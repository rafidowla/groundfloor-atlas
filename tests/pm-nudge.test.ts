/**
 * tests/pm-nudge.test.ts — the developer commit-time nudge (flag → hire the PM).
 *
 * Covers the free-tier experience: at commit time the pre-commit hook runs
 * `atlas memory flag --nudge`, which NAMES unbacked work and points to the PM
 * as the fix — flag, never block; silent when clean; suppressible.
 */
import * as assert from 'node:assert/strict';
import { formatFlagNudge, type UnbackedWorkFlag } from '../src/pmDecision.js';
import { buildExportHookSection } from '../src/cli/gitHooks.js';

const flag = (id: string, label: string): UnbackedWorkFlag => ({
    node: { kind: 'node', id, type: 'decision', label },
    reason: 'no approved PM change request backs this work',
});

async function main(): Promise<void> {
    console.log('pm-nudge (commit-time flag → hire-the-PM) tests');

    // ── CLAIM 1 — silent on a clean project (no nag) ─────────────────────────
    {
        assert.deepEqual(formatFlagNudge([]), [], 'no flags → no output');
        console.log('  ✓ CLAIM 1: clean project prints nothing');
    }

    // ── CLAIM 2 — names the pain AND points to the PM ────────────────────────
    {
        const lines = formatFlagNudge([flag('knowledge:decision:dev-oauth', 'Added OAuth login flow')]);
        const text = lines.join('\n');
        assert.ok(text.includes('1 change on this project has no approved change request'), 'singular count + phrasing');
        assert.ok(text.includes('Added OAuth login flow'), 'lists the offending work by label');
        assert.ok(text.includes('unbilled hours'), 'states why it matters');
        assert.ok(/PremiseHQ AI project manager/.test(text), 'points to the PM as the fix');
        assert.ok(text.includes('docs/pm-memory-contract.md'), 'honest pointer to how to enable it (not a fake button)');
        assert.ok(text.includes('ATLAS_NO_NUDGE'), 'tells the developer how to silence it');
        console.log('  ✓ CLAIM 2: names the pain, points to the PM, honest pointer + opt-out');
    }

    // ── CLAIM 3 — plural + truncation ("…and N more") ────────────────────────
    {
        const many = Array.from({ length: 5 }, (_, i) => flag(`knowledge:decision:d${i}`, `Change ${i}`));
        const lines = formatFlagNudge(many, { maxItems: 3 });
        const text = lines.join('\n');
        assert.ok(text.includes('5 changes on this project have no approved change request'), 'plural count + phrasing');
        assert.equal(lines.filter((l) => l.trim().startsWith('•')).length, 4, '3 items + 1 "…and N more" bullet');
        assert.ok(text.includes('…and 2 more'), 'summarizes the overflow');
        console.log('  ✓ CLAIM 3: plural phrasing + top-N with overflow summary');
    }

    // ── CLAIM 4 — the pre-commit hook actually runs the nudge (flag-never-block)
    {
        const section = buildExportHookSection('/tmp/some/repo', 'ws');
        assert.ok(section.includes('memory flag .atlas/memory.jsonl --nudge'),
            'pre-commit body runs the nudge after export');
        assert.ok(section.includes('|| true'), 'nudge can never fail the commit (flag-never-block)');
        // Regression guard: the nudge must not have displaced the W1 merge-safety flag.
        assert.ok(section.includes('--union'), 'export still carries --union');
        assert.ok(section.includes('git add -f .atlas/memory.jsonl'), 'export still force-stages the ledger');
        assert.ok(section.includes('if [ "$(pwd)" = "/tmp/some/repo" ]'), 'shared-hooks-dir repo guard intact');
        console.log('  ✓ CLAIM 4: pre-commit runs the nudge, non-blocking, without losing --union/guard');
    }

    console.log('pm-nudge: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
