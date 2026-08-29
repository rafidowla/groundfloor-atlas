/**
 * lore/embeddedLore.ts — in-process Lore adapter (the embed-as-library path).
 *
 * Wraps @groundfloor/lore's createLore() so Groundfloor Atlas runs a DEDICATED,
 * isolated Lore per project (its own kuzu + lancedb + sqlite under a
 * dataDir) instead of talking to a shared daemon over HTTP.
 *
 * It presents the SAME write surface as LoreClient (storeNode / storeEdge /
 * bulkStoreNodes / bulkStoreEdges / connect / close) plus the reads
 * loreReader needs (getNode / listNodes / traverse), so callers swap with
 * minimal change.
 *
 * Model: ONE EmbeddedLore per project — separation comes from the dataDir,
 * NOT the Lore workspace. We use the built-in 'default' workspace and stamp
 * project=<atlas workspace> on writes so reads scope correctly (F1).
 *
 * In-process wins (proven by scripts/embed-proof): no HTTP auth/403, no
 * project='*' mismatch (caller sets project), no 1,000-row read cap (10k
 * default + unbounded opt-in), and native traverse() for call-graph /
 * blast-radius (inbound + outbound edges with relation, no '←' hack, no
 * per-symbol HTTP fan-out).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLore, type LoreInstance } from '@groundfloor/lore';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { StoreNodeInput, StoreEdgeInput, LoreWriter } from '../loreClient.js';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../cli/memorySync.js';
import { tombstoneIdFor } from '../mcp/tools/knowledgeList.js';

/** The built-in workspace every dedicated instance ships with. */
const LORE_WORKSPACE = 'default';
const CODE_ECOSYSTEM = 'code';

/**
 * Coerce a LanceDB-returned vector field into a plain number[].
 *
 * LanceDB returns the `vector` column as an Apache Arrow `Vector` OBJECT —
 * NOT a JS array and NOT a TypedArray. Its real data is reachable ONLY via
 * `.toArray()` (a Float32Array); integer index access (`v[0]`) returns
 * `undefined`, so the naive index-loop below yields `Number(undefined)` ===
 * NaN for every element (384× NaN). The Arrow-`Vector` branch MUST run first.
 *
 * This mirrors Lore's own verbatimStore.toPlainVector, which checks
 * `typeof v.toArray === 'function'` before any index access. A previous
 * incomplete copy here dropped that branch and produced all-NaN vectors that
 * serialized to `[null, ...]` on export (JSON.stringify(NaN) === "null").
 */
function toPlainVector(v: unknown): number[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => Number(x));
    // Apache Arrow Vector (or any Arrow-like): the data lives behind
    // .toArray() — index access on the Vector itself returns undefined.
    const arrowLike = v as { toArray?: () => unknown };
    if (typeof arrowLike.toArray === 'function') {
        const inner = arrowLike.toArray(); // Float32Array or plain array
        if (Array.isArray(inner)) return inner.map((x) => Number(x));
        const ta = inner as { length?: number; [i: number]: unknown };
        if (typeof ta.length === 'number') {
            const out = new Array<number>(ta.length);
            for (let i = 0; i < ta.length; i++) out[i] = Number(ta[i]);
            return out;
        }
    }
    const indexed = v as { length?: number; [i: number]: unknown };
    if (typeof indexed.length !== 'number') return [];
    const out = new Array<number>(indexed.length);
    for (let i = 0; i < indexed.length; i++) out[i] = Number(indexed[i]);
    return out;
}

// Stable sort hits so curated knowledge types (decision/convention/bug_pattern/
// architecture/troubleshooting) rank ABOVE auto-generated types (code_context,
// code_file, code_symbol). Within each tier, original order/score preserved.
// Result item shape: { id, type?, label?, content?, ... } — anything with a string
// .type field. Items missing .type are treated as non-knowledge (rank below).
function reRankByType<T extends { type?: string }>(hits: T[]): T[] {
    const knowledge = new Set<string>(KNOWLEDGE_TYPES);
    // Stable partition: knowledge types first, others next; original relative order kept.
    const known: T[] = []; const other: T[] = [];
    for (const h of hits) (h.type && knowledge.has(h.type as KnowledgeType) ? known : other).push(h);
    return known.concat(other);
}

/** Max chars of `content` returned per hit in summary (default) recall mode.
 *  Long enough to be a useful snippet, short enough to keep recall responses
 *  lean; `mode:'full'` returns the complete content instead. */
const RECALL_SNIPPET_CHARS = 280;

/** Bound on how long close() waits for the maintenance lock before giving up
 *  on a clean dispose for THIS workspace (shutdown-wedge guard, RD-F13-adjacent).
 *  Distinct from runMaintenance's 120s loopback bound on purpose: that cap is
 *  the MCP CLIENT's patience with a slow-but-healthy compaction — it says
 *  nothing about when the lock actually frees, because the server-side
 *  compaction keeps running after the client gives up and the write paths
 *  (storeNode/storeEdge/bulks/supersede/deleteNode) hold the same lock with
 *  NO bound at all on their native calls. If any of those wedges natively,
 *  close()'s unbounded lock wait hangs the whole daemon shutdown forever.
 *  60s = 2× the fold's 30s patience window and above both 30s registry drain
 *  windows, so a healthy-but-slow holder is very likely to have settled;
 *  past it, "the daemon actually restarts" outranks "this one workspace's
 *  shutdown was pristine" (see close()). */
export const CLOSE_LOCK_TIMEOUT_MS = 60_000;

/** Non-destructively truncate a hit's `content` to a snippet for summary mode.
 *  Returns a copy; the original hit object is never mutated. */
function snippetHit<T extends { content?: string | null }>(h: T): T {
    const c = h.content;
    if (typeof c !== 'string' || c.length <= RECALL_SNIPPET_CHARS) return h;
    return { ...h, content: `${c.slice(0, RECALL_SNIPPET_CHARS).trimEnd()}…` };
}

export interface NodeBulkResult {
    ok: boolean;
    count: number;
    succeeded: number;
    results: Array<{ ok: boolean; id?: string; error?: string }>;
}
export interface EdgeBulkResult {
    ok: boolean;
    count: number;
    succeeded: number;
    results: Array<{ ok: boolean; error?: string }>;
}

export class EmbeddedLore implements LoreWriter {
    /**
     * The Atlas workspace this instance is dedicated to — derived in open()
     * from its dataDir's basename (embeddedDataDir(cfg, workspace) always
     * names the dir after the workspace, so this is exact, not a guess).
     * Used to report accurate scope info from recall() instead of echoing
     * the underlying engine's fixed LORE_WORKSPACE placeholder.
     */
    private constructor(private readonly lore: LoreInstance, readonly workspace: string) {}

    /**
     * RD-F13 — serialize LanceDB compaction (runMaintenance) against live
     * writes. Maintenance rewrites/cleans LanceDB versions on the shared db
     * handle; running it concurrently with an in-flight write can corrupt or
     * lose rows. A simple promise-chain mutex makes maintenance and writes
     * mutually exclusive without blocking concurrent reads.
     */
    private _maintenanceLock: Promise<void> = Promise.resolve();

    /**
     * RC reconciliation — every read tool (call_graph / find_dead_code /
     * blast_radius / hotspots / communities / processes / exportMemory) used to
     * re-materialize the FULL directed edge set from Kùzu on every single call,
     * even when back-to-back tool invocations in the same request burst see an
     * identical graph. listEdges() is memoized per-instance (one EmbeddedLore =
     * one workspace's dataDir) behind `_edgeCacheEpoch`: a cache entry is valid
     * only for the epoch it was built under, and every write that can change the
     * edge set (_storeEdgeUnlocked — single + bulk — and deleteNode, which
     * cascades to a node's edges) bumps the epoch FIRST. This mirrors
     * mcp/loreReader.ts's workspaceEpoch pattern (RC-F2) but scoped to a single
     * instance instead of a module-level map, since one EmbeddedLore already IS
     * one workspace. A cache MISS just re-runs the exact same paginated
     * queryEdges() walk listEdges() always did — no behavior change, no
     * staleness risk: any write bumps the epoch before the next read can
     * observe the old array.
     */
    private _edgeCacheEpoch = 0;
    private _edgeCache: { epoch: number; pageSize: number; edges: Awaited<ReturnType<EmbeddedLore['_listEdgesUncached']>> } | null = null;

    /** Invalidate the cached edge array. Called by every write path that can
     *  add/remove an edge, BEFORE the write is visible to a concurrent reader —
     *  the maintenance lock (which all mutating paths already hold) ensures no
     *  reader can observe a state between the bump and the write landing. */
    private _bumpEdgeEpoch(): void {
        this._edgeCacheEpoch += 1;
        this._edgeCache = null;
    }

    /** Run `fn` with exclusive access against any other lock holder.
     *
     *  `acquireTimeoutMs` bounds ONLY the wait for prior holders to release —
     *  the body still runs to completion once acquired (cutting a RUNNING
     *  body short would reopen the exact interleave this lock exists to
     *  prevent). On acquire-timeout, `fn` NEVER runs and the caller may give
     *  up — but the slot we took stays chained to the abandoned holder: it
     *  resolves only when THAT holder releases, never eagerly, so a holder
     *  enqueued after us still cannot run concurrently with the still-running
     *  one. (Eager release here would let a post-timeout storeNode interleave
     *  with a mid-flight compaction — RD-F13, reintroduced through the back
     *  door.) Omitted by every non-shutdown caller — the normal path is
     *  unchanged. */
    private async _withMaintenanceLock<T>(
        fn: () => Promise<T>,
        opts?: { acquireTimeoutMs?: number },
    ): Promise<T> {
        const prev = this._maintenanceLock;
        let release!: () => void;
        this._maintenanceLock = new Promise<void>((r) => { release = r; });
        let acquired = false;
        try {
            if (opts?.acquireTimeoutMs === undefined) {
                await prev;
                acquired = true;
            } else {
                // prev only ever resolves (release() in the finally) — it can
                // never reject — so this race has exactly one loser: the timer.
                // clearTimeout on win so a fired-and-forgotten timer can never
                // delay process exit; after a timeout the timer has already
                // fired and completed on its own.
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error(`maintenance lock not acquired within ${opts.acquireTimeoutMs}ms`)),
                        opts.acquireTimeoutMs,
                    );
                    void prev.then(() => { clearTimeout(timer); resolve(); });
                });
                acquired = true;
            }
            return await fn();
        } finally {
            if (acquired) release();
            // Timeout path: hold OUR slot until the holder we abandoned
            // releases theirs — the chain stays a real mutex even though this
            // caller has walked away. prev never rejects, so this always
            // resolves eventually (or never — in which case every later
            // holder waits exactly as it would have without a timeout).
            else void prev.then(() => release());
        }
    }

    /**
     * Run `fn` with LORE_DEPLOYMENT_MODE temporarily removed from the env.
     *
     * The substrate already booted with explicit deploymentMode:'embedded', so
     * the resolved mode is 'local'. But Lore's per-tool scope gate
     * (assertMcpScope, null-principal branch) reads process.env.LORE_DEPLOYMENT_MODE
     * DIRECTLY — and Lore's env-scrub allowlist KEEPS that var. So a user who
     * also runs Lore Cloud with LORE_DEPLOYMENT_MODE=cloud exported in their
     * shell would make the in-process MCP loopback (semantic/hybrid search,
     * maintain) fail CLOSED with workspace_forbidden, degrading search to zero
     * results. The in-memory loopback always hits the null-principal branch, so
     * unsetting the var for the duration of the call restores the intended
     * embedded behavior. Snapshot + restore in finally so we don't perturb any
     * concurrent Lore Cloud process inspecting the same env.
     */
    /** Serializes withLocalDeploymentEnv (process-global env mutation). */
    private _envLock: Promise<void> = Promise.resolve();

    private async withLocalDeploymentEnv<T>(fn: () => Promise<T>): Promise<T> {
        // SERIALIZE — mutating process.env is PROCESS-global, so two concurrent
        // holders interleave: A restores LORE_DEPLOYMENT_MODE=cloud while B is
        // still mid-call, and B's scope gate then fails CLOSED (the exact
        // failure this helper exists to prevent). The maintenance lock can't
        // be reused — reads legitimately overlap each other; only the env
        // mutation itself must be exclusive.
        const lockPrev = this._envLock;
        let release!: () => void;
        this._envLock = new Promise<void>((r) => { release = r; });
        await lockPrev;
        try {
            const had = Object.prototype.hasOwnProperty.call(process.env, 'LORE_DEPLOYMENT_MODE');
            const prev = process.env.LORE_DEPLOYMENT_MODE;
            if (had) delete process.env.LORE_DEPLOYMENT_MODE;
            try {
                return await fn();
            } finally {
                if (had) process.env.LORE_DEPLOYMENT_MODE = prev;
            }
        } finally {
            release();
        }
    }

    /** Open (constructing kuzu+lancedb+sqlite) a dedicated Lore at `dataDir`. */
    static async open(dataDir: string): Promise<EmbeddedLore> {
        // Harden BEFORE createLore() touches the filesystem: dataDir holds the
        // full source-code graph (kuzu+lancedb+sqlite) — owner-only. Pre-creating
        // it 0700 means createLore()'s own mkdir (umask-subject, typically 0755)
        // is a no-op on an already-owner-only dir. chmod is authoritative and
        // also hardens an already-existing 0755 dir from before this fix.
        // Best-effort but visible — never crash the daemon over a mode failure.
        try {
            fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        } catch (err) {
            console.error(`[atlas] warning: failed to create embedded Lore dataDir (${dataDir}): ${(err as Error).message}`);
        }
        try {
            fs.chmodSync(dataDir, 0o700);
        } catch (err) {
            console.error(`[atlas] warning: failed to chmod embedded Lore dataDir (${dataDir}) to 0700: ${(err as Error).message}`);
        }

        // device default 'cpu' — MEASURED fastest for the tiny e5-small model on
        // dayjs (cpu 35s vs coreml 69s vs auto 100s): CoreML/GPU compile+transfer
        // overhead dwarfs the gain on a 384-dim model. Override via ATLAS_EMBED_DEVICE
        // for larger models / other platforms where GPU wins. Read before createLore
        // scrubs process.env.
        const device = (process.env.ATLAS_EMBED_DEVICE ?? 'cpu') as 'auto' | 'cpu' | 'coreml' | 'cuda' | 'webgpu';
        // Defense-in-depth belt for arcade-only secrets that Lore's envScrub can
        // leave in process.env on the embedded path. Atlas runs Lore embedded and
        // NEVER enters arcade mode, so it never consumes ANY arcade secret backend;
        // strip these keys BEFORE createLore() runs (its first statement is the
        // scrub) so they never even reach the scrub.
        //   - ARCADE_SECRET_*  : as of Lore 8fcc6e0 (b22b2aa) envScrub now gates
        //     this prefix on LORE_ARCADE_SECRET_BACKEND=env and scrubs it in
        //     embedded mode, so this strip is now REDUNDANT-but-correct (idempotent
        //     defense-in-depth against an older Lore / a future regression).
        //   - LORE_ARCADE_KMS_KEK : the raw base64 slice-5 KEK is on Lore's STATIC
        //     unconditional envScrub allowlist (fc05dbd), so it survives the scrub
        //     even in embedded mode. Its only reader is the arcade KMS store, which
        //     Atlas never reaches and prunes from the bundle — strip it to keep the
        //     post-scrub env surface minimal (S9). Not a reachable exposure, hygiene.
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('ARCADE_SECRET_') || key === 'LORE_ARCADE_KMS_KEK') {
                delete process.env[key];
            }
        }
        const lore = await createLore({ deploymentMode: 'embedded', dataDir, embedding: { device } });
        return new EmbeddedLore(lore, path.basename(dataDir));
    }

    /** LoreClient-compatible: nothing to bootstrap in-process. */
    async connect(): Promise<void> { /* no session/handshake in-process */ }

    /** Closes Kùzu + LanceDB handles deterministically (host-owned lifecycle).
     *  Serialized through the maintenance lock: disposing while a compaction /
     *  retention sweep is mid-flight is exactly the interleave RD-F13's lock
     *  guards writes against (LanceDB version corruption).
     *
     *  SHUTDOWN-WEDGE GUARD — the lock wait is BOUNDED (CLOSE_LOCK_TIMEOUT_MS,
     *  overridable for tests). The lock is a promise-chain mutex released only
     *  when the holder's own promise settles, and a holder's native call
     *  (LanceDB optimize() during a detached post-flush fold, or any write
     *  path's kuzu/lancedb op) can wedge indefinitely — daemon.ts's own
     *  maintenance comment: "in the worst case, wedge the process
     *  indefinitely." An unbounded wait here therefore hangs ALL of shutdown
     *  (closeAllEmbedded has no deadline around close()). On timeout we do
     *  NOT force-dispose — tearing down native handles under a mid-flight
     *  compaction is the RD-F13 corruption itself — we SKIP this workspace's
     *  clean dispose, log loudly, and let the OS reap the handles at process
     *  exit. That is exactly the state a crash mid-compaction already leaves,
     *  which the system is built to survive: verbatim-queue.jsonl replays on
     *  the next start, "[outbox] boot recovery" drains the outbox, and the
     *  next maintenance pass reclaims what an interrupted compaction left.
     *  Restartability outranks a pristine shutdown for this ONE workspace.
     *
     *  @param lockTimeoutMs acquire bound for the maintenance lock; defaults
     *   to CLOSE_LOCK_TIMEOUT_MS. Optional so LoreWriter's close(): Promise<void>
     *   stays satisfied for every existing caller. */
    async close(lockTimeoutMs: number = CLOSE_LOCK_TIMEOUT_MS): Promise<void> {
        try {
            await this._withMaintenanceLock(
                () => this.lore.dispose('atlas close'),
                { acquireTimeoutMs: lockTimeoutMs },
            );
        } catch (err) {
            if (!(err instanceof Error) || !err.message.includes('maintenance lock not acquired')) throw err;
            // Loud by design: this workspace's native handles were NOT cleanly
            // disposed — the lossiest shutdown outcome short of a crash, and
            // invisible unless it's greppable in daemon.err. [atlas] CRITICAL
            // prefix = the "stop and read me" tier this repo reserves for
            // state-losing events.
            console.error(
                `[atlas] CRITICAL: close() for workspace '${this.workspace}' abandoned the maintenance lock ` +
                `after ${lockTimeoutMs}ms — a native compaction/write appears wedged. SKIPPING its clean ` +
                `dispose (never mid-write — that is the RD-F13 corruption interleave); the OS will reap the ` +
                `handles at process exit and the next start's journal replay + outbox boot recovery heal ` +
                `this workspace. Error: ${err.message}`,
            );
        }
    }

    /**
     * Settle ALL pending embeds + verbatim writes so a subsequent read (e.g.
     * getEmbeddings during export) sees the persisted LanceDB rows.
     *
     * Two independent async paths must be drained:
     *
     *  1. embedQueue — `lore.awaitEmbeds()` resolves `embedQueue.drained()`.
     *     Covers asyncEmbed/batch ingests.
     *
     *  2. outbox replicator — single-node `storeNode` routes through the
     *     outbox (nodeUpsert → verbatim.upsert row), and the actual embed +
     *     LanceDB write happens later in the background replicator. In EMBEDDED
     *     mode that replicator is constructed but NEVER started (its loop only
     *     runs in the daemon `main()` entry), so `awaitEmbeds()` alone leaves
     *     the row absent → an empty map → a v1 export. We drive the replicator
     *     to quiescence deterministically with `tickOnce()` (returns the number
     *     of rows processed; 0 means the outbox is drained). The handle lives
     *     on the narrow `_daemon.outboxWiring` surface — underscore-prefixed,
     *     not a stable API, so every hop is defensively optional.
     */
    async awaitEmbeds(): Promise<void> {
        try {
        // Drain the embedQueue first (batch/async embeds).
        await this.lore.awaitEmbeds();
        // Then drive the outbox replicator to quiescence (single-node path).
        const daemon = (this.lore as unknown as {
            _daemon?: {
                outboxWiring?: { replicator?: { tickOnce?: () => Promise<number> } };
            };
        })._daemon;
        const replicator = daemon?.outboxWiring?.replicator;
        if (!replicator || typeof replicator.tickOnce !== 'function') {
            // No replicator to drive — still run the LanceDB visibility settle
            // pass below so a plain embedQueue write is queryable on return.
            await this._settleLanceVisibility();
            return;
        }
        // Loop until a tick processes nothing. Bounded so a pathological,
        // continuously-refilling outbox can't spin forever (export is a
        // one-shot read; the producer is idle).
        const MAX_TICKS = 1000;
        for (let i = 0; i < MAX_TICKS; i++) {
            let processed: number;
            try {
                processed = await replicator.tickOnce();
            } catch {
                // A transient replicator error must not abort export — the
                // unsettled rows simply fall back to re-embed on import.
                return;
            }
            if (!processed || processed <= 0) {
                // Outbox drained. The embedQueue may report drained() BEFORE
                // the freshly-written vector is visible to a LanceDB query (the
                // index-visibility step lands sub-200ms later). Settle that
                // last hop so a store→recall within the same turn sees the row.
                await this._settleLanceVisibility();
                return;
            }
            // A tick that drained the verbatim row may have enqueued the
            // embed onto embedQueue; flush it so the LanceDB vector lands
            // before the next read.
            await this.lore.awaitEmbeds();
        }
        } finally {
            // AUTOLINK EPOCH — Lore's nodeUpsert inserts similarity AUTOLINK
            // edges during embed processing (fire-and-forget reconnectOneNode),
            // and only explicit edge writes/deletes bump _edgeCacheEpoch.
            // awaitEmbeds is the deterministic settle point for that work, so
            // bump here: the memoized listEdges() must not keep serving a
            // pre-autolink edge set (reproduced live: a real autolink edge in
            // the raw graph stayed invisible to listEdges() until an unrelated
            // edge write happened to bump the epoch).
            this._bumpEdgeEpoch();
        }
    }

    /**
     * Bridge the gap between embedQueue.drained() and LanceDB query-visibility.
     *
     * `lore.awaitEmbeds()` resolves when the embed batch has been WRITTEN, but
     * the freshly-stored vector is not yet returned by a LanceDB search for a
     * short window afterwards (~sub-200ms, measured). A naive store→recall in
     * the same turn therefore gets 0 hits intermittently. A SECOND full
     * awaitEmbeds() eliminated the miss in 5/5 runs, so we do that, then poll
     * briefly until the freshest verbatim row is actually searchable.
     *
     * The poll is BOUNDED (~500ms, ~50ms steps) so an idle producer can't spin
     * and a backend without the visibility lag returns on the first check. The
     * probe is the same LanceDB table escape hatch getEmbeddings() uses; any
     * structural mismatch / error degrades gracefully to a fixed short settle
     * (the second awaitEmbeds() above is already enough in the common case).
     */
    private async _settleLanceVisibility(): Promise<void> {
        // Second full drain — empirically sufficient to clear the visibility
        // lag in the common case.
        await this.lore.awaitEmbeds();

        // Reach the lance Table to probe whether ANY row is now searchable.
        const verbatim = this.sc.rawVerbatim() as unknown as {
            table?: { query(): { limit(n: number): { toArray(): Promise<Array<unknown>> } } };
        };
        const table = verbatim?.table;
        if (!table) return; // No vector store yet → nothing to settle.

        const DEADLINE_MS = 500;
        const STEP_MS = 50;
        const start = Date.now();
        for (;;) {
            try {
                const rows = await table.query().limit(1).toArray();
                // A readable row confirms the table is open and serving queries
                // post-write. This is a lightweight liveness bound on the poll;
                // the real fix is the second awaitEmbeds() above (empirically
                // sufficient 5/5). Returning early here at worst falls back to
                // that already-sufficient double drain.
                if (rows.length > 0) return;
            } catch {
                // Probe failed structurally — the second awaitEmbeds() above is
                // the best-effort settle; don't spin on a broken escape hatch.
                return;
            }
            if (Date.now() - start >= DEADLINE_MS) return;
            await new Promise((resolve) => setTimeout(resolve, STEP_MS));
        }
    }

    private get sc(): LoreInstance['store']['storageClient'] {
        return this.lore.store.storageClient;
    }

    /**
     * Bounded retry for transient embedded-graph write conflicts. The in-
     * process Kùzu graph occasionally fails a single upsert/edge under rapid
     * sequential writes (background outbox/audit writers contend with the
     * index batch) — the failure is intermittent and hits a different node
     * each run, so a short backoff clears it. Deterministic failures still
     * surface after the final attempt.
     */
    private async withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (i < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 20 * (i + 1)));
                }
            }
        }
        throw lastErr;
    }

    // ── writes (LoreClient-compatible) ──────────────────────────────────────

    async storeNode(input: StoreNodeInput): Promise<unknown> {
        // RD-F13 — write serialized against maintenance/compaction.
        return this._withMaintenanceLock(() => {
            const { id, type, workspace, embed, ...rest } = input;
            return this.withRetry(() => this.lore.nodeUpsert({
                id,
                workspace: LORE_WORKSPACE,
                ecosystem: CODE_ECOSYSTEM,
                // Groundfloor Atlas embed:false → graph-only write (no LanceDB mirror).
                skipEmbed: embed === false,
                // project = the Groundfloor Atlas workspace so reads scope correctly (F1);
                // the rest (label/content/tags/metadata) passes straight through.
                nodeData: { id, type, project: workspace, ...rest },
            }));
        });
    }

    async storeEdge(input: StoreEdgeInput): Promise<void> {
        // RD-F13 — public entry acquires the maintenance lock; the actual work
        // lives in _storeEdgeUnlocked so bulk paths can hold ONE lock for the
        // whole batch instead of re-acquiring per edge (which would deadlock
        // the promise-chain mutex).
        return this._withMaintenanceLock(() => this._storeEdgeUnlocked(input));
    }

    private async _storeEdgeUnlocked(input: StoreEdgeInput): Promise<void> {
        const edge: Record<string, unknown> = {
            sourceId: input.sourceId,
            targetId: input.targetId,
            relation: input.relation,
        };
        if (input.confidence) edge['confidence'] = input.confidence;
        if (input.confidenceScore !== undefined) edge['confidenceScore'] = input.confidenceScore;
        await this.withRetry(() => this.sc.addEdge(edge as never));
        // G-2 — addEdge's Cypher is `MATCH (a {id}),(b {id}) CREATE ...`; when
        // EITHER endpoint is absent the MATCH yields zero rows, CREATE never
        // fires, and addEdge STILL resolves void with no throw (see
        // groundfloor-lore graphEdges.ts:126-133). That silent no-op is how
        // imported edges used to vanish while edgeCount kept incrementing. Read
        // the row back and throw when it didn't land, so callers
        // (importEdgeLine / loadGroup) record a truthful per-edge error instead
        // of inflating the count. The read uses the same rawGraph().queryEdges
        // escape hatch listEdges() uses, filtered to this exact triple.
        if (!(await this.edgeExists(input.sourceId, input.targetId, input.relation))) {
            throw new Error(`edge endpoint missing: ${input.sourceId}→${input.targetId} (${input.relation})`);
        }
        // RC reconciliation — the edge set just changed; invalidate the
        // listEdges() cache so the next read re-materializes it instead of
        // serving a stale pre-write array. Bumped only after the write is
        // CONFIRMED landed (not on a throw above), and again below if the
        // reverse (bidirectional) edge also lands, so a failed write never
        // needlessly invalidates an otherwise-still-valid cache.
        this._bumpEdgeEpoch();
        if (input.bidirectional) {
            // addBidirectionalEdge isn't on the facade; write the reverse edge.
            await this.withRetry(() => this.sc.addEdge({ ...edge, sourceId: input.targetId, targetId: input.sourceId } as never));
            if (!(await this.edgeExists(input.targetId, input.sourceId, input.relation))) {
                throw new Error(`edge endpoint missing (reverse): ${input.targetId}→${input.sourceId} (${input.relation})`);
            }
            this._bumpEdgeEpoch();
        }
    }

    /**
     * G-2 — does a directed (source → target, relation) edge actually exist in
     * the graph? Used by storeEdge to surface Lore's silent MATCH..CREATE
     * no-op as a real error. Reaches rawGraph().queryEdges (the same runtime
     * escape hatch listEdges() uses) with the optional source/target/relation
     * filters so the read is a single indexed lookup, not a full scan. Returns
     * false defensively on any query error — a verification we can't run must
     * not pass silently.
     */
    async edgeExists(sourceId: string, targetId: string, relation: string): Promise<boolean> {
        const graph = this.sc.rawGraph() as unknown as {
            queryEdges(q: { limit: number; offset: number; source?: string; target?: string; relation?: string }): Promise<
                Array<{ sourceId: string; targetId: string; relation: string }>
            >;
        };
        try {
            const rows = await this.withRetry(() =>
                graph.queryEdges({ limit: 1, offset: 0, source: sourceId, target: targetId, relation }),
            );
            return rows.length > 0;
        } catch {
            return false;
        }
    }

    /**
     * RC reconciliation — edges whose SOURCE is one of `sourceIds`, via the
     * same `queryEdges({source})` escape hatch edgeExists uses (an indexed
     * lookup, not a full scan). Added for exportMemory (cli/memorySync.ts),
     * which used to call the unfiltered listEdges() — pulling the ENTIRE
     * CODE-edge set of the workspace (potentially the whole call/import graph)
     * just to filter down to the handful of edges sourced from knowledge
     * nodes (decision/convention/bug_pattern/troubleshooting/architecture).
     * knowledge_store triggers exportMemory on every write (mirrorKnowledgeBackup
     * in mcp/allTools.ts), so that full pull ran on every knowledge write against
     * a real code-sized workspace.
     *
     * Iterates `sourceIds` (expected to be small — the knowledge-node id set,
     * not the code graph) and paginates each source's edges with the same
     * non-advancing / MAX_PAGES guards listEdges() uses, so a source with an
     * unexpectedly large fan-out still can't spin or exhaust memory. Does NOT
     * go through the listEdges() cache (that cache is keyed on the whole-graph
     * read; a source-filtered query is a different, cheaper shape) — each call
     * is a handful of small indexed lookups, not a full-graph materialization.
     */
    async listEdgesBySource(
        sourceIds: Iterable<string>,
        pageSize = 5000,
    ): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>> {
        const graph = this.sc.rawGraph() as unknown as {
            queryEdges(q: { limit: number; offset: number; source?: string }): Promise<
                Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>
            >;
        };
        const out: Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }> = [];
        const MAX_PAGES_PER_SOURCE = 1000;
        for (const source of sourceIds) {
            let pages = 0;
            let prevFirstKey: string | null = null;
            for (let offset = 0; ; offset += pageSize) {
                if (pages >= MAX_PAGES_PER_SOURCE) {
                    console.error(`[atlas] listEdgesBySource hit MAX_PAGES=${MAX_PAGES_PER_SOURCE} for source=${source}; truncating`);
                    break;
                }
                pages += 1;
                const batch = await this.withRetry(() => graph.queryEdges({ limit: pageSize, offset, source }));
                const first = batch[0];
                const firstKey = first ? `${first.sourceId}|${first.targetId}|${first.relation}` : null;
                if (offset > 0 && firstKey !== null && firstKey === prevFirstKey) break;
                prevFirstKey = firstKey;
                for (const e of batch) out.push(e);
                if (batch.length < pageSize) break;
            }
        }
        return out;
    }

    async bulkStoreNodes(nodes: StoreNodeInput[]): Promise<NodeBulkResult> {
        // Uses lore.bulkIngest (the corrected A6) with autolink:false +
        // embed:'sync' — one embedDocumentBatch, no per-node autolink thrash,
        // vectors persisted before resolve. The earlier nodeUpsertBatch attempt
        // that regressed indexing is documented in docs/PERFORMANCE.md.
        return this._withMaintenanceLock(async () => {
            const batchNodes = nodes.map(({ id, type, workspace, embed, ...rest }) => ({
                id,
                workspace: LORE_WORKSPACE,
                ecosystem: CODE_ECOSYSTEM,
                skipEmbed: embed === false,
                nodeData: { id, type, project: workspace, ...rest },
            }));
            const ingest = await this.withRetry(() => this.lore.bulkIngest(batchNodes, { autolink: false, embed: 'sync' }));
            const results: NodeBulkResult['results'] = ingest.results.map((r) => (
                r.ok ? { ok: true, id: r.id } : { ok: false, id: r.id, error: r.error }
            ));
            return { ok: ingest.ok, count: ingest.count, succeeded: ingest.succeeded, results };
        });
    }

    /**
     * A0 — vectors-included ingest. Pairs each StoreNodeInput with a
     * precomputed embedding vector and routes through lore.bulkIngest's
     * `embed:'precomputed'` mode (Lore commit 3602910). Lore validates the
     * dim per-node; mismatches surface in results[] with
     * `embedding dimension mismatch: got N, model expects M` — the caller
     * (memorySync.importMemory) detects this and falls back to re-embedding
     * those specific ids via bulkStoreNodes(embed:'sync').
     *
     * Semantics otherwise identical to bulkStoreNodes: project=workspace,
     * autolink:false (caller already knows the structure), withRetry wrap
     * for transient Kùzu contention.
     *
     * `nodes[i]` and `vectors[i]` MUST correspond positionally. Mismatched
     * lengths throw — that's a programming error, not a per-node failure.
     */
    async bulkStoreNodesWithVectors(
        nodes: StoreNodeInput[],
        vectors: number[][],
    ): Promise<NodeBulkResult> {
        if (nodes.length !== vectors.length) {
            throw new Error(
                `bulkStoreNodesWithVectors: nodes/vectors length mismatch ` +
                `(nodes=${nodes.length}, vectors=${vectors.length})`,
            );
        }
        return this._withMaintenanceLock(async () => {
            const batchNodes = nodes.map(({ id, type, workspace, embed, ...rest }, i) => ({
                id,
                workspace: LORE_WORKSPACE,
                ecosystem: CODE_ECOSYSTEM,
                skipEmbed: embed === false,
                nodeData: { id, type, project: workspace, ...rest },
                // Lore reads this top-level field when opts.embed === 'precomputed'.
                embedding: vectors[i],
            }));
            const ingest = await this.withRetry(() => this.lore.bulkIngest(batchNodes, { autolink: false, embed: 'precomputed' }));
            const results: NodeBulkResult['results'] = ingest.results.map((r) => (
                r.ok ? { ok: true, id: r.id } : { ok: false, id: r.id, error: r.error }
            ));
            return { ok: ingest.ok, count: ingest.count, succeeded: ingest.succeeded, results };
        });
    }

    async bulkStoreEdges(edges: StoreEdgeInput[]): Promise<EdgeBulkResult> {
        // RD-F13 — hold the maintenance lock ONCE for the whole batch and call
        // the unlocked edge writer per row (re-acquiring would deadlock).
        //
        // RD-X3 (REVERTED): the batch is deliberately NOT atomic. Cross-file
        // edges are inherently forward references — the index pipeline flushes
        // one 50-file batch at a time (nodes then edges), so an `imports`/
        // `calls`/`extends` edge in batch 1 that targets a symbol defined in a
        // later batch's file legitimately hits `_storeEdgeUnlocked`'s
        // `edge endpoint missing` throw at batch-1 flush time. The previous
        // all-or-nothing rollback turned that single tolerable dangling edge
        // into BATCH-WIDE edge loss (every edge → `batch rolled back`),
        // silently under-populating the call/import graph that is the product's
        // core value. We restore the per-item contract that BatchWriter and the
        // single-file tryEdge path already rely on: a failed edge is reported as
        // `{ok:false, error}` and the batch CONTINUES, so valid edges land.
        return this._withMaintenanceLock(async () => {
            const results: EdgeBulkResult['results'] = [];
            let succeeded = 0;
            for (const e of edges) {
                try {
                    await this._storeEdgeUnlocked(e);
                    results.push({ ok: true });
                    succeeded++;
                } catch (err) {
                    results.push({ ok: false, error: (err as Error).message });
                }
            }
            return { ok: succeeded === edges.length, count: edges.length, succeeded, results };
        });
    }

    // ── reads (for loreReader) ──────────────────────────────────────────────

    async getNode(id: string): Promise<unknown> {
        return this.sc.getNode(id);
    }

    /**
     * List nodes by type/tag/project. Defaults to the unbounded path when no
     * explicit limit is given — the in-process cap is 10k (vs the daemon's
     * 1,000) and full enumeration is allowed.
     */
    async listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]> {
        // No ecosystem filter — a dedicated instance is all code, and the
        // stored ecosystem isn't what callers scope on (they use type+project).
        return this.sc.listNodes(
            type, tag, project, undefined, limit,
            limit ? undefined : { unbounded: true },
        );
    }

    /**
     * Native call-graph / blast-radius traversal: BFS from `nodeId` returning
     * inbound AND outbound neighbors with their relation. Replaces the HTTP
     * file→symbol neighbor recovery loreReader had to hand-roll.
     */
    async traverse(nodeId: string, depth = 1): Promise<unknown[]> {
        return this.sc.rawGraph().traverse(nodeId, depth);
    }

    /**
     * Distinct `n.project` values across every node in this store. Used by
     * the stats snapshot so the workspace list can show which indexed
     * projects a workspace contains without opening/scanning the store per
     * call. `n.project` holds the indexed workspace/project name (see
     * storeNode: `project: workspace`). Rows with a null/empty project are
     * dropped.
     *
     * Kùzu-backed stores: ONE Cypher DISTINCT aggregation via
     * getGraphContext().queryRows — the same rawGraph() escape hatch
     * queryEdges/getEmbeddings use (cheap, same cost profile as getStats'
     * count()).
     *
     * Non-Kùzu stores (e.g. `graphEngine: 'surreal'` in workspaces.json —
     * see groundfloor-lore's graphEngineSelector.js): getGraphContext is one
     * of the Kùzu-only ops loreStorageClient.js's facade deliberately never
     * wraps ("remain reachable via the rawGraph() escape hatch until a
     * follow-up sprint expands the facade further"), and SurrealGraph simply
     * doesn't implement it — checked up front (not try/catch) so a genuine
     * Cypher failure on a real Kùzu store still throws instead of being
     * mistaken for an engine mismatch. Falls back to the engine-agnostic
     * listNodes() facade method (unbounded) and dedupes `project`
     * client-side — a full scan is more expensive than the single DISTINCT
     * query, but every engine's graph class implements listNodes, so this
     * actually restores the stats snapshot on a surreal-backed workspace
     * instead of merely failing more legibly. Same unbounded-listNodes heap
     * cost the H1 scalability finding warns about (recall-scalability-
     * consistency-sweep-oom-nonactive-workspace-scan-2026-07-02) — acceptable
     * here because both callers (atlas_index's end-of-run snapshot,
     * workspace_status's lazy snapshot) are per-workspace and on-demand, not
     * a scheduled sweep; don't wire this fallback into anything recurring
     * without chunking it first.
     */
    async distinctProjects(): Promise<string[]> {
        const graph = this.sc.rawGraph() as unknown as {
            getGraphContext?(): { queryRows(cypher: string): Promise<Array<Record<string, unknown>>> };
        };
        if (typeof graph.getGraphContext === 'function') {
            const rows = await this.withRetry(() =>
                graph.getGraphContext!().queryRows(
                    'MATCH (n:LoreNode) WHERE n.project IS NOT NULL AND n.project <> "" RETURN DISTINCT n.project AS project',
                ),
            );
            return rows
                .map((r) => (typeof r.project === 'string' ? r.project : null))
                .filter((p): p is string => p !== null && p.length > 0);
        }
        const nodes = (await this.listNodes()) as Array<Record<string, unknown>>;
        const projects = new Set<string>();
        for (const n of nodes) {
            const p = n.project;
            if (typeof p === 'string' && p.length > 0) projects.add(p);
        }
        return [...projects];
    }

    /**
     * A0 — bulk-fetch precomputed embedding vectors for a set of node ids.
     *
     * Returns `Map<nodeId, number[]>` — ids without a stored vector (e.g. a
     * `embed:false` graph-only node) are simply absent. Used by
     * exportMemory to bundle vectors into `.atlas/memory.jsonl` so a
     * teammate's first clone imports vectors directly instead of paying
     * the re-embed cost (~5min → ~5sec on a medium repo).
     *
     * Implementation note: there is no public `LoreStorageClient` method to
     * fetch a stored vector by id (getById returns only contentHash+text).
     * The lance table itself lives on the concrete VerbatimStore behind
     * rawVerbatim() — structurally accessible at runtime even though the
     * typed VectorProvider surface doesn't expose it. Same escape-hatch
     * pattern as rawGraph().queryEdges above.
     *
     * Verbatim ids are prefixed `lore:<nodeId>` (Lore convention — see
     * bulkIngest.js:146). Lookups use `id IN (...)` chunks (mirroring
     * verbatim's own bulkLookupByContentHash chunking) so a large export
     * resolves in ceil(N/CHUNK) scans, not N.
     */
    async getEmbeddings(nodeIds: string[]): Promise<Map<string, number[]>> {
        const out = new Map<string, number[]>();
        if (nodeIds.length === 0) return out;

        // rawVerbatim() returns LoreVectorHandle (VectorProvider) by type
        // but at runtime is the concrete VerbatimStore. Structural cast so
        // we can reach the lance Table handle without `as never`.
        const verbatim = this.sc.rawVerbatim() as unknown as {
            table?: {
                query(): {
                    where(predicate: string): {
                        toArray(): Promise<Array<Record<string, unknown>>>;
                    };
                };
            };
        };
        const table = verbatim.table;
        // Table not initialized → no vectors stored yet. Caller should fall
        // through to the re-embed path; we don't throw.
        if (!table) return out;

        // Map prefixed id → original id for the response.
        const prefixed = nodeIds.map((id) => ({ raw: id, prefixed: `lore:${id}` }));
        const byPrefixed = new Map(prefixed.map((p) => [p.prefixed, p.raw] as const));

        const CHUNK = 500;
        for (let i = 0; i < prefixed.length; i += CHUNK) {
            const slice = prefixed.slice(i, i + CHUNK);
            // Escape single quotes to keep the IN(...) predicate safe.
            const inList = slice.map((p) => `'${p.prefixed.replace(/'/g, "''")}'`).join(', ');
            const predicate = `id IN (${inList})`;
            let rows: Array<Record<string, unknown>>;
            try {
                rows = await this.withRetry(() => table.query().where(predicate).toArray());
            } catch {
                // Defensive: a malformed row or transient lance error should
                // not corrupt the export — the unfetched ids fall back to
                // re-embed on import.
                continue;
            }
            for (const r of rows) {
                const rowId = typeof r['id'] === 'string' ? r['id'] : undefined;
                if (!rowId) continue;
                const original = byPrefixed.get(rowId);
                if (!original) continue;
                const vec = r['vector'];
                if (!vec) continue;
                // LanceDB returns vectors as Arrow Float32Array-backed
                // structures; coerce to plain number[] (same fix verbatim
                // store applies in toPlainVector — Arrow nullable sentinels
                // confuse JSON.stringify).
                const plain = toPlainVector(vec);
                if (plain.length === 0) continue;
                // Belt: never surface a NaN / non-finite vector. If a read
                // ever yields garbage (e.g. an Arrow coercion regression or an
                // unsettled row), drop it so export emits NO embedding for this
                // node — it cleanly re-embeds on import (same as v1) instead of
                // poisoning the v2 fast path with `[null, ...]`.
                if (!plain.every((x) => Number.isFinite(x))) continue;
                out.set(original, plain);
            }
        }
        return out;
    }

    /**
     * All directed code edges, paginated. Uses the rawGraph() escape hatch's
     * queryEdges — present on the embedded LocalGraph at runtime though not on
     * the typed LoreGraphHandle (queryEdges lives on GraphProvider's concrete
     * impl). Edges are DIRECTED (sourceId→targetId), so reconstructing the
     * call graph needs no '←'-prefix de-duplication the HTTP neighbor path did,
     * and no per-symbol traverse fan-out (which would merge in/out and invert).
     *
     * RC reconciliation — memoized per-instance (see `_edgeCache` /
     * `_edgeCacheEpoch` above). Every read tool (call_graph, find_dead_code,
     * blast_radius, hotspots, communities, processes, exportMemory, …) used to
     * pay this full paginated Kùzu walk on EVERY invocation, even back-to-back
     * within the same request burst against an unchanged graph. A cache hit
     * returns the exact same array a fresh call would have produced (no
     * slicing, no staleness) — any write that changes the edge set bumps the
     * epoch BEFORE the write is visible (see _storeEdgeUnlocked / deleteNode),
     * so a hit can never serve pre-write data after a re-index or edit.
     * Different `pageSize` callers bypass the cache (extremely rare in
     * practice — every real caller uses the default) rather than risk serving
     * a result built under a different pagination stride.
     */
    async listEdges(pageSize = 5000): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>> {
        const cached = this._edgeCache;
        if (cached && cached.epoch === this._edgeCacheEpoch && cached.pageSize === pageSize) {
            return cached.edges;
        }
        // Snapshot the epoch we're reading UNDER before the (possibly slow)
        // fetch. If a write races this read and bumps the epoch mid-flight, the
        // cache we store below is keyed to the OLD (now-stale) epoch number, so
        // the very next call's `cached.epoch === this._edgeCacheEpoch` check
        // naturally misses and refetches — a racing write can never get
        // shadowed by a cache entry that looks fresh but isn't.
        const epochAtStart = this._edgeCacheEpoch;
        const edges = await this._listEdgesUncached(pageSize);
        this._edgeCache = { epoch: epochAtStart, pageSize, edges };
        return edges;
    }

    /** The actual paginated Kùzu walk — unchanged from the pre-cache
     *  implementation. Extracted so listEdges() can memoize its result. */
    private async _listEdgesUncached(pageSize: number): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>> {
        // GF-1 — Lore's queryEdges RETURNS confidence/confidenceScore at runtime
        // (graphEdges.ts:58-68 selects e.confidence / e.confidenceScore with an
        // 'extracted'/1.0 fallback). The old structural cast under-typed the rows
        // to {sourceId,targetId,relation}, so TS-shaped consumers (subgraph viz)
        // never saw the per-edge confidence even though it was on the wire. Widen
        // the cast + the out/return type so the existing out.push(...batch) carries
        // the fields straight through — pure pass-through, no logic change.
        const graph = this.sc.rawGraph() as unknown as {
            queryEdges(q: { limit: number; offset: number }): Promise<
                Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>
            >;
        };
        const out: Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }> = [];
        // RD-MlistEdges — bound the pagination so a backend that keeps returning
        // full pages (or silently ignores offset → identical rows forever)
        // cannot spin indefinitely / exhaust memory.
        const MAX_PAGES = 1000;
        let pages = 0;
        let prevFirstKey: string | null = null;
        for (let offset = 0; ; offset += pageSize) {
            if (pages >= MAX_PAGES) {
                console.error(`[atlas] listEdges hit MAX_PAGES=${MAX_PAGES} (pageSize=${pageSize}); truncating`);
                break;
            }
            pages += 1;
            const batch = await this.withRetry(() => graph.queryEdges({ limit: pageSize, offset }));
            // Non-advancing guard: a backend that ignores `offset` returns the
            // SAME first row every page — detect and stop rather than loop.
            const first = batch[0];
            const firstKey = first ? `${first.sourceId}|${first.targetId}|${first.relation}` : null;
            if (offset > 0 && firstKey !== null && firstKey === prevFirstKey) break;
            prevFirstKey = firstKey;
            for (const e of batch) out.push(e);
            if (batch.length < pageSize) break;
        }
        return out;
    }

    /**
     * RD-status-oom — cheap graph cardinality via real Cypher `count()`
     * aggregation (Lore's graphStats.ts), NOT full enumeration. Added so
     * workspace_status stops calling listNodes/listEdges just to measure
     * `.length` — materializing every node's full content + every edge into
     * JS objects to report a COUNT OOM-crashed the daemon outright against a
     * real-sized workspace (V8 FatalProcessOutOfMemory converting the native
     * Kuzu result set). getStats never touches per-node content at all.
     */
    async getStats(projectFilter?: string): Promise<{ nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> }> {
        return this.sc.getStats(projectFilter);
    }

    // ── knowledge recall / search (P2: in-process, no HTTP, no token) ────────

    /**
     * Semantic recall — Lore's hybrid (vector + BM25 + graph traversal) recall
     * pipeline, in-process. Queries this dedicated instance's built-in
     * 'default' workspace (one dataDir = one project, so no project filter is
     * needed on the query itself). The outbound `scope` field is overridden
     * with `this.workspace` rather than the underlying engine's response —
     * that response always echoes the internal 'default' placeholder it was
     * called with, which would misreport scope to any caller that (rightly)
     * treats it as ground truth. Returns Lore's typed RecallResult. Structural
     * cast: recall() is a first-class LoreInstance method at runtime (Lore P2)
     * but we avoid pinning the exact exported opts type here.
     */
    async recall(topic: string, opts: { depth?: number; max?: number; includeSuperseded?: boolean; mode?: 'summary' | 'full' } = {}): Promise<unknown> {
        // Over-fetch so the type re-rank can promote curated knowledge that
        // would otherwise fall outside the user's top-K. Lore ranks by raw
        // score and truncates BEFORE we see the hits, so re-ranking the slice
        // alone is not enough — at small limits the decision/convention can
        // be missing from the input entirely. Pull 5x (capped at 100) and
        // slice back to userMax after re-rank.
        //
        // mode:'full' is REQUIRED here: summary-mode caps the response at
        // SUMMARY_MAX_HITS (10) regardless of `max`, so the over-fetched pool
        // would be invisible to the re-rank. Full-mode returns up to `max`
        // candidates in `knowledge`, which we then re-rank and project back
        // into Groundfloor Atlas's outbound `hits` envelope so downstream callers (MCP
        // knowledge_recall handler, bench retrievers) see the same shape.
        const userMax = opts.max ?? 10;
        const includeSuperseded = opts.includeSuperseded ?? false;
        // OUTPUT mode (caller-facing): 'summary' (default) returns title + a
        // bounded content SNIPPET; 'full' returns complete node content. This is
        // independent of the INTERNAL mode:'full' below, which is always 'full'
        // so the over-fetch pool is visible to the re-rank.
        const outMode: 'summary' | 'full' = opts.mode ?? 'summary';
        const internalMax = Math.min(userMax * 5, 100);
        const result = await (this.lore as unknown as {
            recall(topic: string, o: { workspace: string; ecosystem?: string; depth?: number; includeSuperseded?: boolean; max?: number; mode?: 'summary' | 'full' }): Promise<unknown>;
        }).recall(topic, { workspace: LORE_WORKSPACE, ecosystem: '*', depth: opts.depth, includeSuperseded, max: internalMax, mode: 'full' });

        // Full-mode shape: { topic, mode:'full', scope, totalRecalled,
        // directMatches, connectedMatches, knowledge: RecallNode[], ... }.
        // No `hits`, no `shown` — we map `knowledge` → `hits` and synthesize
        // `shown` so the outbound envelope matches what summary-mode callers
        // were already consuming.
        const r = result as {
            topic?: string;
            mode?: string;
            scope?: unknown;
            totalRecalled?: number;
            knowledge?: Array<{ id: string; type?: string; label?: string; content?: string; tags?: string | string[]; project?: string; source?: string; language?: string | null }>;
        } | null;

        if (!r || !Array.isArray(r.knowledge) || r.knowledge.length === 0) {
            // Preserve the outbound envelope even on empty: callers expect
            // hits:[] / shown:0, not knowledge:[].
            return {
                topic: r?.topic ?? topic,
                mode: outMode,
                scope: { workspace: this.workspace, ecosystem: '*' },
                totalRecalled: r?.totalRecalled ?? 0,
                shown: 0,
                hits: [],
            };
        }

        // Defensive superseded filter: the in-process recall currently surfaces
        // soft-superseded nodes even with includeSuperseded:false, so drop any
        // hit whose node carries supersededAt. getNode is in-process (cheap, no
        // HTTP) and recall hits are top-K. Tracked as a Lore recall follow-up.
        // SKIPPED when the caller asked includeSuperseded:true — they explicitly
        // want the soft-deleted nodes (knowledge_recall advertises this).
        let kept: typeof r.knowledge = [];
        if (includeSuperseded) {
            kept = r.knowledge;
        } else {
            for (const h of r.knowledge) {
                // undefined = lookup FAILED (transient error — don't hide
                // results); null = node is GONE from the graph (hard-deleted,
                // e.g. an orphaned vector row) — must be dropped, not kept.
                const node = await this.sc.getNode(h.id).catch(() => undefined) as { supersededAt?: string | null } | null | undefined;
                if (node === undefined) { kept.push(h); continue; }
                if (node && !node.supersededAt) kept.push(h);
            }
        }
        // Tombstone exclusion — unconditional, including includeSuperseded:true.
        // A tombstone (knowledge_retract's per-workspace sink node) is stored
        // embed:false, which was assumed sufficient to keep it out of recall —
        // but recall is hybrid (semantic + keyword), and embed:false only
        // removes the semantic half. Its own literal content ("Sink node for
        // retracted knowledge in this workspace...") can still keyword-match a
        // query about retraction/tombstones, and the superseded-filter above is
        // skipped entirely when includeSuperseded is true (a real superseded
        // node is supposed to surface there — a tombstone never should, since
        // it isn't knowledge, it's Atlas's own bookkeeping anchor).
        //
        // Compare against EACH hit's own `project` field (storeNode stamps the
        // caller's `workspace` there — see storeNode above), NOT this.workspace.
        // The two normally coincide (one Lore data dir per Atlas workspace), but
        // are not required to — recall's `workspace` param to the underlying
        // Lore call is a fixed LORE_WORKSPACE constant, not per-Atlas-workspace,
        // so a single instance's results can carry hits scoped to whatever
        // `project` each node was actually stored under. Falls back to
        // this.workspace only when a hit has no project (defensive, not the
        // expected path — every write threads project through).
        kept = kept.filter((h) => h.id !== tombstoneIdFor(h.project ?? this.workspace));
        const dropped = r.knowledge.length - kept.length;
        let totalRecalled = typeof r.totalRecalled === 'number' ? r.totalRecalled : kept.length;
        if (dropped > 0) totalRecalled = Math.max(0, totalRecalled - dropped);

        // Knowledge-type re-rank: surface curated knowledge above auto-generated
        // code_context in MIXED workspaces. Pure reorder — scores untouched, stable
        // within each tier. No-op when all hits share a tier (e.g. type-filtered).
        // Re-rank operates on the over-fetched set so curated items at
        // ranks 6..internalMax can be promoted INTO the final top-userMax.
        kept = reRankByType(kept);

        // Slice to the user's requested size AFTER re-rank. totalRecalled
        // stays as Lore reported it (minus superseded) — it represents
        // what matched, not what we returned. shown reflects the slice.
        if (kept.length > userMax) kept = kept.slice(0, userMax);

        // OUTPUT mode projection: summary returns a bounded content snippet
        // (titles + snippets, per the knowledge_recall schema); full returns
        // complete content untouched. Non-destructive — copy each hit.
        const projected = outMode === 'full' ? kept : kept.map((h) => snippetHit(h));

        return {
            topic: r.topic ?? topic,
            mode: outMode,
            scope: { workspace: this.workspace, ecosystem: '*' },
            totalRecalled,
            shown: projected.length,
            hits: projected,
        };
    }

    /**
     * Vector + keyword search over knowledge nodes, optionally filtered by type.
     *
     * Two execution paths:
     *   - search_mode undefined OR 'keyword' → fast-path through
     *     storageClient.search() (Kùzu CONTAINS scan). storageClient.search
     *     signature: (query, limit, project, ecosystem). Scope by PROJECT
     *     (the Groundfloor Atlas workspace stamped on writes), NOT the Lore workspace
     *     (passing 'default' here was the original bug that returned []).
     *   - search_mode 'semantic' OR 'hybrid' → loopback through Lore's MCP
     *     `search` tool via an in-memory MCP pair (same pattern as
     *     runMaintenance below). Lore's tool, fixed in 84d65e1, is what
     *     actually queries LanceDB vectors and merges with the keyword
     *     index. Going through the tool means Groundfloor Atlas inherits any future
     *     Lore search improvements with zero code change here.
     *
     * Return shape:
     *   - keyword/undefined: bare array of node objects (preserves the
     *     pre-existing contract — older internal callers still work).
     *   - semantic/hybrid: the parsed Lore envelope
     *     `{ query, scope, resultCount, results, _meta, ... }` so MCP
     *     clients see exactly what Lore's own searchTool produces.
     *
     * Both paths drop nodes carrying supersededAt (defensive — mirrors the
     * recall() filter above so the soft-delete contract is consistent
     * across all read paths).
     */
    async search(
        query: string,
        limit = 20,
        type?: string,
        project?: string,
        search_mode?: 'keyword' | 'semantic' | 'hybrid',
    ): Promise<unknown> {
        // Fast-path: no mode (legacy callers) or explicit keyword → direct
        // storageClient call, no MCP loopback overhead.
        if (!search_mode || search_mode === 'keyword') {
            const hits = await this.sc.search(query, limit, project, undefined) as unknown as Array<{ type?: string; id?: string; supersededAt?: string | null }>;
            const live = hits.filter((n) => !n.supersededAt);
            return type ? live.filter((n) => n.type === type) : live;
        }

        // Loopback path: route 'semantic' / 'hybrid' through Lore's own MCP
        // searchTool so the LanceDB vector path actually runs. The embedded
        // instance owns its workspace ('default'), so that's what we pass.
        //
        // Over-fetch so the type re-rank can promote curated knowledge that
        // would otherwise fall outside the user's top-K. Lore truncates BEFORE
        // we see the results, so re-ranking the returned slice alone misses
        // curated hits below the cut. Request 5x (cap 100), re-rank, slice.
        const internalLimit = Math.min(limit * 5, 100);
        // Neutralize a stray LORE_DEPLOYMENT_MODE=cloud in the shell env: the
        // substrate already booted 'embedded', but the per-tool scope gate reads
        // the raw env var and would otherwise fail this loopback CLOSED.
        return this.withLocalDeploymentEnv(async () => {
        const server = this.lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'atlas-search', version: '0.0.0' }, { capabilities: {} });
        try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const res = await client.callTool({
                name: 'search',
                arguments: {
                    query,
                    limit: internalLimit,
                    workspace: LORE_WORKSPACE,
                    search_mode,
                },
            });

            // Lore's tool returns { content: [{type:'text', text: JSON.stringify(envelope)}] }.
            const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
            const textBlock = content.find((c) => c.type === 'text' && typeof c.text === 'string');
            if (!textBlock?.text) {
                return { query, resultCount: 0, results: [], _meta: { confidence: 0, sources_consulted: 0, error: 'empty_response' } };
            }
            let envelope: {
                query?: string;
                scope?: unknown;
                resultCount?: number;
                results?: Array<{ id: string; type?: string; label?: string; content?: string; tags?: string | string[]; project?: string; language?: string | null }>;
                _meta?: unknown;
                error?: string;
            };
            try {
                envelope = JSON.parse(textBlock.text);
            } catch {
                // Lore returned a raw error string (e.g. "Error: ...").
                return { query, resultCount: 0, results: [], _meta: { confidence: 0, sources_consulted: 0, error: 'parse_failed', raw: textBlock.text } };
            }

            // Optional client-side type filter — keep parity with the keyword
            // fast-path so MCP clients can narrow without a second hop.
            let results = envelope.results ?? [];
            if (type) results = results.filter((n) => n.type === type);

            // Defensive supersededAt filter. The MCP tool's projected fields
            // don't include supersededAt, so check getNode for each hit.
            // Hits are top-K, so this is a cheap fan-out (no HTTP).
            if (results.length > 0) {
                const live: typeof results = [];
                for (const hit of results) {
                    // undefined = lookup failed (keep); null = graph-deleted
                    // (drop — same inverted-filter fix as the recall path).
                    const node = await this.sc.getNode(hit.id).catch(() => undefined) as { supersededAt?: string | null } | null | undefined;
                    if (node === undefined) { live.push(hit); continue; }
                    if (node && !node.supersededAt) live.push(hit);
                }
                results = live;
            }

            // Knowledge-type re-rank: surface curated knowledge above auto-generated
            // code_context in MIXED workspaces. Pure reorder — scores untouched, stable
            // within each tier. No-op when all hits share a tier (e.g. type-filtered).
            // Re-rank operates on the over-fetched set so curated items at
            // ranks limit+1..internalLimit can be promoted INTO the final top-limit.
            results = reRankByType(results);

            // Slice to the user's requested limit AFTER re-rank. resultCount
            // reflects what we actually return (honesty in the envelope).
            if (results.length > limit) results = results.slice(0, limit);

            return {
                ...envelope,
                results,
                resultCount: results.length,
            };
        } finally {
            await client.close().catch(() => undefined);
            await server.close().catch(() => undefined);
        }
        });
    }

    /** Soft-supersede oldId with newId (audit trail preserved), in-process. */
    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<unknown> {
        // Through the maintenance lock like every other mutating path — a bare
        // call could interleave with a maintenance compaction/retention sweep
        // (the interleave RD-F13's lock exists to prevent).
        return this._withMaintenanceLock(() =>
            this.withRetry(() => this.sc.supersedeNode(oldId, newId, reason)));
    }

    /**
     * Hard-delete a node by id, in-process. Unlike supersedeNode (a soft
     * tombstone that keeps the audit trail), this removes the node outright —
     * used to purge stray/test nodes that should never have been stored.
     *
     * Two substrates hold a node, so we clear both via the storageClient's
     * rawGraph()/rawVerbatim() escape hatch (the facade routes destructive ops
     * there, per loreStorageClient.ts):
     *   1. rawGraph().deleteNode — removes the graph node AND all its edges
     *      (both directions). Returns false if the id was already absent.
     *   2. rawVerbatim().delete — tombstones the LanceDB vector/text row so the
     *      node stops surfacing in recall's vector search. Best-effort: a graph
     *      node written with embed:false has no verbatim row, so an absent row
     *      is not an error — the graph delete is the source of truth.
     * Serialized under the maintenance lock so it can't interleave with a
     * concurrent upsert of the same id (localGraph serializes per-id too).
     */
    async deleteNode(id: string): Promise<{ ok: boolean; deleted: boolean }> {
        return this._withMaintenanceLock(async () => {
            const graph = this.sc.rawGraph() as unknown as { deleteNode(id: string): Promise<boolean> };
            const deleted = await this.withRetry(() => graph.deleteNode(id));
            // RC reconciliation — deleteNode cascades to remove ALL of this
            // node's edges (both directions, per the doc comment above); the
            // cached edge array is stale the instant this returns true.
            if (deleted) this._bumpEdgeEpoch();
            try {
                const vec = this.sc.rawVerbatim() as unknown as {
                    delete(id: string): Promise<void>;
                    physicalDelete?(id: string): Promise<void>;
                };
                // Verbatim rows are keyed `lore:<nodeId>` (Lore's nodeService/
                // bulkIngest write them that way; getEmbeddings reads them that
                // way) — the old bare-id delete silently matched zero rows.
                // And delete() is only a TOMBSTONE (keeps the vector for
                // history): a graph-deleted node's embedding must be HARD-
                // deleted or semantic search keeps matching the orphan
                // (physicalDelete — the same purge Lore's orphan sweeper uses).
                if (typeof vec.physicalDelete === 'function') {
                    await this.withRetry(() => vec.physicalDelete!(`lore:${id}`));
                } else {
                    await this.withRetry(() => vec.delete(`lore:${id}`));
                }
            } catch {
                // No verbatim/vector row for this id (embed:false node, or already
                // purged) — the graph delete above is authoritative.
            }
            return { ok: true, deleted };
        });
    }

    /**
     * RC #2 — reconcile a repo's file-derived code nodes after a FULL index:
     * delete any `code_file` / `code_symbol` / `code_context` node scoped to
     * `repo` (its id is `<prefix><repo>/…`) whose id is NOT in `liveNodeIds`
     * (the exact set the fresh index just wrote). This purges nodes for files
     * that were DELETED or RENAMED since the last index — otherwise their nodes
     * (and, via the cascading graph delete, their edges) linger forever as
     * phantom callers/callees in call_graph / blast_radius / fullgraph.
     *
     * SCOPING (critical): only nodes whose id begins `<prefix>${repo}/` are
     * considered, so a workspace holding MULTIPLE repos never has its OTHER
     * repos touched. `code_folder` and `code_import` are intentionally excluded:
     * folders are derived from the live set (a surviving sibling file keeps the
     * dir alive) and import nodes are shared, repo-unqualified identities — both
     * are safely idempotent under upsert and must not be repo-prefix-swept.
     *
     * Returns the ids it deleted. Best-effort per node (a failed delete is
     * logged via the returned `errors`, never throws the whole reconcile).
     */
    async reconcileRepoFiles(
        workspace: string,
        repo: string,
        liveNodeIds: Set<string>,
    ): Promise<{ deleted: string[]; errors: Array<{ id: string; error: string }> }> {
        const deleted: string[] = [];
        const errors: Array<{ id: string; error: string }> = [];
        // File-derived code node types, by their id prefix. code-context-sym: is a
        // sub-prefix of code-context: only textually — list it explicitly so the
        // startsWith check below is exact.
        const FILE_SCOPED_PREFIXES = [
            'code-file:',
            'code-symbol:',
            'code-context:',
            'code-context-sym:',
        ];
        // Enumerate this workspace's nodes once (unbounded — the in-process cap is
        // generous and a full index already holds the whole repo in memory).
        const rows = await this.listNodes(undefined, undefined, workspace) as Array<{ id?: string }>;
        for (const n of rows) {
            const id = n.id;
            if (typeof id !== 'string') continue;
            const prefix = FILE_SCOPED_PREFIXES.find((p) => id.startsWith(p));
            if (!prefix) continue; // not a file-derived code node (folder/import/knowledge)
            // Scope to THIS repo: the qualified id is `<prefix><repo>/<rest>`.
            if (!id.startsWith(`${prefix}${repo}/`)) continue;
            if (liveNodeIds.has(id)) continue; // still present in the fresh index
            try {
                await this.deleteNode(id);
                deleted.push(id);
            } catch (err) {
                errors.push({ id, error: (err as Error).message });
            }
        }
        return { deleted, errors };
    }

    // ── maintenance (E3) ────────────────────────────────────────────────────

    /**
     * Run Lore's storage maintenance (LanceDB compaction + version cleanup +
     * retention) in-process. Embedded mode gates Lore's own auto-sweep timers
     * OFF (the daemon would normally drive them), so Groundfloor Atlas owns the schedule.
     *
     * Implemented via an in-memory MCP loopback to the embedded instance's own
     * `maintain` tool — the same contract scripts/lore-maintain.mjs uses over
     * HTTP, but with no port/token. `cutoff` MUST carry a unit ('15m'); a bare
     * integer means DAYS. The 7-day default never reclaims same-day churn, so
     * we pass a short window that still clears LanceDB's ~10-min grace period.
     * The loopback call carries an explicit 120s timeout (see below) so slow
     * but healthy passes do not die as spurious -32001s at the SDK's 60s
     * default.
     */
    async runMaintenance(opts: { dryRun?: boolean; cutoff?: string } = {}): Promise<unknown> {
        // RD-F13 — hold the maintenance lock for the WHOLE compaction so no
        // write interleaves with the LanceDB version rewrite.
        return this._withMaintenanceLock(async () => {
            const { dryRun = false, cutoff = '15m' } = opts;
            // Neutralize a stray LORE_DEPLOYMENT_MODE=cloud in the shell env so
            // the in-process `maintain` tool's scope gate doesn't fail CLOSED —
            // the substrate already booted 'embedded' (see withLocalDeploymentEnv).
            return this.withLocalDeploymentEnv(async () => {
                const server = this.lore.createMcpServer();
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: 'atlas-maintain', version: '0.0.0' }, { capabilities: {} });
                try {
                    await server.connect(serverTransport);
                    await client.connect(clientTransport);
                    // Explicit timeout: the SDK's 60s default rejected
                    // legitimately-slow passes as spurious -32001s (observed
                    // live on a 450-fragment table, 2026-08-27) while the
                    // server-side tool kept running — the daemon ticker's
                    // error log filled with noise and callers lost the
                    // result. 120s = 2× the old default, comfortably above
                    // the fold trigger's 30s patience window; genuinely
                    // wedged passes still surface at the cap.
                    return await client.callTool({
                        name: 'maintain',
                        arguments: { dry_run: dryRun, cleanup_versions_older_than: cutoff },
                    }, undefined, { timeout: 120_000 });
                } finally {
                    await client.close().catch(() => undefined);
                    await server.close().catch(() => undefined);
                }
            });
        });
    }
}
