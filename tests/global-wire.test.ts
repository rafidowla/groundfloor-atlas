/**
 * tests/global-wire.test.ts — Atlas auto-wire Part 3: `atlas wire install
 * --global` (src/cli/globalWire.ts).
 *
 * Part 1 (path->workspace resolver) and Part 2 (workspace-less hook, resolved
 * from cwd) made a single machine-wide hook possible; this is the install side
 * — merging the Atlas PreToolUse/PostToolUse hook entries into the user's
 * GLOBAL ~/.claude/settings.json instead of a per-repo one, with the same
 * merge-never-clobber discipline cli/ideConnect.ts uses for IDE configs, plus
 * a de-dup contract so an already-locally-wired repo never fires twice.
 *
 *   CLAIM A — fresh install (no prior file): both hook events land with the
 *             expected matchers, and the command carries NO workspace token
 *             (workspace-less — resolved server-side from cwd).
 *   CLAIM B — merge, never clobber: every unrelated top-level key (permissions,
 *             enabledPlugins, …) and any pre-existing NON-Atlas hook entry
 *             survive install byte-for-byte (deep-equal).
 *   CLAIM C — idempotent: installing twice yields the exact same hooks arrays
 *             (no duplicate Atlas entries), unrelated keys still untouched.
 *   CLAIM D — malformed existing JSON is refused (ok:false) and the file is
 *             left completely untouched — never silently clobbered.
 *   CLAIM E — the file is chmod'd 0600 after install (matches ideConnect.ts's
 *             convention), and a backup is written before an in-place edit but
 *             NOT on a from-scratch first install (nothing to back up).
 *   CLAIM F — end-to-end against the REAL daemon: a brand-new folder with NO
 *             local wiring, registered to a workspace, gets correct Atlas
 *             context (naming its OWN workspace) from the installed GLOBAL
 *             hook command alone — nothing installed into the folder itself.
 *   CLAIM G — de-dup: in a repo that has BOTH the installed global hook
 *             command and its own already-installed LOCAL hook command, firing
 *             both for the same tool event reaches the daemon exactly ONCE
 *             (the global invocation stays silent — proven by counting actual
 *             requests against a stub server, not by inspecting internals).
 *   CLAIM H — control for G: the same global command, run in a folder with NO
 *             local wiring, DOES reach the daemon — the skip in G is
 *             conditional on a local hook being present, not unconditional.
 *   CLAIM I — de-dup walks up: G's same already-wired repo, but the tool
 *             call's `cwd` is a SUBDIRECTORY of the wired root (not the exact
 *             directory `atlas wire install` wrote into) — still exactly ONE
 *             request reaches the daemon, because the local-hook check walks
 *             up from cwd instead of only checking the literal cwd.
 *   CLAIM J — the walk-up must NOT overshoot into the home directory: once a
 *             global install exists, `$HOME/.claude/settings.json` itself
 *             contains HOOK_TAG (it IS the global hook file), so a project
 *             living a few folders under $HOME with no local wiring of its
 *             own must still get context from the global hook — the walk has
 *             to stop before $HOME, not treat the global file as if it were a
 *             local one and silence itself everywhere under the user's home.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobalWire, globalSettingsPath } from '../src/cli/globalWire.js';
import { installWire } from '../src/cli/wire.js';
import { loadConfig } from '../src/config.js';
import { registerProject } from '../src/projectRegistry.js';
import { invalidateWorkspaceResolverCache } from '../src/pathWorkspaceResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, 'scripts', 'atlas-hook.mjs');

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Settings {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>; PostToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> };
    [k: string]: unknown;
}

function readSettings(file: string): Settings {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Settings;
}

/** Every Atlas-owned command string across both event arrays. */
function atlasCommands(s: Settings): string[] {
    const all = [...(s.hooks?.PreToolUse ?? []), ...(s.hooks?.PostToolUse ?? [])];
    return all.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes('atlas-hook.mjs'));
}

/** Find the command for one matcher in one event array. */
function commandFor(s: Settings, event: 'PreToolUse' | 'PostToolUse', matcher: string): string {
    const entries = s.hooks?.[event] ?? [];
    const e = entries.find((x) => x.matcher === matcher);
    assert.ok(e, `expected a ${event} entry with matcher ${matcher}`);
    const cmd = e!.hooks[0]?.command;
    assert.ok(cmd, `expected a command on ${event}/${matcher}`);
    return cmd!;
}

// ── CLAIM A/B/C/D/E — installGlobalWire merge/idempotency/safety ────────────

async function unitClaims(): Promise<void> {
    // ── CLAIM A — fresh install, workspace-less commands ──────────────────
    {
        const home = tmp('atlas-gw-a-home-');
        const r = installGlobalWire({ home });
        assert.equal(r.ok, true, 'A: install must succeed');
        const file = globalSettingsPath(home);
        assert.equal(r['settingsFile'], file, 'A: reports the file it wrote');
        const s = readSettings(file);
        const preSearch = commandFor(s, 'PreToolUse', 'Grep|Glob');
        const preEdit = commandFor(s, 'PreToolUse', 'Edit|Write|MultiEdit');
        const postBash = commandFor(s, 'PostToolUse', 'Bash');
        for (const [label, cmd, event] of [['pre-search', preSearch, 'pre-search'], ['pre-edit', preEdit, 'pre-edit'], ['post-bash', postBash, 'post-bash']] as const) {
            assert.match(cmd, /atlas-hook\.mjs/, `A: ${label} command runs the hook client`);
            // The command must end with the bare event name — no workspace
            // token appended (that's exactly what makes it the global hook).
            assert.match(cmd, new RegExp(`${event}$`), `A: ${label} command carries no trailing workspace token`);
        }
        assert.equal(r['backup'], null, 'A: no backup when there was nothing to back up');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM A ok — fresh install writes workspace-less commands');
    }

    // ── CLAIM B — merge, never clobber ──────────────────────────────────────
    let bHome!: string;
    {
        bHome = tmp('atlas-gw-b-home-');
        const file = globalSettingsPath(bHome);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const before: Settings = {
            permissions: { allow: ['Bash(ls)'], deny: [] },
            enabledPlugins: { foo: true },
            skipWorkflowUsageWarning: true,
            hooks: {
                PreToolUse: [{ matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'echo not-atlas' }] }],
            },
        };
        fs.writeFileSync(file, JSON.stringify(before, null, 2));

        const r = installGlobalWire({ home: bHome });
        assert.equal(r.ok, true, 'B: install must succeed on a pre-existing file');
        assert.ok(r['backup'], 'B: a backup is taken when editing an existing file');
        assert.ok(fs.existsSync(r['backup'] as string), 'B: the backup file actually exists');
        assert.deepEqual(JSON.parse(fs.readFileSync(r['backup'] as string, 'utf-8')), before, 'B: backup is a faithful copy of the pre-install content');

        const after = readSettings(file);
        // Strict, whole-object check — not just the three named keys: every
        // top-level key EXCEPT `hooks` must be byte-for-byte (deep-equal)
        // identical to what was there before install.
        const { hooks: _beforeHooks, ...beforeRest } = before;
        const { hooks: _afterHooks, ...afterRest } = after;
        assert.deepEqual(afterRest, beforeRest, 'B: every top-level key outside `hooks` is untouched, exhaustively');
        const survivor = (after.hooks?.PreToolUse ?? []).find((e) => e.matcher === 'SomeOtherTool');
        assert.ok(survivor, 'B: the pre-existing non-Atlas hook entry survives install');
        assert.equal(survivor!.hooks[0]?.command, 'echo not-atlas', 'B: the non-Atlas hook command is unchanged');
        // Atlas's own three entries were still added alongside it.
        assert.equal(atlasCommands(after).length, 3, 'B: all three Atlas entries present alongside the survivor');
        console.log('CLAIM B ok — merge never clobbers unrelated keys or other tools\' hooks');
    }

    // ── CLAIM C — idempotent re-install ─────────────────────────────────────
    {
        const file = globalSettingsPath(bHome);
        const before = readSettings(file);
        const r2 = installGlobalWire({ home: bHome });
        assert.equal(r2.ok, true, 'C: second install succeeds');
        const after = readSettings(file);
        assert.deepEqual(after, before, 'C: re-running install is a no-op on content (no duplicate Atlas entries)');
        assert.equal(atlasCommands(after).length, 3, 'C: still exactly 3 Atlas entries, not 6');
        fs.rmSync(bHome, { recursive: true, force: true });
        console.log('CLAIM C ok — re-install is idempotent, no duplicate entries');
    }

    // ── CLAIM D — malformed existing file is refused, left untouched ───────
    {
        const home = tmp('atlas-gw-d-home-');
        const file = globalSettingsPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const garbage = '{ this is not valid json,,,';
        fs.writeFileSync(file, garbage);
        const r = installGlobalWire({ home });
        assert.equal(r.ok, false, 'D: install on malformed JSON must fail, not silently overwrite');
        assert.equal(fs.readFileSync(file, 'utf-8'), garbage, 'D: the malformed file is left byte-for-byte untouched');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM D ok — malformed global settings refused, left untouched');
    }

    // ── CLAIM E — 0600 perms ────────────────────────────────────────────────
    {
        const home = tmp('atlas-gw-e-home-');
        installGlobalWire({ home });
        const file = globalSettingsPath(home);
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600, `E: settings file must be chmod 0600, got ${mode.toString(8)}`);
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM E ok — global settings file is chmod 0600 after install');
    }
}

// ── CLAIM F — brand-new folder gets context from the global hook alone ──────

interface HookRun { stdout: string; code: number | null }

function runCommand(cmdLine: string, opts: { cwd: string; env: NodeJS.ProcessEnv; payload: Record<string, unknown> }): Promise<HookRun> {
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

async function realDaemonClaim(): Promise<void> {
    process.env['ATLAS_MCP_AUTH'] = 'off'; // trusted-local — isolates from token minting/rotation
    const globalHome = tmp('atlas-gw-f-global-home-');
    const atlasHome = tmp('atlas-gw-f-atlas-home-');
    const hookTmp = tmp('atlas-gw-f-hooktmp-');
    const projA = tmp('atlas-gw-f-proja-');
    const cleanup = [globalHome, atlasHome, hookTmp, projA];

    try {
        const gr = installGlobalWire({ home: globalHome });
        assert.equal(gr.ok, true, 'F: global install must succeed');
        const gs = readSettings(globalSettingsPath(globalHome));
        const globalPostBash = commandFor(gs, 'PostToolUse', 'Bash');

        const cfg = loadConfig(atlasHome);
        assert.equal(registerProject(cfg, 'ws-brand-new', projA), true, 'F: register the brand-new folder to its own workspace');
        invalidateWorkspaceResolverCache();

        const { startAtlasMcpServer } = await import('../src/mcp/server.js');
        const srv = await startAtlasMcpServer({ port: 0, home: atlasHome });
        try {
            // Sanity: nothing was ever installed INTO the folder itself.
            assert.equal(fs.existsSync(path.join(projA, '.claude', 'settings.json')), false, 'F: the folder has no local wiring at all');

            const run = await runCommand(globalPostBash, {
                cwd: projA,
                env: baseEnv({ ATLAS_PORT: String(srv.port), ATLAS_HOME: atlasHome, TMPDIR: hookTmp, TMP: hookTmp, TEMP: hookTmp }),
                payload: { session_id: 'sess-f', cwd: projA, tool_name: 'Bash', tool_input: { command: 'git commit -m wip' } },
            });
            assert.equal(run.code, 0, 'F: exit 0');
            const ctx = contextOf(run);
            assert.match(ctx, /Commit detected/, 'F: the global-hook-alone invocation returns real Atlas context');
            assert.match(ctx, /--workspace ws-brand-new\b/, 'F: context names the folder\'s OWN workspace, resolved purely from cwd');
            console.log('CLAIM F ok — a brand-new, never-wired folder gets correct context from the global hook alone');
        } finally {
            await srv.close();
        }
    } finally {
        delete process.env['ATLAS_MCP_AUTH'];
        invalidateWorkspaceResolverCache();
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
}

// ── CLAIM G/H — de-dup against a stub daemon (counts real requests) ─────────

interface Stub { port: number; hits: number; close: () => Promise<void> }

function startStub(): Promise<Stub> {
    const stub: Partial<Stub> = { hits: 0 };
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            stub.hits = (stub.hits ?? 0) + 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ additionalContext: 'CTX' }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            stub.port = typeof addr === 'object' && addr ? addr.port : 0;
            stub.close = () => new Promise((r) => server.close(() => r()));
            resolve(stub as Stub);
        });
    });
}

async function dedupClaims(): Promise<void> {
    const globalHome = tmp('atlas-gw-gh-global-home-');
    const localRepo = tmp('atlas-gw-gh-local-repo-');
    const unwiredRepo = tmp('atlas-gw-gh-unwired-repo-');
    const atlasHome = tmp('atlas-gw-gh-atlas-home-'); // token/marker home for the hook client
    const hookTmp = tmp('atlas-gw-gh-hooktmp-');
    const cleanup = [globalHome, localRepo, unwiredRepo, atlasHome, hookTmp];

    try {
        // The globally-installed command (workspace-less).
        const gr = installGlobalWire({ home: globalHome });
        assert.equal(gr.ok, true);
        const gs = readSettings(globalSettingsPath(globalHome));
        const globalEditCmd = commandFor(gs, 'PreToolUse', 'Edit|Write|MultiEdit');

        // The already-installed LOCAL command for localRepo (explicit workspace).
        const lr = await installWire(localRepo, 'test-ws-local');
        assert.equal(lr.ok, true, 'setup: local wire install must succeed');
        const ls = readSettings(path.join(localRepo, '.claude', 'settings.json'));
        const localEditCmd = commandFor(ls, 'PreToolUse', 'Edit|Write|MultiEdit');
        assert.notEqual(localEditCmd, globalEditCmd, 'setup: local and global commands must actually differ (one carries a workspace)');

        const stub = await startStub();
        try {
            const env = baseEnv({ ATLAS_PORT: String(stub.port), ATLAS_HOME: atlasHome, TMPDIR: hookTmp, TMP: hookTmp, TEMP: hookTmp });
            const payload = { session_id: 'sess-gh', tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } };

            // ── CLAIM G — both fire in the already-locally-wired repo: exactly 1 hit
            stub.hits = 0;
            const globalRun = await runCommand(globalEditCmd, { cwd: localRepo, env, payload: { ...payload, cwd: localRepo } });
            const localRun = await runCommand(localEditCmd, { cwd: localRepo, env, payload: { ...payload, cwd: localRepo } });
            assert.equal(globalRun.code, 0, 'G: global invocation exits 0');
            assert.equal(localRun.code, 0, 'G: local invocation exits 0');
            assert.equal(contextOf(globalRun), '', 'G: the global hook stays silent (local hook already covers this repo)');
            assert.match(contextOf(localRun), /CTX/, 'G: the local hook still fires normally, unaffected');
            assert.equal(stub.hits, 1, `G: exactly ONE request must reach the daemon for this event, got ${stub.hits}`);
            console.log('CLAIM G ok — an already-locally-wired repo fires the hook exactly once');

            // ── CLAIM H — control: same global command, unwired folder → DOES fire
            stub.hits = 0;
            const controlRun = await runCommand(globalEditCmd, { cwd: unwiredRepo, env, payload: { ...payload, cwd: unwiredRepo, session_id: 'sess-gh-2' } });
            assert.equal(controlRun.code, 0, 'H: control invocation exits 0');
            assert.match(contextOf(controlRun), /CTX/, 'H: the global hook DOES fire when no local hook is present');
            assert.equal(stub.hits, 1, `H: exactly one request from the control run, got ${stub.hits}`);
            console.log('CLAIM H ok — the skip in G is conditional on a local hook, not unconditional');

            // ── CLAIM I — de-dup walks up from a nested cwd ─────────────────
            const nestedDir = path.join(localRepo, 'src', 'nested');
            fs.mkdirSync(nestedDir, { recursive: true });
            stub.hits = 0;
            const globalNestedRun = await runCommand(globalEditCmd, { cwd: nestedDir, env, payload: { ...payload, cwd: nestedDir, session_id: 'sess-gh-3' } });
            const localNestedRun = await runCommand(localEditCmd, { cwd: nestedDir, env, payload: { ...payload, cwd: nestedDir, session_id: 'sess-gh-3' } });
            assert.equal(globalNestedRun.code, 0, 'I: global invocation exits 0');
            assert.equal(localNestedRun.code, 0, 'I: local invocation exits 0');
            assert.equal(contextOf(globalNestedRun), '', 'I: the global hook stays silent from a subdirectory of the wired root too');
            assert.match(contextOf(localNestedRun), /CTX/, 'I: the local hook still fires normally, unaffected');
            assert.equal(stub.hits, 1, `I: exactly ONE request must reach the daemon when cwd is nested under the wired root, got ${stub.hits}`);
            console.log('CLAIM I ok — de-dup walks up from a nested cwd, still exactly one invocation');

            // ── CLAIM J — walk-up stops before $HOME, never treats the global
            // settings file itself as a local hook ──────────────────────────
            const fakeHome = tmp('atlas-gw-gh-fakehome-');
            const projUnderHome = path.join(fakeHome, 'code', 'some-unwired-project');
            fs.mkdirSync(projUnderHome, { recursive: true });
            try {
                const gr2 = installGlobalWire({ home: fakeHome }); // writes fakeHome/.claude/settings.json (contains HOOK_TAG)
                assert.equal(gr2.ok, true, 'J setup: global install into fakeHome must succeed');
                const gs2 = readSettings(globalSettingsPath(fakeHome));
                const globalEditCmd2 = commandFor(gs2, 'PreToolUse', 'Edit|Write|MultiEdit');

                stub.hits = 0;
                const homeRun = await runCommand(globalEditCmd2, {
                    cwd: projUnderHome,
                    env: baseEnv({ ATLAS_PORT: String(stub.port), ATLAS_HOME: atlasHome, TMPDIR: hookTmp, TMP: hookTmp, TEMP: hookTmp, HOME: fakeHome }),
                    payload: { ...payload, cwd: projUnderHome, session_id: 'sess-gh-4' },
                });
                assert.equal(homeRun.code, 0, 'J: invocation exits 0');
                assert.match(contextOf(homeRun), /CTX/, 'J: the global hook still fires for a project nested under $HOME with no local wiring');
                assert.equal(stub.hits, 1, `J: exactly one request — the global settings file itself must not be mistaken for a local hook, got ${stub.hits}`);
                console.log('CLAIM J ok — walk-up stops before $HOME, does not self-silence under the global file');
            } finally {
                fs.rmSync(fakeHome, { recursive: true, force: true });
            }
        } finally {
            await stub.close();
        }
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('Running global-wire (auto-wire Part 3) tests…');
    await unitClaims();
    await realDaemonClaim();
    await dedupClaims();
    console.log('global-wire: ALL CLAIMS PASS');
}

await main();
