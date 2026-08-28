/**
 * lore/indexDrain.ts — in-flight index tracker + shutdown drain (RC defect #3).
 *
 * THE DEFECT: on SIGTERM/SIGINT the daemon (src/daemon.ts) tore down the
 * Kuzu/LanceDB handles (closeAllEmbedded) while an `atlas_index` batch could be
 * mid-write — the index runs a node-pass-then-edge-pass, so an interrupt between
 * the two passes leaves nodes written but their edges missing, and closing the
 * store handle underneath a live write can corrupt LanceDB versions outright.
 * There was no "stop accepting new work + await the in-flight batch" step.
 *
 * THE FIX: every `atlas_index` run brackets its write section with
 * beginIndexWork()/endIndexWork(). The shutdown handler calls
 * `drainIndexWork()` FIRST — it flips an accepting=false flag (a fresh
 * atlas_index checks isShuttingDown() and refuses) and awaits every currently
 * in-flight run to reach endIndexWork (bounded by a timeout so a wedged index
 * can't hang shutdown forever) BEFORE closeAllEmbedded runs. Draining to a
 * between-batch boundary keeps the persisted graph consistent; if the drain
 * times out we still proceed to close (best-effort — a bounded wait beats an
 * unbounded hang), but the common case reaches a clean point first.
 *
 * This is process-local (same lifetime as embeddedRegistry's instance map),
 * which is exactly right: it coordinates the daemon's OWN in-process index runs
 * with the daemon's OWN shutdown. Cross-PROCESS coordination (CLI vs daemon) is
 * the writer lock's job (writerLock.ts).
 */

/** workspace → count of in-flight index runs for it. A Map (not a Set) because
 *  a workspace could in principle have overlapping runs; the count reaches 0
 *  only when the last one ends. */
const _inFlight = new Map<string, number>();

/** Flipped true by drainIndexWork(); a new index checks this and refuses. */
let _shuttingDown = false;

/** Resolvers waiting for the in-flight count to reach zero. Notified on each
 *  endIndexWork once the map is empty. */
let _idleWaiters: Array<() => void> = [];

/** Mark the start of an index run for `workspace`. */
export function beginIndexWork(workspace: string): void {
    _inFlight.set(workspace, (_inFlight.get(workspace) ?? 0) + 1);
}

/** Mark the end of an index run for `workspace`. Notifies drain waiters when
 *  the whole daemon reaches zero in-flight index work. */
export function endIndexWork(workspace: string): void {
    const n = (_inFlight.get(workspace) ?? 0) - 1;
    if (n <= 0) _inFlight.delete(workspace);
    else _inFlight.set(workspace, n);
    if (_inFlight.size === 0 && _idleWaiters.length > 0) {
        const waiters = _idleWaiters;
        _idleWaiters = [];
        for (const w of waiters) w();
    }
}

/** True once shutdown has begun — a new atlas_index should refuse rather than
 *  start a write that the shutdown might tear down mid-flight. */
export function isShuttingDown(): boolean {
    return _shuttingDown;
}

/** True if any index run is currently in flight (for tests / diagnostics). */
export function hasInFlightIndex(): boolean {
    return _inFlight.size > 0;
}

/**
 * Shutdown drain: stop accepting new index work and await the in-flight runs to
 * finish (reach a between-pass consistent point). Bounded by `timeoutMs` so a
 * wedged run can't block shutdown indefinitely — on timeout it resolves anyway
 * (the caller proceeds to close handles best-effort). Returns whether the drain
 * reached idle cleanly (true) or timed out (false).
 */
export function drainIndexWork(timeoutMs = 30_000): Promise<boolean> {
    _shuttingDown = true;
    if (_inFlight.size === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (clean: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(clean);
        };
        // NOT unref'd: the timeout must be allowed to fire to enforce the bound.
        // (An unref'd timer lets Node exit the event loop before it fires, which
        // would leave this await pending forever if nothing else keeps the loop
        // alive — during shutdown the process is ending anyway.)
        const timer = setTimeout(() => done(false), timeoutMs);
        _idleWaiters.push(() => done(true));
    });
}

/** Test hook: reset the module to a pristine state between test cases. */
export function _resetIndexDrainForTest(): void {
    _inFlight.clear();
    _shuttingDown = false;
    _idleWaiters = [];
}
