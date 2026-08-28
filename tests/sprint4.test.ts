/**
 * tests/sprint4.test.ts — Sprint 4 backend contract (stats + live index progress).
 *
 *   S1  index_status returns a WELL-FORMED idle progress object for a workspace
 *       that has never been indexed (no daemon, pure registry read).
 *   S2  setProgress → getProgress round-trips a partial patch (the registry the
 *       indexer publishes to and index_status reads from).
 *   S3  After a REAL index over a directory (same embedded write path as
 *       embedded-read.test.ts), index_status reflects a TERMINAL state:
 *         indexing === false, phase === 'done', filesDone === filesTotal,
 *         and nodesWritten/edgesWritten match the index's returned totals.
 *   S4  A mid-run snapshot is observable: a BatchWriter onProgress-style patch
 *       lands in the registry while phase==='writing' with filesDone<filesTotal.
 *
 * Run: tsx tests/sprint4.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getProgress,
    setProgress,
    clearProgress,
    idleProgress,
} from '../src/mcp/indexProgress.js';
import { runIndexStatusTool } from '../src/mcp/tools/indexStatus.js';

async function main(): Promise<void> {
    console.log('Atlas Sprint 4 backend tests (stats + index progress)');

    // ── S1: idle/well-formed shape for an un-indexed workspace ───────────────
    {
        const ws = 'sprint4-never-indexed';
        clearProgress(ws);
        const res = runIndexStatusTool({ workspace: ws }, ws);
        assert.equal(res.workspace, ws, 'S1 echoes workspace');
        assert.equal(res.indexing, false, 'S1 idle: not indexing');
        assert.equal(res.phase, 'idle', 'S1 idle phase');
        assert.equal(res.filesDone, 0, 'S1 filesDone 0');
        assert.equal(res.filesTotal, 0, 'S1 filesTotal 0');
        assert.equal(res.nodesWritten, 0, 'S1 nodesWritten 0');
        assert.equal(res.edgesWritten, 0, 'S1 edgesWritten 0');
        // No fabricated embed denominator on the idle shape.
        assert.equal(res.embedsPending, undefined, 'S1 no embedsPending fabricated');
        // Matches the canonical idle snapshot.
        assert.deepEqual(
            { ...idleProgress() },
            {
                indexing: false,
                phase: 'idle',
                filesDone: 0,
                filesTotal: 0,
                nodesWritten: 0,
                edgesWritten: 0,
            },
            'S1 idleProgress() canonical shape',
        );
        console.log('  ✓ S1 idle index_status well-formed');
    }

    // ── S2: registry round-trips a partial patch ─────────────────────────────
    {
        const ws = 'sprint4-patch';
        clearProgress(ws);
        setProgress(ws, { indexing: true, phase: 'writing', filesTotal: 10 });
        setProgress(ws, { filesDone: 4, nodesWritten: 40, edgesWritten: 12 });
        const p = getProgress(ws);
        assert.equal(p.indexing, true, 'S2 indexing true after patch');
        assert.equal(p.phase, 'writing', 'S2 phase carried');
        assert.equal(p.filesTotal, 10, 'S2 filesTotal carried from earlier patch');
        assert.equal(p.filesDone, 4, 'S2 filesDone from later patch');
        assert.equal(p.nodesWritten, 40, 'S2 nodesWritten merged');
        assert.equal(p.edgesWritten, 12, 'S2 edgesWritten merged');
        clearProgress(ws);
        console.log('  ✓ S2 setProgress/getProgress partial merge');
    }

    // ── S4: a mid-run snapshot is observable (writing, filesDone<filesTotal) ──
    // (Run before S3 so it doesn't depend on the heavier embedded index.)
    {
        const ws = 'sprint4-midrun';
        clearProgress(ws);
        setProgress(ws, { indexing: true, phase: 'parsing', startedAt: Date.now() });
        let snap = runIndexStatusTool({ workspace: ws }, ws);
        assert.equal(snap.indexing, true, 'S4 indexing during run');
        assert.equal(snap.phase, 'parsing', 'S4 parsing phase mid-run');
        // Simulate the BatchWriter onProgress mid-flush.
        setProgress(ws, { phase: 'writing', filesTotal: 8, filesDone: 3, nodesWritten: 30, edgesWritten: 9 });
        snap = runIndexStatusTool({ workspace: ws }, ws);
        assert.equal(snap.phase, 'writing', 'S4 writing phase mid-run');
        assert.ok(snap.filesDone < snap.filesTotal, 'S4 filesDone < filesTotal mid-run');
        assert.equal(snap.filesDone, 3, 'S4 mid-run filesDone');
        assert.equal(snap.filesTotal, 8, 'S4 mid-run filesTotal');
        clearProgress(ws);
        console.log('  ✓ S4 mid-run snapshot observable (writing, files 3/8)');
    }

    // ── S3: real index → terminal state in the registry ──────────────────────
    {
        const { loadConfig } = await import('../src/config.js');
        const { getEmbeddedLore, closeAllEmbedded } = await import('../src/mcp/embeddedRegistry.js');
        const { runIndexTool } = await import('../src/mcp/tools/index.js');

        const WS = 'sprint4-realidx';
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-s4-home-'));
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-s4-data-'));
        fs.writeFileSync(
            path.join(home, 'config.json'),
            JSON.stringify({ port: 3848, lore: { workspace: WS, mode: 'embedded', dataDir: base } }),
        );
        const cfg = loadConfig(home);
        clearProgress(WS);
        // Hermetic across back-to-back suite runs: runIndexTool's resume
        // checkpoint lives at <root>/.atlas/index-state.json (gitignored,
        // machine-local). A previous S3 run leaves it stamped for THIS
        // workspace with current fingerprints, so every later run skips all
        // 7 unchanged files, filesTotal lands at 0, and the assert below
        // fails — the full suite passed once and then failed forever after.
        // Remove the resolver-local checkpoint (NOT the repo-root .atlas,
        // which holds the real memory.jsonl) so each run does the full,
        // observable write it asserts on.
        fs.rmSync(path.resolve('src/resolver', '.atlas'), { recursive: true, force: true });
        try {
            // Index a real source dir through the SHARED embedded instance — the
            // exact write path embedded-read.test.ts exercises. This drives the
            // progress publishing in runIndexTool end to end.
            const target = path.resolve('src/resolver');
            const lore = await getEmbeddedLore(cfg, WS);
            const idx = (await runIndexTool(lore, { path: target }, WS, cfg)) as {
                filesWritten?: number; nodesWritten?: number; edgesWritten?: number;
            };
            assert.ok((idx.nodesWritten ?? 0) > 0, `S3 index wrote nodes; got ${JSON.stringify(idx)}`);

            // The index_status tool must now report a terminal, internally
            // consistent snapshot — done == total, not indexing.
            const status = runIndexStatusTool({ workspace: WS }, WS);
            assert.equal(status.indexing, false, 'S3 terminal: indexing false');
            assert.equal(status.phase, 'done', 'S3 terminal: phase done');
            assert.ok(status.filesTotal > 0, 'S3 filesTotal known after a real run');
            assert.equal(status.filesDone, status.filesTotal, 'S3 done === total');
            assert.equal(status.nodesWritten, idx.nodesWritten, 'S3 nodesWritten matches index result');
            assert.equal(status.edgesWritten, idx.edgesWritten, 'S3 edgesWritten matches index result');
            assert.ok(typeof status.startedAt === 'number', 'S3 startedAt recorded');
            assert.ok(typeof status.finishedAt === 'number', 'S3 finishedAt recorded');
            // No fabricated embedding bar for the code index (code nodes embed:false).
            assert.equal(status.embedsPending, undefined, 'S3 no embed progress fabricated for code index');
            console.log(
                `  ✓ S3 real index terminal: ${status.filesDone}/${status.filesTotal} files, ` +
                `${status.nodesWritten} nodes / ${status.edgesWritten} edges`,
            );
        } finally {
            await closeAllEmbedded();
            clearProgress(WS);
        }
    }

    console.log('All Sprint 4 backend tests passed.');
}

main().catch((err) => {
    console.error('[S4] FAILED:', err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
});
