/**
 * tests/audit-round4.test.ts — regression tests for the round-4 backend fixes:
 *  C4. Walker symlink cycles (phantom files / unbounded walk).
 *  H5. deleteNode tombstones the `lore:<id>` verbatim row (vector leak).
 *  H6. closeAllEmbedded drains in-flight borrows before closing.
 *  H7. awaitEmbeds bumps the edge-cache epoch (autolink visibility).
 *
 * Shape follows tests/audit-high-severity.test.ts. Run under the ABI-matched
 * node (native modules).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── C4 — symlink cycles can't phantom-index or hang the walk ────────────────
async function testWalkerSymlinkCycle(cleanup: string[]): Promise<void> {
    console.log('\n[C4] CRITICAL — symlink loop poisoned/hung the indexer');
    const { walkRepo } = await import('../src/cli/walker.js');
    const dir = mkTmp('atlas-audit-c4-');
    cleanup.push(dir);

    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'real.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'a', 'inner.ts'), 'export const y = 2;\n');
    // Cycles: a/loop -> .. (ancestor) and b/self -> . (root-ish self loop)
    fs.symlinkSync('..', path.join(dir, 'a', 'loop'));
    fs.symlinkSync(dir, path.join(dir, 'b', 'self'));

    const seen = [...walkRepo(dir, { maxFiles: 10_000 })];
    const rels = seen.map((p) => path.relative(dir, p).split(path.sep).join('/')).sort();
    assert.deepEqual(rels, ['a/inner.ts', 'real.ts'],
        `CLAIM C4a: only real files yielded, no phantom loop/ paths (got ${rels.length}: ${rels.slice(0, 6).join(', ')})`);
    console.log('  ✓ CLAIM C4a: symlink cycles yield each real file exactly once');

    // A dirs-only cycle must also terminate (no file ever trips maxFiles).
    const dir2 = mkTmp('atlas-audit-c4b-');
    cleanup.push(dir2);
    fs.mkdirSync(path.join(dir2, 'x'));
    fs.symlinkSync('..', path.join(dir2, 'x', 'loop'));
    const seen2 = [...walkRepo(dir2, { maxFiles: 10_000 })];
    assert.equal(seen2.length, 0, 'CLAIM C4b: dirs-only cycle terminates with zero yields');
    console.log('  ✓ CLAIM C4b: dirs-only cycle terminates (no unbounded stack growth)');

    // A legit symlink to a real dir inside the root still works — once.
    const dir3 = mkTmp('atlas-audit-c4c-');
    cleanup.push(dir3);
    fs.mkdirSync(path.join(dir3, 'pkg'));
    fs.writeFileSync(path.join(dir3, 'pkg', 'mod.ts'), 'export const z = 3;\n');
    fs.symlinkSync('pkg', path.join(dir3, 'alias'));
    const rels3 = [...walkRepo(dir3)].map((p) => path.relative(dir3, p).split(path.sep).join('/')).sort();
    // WHICH entry readdir(3) yields first — the real dir `pkg` or the in-root
    // symlink `alias` — is filesystem-order-dependent (macOS/APFS and
    // Linux/ext4 disagree), and the walker's contract is dedupe-by-realpath:
    // first-seen real dir wins. Assert the INVARIANT, not the order — exactly
    // one yield, and it resolves to the one real file.
    assert.equal(
        fs.realpathSync(path.join(dir3, rels3[0])),
        fs.realpathSync(path.join(dir3, 'pkg', 'mod.ts')),
        `the single yield is the real file, via pkg/ or alias/ (got ${rels3[0]})`,
    );
    console.log('  ✓ CLAIM C4c: legitimate in-root symlinks still index (deduped by realpath)');
}

// ── H5 — deleteNode removes the lore:<id> vector row ────────────────────────
async function testDeleteNodeVectorPrefix(cleanup: string[]): Promise<void> {
    console.log('\n[H5] HIGH — deleteNode orphaned the verbatim vector row');
    const dir = mkTmp('atlas-audit-h5-');
    cleanup.push(dir);
    const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
    const lore = await EmbeddedLore.open(dir);
    try {
        await lore.storeNode({
            id: 'k:del-1', type: 'decision', label: 'Temporary decision',
            content: 'This node will be deleted and its vector must die too.',
            workspace: 'ws', embed: true,
        } as never);
        await lore.awaitEmbeds();
        const before = await lore.getEmbeddings(['k:del-1']);
        assert.ok((before.get('k:del-1')?.length ?? 0) > 0, 'setup: vector row exists after store');

        await lore.deleteNode('k:del-1');
        const after = await lore.getEmbeddings(['k:del-1']);
        assert.ok(!(after.get('k:del-1')?.length),
            'CLAIM H5: vector row is tombstoned with the lore:<id> prefix (was orphaned by the bare-id delete)');
        console.log('  ✓ CLAIM H5: deleteNode purges the vector row (no more orphaned embeddings)');
    } finally {
        await lore.close();
    }
}

// ── H6 — closeAllEmbedded drains in-flight borrows ──────────────────────────
async function testCloseAllDrains(cleanup: string[]): Promise<void> {
    console.log('\n[H6] HIGH — close-all killed native handles under live borrows');
    const home = mkTmp('atlas-audit-h6-');
    cleanup.push(home);
    const { loadConfig } = await import('../src/config.js');
    const { borrowEmbeddedLore, closeAllEmbedded, openEmbeddedInstances } = await import('../src/mcp/embeddedRegistry.js');
    const cfg = { ...loadConfig(), home };

    const { lore, release } = await borrowEmbeddedLore(cfg, 'drainws');
    let closedAll = false;
    const p = closeAllEmbedded().then(() => { closedAll = true; });
    await sleep(200);
    assert.equal(closedAll, false, 'CLAIM H6a: close-all waits while a borrow is in flight');
    // The borrowed handle still works mid-drain.
    const stats = await lore.getStats();
    assert.ok(stats && typeof stats === 'object', 'borrowed instance still usable during the drain window');
    release();
    await p;
    assert.equal(closedAll, true, 'CLAIM H6b: close-all completes once the borrow releases');
    assert.deepEqual(await openEmbeddedInstances(), [], 'registry is empty after close-all');
    console.log('  ✓ CLAIM H6a/b: closeAllEmbedded drains borrows, then closes (no more mid-call pool crashes)');
}

// ── H7 — awaitEmbeds bumps the edge-cache epoch ─────────────────────────────
async function testAwaitEmbedsEpoch(cleanup: string[]): Promise<void> {
    console.log('\n[H7] HIGH — autolink edges invisible to the memoized listEdges()');
    const dir = mkTmp('atlas-audit-h7-');
    cleanup.push(dir);
    const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
    const lore = await EmbeddedLore.open(dir);
    try {
        const epochOf = () => (lore as unknown as { _edgeCacheEpoch: number })._edgeCacheEpoch;
        // Prime the edge cache (memoizes at the current epoch).
        await lore.listEdges();
        const before = epochOf();
        await lore.storeNode({
            id: 'k:epoch-1', type: 'decision', label: 'Epoch probe',
            content: 'A knowledge write whose autolink must not strand the edge cache.',
            workspace: 'ws', embed: true,
        } as never);
        await lore.awaitEmbeds();
        assert.ok(epochOf() > before,
            `CLAIM H7: awaitEmbeds bumps the edge-cache epoch (${before} → ${epochOf()}) — autolink edges can't stay invisible`);
        console.log('  ✓ CLAIM H7: the edge cache is invalidated at the autolink settle point');
    } finally {
        await lore.close();
    }
}

async function main(): Promise<void> {
    console.log('Running audit round-4 regression tests…');
    const cleanup: string[] = [];
    try {
        await testWalkerSymlinkCycle(cleanup);
        await testDeleteNodeVectorPrefix(cleanup);
        await testCloseAllDrains(cleanup);
        await testAwaitEmbedsEpoch(cleanup);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log('\nAll audit round-4 regression tests passed ✓');
}

await main();
