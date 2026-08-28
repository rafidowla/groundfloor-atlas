/**
 * mcp/tools/source.ts — atlas_source.
 *
 * Return a source-line slice for a file the code graph already knows about, so
 * the viewer's inspector can show a symbol's body inline. The inbound `path` is
 * the SAME repo-relative, forward-slash path the graph carries
 * (`code_file.label` / `SubgraphNode.file`, normalized at parser/index.ts:149).
 *
 * SECURITY: this tool reads arbitrary files off disk, so it MUST refuse any
 * path that escapes the resolved repo root. Resolution is anchored on the Atlas
 * registry (`<LORE_HOME>/atlas-registry.json` via codeIndexer.listRepos): a
 * repo-relative path is only ever joined onto a REGISTERED repo root, and a
 * two-stage containment check (lexical `path.relative` THEN `fs.realpathSync`
 * re-check) defeats `../` traversal, absolute-path escapes, AND symlink escape.
 * Nothing outside a registered repo root is ever readable.
 *
 * Pure filesystem + registry — no EmbeddedLore / Lore daemon needed, so the
 * caller in allTools.ts does NOT gate this behind embedded mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listRepos, getRepo, type IndexedRepo } from '../../codeIndexer.js';

export interface SourceArgs {
    /** Repo-relative file path (as in code_file.label / SubgraphNode.file). */
    path: string;
    /** 1-based first line of the slice. Omit for the whole file. */
    startLine?: number;
    /** 1-based last line of the slice. */
    endLine?: number;
    /** Extra lines above/below the slice. Default 5. */
    contextMargin?: number;
    /** Repo name (IndexedRepo.name) to resolve against directly, if known. */
    repo?: string;
    workspace?: string;
}

export interface SourceResult {
    path: string;
    absolutePath: string;
    /** 1-based first line actually returned (after margin + clamping). */
    startLine: number;
    /** 1-based last line actually returned. */
    endLine: number;
    /** Total line count of the file. */
    totalLines: number;
    /** The joined slice text. */
    content: string;
    /** GF-1 — true when the no-range whole-file fallback was head-capped to
     *  WHOLE_FILE_MAX_LINES. Absent (falsy) for explicit ranges and small files. */
    truncated?: boolean;
    /** GF-1 — human-readable note explaining the head cap + how to read more.
     *  Only set when `truncated` is true. */
    notice?: string;
}

export interface SourceError {
    error: string;
    path: string;
    detail?: string;
}

const DEFAULT_CONTEXT_MARGIN = 5;

/**
 * GF-1 — head cap for the no-range whole-file fallback. When the caller omits
 * BOTH startLine and endLine on a large file, returning the entire body floods
 * the inspector (and the model's context). Cap to the first N lines and flag
 * `truncated` + a `notice` telling the caller to pass an explicit range to read
 * more. Explicit ranges are caller-controlled and stay UNCAPPED.
 */
const WHOLE_FILE_MAX_LINES = 400;
/** RD-Msource — reject reading a file larger than this BEFORE slurping it into
 *  memory (a stat check, not a post-read truncation). 16 MiB is well above any
 *  real source file; binaries / generated blobs above it are refused. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Resolve `relPath` against `repoRoot` and run the two-stage path-safety check.
 * Returns the canonicalized absolute target on success, or a SourceError if the
 * path escapes the root (or does not exist).
 *
 * Stage 1 (lexical, BEFORE touching disk): join the (possibly malicious) path
 * onto the canonical root and reject if `path.relative(root, requested)` is ''
 * (the root itself), starts with '..' (traversal), or is absolute (an absolute
 * `relPath` makes `path.resolve` discard the root → relative back to root is
 * '..'-prefixed → rejected here).
 *
 * Stage 2 (symlink, after stat): `fs.realpathSync` both root and target and
 * re-check containment, so a symlink INSIDE the repo that points OUTSIDE it is
 * still rejected.
 */
function resolveWithinRoot(
    repoRoot: string,
    relPath: string,
): { absolutePath: string } | SourceError {
    const root = path.resolve(repoRoot);
    const requested = path.resolve(root, relPath);

    // ── Stage 1: lexical containment (no disk access yet). ──
    const rel = path.relative(root, requested);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { error: 'path escapes repo root', path: relPath };
    }

    // ── Stage 2: resolve symlinks and re-check containment. ──
    let realRoot: string;
    let realTarget: string;
    try {
        realRoot = fs.realpathSync(root);
    } catch {
        // The registered root itself is missing — treat as not-found.
        return { error: 'repo root not found on disk', path: relPath };
    }
    try {
        realTarget = fs.realpathSync(requested);
    } catch {
        return { error: 'file not found', path: relPath };
    }
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return { error: 'path escapes repo root (symlink)', path: relPath };
    }

    return { absolutePath: realTarget };
}

/**
 * Resolve the inbound repo-relative path against a registered repo root and
 * return the requested line slice (+ context margin). Refuses any path that
 * escapes a registered root.
 *
 * Resolution order:
 *   1. If `args.repo` is given, resolve against THAT registry entry only.
 *   2. Otherwise try each registered repo root in turn; the first one that both
 *      passes the safety check AND exists on disk wins. (A workspace can hold
 *      multiple registered repos and the inbound path is repo-relative, so we
 *      probe each root rather than guess.)
 */
export async function runSourceTool(args: SourceArgs): Promise<SourceResult | SourceError> {
    const relPath = args.path;
    if (typeof relPath !== 'string' || relPath.length === 0) {
        return { error: 'path is required', path: String(relPath ?? '') };
    }

    // Candidate roots: a named repo if supplied, else every registered repo.
    let candidates: IndexedRepo[];
    if (args.repo) {
        const r = getRepo(args.repo);
        if (!r) return { error: `repo not registered: ${args.repo}`, path: relPath };
        candidates = [r];
    } else {
        candidates = listRepos();
    }
    if (candidates.length === 0) {
        return { error: 'no indexed repos registered', path: relPath };
    }

    // Probe each candidate root. A safety REJECTION (escape) on one root does
    // NOT short-circuit — a benign relative path can still resolve under a
    // different registered root. But if the ONLY outcomes were escapes, surface
    // the escape error (never silently fall through to "not found").
    let lastError: SourceError | null = null;
    let resolved: { absolutePath: string } | null = null;
    for (const repo of candidates) {
        const r = resolveWithinRoot(repo.path, relPath);
        if ('error' in r) {
            lastError = r;
            continue;
        }
        resolved = r;
        break;
    }
    if (!resolved) {
        return lastError ?? { error: 'file not found', path: relPath };
    }

    // ── Read + slice. ──
    // RD-Msource — size-gate BEFORE reading the file into memory. A multi-GB
    // blob must not be slurped just to slice a few lines off it.
    try {
        const st = fs.statSync(resolved.absolutePath);
        if (st.size > MAX_FILE_BYTES) {
            return {
                error: 'file too large',
                path: relPath,
                detail: `file is ${st.size} bytes; max ${MAX_FILE_BYTES}`,
            };
        }
    } catch (err) {
        return { error: 'failed to read file', path: relPath, detail: (err as Error).message };
    }
    let raw: string;
    try {
        raw = fs.readFileSync(resolved.absolutePath, 'utf-8');
    } catch (err) {
        return { error: 'failed to read file', path: relPath, detail: (err as Error).message };
    }

    const lines = raw.split('\n');
    const totalLines = lines.length;
    const margin = typeof args.contextMargin === 'number' && args.contextMargin >= 0
        ? Math.floor(args.contextMargin)
        : DEFAULT_CONTEXT_MARGIN;

    // GF-1 — detect the no-range case BEFORE the reqStart/reqEnd defaulting below
    // collapses it (defaulting reqEnd to totalLines loses the "caller omitted it"
    // signal). Only when BOTH bounds are absent do we treat this as a whole-file
    // request eligible for the head cap.
    const noRange = typeof args.startLine !== 'number' && typeof args.endLine !== 'number';

    // GF-1 — whole-file fallback head cap. A no-range request on a large file is
    // capped to the first WHOLE_FILE_MAX_LINES (a head cap, NOT a slice-around-
    // target, so contextMargin does not apply here). Explicit ranges and small
    // whole files (≤ cap) fall through to the unbounded lo/hi path below.
    if (noRange && totalLines > WHOLE_FILE_MAX_LINES) {
        const cappedContent = lines.slice(0, WHOLE_FILE_MAX_LINES).join('\n');
        return {
            path: relPath,
            absolutePath: resolved.absolutePath,
            startLine: 1,
            endLine: WHOLE_FILE_MAX_LINES,
            totalLines,
            content: cappedContent,
            truncated: true,
            notice: `file has ${totalLines} lines; returning first ${WHOLE_FILE_MAX_LINES}. Pass startLine/endLine to read more.`,
        };
    }

    // Default to the whole file when no start/end given.
    const reqStart = typeof args.startLine === 'number' ? Math.floor(args.startLine) : 1;
    const reqEnd = typeof args.endLine === 'number' ? Math.floor(args.endLine) : totalLines;

    // Apply margin, then clamp to [1, totalLines]. Guard inverted ranges.
    const lo = Math.max(1, Math.min(reqStart, reqEnd) - margin);
    const hi = Math.min(totalLines, Math.max(reqStart, reqEnd) + margin);

    // slice() is 0-based, half-open: lines[lo-1 .. hi-1] inclusive.
    const content = lines.slice(lo - 1, hi).join('\n');

    return {
        path: relPath,
        absolutePath: resolved.absolutePath,
        startLine: lo,
        endLine: hi,
        totalLines,
        content,
    };
}
