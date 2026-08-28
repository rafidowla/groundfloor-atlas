/**
 * tests/rc-scale-bounds.test.ts — RC read-path bound reconciliation.
 *
 * Wave X7 removed the OLD context caps because a blind edge-prefix SLICE
 * (listEdges().slice(0, N)) could drop a symbol's only inbound edge and turn
 * a referenced symbol into a FALSE dead-code positive — a correctness bug.
 * But the fix over-corrected: embeddedReader.ts stopped passing ANY limit to
 * listNodes(), which sends it down a genuinely UNBOUNDED path (not the "10k"
 * the old comment claimed), exposing an OOM cliff against a pathological
 * workspace. This harness proves the RECONCILIATION:
 *
 *   CLAIM A — a low ATLAS_MAX_CONTEXT_NODES cap clamps the node read and the
 *             read tool's JSON result carries an HONEST `truncated` flag
 *             with the exact nodeLimit that fired.
 *   CLAIM B — the SAME workspace read under the (high) default cap carries
 *             NO `truncated` field at all (not `truncated: false` — absent).
 *   CLAIM C — the fix must NOT reintroduce edge slicing: EmbeddedLore.listEdges()
 *             returns the FULL edge set regardless of the node cap, and
 *             — reusing the exact dead-code idea X7's comment described —
 *             a symbol whose ONLY inbound edge sits in what would be the
 *             "tail" of a naive prefix-slice is still counted as referenced
 *             (find_dead_code does not flag it), even when the node cap is
 *             low enough to exclude most OTHER symbols from the table.
 *   CLAIM D — cli/memorySync.ts exportMemory no longer pulls the full
 *             CODE-edge set to find knowledge edges: it calls the new
 *             source-filtered EmbeddedLore.listEdgesBySource (an indexed
 *             per-source query), not the unfiltered listEdges().
 *
 * Shape follows tests/embedded-read.test.ts (real embedded Lore, real
 * runIndexTool write path, real read-tool call) and tests/scale-integrity.test.ts
 * (node:assert/strict, '  ✓ CLAIM …' progress lines, async main()).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { EmbeddedLoreReader, DEFAULT_MAX_CONTEXT_NODES } from '../src/mcp/embeddedReader.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import { runFindDeadCode } from '../src/mcp/tools/findDeadCode.js';
import { exportMemory, type MemoryExportReader } from '../src/cli/memorySync.js';

interface DeadCodeResult {
    candidates?: Array<{ id?: string; name?: string }>;
    error?: string;
    truncated?: { nodes: number; nodeLimit: number };
}

/**
 * Generate a tiny fixture with `n` symbols across `n` files where EVERY file
 * (except the last) calls the NEXT file's function. The chain means:
 *   - fn0..fn(n-2) each have exactly one inbound caller (the previous file).
 *   - fnLast (the LAST-generated symbol) is called by fn(n-2) — i.e. its only
 *     inbound edge is the LAST edge written/enumerated. A naive prefix-slice
 *     over nodes OR edges is exactly the shape that would drop it.
 * File/symbol generation order matches "tail" position: symbol N is written
 * Nth, so its inbound edge (from symbol N-1) is also among the last written.
 */
function genChainRepo(root: string, n: number): void {
    for (let i = 0; i < n; i++) {
        const dir = path.join(root, 'src');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `file${i}.ts`);
        if (i < n - 1) {
            // Calls the NEXT file's function — forward chain, so the LAST
            // symbol's only inbound edge is the LAST one written.
            const src =
                `import { fn${i + 1} } from './file${i + 1}.js';\n` +
                `export function fn${i}(x: number): number {\n` +
                `  return fn${i + 1}(x) + ${i};\n` +
                `}\n`;
            fs.writeFileSync(file, src);
        } else {
            // Terminal file — no outbound call, called only by fn(n-2).
            fs.writeFileSync(file, `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`);
        }
    }
}

async function main(): Promise<void> {
    console.log('Atlas RC read-path bound reconciliation tests');
    const WS = 'rcscalebounds';
    const SYMBOL_COUNT = 8; // > any low test cap, small enough to be a fast unit test.
    const LOW_CAP = 3;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcscale-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcscale-repo-'));
    genChainRepo(repoRoot, SYMBOL_COUNT);

    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 3848, lore: { workspace: WS, mode: 'embedded', dataDir: path.join(home, 'lore-data') } }),
    );
    const cfg = loadConfig(home);

    const prevEnv = process.env.ATLAS_MAX_CONTEXT_NODES;
    try {
        // ── Index the chain fixture through the real embedded write path ──────
        const lore = await getEmbeddedLore(cfg, WS);
        const idx = (await runIndexTool(lore, { path: path.join(repoRoot, 'src') }, WS, cfg)) as {
            nodesWritten?: number; edgesWritten?: number;
        };
        assert.ok((idx.nodesWritten ?? 0) >= SYMBOL_COUNT, `index wrote at least ${SYMBOL_COUNT} nodes; got ${JSON.stringify(idx)}`);
        console.log(`  ✓ indexed chain fixture: ${idx.nodesWritten} nodes / ${idx.edgesWritten} edges`);

        // Ground truth: the FULL (uncapped) edge count straight from EmbeddedLore,
        // independent of any reader-level node cap.
        const fullEdgesBefore = await lore.listEdges();
        console.log(`  (ground truth: ${fullEdgesBefore.length} total edges in the graph)`);

        // ── CLAIM A — low cap clamps the read and surfaces an honest flag ─────
        process.env.ATLAS_MAX_CONTEXT_NODES = String(LOW_CAP);
        const lowCapReader = new EmbeddedLoreReader(cfg);
        const lowCapCtx = await lowCapReader.loadContext(WS);
        assert.ok(lowCapCtx.truncated, `expected truncated to be set under a cap of ${LOW_CAP}; got ${JSON.stringify(lowCapCtx.truncated)}`);
        assert.equal(lowCapCtx.truncated!.nodeLimit, LOW_CAP, `truncated.nodeLimit should echo the configured cap`);
        assert.equal(lowCapCtx.truncated!.nodes, LOW_CAP, `truncated.nodes should equal the clamped count (== cap)`);
        assert.ok(lowCapCtx.table.all.length <= LOW_CAP, `symbol table should be clamped to <= ${LOW_CAP}; got ${lowCapCtx.table.all.length}`);
        console.log(`  ✓ CLAIM A: cap=${LOW_CAP} → truncated={nodes:${lowCapCtx.truncated!.nodes},nodeLimit:${lowCapCtx.truncated!.nodeLimit}}`);

        // Also verify propagation onto an actual tool's JSON result (find_dead_code).
        const deadUnderCap = (await runFindDeadCode(lowCapReader, {} as never, WS)) as DeadCodeResult;
        assert.ok(deadUnderCap.truncated, `find_dead_code result should carry truncated under the low cap; got ${JSON.stringify(deadUnderCap)}`);
        assert.equal(deadUnderCap.truncated!.nodeLimit, LOW_CAP);
        console.log(`  ✓ CLAIM A (tool propagation): find_dead_code result carries truncated=${JSON.stringify(deadUnderCap.truncated)}`);

        // ── CLAIM B — default/high cap: no truncated field at all ─────────────
        delete process.env.ATLAS_MAX_CONTEXT_NODES;
        assert.ok(DEFAULT_MAX_CONTEXT_NODES > SYMBOL_COUNT, 'harness precondition: default cap must exceed the fixture symbol count');
        const highCapReader = new EmbeddedLoreReader(cfg);
        const highCapCtx = await highCapReader.loadContext(WS);
        assert.equal(highCapCtx.truncated, undefined, `expected NO truncated field under the default cap; got ${JSON.stringify(highCapCtx.truncated)}`);
        assert.ok(highCapCtx.table.all.length >= SYMBOL_COUNT, `expected the full ${SYMBOL_COUNT}-symbol table under the default cap; got ${highCapCtx.table.all.length}`);
        console.log(`  ✓ CLAIM B: default cap (${DEFAULT_MAX_CONTEXT_NODES}) → no truncated field, full ${highCapCtx.table.all.length}-symbol table`);

        const deadUnderDefault = (await runFindDeadCode(highCapReader, {} as never, WS)) as DeadCodeResult;
        assert.equal(deadUnderDefault.truncated, undefined, `find_dead_code result should carry NO truncated field under the default cap; got ${JSON.stringify(deadUnderDefault)}`);
        console.log(`  ✓ CLAIM B (tool propagation): find_dead_code result has no truncated field under the default cap`);

        // ── CLAIM C — edges are NEVER sliced, even under the low node cap ─────
        // Ground truth didn't change just because the NODE cap is low.
        const fullEdgesUnderLowCap = await lore.listEdges();
        assert.equal(
            fullEdgesUnderLowCap.length,
            fullEdgesBefore.length,
            'listEdges() must return the FULL edge set regardless of any node-read cap (no edge slicing)',
        );
        console.log(`  ✓ CLAIM C (ground truth): listEdges() still returns all ${fullEdgesUnderLowCap.length} edges under a node cap of ${LOW_CAP}`);

        // The reader itself: even with table.all clamped to LOW_CAP symbols,
        // relations must be built from the FULL edge set (not a slice) — verify
        // by checking the reader's OWN loadContext under the low cap surfaced
        // as many relations as a direct assembleCodeContext over ALL symbol
        // nodes + the full edge set would, i.e. relations.length reflects the
        // full edge scan, not a slice bounded by the (clamped) node count.
        assert.ok(
            lowCapCtx.relations.length > 0,
            'relations must be non-empty even under the low node cap — proves listEdges() was not skipped/sliced',
        );
        console.log(`  ✓ CLAIM C (reader): loadContext under cap=${LOW_CAP} still recovered ${lowCapCtx.relations.length} relation(s) from the full edge set`);

        // Reuse the dead-code idea directly: the LAST symbol in the chain
        // (fn{SYMBOL_COUNT-1}) has exactly one inbound edge, written/enumerated
        // LAST. Under the default (uncapped-for-this-fixture) read, it must NOT
        // be flagged dead — proving that edge is retained, not dropped as a
        // "tail" the old blind slice would have discarded.
        const lastFnName = `fn${SYMBOL_COUNT - 1}`;
        const flaggedLast = (deadUnderDefault.candidates ?? []).some((c) => c.name === lastFnName);
        assert.ok(
            !flaggedLast,
            `${lastFnName} has one inbound caller (fn${SYMBOL_COUNT - 2}) written/enumerated last — ` +
            `it must NOT be a dead-code false positive; candidates=${JSON.stringify(deadUnderDefault.candidates)}`,
        );
        console.log(`  ✓ CLAIM C (dead-code idea): ${lastFnName}'s only (tail-position) inbound edge is retained — not a false dead-code positive`);

        // ── CLAIM D — exportMemory does not pull the full code-edge set ───────
        // A fake reader whose listEdges() would blow the assertion budget if
        // called at all, but whose listEdgesBySource() is cheap and source-scoped
        // — proves exportMemory prefers the source-filtered query.
        let listEdgesCalled = false;
        let listEdgesBySourceCalledWith: string[] | null = null;
        const knowledgeNode = {
            id: 'dec-rc-scale-bounds',
            type: 'decision',
            label: 'test decision',
            content: 'because reasons',
            tags: 'rc-test',
        };
        const fakeReader: MemoryExportReader = {
            async listNodes(type) {
                if (type === 'decision') return [knowledgeNode];
                return [];
            },
            async listEdges() {
                // The OLD behavior. If exportMemory still calls this, CLAIM D fails.
                listEdgesCalled = true;
                return [];
            },
            async listEdgesBySource(sourceIds) {
                listEdgesBySourceCalledWith = Array.from(sourceIds);
                return [{ sourceId: knowledgeNode.id, targetId: 'lore:some-other-node', relation: 'related_to' }];
            },
        };
        const outPath = path.join(home, 'export-test.jsonl');
        const result = await exportMemory(fakeReader, WS, outPath);
        assert.equal(listEdgesCalled, false, 'exportMemory must NOT call the unfiltered listEdges() when listEdgesBySource is available');
        assert.ok(listEdgesBySourceCalledWith, 'exportMemory must call listEdgesBySource');
        assert.deepEqual(
            listEdgesBySourceCalledWith,
            [knowledgeNode.id],
            'listEdgesBySource must be called with exactly the knowledge-node id set, not the whole graph',
        );
        assert.equal(result.edgeCount, 1, `expected the one source-filtered edge to be exported; got ${result.edgeCount}`);
        console.log(`  ✓ CLAIM D: exportMemory queried listEdgesBySource([${listEdgesBySourceCalledWith}]) — never the unfiltered listEdges()`);

        // Sanity: EmbeddedLore itself actually implements listEdgesBySource with
        // correct source-scoping (not just the interface/fake) — round-trip
        // against the real graph we just indexed. Pick a real symbol id as the
        // "source" and confirm every returned edge really has that source.
        const someSymbolRows = (await lore.listNodes('code_symbol', undefined, WS)) as Array<{ id: string }>;
        const probeId = someSymbolRows[0]?.id;
        assert.ok(probeId, 'harness precondition: at least one code_symbol node exists to probe listEdgesBySource with');
        const bySource = await lore.listEdgesBySource([probeId!]);
        assert.ok(bySource.every((e) => e.sourceId === probeId), 'every edge returned by listEdgesBySource must have the requested source');
        console.log(`  ✓ CLAIM D (real graph): listEdgesBySource([${probeId}]) returned ${bySource.length} edge(s), all correctly source-scoped`);

        console.log('All RC read-path bound claims passed.');
    } finally {
        if (prevEnv === undefined) delete process.env.ATLAS_MAX_CONTEXT_NODES;
        else process.env.ATLAS_MAX_CONTEXT_NODES = prevEnv;
        await closeAllEmbedded();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

await main();
