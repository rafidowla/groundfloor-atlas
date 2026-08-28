/**
 * indexProgress.ts — Sprint 4 index-progress derivation (PURE).
 *
 * Maps a raw `index_status` MCP result (the daemon's progress registry snapshot,
 * see src/mcp/indexProgress.ts) into the view state the header progress bar
 * renders. Kept pure (no React) so the render-from-state logic is unit-tested
 * against hand-rolled snapshots without a DOM.
 *
 * HONESTY (diagnosis §2): the only real, monotonic signal for the code index is
 * filesDone/filesTotal. We render a determinate fill from that ratio and NEVER
 * invent a percentage we can't source. `embedsPending` (present only when the
 * context layer is on) is shown as a raw "finalizing embeds" count with an
 * INDETERMINATE bar — no fake denominator.
 */

export type IndexPhase = 'idle' | 'parsing' | 'writing' | 'done' | 'error';

/** The raw shape index_status returns (subset we read). Everything optional so a
 *  partial / unknown payload degrades gracefully to "hidden". */
export interface IndexStatusRaw {
    indexing?: boolean;
    phase?: string;
    filesDone?: number;
    filesTotal?: number;
    nodesWritten?: number;
    edgesWritten?: number;
    embedsPending?: number;
    error?: string;
    /** epoch ms the current/last run finished (done/error). Used to EXPIRE
     *  terminal snapshots: the daemon retains the done/error snapshot
     *  indefinitely, so without a staleness cutoff the "Indexed N files" bar
     *  (and the failure overlay) persisted forever — including on fresh page
     *  loads hours after the run. */
    finishedAt?: number;
}

/** How long a terminal (done/error) snapshot stays visible. */
export const TERMINAL_SNAPSHOT_VISIBLE_MS = 60_000;

export interface ProgressView {
    /** Whether the bar should be shown at all. Hidden when idle and never run. */
    visible: boolean;
    phase: IndexPhase;
    filesDone: number;
    filesTotal: number;
    nodesWritten: number;
    edgesWritten: number;
    /** 0..1 determinate fill from filesDone/filesTotal, or null when the ratio
     *  is not yet sourceable (filesTotal unknown) → render indeterminate. */
    fraction: number | null;
    /** True while files are still being written (determinate phase). */
    writing: boolean;
    /** True once files are done but embeds are still draining (context layer
     *  on) — indeterminate "finalizing" state, no fake %. */
    finalizingEmbeds: boolean;
    /** Best-effort pending embed count, only when the context layer is on. */
    embedsPending?: number;
    /** Human label, e.g. "Indexing 12/40 files" or "Finalizing embeds (3)". */
    label: string;
    error?: string;
}

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asPhase(v: unknown): IndexPhase {
    return v === 'parsing' || v === 'writing' || v === 'done' || v === 'error' ? v : 'idle';
}

/**
 * Derive the bar view from a raw index_status snapshot. `null`/undefined (e.g.
 * the poll hasn't returned yet) yields a hidden, idle view.
 */
export function deriveProgress(raw: IndexStatusRaw | null | undefined): ProgressView {
    const r = raw ?? {};
    const phase = asPhase(r.phase);
    const indexing = r.indexing === true;
    const filesDone = num(r.filesDone);
    const filesTotal = num(r.filesTotal);
    const nodesWritten = num(r.nodesWritten);
    const edgesWritten = num(r.edgesWritten);
    const embedsPending = typeof r.embedsPending === 'number' ? r.embedsPending : undefined;

    // Files still landing → determinate fill (only when total is known).
    const writing = indexing && (phase === 'parsing' || phase === 'writing') && !(
        // once files are all done but embeds pending, we flip to finalizing
        filesTotal > 0 && filesDone >= filesTotal && (embedsPending ?? 0) > 0
    );
    const finalizingEmbeds =
        indexing && filesTotal > 0 && filesDone >= filesTotal && (embedsPending ?? 0) > 0;

    // Show the bar while a run is in flight, OR briefly on the terminal
    // (done/error) snapshot so the user sees the outcome — then EXPIRE it:
    // the daemon keeps the terminal snapshot forever, and the bar used to
    // persist indefinitely (including resurrecting on fresh page loads).
    const finishedAt = typeof r.finishedAt === 'number' ? r.finishedAt : undefined;
    const terminalStale =
        (phase === 'done' || phase === 'error') &&
        finishedAt !== undefined &&
        Date.now() - finishedAt > TERMINAL_SNAPSHOT_VISIBLE_MS;
    const visible = !terminalStale && (indexing || phase === 'error' || phase === 'done');

    // Determinate fraction ONLY when total is known. parsing (total still 0) →
    // null → indeterminate. done → full.
    let fraction: number | null;
    if (phase === 'done') fraction = 1;
    else if (filesTotal > 0) fraction = Math.min(1, filesDone / filesTotal);
    else fraction = null;

    let label: string;
    if (phase === 'error') label = `Index failed${r.error ? `: ${r.error}` : ''}`;
    else if (phase === 'done') label = `Indexed ${filesDone.toLocaleString()} file${filesDone === 1 ? '' : 's'}`;
    else if (finalizingEmbeds) label = `Finalizing embeds (${embedsPending})`;
    else if (phase === 'parsing' || filesTotal === 0) label = 'Parsing repository…';
    else label = `Indexing ${filesDone.toLocaleString()}/${filesTotal.toLocaleString()} files`;

    return {
        visible,
        phase,
        filesDone,
        filesTotal,
        nodesWritten,
        edgesWritten,
        fraction,
        writing,
        finalizingEmbeds,
        embedsPending,
        label,
        error: r.error,
    };
}
