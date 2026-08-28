#!/usr/bin/env node
/**
 * scripts/run-all-tests.mjs — run EVERY tests/*.test.ts as a gate.
 *
 * `npm test` runs only tests/health.test.ts, and there was no script that ran the
 * whole suite, so "green" was ambiguous. This aggregator runs every committed
 * test file sequentially, keeps going on failure (so you see ALL the failures, not
 * just the first), prints a per-file PASS/FAIL table, and exits non-zero if any
 * file failed — making `npm run test:all` a real gate (the tsc --noEmit that
 * precedes it in the `test:all` script covers type errors).
 *
 * Almost every test file is self-contained (in-process embedded Lore or mock HTTP
 * servers); b3a-cloud self-exits 0 when its cloud env is absent. The ONE exception
 * is tests/x7.test.ts: it is a legacy REST-path integration test against a live,
 * Atlas-bootstrapped Lore dogfood dataset (~5.8k symbols) that only exists on a
 * developer machine with ~/.groundfloor/atlas/auth.token present. On a fresh clone
 * or CI that token is absent, so x7 is SKIPPED here (not failed) when the token is
 * missing — same opt-out idea as b3a-cloud, but gated on a file instead of an env,
 * since x7 has no self-skip and modifying it is out of scope. When the token IS
 * present (dogfood machine), x7 runs and gates normally.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'tests');

const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();

if (files.length === 0) {
    console.error('[test:all] no test files found under tests/');
    process.exit(1);
}

// x7.test.ts is a legacy REST integration test that needs an Atlas-bootstrapped
// Lore dogfood dataset + auth token present on the machine. Skip it (not fail)
// when the token is absent so the gate stays green on fresh clones / CI. See the
// header comment for the full rationale.
const x7TokenPath = path.join(os.homedir(), '.groundfloor', 'atlas', 'auth.token');
const x7Available = fs.existsSync(x7TokenPath);
if (!x7Available) {
    console.log(`[test:all] skipping tests/x7.test.ts (no Atlas auth token at ${x7TokenPath} — legacy REST integration test)`);
}

const results = [];
for (const file of files) {
    const rel = path.join('tests', file);
    if (file === 'x7.test.ts' && !x7Available) {
        results.push({ file: rel, ok: true, skipped: true });
        console.log(`[test:all] running ${rel} ... SKIP`);
        continue;
    }
    process.stdout.write(`[test:all] running ${rel} ... `);
    const t0 = Date.now();
    try {
        execFileSync('npx', ['tsx', rel], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 300_000 });
        const ms = Date.now() - t0;
        console.log(`PASS (${ms}ms)`);
        results.push({ file: rel, ok: true, ms });
    } catch (err) {
        const ms = Date.now() - t0;
        console.log(`FAIL (${ms}ms)`);
        const e = err;
        const stdout = (e.stdout?.toString() ?? '').trim();
        const stderr = (e.stderr?.toString() ?? '').trim();
        // Surface the tail of the failure so the summary is actionable without
        // re-running the file.
        const tail = (stderr || stdout).split('\n').slice(-12).join('\n');
        results.push({ file: rel, ok: false, ms, tail });
    }
}

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.ok);
console.log('');
const skipNote = skipped.length > 0 ? ` · ${skipped.length} skipped` : '';
console.log(`[test:all] ${passed.length}/${results.length} passed${skipNote}`);
if (failed.length > 0) {
    console.log(`[test:all] ${failed.length} FAILED:`);
    for (const r of failed) {
        console.log(`\n  ✗ ${r.file}`);
        if (r.tail) console.log(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
    }
    process.exit(1);
}
