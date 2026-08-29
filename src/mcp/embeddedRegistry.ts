/**
 * mcp/embeddedRegistry.ts — process-wide registry of long-lived EmbeddedLore
 * instances, one per workspace.
 *
 * EmbeddedLore.open() constructs kuzu + lancedb + sqlite handles — expensive,
 * and a single dataDir must not be opened twice concurrently (single-writer
 * stores contend). So in the daemon BOTH the read tools and the in-process
 * writer share ONE instance per workspace, opened on first use and closed on
 * daemon shutdown. The short-lived CLI (`atlas index`) opens its own instead.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../lore/embeddedLore.js';
import { loadConfig } from '../config.js';

type AtlasConfig = ReturnType<typeof loadConfig>;

/** dataDir → opening/opened instance. Keyed by dir so two workspaces that
 *  resolve to the same dir share, and re-opens are coalesced. Map iteration
 *  order is insertion/refresh order, so it doubles as the LRU queue. */
const instances = new Map<string, Promise<EmbeddedLore>>();

/** RC #4 — per-instance count of IN-FLIGHT users (tool calls currently reading/
 *  writing through the instance). LRU eviction must NEVER close an instance with
 *  a live user: closing native Kuzu/LanceDB handles out from under an in-flight
 *  read/write crashes the process. Keyed by the SAME dataDir key as `instances`.
 *  A borrow increments; the matching release decrements. */
const refCounts = new Map<string, number>();

/** RD-Mregistry — cap concurrently-open embedded instances. Each one holds
 *  native graph+lancedb+sqlite handles plus (in the daemon) a ~600MiB
 *  search-worker child; an unbounded daemon serving many workspaces would
 *  leak file descriptors / memory without bound. When the cap is exceeded
 *  the least-recently-used IDLE instance is closed and evicted.
 *
 *  The cap is MEMORY-ADAPTIVE (2026-08): the old fixed 10 was right for
 *  nobody — dangerous on an 8GiB laptop, needlessly tight on a 128GiB
 *  workstation. Derived from os.totalmem() by computeAdaptiveMaxOpen below,
 *  installed once at daemon boot (applyAdaptiveMaxOpen, daemon.ts) and
 *  force-able by operators via ATLAS_EMBEDDED_MAX_OPEN. */

/** Memory budget fraction — the daemon's worst-case footprint for open
 *  stores may claim at most half the machine's RAM; the other half belongs
 *  to the OS / IDE / browser. TOTAL (not free) memory is the signal:
 *  freemem() is a boot-moment snapshot dominated by transient page cache
 *  (measured 12GiB "free" on this 128GiB box mid-build), so a freemem-based
 *  cap would swing run-to-run — totalmem() is stable, matching the
 *  compute-once-at-boot-for-predictability goal. */
const MEM_BUDGET_FRACTION = 0.5;

/** Worst-case resident cost of ONE open workspace, the divisor of the cap.
 *  Dominated by the search-worker child's own embedding-model copy when
 *  LORE_SEARCH_WORKER=1 (the daemon plist always sets it — cli/service.ts):
 *  ~600MiB RSS per child, measured this session (a live re-read under load
 *  showed 777MB; 600MiB is the canonical budget figure). Also upper-bounds
 *  the cheaper worker-less config, so the cap errs conservative there. */
const PER_WORKSPACE_MEM_BYTES = 600 * 1024 * 1024;

/** Floor: even a tiny machine keeps a useful working set (current workspace
 *  plus a couple of recents) — eviction thrash below that costs more than
 *  the memory it saves. */
const MIN_OPEN = 3;

/** Ceiling: bounds file-descriptor growth on huge machines, where the raw
 *  memory formula alone would admit hundreds. Measured per open workspace:
 *  ~36 daemon-side store FDs + ~35 in the worker child ≈ 90 total, so 64
 *  open ≈ 5.8K FDs — comfortable under the common effective limits (libuv
 *  raises the soft limit at startup; 1048576 observed here). Operators in
 *  tighter containers use ATLAS_EMBEDDED_MAX_OPEN. */
const MAX_OPEN_CEILING = 64;

/** ATLAS_EMBEDDED_MAX_OPEN=<n> forces the cap (positive integer, honored
 *  UNCLAMPED — an operator forcing a value knows better than the heuristic;
 *  anything else is warned about and ignored). Same env-override shape as
 *  ATLAS_PORT et al. */
const MAX_OPEN_ENV = 'ATLAS_EMBEDDED_MAX_OPEN';

/** The derived cap plus every input that produced it, so the boot log and
 *  the workspace_status health surface can show WHY a value was chosen, not
 *  just that one was. */
export interface AdaptiveMaxOpen {
    maxOpen: number;
    /** 'env-override' = forced via ATLAS_EMBEDDED_MAX_OPEN; 'adaptive' = memory-derived. */
    source: 'env-override' | 'adaptive';
    totalMemBytes: number;
    /** totalMemBytes × MEM_BUDGET_FRACTION; null when env-forced (no budget was consulted). */
    memBudgetBytes: number | null;
    perWorkspaceBytes: number;
    minOpen: number;
    ceiling: number;
}

/** Pure derivation of the registry cap: floor(budget / per-workspace-cost)
 *  clamped to [MIN_OPEN, MAX_OPEN_CEILING], or the env override verbatim. */
export function computeAdaptiveMaxOpen(totalMemBytes: number, envOverride?: string): AdaptiveMaxOpen {
    const forced = envOverride === undefined ? NaN : Number(envOverride);
    if (Number.isInteger(forced) && forced >= 1) {
        return {
            maxOpen: forced,
            source: 'env-override',
            totalMemBytes,
            memBudgetBytes: null,
            perWorkspaceBytes: PER_WORKSPACE_MEM_BYTES,
            minOpen: MIN_OPEN,
            ceiling: MAX_OPEN_CEILING,
        };
    }
    if (envOverride !== undefined) {
        console.error(
            `[atlas] ${MAX_OPEN_ENV}="${envOverride}" is not a positive integer — ignoring it and using the memory-adaptive cap`,
        );
    }
    const memBudgetBytes = Math.floor(totalMemBytes * MEM_BUDGET_FRACTION);
    const raw = Math.floor(memBudgetBytes / PER_WORKSPACE_MEM_BYTES);
    return {
        maxOpen: Math.min(MAX_OPEN_CEILING, Math.max(MIN_OPEN, raw)),
        source: 'adaptive',
        totalMemBytes,
        memBudgetBytes,
        perWorkspaceBytes: PER_WORKSPACE_MEM_BYTES,
        minOpen: MIN_OPEN,
        ceiling: MAX_OPEN_CEILING,
    };
}

/** Current decision. Seeded at module load so non-daemon importers get a
 *  sane machine-appropriate cap too; the daemon boot re-derives + logs it
 *  via applyAdaptiveMaxOpen() (same inputs → same value; os.totalmem() is
 *  stable, so this is deterministic either way). */
let maxOpenDecision: AdaptiveMaxOpen = computeAdaptiveMaxOpen(os.totalmem(), process.env[MAX_OPEN_ENV]);

/** (Re)derive + install the cap. Called once from the daemon boot sequence,
 *  BEFORE any store can open, and from tests to pin specific scenarios.
 *  Returns the decision so the caller can log/expose it. */
export function applyAdaptiveMaxOpen(
    totalMemBytes: number = os.totalmem(),
    envOverride: string | undefined = process.env[MAX_OPEN_ENV],
): AdaptiveMaxOpen {
    maxOpenDecision = computeAdaptiveMaxOpen(totalMemBytes, envOverride);
    return maxOpenDecision;
}

/** The currently-installed cap decision (observability: workspace_status). */
export function embeddedMaxOpen(): AdaptiveMaxOpen {
    return maxOpenDecision;
}

/** Pin-while-pending (verbatim flush drain): injected predicate — TRUE for a
 *  dataDir whose workspace has a non-empty verbatim flush queue AND whose
 *  flush circuit breaker is closed or half-open. Such an idle instance is
 *  exempt from LRU eviction: the 30s flush tick would otherwise close+reopen
 *  it on every pass while it is actively mid-drain. INJECTED (daemon boot
 *  wires verbatimQueue.isDirFlushPendingEligible here) rather than imported
 *  because verbatimQueue already imports this module — a static back-import
 *  would be circular. Null = no pinning (tests, non-daemon entry points). */
let hasPendingEligibleFlush: ((dir: string) => boolean) | null = null;

export function setPendingFlushPredicate(fn: ((dir: string) => boolean) | null): void {
    hasPendingEligibleFlush = fn;
}

/** Cap on how many dirs the pin above may exempt from eviction: without it,
 *  a pathological multi-workspace verbatim backlog would pin every idle
 *  instance and turn the LRU cap into unbounded cache growth (a memory
 *  leak, the exact failure class MAX_OPEN exists to prevent). Over-cap
 *  pending dirs fall back to plain LRU with a log line. */
const MAX_FLUSH_PINNED = 5;

/** Per-dir eviction/reopen counters for the health surface (workspace_status):
 *  how many times this dir was LRU-evicted, and how many times it was
 *  re-opened after previously being seen. Churn here = an over-cap registry
 *  thrashing a workspace, or a pinned-then-expired drain. */
interface DirLifecycle {
    evictions: number;
    reopens: number;
}

const dirLifecycle = new Map<string, DirLifecycle>();

export function embeddedDirLifecycle(dir: string): { evictions: number; reopens: number } {
    return dirLifecycle.get(dir) ?? { evictions: 0, reopens: 0 };
}

/**
 * RD-Mquarantine — corrupt-store circuit breaker.
 *
 * Without this, a dataDir whose kuzu/lancedb/sqlite files are corrupt (disk
 * corruption, an interrupted write, a bad manual edit) gets its EXPENSIVE
 * `EmbeddedLore.open()` re-attempted on EVERY tool call forever — the existing
 * `p.catch(() => instances.delete(dir))` eviction means a failed open is never
 * cached as a rejection, so nothing short-circuits the retry. For a corrupt
 * store that open can be slow AND doomed to fail every time, so every tool
 * call pays the full cost only to fail identically.
 *
 * Tracks consecutive open failures per dataDir. After `FAILURE_THRESHOLD`
 * CONSECUTIVE failures, the dir is quarantined for `COOLDOWN_MS`: further
 * calls fail FAST with a clear, actionable error instead of re-attempting the
 * open. After the cooldown elapses, exactly one "probe" open is allowed
 * (half-open) — success clears the quarantine, failure re-arms it for
 * another full cooldown. A successful open at ANY point resets the counter to
 * zero, so a transiently-flaky store (e.g. one interrupted write) recovers
 * automatically instead of tripping the breaker on unrelated future failures.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;

interface FailureState {
    consecutiveFailures: number;
    quarantinedUntil: number; // epoch ms; 0 = not quarantined
    lastError: string;
}

const failureStates = new Map<string, FailureState>();

/** True while `dir` is quarantined (past threshold, cooldown not yet elapsed). */
function isQuarantined(dir: string): boolean {
    const st = failureStates.get(dir);
    if (!st) return false;
    return st.consecutiveFailures >= FAILURE_THRESHOLD && Date.now() < st.quarantinedUntil;
}

function recordOpenSuccess(dir: string): void {
    failureStates.delete(dir);
}

function recordOpenFailure(dir: string, err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    const prev = failureStates.get(dir);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    const quarantinedUntil = consecutiveFailures >= FAILURE_THRESHOLD ? Date.now() + COOLDOWN_MS : 0;
    failureStates.set(dir, { consecutiveFailures, quarantinedUntil, lastError: msg });
}

function quarantineError(dir: string): Error {
    const st = failureStates.get(dir);
    const secondsLeft = st ? Math.max(0, Math.ceil((st.quarantinedUntil - Date.now()) / 1000)) : 0;
    return new Error(
        `Lore store at ${dir} failed to open ${st?.consecutiveFailures ?? FAILURE_THRESHOLD} times in a row ` +
        `(last error: ${st?.lastError ?? 'unknown'}) and is temporarily quarantined for ${secondsLeft}s to avoid ` +
        `retrying an expensive failing open on every call. This usually means the store is corrupt. ` +
        `Re-index the workspace (\`atlas index <path> --force\`) or remove the store directory and re-index from ` +
        `scratch if the problem persists.`,
    );
}

/** Test-only: reset the quarantine/failure state (and lifecycle counters)
 *  for a dir, or all dirs. */
export function _resetFailureStateForTests(dir?: string): void {
    if (dir) {
        failureStates.delete(dir);
        dirLifecycle.delete(dir);
    } else {
        failureStates.clear();
        dirLifecycle.clear();
    }
}

/** Diagnostics: current failure count for a dir (0 if none recorded). */
export function openFailureCount(dir: string): number {
    return failureStates.get(dir)?.consecutiveFailures ?? 0;
}

// Moved to ../projectRegistry.js (pure path math, no native deps) so callers
// needing only a data-dir path don't drag EmbeddedLore → @groundfloor/lore →
// kuzu/lancedb/better-sqlite3 in with them. Re-exported here so every existing
// importer of embeddedBaseDir/embeddedDataDir keeps working unchanged.
// Imported (so this module's own code can call them) AND re-exported (so every
// existing `from './embeddedRegistry.js'` import site keeps working unchanged).
import { embeddedBaseDir, embeddedDataDir } from '../projectRegistry.js';
export { embeddedBaseDir, embeddedDataDir };

/**
 * Ensure the lore-data root (or configured dataDir base) exists at 0700.
 * `lore-data` holds every workspace's full source-code graph — owner-only.
 * chmod is authoritative (mkdir's mode is umask-subject) and also hardens an
 * already-existing 0755 dir from before this fix. Best-effort: never crash the
 * daemon over a mode failure, but log it.
 */
export function ensureEmbeddedBaseDir(cfg: AtlasConfig): string {
    const dir = embeddedBaseDir(cfg);
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
        console.error(`[atlas] warning: failed to create lore-data root (${dir}): ${(err as Error).message}`);
    }
    try {
        fs.chmodSync(dir, 0o700);
    } catch (err) {
        console.error(`[atlas] warning: failed to chmod lore-data root (${dir}) to 0700: ${(err as Error).message}`);
    }
    return dir;
}


/** Get-or-open the shared EmbeddedLore for a workspace. Concurrent callers
 *  coalesce on the same open() promise; a failed open is dropped so a later
 *  call retries instead of pinning the rejection.
 *
 *  RD-Mquarantine — a dir with FAILURE_THRESHOLD consecutive failed opens is
 *  quarantined for a cooldown: calls during that window fail fast with a
 *  clear, actionable error instead of re-attempting the (expensive, doomed)
 *  open. See the circuit-breaker block above for the full rationale. */
export function getEmbeddedLore(cfg: AtlasConfig, workspace: string): Promise<EmbeddedLore> {
    ensureEmbeddedBaseDir(cfg);
    const dir = embeddedDataDir(cfg, workspace);
    let p = instances.get(dir);
    if (p) {
        // Refresh recency: move to the end of the Map (most-recently-used).
        instances.delete(dir);
        instances.set(dir, p);
        return p;
    }
    if (isQuarantined(dir)) {
        return Promise.reject(quarantineError(dir));
    }
    // Reopen bookkeeping for the health surface: a dir opening again after
    // being seen before is by definition an eviction-recovery (or a fresh
    // open after workspace_delete — still a reopen of a known dir).
    const lifecycle = dirLifecycle.get(dir);
    if (lifecycle) lifecycle.reopens += 1;
    else dirLifecycle.set(dir, { evictions: 0, reopens: 0 });
    p = EmbeddedLore.open(dir);
    p.then(
        () => recordOpenSuccess(dir),
        (err) => { instances.delete(dir); refCounts.delete(dir); recordOpenFailure(dir, err); },
    ).catch(() => { /* the handlers above never throw; belt-and-suspenders only */ });
    instances.set(dir, p);
    evictIdleOverCap(dir);
    return p;
}

/**
 * RC #4 — evict least-recently-used IDLE instances over the cap. Iterates the
 * Map in LRU order (oldest first) and closes only instances with a ZERO ref
 * count — never one with an in-flight user (that would close native handles
 * mid-read/write and crash). If every over-cap candidate is busy, we simply run
 * temporarily over the cap rather than close a live instance; the next
 * borrow/release or open retries the eviction. `keepDir` (the just-opened
 * instance) is never chosen.
 *
 * Pin-while-pending: an IDLE candidate whose workspace has a non-empty
 * verbatim flush queue (breaker closed or half-open — see the predicate
 * block above) is exempt, capped at MAX_FLUSH_PINNED exemptions so a
 * multi-workspace backlog cannot defeat MAX_OPEN; over-cap pending dirs
 * fall back to plain LRU with a log line.
 */
function evictIdleOverCap(keepDir: string): void {
    const cap = maxOpenDecision.maxOpen; // adaptive — see computeAdaptiveMaxOpen
    if (instances.size <= cap) return;
    let pinned = 0;
    let capLogged = false;
    for (const oldestKey of [...instances.keys()]) {
        if (instances.size <= cap) break;
        if (oldestKey === keepDir) continue;
        if ((refCounts.get(oldestKey) ?? 0) > 0) continue; // busy — skip, don't close
        const pending = hasPendingEligibleFlush?.(oldestKey) ?? false;
        if (pending) {
            if (pinned < MAX_FLUSH_PINNED) {
                pinned += 1;
                continue; // mid-drain workspace — keep its warm handles
            }
            if (!capLogged) {
                capLogged = true;
                console.error(
                    `[atlas] embedded registry: flush-pin cap (${MAX_FLUSH_PINNED}) exceeded — ` +
                        `${oldestKey} and any further pending dirs fall back to plain LRU eviction`,
                );
            }
        }
        const victim = instances.get(oldestKey);
        instances.delete(oldestKey);
        refCounts.delete(oldestKey);
        const lc = dirLifecycle.get(oldestKey);
        if (lc) lc.evictions += 1;
        else dirLifecycle.set(oldestKey, { evictions: 1, reopens: 0 });
        if (victim) {
            void victim.then((l) => l.close()).catch(() => { /* best-effort close */ });
        }
    }
}

/**
 * RC #4 — borrow the shared EmbeddedLore for a workspace, marking it in-flight so
 * LRU eviction can't close it under us. Pairs with a `release()` (call it in a
 * finally). Returns the opened instance + its release. Concurrent borrows stack:
 * the instance is safe to evict only when the ref count is back to zero.
 */
export async function borrowEmbeddedLore(
    cfg: AtlasConfig,
    workspace: string,
): Promise<{ lore: EmbeddedLore; release: () => void }> {
    ensureEmbeddedBaseDir(cfg);
    const dir = embeddedDataDir(cfg, workspace);
    // Increment BEFORE awaiting open so an eviction racing the open can't pick
    // this dir (getEmbeddedLore sets instances[dir] synchronously below).
    refCounts.set(dir, (refCounts.get(dir) ?? 0) + 1);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        const n = (refCounts.get(dir) ?? 1) - 1;
        if (n <= 0) refCounts.delete(dir);
        else refCounts.set(dir, n);
    };
    try {
        const lore = await getEmbeddedLore(cfg, workspace);
        return { lore, release };
    } catch (err) {
        // Open failed — undo the ref so a leaked count can't pin a phantom dir.
        release();
        throw err;
    }
}

/** RC #4 — in-flight user count for a dataDir (tests / diagnostics). */
export function inFlightUsers(dir: string): number {
    return refCounts.get(dir) ?? 0;
}

/**
 * RC #4 convenience — borrow, run `fn`, release (even on throw). Prefer this
 * over raw `getEmbeddedLore` in tool handlers: a raw get leaves the refcount
 * at 0, so LRU eviction can close native handles out from under the in-flight
 * query (the crash class RC #4 exists to prevent).
 */
export async function withEmbeddedLore<T>(
    cfg: AtlasConfig,
    workspace: string,
    fn: (lore: EmbeddedLore) => Promise<T>,
): Promise<T> {
    const { lore, release } = await borrowEmbeddedLore(cfg, workspace);
    try {
        return await fn(lore);
    } finally {
        release();
    }
}

/**
 * Close + evict the shared instance for ONE workspace (workspace_delete /
 * workspace_rename). The cached handle keeps Kuzu/LanceDB/SQLite files open —
 * deleting or renaming the dataDir while it's still cached leaves a GHOST
 * instance whose later writes go into unlinked files, and re-creating a
 * workspace of the same name would keep serving the ghost instead of opening
 * the fresh dir.
 *
 * Detaches the cache entry first so no new user can attach to the closing
 * instance, then waits for in-flight borrows to drain (RC #4: never close
 * native handles under a live user). If the workspace is still busy when the
 * drain window expires, the entry is re-attached (so the registry keeps
 * owning the live handle — orphaning it would let a second open violate the
 * single-writer rule) and an error is thrown so the caller can retry.
 * No-op if the workspace was never opened in this process.
 */
export async function closeEmbeddedLore(cfg: AtlasConfig, workspace: string): Promise<void> {
    const dir = embeddedDataDir(cfg, workspace);
    const p = instances.get(dir);
    if (!p) return;
    instances.delete(dir);
    const deadline = Date.now() + 30_000;
    while ((refCounts.get(dir) ?? 0) > 0) {
        if (Date.now() > deadline) {
            instances.set(dir, p); // keep owning the live handle
            throw new Error(`workspace '${workspace}' still has in-flight operations — try again in a moment`);
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    refCounts.delete(dir);
    await p.then((l) => l.close()).catch(() => { /* best-effort close */ });
}

/** Close every open instance (daemon graceful shutdown). Best-effort. */
export async function closeAllEmbedded(): Promise<void> {
    // RD-F07close — snapshot the handles FIRST, then clear, then await. A close
    // that throws can no longer leave the registry pointing at a half-closed
    // instance, and allSettled means one failure doesn't abort the rest.
    const entries = [...instances.entries()];
    instances.clear();
    // DRAIN (RC #4, close-all path) — closeEmbeddedLore waits for in-flight
    // borrows before closing; the close-ALL path used to clear refCounts and
    // close immediately, killing native handles under live tool calls during
    // daemon shutdown (reproduced: a borrowed instance closed mid-call →
    // `KuzuConnectionPool: pool is closed`). Give outstanding borrows the same
    // bounded drain window, then close regardless — shutdown can't wait forever.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const busy = entries.some(([dir]) => (refCounts.get(dir) ?? 0) > 0);
        if (!busy) break;
        await new Promise((r) => setTimeout(r, 25));
    }
    refCounts.clear();
    await Promise.allSettled(entries.map(([, p]) => p.then((l) => l.close())));
}

/** True if any embedded instance is currently open (for the maintenance timer). */
export function hasOpenEmbedded(): boolean {
    return instances.size > 0;
}

/** Snapshot of open instances (for the maintenance timer to sweep each).
 *  Tolerates a still-rejecting cached open promise (which races getEmbeddedLore's
 *  p.catch eviction): allSettled returns only the successfully-opened instances
 *  instead of rejecting the whole snapshot — matching closeAllEmbedded above. */
export async function openEmbeddedInstances(): Promise<EmbeddedLore[]> {
    const settled = await Promise.allSettled(Array.from(instances.values()));
    return settled
        .filter((r): r is PromiseFulfilledResult<EmbeddedLore> => r.status === 'fulfilled')
        .map((r) => r.value);
}
