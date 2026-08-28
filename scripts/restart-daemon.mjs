#!/usr/bin/env node
/*
 * restart-daemon.mjs — refresh the running Groundfloor Atlas daemon after a rebuild.
 *
 * WHY: the daemon is a long-lived background service (launchd). It loads
 * dist/ into memory ONCE at start and keeps running that copy. After
 * `npm run build` rewrites dist/, the already-running process is still
 * serving the OLD code until it is restarted — which is how a daemon can
 * silently serve 10-day-stale behaviour even though dist/ on disk is current.
 * Wiring this as package.json `postbuild` means every rebuild auto-refreshes
 * the running service, so on-disk code and in-memory code can never drift.
 *
 * BEST-EFFORT BY DESIGN: this must NEVER fail a build. It no-ops cleanly when
 * the service isn't installed (CI, a fresh machine, a teammate who doesn't run
 * the daemon) and on non-macOS (launchd is macOS-only). A future systemd
 * branch can be added for Linux service installs.
 */
import { execSync } from 'node:child_process';
import process from 'node:process';

const LABEL = 'com.groundfloor.atlas';

function log(msg) { console.log(`[postbuild] ${msg}`); }

if (process.platform !== 'darwin') {
    // launchd is macOS-only. Nothing to refresh elsewhere (yet).
    process.exit(0);
}

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
if (uid === null) process.exit(0);
const target = `gui/${uid}/${LABEL}`;

// Is the launchd service actually installed for this user? `launchctl print`
// exits non-zero if the label isn't loaded — that's our "not installed" signal.
try {
    execSync(`launchctl print ${target}`, { stdio: 'ignore' });
} catch {
    log(`daemon service (${LABEL}) not installed — skipping restart (build unaffected).`);
    process.exit(0);
}

// Kickstart -k = kill the running instance and start a fresh one, which loads
// the just-built dist/. launchd's KeepAlive brings it back up on its own.
try {
    execSync(`launchctl kickstart -k ${target}`, { stdio: 'ignore' });
    log(`restarted the Groundfloor Atlas daemon to load the fresh build (first recall warms ~90s).`);
} catch (err) {
    log(`could not restart the daemon (skipping, build unaffected): ${err?.message ?? err}`);
}

process.exit(0);
