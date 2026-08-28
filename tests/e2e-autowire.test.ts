/**
 * tests/e2e-autowire.test.ts — Atlas auto-wire Part 7: end-to-end proof.
 *
 * Parts 1-6 (docs/plans/ATLAS-AUTOWIRE-PLAN.md) each landed with their own
 * unit/integration coverage — this file is the single scripted run the plan
 * asks for: fresh global-hook install → touch a never-seen project → it
 * onboards and announces exactly once → memory answers for it once indexing
 * completes → `wire uninstall --global` removes everything → repeat 3×
 * confirming identical results each time.
 *
 * Drives the REAL CLI as a subprocess for install/uninstall (`npx tsx
 * src/cli.ts wire install|uninstall --global`, same as
 * tests/global-wire-uninstall.test.ts's CLAIM G) so this is a genuine
 * end-to-end exercise of the command a user actually runs, not just the
 * library functions behind it. Onboarding is driven through the REAL
 * installed hook command (scripts/atlas-hook.mjs, spawned exactly as Claude
 * Code would invoke it) against one real, in-process daemon
 * (startAtlasMcpServer) shared across all three cycles — a fresh, isolated
 * HOME (for the global settings file) and a fresh, never-before-seen fixture
 * project are used PER CYCLE, so "repeat 3×" proves the whole install →
 * onboard → memory → uninstall sequence is stable across independent runs
 * against one long-lived daemon, the same way the real launchd-managed
 * daemon stays up across many install/uninstall cycles on a real machine.
 *
 *   CLAIM A(n) — fresh `wire install --global` in an isolated HOME succeeds
 *                and writes a workspace-less Atlas hook.
 *   CLAIM B(n) — first touch of a never-seen, real (tier-2, has-git) fixture
 *                project returns fast and announces onboarding of its
 *                derived workspace EXACTLY once; a second touch does not
 *                repeat the announcement.
 *   CLAIM C(n) — the background index this kicked off actually completes,
 *                and memory answers for it afterward: `workspace_status`
 *                over a real MCP client reports real node/edge content, not
 *                zero.
 *   CLAIM D(n) — `wire uninstall --global` in the SAME isolated HOME removes
 *                the hook entirely (zero Atlas commands remain in the global
 *                settings file) and does not error.
 *   CLAIM E     — all of A-D above hold, independently and identically,
 *                 across 3 consecutive cycles against the one shared daemon.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { globalSettingsPath } from '../src/cli/globalWire.js';
import { HOOK_TAG } from '../src/cli/wire.js';
import { loadConfig } from '../src/config.js';
import { getProgress } from '../src/mcp/indexProgress.js';
import { closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { deriveOnboardWorkspace } from '../src/mcp/backgroundOnboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A minimal, isolated-hooks git repo — tier-2 (has-git) per Part 4, indexes
 *  almost instantly (one tiny file). A fresh one per cycle so each cycle
 *  genuinely onboards a NEVER-seen project, not a repeat touch. */
function freshFixtureProject(n: number): string {
    const dir = tmp(`atlas-e2e-autowire-fixture-c${n}-`);
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks); // never touch ~/.groundfloor/hooks
    fs.writeFileSync(path.join(dir, 'index.ts'), `export function cycle${n}(): number { return ${n}; }\n`);
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
    return dir;
}

interface Settings {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>; PostToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> };
    [k: string]: unknown;
}

function readSettings(file: string): Settings {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Settings;
}

function atlasCommands(s: Settings): string[] {
    const all = [...(s.hooks?.PreToolUse ?? []), ...(s.hooks?.PostToolUse ?? [])];
    return all.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes(HOOK_TAG));
}

function commandFor(s: Settings, event: 'PreToolUse' | 'PostToolUse', matcher: string): string {
    const entries = s.hooks?.[event] ?? [];
    const e = entries.find((x) => x.matcher === matcher);
    assert.ok(e, `expected a ${event} entry with matcher ${matcher}`);
    const cmd = e!.hooks[0]?.command;
    assert.ok(cmd, `expected a command on ${event}/${matcher}`);
    return cmd!;
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Spawn the REAL CLI, exactly as a user would (`npx tsx src/cli.ts …`). */
function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
    try {
        const stdout = execFileSync('npx', ['tsx', CLI, ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout: stdout.toString('utf-8'), stderr: '' };
    } catch (err) {
        const e = err as { status: number | null; stdout?: Buffer; stderr?: Buffer };
        return { code: e.status, stdout: e.stdout?.toString('utf-8') ?? '', stderr: e.stderr?.toString('utf-8') ?? '' };
    }
}

interface HookRun { stdout: string; code: number | null }

function runHookCommand(cmdLine: string, opts: { cwd: string; env: NodeJS.ProcessEnv; payload: Record<string, unknown> }): Promise<HookRun> {
    return new Promise((resolve) => {
        const child = spawn(cmdLine, { cwd: opts.cwd, env: opts.env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
        child.on('close', (code) => resolve({ stdout, code }));
        child.stdin.end(JSON.stringify(opts.payload));
    });
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['ATLAS_MCP_TOKEN'];
    delete env['ATLAS_MCP_AUTH'];
    return { ...env, ...extra };
}

function contextOf(run: HookRun): string {
    if (!run.stdout.trim()) return '';
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? '';
}

async function waitForDone(workspace: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const p = getProgress(workspace);
        if (!p.indexing && (p.phase === 'done' || p.phase === 'error')) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`index did not finish within ${timeoutMs}ms (phase=${getProgress(workspace).phase})`);
}

async function invoke(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const res = await client.callTool({ name: 'atlas_tool_invoke', arguments: { tool, args } });
    const content = res.content as Array<{ type: string; text: string }>;
    if (!content?.[0]?.text) return null;
    try { return JSON.parse(content[0].text); } catch { return content[0].text; }
}

/** One full cycle: install → onboard+announce → memory answers → uninstall. */
async function runCycle(n: number, port: number, atlasHome: string, mcpClient: Client): Promise<void> {
    const globalHome = tmp(`atlas-e2e-autowire-globalhome-c${n}-`);
    const hookTmp = tmp(`atlas-e2e-autowire-hooktmp-c${n}-`);
    const fixture = freshFixtureProject(n);
    const cleanup = [globalHome, hookTmp, fixture];

    try {
        // ── (a) CLAIM A(n) — fresh `wire install --global` in an isolated HOME ──
        const cliEnv: NodeJS.ProcessEnv = { ...process.env, HOME: globalHome, ATLAS_HOME: atlasHome, ATLAS_MCP_AUTH: 'off' };
        delete cliEnv['ATLAS_MCP_TOKEN'];
        const installRun = runCli(['wire', 'install', '--global'], cliEnv);
        assert.equal(installRun.code, 0, `cycle ${n}: wire install --global must exit 0 (stderr: ${installRun.stderr})`);
        const settingsFile = globalSettingsPath(globalHome);
        assert.ok(fs.existsSync(settingsFile), `cycle ${n}: global settings file exists after install`);
        const installedSettings = readSettings(settingsFile);
        assert.equal(atlasCommands(installedSettings).length, 3, `cycle ${n}: all three Atlas hook entries present`);
        const preSearchCmd = commandFor(installedSettings, 'PreToolUse', 'Grep|Glob');
        assert.doesNotMatch(preSearchCmd, /pre-search\s+\S+$/, `cycle ${n}: installed command carries no trailing workspace token`);
        console.log(`  ✓ cycle ${n} CLAIM A — fresh global install succeeded, workspace-less hook written`);

        // ── (b) CLAIM B(n) — first touch of a never-seen tier-2 project ─────────
        const expectedWs = deriveOnboardWorkspace(fixture);
        const hookEnv = baseEnv({ ATLAS_PORT: String(port), ATLAS_HOME: atlasHome, TMPDIR: hookTmp, TMP: hookTmp, TEMP: hookTmp });
        const t0 = Date.now();
        const r1 = await runHookCommand(preSearchCmd, { cwd: fixture, env: hookEnv, payload: { session_id: `sess-c${n}-1`, cwd: fixture, tool_name: 'Grep', tool_input: { pattern: `cycle${n}` } } });
        const elapsedMs = Date.now() - t0;
        assert.equal(r1.code, 0, `cycle ${n}: hook invocation exits 0`);
        const ctx1 = contextOf(r1);
        assert.ok(elapsedMs < 5000, `cycle ${n}: first touch returns fast (${elapsedMs}ms, spawn overhead included)`);
        assert.match(ctx1, /new project detected/i, `cycle ${n}: onboarding announcement present on first touch`);
        assert.match(ctx1, new RegExp('`' + expectedWs + '`'), `cycle ${n}: announcement names the derived workspace '${expectedWs}'`);
        const occurrences = (ctx1.match(/new project detected/gi) ?? []).length;
        assert.equal(occurrences, 1, `cycle ${n}: exactly one announcement line, not repeated`);
        console.log(`  ✓ cycle ${n} CLAIM B — first touch of '${expectedWs}' announced onboarding exactly once (${elapsedMs}ms)`);

        // Second touch of the SAME fixture: no repeat announcement.
        const r2 = await runHookCommand(preSearchCmd, { cwd: fixture, env: hookEnv, payload: { session_id: `sess-c${n}-2`, cwd: fixture, tool_name: 'Grep', tool_input: { pattern: `cycle${n}` } } });
        assert.equal(r2.code, 0, `cycle ${n}: second hook invocation exits 0`);
        assert.doesNotMatch(contextOf(r2), /new project detected/i, `cycle ${n}: second touch does not repeat the announcement`);
        console.log(`  ✓ cycle ${n} CLAIM B (cont.) — second touch of the same project does not re-announce`);

        // ── (c) CLAIM C(n) — background index completes, memory answers ────────
        await waitForDone(expectedWs, 60_000);
        assert.equal(getProgress(expectedWs).phase, 'done', `cycle ${n}: background index actually completed`);
        const status = await invoke(mcpClient, 'workspace_status', { workspace: expectedWs }) as { ok: boolean; exists: boolean; nodeCount: number; edgeCount: number };
        assert.equal(status.ok, true, `cycle ${n}: workspace_status reports ok`);
        assert.equal(status.exists, true, `cycle ${n}: onboarded workspace exists`);
        assert.ok(status.nodeCount > 0, `cycle ${n}: memory answers with real content (nodeCount=${status.nodeCount})`);
        console.log(`  ✓ cycle ${n} CLAIM C — index completed, memory answers for '${expectedWs}' (nodeCount=${status.nodeCount}, edgeCount=${status.edgeCount})`);

        // ── (d) CLAIM D(n) — `wire uninstall --global` removes everything ──────
        const uninstallRun = runCli(['wire', 'uninstall', '--global'], cliEnv);
        assert.equal(uninstallRun.code, 0, `cycle ${n}: wire uninstall --global must exit 0 (stderr: ${uninstallRun.stderr})`);
        const afterUninstall = readSettings(settingsFile);
        assert.equal(atlasCommands(afterUninstall).length, 0, `cycle ${n}: zero Atlas hook entries remain after uninstall`);
        console.log(`  ✓ cycle ${n} CLAIM D — wire uninstall --global removed every Atlas hook entry`);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('Running e2e-autowire (auto-wire Part 7) tests…');
    process.env['ATLAS_MCP_AUTH'] = 'off'; // trusted-local — isolates from token minting/rotation
    const atlasHome = tmp('atlas-e2e-autowire-atlashome-');
    // loadConfig() with no override (every allTools.ts MCP tool handler,
    // including workspace_status, calls it this way) resolves the home from
    // process.env.ATLAS_HOME — startAtlasMcpServer's own `home:` option only
    // scopes ITS internal cfg (used for /hooks/context). Without this, the
    // MCP client's workspace_status call in runCycle would read/write against
    // this machine's REAL Atlas home instead of the isolated one.
    process.env['ATLAS_HOME'] = atlasHome;

    try {
        const { startAtlasMcpServer } = await import('../src/mcp/server.js');
        const srv = await startAtlasMcpServer({ port: 0, home: atlasHome });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`));
        const mcpClient = new Client({ name: 'atlas-e2e-autowire', version: '0.1.0' });
        await mcpClient.connect(transport);

        try {
            // CLAIM E — three independent cycles against the one shared daemon,
            // each proving A-D hold identically.
            for (let n = 1; n <= 3; n++) {
                console.log(`— cycle ${n}/3 —`);
                await runCycle(n, srv.port, atlasHome, mcpClient);
            }
            console.log('CLAIM E ok — 3 consecutive install→onboard→memory→uninstall cycles all passed identically');
        } finally {
            await mcpClient.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
            await srv.close();
        }
    } finally {
        delete process.env['ATLAS_MCP_AUTH'];
        delete process.env['ATLAS_HOME'];
        await closeAllEmbedded();
        fs.rmSync(atlasHome, { recursive: true, force: true });
    }

    console.log('e2e-autowire: ALL CLAIMS PASS');
}

await main();
