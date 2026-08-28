/**
 * tests/hook-workspace-resolution.test.ts — Atlas auto-wire Part 2.
 *
 * scripts/atlas-hook.mjs now sends `cwd` in its POST body (read from Claude
 * Code's own hook payload, falling back to process.cwd()); src/mcp/server.ts's
 * POST /hooks/context handler resolves the owning workspace from `cwd` via
 * Part 1's src/pathWorkspaceResolver.ts whenever the request carries no
 * explicit `workspace`. An explicit `workspace` — what every per-repo `atlas
 * wire install` hook has always sent as the positional argv[3] — still wins,
 * so an already-wired repo's exact old invocation is unaffected.
 *
 * This drives the REAL daemon (startAtlasMcpServer) and the REAL hook client
 * (scripts/atlas-hook.mjs) end-to-end, not a stub — tests/hook-client.test.ts
 * already covers the hook client's auth/fail-open contract against a stub, so
 * this file is scoped to the one thing that changed: workspace resolution.
 * Observed through postBash's `--workspace <ws>` interpolation (mcp/hooks.ts)
 * on a `git commit` command, since that is the one buildHookContext branch
 * whose output text names the resolved workspace verbatim.
 *
 *   CLAIM A — three different registered project cwds, no workspace arg, each
 *             resolve to their own correct workspace.
 *   CLAIM B — an unregistered cwd resolves to "no workspace" (context omits
 *             `--workspace`), not a crash or a wrong guess.
 *   CLAIM C — an explicit workspace argv (an already-wired repo's exact old
 *             invocation) wins even when the payload's `cwd` resolves to a
 *             DIFFERENT registered workspace — nothing already working changes.
 *   CLAIM D — a payload with no `cwd` field at all (older Claude Code shape)
 *             still resolves correctly, via the hook client's process.cwd()
 *             fallback (the child is spawned with that directory as its OS cwd).
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { registerProject } from '../src/projectRegistry.js';
import { invalidateWorkspaceResolverCache } from '../src/pathWorkspaceResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, 'scripts', 'atlas-hook.mjs');

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface HookRun { stdout: string; code: number | null }

/** Spawn the real hook client. `workspaceArg` omitted reproduces the
 *  machine-wide (Part 3) invocation shape; passed, it reproduces an
 *  already-wired per-repo hook's exact old command line. `payload` is the
 *  JSON written to stdin (mirrors what Claude Code writes); `spawnCwd` sets
 *  the CHILD PROCESS's own OS-level cwd, independent of any `cwd` field in
 *  the payload — used by CLAIM D to exercise the process.cwd() fallback. */
function runHook(opts: {
    port: number;
    home: string;
    tmp: string;
    event?: string;
    workspaceArg?: string;
    payload: Record<string, unknown>;
    spawnCwd?: string;
}): Promise<HookRun> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['ATLAS_MCP_TOKEN'];
    delete env['ATLAS_MCP_AUTH'];
    env['ATLAS_PORT'] = String(opts.port);
    env['ATLAS_HOME'] = opts.home;
    env['TMPDIR'] = opts.tmp;
    env['TMP'] = opts.tmp;
    env['TEMP'] = opts.tmp;

    const argv = [opts.event ?? 'post-bash'];
    if (opts.workspaceArg) argv.push(opts.workspaceArg);

    return new Promise((resolve) => {
        const child = spawn(process.execPath, [HOOK, ...argv], {
            env,
            cwd: opts.spawnCwd,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
        child.on('close', (code) => resolve({ stdout, code }));
        child.stdin.end(JSON.stringify(opts.payload));
    });
}

function contextOf(run: HookRun): string {
    if (!run.stdout.trim()) return '';
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? '';
}

const COMMIT_INPUT = { command: 'git commit -m "wip"' };

async function main(): Promise<void> {
    console.log('Running hook workspace-resolution tests…');

    process.env['ATLAS_MCP_AUTH'] = 'off'; // trusted-local — isolates this test from token minting/rotation
    const home = tmp('atlas-hookws-home-');
    const hookTmp = tmp('atlas-hookws-tmp-'); // once-per-session markers for the spawned hook
    const cleanupDirs = [home, hookTmp];

    try {
        const cfg = loadConfig(home);

        const projA = tmp('atlas-hookws-proj-a-');
        const projB = tmp('atlas-hookws-proj-b-');
        const projC = tmp('atlas-hookws-proj-c-');
        const unregistered = tmp('atlas-hookws-unreg-');
        cleanupDirs.push(projA, projB, projC, unregistered);
        assert.equal(registerProject(cfg, 'ws-a', projA), true);
        assert.equal(registerProject(cfg, 'ws-b', projB), true);
        assert.equal(registerProject(cfg, 'ws-c', projC), true);
        invalidateWorkspaceResolverCache();

        const { startAtlasMcpServer } = await import('../src/mcp/server.js');
        const srv = await startAtlasMcpServer({ port: 0, home });
        try {
            // ── CLAIM A — three different cwds, no workspace arg ──────────────
            let i = 0;
            for (const [proj, ws] of [[projA, 'ws-a'], [projB, 'ws-b'], [projC, 'ws-c']] as const) {
                const run = await runHook({
                    port: srv.port,
                    home,
                    tmp: hookTmp,
                    payload: { session_id: `sess-a-${i++}`, cwd: proj, tool_name: 'Bash', tool_input: COMMIT_INPUT },
                });
                assert.equal(run.code, 0, `A: exit 0 for ${ws}`);
                const ctx = contextOf(run);
                assert.match(ctx, /Commit detected/, `A: post-bash still fires for ${ws}`);
                assert.match(ctx, new RegExp(`atlas index \\.\\s*--workspace ${ws}\\b`), `A: ${proj} resolves to workspace "${ws}" with no workspace arg`);
            }
            console.log('  ✓ CLAIM A: three different registered project cwds each resolve to their own workspace');

            // ── CLAIM B — unregistered cwd resolves to no workspace ───────────
            {
                const run = await runHook({
                    port: srv.port,
                    home,
                    tmp: hookTmp,
                    payload: { session_id: 'sess-b', cwd: unregistered, tool_name: 'Bash', tool_input: COMMIT_INPUT },
                });
                assert.equal(run.code, 0, 'B: exit 0');
                const ctx = contextOf(run);
                assert.match(ctx, /Commit detected/, 'B: post-bash still fires');
                assert.doesNotMatch(ctx, /--workspace/, 'B: an unregistered cwd names no workspace, not a wrong guess');
                console.log('  ✓ CLAIM B: unregistered cwd resolves to "no workspace" cleanly');
            }

            // ── CLAIM C — explicit workspace arg wins over a resolvable cwd ───
            {
                const run = await runHook({
                    port: srv.port,
                    home,
                    tmp: hookTmp,
                    workspaceArg: 'legacy-wired-ws', // an already-wired repo's baked-in argv
                    payload: { session_id: 'sess-c', cwd: projA, tool_name: 'Bash', tool_input: COMMIT_INPUT }, // cwd would resolve to ws-a
                });
                assert.equal(run.code, 0, 'C: exit 0');
                const ctx = contextOf(run);
                assert.match(ctx, /--workspace legacy-wired-ws\b/, 'C: the explicit argv workspace wins');
                assert.doesNotMatch(ctx, /--workspace ws-a\b/, 'C: the cwd-resolved workspace must NOT override an explicit argv');
                console.log('  ✓ CLAIM C: explicit workspace argv wins over a resolvable cwd (already-wired repos unaffected)');
            }

            // ── CLAIM D — no cwd field in the payload → process.cwd() fallback ─
            {
                const run = await runHook({
                    port: srv.port,
                    home,
                    tmp: hookTmp,
                    spawnCwd: projB, // the CHILD's OS-level cwd, not a payload field
                    payload: { session_id: 'sess-d', tool_name: 'Bash', tool_input: COMMIT_INPUT }, // no `cwd` key at all
                });
                assert.equal(run.code, 0, 'D: exit 0');
                const ctx = contextOf(run);
                assert.match(ctx, /--workspace ws-b\b/, 'D: process.cwd() fallback resolves when the payload omits cwd');
                console.log('  ✓ CLAIM D: payload with no cwd field falls back to process.cwd()');
            }
        } finally {
            await srv.close();
        }
    } finally {
        delete process.env['ATLAS_MCP_AUTH'];
        invalidateWorkspaceResolverCache();
        for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    }

    console.log('hook-workspace-resolution: ALL CLAIMS PASS');
}

await main();
