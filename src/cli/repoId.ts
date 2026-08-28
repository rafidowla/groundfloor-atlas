/**
 * cli/repoId.ts — Git-aware, filesystem-safe repo slugs.
 *
 * The <repo> namespace baked into code-node ids (codeNodes.ts qualify():
 * `${repo}/${raw}`) used to be a BARE directory basename (path.basename).
 * The G-2/GROUPS critique flagged this as a collision hazard: two repos
 * cloned to same-basename dirs (e.g. both checked out as `src`, or two
 * forks both named `atlas`) would COLLIDE in a shared group store — one
 * repo's `code-file:atlas/src/index.ts` silently upserts the other's.
 *
 * `repoSlug(dirAbs)` fixes this by deriving a STABLE identity from the git
 * ORIGIN REMOTE instead of the local directory name:
 *
 *   git@github.com:groundfloor/atlas.git   → "github.com-groundfloor-atlas"
 *   https://github.com/groundfloor/lore.git → "github.com-groundfloor-lore"
 *
 * The remote is the same on every machine regardless of where the repo is
 * cloned, so two checkouts of the SAME repo always slug identically, and two
 * DIFFERENT repos (different remotes) never collide even if their local dir
 * names match.
 *
 * Degrade-don't-fail: a dir that is NOT a git repo, has NO origin remote, or
 * sits on a machine where git is unavailable falls back to path.basename —
 * exactly the legacy behavior — so non-git scratch dirs keep working as today.
 *
 * MIGRATION NOTE (no auto-migration): adopting git-aware ids changes the
 * <repo> prefix for an ALREADY-indexed git workspace (basename → slug).
 * Existing basename-prefixed code nodes are NOT rewritten in place — that
 * would require a risky id-rename pass over the graph. They simply remain
 * orphaned until a `atlas index --force <root>` re-index regenerates every
 * node under the new slug. (Knowledge nodes in .atlas/memory.jsonl are
 * unaffected — they are author-id'd, not repo-prefixed.) This trade-off is
 * intentional: a clean forced re-index is cheap and unambiguous, whereas an
 * in-place id migration risks half-migrated graphs.
 */

import * as path from 'node:path';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Bound the git probe so a hung/networked git config read can't stall the CLI. */
const GIT_TIMEOUT_MS = 5000;

/**
 * Derive a stable, filesystem-safe repo slug for `dirAbs`.
 *
 * Pure + synchronous. Never throws — any failure (not a git repo, no origin,
 * git missing, spawn error) falls back to `path.basename(dirAbs)` so non-git
 * dirs behave exactly as they did before git-aware ids landed.
 *
 * @param dirAbs absolute path to a directory (a repo root, or any dir inside
 *               one — git resolves the enclosing work-tree's origin).
 */
export function repoSlug(dirAbs: string): string {
    const remote = resolveOriginRemote(dirAbs);
    if (remote) {
        const slug = slugifyRemote(remote);
        if (slug) return slug;
    }
    return path.basename(dirAbs);
}

/**
 * Resolve the git work-tree TOP-LEVEL for the directory containing `absFile`
 * (or for `absFile` itself if it is a directory). This is the canonical repo
 * root that BOTH the recursive index and the single-file index must root at, so
 * a file's repo-relative `ParsedFile.path` (e.g. `src/foo.ts`) — and therefore
 * its node id `code-file:<slug>/src/foo.ts` — is identical whether the file is
 * indexed alone or as part of its directory. Rooting single-file indexing at the
 * file's PARENT dir instead would yield `foo.ts`, a divergent orphan node.
 *
 * Pure + synchronous. Never throws: a non-git path, missing git, or spawn error
 * degrades to `path.dirname(absFile)` (a dir input degrades to itself) — the
 * legacy single-file behavior. Shared by cli.ts and mcp/tools/index.ts so the
 * two single-file paths cannot drift.
 */
export function resolveRepoRoot(absFile: string): string {
    const startDir = isDirSafe(absFile) ? absFile : path.dirname(absFile);
    try {
        const res = spawnSync(
            'git',
            ['-C', startDir, 'rev-parse', '--show-toplevel'],
            { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS },
        );
        if (res.status === 0) {
            const top = (res.stdout ?? '').trim();
            if (top.length > 0) return path.resolve(top);
        }
    } catch {
        /* fall through to dirname */
    }
    return startDir;
}

/** True if `p` is an existing directory; false on any stat error. */
function isDirSafe(p: string): boolean {
    try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Best-effort git origin remote URL for `dir`. Returns undefined when the dir
 * isn't inside a git work-tree, has no origin remote, or git isn't on PATH.
 * Bounded by GIT_TIMEOUT_MS; any spawn error is swallowed (→ undefined).
 */
function resolveOriginRemote(dir: string): string | undefined {
    try {
        const res = spawnSync(
            'git',
            ['-C', dir, 'config', '--get', 'remote.origin.url'],
            { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS },
        );
        if (res.status !== 0) return undefined;
        const url = (res.stdout ?? '').trim();
        return url.length > 0 ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Normalize a git remote URL to a deterministic, filesystem-safe slug.
 *
 * Steps (applied in order):
 *   1. Strip the protocol scheme (`https://`, `http://`, `ssh://`, `git://`).
 *   2. Strip any `user@` prefix (e.g. `git@`).
 *   3. Collapse the scp-style `host:path` colon into `host/path`.
 *   4. Strip a trailing `.git` suffix.
 *   5. Replace every run of non-[A-Za-z0-9._-] characters with a single `-`.
 *   6. Trim leading/trailing `-` and lowercase.
 *
 *   git@github.com:groundfloor/atlas.git    → github.com-groundfloor-atlas
 *   https://github.com/groundfloor/lore.git → github.com-groundfloor-lore
 *   ssh://git@host.example:22/team/repo.git → host.example-22-team-repo
 *
 * Returns undefined when the input normalizes to empty (so the caller falls
 * back to the basename).
 */
export function slugifyRemote(remoteUrl: string): string | undefined {
    let s = remoteUrl.trim();
    if (!s) return undefined;

    // 1. Strip protocol scheme (anything up to and including "://").
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    // 2. Strip a leading "user@" (handles git@, plus any other user prefix).
    s = s.replace(/^[^@/]+@/, '');
    // 3. scp-style "host:path" → "host/path". Only the FIRST colon is the
    //    host/path separator; an embedded port (ssh://host:22/…) is already
    //    past the scheme strip and its colon is also folded by the slug pass.
    s = s.replace(':', '/');
    // 4. Strip a trailing ".git".
    s = s.replace(/\.git$/i, '');
    // 5. Replace runs of unsafe chars with a single dash; this also collapses
    //    the path separators ("/") into dashes deterministically.
    s = s.replace(/[^A-Za-z0-9._-]+/g, '-');
    // 6. Collapse any accidental dash runs, trim edges, lowercase.
    s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

    return s.length > 0 ? s : undefined;
}
