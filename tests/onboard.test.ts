/**
 * tests/onboard.test.ts — atlas_onboard: one-call onboarding.
 *
 * Covers the runner end-to-end against a real embedded store in a temp
 * ATLAS_HOME:
 *   - workspace derived from the repo folder slug; REUSED (not duplicated)
 *     on a second onboard;
 *   - stale/wrong-path .atlas/index-state.json → warning + forced FULL
 *     re-index (resume:false) instead of a broken incremental one;
 *   - background mode returns immediately with a jobId, and index_status
 *     (getProgress) is the polling surface — same jobId, terminal counts,
 *     and the skipped-files report (unsupported extension + excluded test
 *     fixture, with reasons — not buried in errorCount);
 *   - the wire step installs AGENTS.md as well as CLAUDE.md, and uninstall/
 *     status treat AGENTS.md symmetrically;
 *   - overlap with an in-flight index of the same workspace is rejected.
 *
 * Isolation: temp ATLAS_HOME (its own lore-data), temp git repo with a
 * repo-local core.hooksPath (hook writes never touch ~/.groundfloor/hooks).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { runOnboard } from '../src/mcp/tools/onboard.js';
import { getProgress, clearProgress } from '../src/mcp/indexProgress.js';
import { indexInFlight } from '../src/mcp/indexInFlight.js';
import { closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { uninstallWire, wireStatus } from '../src/cli/wire.js';

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A temp git repo (isolated hooks) with one indexable TS file, one
 *  default-excluded test file, and one unsupported-extension file. */
function freshRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-onboard-repo-'));
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function greet(): string { return "hi"; }\ngreet();\n');
    fs.writeFileSync(path.join(dir, 'src', 'index.test.ts'), 'import { greet } from "./index";\ngreet();\n');
    fs.writeFileSync(path.join(dir, 'docs', 'notes.txt'), 'plain prose — no parser\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
    return dir;
}

function saveCheckpointState(repo: string, root: string): void {
    const dir = path.join(repo, '.atlas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index-state.json'), JSON.stringify({
        version: 1,
        root,
        files: { 'src/index.ts': { mtimeMs: 1, sizeBytes: 1, indexedAt: new Date().toISOString() } },
        updatedAt: new Date().toISOString(),
    }, null, 2));
}

async function waitForDone(workspace: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const p = getProgress(workspace);
        if (!p.indexing && (p.phase === 'done' || p.phase === 'error')) return;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`index did not finish within ${timeoutMs}ms (phase=${getProgress(workspace).phase})`);
}

async function main(): Promise<void> {
    console.log('atlas_onboard — one-call onboarding');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-onboard-home-'));
    const cfg = loadConfig(home);
    const repo = freshRepo();
    const expectedWs = path.basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

    // ── 1. Full onboard, wait:true — workspace derive + index + wire ─────────
    const r1 = await runOnboard(cfg, { path: repo, wait: true }) as Record<string, never> & {
        ok: boolean; workspace: string; workspaceReused: boolean; jobId: string;
        index: { queued: boolean; resume: boolean; result: { filesWritten: number; skippedFiles?: { count: number; byReason: Record<string, number> } } };
        wire: { ok: boolean; claudeFile: string | null; agentsFile: string | null };
    };
    assert.equal(r1.ok, true, `onboard ok; got ${JSON.stringify(r1).slice(0, 400)}`);
    assert.equal(r1.workspace, expectedWs, `workspace derived from folder slug; got ${r1.workspace}`);
    assert.equal(r1.workspaceReused, false, 'first onboard creates the workspace');
    assert.equal(r1.index.resume, true, 'no checkpoint → incremental-eligible (no stale warning)');
    assert.ok(r1.jobId.startsWith(`onboard-${expectedWs}-`), `job id stamped; got ${r1.jobId}`);
    assert.ok(r1.index.result.filesWritten >= 1, 'at least the TS file written');
    // Skipped files reported WITH reasons, not buried in an error count.
    const skipped = r1.index.result.skippedFiles;
    assert.ok(skipped && skipped.count >= 2, `skipped files reported; got ${JSON.stringify(skipped)}`);
    assert.ok((skipped!.byReason['unsupported extension'] ?? 0) >= 1, 'notes.txt skipped: unsupported extension');
    assert.ok((skipped!.byReason['test/fixture (default-excluded)'] ?? 0) >= 1, 'index.test.ts skipped: test/fixture');
    // index_status is the polling surface — jobId + skipped files visible there too.
    const prog = getProgress(expectedWs);
    assert.equal(prog.jobId, r1.jobId, 'index_status carries the job id');
    assert.equal(prog.phase, 'done', 'run finished');
    assert.ok((prog.skippedFiles?.count ?? 0) >= 2, 'index_status carries the skipped-files report');
    // Wire installed BOTH standing-instruction files.
    assert.ok(r1.wire.agentsFile && fs.readFileSync(r1.wire.agentsFile, 'utf8').includes('atlas-wire-begin'), 'AGENTS.md block installed');
    assert.ok(r1.wire.claudeFile && fs.readFileSync(r1.wire.claudeFile, 'utf8').includes('atlas-wire-begin'), 'CLAUDE.md block installed');
    // The atlas-onboard SKILL ships with the other three and tells agents to
    // call the single atlas_onboard tool.
    const onboardSkill = path.join(repo, '.claude', 'skills', 'atlas-onboard', 'SKILL.md');
    assert.ok(fs.existsSync(onboardSkill), 'atlas-onboard skill installed alongside the others');
    const onboardSkillBody = fs.readFileSync(onboardSkill, 'utf8');
    assert.ok(onboardSkillBody.includes('atlas_onboard'), 'skill calls the single atlas_onboard tool');
    assert.ok(onboardSkillBody.includes('index_status'), 'skill makes index_status the polling surface');
    assert.ok(onboardSkillBody.includes('staleIndex'), 'skill covers the wrong-path-index edge case');
    assert.ok(onboardSkillBody.includes('AGENTS.md'), 'skill covers the AGENTS.md edge case');
    console.log(`  ✓ wait:true — workspace '${r1.workspace}', ${r1.index.result.filesWritten} files written, ${skipped!.count} skipped (with reasons), AGENTS.md + CLAUDE.md wired`);

    // ── 2. Second onboard REUSES the workspace (no duplicate) ────────────────
    const r2 = await runOnboard(cfg, { path: repo, wait: true }) as { ok: boolean; workspace: string; workspaceReused: boolean; index: { resume: boolean } };
    assert.equal(r2.ok, true, 'second onboard ok');
    assert.equal(r2.workspace, expectedWs, 'same derived workspace');
    assert.equal(r2.workspaceReused, true, 'existing workspace reused, not duplicated');
    assert.equal(r2.index.resume, true, 'checkpoint root matches → incremental');
    console.log('  ✓ second onboard reuses the workspace; incremental resume');

    // ── 3. Stale/wrong-path index-state.json → warn + FULL re-index ──────────
    saveCheckpointState(repo, '/nonexistent/other-checkout');
    const r3 = await runOnboard(cfg, { path: repo, wait: true }) as {
        ok: boolean; index: { resume: boolean; staleIndex?: { detected: boolean; previousRoot: string } };
    };
    assert.equal(r3.ok, true, 'stale-root onboard ok');
    assert.equal(r3.index.resume, false, 'stale checkpoint forces a FULL re-index');
    assert.equal(r3.index.staleIndex?.detected, true, 'stale index warning surfaced');
    assert.equal(r3.index.staleIndex?.previousRoot, '/nonexistent/other-checkout', 'warning names the previous root');
    console.log('  ✓ stale/wrong-path checkpoint → warning + forced full re-index');

    // ── 4. Fire-and-forget: immediate return + jobId; index_status polls ─────
    clearProgress(expectedWs);
    const t0 = Date.now();
    const r4 = await runOnboard(cfg, { path: repo }) as { ok: boolean; jobId: string; index: { queued: boolean; confirmed: boolean; poll: string } };
    const elapsed = Date.now() - t0;
    assert.equal(r4.ok, true, 'background onboard ok');
    assert.equal(r4.index.queued, true, 'index queued, not awaited');
    assert.equal(r4.index.confirmed, true, 'liftoff confirmed against index_status');
    assert.ok(elapsed < 15_000, `returned immediately (${elapsed}ms), not after the index`);
    await waitForDone(expectedWs, 120_000);
    assert.equal(getProgress(expectedWs).jobId, r4.jobId, 'polled status matches the returned job id');
    console.log(`  ✓ fire-and-forget — returned in ${elapsed}ms with jobId; index_status tracked it to done`);

    // ── 5. Overlap with an in-flight index is rejected ───────────────────────
    indexInFlight.add(expectedWs);
    try {
        const r5 = await runOnboard(cfg, { path: repo }) as { error?: string };
        assert.equal(r5.error, 'index_in_progress', `overlap rejected; got ${JSON.stringify(r5)}`);
    } finally {
        indexInFlight.delete(expectedWs);
    }
    console.log('  ✓ concurrent index of the same workspace rejected');

    // ── 6. AGENTS.md symmetric with CLAUDE.md in status + uninstall ──────────
    const status = wireStatus(repo) as { wired: boolean; agentsMd: boolean; claudeMd: boolean };
    assert.equal(status.wired, true, 'repo fully wired');
    assert.equal(status.agentsMd, true, 'status reports AGENTS.md');
    // An install from before AGENTS.md existed (CLAUDE.md only) is still 'wired'.
    fs.rmSync(path.join(repo, 'AGENTS.md'));
    const legacy = wireStatus(repo) as { wired: boolean; mode: string };
    assert.equal(legacy.wired, true, `CLAUDE.md-only install still counts as wired; got mode=${legacy.mode}`);
    const unr = uninstallWire(repo) as { ok: boolean };
    assert.equal(unr.ok, true, 'uninstall ok');
    assert.ok(!fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').includes('atlas-wire-begin'), 'CLAUDE.md block removed');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'skills', 'atlas-onboard')), 'atlas-onboard skill removed on uninstall');
    console.log('  ✓ wire status/uninstall treat AGENTS.md symmetrically (legacy CLAUDE.md-only still wired)');

    await closeAllEmbedded();
    console.log('\nAll atlas_onboard tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
