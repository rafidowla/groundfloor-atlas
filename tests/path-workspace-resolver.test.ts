/**
 * tests/path-workspace-resolver.test.ts — Atlas auto-wire Part 1.
 *
 * src/pathWorkspaceResolver.ts reverse-indexes every workspace's
 * projects.json (src/projectRegistry.ts) so a bare folder path can be
 * answered with "which workspace owns this, or none" — the piece a
 * machine-wide hook needs (Part 2/3) since the workspace can no longer be
 * baked into the hook command at install time.
 *
 *   CLAIM A — a path nested under a registered project resolves to its workspace.
 *   CLAIM B — overlapping registrations: the LONGEST matching registered path wins.
 *   CLAIM B2 — two workspaces registering the IDENTICAL path (a real case, verified
 *              live: this repo is registered under both "groundfloor-atlas" and
 *              "alex-admin") resolves via EARLIEST registration wins.
 *   CLAIM C — a path under no registered project resolves to none (null).
 *   CLAIM D — a registered path that no longer exists on disk resolves to none.
 *   CLAIM E — symlinks and '..' are resolved canonically before comparison.
 *   CLAIM F — the cache is invalidated on demand (stale answer only until invalidated).
 *   CLAIM G — warm lookups are cheap (<5ms), since this runs on every Grep/Edit.
 *   CLAIM H — this repo checkout resolves to workspace "groundfloor-atlas" on a
 *             machine where it's actually registered (soft-skips elsewhere, same
 *             idea as tests/x7.test.ts's environment-gated skip).
 *   CLAIM I — every production site that registers a project (not just the four
 *             allTools.ts workspace-management handlers) invalidates the cache:
 *             src/mcp/tools/index.ts, src/cli.ts, and src/mcp/tools/onboard.ts.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveWorkspaceForPath,
    invalidateWorkspaceResolverCache,
} from '../src/pathWorkspaceResolver.js';
import { registerProject, embeddedDataDir } from '../src/projectRegistry.js';
import type { AtlasConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function tmp(): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-resolver-')));
}

/** Minimal embedded-mode AtlasConfig pointed at an isolated tmp data dir, so
 *  each CLAIM gets its own reverse index with no cross-test bleed. */
function cfgWithDataDir(dataDir: string): AtlasConfig {
    return {
        port: 3848,
        home: dataDir,
        lore: { workspace: 'developer', mcpUrl: 'http://127.0.0.1:3847/mcp', mode: 'embedded', dataDir },
    };
}

async function main(): Promise<void> {
    console.log('Running path -> workspace resolver tests…');

    // ── CLAIM A — nested folder under a registered project ───────────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const projectDir = tmp();
        fs.mkdirSync(path.join(projectDir, 'src', 'deep', 'nested'), { recursive: true });
        assert.equal(registerProject(cfg, 'proj-a', projectDir), true, 'registration succeeds');
        invalidateWorkspaceResolverCache();

        assert.equal(resolveWorkspaceForPath(cfg, projectDir), 'proj-a', 'the registered root itself resolves');
        assert.equal(
            resolveWorkspaceForPath(cfg, path.join(projectDir, 'src', 'deep', 'nested')),
            'proj-a',
            'a folder nested under the registered project resolves to its workspace',
        );
        console.log('  ✓ CLAIM A: nested folder resolves to its registered workspace');
    }

    // ── CLAIM B — overlapping registrations: longest path wins ───────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const monorepo = tmp();
        const pkgDir = path.join(monorepo, 'packages', 'inner');
        fs.mkdirSync(pkgDir, { recursive: true });
        // Two workspaces register overlapping paths — a monorepo root and a
        // package nested inside it. The more specific (longer) match must win.
        assert.equal(registerProject(cfg, 'outer-ws', monorepo), true);
        assert.equal(registerProject(cfg, 'inner-ws', pkgDir), true);
        invalidateWorkspaceResolverCache();

        assert.equal(
            resolveWorkspaceForPath(cfg, path.join(pkgDir, 'index.ts')),
            'inner-ws',
            'a path under the nested (longer) registration resolves to the nested workspace',
        );
        assert.equal(
            resolveWorkspaceForPath(cfg, path.join(monorepo, 'README.md')),
            'outer-ws',
            'a path under the monorepo root but outside the nested package resolves to the outer workspace',
        );
        console.log('  ✓ CLAIM B: overlapping registrations resolve via longest-path-wins');
    }

    // ── CLAIM B2 — identical-path dual registration: earliest wins ───────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const sharedProject = tmp();
        fs.mkdirSync(sharedProject, { recursive: true });
        // Write both registrations directly so addedAt ordering is deterministic
        // (registerProject stamps `new Date().toISOString()`, too coarse to
        // reliably order two back-to-back calls in a fast test).
        const olderDir = embeddedDataDir(cfg, 'first-registered-ws');
        fs.mkdirSync(olderDir, { recursive: true });
        fs.writeFileSync(path.join(olderDir, 'projects.json'), JSON.stringify([{ path: sharedProject, addedAt: '2026-08-09T18:07:57.969Z' }]));
        const newerDir = embeddedDataDir(cfg, 'later-registered-ws');
        fs.mkdirSync(newerDir, { recursive: true });
        fs.writeFileSync(path.join(newerDir, 'projects.json'), JSON.stringify([{ path: sharedProject, addedAt: '2026-08-14T11:54:35.939Z' }]));
        invalidateWorkspaceResolverCache();

        assert.equal(
            resolveWorkspaceForPath(cfg, sharedProject),
            'first-registered-ws',
            'when two workspaces register the identical path, the earliest registration wins',
        );
        console.log('  ✓ CLAIM B2: identical-path dual registration resolves via earliest-wins');
    }

    // ── CLAIM C — unregistered path resolves to none ──────────────────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const registered = tmp();
        fs.mkdirSync(registered, { recursive: true });
        assert.equal(registerProject(cfg, 'proj-c', registered), true);
        invalidateWorkspaceResolverCache();

        const elsewhere = tmp();
        assert.equal(resolveWorkspaceForPath(cfg, elsewhere), null, 'a path under no registered project resolves to null');
        assert.equal(resolveWorkspaceForPath(cfg, '/definitely/not/registered/anywhere'), null, 'an arbitrary unregistered path resolves to null');
        console.log('  ✓ CLAIM C: unregistered path resolves to none (null)');
    }

    // ── CLAIM D — registered path no longer on disk resolves to none ─────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const goneDir = path.join(tmp(), 'was-here');
        fs.mkdirSync(goneDir, { recursive: true });
        assert.equal(registerProject(cfg, 'proj-d', goneDir), true);
        fs.rmSync(goneDir, { recursive: true, force: true }); // registered, but deleted from disk afterward
        invalidateWorkspaceResolverCache();

        assert.equal(resolveWorkspaceForPath(cfg, goneDir), null, 'a registered path that no longer exists on disk resolves to none');
        console.log('  ✓ CLAIM D: a registered-but-deleted path resolves to none, not a crash');
    }

    // ── CLAIM E — symlinks and '..' resolved canonically ──────────────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const realProject = tmp();
        fs.mkdirSync(path.join(realProject, 'src'), { recursive: true });
        assert.equal(registerProject(cfg, 'proj-e', realProject), true);
        invalidateWorkspaceResolverCache();

        // A symlink pointing AT the registered project, queried by its symlink path.
        const container = tmp();
        const linkPath = path.join(container, 'link-to-project');
        fs.symlinkSync(realProject, linkPath);
        assert.equal(resolveWorkspaceForPath(cfg, linkPath), 'proj-e', 'a symlink resolving to a registered project resolves canonically');

        // A '..'-laden path that textually looks unrelated but canonically lands inside.
        const dotDotPath = path.join(realProject, 'src', '..', 'src');
        assert.equal(resolveWorkspaceForPath(cfg, dotDotPath), 'proj-e', "a path containing '..' is resolved canonically before matching");
        console.log("  ✓ CLAIM E: symlinks and '..' resolved canonically before comparison");
    }

    // ── CLAIM F — cache invalidation ──────────────────────────────────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const projectDir = tmp();
        fs.mkdirSync(projectDir, { recursive: true });
        invalidateWorkspaceResolverCache();
        assert.equal(resolveWorkspaceForPath(cfg, projectDir), null, 'not yet registered → none (and this also warms/builds the cache)');

        assert.equal(registerProject(cfg, 'proj-f', projectDir), true);
        // Without invalidation the stale cache would still answer null.
        assert.equal(resolveWorkspaceForPath(cfg, projectDir), null, 'stale cache still answers from before the registration until invalidated');
        invalidateWorkspaceResolverCache();
        assert.equal(resolveWorkspaceForPath(cfg, projectDir), 'proj-f', 'after invalidation, the new registration is picked up');
        console.log('  ✓ CLAIM F: cache invalidation makes a new registration visible');
    }

    // ── CLAIM G — warm lookup cost stays negligible ───────────────────────────
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        // A handful of registered projects, mirroring a real machine (not just one).
        for (let i = 0; i < 25; i++) {
            const d = tmp();
            assert.equal(registerProject(cfg, `proj-warm-${i}`, d), true);
        }
        invalidateWorkspaceResolverCache();
        const target = tmp();
        resolveWorkspaceForPath(cfg, target); // cold — builds the cache, excluded from timing

        const iterations = 200;
        const t0 = performance.now();
        for (let i = 0; i < iterations; i++) resolveWorkspaceForPath(cfg, target);
        const elapsedMs = performance.now() - t0;
        const perCallMs = elapsedMs / iterations;
        assert.ok(perCallMs < 5, `warm lookup must stay under 5ms (got ${perCallMs.toFixed(3)}ms avg over ${iterations} calls)`);
        console.log(`  ✓ CLAIM G: warm lookup cost ${perCallMs.toFixed(3)}ms avg (< 5ms budget)`);
    }

    // ── CLAIM H — this repo resolves to "groundfloor-atlas" (live-machine check) ─
    {
        const liveDataDir = path.join(os.homedir(), '.groundfloor', 'atlas', 'lore-data');
        const liveRegistryFile = path.join(liveDataDir, 'groundfloor-atlas', 'projects.json');
        if (!fs.existsSync(liveRegistryFile)) {
            console.log('  - CLAIM H: skipped (no live groundfloor-atlas registry on this machine)');
        } else {
            const registered: { path: string }[] = JSON.parse(fs.readFileSync(liveRegistryFile, 'utf8'));
            const isThisRepoRegistered = registered.some((p) => fs.realpathSync.native(path.resolve(p.path)) === fs.realpathSync.native(REPO_ROOT));
            if (!isThisRepoRegistered) {
                console.log('  - CLAIM H: skipped (this checkout is not the machine\'s registered groundfloor-atlas project)');
            } else {
                const liveCfg = cfgWithDataDir(liveDataDir);
                invalidateWorkspaceResolverCache();
                assert.equal(resolveWorkspaceForPath(liveCfg, REPO_ROOT), 'groundfloor-atlas', 'this repo checkout resolves to workspace "groundfloor-atlas"');
                assert.equal(
                    resolveWorkspaceForPath(liveCfg, path.join(REPO_ROOT, 'src', 'mcp')),
                    'groundfloor-atlas',
                    'a folder nested inside this repo also resolves to "groundfloor-atlas"',
                );
                console.log('  ✓ CLAIM H: this repo checkout resolves to workspace "groundfloor-atlas"');
            }
        }
    }

    // ── CLAIM I — every production site that registers a project invalidates
    // the cache, not just the four allTools.ts workspace-management handlers.
    // Regression test for a prior iteration: src/mcp/tools/index.ts's
    // runIndexTool (the `atlas_index` MCP tool / daemon path taken by `atlas
    // index`, the git-hook nudge, and any IDE-triggered index), src/cli.ts's
    // `atlas index` CLI command, and src/mcp/tools/onboard.ts's runOnboard all
    // call registerProject() (or, for onboard.ts before this fix, wrote
    // projects.json inline bypassing registerProject entirely) without ever
    // calling invalidateWorkspaceResolverCache() — so a hook firing right
    // after a fresh `atlas index <dir>` or `atlas_onboard` kept answering
    // "none" from a stale cache until some unrelated workspace-management call
    // happened to invalidate it. Proven two ways: (1) the exact functional
    // sequence those sites now run — registerProject() gated
    // invalidateWorkspaceResolverCache() — resolves correctly with a warm
    // cache in the way; (2) a source check that each of the three files still
    // contains the invalidation call, so a future edit that reintroduces the
    // bare `registerProject(...)` call (or a hand-rolled projects.json write,
    // as onboard.ts had) without the paired invalidation fails loudly here
    // instead of silently regressing.
    {
        const dataDir = tmp();
        const cfg = cfgWithDataDir(dataDir);
        const projectDir = tmp();
        fs.mkdirSync(projectDir, { recursive: true });
        // Warm the cache BEFORE the project exists, exactly like a hook firing
        // on an agent's first Grep in a brand-new directory.
        invalidateWorkspaceResolverCache();
        assert.equal(resolveWorkspaceForPath(cfg, projectDir), null, 'unregistered path warms the cache with a null answer');

        // The pattern now used verbatim at src/mcp/tools/index.ts (runIndexTool),
        // src/cli.ts (`atlas index`), and src/mcp/tools/onboard.ts (runOnboard,
        // via the shared registerProject() helper it now calls instead of
        // writing projects.json by hand).
        if (registerProject(cfg, 'proj-i', projectDir)) invalidateWorkspaceResolverCache();

        assert.equal(
            resolveWorkspaceForPath(cfg, projectDir),
            'proj-i',
            'the guard+invalidate pattern used by index.ts/cli.ts/onboard.ts must make a fresh registration visible immediately, not just after some unrelated workspace-management call',
        );
        console.log('  ✓ CLAIM I: registerProject() + invalidate pattern (index.ts / cli.ts / onboard.ts) resolves immediately');

        const srcRoot = path.join(REPO_ROOT, 'src');
        const sites: { file: string; mustContain: string[] }[] = [
            {
                file: path.join(srcRoot, 'mcp', 'tools', 'index.ts'),
                // Was `registerProject(loadConfig(), workspace, abs)` — a bare loadConfig()
                // ignored the caller's actual ATLAS_HOME (ATL-runIndexTool-cfg-leak), silently
                // registering the project into the machine's DEFAULT home instead of whichever
                // home the running daemon/test was actually scoped to. Fixed by threading the
                // real `cfg: AtlasConfig` through runIndexTool's own signature, same as
                // cli.ts/onboard.ts already did.
                mustContain: ["registerProject(cfg, workspace, abs)", 'invalidateWorkspaceResolverCache()'],
            },
            {
                file: path.join(srcRoot, 'cli.ts'),
                mustContain: ["registerProject(cfg, workspace, abs)", 'invalidateWorkspaceResolverCache()'],
            },
            {
                file: path.join(srcRoot, 'mcp', 'tools', 'onboard.ts'),
                mustContain: ["registerProject(cfg, workspace, abs)", 'invalidateWorkspaceResolverCache()'],
            },
        ];
        for (const site of sites) {
            const content = fs.readFileSync(site.file, 'utf8');
            for (const needle of site.mustContain) {
                assert.ok(
                    content.includes(needle),
                    `${path.relative(REPO_ROOT, site.file)} must contain ${JSON.stringify(needle)} — a project-registration site must invalidate the path resolver's cache`,
                );
            }
        }
        console.log('  ✓ CLAIM I: index.ts, cli.ts, and onboard.ts each wire registerProject() to invalidateWorkspaceResolverCache()');
    }

    invalidateWorkspaceResolverCache(); // leave no cached state behind for later test files
    console.log('All path -> workspace resolver tests passed.');
}

await main();
