/**
 * tests/background-onboard.test.ts — Atlas auto-wire Part 5: background
 * onboarding with a visible, once-only announcement.
 *
 * Drives the REAL daemon (startAtlasMcpServer) and posts directly to
 * POST /hooks/context (the same endpoint scripts/atlas-hook.mjs calls),
 * not a stub — tests/hook-workspace-resolution.test.ts already covers Part
 * 2's workspace resolution end-to-end via the real hook client, so this
 * file goes straight at the server to keep timing measurements free of
 * child-process spawn overhead.
 *
 *   CLAIM A — first hook touch of a never-seen, real (tier-2, has-git)
 *             project returns well under a second AND its
 *             additionalContext carries exactly one onboarding-
 *             announcement line naming the derived workspace; the
 *             background run it kicked off actually completes (index
 *             reaches phase 'done').
 *   CLAIM B — a second hook touch of the SAME project (now registered as a
 *             known/tier-1 workspace) does NOT repeat the announcement.
 *   CLAIM C — two back-to-back calls to maybeStartBackgroundOnboard for the
 *             SAME never-seen path: only the first announces / kicks off
 *             onboarding. The announced-Set claim happens synchronously
 *             before either call's onboarding run does any I/O, so this
 *             holds regardless of how "simultaneous" two real hook calls
 *             from the daemon's HTTP layer are.
 *   CLAIM D — a tier-3 path (bare scratch dir, no git/manifest) never
 *             triggers onboarding or an announcement — Part 4's "stay
 *             quiet" case is unaffected by Part 5.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { getProgress } from '../src/mcp/indexProgress.js';
import { closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import {
    maybeStartBackgroundOnboard,
    deriveOnboardWorkspace,
    _resetBackgroundOnboardAnnouncedForTests,
} from '../src/mcp/backgroundOnboard.js';

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A minimal, isolated-hooks git repo — enough to classify TIER 2
 *  (has-git) and index almost instantly (one tiny file). */
function freshRepo(): string {
    const dir = tmp('atlas-bgonboard-repo-');
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks); // never touch ~/.groundfloor/hooks
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export function greet(): string { return "hi"; }\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
    return dir;
}

interface HookResponse { status: number; additionalContext: string; elapsedMs: number }

/** Raw POST to /hooks/context — the exact shape scripts/atlas-hook.mjs
 *  sends, minus its own stdout/hookSpecificOutput wrapping, so the
 *  elapsed-time measurement is the server's own latency, not spawn cost. */
function postHookContext(port: number, body: Record<string, unknown>): Promise<HookResponse> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/hooks/context',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const elapsedMs = Date.now() - t0;
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { additionalContext?: string };
                    resolve({ status: res.statusCode ?? 0, additionalContext: parsed.additionalContext ?? '', elapsedMs });
                } catch (err) { reject(err as Error); }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
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

async function main(): Promise<void> {
    console.log('Running background-onboard tests…');
    process.env['ATLAS_MCP_AUTH'] = 'off'; // trusted-local — isolates from token minting/rotation
    const home = tmp('atlas-bgonboard-home-');
    const cleanupDirs = [home];

    try {
        const cfg = loadConfig(home);
        const { startAtlasMcpServer } = await import('../src/mcp/server.js');
        const srv = await startAtlasMcpServer({ port: 0, home });
        try {
            // ── CLAIM A — first touch: fast + one announcement + real onboarding ──
            const repo = freshRepo();
            cleanupDirs.push(repo);
            const expectedWs = deriveOnboardWorkspace(repo);

            const r1 = await postHookContext(srv.port, {
                session_id: 'sess-a', cwd: repo, event: 'pre-search', toolName: 'Grep', toolInput: { pattern: 'greet' },
            });
            assert.equal(r1.status, 200, 'A: 200 response');
            assert.ok(r1.elapsedMs < 900, `A: hook response returned well under a second (${r1.elapsedMs}ms)`);
            assert.match(r1.additionalContext, /new project detected/i, 'A: onboarding announcement line present');
            assert.match(r1.additionalContext, new RegExp('`' + expectedWs + '`'), `A: announcement names the derived workspace '${expectedWs}'`);
            const occurrences = (r1.additionalContext.match(/new project detected/gi) ?? []).length;
            assert.equal(occurrences, 1, 'A: exactly one onboarding announcement line, not repeated');
            console.log(`  ✓ CLAIM A: first touch announced onboarding of '${expectedWs}' in ${r1.elapsedMs}ms`);

            await waitForDone(expectedWs, 60_000);
            assert.equal(getProgress(expectedWs).phase, 'done', 'A: background index actually completed behind the fast response');
            console.log('  ✓ CLAIM A (cont.): background index completed behind the fast hook response');

            // ── CLAIM B — second touch of the SAME project: no repeat ──────────────
            const r2 = await postHookContext(srv.port, {
                session_id: 'sess-b', cwd: repo, event: 'pre-search', toolName: 'Grep', toolInput: { pattern: 'greet' },
            });
            assert.equal(r2.status, 200, 'B: 200 response');
            assert.doesNotMatch(r2.additionalContext, /new project detected/i, 'B: no repeat announcement on the second touch');
            console.log('  ✓ CLAIM B: second touch of the same project does not re-announce');

            // ── CLAIM C — synchronous dedup: two back-to-back calls, one path ──────
            _resetBackgroundOnboardAnnouncedForTests();
            const repoC = freshRepo();
            cleanupDirs.push(repoC);
            const out1 = maybeStartBackgroundOnboard(cfg, repoC);
            const out2 = maybeStartBackgroundOnboard(cfg, repoC);
            assert.equal(out1.announced, true, 'C: first call announces and kicks off onboarding');
            assert.equal(out2.announced, false, 'C: an immediate second call for the same path does not');
            assert.equal(out1.workspace, out2.workspace, 'C: both calls derive the same workspace');
            await waitForDone(out1.workspace, 60_000); // let the fire-and-forget run settle before teardown
            console.log('  ✓ CLAIM C: two back-to-back onboard attempts for the same path only the first fires');

            // ── CLAIM D — tier-3 scratch dir never onboards or announces ───────────
            // post-bash with a non-commit command so buildHookContext's OWN
            // (onboarding-unrelated) hints also stay silent, isolating the
            // assertion to Part 5's behaviour: additionalContext must be
            // fully empty, not just missing the onboarding phrase.
            const scratch = tmp('atlas-bgonboard-scratch-');
            cleanupDirs.push(scratch);
            const r4 = await postHookContext(srv.port, {
                session_id: 'sess-d', cwd: scratch, event: 'post-bash', toolName: 'Bash', toolInput: { command: 'ls' },
            });
            assert.equal(r4.status, 200, 'D: 200 response');
            assert.equal(r4.additionalContext, '', 'D: a bare scratch dir (tier 3) stays quiet — no onboarding, no announcement');
            console.log('  ✓ CLAIM D: a tier-3 scratch dir never triggers onboarding');
        } finally {
            await srv.close();
        }
    } finally {
        delete process.env['ATLAS_MCP_AUTH'];
        _resetBackgroundOnboardAnnouncedForTests();
        await closeAllEmbedded();
        for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    }

    console.log('background-onboard: ALL CLAIMS PASS');
}

await main();
