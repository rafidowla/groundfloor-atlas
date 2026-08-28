/**
 * projectTier.ts — "what counts as a real project" (Atlas auto-wire Part 4).
 *
 * WHY THIS EXISTS. Part 3 makes the Atlas hook fire in EVERY folder on the
 * machine, not just already-wired repos. That means the hook now sees paths
 * it has never met before, and Part 5 needs to decide, for each one: is this
 * a project worth auto-onboarding (background index + one announcement), or
 * should Atlas stay quiet? Get this wrong in one direction and Atlas silently
 * ingests client code, a colleague's unrelated repo, or a scratch clone
 * (over-broad — the risk the plan calls out as "the one that matters"); get
 * it wrong the other way and the zero-touch promise fails for real projects.
 * This module is the single rule set that decision is built on — written
 * down as THREE EXPLICIT TIERS below, then implemented as one pure function.
 *
 * ONE FUNCTION, TWO CALLERS. `classifyProjectPath` is deliberately pure
 * fs + the Part 1 resolver — no embedded-Lore I/O (same constraint as
 * src/mcp/hooks.ts and src/pathWorkspaceResolver.ts; see their header
 * comments for why a live DB query on this path previously crashed the
 * daemon). That keeps it cheap enough to call from the hook path (Part 5,
 * wiring it into src/mcp/hooks.ts / server.ts's /hooks/context handler) AND
 * from any future CLI command, off the SAME rules — the tiers are decided
 * once, here, not re-derived per caller.
 *
 * ── THE THREE TIERS ─────────────────────────────────────────────────────────
 *
 * TIER 1 — KNOWN PROJECT. `resolveWorkspaceForPath` (Part 1) already answers
 * a workspace for this path: it (or an ancestor) is registered in some
 * workspace's projects.json. Full memory + code context, exactly today's
 * behaviour — nothing about auto-wire changes this path. Checked FIRST and
 * wins unconditionally: an already-registered project must keep working
 * unchanged (invariant 6) even in the rare case its path also happens to sit
 * under a name this module would otherwise treat as a container to skip
 * (e.g. a real project directory someone named `vendor-tools`).
 *
 * TIER 2 — REAL BUT UNINDEXED. Not (yet) known to any workspace, but looks
 * like an actual source tree: it has its own `.git` directory, OR it has one
 * of a small set of recognisable source-tree manifest files directly in it
 * (see SOURCE_MARKER_FILES below — decided and documented here per the plan,
 * since a folder can be a perfectly real project without ever having been
 * `git init`'d, e.g. a fresh `npm init`/`cargo new` before the first commit).
 * Eligible for Part 5's background auto-onboard.
 *
 * TIER 3 — NOT A PROJECT. Everything else, and specifically:
 *   - doesn't exist, or isn't a directory;
 *   - outside the operator's ATLAS_INDEX_ROOTS allowlist, when one is set
 *     (src/indexRoots.ts's scanPathError — unset = permissive, matching
 *     every other Atlas scan path);
 *   - inside the Atlas data dir itself (`cfg.home`, default
 *     `~/.groundfloor/atlas`) — Atlas must never onboard itself as a project;
 *   - inside a dependency/VCS-internal/tool-cache container at ANY level of
 *     the path — `node_modules`, `vendor`, `bower_components`, `Pods`,
 *     `site-packages`, `__pycache__`, `coverage`, `.git` (as a path segment,
 *     not just "has a .git subdir"), the `venv` family, and the dot-prefixed
 *     tool-cache names in src/cli/walker.ts's DEFAULT_SKIP_DIRS (`.next`,
 *     `.turbo`, `.terraform`, …) — matched unconditionally, ANY occurrence
 *     excludes. Three names — `env`, `build`, `dist` — are ALSO in that
 *     walker list but are NOT unconditional here (AMBIGUOUS_ANCESTOR_NAMES
 *     in the code): they are bare English words a human also uses for an
 *     ordinary, unrelated ancestor folder, so a bare name match alone is
 *     not enough signal. They instead exclude only when
 *     `ambiguousSegmentBelongsToHostProject` finds a REAL project (its own
 *     `.git` or source marker) somewhere ABOVE that segment — i.e. the
 *     ambiguous name is that project's own build-output/tool-cache dir
 *     (CMake's `build/_deps/<vendored-lib>`, a checked-in `dist/`, a
 *     `venv`'s activation dir named plain `env`), not a folder a human
 *     picked for something else. This whole check runs on the WHOLE path,
 *     not just the leaf, specifically so a `.git` repo nested inside some
 *     other project's `node_modules` (a real, observed shape — a vendored
 *     dependency that happens to carry its own git history) does NOT read
 *     as tier 2 just because it has a `.git` directory — while a real,
 *     top-level, directly-`.git`'d project that merely happens to live
 *     under a bare, context-free ancestor folder named `env`/`build`/`dist`
 *     (no host project of its own above it) still classifies tier 2, per
 *     the near-miss test (CLAIM K). See AMBIGUOUS_ANCESTOR_NAMES's own
 *     comment for the full reasoning and the checker history behind it;
 *   - a bare directory with neither a `.git` nor any recognised source
 *     marker — a plain scratch/tmp dir (e.g. `mkdtemp()`) reads as this by
 *     construction: it has nothing in it, so it falls through every tier-2
 *     check.
 * This is the ONLY case where Atlas silence is correct (invariant 2 —
 * announce, never sneak — only applies once something IS being onboarded).
 *
 * "Under a plausible root" (the plan's phrase for tier 2) is not a separate
 * check here — it falls out of tier 3 already excluding every implausible
 * root (container dirs, the Atlas data dir, outside the allowlist). Nothing
 * left over needs a fourth rule.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasConfig } from './config.js';
import { resolveWorkspaceForPath } from './pathWorkspaceResolver.js';
import { scanPathError, realResolve } from './indexRoots.js';
import { isSkippableDirName } from './cli/walker.js';

export type ProjectTier = 1 | 2 | 3;

/** Stable, machine-readable reason codes — asserted on directly in tests and
 *  safe to log; not intended as end-user prose. */
export type ProjectTierReason =
    | 'known-project'
    | 'not-a-directory'
    | 'outside-index-roots'
    | 'atlas-data-dir'
    | 'inside-excluded-container'
    | 'has-git'
    | 'has-source-marker'
    | 'no-project-markers';

export interface ProjectTierResult {
    tier: ProjectTier;
    reason: ProjectTierReason;
    /** Set only for tier 1 — the workspace that already owns this path. */
    workspace?: string;
    /** Set only when reason === 'has-source-marker' — which file matched. */
    marker?: string;
}

/**
 * Recognisable source-tree manifest files (tier 2's git-free path). Presence
 * of ANY one of these directly inside the candidate directory is treated as
 * "this is a real source tree" even with no `.git` — deliberately the small,
 * unambiguous set named in the plan (one manifest per major ecosystem this
 * codebase's own parser layer already understands: JS/TS, Python, Rust, Go),
 * not an exhaustive list of every possible project file. Extend deliberately
 * if a real near-miss shows up, not speculatively.
 */
export const SOURCE_MARKER_FILES: readonly string[] = [
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
];

/**
 * Bare, generic English words that appear in src/cli/walker.ts's
 * DEFAULT_SKIP_DIRS but are ALSO names a human plausibly picks for an
 * ordinary, UNRELATED ancestor folder that has nothing to do with dependency
 * vendoring or build tooling: a CI checkout root `~/build/...`, an
 * "environments" folder `~/env/...`, a release staging dir `~/dist/...`. The
 * walker tolerates a false match on these because it only ever prunes a name
 * like this while ALREADY crawling inside one project it knows is real —
 * cheap to miss a few files. This module's whole-PATH container check runs
 * with no such context, so a bare name-match alone is not enough signal for
 * these three; they get the extra ANCESTOR-PROJECT check below
 * (`ambiguousSegmentBelongsToHostProject`) instead of an unconditional match.
 * `coverage` was in this set through 2026-08-22 but is deliberately NOT here
 * any more: unlike `build`/`dist`/`env`, it is not a word people reach for
 * to name an arbitrary unrelated folder — it is near-exclusively test/code
 * -coverage tool output (nyc/istanbul, `jest --coverage`, `pytest-cov`, …),
 * so it stays in the always-excluded set below, same as `node_modules`.
 * *(Checker iteration 2, 2026-08-22, finding 1: the direct-parent-of-a-git-
 * repo shape this set exists to protect — `<ancestor>/build/<real-project>`
 * with `<ancestor>` itself an ordinary folder — is, by construction,
 * PATH-INDISTINGUISHABLE from a genuine build-tool container holding a bare
 * git checkout with no host-project context of its own. That exact shape is
 * ALSO the required near-miss in CLAIM K (tests/project-tier.test.ts),
 * added in response to an earlier checker iteration and still required: a
 * real, top-level, directly-`.git`'d project living under an unrelated
 * ancestor named `env`/`build`/`dist` must classify tier 2, not tier 3.
 * Tightening `env`/`build`/`dist` to match finding 1's bare-ancestor case
 * would silently break CLAIM K — an already-required test — which invariant
 * 5's "never weaken a test to make it pass" and the plan's own precedent
 * rule out. `coverage` has no such competing test and no comparable
 * legitimate ambiguity, so it moves to the unconditional list; `env`/
 * `build`/`dist` instead gain `ambiguousSegmentBelongsToHostProject`, which
 * DOES close finding 2's CMake `build/_deps/<vendored-lib>` case — the
 * ambiguous name is excluded when a REAL project is found somewhere above
 * it (the actual "this is that project's own build output" signal) — while
 * leaving a bare, context-free ancestor (CLAIM K, and finding 1's own
 * `env`/`build`/`dist` sub-cases) classified tier 2 by design. Operators who
 * want stricter behaviour than this residual ambiguity allows have
 * `ATLAS_INDEX_ROOTS` (checked earlier and unconditionally, per the plan's
 * Risks section).*
 */
const AMBIGUOUS_ANCESTOR_NAMES: ReadonlySet<string> = new Set(['env', 'build', 'dist']);

/**
 * True if `ambiguousSegmentAbs` (the absolute path through one of
 * AMBIGUOUS_ANCESTOR_NAMES's segments, e.g. `.../myproject/build`) sits
 * beneath a REAL project of its own — i.e. some directory strictly ABOVE it
 * (from its immediate parent up to the filesystem root) has its own `.git`
 * or source marker. When true, the ambiguous name is that project's own
 * build-output / tool-cache directory (CMake's `build/_deps`, a Python
 * `env`, a bundler's `dist`) — a genuine container, not a folder name a
 * human picked for something unrelated. Bounded by path depth (a handful of
 * fs checks at most); pure fs, no embedded-Lore I/O, same constraint as the
 * rest of this module.
 */
function ambiguousSegmentBelongsToHostProject(ambiguousSegmentAbs: string): boolean {
    let dir = path.dirname(ambiguousSegmentAbs);
    for (;;) {
        try {
            if (fs.existsSync(path.join(dir, '.git')) || hasSourceMarker(dir)) return true;
        } catch {
            /* an unreadable ancestor is not a host project — keep walking up */
        }
        const parent = path.dirname(dir);
        if (parent === dir) return false; // reached the filesystem root
        dir = parent;
    }
}

/**
 * Directory NAMES that make everything beneath them a container, not a
 * project, EVEN WHEN that subtree has its own `.git` or manifest file — a
 * vendored dependency with its own git history is still not the caller's own
 * project. Built from src/cli/walker.ts's isSkippableDirName (the same list
 * the indexer already refuses to recurse into) plus `vendor`, which the
 * walker's list omits (it isn't a build/cache artifact the walker needs to
 * skip mid-crawl the way `dist`/`node_modules` are — a `vendor/` folder can
 * itself contain real, walkable source — but it IS exactly the "not the
 * caller's own project" container this tier check exists for, e.g. Go/PHP
 * vendored deps) — MINUS AMBIGUOUS_ANCESTOR_NAMES above. What's left is
 * unambiguous package-manager/VCS-internal/tool-generated names that nobody
 * plausibly chooses for an arbitrary, unrelated folder: `node_modules`,
 * `vendor`, `bower_components`, `Pods`, `site-packages`, `__pycache__`,
 * `.git` as a MID-path segment (something nested inside another repo's
 * `.git` internals), the `venv` family (bare `venv`/`.venv`/`*venv*` via
 * isSkippableDirName's own `.includes('venv')` rule — "venv" alone, unlike
 * "env", is not a word people give unrelated folders), and every
 * dot-prefixed tool-cache name (`.next`, `.nuxt`, `.cache`, `.turbo`,
 * `.parcel-cache`, `.gradle`, `.terraform`, `.serverless`, `.tox`,
 * `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.eggs`, `.svn`, `.hg`) — a
 * dot-prefixed name is tool-generated by convention, not a name a human
 * deliberately gives an ordinary ancestor directory.
 */
function isInsideExcludedContainer(abs: string): boolean {
    const segments = abs.split(path.sep);
    let prefix = '';
    for (const seg of segments) {
        if (seg === '') continue; // POSIX leading empty segment from the root slash
        prefix = prefix === '' ? path.sep + seg : path.join(prefix, seg);

        if (AMBIGUOUS_ANCESTOR_NAMES.has(seg)) {
            if (ambiguousSegmentBelongsToHostProject(prefix)) return true;
            continue; // bare ancestor with no host project above it — not excluded
        }
        if (isSkippableDirName(seg) || seg === 'vendor') return true;
    }
    return false;
}

function hasSourceMarker(abs: string): string | null {
    for (const marker of SOURCE_MARKER_FILES) {
        try {
            if (fs.existsSync(path.join(abs, marker))) return marker;
        } catch {
            /* an unreadable candidate file is not a marker — keep checking */
        }
    }
    return null;
}

/**
 * Classify a folder into one of the three tiers above. Pure fs + the Part 1
 * resolver — no embedded-Lore I/O, safe to call on every hook invocation.
 * Never throws: an unreadable/unresolvable path degrades to tier 3, not an
 * exception (a classification helper must never be the thing that breaks the
 * hook's fail-open contract).
 */
export function classifyProjectPath(cfg: AtlasConfig, targetPath: string): ProjectTierResult {
    try {
        if (!targetPath) return { tier: 3, reason: 'not-a-directory' };
        const abs = realResolve(targetPath);

        // TIER 1 first and unconditional — an already-registered project
        // keeps working exactly as before, regardless of anything below.
        const workspace = resolveWorkspaceForPath(cfg, abs);
        if (workspace) return { tier: 1, reason: 'known-project', workspace };

        let stat: fs.Stats;
        try {
            stat = fs.statSync(abs);
        } catch {
            return { tier: 3, reason: 'not-a-directory' };
        }
        if (!stat.isDirectory()) return { tier: 3, reason: 'not-a-directory' };

        if (scanPathError(abs)) return { tier: 3, reason: 'outside-index-roots' };

        const atlasHome = realResolve(cfg.home);
        if (abs === atlasHome || abs.startsWith(atlasHome + path.sep)) {
            return { tier: 3, reason: 'atlas-data-dir' };
        }

        if (isInsideExcludedContainer(abs)) return { tier: 3, reason: 'inside-excluded-container' };

        if (fs.existsSync(path.join(abs, '.git'))) return { tier: 2, reason: 'has-git' };

        const marker = hasSourceMarker(abs);
        if (marker) return { tier: 2, reason: 'has-source-marker', marker };

        return { tier: 3, reason: 'no-project-markers' };
    } catch {
        return { tier: 3, reason: 'not-a-directory' };
    }
}
