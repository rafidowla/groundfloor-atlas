/**
 * tests/maintenance-overlap-guard.test.ts — proves createMaintenanceTicker()
 * (extracted from daemon.ts) actually prevents overlapping runMaintenance()
 * calls, against the REAL daemon code path and a real EmbeddedLore instance
 * (scratch dir — never touches ~/.groundfloor).
 *
 * Regression target: groundfloor-lore's 2026-08-26 spike measured 65-73%
 * failure when two maintenance passes race the same table (their
 * overlapping-optimize.mjs repro). This drives the same "next tick fires
 * while the previous pass is still running" shape through Atlas's own
 * scheduler, with a stubbed runMaintenance() standing in for a slow/stalled
 * LanceDB optimize() call, and asserts the guard keeps concurrency at 1.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeEmbeddedLore } from '../src/mcp/embeddedRegistry.js';
import { createMaintenanceTicker } from '../src/daemon.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    console.log('Maintenance overlap guard tests');
    const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-maint-guard-test-'));
    const cfg = { ...loadConfig(), lore: { ...loadConfig().lore, dataDir: scratchBase } };
    const WS = 'maintguardtest';

    const lore = await getEmbeddedLore(cfg, WS);
    try {
        let inFlight = 0;
        let maxConcurrent = 0;
        let callCount = 0;
        const PASS_MS = 150;

        // Stand in for a slow/stalled LanceDB optimize() — the real failure
        // mode this test targets. Instance-level assignment shadows the
        // prototype method; type must match runMaintenance's real signature.
        lore.runMaintenance = async (_opts?: { dryRun?: boolean; cutoff?: string }): Promise<unknown> => {
            callCount++;
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            try {
                await sleep(PASS_MS);
                return { ok: true };
            } finally {
                inFlight--;
            }
        };

        const tick = createMaintenanceTicker();

        // Fire three ticks in quick succession while the first pass is still
        // running — exactly "next tick fires while the previous is in
        // flight," the scenario groundfloor-lore measured as 65-73% failure.
        tick();
        await sleep(20);
        tick();
        await sleep(20);
        tick();

        // Let the first pass (and the guard's own async tail) fully resolve.
        await sleep(PASS_MS + 100);

        // One more tick now that the previous pass has finished — this one
        // should actually run.
        tick();
        await sleep(PASS_MS + 100);

        assert.equal(
            maxConcurrent, 1,
            `no two maintenance passes should ever run concurrently — observed max concurrency ${maxConcurrent}`,
        );
        assert.equal(
            callCount, 2,
            `expected exactly 2 passes to run (the first + the one after it finished); the two overlapping ticks in between must be skipped — got ${callCount}`,
        );
        console.log(`  ✓ overlap guard: ${callCount} passes ran, max concurrency ${maxConcurrent}, overlapping ticks skipped`);
    } finally {
        await closeEmbeddedLore(cfg, WS);
        fs.rmSync(scratchBase, { recursive: true, force: true });
    }
    console.log('All maintenance overlap guard tests passed.');
}

await main();
