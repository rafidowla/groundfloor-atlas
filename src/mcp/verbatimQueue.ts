/**
 * mcp/verbatimQueue.ts — append-only write queue for the verbatim tools (WO-2).
 *
 * verbatim_store / verbatim_import must return IMMEDIATELY (an agent quoting a
 * doc should not wait on kuzu+lancedb), so they hand the fully-built node to
 * this queue and the flush lands it via EmbeddedLore.bulkStoreNodes (the bulk
 * upsert path, embed:'sync' — vectors persisted before resolve).
 *
 * Deliberately APPEND-ONLY: nodes are upserted by their deterministic
 * `verbatim:<sha256(text)[0..12]>` id and never edited or deleted here (D6).
 * Re-storing byte-identical text before a flush replaces the queued entry;
 * after a flush the bulk upsert lands on the same id (idempotent).
 *
 * Failure posture: a transient batch failure re-queues the batch at the BACK
 * and the pass ROTATES to the next different workspace (never head-of-line
 * blocking); a per-workspace circuit breaker (3 strikes → cooldown →
 * half-open probe, mirroring embeddedRegistry's quarantine) stops a
 * hopelessly-broken workspace from re-embedding on every tick, and a
 * retry-path existence pre-check drops ids a timed-out write already landed.
 * A per-node failure inside a landed batch is logged and dropped; the node was
 * rejected by the store itself, so re-queuing would be a poison pill every 30s.
 *
 * Durability posture: every enqueue appends one JSON line to a write-ahead
 * journal (<ATLAS_HOME>/verbatim-queue.jsonl — the .jsonl convention of
 * memorySync's .atlas/memory.jsonl and allTools' knowledge-backups) BEFORE
 * the in-memory push, a flush pass that removed entries compacts the journal
 * back down to the queue, and daemon startup replays it
 * (replayVerbatimJournal). An entry therefore survives even a SIGKILL between
 * enqueue and flush — the graceful-shutdown flush alone could never cover a
 * hard crash, which skips it entirely. Durability comes from the enqueue-time
 * append, NEVER from a last-ditch shutdown-time write under time pressure.
 *
 * Liveness posture: EVERY await in a flush pass is time-bounded, and the pass
 * slot is never held across an unbounded await. Reproduced live on the
 * long-running daemon: a single never-settling store call (LanceDB
 * search-worker hang, maintenance-lock stall) used to leave the flush
 * in-flight forever — verbatim_store kept answering {ok,queued}, nothing ever
 * landed, and the daemon-shutdown flush returned instantly with
 * "0 landed, N unflushed" and no error logged. The journal's own I/O is
 * deliberately synchronous LOCAL disk (appendFileSync / temp+rename) OUTSIDE
 * the bounded-step machinery — the timeouts exist to bound REMOTE/native
 * calls that can hang; a local page-cache append cannot wedge on a stalled
 * store, and keeping it out of that machinery means it can never sit in the
 * same lock/await chain as one (the pre-4e89f57 wedge).
 *
 * Search-visibility posture: a landed row is durable but INVISIBLE to
 * keyword/BM25 search until Lore folds it into the FTS/vector indices, which
 * only a maintenance/optimize pass does (the daemon's 20-min ticker, or a
 * fresh process). Each landed batch therefore arms a rate-limited, fully
 * detached index fold (maybeFoldVerbatimIndex) — every 5th landed batch or
 * every 2 minutes, whichever fires first — so a quote becomes searchable in
 * seconds-to-minutes instead of up to 20 minutes. The fold is never awaited
 * by a pass and never inside the bounded-step machinery: the maintenance
 * lock is exactly what wedged this queue once before (4e89f57), so a fold
 * may at worst contend with a later pass's write, which the pass already
 * survives (step timeout → requeue → next tick).
 */

import type { StoreNodeInput } from '../loreClient.js';
import type { EmbeddedLore } from '../lore/embeddedLore.js';
import type { AtlasConfig } from '../config.js';
import { embeddedDataDir } from '../projectRegistry.js';
import { borrowEmbeddedLore } from './embeddedRegistry.js';
import { isShuttingDown } from '../lore/indexDrain.js';
import { loadConfig } from '../config.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Max nodes per bulkStoreNodes call. Keeps one embed batch small and bounded
 *  (same reasoning as the 50-file index batches, sized for interactive text). */
export const VERBATIM_BATCH = 5;
/** Embed-work budget per flush batch, in estimated e5 chunks. VERBATIM_BATCH
 *  caps a batch by node COUNT — sized for interactive text (a few hundred
 *  chars each). Real verbatim notes run to tens of KB, and Lore chunks those
 *  at ~1200 chars/chunk before embedding: five 25k-char notes = ~120 chunks
 *  of ONNX forward-pass work in ONE bulkStoreNodes call, which deterministically
 *  blew the 10s step budget every tick (the 2026-08 llm-api-gateway incident:
 *  head-of-line requeue loop, unbounded abandoned native writes, daemon CPU
 *  climb). Capping the batch by estimated chunk cost too keeps each batch
 *  inside the step budget; 32 = one of Lore's EMBED_FORWARD_BATCH forward
 *  passes. A single note whose estimate alone exceeds the budget still gets
 *  its own solo batch (batch size 1) — never skipped, never split. */
export const VERBATIM_BATCH_CHUNK_BUDGET = 32;

/** Mirrors @groundfloor/lore's LocalEmbeddingProvider chunking constants
 *  (verified 2026-08-29: EMBED_CHUNK_CHARS=1200, EMBED_CHUNK_CHAR_OVERLAP=150,
 *  tokenizer path 448/64). Duplicated because the provider does not export
 *  them. The estimate uses the CHAR-window fallback (stride 1050): for
 *  English prose it OVERESTIMATES vs the token path (~4 chars/token), so a
 *  drift in either direction is absorbed by the solo-batch path and the
 *  flush circuit breaker — this only sizes batches, it gates nothing. */
const EMBED_CHUNK_CHARS_EST = 1200;
const EMBED_CHUNK_CHAR_STRIDE_EST = 1050;

/** Estimated e5 chunk count for one queued node — the same text Lore embeds
 *  (buildVerbatimText: label + content + tags joined by blank lines), split
 *  by the same windows. embed:false nodes cost nothing (no vector row). */
export function estimateEmbedChunks(node: StoreNodeInput): number {
    if (node.embed === false) return 0;
    const parts = [node.label, node.content, node.tags].filter(
        (p): p is string => typeof p === 'string' && p.trim() !== '',
    );
    const len = parts.join('\n\n').length;
    if (len <= EMBED_CHUNK_CHARS_EST) return 1;
    return 1 + Math.ceil((len - EMBED_CHUNK_CHARS_EST) / EMBED_CHUNK_CHAR_STRIDE_EST);
}

/** Flush cadence. Unref'd so a queue holding entries can never keep the
 *  daemon (or a test process) alive on its own. */
export const VERBATIM_FLUSH_INTERVAL_MS = 30_000;

/** Hard queue cap. Overflow drops the OLDEST entry (FIFO pressure relief) and
 *  warns ONCE per overflow episode — a burst must not spam the log per item. */
export const VERBATIM_QUEUE_CAP = 500;

/** Bound for the daemon-shutdown flush. Best-effort: unflushed entries at the
 *  deadline are logged, not silently dropped. */
export const VERBATIM_SHUTDOWN_FLUSH_MS = 10_000;

/** Per-step budget for each await inside a flush pass (the borrow open, the
 *  bulkStoreNodes write, the embed settle). A healthy batch — ≤5 nodes,
 *  embed:'sync', lore's own withRetry inside — lands in well under a second;
 *  the same calls have been observed stalling for 120s+ (LanceDB search
 *  worker hangs) or never settling (maintenance-lock contention) on live
 *  long-running daemons. A step that blows this budget is treated as a
 *  transient failure: requeue, retry next tick — never an eternal await. */
export const VERBATIM_FLUSH_STEP_MS = 10_000;

/** Overall budget for the periodic (30s-tick) flush, which passes no deadline
 *  of its own. Bounds a queue-draining pass of many healthy batches; a pass
 *  blocked on a stalled store ends at its first step timeout long before
 *  this. Every flush is bounded — an unbounded one can hold the flush slot
 *  forever, which is how the queue used to wedge (see flushVerbatimQueue). */
export const VERBATIM_PERIODIC_FLUSH_MS = 60_000;
/** Landed-batch boundary for the post-flush index fold. A pass draining
 *  bursts folds at most this many batches late — 5 batches = 25+ entries,
 *  where keyword-visibility lag compounds fastest. Trickle traffic never
 *  reaches it and is covered by the time boundary below instead. */
export const VERBATIM_FOLD_EVERY_BATCHES = 5;

/** Time boundary for the post-flush index fold — whichever boundary comes
 *  FIRST fires. 2 minutes bounds the blind window for any cadence to
 *  ~2.5 min (this + the 30s flush tick) vs the ~20.5 min status quo (the
 *  daemon maintenance ticker alone), while keeping fold frequency an order
 *  of magnitude below the measured overlapping-maintenance conflict regime
 *  (65-73%, daemon.ts) — and folds never overlap each other anyway (one
 *  in-flight slot). */
export const VERBATIM_FOLD_MIN_INTERVAL_MS = 120_000;

/** Patience budget for ONE fold's own maintenance await. The fold is fully
 *  detached from the flush pass (never inside its bounded-step budget), so
 *  this only bounds how long WE watch before logging and moving on — the
 *  underlying runMaintenance is left to finish and keeps the fold slot held
 *  (a stall suppresses later folds instead of piling concurrent maintenance
 *  onto the store). 30s = 3× a flush step budget: enough for a normal
 *  in the log quickly. */
export const VERBATIM_FOLD_TIMEOUT_MS = 30_000;

export interface QueuedVerbatim {
    workspace: string;
    node: StoreNodeInput;
    /** When this entry was queued (epoch ms) — powers the oldest-queued-age
     *  health signal. Journaled; replay falls back to Date.now() for lines
     *  written before the field existed (e.g. the quarantined backlog). */
    enqueuedAt: number;
}

/** A borrowed shared instance + its release (mirrors borrowEmbeddedLore's
 *  shape so tests can substitute a scratch EmbeddedLore without the registry). */
export interface VerbatimBorrow {
    lore: EmbeddedLore;
    release: () => void;
}

export interface VerbatimFlushResult {
    /** Nodes that landed in the store. */
    flushed: number;
    /** bulkStoreNodes calls made. */
    batches: number;
    /** Entries still queued when the flush ended (requeued failures or deadline). */
    remaining: number;
    /** Entries that failed per-node inside a landed batch (dropped, logged). */
    failed: number;
}

const queue: QueuedVerbatim[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let overflowWarned = false;
/** The pass currently draining the queue, or null. Replaces the old boolean
 *  `flushing` flag: the flag was held across unbounded awaits, so a single
 *  never-settling store call (observed live: LanceDB search-worker hangs,
 *  maintenance-lock stalls) wedged it FOREVER — every later flush, including
 *  the daemon's shutdown flush, returned instantly having landed nothing
 *  ("0 landed, N unflushed" with no error logged). Passes are now internally
 *  bounded, and a re-entrant caller waits for the in-flight pass instead of
 *  silently no-op-ing. */
let flushInFlight: Promise<VerbatimFlushResult> | null = null;

/** Entries the in-flight pass has shifted off `queue` but not yet landed or
 *  requeued. A caller that gives up waiting on the in-flight pass reports
 *  these as not-yet-flushed — `queue.length` alone undercounts to 0 mid-batch
 *  and would read as "all landed" while the entries are still in flight. */
let claimedEntries = 0;
/** Landed batches since the last fired index fold (burst boundary). */
let batchesSinceFold = 0;

/** foldClock() of the last fired index fold. Starts at 0, so the FIRST
 *  landed batch of a process is always time-due and folds immediately —
 *  the common case is one quote between long idle gaps, and it should not
 *  sit out a timer. */
let lastFoldAt = 0;

/** The detached fold currently running, or null. Mirrors flushInFlight's
 *  role: while set, no new fold may start (never overlap maintenance —
 *  measured upstream at 65-73% failure, see daemon.ts). */
let foldInFlight: Promise<void> | null = null;

/** Time source for the fold rate-limits. Production is Date.now; tests pin
 *  it to prove the time boundary deterministically. Same override
 *  precedent as journalPathOverride. */
let foldClock: () => number = Date.now;

// ── Write-failure circuit breaker ───────────────────────────────────────────
// Port of embeddedRegistry's RD-Mquarantine open-failure pattern (3 strikes →
// cooldown → half-open probe), applied to per-workspace FLUSH failures. The
// registry breaker guards expensive re-OPENs of a corrupt store; this one
// guards the re-EMBED+re-WRITE of a batch that keeps failing. Same shape and
// naming (record*Success/Failure, isQuarantined, threshold+cooldown+half-open)
// so the two read as one pattern.

const FLUSH_FAILURE_THRESHOLD = 3;
const FLUSH_COOLDOWN_MS = 60_000;

interface FlushFailureState {
    consecutiveFailures: number;
    quarantinedUntil: number; // epoch ms; 0 = not quarantined
    lastError: string;
}

const flushFailures = new Map<string, FlushFailureState>();

/** True while `workspace`'s flush breaker is OPEN (past threshold, cooldown
 *  not yet elapsed). Flush passes skip its entries entirely for the window;
 *  after it elapses the next pass is a half-open probe batch. */
function isFlushQuarantined(workspace: string): boolean {
    const st = flushFailures.get(workspace);
    if (!st) return false;
    return st.consecutiveFailures >= FLUSH_FAILURE_THRESHOLD && Date.now() < st.quarantinedUntil;
}

/** Consecutive flush failures for a workspace (0 if none recorded). Drives
 *  the retry-path existence pre-check and the health surface. */
export function flushFailureStreak(workspace: string): number {
    return flushFailures.get(workspace)?.consecutiveFailures ?? 0;
}

function recordFlushSuccess(workspace: string): void {
    flushFailures.delete(workspace);
}

function recordFlushFailure(workspace: string, err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    const prev = flushFailures.get(workspace);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    const wasQuarantined = prev !== undefined && prev.consecutiveFailures >= FLUSH_FAILURE_THRESHOLD && Date.now() < prev.quarantinedUntil;
    const quarantinedUntil = consecutiveFailures >= FLUSH_FAILURE_THRESHOLD ? Date.now() + FLUSH_COOLDOWN_MS : 0;
    flushFailures.set(workspace, { consecutiveFailures, quarantinedUntil, lastError: msg });
    // Log only on the transition INTO quarantine (and each half-open re-arm):
    // a broken workspace must be visible without raw-log archaeology, but a
    // per-tick repeat would spam daemon.err exactly like the overflow path
    // this module already guards against.
    if (!wasQuarantined && consecutiveFailures >= FLUSH_FAILURE_THRESHOLD) {
        console.error(
            `[atlas] verbatim flush: workspace ${workspace} failed ${consecutiveFailures} flushes in a row ` +
                `(last error: ${msg}) — quarantining its ${FLUSH_COOLDOWN_MS / 1000}s before the next half-open probe; ` +
                `entries stay queued (see workspace_status verbatimQueue health)`,
        );
    }
}

// ── Health surface (observability) ──────────────────────────────────────────

/** Per-workspace queue health for workspace_status: pending depth, flush
 *  failure streak, breaker state, and the age of the oldest queued entry.
 *  A streak ≥ FLUSH_FAILURE_THRESHOLD is visible here without raw logs. */
export interface VerbatimQueueHealth {
    /** Entries currently queued for this workspace. */
    pendingEntries: number;
    /** Consecutive failed flush batches (0 = healthy). */
    consecutiveFlushFailures: number;
    /** True while the flush breaker is OPEN (cooldown window). */
    quarantined: boolean;
    /** Age in ms of the oldest queued entry (null = nothing queued). */
    oldestQueuedAgeMs: number | null;
}

export function verbatimQueueHealth(workspace: string): VerbatimQueueHealth {
    let pending = 0;
    let oldest: number | null = null;
    for (const e of queue) {
        if (e.workspace !== workspace) continue;
        pending += 1;
        if (oldest === null || e.enqueuedAt < oldest) oldest = e.enqueuedAt;
    }
    const st = flushFailures.get(workspace);
    return {
        pendingEntries: pending,
        consecutiveFlushFailures: st?.consecutiveFailures ?? 0,
        quarantined: isFlushQuarantined(workspace),
        oldestQueuedAgeMs: oldest === null ? null : Date.now() - oldest,
    };
}

/** Item-5 predicate wired into embeddedRegistry (daemon boot) so LRU eviction
 *  can exempt a workspace that is actively mid-drain: true while `dir`'s
 *  workspace has a non-empty flush queue AND its breaker is closed or
 *  half-open — NOT open (an open breaker makes the workspace flush-ineligible
 *  for the whole cooldown, so pinning it would waste one of the registry's
 *  capped pin slots). Takes a dataDir (the registry's key space) and maps it
 *  back via embeddedDataDir, the same pure path math the registry uses. */
export function isDirFlushPendingEligible(dir: string): boolean {
    if (queue.length === 0) return false;
    let cfg: AtlasConfig;
    try {
        cfg = loadConfig();
    } catch {
        return false; // unreadable config: pin nothing, fall back to plain LRU
    }
    for (const workspace of new Set(queue.map((e) => e.workspace))) {
        try {
            if (embeddedDataDir(cfg, workspace) === dir && !isFlushQuarantined(workspace)) return true;
        } catch {
            // invalid workspace name for this config — cannot be this dir
        }
    }
    return false;
}

// ── Write-ahead journal ──────────────────────────────────────────────────────

/** Memoized <ATLAS_HOME>/verbatim-queue.jsonl (loadConfig on every enqueue
 *  would re-read config.json per verbatim_store; the home never moves
 *  mid-process — config.ts snapshots ATLAS_HOME at load precisely because
 *  embedded Lore's env-scrubber deletes it later, so both resolution paths
 *  agree). Null when resolution failed (unreadable config): the queue then
 *  runs memory-only, exactly the pre-journal behavior, never throwing into
 *  the enqueue path. */
let journalPathCache: string | null = null;

/** Test override for the journal location (tests must never touch the real
 *  ATLAS_HOME). Same precedent as hookEnrich._setLookupForTests. */
let journalPathOverride: string | null = null;

/** One journal-I/O warning per episode (mirrors overflowWarned): a failing
 *  disk must not turn every enqueue into a log line. Cleared again by the
 *  first successful journal write. */
let journalWarned = false;

function resolveJournalPath(): string | null {
    if (journalPathOverride) return journalPathOverride;
    if (!journalPathCache) {
        try {
            journalPathCache = path.join(loadConfig().home, 'verbatim-queue.jsonl');
        } catch {
            return null;
        }
    }
    return journalPathCache;
}

function warnJournalOnce(detail: string): void {
    if (journalWarned) return;
    journalWarned = true;
    console.error(`[atlas] verbatim journal: ${detail} — continuing in memory only; entries still queued at a hard kill may be lost`);
}

/** One durable journal line: {"workspace":"…","node":{…}}\n. JSON.stringify
 *  escapes embedded newlines, so one entry is always exactly one line — the
 *  .jsonl convention used by .atlas/memory.jsonl and the knowledge backups.
 *  No fsync: the failure mode this journal exists for is PROCESS death
 *  (SIGKILL/crash), which page-cache writes survive; OS-power-loss durability
 *  would cost a sync per quote for no observed failure to match. */
function appendJournalLine(entry: QueuedVerbatim): void {
    const jp = resolveJournalPath();
    if (!jp) {
        warnJournalOnce('path resolution failed');
        return;
    }
    try {
        fs.mkdirSync(path.dirname(jp), { recursive: true });
        fs.appendFileSync(jp, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
        journalWarned = false;
    } catch (err) {
        warnJournalOnce(`append failed: ${(err as Error)?.message ?? String(err)}`);
    }
}

/** Compact the journal to the current in-memory queue so landed (or
 *  rejected-and-dropped) entries leave the file and it never grows unbounded.
 *  Atomic temp+rename with 0o600 — the same discipline as memorySync's
 *  memory.jsonl writes — so a crash mid-compact leaves the complete OLD file,
 *  never a truncated one. Bounded by VERBATIM_QUEUE_CAP lines of local I/O. */
function rewriteJournal(): void {
    const jp = resolveJournalPath();
    if (!jp) return;
    try {
        fs.mkdirSync(path.dirname(jp), { recursive: true });
        const tmp = `${jp}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, queue.map((e) => `${JSON.stringify(e)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort on platforms without chmod */ }
        fs.renameSync(tmp, jp);
        journalWarned = false;
    } catch (err) {
        warnJournalOnce(`compact failed: ${(err as Error)?.message ?? String(err)} — replayed landed entries re-upsert idempotently, so this is waste, not loss`);
    }
}

/** Outcome of one bounded flush step. `timeout` means the step's budget
 *  blew; `error` re-surfaces the step's own rejection to the pass's catch. */
type StepOutcome<T> =
    | { state: 'value'; value: T }
    | { state: 'error'; error: unknown }
    | { state: 'timeout' };

/** Await `p` for at most `ms`. Never rejects — the outcome object carries a
 *  rejection — and always observes `p`, so a late rejection after a lost race
 *  can never surface as an unhandled rejection. The timer is unref'd so a
 *  losing race never keeps an idle process alive. (Executor form, not
 *  Promise.withResolvers: the daemon's pinned Node 20 runtime lacks it.) */
function stepBounded<T>(p: Promise<T>, ms: number): Promise<StepOutcome<T>> {
    return new Promise((resolveStep) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; resolveStep({ state: 'timeout' }); }
        }, Math.max(1, ms));
        if (typeof timer.unref === 'function') timer.unref();
        p.then(
            (value) => { if (!settled) { settled = true; clearTimeout(timer); resolveStep({ state: 'value', value }); } },
            (error) => { if (!settled) { settled = true; clearTimeout(timer); resolveStep({ state: 'error', error }); } },
        );
    });
}

/** Deterministic node id — first 12 hex chars of sha256(text). Identical text
 *  collapses onto ONE node (intentional idempotent upsert, D6). */
export function verbatimIdFor(text: string): string {
    return `verbatim:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`;
}

function ensureFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        void flushVerbatimQueue().catch((err: unknown) => {
            console.error(`[atlas] verbatim flush error: ${(err as Error)?.message ?? String(err)}`);
        });
    }, VERBATIM_FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Queue one fully-built verbatim node. Returns immediately; the entry lands on
 * the next flush (30s tick, a direct flushVerbatimQueue call, or shutdown).
 */
export function enqueueVerbatim(workspace: string, node: StoreNodeInput): void {
    // Write-ahead journal BEFORE the in-memory push: once this line is on
    // disk the entry survives even a hard kill before any flush — durability
    // comes from THIS append, never from a shutdown-time write. Synchronous
    // local disk, deliberately outside the flush's bounded-step machinery
    // (see the module header's liveness posture).
    appendJournalLine({ workspace, node, enqueuedAt: Date.now() });
    // Journal hygiene: a re-store of identical text (dedup) or an overflow
    // drop leaves a stale line on disk. Rewrite so the journal mirrors the
    // queue. A crash between the append above and this rewrite replays BOTH
    // copies of a deduped id — replay applies the same last-write-wins, so
    // it self-heals.
    const deduped = queue.some((e) => e.node.id === node.id);
    const overflowed = pushEntry(workspace, node);
    if (deduped || overflowed) rewriteJournal();
    ensureFlushTimer();
}

/** Queue mutation shared by live enqueue and journal replay — identical
 *  semantics either way: last-write-wins dedup by node id, FIFO cap with a
 *  single warning per overflow episode. Returns true when an overflow drop
 *  happened (the live caller refreshes the journal; replay must not write). */
function pushEntry(workspace: string, node: StoreNodeInput, enqueuedAt: number = Date.now()): boolean {
    // Same id already queued (identical text re-stored before a flush):
    // drop the earlier copy — last write wins, same as the upsert would do.
    const idx = queue.findIndex((e) => e.node.id === node.id);
    if (idx >= 0) queue.splice(idx, 1);
    queue.push({ workspace, node, enqueuedAt });
    if (queue.length > VERBATIM_QUEUE_CAP) {
        const dropped = queue.splice(0, queue.length - VERBATIM_QUEUE_CAP);
        if (!overflowWarned) {
            overflowWarned = true;
            console.error(
                `[atlas] verbatim queue at cap (${VERBATIM_QUEUE_CAP}); dropped ${dropped.length} oldest entr${dropped.length === 1 ? 'y' : 'ies'}`,
            );
        }
        return true;
    }
    return false;
}

export interface VerbatimReplayResult {
    /** Valid entries re-populated into the in-memory queue. */
    replayed: number;
    /** Lines skipped as malformed (each is logged with its line number). */
    malformed: number;
}

/**
 * Startup recovery: re-populate the in-memory queue from the write-ahead
 * journal so entries survive a hard crash / SIGKILL — the kill that skips the
 * graceful-shutdown flush entirely. The daemon calls this ONCE at boot,
 * before the MCP server binds (replay must finish before new traffic can
 * enqueue, and before the first periodic tick). Read-only by design: the
 * first flush that lands anything compacts junk away. Malformed lines are
 * skipped and logged, never fatal — a damaged journal must not take the
 * daemon down with it. Replayed entries re-apply the exact live-enqueue
 * semantics via pushEntry (dedup by id, FIFO cap), so a journal holding both
 * copies of a deduped id, or more lines than the cap, self-heals to the same
 * state a live process would have.
 */
export function replayVerbatimJournal(): VerbatimReplayResult {
    const result: VerbatimReplayResult = { replayed: 0, malformed: 0 };
    const jp = resolveJournalPath();
    if (!jp) {
        warnJournalOnce('path resolution failed');
        return result;
    }
    let raw: string;
    try {
        raw = fs.readFileSync(jp, 'utf8');
        // Self-heal perms at boot: `mode` on appendFileSync only applies on
        // CREATE, so a journal that predates this fix (or was restored with
        // looser bits) is tightened here — the file holds quoted transcript
        // text. Same pattern as ideConnect's authoritative chmod.
        try { fs.chmodSync(jp, 0o600); } catch { /* best-effort */ }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnJournalOnce(`replay read failed: ${(err as Error)?.message ?? String(err)}`);
        }
        return result; // no journal yet = nothing was lost (normal first boot)
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() === '') continue;
        try {
            const parsed = JSON.parse(line) as { workspace?: unknown; node?: unknown };
            const node = parsed.node as Record<string, unknown> | undefined;
            // Shape gate: exactly the fields bulkStoreNodes requires to build
            // a node. Junk that could THROW inside the store would otherwise
            // requeue as a poison pill every 30s after replay.
            if (typeof parsed.workspace !== 'string' || parsed.workspace === ''
                || !node || typeof node !== 'object'
                || typeof node['id'] !== 'string' || node['id'] === ''
                || typeof node['type'] !== 'string' || node['type'] === ''
                || typeof node['label'] !== 'string' || node['label'] === ''
                || typeof node['workspace'] !== 'string' || node['workspace'] === '') {
                throw new Error('not a {workspace, node{id,type,label,workspace}} line');
            }
            pushEntry(
                parsed.workspace,
                node as unknown as StoreNodeInput,
                typeof (parsed as { enqueuedAt?: unknown }).enqueuedAt === 'number' && Number.isFinite((parsed as { enqueuedAt: number }).enqueuedAt)
                    ? (parsed as { enqueuedAt: number }).enqueuedAt
                    : Date.now(),
            );
            result.replayed += 1;
        } catch {
            result.malformed += 1;
            console.error(`[atlas] verbatim journal line ${i + 1}: malformed, skipped`);
        }
    }
    if (result.replayed > 0) ensureFlushTimer(); // the 30s tick lands them
    return result;
}

/** Test-only: point the journal at a scratch file so tests never touch the
 *  real ATLAS_HOME. Pass null to restore production resolution. */
export function _setVerbatimJournalPathForTests(p: string | null): void {
    journalPathOverride = p;
}

/** Test-only: reset the module to a fresh-process state (empty queue, no
 *  cached journal path, fold rate-limit counters at process start) —
 *  verbatim.test.ts CLAIM G uses this to simulate the death of the process
 *  between enqueue and flush, then runs the exact startup replay the daemon
 *  runs. Never call while a flush pass (or a detached fold) is in flight.
 *  Same precedent as indexDrain._resetIndexDrainForTest. */
export function _resetVerbatimQueueForTest(): void {
    queue.length = 0;
    overflowWarned = false;
    journalWarned = false;
    flushFailures.clear();
    journalPathCache = null;
    batchesSinceFold = 0;
    lastFoldAt = 0;
    foldClock = Date.now;
}

/** Test-only: pin the fold rate-limit clock (pass null to restore Date.now).
 *  CLAIM H uses this to prove the time boundary deterministically instead of
 *  sleeping out VERBATIM_FOLD_MIN_INTERVAL_MS. */
export function _setVerbatimFoldClockForTests(fn: (() => number) | null): void {
    foldClock = fn ?? Date.now;
}

/** Test-only: observe the fold rate-limit state (CLAIM H asserts the
 *  boundaries fire on schedule and that an in-flight fold suppresses the
 *  next one). */
export function _verbatimFoldForTests(): { batchesSinceFold: number; lastFoldAt: number; inFlight: boolean } {
    return { batchesSinceFold, lastFoldAt, inFlight: foldInFlight !== null };
}

/**
 * Flush the queue: process entries in FIFO order, grouping each consecutive
 * same-workspace run into bulkStoreNodes batches bounded BOTH by node count
 * (VERBATIM_BATCH) and by estimated embed work (VERBATIM_BATCH_CHUNK_BUDGET —
 * a batch of large notes must not deterministically blow the step budget, the
 * 2026-08 head-of-line incident). A failing batch is requeued to the back and
 * the pass rotates to the next DIFFERENT workspace (never head-of-line
 * blocking), under a per-workspace failure circuit breaker.
 *
 * `borrow` substitutes the lore source (tests pass a scratch EmbeddedLore);
 * `deadlineMs` bounds the whole flush (daemon shutdown uses 10s; the periodic
 * tick's default is VERBATIM_PERIODIC_FLUSH_MS). EVERY await inside a pass is
 * additionally bounded per-step (VERBATIM_FLUSH_STEP_MS) — reproduced live, a
 * pass left holding the flush slot across a never-settling store call wedged
 * the queue permanently (nothing landed, shutdown reported "0 landed, N
 * unflushed", no error ever surfaced).
 *
 * Re-entrant calls while a pass is in flight WAIT for it (bounded by the
 * caller's own deadline) and then take over if entries remain — never a
 * silent instant no-op.
 */
export async function flushVerbatimQueue(opts: {
    borrow?: (workspace: string) => Promise<VerbatimBorrow>;
    deadlineMs?: number;
} = {}): Promise<VerbatimFlushResult> {
    // The deadline bounds this WHOLE call: the bounded wait for an in-flight
    // pass and the take-over pass below share it.
    const deadline = Date.now() + (opts.deadlineMs ?? VERBATIM_PERIODIC_FLUSH_MS);
    if (flushInFlight) {
        await stepBounded(flushInFlight, Math.max(1, deadline - Date.now()));
        if (flushInFlight !== null || queue.length === 0) {
            // Still running at our deadline (or it drained everything).
            // Count entries the running pass holds mid-batch: bare
            // queue.length would claim "all landed" while they are in flight.
            return { flushed: 0, batches: 0, remaining: queue.length + claimedEntries, failed: 0 };
        }
        // The in-flight pass settled with entries still queued — take over
        // and drain them with whatever budget remains.
    }
    // Default borrower: the shared per-workspace registry instance, marked
    // in-flight so LRU eviction can't close native handles mid-write (RC #4).
    const borrow = opts.borrow ?? ((workspace: string) => borrowEmbeddedLore(loadConfig(), workspace));
    const pass = runFlushPass(borrow, deadline);
    flushInFlight = pass;
    try {
        return await pass;
    } finally {
        if (flushInFlight === pass) flushInFlight = null;
    }
}

/** Fire the post-flush index fold if a rate-limit boundary is due. Called
 *  AFTER a batch lands (post embed-settle) with the pass's own `borrow`, so
 *  production reaches the SAME runMaintenance surface the daemon's 20-min
 *  maintenance ticker uses — the only thing (besides a fresh process) that
 *  folds newly-written rows into Lore's FTS/vector indices. Until it runs,
 *  landed verbatim rows are durable but invisible to keyword/BM25 search.
 *
 *  Liveness posture (the pre-4e89f57 lesson — a maintenance-lock stall is
 *  exactly what used to wedge this queue): the fold is FULLY DETACHED. It is
 *  never awaited by the pass, never inside the bounded-step budget, and holds
 *  no queue state — a stalled fold can delay at most its own 30s watch, and
 *  the worst it can do to a later flush is ordinary maintenance-lock
 *  contention, which the pass already survives (step timeout → requeue →
 *  next tick). Boundaries, whichever fires first:
 *    - count: VERBATIM_FOLD_EVERY_BATCHES landed batches since the last fold;
 *    - time:  VERBATIM_FOLD_MIN_INTERVAL_MS since the last fold (and the
 *      first landed batch of a process — lastFoldAt starts at 0).
 *  Suppressed while another fold runs (never overlap maintenance) and during
 *  daemon shutdown (a fold fired there would only delay closeAllEmbedded —
 *  it serializes behind the fold on the maintenance lock — for zero benefit;
 *  the next start's first-batch fold covers visibility). */
function maybeFoldVerbatimIndex(
    borrow: (workspace: string) => Promise<VerbatimBorrow>,
    workspace: string,
): void {
    if (foldInFlight) return;
    if (isShuttingDown()) return;
    const now = foldClock();
    const byCount = batchesSinceFold >= VERBATIM_FOLD_EVERY_BATCHES;
    const byTime = now - lastFoldAt >= VERBATIM_FOLD_MIN_INTERVAL_MS;
    if (!byCount && !byTime) return;
    const batchesSeen = batchesSinceFold;
    const prevFoldAt = lastFoldAt;
    batchesSinceFold = 0;
    lastFoldAt = now;
    const why: string[] = [];
    if (byCount) why.push(`${batchesSeen} batches`);
    if (byTime) why.push(prevFoldAt === 0 ? 'first landed batch of the process' : `${Math.round((now - prevFoldAt) / 1000)}s`);
    console.error(`[atlas] verbatim: folding search indices for ${workspace} (${why.join(' + ')} since last fold)`);
    const fold = (async (): Promise<void> => {
        let release: (() => void) | null = null;
        let maintenance: Promise<unknown> | null = null;
        try {
            // Own borrow, own refcount: the pass's borrow can be released
            // long before this detached fold actually runs (RC #4 —
            // protection follows the operation, not the caller's patience).
            const b = await borrow(workspace);
            release = b.release;
            maintenance = Promise.resolve(b.lore.runMaintenance({ dryRun: false, cutoff: '15m' }));
            const om = await stepBounded(maintenance, VERBATIM_FOLD_TIMEOUT_MS);
            if (om.state === 'timeout') {
                console.error(
                    `[atlas] verbatim: index fold for ${workspace} still running after ` +
                    `${VERBATIM_FOLD_TIMEOUT_MS}ms — leaving it to finish in background; later folds suppressed until it settles`,
                );
            } else if (om.state === 'error') {
                console.error(
                    `[atlas] verbatim: index fold for ${workspace} failed: ` +
                    `${(om.error as Error)?.message ?? String(om.error)} — the maintenance ticker still covers it`,
                );
            }
        } catch (err) {
            console.error(
                `[atlas] verbatim: index fold for ${workspace} could not start: ` +
                `${(err as Error)?.message ?? String(err)}`,
            );
        } finally {
            // Pin the borrow until maintenance truly settles — it may outlive
            // the patience budget above — then release. The fold slot frees
            // on the SAME settle, so a stalled fold suppresses later folds
            // instead of piling concurrent maintenance onto the store.
            try {
                if (release) {
                    if (maintenance) await maintenance.then(() => undefined, () => undefined);
                    release();
                }
            } catch {
                // release() failing must not resurrect a settled fold.
            }
        }
    })();
    foldInFlight = fold;
    void fold.then(() => undefined, () => undefined).finally(() => {
        if (foldInFlight === fold) foldInFlight = null;
    });
}

/** One bounded queue-draining pass. Never rejects — every failure path
 *  (throw, step timeout, deadline) requeues what it took and returns. */
async function runFlushPass(
    borrow: (workspace: string) => Promise<VerbatimBorrow>,
    deadline: number,
): Promise<VerbatimFlushResult> {
    const result: VerbatimFlushResult = { flushed: 0, batches: 0, remaining: 0, failed: 0 };
    let borrowed: VerbatimBorrow | null = null;
    let borrowedWorkspace: string | null = null;
    /** True once a batch left the queue for good (landed, or rejected-and-
     *  dropped) — the pass-end journal compaction below depends on it. */
    let removedEntries = false;
    /** Drop the current borrow. When `abandoned` is set, the operation that
     *  timed out may STILL be running natively: keep the refcount pinned
     *  until it truly settles, then release (RC #4 — protection follows the
     *  operation, not the caller's patience). */
    const dropBorrow = (abandoned?: Promise<unknown>) => {
        const b = borrowed;
        borrowed = null;
        borrowedWorkspace = null;
        if (!b) return;
        if (abandoned) abandoned.then(() => undefined, () => undefined).finally(() => b.release());
        else b.release();
    };
    /** Workspaces this pass has already failed (or that are breaker-open):
     *  entries belonging to them are rotated to the back, NOT retried this
     *  pass — one workspace's poison batch must not starve the rest. */
    const unprocessable = new Set<string>();
    const headIsUnprocessable = () =>
        unprocessable.has(queue[0]!.workspace) || isFlushQuarantined(queue[0]!.workspace);
    // Every step's budget: the per-step cap, or whatever is left of the
    // pass deadline if smaller.
    const stepBudget = () => Math.max(1, Math.min(VERBATIM_FLUSH_STEP_MS, deadline - Date.now()));
    /** Land `entries` for `workspace`: ensure the borrow, existence-pre-check
     *  on the retry path, bulkStoreNodes, embed settle, fold arming. Throws
     *  on failure (the caller requeues); returns once every entry has either
     *  landed or been verified already-landed-and-dropped. */
    const attemptStore = async (workspace: string, entries: QueuedVerbatim[]): Promise<void> => {
        if (!borrowed || borrowedWorkspace !== workspace) {
            dropBorrow();
            const borrowP = borrow(workspace);
            const ob = await stepBounded(borrowP, stepBudget());
            if (ob.state === 'timeout') {
                // The open may still complete later — release the borrow
                // whenever it does, and fail this batch for this pass.
                borrowP.then((late) => late.release()).catch(() => undefined);
                throw new Error(`borrow timed out after ${stepBudget()}ms`);
            }
            if (ob.state === 'error') throw ob.error;
            borrowed = ob.value;
            borrowedWorkspace = workspace;
        }
        let toStore = entries;
        // Existence pre-check, RETRY PATH ONLY (the workspace has a failure
        // streak): a batch that timed out may have landed natively after the
        // pass gave up on it — nothing cancels the abandoned write — so look
        // up each deterministic verbatim:<sha> id and drop the ones already
        // in the store instead of paying their embed cost again on every
        // retry. A healthy workspace (streak 0) pays nothing.
        if (flushFailureStreak(workspace) > 0) {
            const survivors: QueuedVerbatim[] = [];
            for (const e of entries) {
                const og = await stepBounded(
                    Promise.resolve().then(() => borrowed!.lore.getNode(e.node.id)),
                    stepBudget(),
                );
                if (og.state === 'value' && og.value != null) {
                    claimedEntries -= 1;
                    removedEntries = true;
                    result.flushed += 1; // verified landed by a prior (timed-out) write
                } else {
                    survivors.push(e);
                }
            }
            if (survivors.length < entries.length) {
                console.error(
                    `[atlas] verbatim flush retry for ${workspace}: ${entries.length - survivors.length} entr` +
                        `${entries.length - survivors.length === 1 ? 'y' : 'ies'} already landed — dropped instead of re-embedded`,
                );
            }
            if (survivors.length === 0) {
                recordFlushSuccess(workspace);
                return;
            }
            toStore = survivors;
        }
        const storeP = borrowed.lore.bulkStoreNodes(toStore.map((e) => e.node));
        const os = await stepBounded(storeP, stepBudget());
        if (os.state === 'timeout') {
            // The write may still land natively — pin the instance until
            // it settles (RC #4). The batch is requeued below and retried
            // next pass; the upsert by deterministic id is idempotent, and
            // the retry-path existence pre-check above drops the stragglers.
            dropBorrow(storeP);
            throw new Error(`bulkStoreNodes timed out after ${stepBudget()}ms`);
        }
        if (os.state === 'error') throw os.error;
        result.batches += 1;
        result.flushed += os.value.succeeded;
        recordFlushSuccess(workspace);
        // Landed (or rejected-and-dropped) — the batch is permanently
        // out of the queue now.
        claimedEntries -= toStore.length;
        removedEntries = true;
        if (os.value.succeeded < os.value.count) {
            result.failed += os.value.count - os.value.succeeded;
            for (const r of os.value.results) {
                if (!r.ok) console.error(`[atlas] verbatim store rejected ${r.id}: ${r.error}`);
            }
        }
        // Mirror knowledge_store's same-turn contract: settle the embed
        // queue so a store → verbatim_recall right after the flush sees
        // the vector. Best-effort and bounded: embed:'sync' persists the
        // vectors BEFORE bulkStoreNodes resolves, so the batch has landed
        // regardless — a slow or stuck settle must not fail or requeue
        // it, and must not wedge the pass.
        const settleP = borrowed.lore.awaitEmbeds();
        const ov = await stepBounded(settleP, stepBudget());
        if (ov.state === 'timeout') {
            console.error(
                `[atlas] verbatim flush: embed settle timed out for workspace ${workspace} — batch already landed, continuing`,
            );
            dropBorrow(settleP);
        } else if (ov.state === 'error') {
            console.error(
                `[atlas] verbatim flush: embed settle failed for workspace ${workspace}: ${(ov.error as Error)?.message ?? String(ov.error)} — batch already landed, continuing`,
            );
        }

        // Search-visibility fold: the row + vector are durable now, but
        // Lore only folds new rows into the FTS/vector indices on a
        // maintenance/optimize pass (the 20-min daemon ticker or a fresh
        // process) — until one runs, keyword/BM25 search cannot see this
        // batch. Fire the rate-limited, fully detached fold (see
        // maybeFoldVerbatimIndex) so visibility lags by seconds-to-minutes
        // instead of up to the full ticker interval. NOT awaited, NOT
        // inside the step budget — a slow or stalled fold must never be
        // able to wedge or stall this pass (pre-4e89f57 lesson).
        batchesSinceFold += 1;
        maybeFoldVerbatimIndex(borrow, workspace);
    };
    while (queue.length > 0) {
        if (Date.now() >= deadline) break; // pass budget exhausted — rest waits for the next tick
        if (headIsUnprocessable()) {
            // Rotate, don't break: a failed/quarantined workspace's entries
            // go to the back so the NEXT workspace's batch surfaces. Only
            // when nothing else is processable does the pass stop.
            if (queue.every((e) => unprocessable.has(e.workspace) || isFlushQuarantined(e.workspace))) break;
            queue.push(queue.shift()!);
            continue;
        }
        const workspace = queue[0]!.workspace;
        // Content-sized batch: consecutive same-workspace entries, capped by
        // node count (VERBATIM_BATCH) AND estimated embed chunks. An entry
        // whose estimate alone exceeds the chunk budget still enters a batch
        // by itself (batch.length === 0 takes it unconditionally) — oversized
        // notes are solo batches, never skipped and never a spin loop.
        const batch: QueuedVerbatim[] = [];
        let batchChunks = 0;
        while (batch.length < VERBATIM_BATCH && queue.length > 0 && queue[0]!.workspace === workspace) {
            const nextChunks = estimateEmbedChunks(queue[0]!.node);
            if (batch.length > 0 && batchChunks + nextChunks > VERBATIM_BATCH_CHUNK_BUDGET) break;
            batch.push(queue.shift()!);
            batchChunks += nextChunks;
        }
        if (batch.length === 0) continue; // unreachable; keeps the loop honest
        claimedEntries += batch.length;
        try {
            await attemptStore(workspace, batch);
        } catch (err) {
            // Demotion probe: a failing batch LARGER than one note gets one
            // size-1 retry before any strike is counted — a solo note landing
            // means "batch too big" (resize, no strike); a solo note failing
            // too means the workspace is genuinely broken (strike). A batch
            // that is ALREADY size 1 (the solo path above) skips the probe
            // entirely: retrying the same single note would burn a full step
            // budget to learn nothing.
            let probeLanded = false;
            if (batch.length > 1) {
                try {
                    await attemptStore(workspace, [batch[0]!]);
                    probeLanded = true;
                } catch {
                    probeLanded = false;
                }
            }
            if (probeLanded) {
                console.error(
                    `[atlas] verbatim flush failed for workspace ${workspace}: ${(err as Error)?.message ?? String(err)} — ` +
                        `batch of ${batch.length} oversized (size-1 retry landed); remainder requeued, no strike counted`,
                );
                queue.push(...batch.slice(1)); // to the BACK: rotate, don't break
                claimedEntries -= batch.length - 1;
            } else {
                recordFlushFailure(workspace, err);
                console.error(
                    `[atlas] verbatim flush failed for workspace ${workspace}: ${(err as Error)?.message ?? String(err)} — ` +
                        `${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} requeued (failure streak ${flushFailureStreak(workspace)})`,
                );
                queue.push(...batch); // to the BACK: retried on a later tick, other workspaces still drain
                claimedEntries -= batch.length;
            }
            unprocessable.add(workspace);
        }
    }
    dropBorrow();
    // Journal hygiene: entries that left the queue for good must leave the
    // journal too, or it grows unbounded across store+flush cycles. ONE
    // compact per pass (not per batch): a crash between landed batches
    // merely replays entries the store already holds, and the idempotent
    // upsert by deterministic id makes that harmless waste, not corruption.
    // Bounded local I/O (≤ VERBATIM_QUEUE_CAP lines, temp+rename) —
    // deliberately not inside any stepBounded await.
    if (removedEntries) rewriteJournal();
    if (queue.length === 0) overflowWarned = false;
    result.remaining = queue.length;
    return result;
}
