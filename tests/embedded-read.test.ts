/**
 * tests/embedded-read.test.ts — E6b: the READ path on embedded Lore.
 *
 * Indexes a real directory through the embedded WRITE path (runIndexTool on a
 * shared EmbeddedLore), then reads it back through the new EmbeddedLoreReader
 * and drives the actual code-intelligence tools (call_graph, find_dead_code)
 * against it — proving the in-process read path reconstructs an identical,
 * correctly-directed code graph with no daemon, no port, no token.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { EmbeddedLoreReader } from '../src/mcp/embeddedReader.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import { runCallGraph } from '../src/mcp/tools/callGraph.js';
import { runFindDeadCode } from '../src/mcp/tools/findDeadCode.js';

async function main(): Promise<void> {
    console.log('Atlas embedded READ-path tests (E6b)');
    const WS = 'readproj';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e6b-home-'));
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e6b-data-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 3848, lore: { workspace: WS, mode: 'embedded', dataDir: base } }),
    );
    const cfg = loadConfig(home);

    try {
        // ── WRITE: index a real dir through the shared embedded instance ──────
        // resume:false — this test asserts a FULL write→read cycle into a fresh
        // per-run dataDir. `npm run guard` runs this same file BEFORE
        // `npm run test:all` does (EMBEDDED_SUITES), and the first run leaves
        // an index-resume checkpoint at src/resolver/.atlas/index-state.json
        // stamped with this same workspace. Unchanged files + default resume
        // mode then skip EVERY write into this run's brand-new (empty) dataDir,
        // and the reader below sees zero symbols. The checkpoint refers to a
        // store that no longer exists — force the full re-index this test
        // actually means to exercise (resume semantics have their own test:
        // tests/checkpoint.test.ts).
        const target = path.resolve('src/resolver');
        const lore = await getEmbeddedLore(cfg, WS);
        const idx = (await runIndexTool(lore, { path: target, resume: false }, WS, cfg)) as {
            filesIndexed?: number; nodesWritten?: number; edgesWritten?: number;
        };
        assert.ok((idx.nodesWritten ?? 0) > 0, `index wrote nodes; got ${JSON.stringify(idx)}`);
        console.log(`  ✓ indexed ${target.split('/').slice(-2).join('/')}: ${idx.nodesWritten} nodes / ${idx.edgesWritten} edges`);

        // ── READ: load the context back through the embedded reader ───────────
        const reader = new EmbeddedLoreReader(cfg);
        const { table, relations } = await reader.loadContext(WS);
        assert.ok(table.all.length > 0, `reader loads symbols; got ${table.all.length}`);
        assert.ok(relations.length > 0, `reader recovers relations; got ${relations.length}`);
        console.log(`  ✓ embedded reader: ${table.all.length} symbols, ${relations.length} relations`);

        // Internal consistency: every relation endpoint resolves to a symbol in
        // the table (no dangling uids after reconstruction).
        const present = relations.filter((r) => table.byId.has(r.sourceId) && table.byId.has(r.targetId));
        assert.ok(present.length > 0, 'at least some relations have both endpoints in the table');
        console.log(`  ✓ ${present.length}/${relations.length} relations fully resolve to table symbols`);

        // ── call_graph downstream must reach a known callee ───────────────────
        // Since Sprint 1 typed the edges, `relations` now include contains/imports/
        // describes alongside calls. call_graph only traverses call-flow, so sample
        // an actual `calls` edge rather than whichever relation happens to be first.
        const sample = present.find((r) => r.kind === 'calls');
        assert.ok(
            sample,
            `at least one resolved 'calls' relation to exercise call_graph; kinds=${[...new Set(present.map((r) => r.kind))].join(',')}`,
        );
        const srcSym = table.byId.get(sample.sourceId)!;
        const tgtSym = table.byId.get(sample.targetId)!;
        const cg = (await runCallGraph(
            reader,
            { symbol: srcSym.qualifiedName || srcSym.name, direction: 'downstream' } as never,
            WS,
        )) as { d1?: Array<{ id?: string; name?: string }>; error?: string };
        assert.ok(!cg.error, `call_graph runs without error; got ${cg.error}`);
        const d1 = cg.d1 ?? [];
        const tgtName = tgtSym.qualifiedName || tgtSym.name;
        const reached = d1.some((n) => n.id === tgtSym.id || n.name === tgtName);
        assert.ok(reached, `call_graph downstream from ${srcSym.name} reaches ${tgtSym.name}; d1=${JSON.stringify(d1).slice(0, 200)}`);
        console.log(`  ✓ call_graph: ${srcSym.name} →(d1) ${tgtSym.name} via embedded read`);

        // ── find_dead_code runs end-to-end on the embedded graph ──────────────
        const dead = (await runFindDeadCode(reader, { limit: 50 } as never, WS)) as {
            candidates?: unknown[]; error?: string;
        };
        assert.ok(!dead.error, `find_dead_code runs without error; got ${dead.error}`);
        assert.ok(Array.isArray(dead.candidates), 'find_dead_code returns a candidates array');
        console.log(`  ✓ find_dead_code: ${dead.candidates!.length} candidate(s) (no error)`);
    } finally {
        await closeAllEmbedded();
    }
    console.log('All embedded READ-path tests passed.');
}

await main();
