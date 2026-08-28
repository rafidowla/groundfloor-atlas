/**
 * tests/wire-all-projects.test.ts — bulk wire install across registered projects.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AtlasConfig } from '../src/config.js';
import { listRegisteredProjects, installWireAllProjects } from '../src/cli/wireAllProjects.js';

const CLAUDE_BEGIN = '<!-- atlas-wire-begin -->';

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function freshRepo(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-wire-all-${name}-`));
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks);
    return dir;
}

async function main(): Promise<void> {
    console.log('wire-all-projects tests');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wire-all-home-'));
    const repoA = freshRepo('a');
    const repoB = freshRepo('b');
    const missing = path.join(os.tmpdir(), 'atlas-wire-all-missing-' + Date.now());

    const loreData = path.join(home, 'lore-data');
    fs.mkdirSync(path.join(loreData, 'ws-a'), { recursive: true });
    fs.mkdirSync(path.join(loreData, 'ws-b'), { recursive: true });
    fs.writeFileSync(
        path.join(loreData, 'ws-a', 'projects.json'),
        JSON.stringify([{ path: repoA, addedAt: '2026-01-01T00:00:00Z' }]),
    );
    fs.writeFileSync(
        path.join(loreData, 'ws-b', 'projects.json'),
        JSON.stringify([
            { path: repoB, addedAt: '2026-01-02T00:00:00Z' },
            { path: missing, addedAt: '2026-01-03T00:00:00Z' },
        ]),
    );

    const cfg: AtlasConfig = {
        port: 3848,
        home,
        lore: { workspace: 'developer', mcpUrl: 'http://127.0.0.1:3847/mcp', mode: 'embedded', dataDir: loreData },
    };

    const listed = listRegisteredProjects(cfg);
    assert.equal(listed.length, 3, 'collects projects from all workspaces');
    assert.ok(listed.some((p) => p.path === repoA && p.workspace === 'ws-a'));
    assert.ok(listed.some((p) => p.path === repoB && p.workspace === 'ws-b'));

    const r = await installWireAllProjects(cfg);
    assert.equal(r.total, 3);
    assert.equal(r.wired, 2);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 1);
    assert.ok(fs.readFileSync(path.join(repoA, 'CLAUDE.md'), 'utf8').includes(CLAUDE_BEGIN));
    assert.ok(fs.readFileSync(path.join(repoB, 'CLAUDE.md'), 'utf8').includes(CLAUDE_BEGIN));
    assert.ok(fs.readFileSync(path.join(repoA, 'CLAUDE.md'), 'utf8').includes('Groundfloor Atlas'));

    // Empty registry
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wire-all-empty-'));
    const emptyCfg: AtlasConfig = {
        port: 3848,
        home: emptyHome,
        lore: { workspace: 'developer', mcpUrl: 'http://127.0.0.1:3847/mcp', mode: 'embedded' },
    };
    const empty = await installWireAllProjects(emptyCfg);
    assert.equal(empty.total, 0);
    assert.equal(empty.wired, 0);

    console.log('  ✓ list + bulk wire registered projects');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
