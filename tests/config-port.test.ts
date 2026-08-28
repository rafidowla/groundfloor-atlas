/**
 * tests/config-port.test.ts — ATLAS_PORT env override honored by loadConfig.
 *
 * Regression: `atlas service install --port N` injects ATLAS_PORT=N into the
 * LaunchAgent plist env, but loadConfig() only read `port` from config.json, so
 * the override was silently dropped (daemon kept binding DEFAULT_PORT 3848).
 *
 *   CLAIM A — ATLAS_PORT (valid int) overrides config.json's port.
 *   CLAIM B — ATLAS_PORT overrides the DEFAULT_PORT when no config.json exists.
 *   CLAIM C — unset/blank ATLAS_PORT leaves config.port untouched.
 *   CLAIM D — set-but-invalid ATLAS_PORT throws (loud misconfig, not silent).
 *
 * tsx-style: node:assert, top-level await, a tmp ATLAS_HOME — matching the
 * other tests/*.test.ts (no real test framework).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, DEFAULT_PORT } from '../src/config.js';

function tmpHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-cfgport-${tag}-`));
}

/** Run a thunk with ATLAS_PORT set to `val` (or deleted when undefined). */
function withAtlasPort<T>(val: string | undefined, fn: () => T): T {
    const prev = process.env['ATLAS_PORT'];
    if (val === undefined) delete process.env['ATLAS_PORT'];
    else process.env['ATLAS_PORT'] = val;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env['ATLAS_PORT'];
        else process.env['ATLAS_PORT'] = prev;
    }
}

function writeConfig(home: string, obj: unknown): void {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(obj), 'utf-8');
}

async function main(): Promise<void> {
    // ── CLAIM A — ATLAS_PORT overrides config.json's port ────────────────────
    {
        const home = tmpHome('a');
        writeConfig(home, { port: 3848 });
        const cfg = withAtlasPort('9000', () => loadConfig(home));
        assert.equal(cfg.port, 9000, 'ATLAS_PORT must override config.json port');
    }

    // ── CLAIM B — ATLAS_PORT overrides DEFAULT_PORT (no config.json) ──────────
    {
        const home = tmpHome('b'); // no config.json written
        const cfg = withAtlasPort('9100', () => loadConfig(home));
        assert.equal(cfg.port, 9100, 'ATLAS_PORT must override DEFAULT_PORT');
        // sanity: without the override it would be DEFAULT_PORT
        const baseline = withAtlasPort(undefined, () => loadConfig(home));
        assert.equal(baseline.port, DEFAULT_PORT, 'baseline must be DEFAULT_PORT');
    }

    // ── CLAIM C — unset/blank ATLAS_PORT leaves config.port untouched ─────────
    {
        const home = tmpHome('c');
        writeConfig(home, { port: 4242 });
        const unset = withAtlasPort(undefined, () => loadConfig(home));
        assert.equal(unset.port, 4242, 'unset ATLAS_PORT must not change config.port');
        const blank = withAtlasPort('   ', () => loadConfig(home));
        assert.equal(blank.port, 4242, 'blank ATLAS_PORT must not change config.port');
    }

    // ── CLAIM D — set-but-invalid ATLAS_PORT throws ──────────────────────────
    {
        const home = tmpHome('d');
        writeConfig(home, { port: 3848 });
        for (const bad of ['0', '70000', '-1', 'abc', '80.5']) {
            assert.throws(
                () => withAtlasPort(bad, () => loadConfig(home)),
                /ATLAS_PORT must be 1\.\.65535/,
                `ATLAS_PORT=${bad} must throw`,
            );
        }
    }

    console.log('config-port.test.ts — all claims passed ✓');
}

await main();
