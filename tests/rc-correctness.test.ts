/**
 * tests/rc-correctness.test.ts — RC correctness reconciliation.
 *
 * Four verified correctness defects in the code-intelligence read path, each
 * written test-first (RED before its fix). No daemon, no port, no token: the
 * embedded write path (runIndexTool on a shared EmbeddedLore) + the embedded
 * read path (EmbeddedLoreReader) drive the real tools end-to-end. Pure-function
 * unit tests (assembleCodeContext, findSymbol) reproduce the isolated cases.
 *
 *   F1 (CRITICAL) — `imports` edges dropped before analytics. A file→symbol
 *       `imports` edge (a named/re-export import) has sourceId=code-file:… so
 *       assembleCodeContext's symbol→symbol-only filter dropped it, and a
 *       symbol that is ONLY imported (never called) became a FALSE dead-code
 *       positive. KEYSTONE: index a fixture where X is defined + exported +
 *       re-exported/imported but NEVER called → find_dead_code must NOT list X.
 *
 *   F2 (MEDIUM) — HTTP loadContext cache never invalidated. A module-scope
 *       per-workspace cache served pre-reindex data forever in HTTP/standalone
 *       mode. There must be an invalidation hook the index path calls (mirrors
 *       the embedded path, which re-reads kuzu every call).
 *
 *   F3 (MEDIUM) — findSymbol bare-name fallback silently picks the first
 *       cross-repo match. With two repos each defining `handler`, a bare-name
 *       lookup must NOT silently answer for one arbitrary repo — it returns an
 *       ambiguity signal listing the candidates (or accepts a repo qualifier).
 *
 *   F4 (MEDIUM) — empty-vs-unknown workspace indistinguishable. A typo'd /
 *       never-indexed workspace returned the SAME clean empty success as a
 *       genuinely-empty index. find_dead_code (and hotspots / layer_violations)
 *       must distinguish "workspace not indexed" from "indexed but empty".
 *
 * ATLAS_CONTEXT_LAYER off (lean edge set; we don't assert on context cards).
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env['ATLAS_CONTEXT_LAYER'] = '0';

import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { EmbeddedLoreReader } from '../src/mcp/embeddedReader.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import { runFindDeadCode } from '../src/mcp/tools/findDeadCode.js';
import { runCallGraph } from '../src/mcp/tools/callGraph.js';
import { runHotspots } from '../src/mcp/tools/hotspots.js';
import { runLayerViolations } from '../src/mcp/tools/layerViolations.js';
import { assembleCodeContext, type CodeEdge, type CodeSymbolNode } from '../src/mcp/codeContext.js';

function mkHome(port: number, workspace: string, dataDir: string): ReturnType<typeof loadConfig> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-home-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port, lore: { workspace, mode: 'embedded', dataDir } }),
    );
    return loadConfig(home);
}

/* ─── F1 unit: assembleCodeContext keeps file→symbol `imports` edges ───────── */

function testF1AssembleKeepsImports(): void {
    // Symbol X (code-symbol:repo/x) is defined; the only inbound edge is a
    // file→symbol `imports` edge (a named import / re-export). Before the fix
    // assembleCodeContext dropped it (sourceId is code-file:, not code-symbol:),
    // so X had ZERO inbound relations → dead-code false positive.
    const symbolNodes: CodeSymbolNode[] = [
        { id: 'code-symbol:repo/x', content: 'export function x(){}', metadata: JSON.stringify({ name: 'x', qualifiedName: 'x', kind: 'function', filePath: 'src/x.ts' }) },
        { id: 'code-symbol:repo/barrel', content: '', metadata: JSON.stringify({ name: 'barrel', qualifiedName: 'barrel', kind: 'function', filePath: 'src/index.ts' }) },
    ];
    const edges: CodeEdge[] = [
        // file→symbol imports edge — the load-bearing case.
        { sourceId: 'code-file:repo/src/index.ts', targetId: 'code-symbol:repo/x', relation: 'imports' },
        // a structural file→symbol contains edge — must STILL be dropped.
        { sourceId: 'code-file:repo/src/x.ts', targetId: 'code-symbol:repo/x', relation: 'contains' },
    ];
    const { relations } = assembleCodeContext(symbolNodes, edges);
    const importRels = relations.filter((r) => r.kind === 'imports' && r.targetId === 'repo/x');
    assert.equal(importRels.length, 1, `file→symbol imports edge survives assembly; got relations=${JSON.stringify(relations)}`);
    // The rescued file source is `file:`-prefixed AND repo-relative (repo prefix
    // stripped to align with a symbol's `.file`, so layer_violations globs match).
    assert.equal(importRels[0]!.sourceId, 'file:src/index.ts', `file source is repo-relative for layer matching; got ${importRels[0]!.sourceId}`);
    // The contains file→symbol edge must NOT have leaked in (only imports is rescued).
    const containsRels = relations.filter((r) => r.kind === 'contains');
    assert.equal(containsRels.length, 0, `structural file→symbol contains edge still dropped; got ${JSON.stringify(containsRels)}`);
    console.log('  ✓ F1(unit): assembleCodeContext keeps file→symbol `imports`, still drops `contains`');
}

/* ─── F1 keystone: only-imported symbol is NOT dead code (embedded e2e) ────── */

async function testF1Keystone(cfg: ReturnType<typeof loadConfig>, ws: string): Promise<void> {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-f1-'));
    // X (onlyImported) is defined + exported in impl.ts and IMPORTED by
    // consumer.ts — but only *bound to a const*, NEVER CALLED. Its single
    // inbound edge is the file→symbol `imports` edge (code-file:consumer →
    // code-symbol:onlyImported). Pre-fix, assembleCodeContext dropped that
    // edge → onlyImported looked like zero-inbound dead code. It must not be
    // flagged. (A direct named import is the shape the resolver actually
    // materializes into a symbol-target `imports` edge; a bare re-export chain
    // does not declare the name in the intermediate file.)
    fs.writeFileSync(path.join(src, 'impl.ts'), `export function onlyImported(): number { return 42; }\n`);
    fs.writeFileSync(path.join(src, 'consumer.ts'), `import { onlyImported } from './impl.js';\nexport const bound = onlyImported;\n`);

    const lore = await getEmbeddedLore(cfg, ws);
    const idx = (await runIndexTool(lore, { path: src }, ws, cfg)) as { nodesWritten?: number };
    assert.ok((idx.nodesWritten ?? 0) > 0, `indexed fixture; got ${JSON.stringify(idx)}`);

    const reader = new EmbeddedLoreReader(cfg);
    const dead = (await runFindDeadCode(reader, { limit: 200 } as never, ws)) as {
        candidates?: Array<{ name?: string }>; error?: string; warning?: string;
    };
    assert.ok(!dead.error, `find_dead_code runs without error; got ${dead.error}`);
    const names = (dead.candidates ?? []).map((c) => c.name);
    assert.ok(
        !names.includes('onlyImported'),
        `an only-imported (never-called) symbol is NOT dead code; candidates=${JSON.stringify(names)}`,
    );
    console.log('  ✓ F1(keystone): only-imported `onlyImported` NOT flagged dead (candidates: ' + names.length + ')');
    fs.rmSync(src, { recursive: true, force: true });
}

/* ─── F2: HTTP loadContext cache invalidates after re-index ────────────────── */

async function testF2HttpCacheInvalidation(): Promise<void> {
    // Unit-level: the HTTP reader must expose a per-workspace invalidation hook,
    // and a fresh loadContext after invalidation must NOT return the stale cached
    // Promise. We stub the network by pre-seeding the cache via the public reset/
    // invalidate API and asserting the cache key is cleared.
    const mod = await import('../src/mcp/loreReader.js');
    assert.equal(typeof mod.invalidateLoreContext, 'function', 'loreReader exports invalidateLoreContext(workspace)');
    assert.equal(typeof mod._loreContextCacheSize, 'function', 'loreReader exposes _loreContextCacheSize for testing');

    const reader = new mod.LoreReader({ mcpUrl: 'http://127.0.0.1:59999/mcp', token: 'test-token' });
    // Kick off a load (it will fail against the dead port, but the in-flight
    // Promise is cached synchronously before the await resolves).
    const p = reader.loadContext('f2ws').catch(() => undefined);
    assert.ok(mod._loreContextCacheSize() >= 1, 'in-flight loadContext is cached');
    // Invalidate this workspace — the cache entry for f2ws must be gone.
    mod.invalidateLoreContext('f2ws');
    assert.equal(
        mod._loreContextCacheSize('f2ws'),
        0,
        'invalidateLoreContext(workspace) clears the workspace cache entry',
    );
    await p;
    mod._resetLoreReaderCache();
    console.log('  ✓ F2: HTTP loadContext cache invalidates per-workspace after re-index');
}

/* ─── F3: findSymbol ambiguity across repos ────────────────────────────────── */

async function testF3FindSymbolAmbiguity(): Promise<void> {
    const { findSymbol } = await import('../src/mcp/tools/findSymbol.js');
    const { buildSymbolTable } = await import('../src/resolver/symbolTable.js');
    const mkSym = (repo: string, uid: string, name: string) => ({
        id: `${repo}/${uid}`,
        name,
        qualifiedName: name,
        kind: 'function' as const,
        file: `src/${name}.ts`,
        byteRange: { start: 0, end: 0, startLine: 1, endLine: 1 },
        signature: '',
        complexity: 1,
        parentSymbolId: null,
        parsedAt: '',
    });
    // Two repos, each with a `handler` symbol at the same bare name.
    const table = buildSymbolTable([
        { path: 'src/handler.ts', language: 'typescript', symbols: [mkSym('repoA', 'src/handler.ts::handler', 'handler')], imports: [], calls: [], sizeBytes: 0, loc: 0, parsedAt: '' } as never,
        { path: 'src/handler.ts', language: 'typescript', symbols: [mkSym('repoB', 'src/handler.ts::handler', 'handler')], imports: [], calls: [], sizeBytes: 0, loc: 0, parsedAt: '' } as never,
    ]);

    // A bare-name lookup with >1 cross-repo candidate must be AMBIGUOUS, not a
    // silent first-match.
    const ambiguous = findSymbol(table, 'handler');
    assert.equal(ambiguous.kind, 'ambiguous', `bare-name cross-repo lookup is ambiguous; got ${JSON.stringify(ambiguous)}`);
    if (ambiguous.kind === 'ambiguous') {
        assert.equal(ambiguous.candidates.length, 2, 'both repo candidates are listed');
        assert.ok(
            ambiguous.candidates.some((c) => c.id.startsWith('repoA/')) && ambiguous.candidates.some((c) => c.id.startsWith('repoB/')),
            'candidate list spans both repos',
        );
    }

    // A repo-qualified lookup disambiguates to exactly one symbol.
    const qualified = findSymbol(table, 'repoA/src/handler.ts::handler');
    assert.equal(qualified.kind, 'found', `exact id resolves; got ${JSON.stringify(qualified)}`);

    // A unique bare name still resolves cleanly.
    const table2 = buildSymbolTable([
        { path: 'src/uniq.ts', language: 'typescript', symbols: [mkSym('repoA', 'src/uniq.ts::uniqueName', 'uniqueName')], imports: [], calls: [], sizeBytes: 0, loc: 0, parsedAt: '' } as never,
    ]);
    const unique = findSymbol(table2, 'uniqueName');
    assert.equal(unique.kind, 'found', `unique bare name resolves; got ${JSON.stringify(unique)}`);
    console.log('  ✓ F3: findSymbol returns an ambiguity signal for cross-repo bare names, resolves qualified + unique');
}

/* ─── F3 tool wiring: call_graph surfaces ambiguity instead of guessing ────── */

async function testF3CallGraphAmbiguity(cfg: ReturnType<typeof loadConfig>): Promise<void> {
    const wsA = 'rcf3a';
    const srcA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-f3a-'));
    const srcB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-f3b-'));
    // Distinct dir names → distinct repo slugs (non-git basename), each defining `shared`.
    fs.writeFileSync(path.join(srcA, 'a.ts'), `export function shared(): number { return 1; }\nexport function callsA(): number { return shared(); }\n`);
    fs.writeFileSync(path.join(srcB, 'b.ts'), `export function shared(): number { return 2; }\nexport function callsB(): number { return shared(); }\n`);

    const lore = await getEmbeddedLore(cfg, wsA);
    await runIndexTool(lore, { path: srcA }, wsA, cfg);
    await runIndexTool(lore, { path: srcB }, wsA, cfg);

    const reader = new EmbeddedLoreReader(cfg);
    const cg = (await runCallGraph(reader, { symbol: 'shared', direction: 'upstream' } as never, wsA)) as {
        error?: string; ambiguous?: boolean; candidates?: unknown[];
    };
    assert.ok(
        cg.ambiguous === true || (typeof cg.error === 'string' && /ambig/i.test(cg.error)),
        `call_graph surfaces the cross-repo ambiguity for bare 'shared'; got ${JSON.stringify(cg).slice(0, 300)}`,
    );
    if (Array.isArray(cg.candidates)) {
        assert.ok(cg.candidates.length >= 2, 'call_graph lists both repo candidates');
    }
    console.log('  ✓ F3(tool): call_graph reports ambiguity for a cross-repo bare name');
    fs.rmSync(srcA, { recursive: true, force: true });
    fs.rmSync(srcB, { recursive: true, force: true });
}

/* ─── F4: unknown workspace ≠ empty index ──────────────────────────────────── */

async function testF4UnknownWorkspace(cfg: ReturnType<typeof loadConfig>): Promise<void> {
    const reader = new EmbeddedLoreReader(cfg);
    // A never-indexed workspace name — no dataDir subdir on disk.
    const unknown = 'never-indexed-typo';
    const dead = (await runFindDeadCode(reader, {} as never, unknown)) as {
        error?: string; warning?: string; candidates?: unknown[];
    };
    assert.ok(
        typeof dead.error === 'string' || typeof dead.warning === 'string',
        `find_dead_code distinguishes an unknown workspace with error/warning; got ${JSON.stringify(dead)}`,
    );
    const signal = (dead.error ?? dead.warning ?? '').toLowerCase();
    assert.ok(/not indexed|unknown|no.*index/.test(signal), `signal names the not-indexed condition; got "${signal}"`);

    const hot = (await runHotspots(reader, {} as never, unknown)) as { error?: string; warning?: string };
    assert.ok(typeof hot.error === 'string' || typeof hot.warning === 'string', `hotspots flags unknown workspace; got ${JSON.stringify(hot)}`);

    const lv = (await runLayerViolations(reader, {} as never, unknown)) as { error?: string; warning?: string };
    assert.ok(typeof lv.error === 'string' || typeof lv.warning === 'string', `layer_violations flags unknown workspace; got ${JSON.stringify(lv)}`);

    console.log('  ✓ F4: unknown/never-indexed workspace returns a distinguishable not-indexed signal');
}

/* ─── F4 negative: a genuinely-empty but indexed workspace is a clean pass ──── */

async function testF4EmptyIndexed(cfg: ReturnType<typeof loadConfig>): Promise<void> {
    const ws = 'rcf4-empty';
    // Create the workspace dataDir by opening it (indexes nothing → truly empty).
    await getEmbeddedLore(cfg, ws);
    const reader = new EmbeddedLoreReader(cfg);
    const dead = (await runFindDeadCode(reader, {} as never, ws)) as { error?: string; warning?: string; candidates?: unknown[] };
    // Indexed-but-empty must NOT carry the not-indexed error (it's a valid clean result).
    const signal = (dead.error ?? '').toLowerCase();
    assert.ok(!/not indexed|unknown/.test(signal), `an opened-but-empty workspace is NOT reported as unknown; got ${JSON.stringify(dead)}`);
    assert.ok(Array.isArray(dead.candidates), 'empty indexed workspace still returns a candidates array');
    console.log('  ✓ F4(negative): opened-but-empty workspace is a clean, non-error result');
}

/* ─── runner ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('Running RC correctness tests…');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-data-'));
    const cfg = mkHome(3848, 'rcmain', base);
    try {
        testF1AssembleKeepsImports();
        await testF1Keystone(cfg, 'rcf1');
        await testF2HttpCacheInvalidation();
        await testF3FindSymbolAmbiguity();
        await testF3CallGraphAmbiguity(cfg);
        await testF4UnknownWorkspace(cfg);
        await testF4EmptyIndexed(cfg);
    } finally {
        await closeAllEmbedded();
    }
    console.log('All RC correctness tests passed.');
}

await main();
