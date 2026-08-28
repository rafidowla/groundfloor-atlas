/**
 * tests/memory-no-native.test.ts — W2-T5: the no-native-deps CONTRACT test.
 *
 * FAILS if `atlas memory show|grep|append` (or anything in their import
 * graph — src/cli.ts's top-level imports, src/memoryFile.ts,
 * src/memoryQuery.ts) ever grows a path to the native/embedding stack:
 * kuzu, @lancedb/vectordb, better-sqlite3, onnxruntime, @xenova.
 *
 * Mechanism: the CLI is spawned as a REAL subprocess (node + tsx) with a
 * `--require` shim that patches Module._load to THROW on any forbidden module
 * request. Node's ESM→CJS interop routes native-package loads through
 * Module._load even under tsx, so both `import` and `require` paths are
 * caught (verified by hand: adding an eager `import './lore/embeddedLore.js'`
 * to src/cli.ts turns every claim here red with NATIVE_MODULE_LOADED).
 * The CLI statically imports src/memoryFile.ts + src/memoryQuery.ts, so a
 * clean run proves the library modules' graphs too.
 *
 * The subprocess also runs with every ATLAS_ and LORE_ env var scrubbed —
 * proving the bare-clone contract (no daemon, no config, no data dir).
 *
 * Uses the canonical fixture tests/fixtures/memory-150.jsonl (layout
 * documented in tests/memory-file.test.ts's header).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const CLI = path.join(repoRoot, 'src', 'cli.ts');
const FIXTURE_150 = path.join(here, 'fixtures', 'memory-150.jsonl');
const require2 = createRequire(import.meta.url);
const TSX_CLI = require2.resolve('tsx/cli');

const GUARD_SHIM = `
// Injected by tests/memory-no-native.test.ts — throws the moment module
// resolution touches the native/embedding stack.
const Module = require('node:module');
const FORBIDDEN = /(kuzu|@lancedb|vectordb|better-sqlite3|onnxruntime|@xenova)/;
const origLoad = Module._load;
Module._load = function (request) {
  if (FORBIDDEN.test(String(request))) {
    throw new Error('NATIVE_MODULE_LOADED: ' + request);
  }
  return origLoad.apply(this, arguments);
};
`;

/** Spawn `atlas memory <args>` under the guard shim with a scrubbed env. */
function runGuarded(dir: string, args: string[], stdin?: string): { status: number; stdout: string; stderr: string } {
    const shim = path.join(dir, 'native-guard.cjs');
    if (!fs.existsSync(shim)) fs.writeFileSync(shim, GUARD_SHIM);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (/^(ATLAS_|LORE_)/.test(k)) continue; // bare-clone contract: no Atlas/Lore config
        env[k] = v;
    }
    env['NODE_OPTIONS'] = `--require ${shim}`;
    try {
        const stdout = execFileSync(process.execPath, [TSX_CLI, CLI, 'memory', ...args], {
            cwd: repoRoot,
            env,
            encoding: 'utf8',
            ...(stdin !== undefined ? { input: stdin } : {}),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { status: 0, stdout, stderr: '' };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
}

/** The stdout envelope is the LAST parseable JSON line (humans skim above it). */
function lastJson(stdout: string): Record<string, unknown> {
    const jsonLines = stdout.trim().split('\n').filter((l) => l.startsWith('{'));
    assert.ok(jsonLines.length > 0, `expected a JSON envelope in stdout, got: ${stdout}`);
    return JSON.parse(jsonLines[jsonLines.length - 1]!) as Record<string, unknown>;
}

async function main(): Promise<void> {
    console.log('memory-no-native (W2-T5) load-guard contract tests');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-noNative-'));
    try {
        // ── CLAIM 1 — `memory show` runs natively-clean in a scrubbed env ────
        {
            const r = runGuarded(dir, ['show', FIXTURE_150, '--json']);
            assert.ok(!r.stderr.includes('NATIVE_MODULE_LOADED'),
                `show must not resolve a native module:\n${r.stderr}`);
            assert.equal(r.status, 0, `show exits 0 (stderr: ${r.stderr})`);
            const env = lastJson(r.stdout);
            assert.equal(env['ok'], true);
            assert.equal(env['total'], 125);
            assert.equal(env['shown'], 110, 'superseded hidden by default');
            console.log('  ✓ CLAIM 1: memory show — zero native loads, correct JSON');
        }

        // ── CLAIM 2 — `memory grep` runs natively-clean ──────────────────────
        {
            const r = runGuarded(dir, ['grep', 'merge driver union', FIXTURE_150, '--json', '--limit', '5']);
            assert.ok(!r.stderr.includes('NATIVE_MODULE_LOADED'), `grep must not resolve a native module:\n${r.stderr}`);
            assert.equal(r.status, 0);
            const env = lastJson(r.stdout);
            assert.equal(env['ok'], true);
            assert.equal(env['matches'], 5, '--limit respected');
            assert.ok(Array.isArray(env['results']) && (env['results'] as unknown[]).length === 5);
            console.log('  ✓ CLAIM 2: memory grep — zero native loads, stable JSON for scripts');
        }

        // ── CLAIM 3 — `memory append` (stdin) runs natively-clean ────────────
        {
            const ledger = path.join(dir, 'memory.jsonl');
            fs.copyFileSync(FIXTURE_150, ledger);
            const entry = JSON.stringify({ id: 'knowledge:decision:pm-guard-1', content: 'appended under the guard', tags: 'pm' });
            const r = runGuarded(dir, ['append', ledger, '--json-lines', '-'], entry + '\n');
            assert.ok(!r.stderr.includes('NATIVE_MODULE_LOADED'), `append must not resolve a native module:\n${r.stderr}`);
            assert.equal(r.status, 0, `append exits 0 (stderr: ${r.stderr})`);
            const env = lastJson(r.stdout);
            assert.equal(env['ok'], true);
            assert.equal(env['nodeCount'], 126, '125 fixture nodes + the appended one');
            console.log('  ✓ CLAIM 3: memory append — zero native loads, prior entries preserved');
        }

        // ── CLAIM 4 — the guard itself is live (control) ─────────────────────
        {
            // Prove the shim actually fires: a driver that requires a forbidden
            // name under the same shim must die with the marker. Without this
            // control, a broken shim would green-light everything above.
            const probe = path.join(dir, 'probe.cjs');
            fs.writeFileSync(probe, `require('better-sqlite3');\n`);
            const shim = path.join(dir, 'native-guard.cjs');
            let died = false;
            let stderr = '';
            try {
                execFileSync(process.execPath, ['--require', shim, probe], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (err) {
                died = true;
                stderr = String((err as { stderr?: string }).stderr ?? '');
            }
            assert.ok(died, 'the control probe must be killed by the guard');
            assert.ok(stderr.includes('NATIVE_MODULE_LOADED: better-sqlite3'), 'guard names the offender');
            console.log('  ✓ CLAIM 4: control — the guard demonstrably fires on a forbidden load');
        }

        // ── CLAIM 5 — usage/bad-file exits stay clean under the guard ────────
        {
            const usage = runGuarded(dir, ['append']);
            assert.equal(usage.status, 2, 'usage error exits 2');
            const badFile = runGuarded(dir, ['show', path.join(dir, 'no-such.jsonl')]);
            assert.equal(badFile.status, 1, 'missing file exits 1');
            assert.ok(!usage.stderr.includes('NATIVE_MODULE_LOADED') && !badFile.stderr.includes('NATIVE_MODULE_LOADED'));
            console.log('  ✓ CLAIM 5: usage(2)/bad-file(1) exit codes, still zero native loads');
        }

        // ── CLAIM 6 — the PM write path (`pm-record`) is natively clean ──────
        {
            // W3: the PM digital employee's clone has no DB — its write path must
            // load zero native modules, same contract as show/grep/append.
            const ledger = path.join(dir, 'pm.jsonl');
            const r = runGuarded(dir, [
                'pm-record', ledger, '--request-id', 'REQ-N1', '--label', 'guarded pm write',
                '--content', 'approved under the native guard', '--approved-by', 'p',
                '--approved-at', '2026-07-16T00:00:00.000Z',
            ]);
            assert.ok(!r.stderr.includes('NATIVE_MODULE_LOADED'), `pm-record must not resolve a native module:\n${r.stderr}`);
            assert.equal(r.status, 0, `pm-record exits 0 (stderr: ${r.stderr})`);
            const env = lastJson(r.stdout);
            assert.equal(env['ok'], true);
            assert.equal(env['id'], 'knowledge:decision:pm-REQ-N1', 'deterministic id written');
            console.log('  ✓ CLAIM 6: memory pm-record — zero native loads, deterministic id');
        }

        // ── CLAIM 7 — the developer flag reader (`flag`) is natively clean ───
        {
            const r = runGuarded(dir, ['flag', FIXTURE_150, '--json']);
            assert.ok(!r.stderr.includes('NATIVE_MODULE_LOADED'), `flag must not resolve a native module:\n${r.stderr}`);
            assert.equal(r.status, 0, `flag exits 0 — flag never blocks (stderr: ${r.stderr})`);
            const env = lastJson(r.stdout);
            assert.equal(env['ok'], true);
            assert.equal(env['command'], 'memory.flag');
            assert.ok(typeof env['flagged'] === 'number', 'reports a flagged count');
            console.log('  ✓ CLAIM 7: memory flag — zero native loads, read-only, exits 0');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('memory-no-native: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
