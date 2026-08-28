/**
 * daemon.ts — Groundfloor Atlas daemon entry point.
 *
 * Startup sequence:
 *   1. Load config + token.
 *   2. If sidecar.enabled → check if Lore is already running.
 *      - Already up  → log and use the existing instance (safe migration path).
 *      - Not running → spawn Lore via loreSidecar, wait up to 30 s for health.
 *   3. Start Groundfloor Atlas MCP server.
 *   4. On SIGTERM/SIGINT → close MCP server then close sidecar.
 */

import * as http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, readAtlasToken } from './config.js';
import { startAtlasMcpServer } from './mcp/server.js';
import { startLore, type LoreSidecarHandle } from './sidecar/loreSidecar.js';
import { closeAllEmbedded, hasOpenEmbedded, openEmbeddedInstances } from './mcp/embeddedRegistry.js';
import { flushVerbatimQueue, replayVerbatimJournal, VERBATIM_SHUTDOWN_FLUSH_MS } from './mcp/verbatimQueue.js';
import { drainIndexWork } from './lore/indexDrain.js';

/** RC #3 — max time the shutdown handler waits for an in-flight index to reach a
 *  consistent between-pass point before closing store handles. A wedged index
 *  can't hang shutdown past this; on timeout we close best-effort. */
const SHUTDOWN_INDEX_DRAIN_MS = 30_000;

/** E3 — how often the daemon sweeps embedded storage maintenance. Paired with
 *  the 15-minute version cutoff (long enough to clear LanceDB's ~10-min grace,
 *  short enough to reclaim same-session re-index churn). */
const MAINTENANCE_INTERVAL_MS = 20 * 60 * 1000;

// ── Lore health helpers ───────────────────────────────────────────────────────

function probeLoreHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { req.destroy(); resolve(false); }, 3_000);
        const req = http.request(
            { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
            (res) => {
                clearTimeout(timer);
                // Drain body so socket is reusable
                res.resume();
                resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
            },
        );
        req.on('error', () => { clearTimeout(timer); resolve(false); });
        req.end();
    });
}

async function waitForLoreReady(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
        attempts++;
        const ok = await probeLoreHealth(port);
        if (ok) {
            console.error(`[atlas:sidecar] Lore healthy on port ${port} (${attempts} probe(s))`);
            return;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
        `Lore sidecar failed to become healthy on port ${port} within ${timeoutMs}ms`,
    );
}

/**
 * E3 — one guarded maintenance pass, factored out of runDaemon so it's
 * independently testable (tests/maintenance-overlap-guard.test.ts drives it
 * directly against a real EmbeddedLore instance instead of waiting on
 * MAINTENANCE_INTERVAL_MS).
 *
 * A pass's runMaintenance() calls can stall for minutes (LanceDB
 * optimize()/FTS-merge contention) or, in the worst case, wedge the process
 * indefinitely (KINDLING-READINESS-STATEMENT.md §4b). Without a guard, the
 * next tick fires anyway and races the same table — measured upstream
 * (groundfloor-lore spike, 2026-08-26) at 65-73% failure when two maintenance
 * passes overlap, only partially closed by lore-side retry (down to
 * ~21-29%). Returns a function safe to hand straight to setInterval: it never
 * starts a new pass while one is still in flight.
 */
export function createMaintenanceTicker(): () => void {
    let maintenanceRunning = false;
    return () => {
        if (maintenanceRunning) {
            console.error('[atlas] embedded maintenance tick skipped — previous pass still running');
            return;
        }
        maintenanceRunning = true;
        void (async () => {
            if (!hasOpenEmbedded()) return;
            // Guard the snapshot await too: openEmbeddedInstances() does a
            // Promise.all over cached open promises, so a still-rejecting open
            // (raced ahead of getEmbeddedLore's p.catch eviction) would throw
            // OUTSIDE the per-instance try/catch and surface as an unhandled
            // rejection. Catch it here so the timer just skips this tick.
            let instances: Awaited<ReturnType<typeof openEmbeddedInstances>>;
            try {
                instances = await openEmbeddedInstances();
            } catch (err) {
                console.error(`[atlas] embedded maintenance error: ${(err as Error).message}`);
                return;
            }
            for (const lore of instances) {
                try {
                    await lore.runMaintenance({ dryRun: false, cutoff: '15m' });
                } catch (err) {
                    console.error(`[atlas] embedded maintenance error: ${(err as Error).message}`);
                }
            }
        })().finally(() => { maintenanceRunning = false; });
    };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runDaemon(opts: { port?: number } = {}): Promise<void> {
    const cfg = loadConfig();
    const token = readAtlasToken();
    // `atlas serve --port N` overrides the resolved config/env port. Validated
    // in parseArgs (1..65535) so a present value is always safe to honor.
    const port = opts.port ?? cfg.port;

    let sidecar: LoreSidecarHandle | null = null;
    let handle: Awaited<ReturnType<typeof startAtlasMcpServer>> | null = null;
    let maintenanceTimer: NodeJS.Timeout | null = null;

    // ── 0. Graceful shutdown — registered FIRST ─────────────────────────────
    // Signal handlers used to be registered AFTER the sidecar spawn + the 30s
    // health wait: a SIGTERM landing anywhere in startup default-killed the
    // daemon and ORPHANED the just-spawned Lore (port bound, stdout EPIPE on
    // its next log line). Register before any of that; every reference below
    // is null-guarded so an early signal is a clean no-op shutdown.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`[atlas] received ${signal}; shutting down`);
        let hadError = false;
        clearInterval(maintenanceTimer!);
        // RC #3 — DRAIN in-flight index work BEFORE closing store handles. This
        // flips the "accepting" flag (a fresh atlas_index now refuses) and awaits
        // the current index run(s) to a between-pass consistent point, so
        // closeAllEmbedded below never tears down Kuzu/LanceDB mid-write (which
        // leaves nodes without their edges / can corrupt LanceDB versions).
        // Bounded so a wedged index can't hang shutdown; on timeout we close
        // anyway (best-effort — a bounded wait beats an unbounded hang).
        // It now runs BEFORE the verbatim shutdown flush below, because the
        // flag it flips also gates the verbatim queue's post-flush index fold
        // (maybeFoldVerbatimIndex checks isShuttingDown): a fold fired by the
        // shutdown flush would race closeAllEmbedded (which serializes behind
        // the fold's maintenance lock) for zero benefit — the next start's
        // replay + first-batch fold covers visibility anyway. Both steps run
        // before any store handle closes either way; only the order changed.
        try {
            const clean = await drainIndexWork(SHUTDOWN_INDEX_DRAIN_MS);
            if (!clean) {
                console.error(`[atlas] index drain timed out after ${SHUTDOWN_INDEX_DRAIN_MS}ms — closing store handles anyway`);
            }
        } catch (err) {
            console.error(`[atlas] index drain error: ${(err as Error).message}`);
        }
        // WO-2 — land any queued verbatim entries BEFORE the store handles
        // close (they are append-only writes; losing them on every restart
        // would defeat the quote bank). Bounded so a wedged store can't hang
        // shutdown; unflushed entries are logged, not silently dropped.
        try {
            const vFlush = await flushVerbatimQueue({ deadlineMs: VERBATIM_SHUTDOWN_FLUSH_MS });
            if (vFlush.remaining > 0 || vFlush.failed > 0) {
                // The remaining entries are already in the write-ahead
                // journal (every enqueue appends before the in-memory push),
                // so "unflushed" here means deferred to the next start's
                // replay, not lost — no last-ditch journal write under
                // shutdown time pressure.
                console.error(`[atlas] verbatim shutdown flush: ${vFlush.flushed} landed, ${vFlush.remaining} unflushed (journaled — next start replays them), ${vFlush.failed} failed`);
            }
        } catch (err) {
            console.error(`[atlas] verbatim shutdown flush error: ${(err as Error).message}`);
        }
        try {
            if (handle) await handle.close();
        } catch (err) {
            hadError = true;
            console.error(`[atlas] MCP server close error: ${(err as Error).message}`);
        } finally {
            // Close every embedded Lore instance (kuzu+lancedb+sqlite handles)
            // the tools opened — deterministic release before exit.
            try {
                await closeAllEmbedded();
            } catch (err) {
                hadError = true;
                console.error(`[atlas] embedded close error: ${(err as Error).message}`);
            }
            // #5: the sidecar MUST stop even if handle.close() throws —
            // otherwise Lore is orphaned (port stays bound) and the next
            // start refuses to manage it. AWAIT the close: sidecar.close()
            // resolves only once the child is really dead (SIGTERM→SIGKILL
            // escalation included) — exiting before that orphaned a
            // SIGTERM-ignoring Lore.
            if (sidecar) {
                console.error('[atlas] stopping Lore sidecar…');
                try {
                    await sidecar.close();
                } catch (err) {
                    hadError = true;
                    console.error(`[atlas] sidecar close error: ${(err as Error).message}`);
                }
            }
        }
        process.exit(hadError ? 1 : 0);
    };

    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT',  () => { void shutdown('SIGINT'); });

    // ── 0b. Verbatim journal replay — recover what a hard kill left behind ──
    // Every enqueue journals write-ahead (mcp/verbatimQueue.ts), so entries
    // unflushed at a crash or SIGKILL — which skips the graceful shutdown
    // flush above entirely — are on disk. Re-populate the queue BEFORE the
    // MCP server binds: replay must complete before new traffic can enqueue
    // and before the first periodic flush tick. Malformed journal lines are
    // skipped inside the replay (a damaged journal never gates startup).
    try {
        const replayed = replayVerbatimJournal();
        if (replayed.replayed > 0 || replayed.malformed > 0) {
            console.error(`[atlas] verbatim journal replay: ${replayed.replayed} entr${replayed.replayed === 1 ? 'y' : 'ies'} recovered, ${replayed.malformed} malformed line${replayed.malformed === 1 ? '' : 's'} skipped`);
        }
    } catch (err) {
        console.error(`[atlas] verbatim journal replay error: ${(err as Error).message}`);
    }

    // ── 1. Lore sidecar (optional) ──────────────────────────────────────────
    if (cfg.sidecar?.enabled) {
        const sc = cfg.sidecar;
        console.error(`[atlas] sidecar enabled — checking Lore on port ${sc.lorePort}…`);

        const alreadyRunning = await probeLoreHealth(sc.lorePort);
        if (alreadyRunning) {
            // Safe migration path: independent Lore is still running.
            // Use it as-is; the operator can stop com.groundfloor.lore later
            // and Atlas will start the sidecar on the next restart.
            console.error(
                `[atlas] Lore already running on port ${sc.lorePort} ` +
                `— using existing instance. ` +
                `To hand Lore over to the sidecar, stop your external Lore ` +
                `(e.g. launchctl stop com.groundfloor.lore) and restart Atlas.`,
            );
        } else {
            console.error(`[atlas] Lore not running — starting sidecar…`);
            if (!token) {
                throw new Error(
                    'sidecar.enabled=true but no auth token found. ' +
                    'Write a Lore bearer token to ' +
                    '~/.groundfloor/atlas/auth.token or set LORE_AUTH_TOKEN.',
                );
            }

            sidecar = startLore({
                loreBinPath: sc.loreBinPath,
                dataDir: sc.loreDataDir,
                port: sc.lorePort,
                token,
                loreArgs: sc.loreArgs,
            });

            // Surface sidecar lifecycle events
            sidecar.on('crash', ({ code, signal }: { code: number | null; signal: string | null }) => {
                console.error(`[atlas] Lore sidecar crashed (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
            });
            sidecar.on('restart', ({ attempt }: { attempt: number }) => {
                console.error(`[atlas] Lore sidecar restarted (attempt ${attempt})`);
            });
            sidecar.on('failed', ({ restarts }: { restarts: number }) => {
                console.error(`[atlas] Lore sidecar failed after ${restarts} restarts — Atlas will continue but Lore is unavailable`);
            });

            // Wait up to 30 s for Lore to be ready before opening the MCP server.
            // On failure the sidecar MUST be stopped — the old bare `await` let
            // runDaemon reject straight to process.exit(1) with the just-spawned
            // Lore still running (the #17 cleanup only covered MCP-start).
            try {
                await waitForLoreReady(sc.lorePort, 30_000);
            } catch (err) {
                console.error(`[atlas] ${(err as Error).message} — stopping the sidecar before exit`);
                try { await sidecar.close(); } catch { /* best-effort */ }
                throw err;
            }
        }
    }

    // ── 2. Groundfloor Atlas MCP server ─────────────────────────────────────────────────
    try {
        handle = await startAtlasMcpServer({ port, home: cfg.home });
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EADDRINUSE') {
            console.error(`[atlas] port ${port} is already in use — is another Atlas daemon running? Stop it or set a different "port" in config.json.`);
        } else {
            console.error(`[atlas] failed to start MCP server: ${e.message}`);
        }
        // #17: never orphan the Lore sidecar we just started.
        if (sidecar) {
            console.error('[atlas] stopping Lore sidecar after failed MCP start…');
            try { await sidecar.close(); } catch { /* best-effort */ }
        }
        process.exit(1);
    }
    console.error(`[atlas] daemon listening on http://127.0.0.1:${handle.port} (home=${cfg.home})`);
    if (cfg.sidecar?.enabled) {
        console.error(`[atlas] Lore sidecar managed=${sidecar !== null} port=${cfg.sidecar.lorePort}`);
    }

    // ── 2b. E3: Groundfloor Atlas-owned storage maintenance (embedded mode) ──────────────
    // Embedded Lore gates its own auto-sweep timers OFF, so Groundfloor Atlas drives them:
    // periodically compact + version-clean whatever per-workspace instances the
    // read/write tools have opened. Unref'd so it never holds the process alive.
    // (The verbatim queue complements this with its own rate-limited fold after
    // landed batches — see verbatimQueue.maybeFoldVerbatimIndex — so fresh
    // quotes do not wait out this full interval to become searchable; the two
    // can never overlap on one instance, RD-F13's maintenance lock serializes
    // them.)
    if (cfg.lore.mode === 'embedded') {
        maintenanceTimer = setInterval(createMaintenanceTicker(), MAINTENANCE_INTERVAL_MS);
        maintenanceTimer.unref();
        console.error(`[atlas] embedded storage maintenance every ${MAINTENANCE_INTERVAL_MS / 60000}min (15m version cutoff)`);
    }

    // ── 3. Top-level safety nets ────────────────────────────────────────────
    // (The graceful-shutdown handler + signal registration live at the TOP of
    // runDaemon now — see "0. Graceful shutdown" — so a signal during startup
    // can no longer orphan the sidecar.)
    // RD-daemon-resilience — top-level safety nets. Node 22 TERMINATES the
    // process on an unhandled promise rejection by default, so a single stray
    // `void p()` that rejects anywhere in the tool/route layer would take the
    // whole daemon (and every in-flight request) down. For a rejection: log and
    // KEEP RUNNING — the daemon must stay up. For a genuinely uncaught
    // exception the process may be in an undefined state, so log the cause and
    // shut down cleanly (launchd KeepAlive restarts us) — a clean, logged
    // restart beats an abrupt crash with no trail.
    process.on('unhandledRejection', (reason) => {
        const r = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        console.error(`[atlas] unhandledRejection (kept alive): ${r}`);
    });
    process.on('uncaughtException', (err) => {
        console.error(`[atlas] uncaughtException — clean restart: ${err.stack ?? err.message}`);
        void shutdown('uncaughtException');
    });
}

// Entry-point detection. Node reports import.meta.url as the module's REALPATH,
// but process.argv[1] is the path AS PASSED — they differ whenever the invocation
// traverses a symlink (/tmp→/private/tmp, a symlinked install dir, an npm-global/
// Homebrew bin shim). A plain string compare then falsely reports "not direct" and
// the daemon silently no-ops (exit 0, no server started). Realpath both sides.
const isDirectInvocation = (() => {
    const invokedPath = process.argv[1];
    if (invokedPath === undefined) return false;
    try {
        return realpathSync(invokedPath) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
})();

if (isDirectInvocation) {
    runDaemon().catch((err) => {
        console.error(`[atlas] fatal: ${(err as Error).message}`);
        process.exit(1);
    });
}
