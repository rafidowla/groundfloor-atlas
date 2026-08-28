/**
 * indexRoots.ts — opt-in scan-path allowlist (audit ATL-004/005/006).
 *
 * Atlas tools that take a CALLER-SUPPLIED filesystem path (atlas_index,
 * schema_drift, hotspots/blast_radius git churn, atlas_source) will, by DEFAULT,
 * scan any path the daemon's OS user can read. On the auth-off embedded
 * deployment any local process could exploit that to read arbitrary folders into
 * the graph. This module lets a security-conscious operator restrict scanning to
 * an approved set of roots WITHOUT changing default behavior.
 *
 *   - UNSET (default) → permissive: every path allowed (no behavior change).
 *   - SET → a caller path must resolve to a descendant of one approved root,
 *     else it is refused.
 *
 * The allowlist is OPERATOR-controlled — `ATLAS_INDEX_ROOTS` env (PATH-style,
 * os.delimiter-separated; takes precedence) or `config.index.roots`. An MCP
 * caller can never widen it. Paths are realpath-resolved before comparison so a
 * `..` traversal or a symlink that escapes an approved root is caught, and the
 * `root + sep` boundary prevents a prefix collision (`/a/foo` ⊄ `/a/foobar`).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { loadConfig } from './config.js';

/**
 * Resolve to an absolute, symlink-canonical path — INCLUDING when the leaf (or
 * any tail) doesn't exist yet. A naive `realpathSync` throws ENOENT on a missing
 * component and a plain `path.resolve` fallback does NOT follow symlinks, so
 * `<root>/<symlink-to-outside>/<nonexistent>` would textually look in-root while
 * actually pointing outside (audit: symlink-escape via the realpath fallback).
 * We realpath the deepest EXISTING ancestor — which follows every intermediate
 * symlink — then re-append the non-existent tail.
 */
export function realResolve(p: string): string {
    let abs = path.resolve(p);
    const tail: string[] = [];
    for (;;) {
        try {
            const real = fs.realpathSync.native(abs);
            return tail.length === 0 ? real : path.join(real, ...tail.reverse());
        } catch {
            const parent = path.dirname(abs);
            if (parent === abs) return path.resolve(p); // reached fs root; nothing existed
            tail.push(path.basename(abs));
            abs = parent;
        }
    }
}

/** The effective allowlist: ATLAS_INDEX_ROOTS env (precedence) else
 *  config.index.roots, each realpath-canonicalized. Empty = permissive. */
export function effectiveIndexRoots(): string[] {
    const env = (process.env['ATLAS_INDEX_ROOTS'] ?? '').trim();
    const raw = env ? env.split(path.delimiter) : (loadConfig().index?.roots ?? []);
    const out: string[] = [];
    for (const r of raw) {
        const t = String(r).trim();
        if (t) out.push(realResolve(t));
    }
    return out;
}

/**
 * Returns an error string if `target` is OUTSIDE the configured allowlist, or
 * null when allowed. Null also when no roots are configured (permissive default)
 * — so callers can unconditionally `const e = scanPathError(p); if (e) return {error:e}`.
 */
export function scanPathError(target: string, roots: string[] = effectiveIndexRoots()): string | null {
    if (roots.length === 0) return null; // unset → permissive
    // Reject raw '..' segments. realResolve()/path.resolve collapse them
    // TEXTUALLY (before following symlinks), but a sink that reads the raw string
    // lets the OS traverse an intermediate symlink FIRST — a check/use mismatch
    // that can escape the root (e.g. /allowed/<symlink-to-/etc>/../x resolves to
    // /etc/x at the read but /allowed/x at the check). A legitimate scan/index/
    // schema path never needs '..'; refuse it while an allowlist is active.
    if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(target)) {
        return `path must not contain '..' segments when an allowlist is configured: ${target}`;
    }
    const abs = realResolve(target);
    const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    return ok
        ? null
        : `path is outside the ATLAS_INDEX_ROOTS allowlist (set ATLAS_INDEX_ROOTS or config.index.roots to permit it): ${abs}`;
}

/**
 * The root set the /api/fs/browse directory-listing endpoint may enumerate.
 *
 * Unlike scanPathError's OPT-IN allowlist, fs/browse is ALWAYS bounded — even
 * with no operator config it must not let a caller list arbitrary system
 * directories (/etc, another user's home, /). The baseline is the daemon user's
 * HOME subtree (the natural place a user picks a project from); any configured
 * scan roots (ATLAS_INDEX_ROOTS / config.index.roots) are added so an operator
 * who indexes projects outside home can still browse to them.
 */
export function fsBrowseRoots(): string[] {
    const roots = new Set<string>();
    roots.add(realResolve(os.homedir()));
    for (const r of effectiveIndexRoots()) roots.add(r);
    return [...roots];
}

/**
 * Returns an error string if `target` is OUTSIDE the fs-browse root set, or null
 * when allowed. Applies the SAME '..'-rejection + realpath containment
 * scanPathError uses (atlas_source's lexical+realpath model), but with an
 * always-on baseline (see fsBrowseRoots) so it is never permissive. `target`
 * should already be tilde-expanded and absolute-resolved by the caller.
 */
export function fsBrowsePathError(target: string, roots: string[] = fsBrowseRoots()): string | null {
    if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(target)) {
        return `path must not contain '..' segments: ${target}`;
    }
    const abs = realResolve(target);
    const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    return ok
        ? null
        : `path is outside the browsable root set (your home directory and any configured index roots): ${abs}`;
}
