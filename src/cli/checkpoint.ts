/**
 * cli/checkpoint.ts — Y3 resume state for `atlas index <dir> --resume`.
 *
 * Lives at `<root>/.atlas/index-state.json`. Records per-file
 * (mtimeMs + sizeBytes) so a re-run can skip unchanged files
 * deterministically without re-reading + re-parsing them. mtime+size
 * is a coarse fingerprint — it misses rewrites that preserve both —
 * but it's the same fingerprint git itself uses for its index, and
 * cheap to compute (one stat per file vs reading + hashing every byte
 * in a 5,800-file repo).
 *
 * Schema is JSON, line-stable: load → mutate → save. No external dep.
 *
 * Concurrency: Y3 ships single-run-only per the spec's scope guard —
 * two `atlas index --resume` processes touching the same .atlas/ are
 * not supported. A lockfile gate is Y3c.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface CheckpointEntry {
    mtimeMs: number;
    sizeBytes: number;
    indexedAt: string;  // ISO timestamp; informational only
}

export interface Checkpoint {
    version: 1;
    root: string;
    /**
     * The Lore workspace these file fingerprints were indexed INTO. A checkpoint
     * is keyed by filesystem root, but the same root can be indexed into
     * different workspaces — fingerprints from one workspace must NOT cause files
     * to be skipped for another (that would leave the new workspace with a
     * partial graph). Absent on pre-existing checkpoints (treated as "any").
     */
    workspace?: string;
    files: Record<string, CheckpointEntry>;  // key: path relative to root
    updatedAt: string;
}

const CHECKPOINT_DIR = '.atlas';
const CHECKPOINT_FILE = 'index-state.json';

function checkpointPath(root: string): string {
    return path.join(path.resolve(root), CHECKPOINT_DIR, CHECKPOINT_FILE);
}

export function loadCheckpoint(root: string, workspace?: string): Checkpoint {
    const p = checkpointPath(root);
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw) as Checkpoint;
        if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
            // Workspace guard: a checkpoint stamped for a DIFFERENT workspace
            // doesn't apply here — its "indexed" files were never written to this
            // workspace, so honoring it would skip them and produce a partial
            // graph. Start fresh (stamped for the new workspace).
            if (workspace !== undefined && parsed.workspace !== undefined && parsed.workspace !== workspace) {
                return { version: 1, root: path.resolve(root), workspace, files: {}, updatedAt: new Date().toISOString() };
            }
            return parsed;
        }
    } catch {
        // Missing / malformed → fresh checkpoint. The fingerprint is
        // local-only state; losing it just forces a full re-walk.
    }
    return { version: 1, root: path.resolve(root), workspace, files: {}, updatedAt: new Date().toISOString() };
}

/**
 * RD-Mckptprune — drop checkpoint entries whose file is gone from the CURRENT
 * parse set before saving. Without this, `cp.files` only ever grows: every
 * deleted/renamed file since the checkpoint was created leaves a permanent
 * fingerprint entry (unbounded growth over a repo's lifetime, and needless
 * bytes re-serialized+rewritten on every batch flush). `liveRelPaths`, when
 * given, is the set of repo-relative paths this run walked+parsed (the same
 * set buildResolutionContext/buildSymbolTable saw) — an entry not in it is
 * either deleted, renamed, or newly excluded, so it's safe to drop; a later
 * run that sees the file again just re-adds it (needsReindex correctly
 * returns true for an absent entry). Callers that don't pass a live set (or
 * pass undefined) keep the pre-existing no-pruning behavior — this is
 * opt-in so any caller unaware of the parameter is unaffected.
 */
export function pruneCheckpoint(cp: Checkpoint, liveRelPaths: ReadonlySet<string>): number {
    let pruned = 0;
    for (const rel of Object.keys(cp.files)) {
        if (!liveRelPaths.has(rel)) {
            delete cp.files[rel];
            pruned++;
        }
    }
    return pruned;
}

export function saveCheckpoint(cp: Checkpoint, liveRelPaths?: ReadonlySet<string>): void {
    const p = checkpointPath(cp.root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (liveRelPaths) pruneCheckpoint(cp, liveRelPaths);
    cp.updatedAt = new Date().toISOString();
    // Atomic write via temp + rename — readers never see a partial file.
    // RD-F29tmp — unique temp name (pid + random) so a symlink planted at a
    // fixed `.tmp` path can't redirect the write, and two concurrent writers
    // don't collide on the same temp file.
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
}

/**
 * Read ONLY the workspace stamp from a root's checkpoint, without the
 * workspace-mismatch invalidation loadCheckpoint applies. This is how a caller
 * discovers "which workspace was this root indexed into?" — the repo's own
 * recorded workspace — so `atlas index` can default to it instead of the
 * machine-global config workspace, which is almost never the project's own
 * (the silent-misfiling trap: nodes land in a generic workspace like
 * 'developer' with no error). Returns null when the checkpoint or its stamp
 * is absent/unreadable.
 */
export function checkpointWorkspace(root: string): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(checkpointPath(root), 'utf8')) as Checkpoint;
        return parsed && parsed.version === 1 && typeof parsed.workspace === 'string' && parsed.workspace.length > 0
            ? parsed.workspace
            : null;
    } catch {
        return null;
    }
}

/**
 * Should we re-parse `absPath`? Returns false when the checkpoint has
 * a matching (mtime + size) entry. The stat call is the only I/O; we
 * never read the file body for the comparison.
 */
export function needsReindex(absPath: string, cp: Checkpoint): boolean {
    const rel = path.relative(cp.root, absPath).split(path.sep).join('/');
    const prev = cp.files[rel];
    if (!prev) return true;
    let st: fs.Stats;
    try { st = fs.statSync(absPath); }
    catch { return true; }
    if (st.mtimeMs !== prev.mtimeMs) return true;
    if (st.size !== prev.sizeBytes) return true;
    return false;
}

/**
 * Record a successful index of `absPath` in the checkpoint. Caller is
 * responsible for invoking `saveCheckpoint(cp)` periodically (Y3 does
 * this after every successful bulk-flush so a kill mid-run resumes from
 * the last flushed batch).
 */
export function markIndexed(absPath: string, cp: Checkpoint, knownStat?: { mtimeMs: number; sizeBytes: number }): void {
    const rel = path.relative(cp.root, absPath).split(path.sep).join('/');
    // MTIME-AT-PARSE — callers that can should pass the stat captured when the
    // file was PARSED, not let us re-stat after the batch write lands (minutes
    // later on a big repo). A file edited mid-run otherwise gets its NEW mtime
    // checkpointed against the OLD content in the graph, so the next --resume
    // skips it and serves stale nodes until the file's next edit.
    let mtimeMs: number;
    let sizeBytes: number;
    if (knownStat) {
        ({ mtimeMs, sizeBytes } = knownStat);
    } else {
        let st: fs.Stats;
        try { st = fs.statSync(absPath); } catch { return; }
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
    }
    cp.files[rel] = {
        mtimeMs,
        sizeBytes,
        indexedAt: new Date().toISOString(),
    };
}
