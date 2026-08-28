/**
 * tests/ide-connect-codex.test.ts — `atlas connect codex` / `atlas disconnect
 * codex`: the targeted TOML merger in src/cli/ideConnect.ts (scanTomlRegions /
 * applyToml).
 *
 * ideConnect.ts resolves ~/.codex via os.homedir() at module load with no
 * injection seam, so this is a REAL-CLI e2e in the
 * tests/global-wire-uninstall.test.ts runCli() mold: every step spawns
 * `npx tsx src/cli.ts …` with HOME/ATLAS_HOME pointed at throwaway tmpdirs —
 * this machine's real ~/.codex is never read or written.
 *
 *   CLAIM A — connect on a missing ~/.codex/config.toml creates it: exactly
 *             the [mcp_servers.groundfloor-atlas] table + nested .env
 *             subtable (bearer via env var, out of argv), mode 0600, exit 0.
 *   CLAIM B — merge, never clobber: a seeded unrelated table, root
 *             key-value and comment survive (asserted by FULL-FILE byte
 *             equality); re-running connect is byte-stable and leaves
 *             exactly one groundfloor-atlas table (+backup); disconnect
 *             restores the seed byte-for-byte.
 *   CLAIM C — legacy self-heal: a pre-rename [mcp_servers.atlas] table is
 *             migrated to the current key in place ("migrated from atlas").
 *   CLAIM D — disconnect removes ONLY the groundfloor-atlas table (+ its
 *             .env subtable); unrelated tables on both sides survive
 *             byte-identical; 0600 survives the rewrite.
 *   CLAIM E — fail closed: a malformed pre-existing config.toml (unterminated
 *             table header) is reported failed (exit 1, "left untouched"),
 *             the file stays byte-identical, and NO backup is written.
 *   CLAIM F — with auth on, the real bearer flows into the .env subtable
 *             (ATLAS_MCP_TOKEN env → entry env), never into argv.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const URL = 'http://127.0.0.1:3848/mcp'; // DEFAULT_PORT; no daemon needed — connect only writes files

/** The exact block applyToml writes (token placeholder shown when
 *  ATLAS_MCP_AUTH=off — runConnect passes '<TOKEN>' through). */
const BLOCK = ''
    + '[mcp_servers.groundfloor-atlas]\n'
    + 'command = "npx"\n'
    + 'args = ["-y", "mcp-remote", "' + URL + '", "--header", "Authorization: Bearer ${ATLAS_MCP_TOKEN}"]\n'
    + '\n'
    + '[mcp_servers.groundfloor-atlas.env]\n'
    + 'ATLAS_MCP_TOKEN = "<TOKEN>"\n'
    + '\n';

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Spawn the REAL CLI, exactly as a user would, with HOME/ATLAS_HOME isolated
 *  to tmpdirs. Auth defaults to off so the written entry carries the
 *  '<TOKEN>' placeholder (deterministic content); CLAIM F opts back in. */
function runCli(args: string[], home: string, atlasHome: string, auth = 'off', token?: string): RunResult {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ATLAS_HOME: atlasHome, ATLAS_MCP_AUTH: auth };
    if (token === undefined) delete env['ATLAS_MCP_TOKEN'];
    else env['ATLAS_MCP_TOKEN'] = token;
    try {
        const stdout = execFileSync('npx', ['tsx', path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
            cwd: REPO_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: stdout.toString('utf8'), stderr: '' };
    } catch (err) {
        const e = err as { status: number | null; stdout?: Buffer; stderr?: Buffer };
        return { code: e.status, stdout: e.stdout?.toString('utf8') ?? '', stderr: e.stderr?.toString('utf8') ?? '' };
    }
}

function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

function mode(file: string): number {
    return fs.statSync(file).mode & 0o777;
}

function configToml(home: string): string {
    return path.join(home, '.codex', 'config.toml');
}

function backupsIn(home: string): string[] {
    const dir = path.join(home, '.codex');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.bak-groundfloor-atlas-')) : [];
}

async function main(): Promise<void> {
    console.log('Running ide-connect-codex tests…');
    const atlasHome = tmp('atlas-icc-atlashome-');

    // ── CLAIM A — fresh machine: ~/.codex doesn't even exist yet ──────────
    {
        const home = tmp('atlas-icc-a-home-');
        const r = runCli(['connect', 'codex'], home, atlasHome);
        assert.equal(r.code, 0, `A: connect codex exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('wrote groundfloor-atlas'), `A: reports a write, got: ${r.stdout}`);
        const file = configToml(home);
        assert.ok(fs.existsSync(file), 'A: ~/.codex/config.toml was created (with the .codex dir)');
        assert.equal(fs.readFileSync(file, 'utf8'), BLOCK, 'A: exact table content — env-var header indirection + .env subtable');
        assert.equal(mode(file), 0o600, 'A: file is owner-only (0600)');
        assert.equal(count(fs.readFileSync(file, 'utf8'), '[mcp_servers.groundfloor-atlas]'), 1, 'A: exactly one server table');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM A — connect creates ~/.codex/config.toml with the exact bridge table, 0600');
    }

    // ── CLAIM B — merge never clobbers; idempotent; disconnect restores ──
    {
        const home = tmp('atlas-icc-b-home-');
        const file = configToml(home);
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        const seed = ''
            + '# top comment — must survive\n'
            + 'model = "gpt-5.1"\n'
            + '\n'
            + '[mcp_servers.other-tool]\n'
            + 'command = "uvx"\n'
            + 'args = ["other-mcp", "--verbose"]\n'
            + '\n'
            + '[profiles.default]\n'
            + 'verbosity = 2\n';
        fs.writeFileSync(file, seed);

        const r1 = runCli(['connect', 'codex'], home, atlasHome);
        assert.equal(r1.code, 0, `B: first connect exits 0 (stderr: ${r1.stderr})`);
        const after1 = fs.readFileSync(file, 'utf8');
        assert.equal(after1, seed + '\n' + BLOCK, 'B: our table is APPENDED; every unrelated byte survives (full-file equality)');
        assert.equal(mode(file), 0o600, 'B: pre-existing file tightened to 0600 after write');

        const r2 = runCli(['connect', 'codex'], home, atlasHome);
        assert.equal(r2.code, 0, 'B: second connect exits 0');
        const after2 = fs.readFileSync(file, 'utf8');
        assert.equal(after2, after1, 'B: re-merge is byte-stable (no duplicate tables, no formatting churn)');
        assert.equal(count(after2, '[mcp_servers.groundfloor-atlas]'), 1, 'B: still exactly one server table');
        assert.equal(count(after2, '[mcp_servers.groundfloor-atlas.env]'), 1, 'B: still exactly one env subtable');
        assert.equal(count(after2, '[mcp_servers.other-tool]'), 1, 'B: unrelated table not duplicated');
        assert.ok(backupsIn(home).length >= 1, 'B: a backup was written before editing the existing file');

        const r3 = runCli(['disconnect', 'codex'], home, atlasHome);
        assert.equal(r3.code, 0, 'B: disconnect exits 0');
        assert.equal(fs.readFileSync(file, 'utf8'), seed, 'B: disconnect restores the seed byte-for-byte');
        assert.equal(mode(file), 0o600, 'B: 0600 survives the disconnect rewrite');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM B — merge preserves unrelated bytes, re-merge is stable, disconnect restores the seed');
    }

    // ── CLAIM C — legacy 'atlas' table self-heals into the current key ────
    {
        const home = tmp('atlas-icc-c-home-');
        const file = configToml(home);
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        fs.writeFileSync(file, ''
            + '# keep me\n'
            + '[mcp_servers.atlas]\n'
            + 'command = "npx"\n'
            + 'args = ["old"]\n'
            + '\n'
            + '[mcp_servers.atlas.env]\n'
            + 'ATLAS_MCP_TOKEN = "x"\n'
            + '\n'
            + '[mcp_servers.other]\n'
            + 'command = "uvx"\n');
        const r = runCli(['connect', 'codex'], home, atlasHome);
        assert.equal(r.code, 0, `C: connect over a legacy-named entry exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('migrated from atlas'), `C: reports the migration, got: ${r.stdout}`);
        const after = fs.readFileSync(file, 'utf8');
        assert.equal(after, '# keep me\n' + BLOCK + '[mcp_servers.other]\ncommand = "uvx"\n', 'C: legacy tables replaced in place; neighbours untouched');
        assert.ok(!after.includes('[mcp_servers.atlas'), 'C: no legacy atlas table (or .env) remains');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM C — pre-rename [mcp_servers.atlas] migrates to groundfloor-atlas in place');
    }

    // ── CLAIM D — disconnect removes only our table, wherever it sits ─────
    {
        const home = tmp('atlas-icc-d-home-');
        const file = configToml(home);
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        fs.writeFileSync(file, ''
            + '[mcp_servers.first]\n'
            + 'command = "a"\n'
            + '\n'
            + '[mcp_servers.groundfloor-atlas]\n'
            + 'command = "npx"\n'
            + 'args = ["stale"]\n'
            + '\n'
            + '[mcp_servers.groundfloor-atlas.env]\n'
            + 'ATLAS_MCP_TOKEN = "stale"\n'
            + '\n'
            + '[mcp_servers.last]\n'
            + 'command = "z"\n');
        const r = runCli(['disconnect', 'codex'], home, atlasHome);
        assert.equal(r.code, 0, `D: disconnect exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('removed groundfloor-atlas'), `D: reports the removal, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(file, 'utf8'), '[mcp_servers.first]\ncommand = "a"\n\n[mcp_servers.last]\ncommand = "z"\n',
            'D: only the groundfloor-atlas table (+env) removed; neighbours byte-identical');
        assert.equal(mode(file), 0o600, 'D: 0600 preserved');
        const r2 = runCli(['disconnect', 'codex'], home, atlasHome);
        assert.equal(r2.code, 0, 'D: second disconnect is a clean no-op');
        assert.ok(r2.stdout.includes('no groundfloor-atlas entry present'), 'D: second disconnect reports nothing to remove');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM D — disconnect excises exactly our table mid-file; second disconnect is a no-op');
    }

    // ── CLAIM E — malformed TOML fails closed, file untouched ─────────────
    {
        const home = tmp('atlas-icc-e-home-');
        const file = configToml(home);
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        const malformed = 'model = "gpt"\n\n[mcp_servers.other\ncommand = "broken"\n'; // unterminated header
        fs.writeFileSync(file, malformed);
        const r = runCli(['connect', 'codex'], home, atlasHome);
        assert.equal(r.code, 1, 'E: connect over malformed TOML exits 1 (failed)');
        assert.ok(r.stdout.includes('left untouched'), `E: reports the fail-closed outcome, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(file, 'utf8'), malformed, 'E: malformed file is byte-identical — never overwritten');
        assert.equal(backupsIn(home).length, 0, 'E: no backup written (nothing was edited)');
        const r2 = runCli(['disconnect', 'codex'], home, atlasHome);
        assert.equal(r2.code, 1, 'E: disconnect over malformed TOML also fails closed');
        assert.equal(fs.readFileSync(file, 'utf8'), malformed, 'E: still untouched after disconnect attempt');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM E — unterminated table header → status failed, exit 1, file untouched, no backup');
    }

    // ── CLAIM F — auth on: the real bearer lands in the env subtable ──────
    {
        const home = tmp('atlas-icc-f-home-');
        const r = runCli(['connect', 'codex'], home, atlasHome, 'on', 'testtoken-deadbeef');
        assert.equal(r.code, 0, `F: connect with auth on exits 0 (stderr: ${r.stderr})`);
        const after = fs.readFileSync(configToml(home), 'utf8');
        assert.ok(after.includes('ATLAS_MCP_TOKEN = "testtoken-deadbeef"'), 'F: real token written into the .env subtable');
        assert.ok(!after.includes('"--header", "Authorization: Bearer testtoken-deadbeef"'), 'F: bearer NOT baked into argv — env-var indirection only');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM F — live bearer flows into [.. .env], never into the spawned argv');
    }

    fs.rmSync(atlasHome, { recursive: true, force: true });
    console.log('All ide-connect-codex tests passed.');
}

await main();
