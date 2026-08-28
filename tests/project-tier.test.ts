/**
 * tests/project-tier.test.ts — Atlas auto-wire Part 4.
 *
 * src/projectTier.ts classifies any folder into one of three tiers so Part 5
 * knows what's safe to auto-onboard. This is the FULL-PANEL part of the plan
 * ("this rule decides what source code gets ingested"), so every claim below
 * maps to one sentence of the written tier rules in src/projectTier.ts's
 * header (and in docs/plans/ATLAS-AUTOWIRE-PLAN.md's Part 4 section).
 *
 *   CLAIM A  — TIER 1: a path registered to a workspace (Part 1) classifies
 *              known-project, regardless of what else is true about it.
 *   CLAIM B  — TIER 2: a directory with its own `.git` classifies has-git.
 *   CLAIM C  — TIER 2: a git-free directory with a recognised source marker
 *              (package.json / pyproject.toml / Cargo.toml / go.mod) still
 *              classifies has-source-marker — the documented git-free path.
 *   CLAIM D  — TIER 3 near-miss: a `.git` repo NESTED INSIDE a node_modules
 *              folder does NOT read as tier 2 — the container check wins.
 *   CLAIM E  — TIER 3 near-miss: a plain temp dir (mkdtemp, nothing in it)
 *              classifies tier 3, no-project-markers — the "stay quiet" case.
 *   CLAIM F  — TIER 3: the Atlas data dir itself (cfg.home) classifies
 *              atlas-data-dir, including a folder nested inside it.
 *   CLAIM G  — TIER 3: a path outside ATLAS_INDEX_ROOTS (when the operator
 *              has set one) classifies outside-index-roots even though it
 *              would otherwise look like a real project (has its own .git).
 *   CLAIM H  — TIER 3: a non-existent path, and a path to a plain FILE
 *              (not a directory), both classify not-a-directory.
 *   CLAIM I  — TIER 3: `vendor/` is an excluded container even though the
 *              walker's own DEFAULT_SKIP_DIRS list omits it (documented gap
 *              this module deliberately closes for classification purposes).
 *   CLAIM J  — TIER 1 wins over TIER 3's container exclusion: a REGISTERED
 *              project whose path happens to contain a container-like
 *              segment name is still tier 1 (invariant 6 — a known project's
 *              behaviour never regresses because of Part 4's new rules).
 *   CLAIM K  — TIER 2 near-miss: a real, top-level, directly-`.git`'d
 *              project living under an UNRELATED ancestor folder named
 *              `env`, `build`, or `dist` (not the project's own dependency
 *              tree — just a folder name collision several levels up) still
 *              classifies has-git. The container-exclusion check (CLAIM D/I)
 *              only applies to unambiguous package-manager/VCS-internal
 *              names (`node_modules`, `vendor`, …); bare English words that
 *              double as ordinary folder names must not blanket-exclude
 *              every path underneath them.
 *   CLAIM L  — TIER 3 near-miss (checker iteration 2, finding 2): a `.git`
 *              repo vendored INSIDE another project's own `build/` output
 *              (the CMake `build/_deps/<lib>-src` shape) does NOT read as
 *              tier 2 — `ambiguousSegmentBelongsToHostProject` finds the
 *              real project (its own `.git`) above `build/` and excludes
 *              the whole subtree, unlike CLAIM K's bare, context-free
 *              ancestor case.
 *   CLAIM M  — TIER 3: `coverage` is NOT in AMBIGUOUS_ANCESTOR_NAMES (unlike
 *              `env`/`build`/`dist`) — it excludes unconditionally, the same
 *              as `node_modules`/`vendor`, even with no host project above
 *              it, because (unlike those three) it is not a name people
 *              plausibly pick for an unrelated ancestor folder.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyProjectPath, SOURCE_MARKER_FILES } from '../src/projectTier.js';
import { registerProject } from '../src/projectRegistry.js';
import { invalidateWorkspaceResolverCache } from '../src/pathWorkspaceResolver.js';
import type { AtlasConfig } from '../src/config.js';

function tmp(prefix = 'atlas-tier-'): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function cfgWithHome(home: string): AtlasConfig {
    const dataDir = path.join(home, 'lore-data');
    return {
        port: 3848,
        home,
        lore: { workspace: 'developer', mcpUrl: 'http://127.0.0.1:3847/mcp', mode: 'embedded', dataDir },
    };
}

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

async function main(): Promise<void> {
    console.log('Running project-tier classification tests…');

    // ── CLAIM A — TIER 1: known project wins outright ─────────────────────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const projectDir = tmp();
        assert.equal(registerProject(cfg, 'known-proj', projectDir), true);
        invalidateWorkspaceResolverCache();

        const result = classifyProjectPath(cfg, projectDir);
        assert.equal(result.tier, 1, 'a registered project classifies tier 1');
        assert.equal(result.reason, 'known-project');
        assert.equal(result.workspace, 'known-proj');
        console.log('  ✓ CLAIM A: registered project -> TIER 1 known-project');
    }

    // ── CLAIM B — TIER 2: has its own .git ─────────────────────────────────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const repo = tmp();
        git(repo, 'init', '-q');

        const result = classifyProjectPath(cfg, repo);
        assert.equal(result.tier, 2, 'a directory with its own .git classifies tier 2');
        assert.equal(result.reason, 'has-git');
        console.log('  ✓ CLAIM B: bare git repo -> TIER 2 has-git');
    }

    // ── CLAIM C — TIER 2: git-free source marker ───────────────────────────────
    for (const marker of SOURCE_MARKER_FILES) {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const projectDir = tmp();
        fs.writeFileSync(path.join(projectDir, marker), marker === 'package.json' ? '{}' : '');

        const result = classifyProjectPath(cfg, projectDir);
        assert.equal(result.tier, 2, `a git-free directory with ${marker} classifies tier 2`);
        assert.equal(result.reason, 'has-source-marker');
        assert.equal(result.marker, marker);
    }
    console.log(`  ✓ CLAIM C: git-free source folder (${SOURCE_MARKER_FILES.join(', ')}) -> TIER 2 has-source-marker`);

    // ── CLAIM D — near-miss: .git nested inside node_modules is NOT tier 2 ────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const hostProject = tmp();
        const vendoredDep = path.join(hostProject, 'node_modules', 'some-dep');
        fs.mkdirSync(vendoredDep, { recursive: true });
        git(vendoredDep, 'init', '-q'); // the vendored dep carries its own git history

        const result = classifyProjectPath(cfg, vendoredDep);
        assert.notEqual(result.tier, 2, 'a .git repo nested inside node_modules must NOT read as tier 2');
        assert.equal(result.tier, 3, 'it classifies tier 3 instead');
        assert.equal(result.reason, 'inside-excluded-container');
        console.log('  ✓ CLAIM D: near-miss — .git inside node_modules -> TIER 3 inside-excluded-container (not TIER 2)');
    }

    // ── CLAIM E — near-miss: plain temp dir (nothing in it) -> TIER 3 ─────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const scratch = tmp('atlas-tier-scratch-'); // mkdtemp, no .git, no marker files

        const result = classifyProjectPath(cfg, scratch);
        assert.equal(result.tier, 3, 'a plain mkdtemp scratch dir classifies tier 3');
        assert.equal(result.reason, 'no-project-markers');
        console.log('  ✓ CLAIM E: near-miss — plain temp dir -> TIER 3 no-project-markers');
    }

    // ── CLAIM F — TIER 3: the Atlas data dir itself ────────────────────────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        fs.mkdirSync(home, { recursive: true });

        const atHome = classifyProjectPath(cfg, home);
        assert.equal(atHome.tier, 3);
        assert.equal(atHome.reason, 'atlas-data-dir');

        const nested = path.join(home, 'lore-data', 'some-workspace');
        fs.mkdirSync(nested, { recursive: true });
        const nestedResult = classifyProjectPath(cfg, nested);
        assert.equal(nestedResult.tier, 3);
        assert.equal(nestedResult.reason, 'atlas-data-dir');
        console.log('  ✓ CLAIM F: Atlas data dir (and nested paths under it) -> TIER 3 atlas-data-dir');
    }

    // ── CLAIM G — TIER 3: outside an operator-set ATLAS_INDEX_ROOTS ───────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const allowedRoot = tmp();
        const outsideRepo = tmp(); // a REAL git repo, but outside the allowlist
        git(outsideRepo, 'init', '-q');

        const prev = process.env['ATLAS_INDEX_ROOTS'];
        process.env['ATLAS_INDEX_ROOTS'] = allowedRoot;
        try {
            const result = classifyProjectPath(cfg, outsideRepo);
            assert.equal(result.tier, 3, 'a real repo outside the allowlist is still tier 3 when ATLAS_INDEX_ROOTS is set');
            assert.equal(result.reason, 'outside-index-roots');

            // Sanity: the SAME repo, WITHOUT the allowlist restricting it, is tier 2.
            delete process.env['ATLAS_INDEX_ROOTS'];
            const unrestricted = classifyProjectPath(cfg, outsideRepo);
            assert.equal(unrestricted.tier, 2, 'the same repo classifies tier 2 once the allowlist restriction is lifted');
        } finally {
            if (prev === undefined) delete process.env['ATLAS_INDEX_ROOTS'];
            else process.env['ATLAS_INDEX_ROOTS'] = prev;
        }
        console.log('  ✓ CLAIM G: ATLAS_INDEX_ROOTS honoured — outside allowlist -> TIER 3 outside-index-roots');
    }

    // ── CLAIM H — TIER 3: nonexistent path and a plain file ───────────────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);

        const missing = classifyProjectPath(cfg, path.join(tmp(), 'does-not-exist'));
        assert.equal(missing.tier, 3);
        assert.equal(missing.reason, 'not-a-directory');

        const fileDir = tmp();
        const filePath = path.join(fileDir, 'just-a-file.txt');
        fs.writeFileSync(filePath, 'hello');
        const file = classifyProjectPath(cfg, filePath);
        assert.equal(file.tier, 3);
        assert.equal(file.reason, 'not-a-directory');
        console.log('  ✓ CLAIM H: nonexistent path and a plain file both -> TIER 3 not-a-directory');
    }

    // ── CLAIM I — vendor/ excluded even though walker's skip-list omits it ────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const hostProject = tmp();
        const vendored = path.join(hostProject, 'vendor', 'github.com', 'some', 'pkg');
        fs.mkdirSync(vendored, { recursive: true });
        fs.writeFileSync(path.join(vendored, 'go.mod'), 'module pkg\n'); // even with a marker file

        const result = classifyProjectPath(cfg, vendored);
        assert.equal(result.tier, 3, 'a vendor/ subtree is excluded even with its own go.mod marker');
        assert.equal(result.reason, 'inside-excluded-container');
        console.log('  ✓ CLAIM I: vendor/ subtree -> TIER 3 inside-excluded-container');
    }

    // ── CLAIM J — TIER 1 wins over the container exclusion ────────────────────
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        // A registered project whose OWN path happens to contain a name this
        // module would otherwise treat as a container ("build-tools" is not an
        // exact skip-dir match, but exercise the exact-match case too: a repo
        // literally named "vendor").
        const container = tmp();
        const registeredPath = path.join(container, 'vendor');
        fs.mkdirSync(registeredPath, { recursive: true });
        git(registeredPath, 'init', '-q');
        assert.equal(registerProject(cfg, 'registered-inside-vendor-named-dir', registeredPath), true);
        invalidateWorkspaceResolverCache();

        const result = classifyProjectPath(cfg, registeredPath);
        assert.equal(result.tier, 1, 'a REGISTERED project stays tier 1 even if its path contains a container-like segment');
        assert.equal(result.reason, 'known-project');
        console.log('  ✓ CLAIM J: known-project registration overrides the container exclusion (invariant 6)');
    }

    // ── CLAIM K — near-miss: unrelated ancestor named env/build/dist ──────────
    for (const ancestorName of ['env', 'build', 'dist']) {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const ancestor = tmp();
        const realProject = path.join(ancestor, ancestorName, 'my-real-project');
        fs.mkdirSync(realProject, { recursive: true });
        git(realProject, 'init', '-q'); // a genuine, top-level repo of its own

        const result = classifyProjectPath(cfg, realProject);
        assert.equal(
            result.tier,
            2,
            `a real .git repo under an unrelated ancestor named "${ancestorName}" must still classify tier 2`,
        );
        assert.equal(result.reason, 'has-git');
    }
    console.log('  ✓ CLAIM K: near-miss — real .git repo under unrelated env/build/dist ancestor -> TIER 2 has-git (not TIER 3)');

    // ── CLAIM L — near-miss: a dep vendored inside a HOST project's own
    //    build/ output (CMake FetchContent's build/_deps/<lib>-src shape)
    //    must NOT read as tier 2, unlike CLAIM K's context-free ancestor ──
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const root = tmp();
        const hostProject = path.join(root, 'myproject');
        fs.mkdirSync(hostProject, { recursive: true });
        git(hostProject, 'init', '-q'); // myproject is a REAL project of its own

        const vendoredDep = path.join(hostProject, 'build', '_deps', 'googletest-src');
        fs.mkdirSync(vendoredDep, { recursive: true });
        git(vendoredDep, 'init', '-q'); // a dependency fetched into the host's own build output

        const result = classifyProjectPath(cfg, vendoredDep);
        assert.notEqual(result.tier, 2, 'a dep vendored inside a host project\'s own build/ output must NOT read as tier 2');
        assert.equal(result.tier, 3, 'it classifies tier 3 instead');
        assert.equal(result.reason, 'inside-excluded-container');
        console.log('  ✓ CLAIM L: near-miss — dep vendored in host project\'s build/_deps -> TIER 3 inside-excluded-container (not TIER 2)');
    }

    // ── CLAIM M — TIER 3: coverage excludes unconditionally, unlike env/build/dist ──
    {
        const home = tmp();
        const cfg = cfgWithHome(home);
        const ancestor = tmp();
        const realProject = path.join(ancestor, 'coverage', 'my-real-project');
        fs.mkdirSync(realProject, { recursive: true });
        git(realProject, 'init', '-q'); // a genuine, top-level repo — but under a "coverage"-named ancestor

        const result = classifyProjectPath(cfg, realProject);
        assert.equal(result.tier, 3, 'a .git repo under a "coverage"-named ancestor classifies tier 3, even with no host project above it');
        assert.equal(result.reason, 'inside-excluded-container');
        console.log('  ✓ CLAIM M: "coverage" ancestor excludes unconditionally (not in AMBIGUOUS_ANCESTOR_NAMES, unlike env/build/dist)');
    }

    invalidateWorkspaceResolverCache(); // leave no cached state behind for later test files
    console.log('All project-tier classification tests passed.');
}

await main();
