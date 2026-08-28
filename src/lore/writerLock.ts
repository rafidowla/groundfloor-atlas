/**
 * lore/writerLock.ts — single-writer lock on a workspace dataDir, shared by
 * BOTH index write paths (the short-lived CLI `atlas index` process AND the
 * always-on daemon's `atlas_index` tool).
 *
 * WHY THIS EXISTS (RC defect #1 — concurrent CLI+daemon writer, no lock):
 * the embedded Lore store (kuzu+lancedb+sqlite) is SINGLE-WRITER per dataDir.
 * The daemon's `atlas_index` had an in-process re-entrancy guard (`_indexInFlight`
 * Set in mcp/allTools.ts), but that Set lives in the daemon's memory only — the
 * CLI is a SEPARATE OS process, so it never sees the daemon's guard (and vice
 * versa). With the daemon running as an always-on service, `atlas index` and a
 * concurrent `atlas_index` tool call would open the SAME dataDir and write it at
 * once → silent partial / corrupted index (or a raw kuzu "Could not set lock on
 * file" stack).
 *
 * THE FIX: a filesystem lock file at `<dataDir>/.atlas-writer.lock` created with
 * `fs.openSync(..., 'wx')` (O_CREAT | O_EXCL — atomic "fail if exists"). The
 * holder writes its pid + start time into the file; a second writer that finds
 * the file open reads the pid, and:
 *   - if the pid is still alive → refuses with a clear
 *     "workspace is being indexed by pid N" error (NOT a corrupt store),
 *   - if the pid is dead (crashed holder left a STALE lock) → steals the lock
 *     and proceeds.
 * Both the CLI path and the daemon tool wrap their write section in
 * `withWorkspaceWriteLock`, so the two processes serialize on the same file.
 *
 * This is deliberately a coarse, cross-PROCESS lock — the daemon's in-process
 * `_indexInFlight` Set stays as a fast-path reject for the daemon-vs-daemon
 * overlap (a clearer message, no filesystem hop); the file lock is the
 * authoritative cross-process guard underneath it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const WRITER_LOCK_BASENAME = '.atlas-writer.lock';

/** A payload-less lock file younger than this is a live winner mid-write
 *  (openSync→writeSync window), NOT a stealable stale lock. The winner's
 *  write lands microseconds after create; 5s is generous beyond belief. */
const EMPTY_PAYLOAD_GRACE_MS = 5_000;

/** Structured error thrown when the lock is held by a LIVE writer. Carries the
 *  holder pid so callers can surface a precise message / map to an exit code. */
export class WorkspaceLockedError extends Error {
    readonly holderPid: number;
    readonly dataDir: string;
    constructor(dataDir: string, holderPid: number) {
        super(
            `workspace dataDir is being indexed by pid ${holderPid} ` +
            `(single-writer lock at ${path.join(dataDir, WRITER_LOCK_BASENAME)}); ` +
            `wait for that index to finish and retry`,
        );
        this.name = 'WorkspaceLockedError';
        this.holderPid = holderPid;
        this.dataDir = dataDir;
    }
}

interface LockPayload {
    pid: number;
    startedAt: number;
    host?: string;
}

/** True if a pid is a live process WE can observe. `kill(pid, 0)` throws ESRCH
 *  when the process is gone and EPERM when it exists but we can't signal it (a
 *  live holder we must still respect). Any other outcome → treat as alive
 *  (fail-safe: never steal a lock we're unsure about). */
function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return false; // definitively gone
        if (code === 'EPERM') return true;  // exists, not ours to signal
        return true;                        // unknown → assume alive
    }
}

/** Read + parse a lock file's payload; null on any read/parse failure. */
function readLockPayload(lockPath: string): LockPayload | null {
    let text: string;
    try { text = fs.readFileSync(lockPath, 'utf8'); }
    catch { return null; }
    try {
        const p = JSON.parse(text) as Partial<LockPayload>;
        if (typeof p.pid === 'number') {
            return { pid: p.pid, startedAt: typeof p.startedAt === 'number' ? p.startedAt : 0, host: p.host };
        }
    } catch { /* corrupt / partial write */ }
    return null;
}

/**
 * Acquire the single-writer lock for `dataDir`. Returns a handle whose
 * `release()` deletes the lock file (idempotent — safe to call twice, and safe
 * even if the file was already stolen/removed).
 *
 * Throws {@link WorkspaceLockedError} when a LIVE process already holds it.
 * A stale lock (holder pid dead, or unparseable/empty file with no live pid) is
 * stolen atomically and the caller proceeds.
 */
export function acquireWorkspaceWriteLock(dataDir: string): { release: () => void; lockPath: string } {
    // The dataDir must exist before we can drop a lock file in it. Index callers
    // create it (EmbeddedLore.open mkdirs 0700) but the lock is acquired BEFORE
    // open, so ensure it here too. Best-effort mode; the open below is authoritative.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dataDir, WRITER_LOCK_BASENAME);
    const payload: LockPayload = { pid: process.pid, startedAt: Date.now(), host: safeHostname() };
    const body = JSON.stringify(payload);

    // Try up to twice: first attempt may race a stale-lock steal below.
    for (let attempt = 0; attempt < 2; attempt++) {
        let fd: number;
        try {
            // O_CREAT | O_EXCL | O_WRONLY — atomic "create, fail if exists".
            fd = fs.openSync(lockPath, 'wx', 0o600);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            // Lock exists — is the holder alive? A LIVE holder (any pid, incl. our
            // own — a re-entrant acquire is still a second concurrent writer)
            // means reject. Only a DEAD holder or a corrupt/unparseable file with
            // no live pid is stealable.
            const held = readLockPayload(lockPath);
            if (held && pidAlive(held.pid)) {
                throw new WorkspaceLockedError(dataDir, held.pid);
            }
            if (!held) {
                // Empty/corrupt payload. Two cases:
                //  (a) genuinely stale garbage (a crash mid-write, long ago) —
                //      stealable, handled below;
                //  (b) a LIVE winner in the openSync→writeSync window RIGHT
                //      NOW — the file exists but its payload hasn't landed yet.
                //      Stealing in case (b) is exactly the two-concurrent-
                //      writers corruption this lock exists to prevent: the
                //      winner already returned holding the lock, and its
                //      release() would even skip removal (pid mismatch).
                // The winner's write lands microseconds after create, so a
                // payload-less file YOUNGER than the grace window means a live
                // contender — treat it as locked (pid unknown → -1, the same
                // sentinel the two-attempts-lost path below already uses).
                try {
                    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
                    if (ageMs < EMPTY_PAYLOAD_GRACE_MS) {
                        throw new WorkspaceLockedError(dataDir, -1);
                    }
                } catch (err) {
                    if (err instanceof WorkspaceLockedError) throw err;
                    // statSync raced a removal — the file vanished; fall
                    // through to the steal/retry path.
                }
            }
            // Stale (dead holder) OR corrupt/empty AND older than the grace
            // window: steal it. Remove and retry the exclusive create so the
            // steal itself stays atomic — if two writers race here, only one
            // wins the re-create; the loser sees EEXIST again and (finding US
            // alive) throws WorkspaceLockedError.
            try { fs.rmSync(lockPath, { force: true }); } catch { /* raced away */ }
            continue;
        }
        try {
            fs.writeSync(fd, body);
        } finally {
            fs.closeSync(fd);
        }
        let released = false;
        return {
            lockPath,
            release: () => {
                if (released) return;
                released = true;
                // Only remove the file if it's still OURS — a stale-steal by a
                // later writer (after our crash) must not be clobbered by a late
                // release. Best-effort throughout.
                const cur = readLockPayload(lockPath);
                if (!cur || cur.pid === process.pid) {
                    try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
                }
            },
        };
    }
    // Both attempts lost the steal race to a live writer.
    const held = readLockPayload(lockPath);
    throw new WorkspaceLockedError(dataDir, held?.pid ?? -1);
}

function safeHostname(): string | undefined {
    try { return os.hostname(); }
    catch { return undefined; }
}
