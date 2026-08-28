/**
 * tests/ide-connect-vscode.test.ts — `atlas connect vscode` / `atlas disconnect
 * vscode` e2e, on tests/ide-connect-codex.test.ts's runCli() pattern (spawn the
 * REAL CLI with HOME/ATLAS_HOME isolated to tmpdirs).
 *
 * VS Code is the one WORKSPACE-scoped client: connect writes
 * <cwd>/.vscode/mcp.json — VS Code's only officially documented concrete
 * mcp.json path (the user-profile file is opened via a command; every VS Code
 * profile keeps its own, so there is no stable global path to write). Per VS
 * Code's documented schema it manages TWO fields: the `servers` map entry
 * (note: `servers`, not `mcpServers`) and a password-masked `inputs`
 * promptString the entry's `${input:groundfloor-atlas-token}` header
 * references — the bearer NEVER lands in the file, which is what keeps it
 * committable (0644, not the token-embedding clients' 0600).
 *
 * Coverage:
 *   CLAIM A — fresh workspace: creates .vscode/mcp.json with the exact servers
 *             entry + inputs promptString, 0644, no token anywhere in the file.
 *   CLAIM B — merge into an existing config (unrelated server + unrelated
 *             input survive), idempotent re-run is byte-stable, disconnect
 *             restores the seed byte-for-byte.
 *   CLAIM C — legacy 'atlas' server key self-heals into groundfloor-atlas.
 *   CLAIM D — disconnect removes ONLY our server entry + our inputs entry;
 *             second disconnect is a no-op; a dangling inputs entry alone is
 *             still cleaned up (both-field self-heal).
 *   CLAIM E — malformed JSON and a non-array `inputs` field both fail closed:
 *             exit 1, file untouched, no backup.
 *   CLAIM F — auth on: the live bearer is NEVER written (placeholder only).
 *   CLAIM G — `atlas wire status` flips not-installed → wired → not-installed
 *             around connect/disconnect; a malformed mcp.json is 'unknown'.
 *   CLAIM H — a cwd that isn't a workspace (home dir, /) is an honest skip:
 *             the daemon's HTTP connect path must never write a stray config.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Run the repo's own tsx directly (not `npx tsx`, which resolves against cwd —
// here an isolated tmpdir workspace with no node_modules).
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const URL = 'http://127.0.0.1:3848/mcp'; // DEFAULT_PORT; no daemon needed — connect only writes files

/** The exact inputs entry connect manages (matched by id, VS Code schema). */
const INPUT: Record<string, unknown> = {
    type: 'promptString',
    id: 'groundfloor-atlas-token',
    description: 'Groundfloor Atlas MCP token (print it: atlas mcp-config --show-token)',
    password: true,
};

/** The exact servers entry connect writes — note the ${input:} placeholder,
 *  never the bearer itself. */
const ENTRY: Record<string, unknown> = {
    type: 'http',
    url: URL,
    headers: { Authorization: 'Bearer ${input:groundfloor-atlas-token}' },
};

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The engine's canonical serialization (2-space JSON + trailing newline) —
 *  every byte-exact expectation goes through here so seed and result round-trip. */
function canon(obj: unknown): string {
    return JSON.stringify(obj, null, 2) + '\n';
}

/** An isolated throwaway workspace (git-init'd so `atlas wire status`'s
 *  git-hook sync check has a repo to inspect) standing in for the project
 *  root a user runs `atlas connect vscode` from. */
function freshWorkspace(name: string): string {
    const ws = tmp(`atlas-icv-${name}-ws-`);
    execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' });
    return ws;
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Spawn the REAL CLI, exactly as a user would, with HOME/ATLAS_HOME isolated
 *  to tmpdirs and cwd = the throwaway workspace (VS Code's config is
 *  workspace-scoped, so the cwd IS the surface under test). Auth defaults to
 *  off so outcomes are deterministic. */
function runCli(args: string[], cwd: string, home: string, atlasHome: string, auth = 'off', token?: string): RunResult {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ATLAS_HOME: atlasHome, ATLAS_MCP_AUTH: auth };
    if (token === undefined) delete env['ATLAS_MCP_TOKEN'];
    else env['ATLAS_MCP_TOKEN'] = token;
    try {
        const stdout = execFileSync(TSX, [path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
            cwd,
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

function mcpJson(ws: string): string {
    return path.join(ws, '.vscode', 'mcp.json');
}

function backupsIn(ws: string): string[] {
    const dir = path.join(ws, '.vscode');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.bak-groundfloor-atlas-')) : [];
}

/** Parse the single JSON blob `atlas wire status` prints off its stdout. */
function wireStatusTools(r: RunResult): Record<string, string> {
    const json = r.stdout.slice(r.stdout.indexOf('{'));
    const parsed = JSON.parse(json) as { tools: Record<string, string> };
    return parsed.tools;
}

async function main(): Promise<void> {
    console.log('Running ide-connect-vscode tests…');
    const atlasHome = tmp('atlas-icv-atlashome-');

    // ── CLAIM A — fresh workspace: no .vscode dir even exists yet ─────────
    {
        const home = tmp('atlas-icv-a-home-');
        const ws = freshWorkspace('a');
        const r = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r.code, 0, `A: connect vscode exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('wrote groundfloor-atlas'), `A: reports a write, got: ${r.stdout}`);
        assert.ok(r.stdout.includes('VS Code prompts for the token'), `A: tells the user about the one-time prompt, got: ${r.stdout}`);
        const file = mcpJson(ws);
        assert.ok(fs.existsSync(file), 'A: .vscode/mcp.json was created (with the .vscode dir)');
        assert.equal(fs.readFileSync(file, 'utf8'), canon({ servers: { 'groundfloor-atlas': ENTRY }, inputs: [INPUT] }),
            'A: exact file content — servers entry with ${input:} header + inputs promptString');
        assert.equal(mode(file), 0o644, 'A: token-free committable file keeps normal 0644 perms (NOT the token clients\' 0600)');
        assert.ok(!fs.readFileSync(file, 'utf8').includes('<TOKEN>'), 'A: no token placeholder leaks into the file');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM A — connect creates .vscode/mcp.json (servers + inputs, ${input:} indirection, 0644)');
    }

    // ── CLAIM B — merge, idempotence, disconnect restores the seed ────────
    {
        const home = tmp('atlas-icv-b-home-');
        const ws = freshWorkspace('b');
        fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
        const otherServer = { type: 'stdio', command: 'uvx', args: ['other-mcp', '--verbose'] };
        const otherInput = { type: 'promptString', id: 'someone-elses-key', description: 'Other API key', password: true };
        const seedObj = { servers: { 'other-tool': otherServer }, inputs: [otherInput] };
        // Seed in the engine's own canonical form so byte-exact comparisons
        // after merge/disconnect are meaningful.
        const seed = canon(seedObj);
        fs.writeFileSync(mcpJson(ws), seed);

        const r1 = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r1.code, 0, `B: first connect exits 0 (stderr: ${r1.stderr})`);
        const after1 = fs.readFileSync(mcpJson(ws), 'utf8');
        assert.equal(after1, canon({ servers: { 'other-tool': otherServer, 'groundfloor-atlas': ENTRY }, inputs: [otherInput, INPUT] }),
            'B: our server appended + our input appended; unrelated server and input survive with their values intact');

        const r2 = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r2.code, 0, 'B: second connect exits 0');
        const after2 = fs.readFileSync(mcpJson(ws), 'utf8');
        assert.equal(after2, after1, 'B: re-run is byte-stable (no duplicate entries, no formatting churn)');
        assert.equal(count(after2, '"groundfloor-atlas"'), 1, 'B: exactly one groundfloor-atlas server key');
        assert.equal(count(after2, 'groundfloor-atlas-token'), 2, 'B: our input id appears exactly twice (inputs entry + header placeholder)');
        assert.equal(count(after2, 'other-tool'), 1, 'B: unrelated server not duplicated');
        assert.equal(count(after2, 'someone-elses-key'), 1, 'B: unrelated input not duplicated');
        assert.ok(backupsIn(ws).length >= 1, 'B: a backup was written before editing the existing file');

        const r3 = runCli(['disconnect', 'vscode'], ws, home, atlasHome);
        assert.equal(r3.code, 0, 'B: disconnect exits 0');
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), seed, 'B: disconnect restores the seed byte-for-byte (no empty inputs [] husk)');
        assert.equal(mode(mcpJson(ws)), 0o644, 'B: perms stay 0644 through the disconnect rewrite');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM B — merge preserves unrelated entries, re-run stable, disconnect restores the seed');
    }

    // ── CLAIM C — legacy 'atlas' server key self-heals to the current key ─
    {
        const home = tmp('atlas-icv-c-home-');
        const ws = freshWorkspace('c');
        fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
        fs.writeFileSync(mcpJson(ws), canon({
            servers: { atlas: { type: 'http', url: 'http://old.example/mcp' }, other: { type: 'stdio', command: 'uvx' } },
        }));
        const r = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r.code, 0, `C: connect over a legacy-named entry exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('migrated from atlas'), `C: reports the migration, got: ${r.stdout}`);
        const cfg = JSON.parse(fs.readFileSync(mcpJson(ws), 'utf8')) as Record<string, unknown>;
        const servers = cfg['servers'] as Record<string, unknown>;
        assert.ok(!('atlas' in servers), 'C: no legacy atlas key remains');
        assert.ok('groundfloor-atlas' in servers, 'C: current key written');
        assert.ok('other' in servers, 'C: unrelated server survives the migration');
        assert.ok(Array.isArray(cfg['inputs']) && (cfg['inputs'] as Record<string, unknown>[]).some((e) => e['id'] === INPUT['id']),
            'C: our inputs entry added alongside');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM C — pre-rename atlas entry migrates to groundfloor-atlas in place');
    }

    // ── CLAIM D — disconnect removes exactly ours; dangling input heals ───
    {
        const home = tmp('atlas-icv-d-home-');
        const ws = freshWorkspace('d');
        fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
        const first = { type: 'stdio', command: 'a' };
        const last = { type: 'stdio', command: 'z' };
        const otherInput = { type: 'promptString', id: 'someone-elses-key', description: 'Other', password: true };
        fs.writeFileSync(mcpJson(ws), canon({
            servers: { first, 'groundfloor-atlas': { type: 'http', url: 'http://stale/mcp' }, last },
            inputs: [INPUT, otherInput],
        }));
        const r = runCli(['disconnect', 'vscode'], ws, home, atlasHome);
        assert.equal(r.code, 0, `D: disconnect exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('removed groundfloor-atlas'), `D: reports the removal, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), canon({ servers: { first, last }, inputs: [otherInput] }),
            'D: only our server entry + our inputs entry removed; neighbours intact');
        const r2 = runCli(['disconnect', 'vscode'], ws, home, atlasHome);
        assert.equal(r2.code, 0, 'D: second disconnect is a clean no-op');
        assert.ok(r2.stdout.includes('no groundfloor-atlas entry present'), 'D: second disconnect reports nothing to remove');

        // Dangling inputs entry alone (server entry already gone) still heals.
        fs.writeFileSync(mcpJson(ws), canon({ inputs: [INPUT] }));
        const r3 = runCli(['disconnect', 'vscode'], ws, home, atlasHome);
        assert.equal(r3.code, 0, 'D: disconnect over a dangling inputs entry exits 0');
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), '{}\n', 'D: the dangling inputs entry is removed and no empty [] husk remains');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM D — disconnect excises exactly our two entries; second run no-op; dangling input heals');
    }

    // ── CLAIM E — malformed config fails closed, file untouched ───────────
    {
        const home = tmp('atlas-icv-e-home-');
        const ws = freshWorkspace('e');
        fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
        const malformed = '{ "servers": { this is not valid json,,,';
        fs.writeFileSync(mcpJson(ws), malformed);
        const r = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r.code, 1, 'E: connect over malformed JSON exits 1 (failed)');
        assert.ok(r.stdout.includes('left untouched'), `E: reports the fail-closed outcome, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), malformed, 'E: malformed file is byte-identical — never overwritten');
        assert.equal(backupsIn(ws).length, 0, 'E: no backup written (nothing was edited)');
        const r2 = runCli(['disconnect', 'vscode'], ws, home, atlasHome);
        assert.equal(r2.code, 1, 'E: disconnect over malformed JSON also fails closed');
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), malformed, 'E: still untouched after disconnect attempt');

        // A non-array `inputs` field is a shape we don't understand — same
        // fail-closed contract rather than clobbering it.
        const badInputs = JSON.stringify({ servers: {}, inputs: 'nope' });
        fs.writeFileSync(mcpJson(ws), badInputs);
        const r3 = runCli(['connect', 'vscode'], ws, home, atlasHome);
        assert.equal(r3.code, 1, 'E: connect over a non-array inputs field exits 1');
        assert.ok(r3.stdout.includes('left untouched'), `E: reports the fail-closed outcome, got: ${r3.stdout}`);
        assert.equal(fs.readFileSync(mcpJson(ws), 'utf8'), badInputs, 'E: non-array inputs file untouched');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM E — malformed JSON / non-array inputs → failed, exit 1, file untouched, no backup');
    }

    // ── CLAIM F — auth on: the live bearer NEVER lands in the file ────────
    {
        const home = tmp('atlas-icv-f-home-');
        const ws = freshWorkspace('f');
        const r = runCli(['connect', 'vscode'], ws, home, atlasHome, 'on', 'testtoken-deadbeef');
        assert.equal(r.code, 0, `F: connect with auth on exits 0 (stderr: ${r.stderr})`);
        const after = fs.readFileSync(mcpJson(ws), 'utf8');
        assert.ok(!after.includes('testtoken-deadbeef'), 'F: the live bearer is NEVER written to the workspace file');
        assert.ok(after.includes('${input:groundfloor-atlas-token}'), 'F: the ${input:} placeholder stands in for it');
        assert.equal(mode(mcpJson(ws)), 0o644, 'F: still 0644 — the file carries no secret and is committable');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM F — live bearer never reaches .vscode/mcp.json; only the ${input:} placeholder does');
    }

    // ── CLAIM G — `atlas wire status` flips around connect/disconnect ─────
    {
        const home = tmp('atlas-icv-g-home-');
        const ws = freshWorkspace('g');
        const before = wireStatusTools(runCli(['wire', 'status'], ws, home, atlasHome));
        assert.equal(before['vscode'], 'not-installed', 'G: vscode not-installed before connect');

        assert.equal(runCli(['connect', 'vscode'], ws, home, atlasHome).code, 0, 'G: connect exits 0');
        const wired = wireStatusTools(runCli(['wire', 'status'], ws, home, atlasHome));
        assert.equal(wired['vscode'], 'wired', 'G: vscode wired after connect');
        assert.equal(wired['cursor'], before['cursor'], 'G: other tools\' verdicts unchanged by the vscode write');

        assert.equal(runCli(['disconnect', 'vscode'], ws, home, atlasHome).code, 0, 'G: disconnect exits 0');
        const after = wireStatusTools(runCli(['wire', 'status'], ws, home, atlasHome));
        assert.equal(after['vscode'], 'not-installed', 'G: vscode back to not-installed after disconnect');

        // A legacy-named entry still counts as wired (same rule as every
        // other client), and an unparseable file is 'unknown', never a guess.
        fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
        fs.writeFileSync(mcpJson(ws), JSON.stringify({ servers: { atlas: { type: 'http', url: 'http://x/mcp' } } }));
        assert.equal(wireStatusTools(runCli(['wire', 'status'], ws, home, atlasHome))['vscode'], 'wired', 'G: legacy atlas key counts as wired');
        fs.writeFileSync(mcpJson(ws), '{ broken');
        assert.equal(wireStatusTools(runCli(['wire', 'status'], ws, home, atlasHome))['vscode'], 'unknown', 'G: malformed mcp.json reports unknown');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
        console.log('  ✓ CLAIM G — wire status flips not-installed → wired → not-installed; malformed is unknown');
    }

    // ── CLAIM H — a cwd that isn't a workspace is an honest skip ──────────
    {
        const home = tmp('atlas-icv-h-home-');
        const rHome = runCli(['connect', 'vscode'], home, home, atlasHome);
        assert.equal(rHome.code, 0, 'H: connect from the home dir exits 0 (skip, not failure)');
        assert.ok(rHome.stdout.includes('workspace-scoped'), `H: explains the skip, got: ${rHome.stdout}`);
        assert.ok(!fs.existsSync(path.join(home, '.vscode')), 'H: no stray ~/.vscode/mcp.json written');
        if (process.platform !== 'win32') {
            const rRoot = runCli(['connect', 'vscode'], '/', home, atlasHome);
            assert.equal(rRoot.code, 0, 'H: connect from / exits 0 (the launchd-daemon cwd case)');
            assert.ok(rRoot.stdout.includes('workspace-scoped'), `H: daemon-cwd case skips honestly, got: ${rRoot.stdout}`);
        }
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM H — home / filesystem-root cwd → honest workspace-scoped skip, no stray file');
    }

    fs.rmSync(atlasHome, { recursive: true, force: true });
    console.log('All ide-connect-vscode tests passed.');
}

await main();
