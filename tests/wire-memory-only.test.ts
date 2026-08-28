/**
 * tests/wire-memory-only.test.ts — W4-T2: `atlas wire install` UX for the
 * open-source first-run against the cold-start matrix.
 *
 * Covers {fresh git repo, non-git dir, no-workspace, reinstall, uninstall} ×
 * the install modes: full wire, `--memory-only`, and `--merge-driver-only`.
 * Asserts each behaves with the correct artifacts and messages:
 *   - --memory-only installs the git memory sync (export/import hooks + union
 *     merge driver) and SKIPS the IDE harness (no .claude/, no CLAUDE.md block);
 *   - --memory-only in a non-git dir FAILS actionably (never a silent skip);
 *   - --merge-driver-only installs ONLY the union driver (no export hook);
 *   - full wire writes the IDE harness AND the git sync;
 *   - the workspace is derived from the repo name (never empty) when unset;
 *   - reinstall is idempotent; uninstall removes the git sync.
 *
 * Isolation: every temp repo sets a repo-local `core.hooksPath` to a dir INSIDE
 * itself, so hook writes never touch this machine's shared ~/.groundfloor/hooks.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installWire, uninstallWire } from '../src/cli/wire.js';
import { installMergeDriverOnly, gitHookSyncStatus, mergeDriverStatus } from '../src/cli/gitHooks.js';

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A temp git repo whose hooks dir is isolated to itself (repo-local
 *  core.hooksPath), so nothing lands in the shared machine-wide hooks dir. */
function freshRepo(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-wire-${name}-`));
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks);
    return dir;
}

function preCommit(repo: string): string {
    const p = path.join(repo, '.isolated-hooks', 'pre-commit');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

async function main(): Promise<void> {
    console.log('wire-memory-only (W4-T2) — first-run UX matrix');

    // ── 1. --memory-only in a fresh git repo ─────────────────────────────────
    {
        const repo = freshRepo('memonly');
        const r = await installWire(repo, undefined, { memoryOnly: true });
        assert.equal(r.ok, true, `memory-only install ok; got ${JSON.stringify(r)}`);
        assert.equal(r.mode, 'memory-only', 'mode is memory-only');
        assert.equal(r.settingsFile, null, 'no settings.json written in memory-only mode');
        assert.equal(r.claudeFile, null, 'no CLAUDE.md written in memory-only mode');
        assert.deepEqual(r.skills, [], 'no skills written in memory-only mode');
        assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no .claude/ dir created');
        // Git memory sync IS installed: export hook carries --union + git add -f.
        const body = preCommit(repo);
        assert.ok(body.includes('memory export .atlas/memory.jsonl'), 'pre-commit exports memory.jsonl');
        assert.ok(body.includes('--union'), 'pre-commit export carries the --union merge-safety flag');
        assert.ok(body.includes('git add -f .atlas/memory.jsonl'), 'pre-commit force-stages the ledger');
        assert.equal(mergeDriverStatus(repo), true, 'union merge driver registered');
        // Workspace derived from the repo dir name (never empty), since unset.
        assert.ok(typeof r.workspace === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(r.workspace as string), `workspace derived to a valid slug; got ${JSON.stringify(r.workspace)}`);
        console.log(`    ✓ --memory-only: git sync installed, IDE harness skipped, workspace='${r.workspace}'`);

        // Reinstall is idempotent (no throw, still ok, hooks still present).
        const r2 = await installWire(repo, undefined, { memoryOnly: true });
        assert.equal(r2.ok, true, 'reinstall ok (idempotent)');
        const status = gitHookSyncStatus(repo);
        assert.equal(status['pre-commit'], 'installed', 'pre-commit still installed after reinstall');
        console.log('    ✓ reinstall idempotent');

        // Uninstall removes the git sync.
        uninstallWire(repo);
        assert.equal(preCommit(repo).includes('memory export'), false, 'export hook removed on uninstall');
        assert.equal(mergeDriverStatus(repo), false, 'merge driver removed on uninstall');
        console.log('    ✓ uninstall removes git sync');
        fs.rmSync(repo, { recursive: true, force: true });
    }

    // ── 2. --memory-only in a NON-git dir → actionable failure ───────────────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wire-nongit-'));
        const r = await installWire(dir, undefined, { memoryOnly: true });
        assert.equal(r.ok, false, 'memory-only in a non-git dir fails');
        assert.ok(String(r.error).includes('not a git repo'), `error names the cause; got ${JSON.stringify(r.error)}`);
        assert.ok(String(r.error).includes('git init'), `error is actionable (suggests git init); got ${JSON.stringify(r.error)}`);
        assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'no harness written on the failed memory-only install');
        console.log('    ✓ --memory-only non-git: actionable failure, nothing written');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 3. --merge-driver-only installs ONLY the driver ──────────────────────
    {
        const repo = freshRepo('drvonly');
        const r = installMergeDriverOnly(repo);
        assert.equal(r.ok, true, `merge-driver-only ok; got ${JSON.stringify(r)}`);
        assert.equal(mergeDriverStatus(repo), true, 'union merge driver registered');
        assert.equal(preCommit(repo), '', 'NO export/import hooks installed (driver-only)');
        assert.ok(fs.existsSync(path.join(repo, '.gitattributes')), '.gitattributes stanza written');
        console.log('    ✓ --merge-driver-only: driver + .gitattributes only, no hooks');
        fs.rmSync(repo, { recursive: true, force: true });
    }

    // ── 4. Full wire writes the IDE harness AND the git sync ─────────────────
    {
        const repo = freshRepo('full');
        const r = await installWire(repo);
        assert.equal(r.ok, true, `full install ok; got ${JSON.stringify(r)}`);
        assert.equal(r.mode, 'full', 'mode is full');
        assert.ok(typeof r.settingsFile === 'string' && fs.existsSync(r.settingsFile as string), 'settings.json written in full mode');
        assert.ok(fs.existsSync(path.join(repo, 'CLAUDE.md')), 'CLAUDE.md written in full mode');
        assert.ok(preCommit(repo).includes('--union'), 'full mode also installs the union export hook');
        console.log('    ✓ full wire: IDE harness + git sync both installed');
        fs.rmSync(repo, { recursive: true, force: true });
    }

    console.log('wire-memory-only: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
