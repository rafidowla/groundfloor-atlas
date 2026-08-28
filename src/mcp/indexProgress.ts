/**
 * mcp/indexProgress.ts — process-level live index progress registry.
 *
 * Sprint 4. The daemon runs an index in-process via the SHARED per-workspace
 * EmbeddedLore (see embeddedRegistry.ts); `atlas_index`'s HTTP call blocks for
 * the whole parse→write run and returns only TERMINAL counts. To surface LIVE
 * progress while that run is in flight, the indexer publishes here and the
 * `index_status` MCP tool reads here — same process, same lifetime as
 * `embeddedRegistry`'s instance map, so a poll from a sibling MCP call sees the
 * running indexer's progress with no IPC.
 *
 * HONESTY CONTRACT (see Sprint 4 diagnosis §2): the only genuinely observable,
 * monotonic signal for the code index is phase + filesDone/filesTotal plus the
 * running nodesWritten/edgesWritten totals — every number here traces to a value
 * the indexer already computes (`parseRepo().files.length` up front, then
 * `BatchWriter`'s flush totals). Code nodes are written `embed:false`, so there
 * is NO per-node embedding bar to show; `embedsPending` is OPTIONAL and only set
 * when the context layer is on, and it carries NO fabricated denominator.
 */

/** Index lifecycle phase for a workspace. `idle` = never run / nothing live. */
export type IndexPhase = 'idle' | 'parsing' | 'writing' | 'done' | 'error';

export interface IndexProgress {
    /** True while a run is actively parsing or writing. */
    indexing: boolean;
    phase: IndexPhase;
    /** Files flushed so far (BatchWriter running total). */
    filesDone: number;
    /** Total files to write — known up front from parseRepo().files.length
     *  (or 1 for the single-file path). 0 while still parsing. */
    filesTotal: number;
    /** Running BatchWriter node/edge totals across flushes. */
    nodesWritten: number;
    edgesWritten: number;
    /** OPTIONAL, best-effort: pending embed-queue depth. Present ONLY when the
     *  context layer is on (code nodes are embed:false otherwise). No fake
     *  total — this is a raw pending count, never a percentage. */
    embedsPending?: number;
    /** RD-idx-async — per-item write errors from the just-finished run
     *  (writer.totals.errors.length), set only at phase==='done'. A
     *  fire-and-forget caller (cmdIndex's detach path) can no longer see the
     *  full error list the way a --wait/synchronous call can — this is the one
     *  genuinely observable signal it keeps: 0 means the run's writes were
     *  clean, >0 means something needs a --wait re-run to see the detail. */
    errorCount?: number;
    /** epoch ms the current/last run started. */
    startedAt?: number;
    /** epoch ms the current/last run finished (done or error). */
    finishedAt?: number;
    /** Error message when phase==='error'. */
    error?: string;
    /** atlas_onboard — correlation id for a fire-and-forget background run
     *  (e.g. `onboard-<ws>-<ts>`), so the caller that got an immediate
     *  "queued" response can match this status to its job. Absent for runs
     *  triggered by plain atlas_index. */
    jobId?: string;
    /** Files the walker/parser deliberately did NOT index this run, with the
     *  reason ('unsupported extension', 'test/fixture (default-excluded)', …).
     *  Surfaced so "224 of 4085 files skipped" is visible here instead of
     *  buried in an errorCount. `sample` is capped; `count`/`byReason` are
     *  exact. */
    skippedFiles?: { count: number; byReason: Record<string, number>; sample: string[] };
}

/** The shape returned for a workspace that has no recorded progress. */
export function idleProgress(): IndexProgress {
    return {
        indexing: false,
        phase: 'idle',
        filesDone: 0,
        filesTotal: 0,
        nodesWritten: 0,
        edgesWritten: 0,
    };
}

/** workspace → latest progress snapshot. Module singleton; same process
 *  lifetime as the embedded instance registry. */
const progress = new Map<string, IndexProgress>();

/** Merge a partial update into the workspace's progress snapshot. The first
 *  call for a workspace seeds from `idleProgress()` so callers can patch a
 *  single field without restating the whole object. */
export function setProgress(workspace: string, partial: Partial<IndexProgress>): void {
    const prev = progress.get(workspace) ?? idleProgress();
    progress.set(workspace, { ...prev, ...partial });
}

/** Read the workspace's latest snapshot, or an idle snapshot if none. */
export function getProgress(workspace: string): IndexProgress {
    return progress.get(workspace) ?? idleProgress();
}

/** Test/maintenance hook: forget a workspace's snapshot. */
export function clearProgress(workspace: string): void {
    progress.delete(workspace);
}
