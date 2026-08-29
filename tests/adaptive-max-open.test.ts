/**
 * tests/adaptive-max-open.test.ts — regression for the memory-aware
 * embedded-registry cap (Phase B, 2026-08).
 *
 * MAX_OPEN (concurrently-open EmbeddedLore stores, LRU-capped in
 * src/mcp/embeddedRegistry.ts) used to be a fixed `10` — an arbitrary number
 * with no relationship to the machine it ran on: dangerous on an 8GiB laptop,
 * needlessly tight on a 128GiB workstation. It is now derived once at daemon
 * boot from os.totalmem():
 *
 *     MAX_OPEN = clamp(floor(totalmem × 0.5 / 600MiB), 3, 64)
 *
 * with ATLAS_EMBEDDED_MAX_OPEN=<positive int> forcing a value outright.
 *
 * Asserts (pure-function level — no store is opened; the eviction MECHANICS
 * under the cap stay covered by tests/rc-integrity.test.ts, which pins the
 * cap for its scenario):
 *   CLAIM 1 — formula: representative machines compute the expected values
 *             (8GiB→6, 16GiB→13, 128GiB→64-clamped).
 *   CLAIM 2 — floor clamps: absurdly LOW memory still yields MIN_OPEN (a
 *             tiny box keeps a useful working set instead of 0).
 *   CLAIM 3 — ceiling clamps: absurdly HIGH memory still yields
 *             MAX_OPEN_CEILING (FD growth stays bounded on huge machines).
 *   CLAIM 4 — env override wins over memory, honored UNCLAMPED.
 *   CLAIM 5 — a garbage override is ignored (falls back to adaptive) and
 *             warns on stderr.
 *   CLAIM 6 — applyAdaptiveMaxOpen INSTALLS the decision, and
 *             embeddedMaxOpen() (the workspace_status surface) reports it
 *             with its inputs — the "why", not just the number.
 */
import * as assert from 'node:assert/strict';
import {
    computeAdaptiveMaxOpen,
    applyAdaptiveMaxOpen,
    embeddedMaxOpen,
} from '../src/mcp/embeddedRegistry.js';

const GiB = 2 ** 30;
const PER_WS = 600 * 2 ** 20; // must match embeddedRegistry.ts's figure

/** Capture console.error lines (the invalid-override warning goes to stderr). */
function captureStderr(): { lines: string[]; restore(): void } {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = original; } };
}

async function main(): Promise<void> {
    // ── CLAIM 1 — formula on representative machines ─────────────────────────
    {
        const cases: Array<[totalMem: number, expected: number, label: string]> = [
            [8 * GiB, 6, '8GiB → floor(4GiB/600MiB)=6'],
            [16 * GiB, 13, '16GiB → floor(8GiB/600MiB)=13'],
            [128 * GiB, 64, '128GiB → raw 109, clamped to ceiling 64'],
        ];
        for (const [total, expected, label] of cases) {
            const d = computeAdaptiveMaxOpen(total);
            assert.equal(d.maxOpen, expected, `CLAIM 1 (${label})`);
            assert.equal(d.source, 'adaptive', `CLAIM 1 (${label}): source`);
            assert.equal(d.totalMemBytes, total, `CLAIM 1 (${label}): echoes the input total`);
            assert.equal(d.memBudgetBytes, Math.floor(total / 2), `CLAIM 1 (${label}): budget = half of total`);
            assert.equal(d.perWorkspaceBytes, PER_WS, `CLAIM 1 (${label}): per-workspace figure exposed`);
        }
        console.log('  ✓ CLAIM 1: 8GiB→6, 16GiB→13, 128GiB→64 (ceiling), budget/inputs exposed');
    }

    // ── CLAIM 2 — floor clamp on absurdly LOW memory ─────────────────────────
    {
        for (const total of [512 * 2 ** 20, 64 * 2 ** 20, 1]) {
            const d = computeAdaptiveMaxOpen(total);
            assert.equal(d.maxOpen, d.minOpen, `CLAIM 2: totalmem=${total}B still yields the floor`);
            assert.equal(d.minOpen, 3, 'CLAIM 2: floor is MIN_OPEN=3');
        }
        console.log('  ✓ CLAIM 2: 512MiB / 64MiB / 1B machines all clamp up to MIN_OPEN=3');
    }

    // ── CLAIM 3 — ceiling clamp on absurdly HIGH memory ──────────────────────
    {
        for (const total of [2 ** 40, 100 * 2 ** 40]) {
            const d = computeAdaptiveMaxOpen(total);
            assert.equal(d.maxOpen, d.ceiling, `CLAIM 3: totalmem=${total / GiB}GiB clamps to the ceiling`);
            assert.equal(d.ceiling, 64, 'CLAIM 3: ceiling is 64');
            assert.ok(Math.floor(total / 2 / PER_WS) > 64, 'CLAIM 3: raw value really did exceed the ceiling');
        }
        console.log('  ✓ CLAIM 3: 1TiB / 100TiB machines clamp down to MAX_OPEN_CEILING=64');
    }

    // ── CLAIM 4 — env override wins, UNCLAMPED ───────────────────────────────
    {
        // Below both the floor and what adaptive would pick, and above the
        // ceiling: an operator force is honored verbatim either way.
        const lo = computeAdaptiveMaxOpen(128 * GiB, '2');
        assert.equal(lo.maxOpen, 2, 'CLAIM 4: override=2 wins on a 128GiB machine');
        assert.equal(lo.source, 'env-override', 'CLAIM 4: source marks the override');
        assert.equal(lo.memBudgetBytes, null, 'CLAIM 4: no budget consulted on override');

        const hi = computeAdaptiveMaxOpen(8 * GiB, '1000');
        assert.equal(hi.maxOpen, 1000, 'CLAIM 4: override=1000 exceeds the ceiling and is still honored');
        assert.equal(hi.source, 'env-override', 'CLAIM 4: source marks the override');

        const str = computeAdaptiveMaxOpen(8 * GiB, '10');
        assert.equal(str.maxOpen, 10, 'CLAIM 4: numeric-string override parses');
        console.log('  ✓ CLAIM 4: ATLAS_EMBEDDED_MAX_OPEN wins over memory, unclamped (2 / 1000 / "10")');
    }

    // ── CLAIM 5 — garbage override ignored + warned ──────────────────────────
    {
        const cap = captureStderr();
        try {
            for (const bad of ['abc', '0', '-5', '3.5', '']) {
                const d = computeAdaptiveMaxOpen(16 * GiB, bad);
                assert.equal(d.source, 'adaptive', `CLAIM 5: override="${bad}" ignored`);
                assert.equal(d.maxOpen, 13, `CLAIM 5: override="${bad}" falls back to the adaptive value`);
            }
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines.length, 5, 'CLAIM 5: one stderr warning per invalid value');
        assert.match(cap.lines[0], /ATLAS_EMBEDDED_MAX_OPEN/, 'CLAIM 5: warning names the env var');
        console.log('  ✓ CLAIM 5: "abc"/"0"/"-5"/"3.5"/"" ignored with a stderr warning each');
    }

    // ── CLAIM 6 — installed decision is observable via embeddedMaxOpen ───────
    {
        const d = applyAdaptiveMaxOpen(8 * GiB);
        assert.equal(d.maxOpen, 6, 'CLAIM 6: apply() returns the 8GiB decision');
        assert.deepEqual(embeddedMaxOpen(), d, 'CLAIM 6: embeddedMaxOpen() (workspace_status source) reports the installed decision');

        const forced = applyAdaptiveMaxOpen(8 * GiB, '1');
        assert.equal(forced.source, 'env-override', 'CLAIM 6: apply() honors the override arg');
        assert.equal(embeddedMaxOpen().maxOpen, 1, 'CLAIM 6: override visible through the getter');
    }
    console.log('  ✓ CLAIM 6: applyAdaptiveMaxOpen installs; embeddedMaxOpen exposes value + inputs');

    console.log('\nadaptive-max-open: all claims passed');
}

await main();
