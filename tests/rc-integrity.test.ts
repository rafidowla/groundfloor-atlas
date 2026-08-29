/**
 * tests/rc-integrity.test.ts — RC store/write-integrity fixes (4 defects).
 *
 * Each block reproduces a real defect, then proves the fix. On the PRE-fix code
 * the "fix proven" assertions would fail (that failure IS the reproduction); on
 * the fixed code every claim is green.
 *
 * DEFECTS:
 *  1. CRITICAL — concurrent CLI+daemon writer, no lock. A second writer opening
 *     the same workspace dataDir while one is mid-write corrupts the store.
 *     FIX: `<dataDir>/.atlas-writer.lock` (writerLock.ts) shared by BOTH the CLI
 *     index path and the daemon's atlas_index; the second writer is rejected
 *     with a clear "being indexed by pid N" error, with stale-lock detection.
 *  2. HIGH — deleted/renamed files leave stale nodes/edges. A full re-index of a
 *     repo with a removed file left the old file's code_file/code_symbol nodes +
 *     edges in the graph forever (phantom callers/callees). FIX: post-full-index
 *     reconcile deletes file-scoped nodes for THIS repo not in the fresh set
 *     (indexCore reconcile → EmbeddedLore.reconcileRepoFiles), repo-scoped.
 *  3. HIGH — SIGTERM/SIGINT mid-index corrupts the store (handles torn down mid
 *     node-pass-then-edge-pass). FIX: drainIndexWork() awaits in-flight index
 *     work to a consistent point BEFORE closeAllEmbedded (indexDrain.ts).
 *  4. HIGH — LRU eviction closes an instance mid-use. FIX: ref-count in-flight
 *     users; evict only zero-ref (idle) instances (embeddedRegistry.ts).
 *
 * Shape follows tests/scale-integrity.test.ts / tests/embedded.test.ts:
 * node:assert/strict, async main(), '  ✓ CLAIM …' lines, ends `await main()`.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    acquireWorkspaceWriteLock,
    WorkspaceLockedError,
    WRITER_LOCK_BASENAME,
} from '../src/lore/writerLock.js';
import {
    beginIndexWork,
    endIndexWork,
    drainIndexWork,
    isShuttingDown,
    hasInFlightIndex,
    _resetIndexDrainForTest,
} from '../src/lore/indexDrain.js';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import type { StoreNodeInput, StoreEdgeInput } from '../src/loreClient.js';
import {
    borrowEmbeddedLore,
    inFlightUsers,
    closeAllEmbedded,
    embeddedDataDir,
    applyAdaptiveMaxOpen,
} from '../src/mcp/embeddedRegistry.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── DEFECT 1 — single-writer lock ────────────────────────────────────────────

async function testWriterLock(cleanup: string[]): Promise<void> {
    console.log('\n[1] CRITICAL — concurrent CLI+daemon writer lock');
    const dataDir = mkTmp('atlas-rc-lock-');
    cleanup.push(dataDir);

    // First writer acquires.
    const first = acquireWorkspaceWriteLock(dataDir);
    assert.ok(
        fs.existsSync(path.join(dataDir, WRITER_LOCK_BASENAME)),
        'lock file created on acquire',
    );

    // A SECOND writer (simulating the other process — CLI vs daemon) must be
    // REJECTED, not allowed to open the same single-writer store concurrently.
    let rejected: WorkspaceLockedError | null = null;
    try {
        acquireWorkspaceWriteLock(dataDir);
    } catch (err) {
        if (err instanceof WorkspaceLockedError) rejected = err;
        else throw err;
    }
    assert.ok(rejected, 'second concurrent writer is rejected (not silently allowed)');
    assert.equal(rejected!.holderPid, process.pid, 'rejection names the live holder pid');
    console.log('  ✓ CLAIM 1a: second concurrent writer rejected with holder pid');

    // After the first releases, a new writer can acquire (lock is not permanent).
    first.release();
    assert.ok(
        !fs.existsSync(path.join(dataDir, WRITER_LOCK_BASENAME)),
        'lock file removed on release',
    );
    const second = acquireWorkspaceWriteLock(dataDir);
    console.log('  ✓ CLAIM 1b: lock re-acquirable after release');
    second.release();

    // STALE lock (holder pid dead) is STOLEN, not a permanent wedge. Write a
    // lock file naming a pid that cannot exist, then assert acquire succeeds.
    const lockPath = path.join(dataDir, WRITER_LOCK_BASENAME);
    // pid 2^31-1 is effectively never a live process on these platforms.
    const deadPid = 2147483646;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() }));
    const stolen = acquireWorkspaceWriteLock(dataDir);
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    assert.equal(held.pid, process.pid, 'stale lock (dead holder) is stolen by the new writer');
    console.log('  ✓ CLAIM 1c: stale lock (dead holder pid) is stolen, not a permanent wedge');
    stolen.release();

    // A corrupt/empty lock file (no live pid) is also stealable — a partial write
    // must not permanently wedge the workspace. The file must be OLDER than the
    // empty-payload grace window: a FRESH payload-less file is a live winner in
    // the openSync→writeSync race window and is (correctly, since the M4 fix)
    // treated as locked rather than stolen. Age this one to simulate a crash
    // that happened a minute ago.
    fs.writeFileSync(lockPath, 'not-json-garbage');
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, minuteAgo, minuteAgo);
    const stolen2 = acquireWorkspaceWriteLock(dataDir);
    console.log('  ✓ CLAIM 1d: corrupt lock file is recovered (stealable once provably stale)');
    stolen2.release();
}

// ── DEFECT 1 (integration) — CLI + a held lock ───────────────────────────────

async function testCliRespectsLock(cleanup: string[]): Promise<void> {
    console.log('\n[1e] CLI `atlas index` refuses when the workspace lock is held');
    const home = mkTmp('atlas-rc-home-');
    cleanup.push(home);
    const repo = mkTmp('atlas-rc-repo-');
    cleanup.push(repo);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function a(): number { return 1; }\n');

    const WORKSPACE = 'rclockws';
    const cfg = loadConfig(home);
    const dataDir = embeddedDataDir(cfg, WORKSPACE);

    // Hold the lock as if the daemon were mid-index of this workspace.
    const holder = acquireWorkspaceWriteLock(dataDir);
    try {
        const { spawnSync } = await import('node:child_process');
        const proc = spawnSync(
            'npx',
            ['tsx', path.join(REPO_ROOT, 'src', 'cli.ts'), 'index', repo, '--workspace', WORKSPACE, '--force'],
            {
                cwd: REPO_ROOT,
                env: { ...process.env, ATLAS_HOME: home, ATLAS_CONTEXT_LAYER: '0' },
                encoding: 'utf8',
                timeout: 120_000,
                maxBuffer: 32 * 1024 * 1024,
            },
        );
        // The CLI must EXIT NON-ZERO (refuse) rather than open the locked store
        // and race the holder. Exit code 9 is the writer-locked code.
        assert.notEqual(proc.status, 0, `CLI must refuse a locked workspace (exit=${proc.status})`);
        const stderr = proc.stderr ?? '';
        assert.match(
            stderr,
            /being indexed by pid|refusing to write concurrently/i,
            `CLI prints a clear locked message; got:\n${stderr.slice(-800)}`,
        );
        console.log(`  ✓ CLAIM 1e: CLI refused (exit=${proc.status}) with a clear locked message`);
    } finally {
        holder.release();
    }
}

// ── DEFECT 2 — stale-node reconcile after a full index ───────────────────────

/**
 * Drive the SHARED index core directly (EmbeddedLore write client) so the test
 * is fast + in-process. Index two files, then re-index with one file REMOVED
 * and assert its nodes + edges are gone after the full re-index reconcile.
 */
async function testStaleReconcile(cleanup: string[]): Promise<void> {
    console.log('\n[2] HIGH — deleted/renamed files leave stale nodes/edges');
    const { indexRepoFiles } = await import('../src/indexCore.js');
    const { BatchWriter } = await import('../src/cli/batchWriter.js');
    const { parseFile } = await import('../src/parser/index.js');

    const dataDir = mkTmp('atlas-rc-reconcile-');
    cleanup.push(dataDir);
    const repoRoot = mkTmp('atlas-rc-reconcile-repo-');
    cleanup.push(repoRoot);
    const WS = 'reconcilews';
    const REPO = path.basename(repoRoot); // non-git tmp dir → repoSlug == basename

    // Two files: keeper.ts (survives) and goner.ts (deleted before re-index).
    const keeperAbs = path.join(repoRoot, 'keeper.ts');
    const gonerAbs = path.join(repoRoot, 'goner.ts');
    fs.writeFileSync(keeperAbs, 'export function keep(): number { return 1; }\n');
    fs.writeFileSync(gonerAbs, 'export function gone(): number { return 2; }\n');

    const lore = await EmbeddedLore.open(dataDir);
    try {
        // ── full index #1 (both files) ────────────────────────────────────────
        async function fullIndex(files: string[]): Promise<number> {
            const items = [];
            for (const abs of files) {
                const pf = await parseFile(abs, repoRoot);
                if (pf) items.push({ pf, abs, write: true });
            }
            const writer = new BatchWriter(lore, { batchSize: 50 });
            const r = await indexRepoFiles({
                writer, rootAbs: repoRoot, workspace: WS, repo: REPO,
                items, reconcile: true, client: lore,
            });
            return r.staleNodesDeleted;
        }

        await fullIndex([keeperAbs, gonerAbs]);
        const filesAfter1 = (await lore.listNodes('code_file', undefined, WS)) as Array<{ id: string }>;
        const gonerFileId = `code-file:${REPO}/goner.ts`;
        const keeperFileId = `code-file:${REPO}/keeper.ts`;
        assert.ok(filesAfter1.some((n) => n.id === gonerFileId), 'goner.ts indexed initially');
        assert.ok(filesAfter1.some((n) => n.id === keeperFileId), 'keeper.ts indexed initially');
        console.log('  ✓ setup: both files indexed (goner + keeper present)');

        // ── delete goner.ts, full re-index (keeper only) ──────────────────────
        fs.rmSync(gonerAbs);
        const deleted = await fullIndex([keeperAbs]);

        // FIX PROVEN — goner's file + symbol nodes are GONE; keeper survives.
        const filesAfter2 = (await lore.listNodes('code_file', undefined, WS)) as Array<{ id: string }>;
        assert.ok(
            !filesAfter2.some((n) => n.id === gonerFileId),
            'CLAIM 2a: deleted file\'s code_file node is reconciled away (was a phantom before)',
        );
        assert.ok(
            filesAfter2.some((n) => n.id === keeperFileId),
            'CLAIM 2b: surviving file\'s node is untouched by the reconcile',
        );
        assert.ok(deleted >= 1, `CLAIM 2c: reconcile reported ≥1 stale node deleted (got ${deleted})`);
        console.log(`  ✓ CLAIM 2a/b/c: deleted file's nodes purged (${deleted} stale), keeper survives`);

        // Its symbol nodes + edges must be gone too (no phantom callers/callees).
        const gonerSyms = (await lore.listNodes('code_symbol', undefined, WS)) as Array<{ id: string }>;
        assert.ok(
            !gonerSyms.some((n) => n.id.startsWith(`code-symbol:${REPO}/goner.ts`)),
            'CLAIM 2d: deleted file\'s symbol nodes are gone',
        );
        const edges = await lore.listEdges();
        assert.ok(
            !edges.some((e) =>
                (typeof e.sourceId === 'string' && e.sourceId.includes('goner.ts')) ||
                (typeof e.targetId === 'string' && e.targetId.includes('goner.ts')),
            ),
            'CLAIM 2e: no edges reference the deleted file (cascade delete)',
        );
        console.log('  ✓ CLAIM 2d/e: deleted file\'s symbols + edges cascaded away');

        // REPO-SCOPING guard: a SECOND repo's node in the SAME workspace must NOT
        // be swept by the reconcile of the first repo.
        const otherRepoFileId = 'code-file:otherrepo/src/thing.ts';
        await lore.bulkStoreNodes([{
            id: otherRepoFileId, type: 'code_file', label: 'src/thing.ts',
            workspace: WS, embed: false, tags: 'atlas,code-file',
        } as StoreNodeInput]);
        await fullIndex([keeperAbs]); // reconcile repo=REPO again
        const other = await lore.getNode(otherRepoFileId) as { id?: string } | null;
        assert.ok(other && other.id === otherRepoFileId, 'CLAIM 2f: a SIBLING repo\'s node is NOT swept (repo-scoped)');
        console.log('  ✓ CLAIM 2f: reconcile is repo-scoped — sibling repo untouched');
    } finally {
        await lore.close();
    }
}

// ── DEFECT 3 — shutdown drains in-flight index before close ───────────────────

async function testShutdownDrain(): Promise<void> {
    console.log('\n[3] HIGH — SIGTERM/SIGINT mid-index drain');
    _resetIndexDrainForTest();

    // With NO in-flight work, drain resolves immediately + clean.
    assert.equal(await drainIndexWork(1000), true, 'drain with no in-flight work is immediately clean');
    _resetIndexDrainForTest();

    // Simulate an index run mid-flight. drain() must NOT resolve until the work
    // ends — proving the daemon awaits the batch before closing handles.
    beginIndexWork('ws1');
    assert.ok(hasInFlightIndex(), 'index registered as in-flight');
    assert.ok(!isShuttingDown(), 'not shutting down before drain called');

    let drainResolved = false;
    const drainPromise = drainIndexWork(5000).then((clean) => { drainResolved = true; return clean; });

    // drain flips the accepting flag immediately (new indexes now refuse)…
    assert.ok(isShuttingDown(), 'drain flips isShuttingDown so new indexes refuse');
    // …but does NOT resolve while work is in flight.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drainResolved, false, 'CLAIM 3a: drain awaits in-flight index (did NOT resolve early)');
    console.log('  ✓ CLAIM 3a: drain blocks while an index batch is in flight');

    // Finish the work → drain resolves clean.
    endIndexWork('ws1');
    const clean = await drainPromise;
    assert.equal(clean, true, 'CLAIM 3b: drain resolves clean once the in-flight index ends');
    assert.ok(drainResolved, 'drain observed the completion');
    console.log('  ✓ CLAIM 3b: drain completes cleanly after the batch finishes');

    // Timeout path: a wedged index that never ends must not hang shutdown forever.
    _resetIndexDrainForTest();
    beginIndexWork('wedged');
    const t0 = Date.now();
    const timedOut = await drainIndexWork(150);
    const elapsed = Date.now() - t0;
    assert.equal(timedOut, false, 'CLAIM 3c: a wedged index times out (returns false), not an infinite hang');
    assert.ok(elapsed >= 140 && elapsed < 3000, `drain honored the timeout window (${elapsed}ms)`);
    console.log(`  ✓ CLAIM 3c: wedged index drains with a bounded timeout (${elapsed}ms)`);
    endIndexWork('wedged');
    _resetIndexDrainForTest();
}

// ── DEFECT 4 — LRU eviction never closes an in-use instance ───────────────────

async function testLruRefCount(cleanup: string[]): Promise<void> {
    console.log('\n[4] HIGH — LRU eviction closing an instance mid-use');
    // Fresh registry state.
    await closeAllEmbedded();

    const home = mkTmp('atlas-rc-lru-home-');
    cleanup.push(home);
    const cfg = loadConfig(home);
    // Pin the registry cap to 10 (the historical fixed value) for this
    // scenario: MAX_OPEN is memory-adaptive since 2026-08 (64 on this box),
    // and the eviction pressure below needs a cap the 12 filler opens
    // actually exceed. The env-override arg forces it deterministically.
    applyAdaptiveMaxOpen(16 * 2 ** 30, '10');

    // Cap is 10. Borrow ws0 and HOLD it in-flight, then open >cap more
    // workspaces to force eviction. The pinned ws0 must NEVER be closed.
    const HELD = 'wsheld';
    const heldDir = embeddedDataDir(cfg, HELD);
    const held = await borrowEmbeddedLore(cfg, HELD);
    assert.equal(inFlightUsers(heldDir), 1, 'held workspace shows 1 in-flight user');

    // Write a probe node so we can prove the handle is still ALIVE after the
    // eviction pressure (a closed native handle would throw here).
    const probeId = 'code-file:held/probe.ts';
    await held.lore.bulkStoreNodes([{
        id: probeId, type: 'code_file', label: 'probe.ts', workspace: HELD, embed: false, tags: 'atlas',
    } as StoreNodeInput]);

    try {
        // Force past the cap (MAX_OPEN=10) while HELD is pinned in-flight. Open
        // each filler, then release + close it so real kuzu handles don't pile up
        // (each kuzu open mmaps a large buffer pool; keeping many alive at once
        // would OOM the test box — not the behavior under test). The eviction the
        // fix guards runs on every open; the invariant is that it never picks the
        // pinned HELD instance. 12 opens > MAX_OPEN forces the LRU path.
        for (let i = 0; i < 12; i++) {
            const ws = `wsfill${i}`;
            const b = await borrowEmbeddedLore(cfg, ws);
            b.release();
            // Deterministically close this filler so the next open doesn't stack a
            // fresh native handle on top of an un-reclaimed one. The registry's
            // own LRU close is fire-and-forget; closing here keeps the box sane.
            await b.lore.close().catch(() => undefined);
        }

        // FIX PROVEN — the pinned instance is still open + serving. A read through
        // it must succeed; a closed native handle would throw / crash.
        assert.equal(inFlightUsers(heldDir), 1, 'held workspace still pinned (ref not lost)');
        const stillThere = await held.lore.getNode(probeId) as { id?: string } | null;
        assert.ok(
            stillThere && stillThere.id === probeId,
            'CLAIM 4a: pinned in-use instance survived eviction pressure (read still works)',
        );
        console.log('  ✓ CLAIM 4a: LRU never closed the in-flight instance (read succeeded post-pressure)');
    } finally {
        held.release();
    }
    assert.equal(inFlightUsers(heldDir), 0, 'CLAIM 4b: ref count returns to 0 after release');
    console.log('  ✓ CLAIM 4b: ref count drops to 0 on release (now evictable)');

    await closeAllEmbedded();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('Running Atlas RC store/write-integrity fixes test…');
    const cleanup: string[] = [];
    try {
        await testWriterLock(cleanup);
        await testStaleReconcile(cleanup);
        await testShutdownDrain();
        await testLruRefCount(cleanup);
        // CLI integration last — it spawns a real tsx process (slower).
        await testCliRespectsLock(cleanup);
        console.log('\nAll RC integrity claims passed.');
    } finally {
        for (const dir of cleanup) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
}

await main();
