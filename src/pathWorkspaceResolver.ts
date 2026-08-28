/**
 * pathWorkspaceResolver.ts — path → workspace resolver (Atlas auto-wire Part 1).
 *
 * WHY THIS EXISTS. `atlas wire install` bakes a workspace name into each
 * repo's hook command at install time (`hookCmd(atlasRoot, event, workspace)`
 * in src/cli/wire.ts), which is why hooks are per-repo: nothing in Atlas could
 * answer "which workspace owns THIS folder" from a bare cwd. This module is
 * that answer — a machine-wide hook (Part 2/3) can send `cwd` and get back the
 * owning workspace, or a clean "none", with no new storage: every workspace
 * already records its registered project paths in
 * `<dataDir>/<workspace>/projects.json` (src/projectRegistry.ts).
 *
 * HOW: reverse-index every workspace's projects.json into a flat list of
 * {realPath, workspace}, then resolve a query path by realpath-canonical
 * prefix match, preferring the LONGEST matching registered path when two
 * registrations overlap (e.g. both a monorepo root and a package inside it
 * are registered — the nested, more specific one wins).
 *
 * WHY REALPATH, REUSED FROM indexRoots.ts. A hook fires on every Grep/Edit
 * with whatever cwd the tool call carries — that can be a symlink or contain
 * `..`. Textual prefix comparison on such a path either false-negatives (a
 * symlinked path that IS inside a registered project textually looks
 * outside it) or false-positives (a `..`-laden path that reads as inside a
 * root but resolves outside it). `indexRoots.ts` already solved this
 * (deepest-existing-ancestor realpath, so a not-yet-existing tail is still
 * resolved correctly) for the exact same shape of problem — reused verbatim
 * rather than re-derived.
 *
 * PURE FS, ZERO EMBEDDED-LORE I/O. This module only reads projects.json files
 * with plain `fs` calls — never touches kuzu/lancedb/EmbeddedLore. A hook
 * fires on EVERY Grep/Edit/Bash (see src/mcp/hooks.ts's header for why a live
 * query there previously crashed the daemon); this resolver must stay cheap
 * enough to run inline on that path, which a cached, plain-fs reverse index
 * comfortably is.
 *
 * CACHE INVALIDATION. The reverse index is built once and cached until
 * invalidated. Call `invalidateWorkspaceResolverCache()` from any mutation
 * that changes what's registered where. That is every one of:
 *   - workspace_create, workspace_delete, workspace_add_project,
 *     workspace_remove_project (src/mcp/allTools.ts);
 *   - runIndexTool, the daemon-routed path taken by the `atlas_index` MCP
 *     tool, `atlas index` (CLI), the git-hook nudge, and any IDE-triggered
 *     index (src/mcp/tools/index.ts);
 *   - the direct (non-daemon) `atlas index` CLI path (src/cli.ts);
 *   - runOnboard, the `atlas_onboard` MCP tool's embedded-mode registration
 *     step, which calls the shared `registerProject()` helper for exactly
 *     this reason instead of writing projects.json by hand
 *     (src/mcp/tools/onboard.ts).
 * All four call registerProject() from src/projectRegistry.ts and gate the
 * invalidation on its return value (true = a new entry was actually written),
 * so a re-registration of an already-known project is a no-op, not a wasted
 * rebuild. A missed invalidation only causes a stale answer until the next
 * one of those calls happens to occur elsewhere, or the process restarts —
 * never a crash or a wrong-but-confident silent failure, since the resolver
 * has no idea it's stale and simply returns what it has.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasConfig } from './config.js';
import { embeddedBaseDir, readProjectRegistry } from './projectRegistry.js';
import { realResolve } from './indexRoots.js';

interface ResolverEntry {
    /** realpath-canonicalized registered project path. */
    realPath: string;
    workspace: string;
    /** ISO timestamp the registration was written (projectRegistry.ts's
     *  addedAt) — the tie-break for two workspaces registering the exact
     *  same path (see resolveWorkspaceForPath). */
    addedAt: string;
}

interface ResolverCache {
    /** Keyed on embeddedBaseDir(cfg) so distinct configs (e.g. per-test tmp
     *  homes) never share a stale cache. */
    baseDir: string;
    entries: ResolverEntry[];
}

let cache: ResolverCache | null = null;

/**
 * Drop the cached reverse index so the next lookup rebuilds it from disk.
 * Call this after any write to a workspace's projects.json (see the header
 * comment for the exact call sites) — cheap and correct beats clever: a
 * rebuild is a few small JSON reads, not worth a finer-grained invalidation.
 */
export function invalidateWorkspaceResolverCache(): void {
    cache = null;
}

/**
 * Build the flat reverse index: every (workspace, registered path) pair
 * across every workspace dir under embeddedBaseDir(cfg), realpath-resolved.
 * A registered path that no longer exists on disk is skipped — a stale
 * registration must resolve to "none", not to a workspace that can no longer
 * back it up with anything real.
 */
function buildIndex(cfg: AtlasConfig): ResolverEntry[] {
    const base = embeddedBaseDir(cfg);
    const entries: ResolverEntry[] = [];
    let workspaceNames: string[];
    try {
        workspaceNames = fs.existsSync(base)
            ? fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
            : [];
    } catch {
        return entries; // a damaged data dir must not crash resolution — fall back to "none" everywhere
    }
    for (const workspace of workspaceNames) {
        for (const proj of readProjectRegistry(cfg, workspace)) {
            if (!fs.existsSync(proj.path)) continue; // registered path no longer on disk → not a match target
            entries.push({ realPath: realResolve(proj.path), workspace, addedAt: proj.addedAt });
        }
    }
    return entries;
}

function getIndex(cfg: AtlasConfig): ResolverEntry[] {
    const baseDir = embeddedBaseDir(cfg);
    if (cache && cache.baseDir === baseDir) return cache.entries;
    const entries = buildIndex(cfg);
    cache = { baseDir, entries };
    return entries;
}

/**
 * Resolve `targetPath` to the workspace that owns it, or null when no
 * registered project contains it.
 *
 * - A path nested inside a registered project resolves to that project's
 *   workspace.
 * - Overlapping registrations (a parent and a nested child both registered,
 *   possibly under different workspaces) resolve to the LONGEST matching
 *   registered path — the most specific registration wins.
 * - Two workspaces registering the IDENTICAL path is a real case, not a
 *   hypothetical one — verified live on this machine (this very repo is
 *   registered under both its own `groundfloor-atlas` workspace AND under
 *   `alex-admin`, which tracks it as one of several projects it oversees).
 *   For that exact-path tie, the EARLIEST registration wins (smallest
 *   `addedAt`) — the workspace that first claimed the path is treated as its
 *   owner; a later, different workspace also pointing at it is treated as a
 *   cross-reference, not a takeover.
 * - Symlinks and `..` are resolved canonically before comparison (see the
 *   header comment on why this reuses indexRoots.ts's realResolve).
 */
export function resolveWorkspaceForPath(cfg: AtlasConfig, targetPath: string): string | null {
    if (!targetPath) return null;
    const abs = realResolve(targetPath);
    let best: ResolverEntry | null = null;
    for (const entry of getIndex(cfg)) {
        const isMatch = abs === entry.realPath || abs.startsWith(entry.realPath + path.sep);
        if (!isMatch) continue;
        if (!best) { best = entry; continue; }
        if (entry.realPath.length > best.realPath.length) { best = entry; continue; }
        if (entry.realPath.length === best.realPath.length && entry.addedAt < best.addedAt) { best = entry; }
    }
    return best ? best.workspace : null;
}
