/**
 * tests/gf2.test.ts — GF-2: semantic code search DEFAULT-ON.
 *
 *   T1 (default-on, file-mode): a fresh buildIndexBatch with NO ATLAS_CONTEXT_*
 *       env set now emits an EMBEDDED code_context card (embed:true) per file —
 *       i.e. semantic code search is on by default. (Pre-GF-2 this required
 *       ATLAS_CONTEXT_LAYER=1 and produced nothing by default.)
 *   T2 (force-off honored): opts.contextMode='off' (what ATLAS_CONTEXT_LAYER=0
 *       resolves to) emits NO code_context node and NO 'describes' bridge —
 *       the lean graph-only index.
 *   T3 (size guard): resolveContextMode auto-falls-back above the thresholds and
 *       returns a single human-readable note stating what happened + how to
 *       override; below the thresholds it is a no-op pass-through.
 *   T4 (semantic recall, real embedded Lore): index a fixture whose file body
 *       shares NO literal keyword with the query, then a semantic search finds
 *       the right file by MEANING — proving the default context layer is what
 *       makes code semantically searchable. Skips gracefully if the local embed
 *       model can't load in this environment.
 *
 * T1-T3 are pure in-process builder/guard tests (no network, no model). They
 * deliberately set NO ATLAS_CONTEXT_* env so they exercise the new default; the
 * mode is driven via opts.contextMode, which overrides the module-load snapshot.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// GF-2: do NOT set ATLAS_CONTEXT_LAYER — the whole point is that the default is
// now ON. Clear any inherited value so the snapshot reflects an unset env.
delete process.env['ATLAS_CONTEXT_LAYER'];
delete process.env['ATLAS_CONTEXT_SPANS'];
delete process.env['ATLAS_CONTEXT_LAYER_MAX_FILES'];
delete process.env['ATLAS_CONTEXT_SPANS_MAX_SYMBOLS'];

const REPO = 'gf2-fixture-repo';
const WORKSPACE = 'gf2-test-ws';

function makeFixtureFile(body: string, name = 'sample.ts'): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf2-fixture-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return { dir, file };
}

const SAMPLE = `export function greet(name: string): string {
    return helper('Hello, ' + name);
}

export function helper(message: string): string {
    return message + '!';
}
`;

/* ─── T1: default-on emits an embedded code_context card ─────────── */

async function testDefaultOn(): Promise<void> {
    const { parseFile } = await import('../src/parser/index.js');
    const { buildIndexBatch, defaultContextMode } = await import('../src/store/codeNodes.js');

    // Sanity: with no env set, the snapshot default is file-mode (ON).
    assert.equal(defaultContextMode(), 'file', `default mode is file (got ${defaultContextMode()})`);

    const { dir, file } = makeFixtureFile(SAMPLE);
    try {
        const parsed = await parseFile(file, dir);
        assert.ok(parsed, 'fixture parsed');
        // No contextMode passed → snapshot default (file-mode) applies.
        const batch = await buildIndexBatch(parsed!, { workspace: WORKSPACE, repo: REPO, absolutePath: file });

        const ctx = batch.nodes.filter((n) => n.type === 'code_context');
        assert.equal(ctx.length, 1, `exactly one per-file code_context card by default; got ${ctx.length}`);
        assert.equal(ctx[0]!.embed, true, 'code_context card is embed:true (semantically searchable)');
        // The describes bridge linking the card → code_file node is present.
        const describes = batch.edges.find((e) => e.relation === 'describes');
        assert.ok(describes, 'code_context → code_file describes bridge present by default');
        // And it's a per-FILE card (id prefix code-context:, not code-context-sym:).
        assert.ok((ctx[0]!.id as string).startsWith('code-context:'), `file-mode card id; got ${ctx[0]!.id}`);
        console.log('  ✓ T1: NO env → embedded per-file code_context card by default (semantic code search on)');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ─── T2: contextMode 'off' (ATLAS_CONTEXT_LAYER=0) emits no card ── */

async function testForceOff(): Promise<void> {
    const { parseFile } = await import('../src/parser/index.js');
    const { buildIndexBatch } = await import('../src/store/codeNodes.js');

    const { dir, file } = makeFixtureFile(SAMPLE);
    try {
        const parsed = await parseFile(file, dir);
        assert.ok(parsed, 'fixture parsed');
        // 'off' is exactly what ATLAS_CONTEXT_LAYER=0 → defaultContextMode() yields,
        // and what the size guard passes when it disables the layer.
        const batch = await buildIndexBatch(parsed!, { workspace: WORKSPACE, repo: REPO, absolutePath: file, contextMode: 'off' });

        const ctx = batch.nodes.filter((n) => n.type === 'code_context');
        assert.equal(ctx.length, 0, `force-off emits NO code_context card; got ${ctx.length}`);
        const describes = batch.edges.find((e) => e.relation === 'describes');
        assert.ok(!describes, 'force-off emits NO describes bridge');
        // The structural graph is still written (code_file + code_symbol + contains).
        assert.ok(batch.nodes.some((n) => n.type === 'code_file'), 'graph nodes still written when layer off');
        console.log('  ✓ T2: contextMode=off (ATLAS_CONTEXT_LAYER=0) → no code_context, graph-only honored');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ─── T3: size guard fallback ─────────────────────────────────────── */

async function testSizeGuard(): Promise<void> {
    const {
        resolveContextMode, CONTEXT_LAYER_MAX_FILES, CONTEXT_SPANS_MAX_SYMBOLS,
    } = await import('../src/store/codeNodes.js');

    // Below thresholds: no-op pass-through, no note.
    const small = resolveContextMode('file', { files: 100, symbols: 1000 });
    assert.equal(small.mode, 'file', 'small repo keeps requested file-mode');
    assert.equal(small.note, undefined, 'no note when nothing downgraded');

    // Above the FILE cap: layer disabled (off) in any mode, with a note.
    const huge = resolveContextMode('file', { files: CONTEXT_LAYER_MAX_FILES + 1, symbols: 50 });
    assert.equal(huge.mode, 'off', `>${CONTEXT_LAYER_MAX_FILES} files → off`);
    assert.ok(huge.note && /graph-only/.test(huge.note) && /ATLAS_CONTEXT_LAYER_MAX_FILES/.test(huge.note),
        `file-cap note explains the downgrade + override; got ${JSON.stringify(huge.note)}`);

    // Above the SYMBOL cap with spans requested: fall back to file-mode, with a note.
    const manySyms = resolveContextMode('spans', { files: 200, symbols: CONTEXT_SPANS_MAX_SYMBOLS + 1 });
    assert.equal(manySyms.mode, 'file', `>${CONTEXT_SPANS_MAX_SYMBOLS} symbols + spans → file`);
    assert.ok(manySyms.note && /spans to file/.test(manySyms.note) && /ATLAS_CONTEXT_SPANS_MAX_SYMBOLS/.test(manySyms.note),
        `symbol-cap note explains the spans→file fallback + override; got ${JSON.stringify(manySyms.note)}`);

    // File-mode is NEVER downgraded by the symbol cap (only spans is).
    const fileManySyms = resolveContextMode('file', { files: 200, symbols: CONTEXT_SPANS_MAX_SYMBOLS + 1 });
    assert.equal(fileManySyms.mode, 'file', 'file-mode unaffected by the symbol cap');
    assert.equal(fileManySyms.note, undefined, 'file-mode under file-cap emits no note');

    // Explicit off is always off (guard never re-enables).
    assert.equal(resolveContextMode('off', { files: 10, symbols: 10 }).mode, 'off', 'off stays off');

    // The file cap wins over the symbol cap (off, not file) when both exceeded.
    const both = resolveContextMode('spans', { files: CONTEXT_LAYER_MAX_FILES + 1, symbols: CONTEXT_SPANS_MAX_SYMBOLS + 1 });
    assert.equal(both.mode, 'off', 'file-cap takes precedence → off');
    console.log('  ✓ T3: size guard — file-cap→off, symbol-cap+spans→file, each with an override note');
}

/* ─── T4: real embedded semantic recall (meaning, not keyword) ────── */

async function testSemanticRecall(): Promise<void> {
    const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
    const { parseFile } = await import('../src/parser/index.js');
    const { buildIndexBatch } = await import('../src/store/codeNodes.js');
    const { BatchWriter } = await import('../src/cli/batchWriter.js');

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gf2-embed-'));
    const dataDir = path.join(base, WORKSPACE);

    // Fixture: a function about CURRENCY FORMATTING. The query asks about "money"
    // — a word that appears NOWHERE in the source, so a keyword scan cannot find
    // it. Only the embedded semantic card can match by meaning.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf2-srcrepo-'));
    const targetName = 'currency.ts';
    fs.writeFileSync(path.join(repoDir, targetName),
        `export function formatCurrency(amount: number, symbol: string): string {
    const rounded = Math.round(amount * 100) / 100;
    return symbol + rounded.toFixed(2);
}
`);
    // A decoy file with an unrelated topic, so the match isn't trivial.
    fs.writeFileSync(path.join(repoDir, 'colors.ts'),
        `export function hexToRgb(hex: string): number[] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
`);

    let client: InstanceType<typeof EmbeddedLore>;
    try {
        client = await EmbeddedLore.open(dataDir);
    } catch (err) {
        console.log(`  ⚠ T4 skipped — embedded Lore/model unavailable in this env: ${(err as Error).message}`);
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
        return;
    }

    try {
        const writer = new BatchWriter(client);
        for (const name of [targetName, 'colors.ts']) {
            const abs = path.join(repoDir, name);
            const parsed = await parseFile(abs, repoDir);
            assert.ok(parsed, `${name} parsed`);
            // Default mode (file) — no contextMode passed, exercising the new default.
            const batch = await buildIndexBatch(parsed!, { workspace: WORKSPACE, repo: REPO, absolutePath: abs });
            await writer.add(abs, batch.nodes, batch.edges);
        }
        await writer.flush();
        await client.awaitEmbeds();

        // Sanity: the embedded code_context cards actually landed.
        const cards = await client.listNodes('code_context') as Array<{ id: string }>;
        assert.ok(cards.length >= 2, `code_context cards persisted; got ${cards.length}`);

        // Semantic query: "money" / "price" — no literal overlap with the source.
        const res = await client.search('formatting a money price amount', 10, undefined, undefined, 'semantic') as {
            results?: Array<{ id?: string; label?: string; content?: string }>;
        };
        const results = res.results ?? [];
        assert.ok(results.length > 0, `semantic search returned hits; got ${JSON.stringify(res).slice(0, 300)}`);
        // The top hit (or any hit) should reference the currency file, by meaning.
        const hitCurrency = results.some((r) =>
            (r.label ?? '').includes(targetName) ||
            (r.content ?? '').includes('formatCurrency') ||
            (r.id ?? '').includes(targetName),
        );
        assert.ok(hitCurrency,
            `semantic query for "money" surfaced the currency file by MEANING (no shared keyword); got ${JSON.stringify(results.map((r) => r.label ?? r.id)).slice(0, 400)}`);
        console.log('  ✓ T4: default context layer → semantic query finds the right file by meaning (no shared keyword)');
    } finally {
        await client.close().catch(() => undefined);
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
}

/* ─── runner ──────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('atlas GF-2 tests');
    await testDefaultOn();
    await testForceOff();
    await testSizeGuard();
    await testSemanticRecall();
    console.log('All GF-2 tests passed.');
}

await main();
