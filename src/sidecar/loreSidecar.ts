/**
 * sidecar/loreSidecar.ts — Lore daemon lifecycle manager.
 *
 * Atlas starts Lore as a child process, monitors it, and restarts it if
 * it crashes or fails the 5-minute health watchdog.
 *
 * API:
 *   startLore(opts) → LoreSidecarHandle
 *
 * LoreSidecarHandle extends EventEmitter:
 *   'crash'   — Lore exited unexpectedly before the watchdog fired
 *   'restart' — watchdog triggered a restart
 *   'failed'  — max restarts exceeded; Atlas should not restart further
 *
 * All lifecycle events are logged to stderr with [atlas:sidecar] prefix.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';

const MAX_RESTARTS = 3;
const WATCHDOG_INTERVAL_MS = 300_000; // 5 minutes
const HEALTH_TIMEOUT_MS = 10_000;    // 10 s per health check attempt

export interface LoreStartOpts {
    /** Absolute path to the Lore entry-point (e.g., /path/to/lore-server.js). */
    loreBinPath: string;
    /** Directory Lore uses for its Kuzu + LanceDB data. Passed as LORE_HOME env var. */
    dataDir: string;
    /** HTTP port the Lore daemon should listen on. Passed as PORT env var. */
    port: number;
    /** Bearer token for Atlas → Lore auth. Passed as LORE_AUTH_TOKEN env var. */
    token: string;
    /** Extra CLI args forwarded to the Lore binary. Default ['--http']. */
    loreArgs?: string[];
}

export interface LoreSidecarHandle extends EventEmitter {
    /** Port the Lore daemon is listening on (same as opts.port). */
    port: number;
    /** Stop the daemon + watchdog cleanly. Safe to call multiple times.
     *  Resolves once the child is actually dead (SIGTERM, then SIGKILL after
     *  a 2s grace + a beat) — await it before process.exit or the escalation
     *  never runs and a SIGTERM-ignoring Lore is orphaned. */
    close(): Promise<void>;
    /** True if the Lore child process is still alive. */
    isAlive(): boolean;
}

function log(msg: string): void {
    process.stderr.write(`[atlas:sidecar] ${msg}\n`);
}

/** RD-R4 — strip C0/C1 control + ANSI bytes from child output before logging. */
// eslint-disable-next-line no-control-regex
function stripControl(s: string): string {
    return s.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
}

function httpGetHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const u = new URL(`http://127.0.0.1:${port}/health`);
        const timer = setTimeout(() => {
            req.destroy();
            resolve(false);
        }, HEALTH_TIMEOUT_MS);

        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'GET',
        }, (res) => {
            clearTimeout(timer);
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () => {
                const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
                resolve(ok);
            });
            res.on('error', () => resolve(false));
        });
        req.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
        req.end();
    });
}

export function startLore(opts: LoreStartOpts): LoreSidecarHandle {
    const emitter = new EventEmitter() as LoreSidecarHandle;
    let child: ChildProcess | null = null;
    let restartCount = 0;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    /** Children WE killed on purpose (restart/close) — their 'exit' is
     *  expected, not a crash. */
    const deliberateKill = new WeakSet<ChildProcess>();

    /** Wait for a child to actually exit (SIGKILL escalation after the
     *  grace window). Restart must not spawn the replacement while the old
     *  process still holds the port. */
    function waitForExit(proc: ChildProcess, graceMs: number): Promise<void> {
        return new Promise((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
            const timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already gone */ }
                resolve();
            }, graceMs);
            timer.unref?.();
            proc.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    function spawnLore(): ChildProcess {
        const extraArgs = opts.loreArgs ?? ['--http'];
        // #4: canonicalize loreBinPath and refuse anything that isn't an
        // existing .js file — we're about to launch it with the Lore token
        // in its env, so an attacker-chosen path must never run.
        const resolvedBin = path.resolve(opts.loreBinPath);
        if (!resolvedBin.endsWith('.js') || !fs.existsSync(resolvedBin) || !fs.statSync(resolvedBin).isFile()) {
            throw new Error(`refusing to spawn Lore: loreBinPath is not an existing .js file: ${opts.loreBinPath}`);
        }
        // RD-R3 — the binary we're about to run with the Lore token in its env
        // MUST be owned by us and not world/group-writable. Otherwise another
        // local user could swap its contents between checks and steal the token.
        const st = fs.statSync(resolvedBin);
        if (process.getuid && st.uid !== process.getuid()) {
            throw new Error(`refusing to spawn Lore: ${resolvedBin} is not owned by the current user`);
        }
        if ((st.mode & 0o022) !== 0) {
            throw new Error(`refusing to spawn Lore: ${resolvedBin} is group/world-writable (mode ${(st.mode & 0o777).toString(8)})`);
        }
        log(`spawning Lore (restart #${restartCount}) from ${resolvedBin} on port ${opts.port} args=${extraArgs.join(' ')}`);
        const proc = spawn('node', [resolvedBin, ...extraArgs], {
            // RD-M7env — explicit env allowlist instead of inheriting the full
            // parent environment (which can leak unrelated secrets into Lore).
            env: {
                PATH: process.env.PATH ?? '',
                HOME: process.env.HOME ?? '',
                TMPDIR: process.env.TMPDIR ?? '',
                LANG: process.env.LANG ?? '',
                LORE_HOME: opts.dataDir,
                PORT: String(opts.port),
                LORE_AUTH_TOKEN: opts.token,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // RD-R4 — strip control/ANSI bytes before forwarding child output to
        // our logger, so a hostile log line can't inject terminal escape
        // sequences (cursor moves, title rewrites, fake prompts) into our tty.
        proc.stdout?.on('data', (chunk: Buffer) => {
            process.stderr.write(`[atlas:sidecar:stdout] ${stripControl(chunk.toString()).trim()}\n`);
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            process.stderr.write(`[atlas:sidecar:stderr] ${stripControl(chunk.toString()).trim()}\n`);
        });

        // One logical "process is gone" path for both exit and spawn-error.
        // 'handled' guards against double-firing; deliberateKill marks the
        // exits WE caused (restart/close) so they don't read as crashes.
        let handled = false;
        const onGone = (kind: 'exit' | 'error', detail: string): void => {
            if (handled) return;
            handled = true;
            if (closed) return; // intentional shutdown — ignore
            if (deliberateKill.has(proc)) {
                log(`Lore exited as expected (${kind}: ${detail})`);
                return;
            }
            log(`Lore ${kind === 'error' ? 'failed to spawn' : 'exited unexpectedly'} (${detail})`);
            emitter.emit('crash', { kind, detail });
            // A dead Lore must not stay down until the next 5-minute watchdog
            // tick — restart immediately (bounded by MAX_RESTARTS, then
            // 'failed'). This is the auto-restart the header has always
            // promised but nothing used to wire up.
            void doRestart('Lore crashed');
        };
        proc.once('exit', (code, signal) => {
            onGone('exit', `code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        });
        // Without this, a failed spawn (node not on the stripped PATH, EACCES)
        // is an UNCAUGHT 'error' event that takes down the whole daemon.
        proc.on('error', (err) => {
            onGone('error', (err as Error).message);
        });

        return proc;
    }

    async function doRestart(reason: string): Promise<void> {
        if (closed) return;

        restartCount += 1;
        log(`${reason} — restarting Lore (attempt ${restartCount}/${MAX_RESTARTS})`);

        if (restartCount > MAX_RESTARTS) {
            log('max restarts exceeded — giving up');
            if (watchdogTimer !== null) {
                clearInterval(watchdogTimer);
                watchdogTimer = null;
            }
            emitter.emit('failed', { restarts: restartCount });
            return;
        }

        // Kill old process if still running — and WAIT for it to die before
        // spawning the replacement. Spawning immediately raced the old
        // process's shutdown: the new Lore could hit EADDRINUSE on the same
        // port, die instantly, and burn a restart attempt (or trip the
        // crash path a second time).
        const old = child;
        if (old && old.exitCode === null && old.signalCode === null && !old.killed) {
            deliberateKill.add(old);
            old.kill('SIGTERM');
            await waitForExit(old, 2_000);
            if (closed) return; // close() raced us while we waited
        }

        try {
            child = spawnLore();
        } catch (err) {
            // Spawn-refusal guards (bad bin path, wrong owner, writable mode)
            // or a missing node binary. Don't crash the daemon over it — log
            // and let the next watchdog tick retry (restartCount keeps
            // counting, so a persistently broken setup still ends in 'failed').
            log(`respawn failed: ${(err as Error).message}`);
            return;
        }
        emitter.emit('restart', { attempt: restartCount });
    }

    // Initial spawn.
    child = spawnLore();

    // 5-minute watchdog.
    watchdogTimer = setInterval(async () => {
        if (closed) return;
        const healthy = await httpGetHealth(opts.port);
        if (!healthy) {
            await doRestart('watchdog health check failed');
        } else {
            log(`watchdog: Lore healthy on port ${opts.port}`);
        }
    }, WATCHDOG_INTERVAL_MS);

    // LoreSidecarHandle surface.
    (emitter as unknown as { port: number }).port = opts.port;

    emitter.port = opts.port;

    emitter.isAlive = (): boolean => {
        if (!child) return false;
        return child.exitCode === null && !child.killed;
    };

    emitter.close = (): Promise<void> => {
        if (closed) return Promise.resolve();
        closed = true;
        log('close() called — stopping Lore and watchdog');
        if (watchdogTimer !== null) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        // RD-R5 — graceful stop: SIGTERM, poll for exit up to 2s, then SIGKILL.
        // Don't null the handle immediately — keep it so the escalation timer
        // can still reach the process if it ignores SIGTERM.
        // NOW AWAITABLE: daemon shutdown used to call this fire-and-forget and
        // process.exit() immediately, so the SIGKILL escalation never ran for
        // a SIGTERM-ignoring Lore — orphaning it with the port bound. The
        // returned promise resolves once the child is dead (or SIGKILL sent +
        // a beat), so a caller that awaits it never orphans the process.
        const target = child;
        if (target && !target.killed) {
            return new Promise<void>((resolve) => {
                target.kill('SIGTERM');
                const start = Date.now();
                const poll = setInterval(() => {
                    if (target.exitCode !== null || target.signalCode !== null) {
                        clearInterval(poll);
                        if (child === target) child = null;
                        resolve();
                        return;
                    }
                    if (Date.now() - start >= 2000) {
                        clearInterval(poll);
                        try { target.kill('SIGKILL'); } catch { /* already gone */ }
                        if (child === target) child = null;
                        const settle = setTimeout(resolve, 150);
                        settle.unref?.();
                    }
                }, 100);
                poll.unref?.();
            });
        }
        child = null;
        return Promise.resolve();
    };

    return emitter;
}
