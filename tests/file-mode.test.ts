/**
 * tests/file-mode.test.ts — owner-only (0700) on-disk hardening (RC wave 6 delta).
 *
 * ATLAS_HOME holds config.json (apiKeys) + the mcp/auth token files, and
 * lore-data/<workspace> holds the full source-code graph (kuzu+lancedb+sqlite).
 * On a multi-user host none of it may be world-readable. main already hardens
 * ATLAS_HOME in the config-WRITE paths but left three gaps this test guards:
 *   CLAIM A — embeddedRegistry.ensureEmbeddedBaseDir → lore-data root 0700
 *   CLAIM B — EmbeddedLore.open(dataDir)             → per-workspace dataDir 0700
 *   CLAIM C — installService                          → ATLAS_HOME 0700 (audit finding)
 *
 * POSIX-only mode assertions are skipped on win32; CLAIM C (installService)
 * asserts the macOS-only effect on darwin and the refusal guard elsewhere.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert';
import { ensureEmbeddedBaseDir } from '../src/mcp/embeddedRegistry.js';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { installService, type Exec } from '../src/cli/service.js';

const isWin = process.platform === 'win32';
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

async function main(): Promise<void> {
    console.log('Running file-mode (0700) hardening test…');
    const cleanup: string[] = [];
    try {
        // ── CLAIM A — lore-data root ─────────────────────────────────────────
        {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fm-a-'));
            cleanup.push(home);
            // Minimal cfg surface ensureEmbeddedBaseDir reads: home + lore.dataDir.
            const cfg = { home, lore: { dataDir: undefined } } as unknown as Parameters<typeof ensureEmbeddedBaseDir>[0];
            const dir = ensureEmbeddedBaseDir(cfg);
            assert.ok(fs.existsSync(dir), 'lore-data root created');
            if (!isWin) assert.equal(mode(dir), 0o700, `CLAIM A: lore-data root 0700, got ${mode(dir).toString(8)}`);
            console.log('  ✓ CLAIM A: ensureEmbeddedBaseDir → lore-data root 0700');
        }

        // ── CLAIM B — per-workspace dataDir (real kuzu+lancedb+sqlite open) ───
        {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fm-b-'));
            cleanup.push(base);
            const dataDir = path.join(base, 'ws-data');
            const lore = await EmbeddedLore.open(dataDir);
            try {
                assert.ok(fs.existsSync(dataDir), 'dataDir created by open()');
                if (!isWin) assert.equal(mode(dataDir), 0o700, `CLAIM B: dataDir 0700, got ${mode(dataDir).toString(8)}`);
            } finally {
                await lore.close();
            }
            console.log('  ✓ CLAIM B: EmbeddedLore.open → dataDir 0700');
        }

        // ── CLAIM C — installService hardens ATLAS_HOME ──────────────────────
        // `atlas service` is macOS-only by design (LaunchAgents — see
        // cli/service.ts darwinGuard) and must REFUSE elsewhere. Same
        // convention as tests/service.test.ts: assert the 0700 effect on
        // darwin, assert the guard on every other platform.
        {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fm-c-'));
            const lad = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fm-lad-'));
            cleanup.push(home, lad);
            const exec: Exec = () => ({ status: 0, stdout: '', stderr: '' });
            // dev:true uses the tsx entry (no dist/daemon.js needed) so the test
            // runs without a build. The fake exec no-ops launchctl unload/load.
            const r = installService({ dev: true }, { launchAgentsDir: lad, exec, home });
            if (process.platform === 'darwin') {
                assert.ok(r.ok, `installService ok (${JSON.stringify(r)})`);
                assert.equal(mode(home), 0o700, `CLAIM C: ATLAS_HOME 0700, got ${mode(home).toString(8)}`);
                console.log('  ✓ CLAIM C: installService → ATLAS_HOME 0700');
            } else {
                assert.equal(r.ok, false, `installService refuses on ${process.platform} (${JSON.stringify(r)})`);
                console.log(`  ✓ CLAIM C: installService refuses on ${process.platform} (macOS-only LaunchAgent)`);
            }
        }

        console.log('All file-mode claims passed — dirs are owner-only 0700.');
    } finally {
        for (const p of cleanup) {
            try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
