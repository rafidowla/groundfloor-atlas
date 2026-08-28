/**
 * cli/service.ts — `atlas service` LaunchAgent lifecycle (macOS).
 *
 * Installs/loads a per-user LaunchAgent (`com.groundfloor.atlas`) so the Atlas
 * daemon runs at login and restarts on crash, matching the style of the
 * sibling `com.groundfloor.tunnel.plist` already on this machine.
 *
 * DESIGN — two layers so tests never touch ~/Library/LaunchAgents and never
 * run real `launchctl`:
 *
 *   1. PURE   — `buildAtlasPlist(opts)` returns the plist XML from plain data
 *               (no I/O). Fully unit-testable with string assertions.
 *   2. EFFECT — `installService` / `uninstallService` / `serviceStatus` take an
 *               injectable `deps = { launchAgentsDir?, exec?, home? }`. Prod
 *               passes nothing → real `~/Library/LaunchAgents` + a `spawnSync`
 *               `launchctl` wrapper (same shape as cli/groups.ts:123). Tests
 *               pass a tmp dir + a recording fake exec.
 *
 * Built vs dev entry (ProgramArguments):
 *   built (default) → [ node, <repoRoot>/dist/daemon.js ]   (plain node, no tsx)
 *   dev   (--dev)   → [ node, <repoRoot>/node_modules/tsx/dist/cli.mjs,
 *                       <repoRoot>/src/daemon.ts ]
 *
 * The daemon logs to STDERR (every console.error in daemon.ts), so the real log
 * lands in <ATLAS_HOME>/daemon.err; daemon.log (stdout) is expected near-empty.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome, loadConfig } from '../config.js';

/** The LaunchAgent label / reverse-DNS id for the Atlas daemon. */
export const ATLAS_LABEL = 'com.groundfloor.atlas';

/** The plist filename under ~/Library/LaunchAgents. */
export const ATLAS_PLIST_NAME = `${ATLAS_LABEL}.plist`;

/** Tunnel-template PATH (style match). The node bin dir is PREPENDED at build. */
const BASE_PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';

// ── injectable seams ─────────────────────────────────────────────────────────

/** Result of a single child-process invocation (subset of spawnSync's shape). */
export interface ExecResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Run a command; mirrors the cli/groups.ts spawnSync({encoding:'utf-8'}) idiom. */
export type Exec = (cmd: string, args: string[]) => ExecResult;

/** Injectable dependencies. Every field defaults to the real, prod value. */
export interface ServiceDeps {
    /** Where the plist is written. Default: ~/Library/LaunchAgents. */
    launchAgentsDir: string;
    /** launchctl runner. Default: real spawnSync wrapper. */
    exec: Exec;
    /** ATLAS_HOME (for log paths + env). Default: cfg.home / defaultHome(). */
    home: string;
}

/** Real default exec: thin spawnSync wrapper, same options as cli/groups.ts. */
function realExec(cmd: string, args: string[]): ExecResult {
    const res = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 15000 });
    return {
        status: res.status,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
    };
}

/** Fill in any unspecified dep with its real default. */
function resolveDeps(deps?: Partial<ServiceDeps>): ServiceDeps {
    return {
        launchAgentsDir: deps?.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
        exec: deps?.exec ?? realExec,
        home: deps?.home ?? defaultHome(),
    };
}

// ── repoRoot / node resolution (runtime, NOT cwd) ────────────────────────────

/**
 * Resolve the Atlas repo root from THIS compiled module's location — never
 * process.cwd() (the user may run `atlas` from anywhere). Mirrors the find-up
 * idiom in mcp/tools/health.ts: walk up from src/cli/service.ts (tsx) OR
 * dist/cli/service.js (built) until a package.json named '@groundfloor/atlas'.
 */
export function resolveRepoRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
        const pkg = join(dir, 'package.json');
        try {
            const parsed = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string };
            if (parsed.name === '@groundfloor/atlas') return dir;
        } catch {
            /* keep walking */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: src/cli/ and dist/cli/ are both two up from the repo root.
    return join(here, '..', '..');
}

// ── pure plist builder ───────────────────────────────────────────────────────

export interface PlistOpts {
    /** Reverse-DNS label. */
    label: string;
    /** Resolved repo root (WorkingDirectory). */
    repoRoot: string;
    /** Absolute node binary (process.execPath). */
    nodePath: string;
    /** 'built' → dist/daemon.js via node; 'dev' → tsx cli.mjs + src/daemon.ts. */
    mode: 'built' | 'dev';
    /** The arg(s) AFTER nodePath (e.g. [dist/daemon.js] or [cli.mjs, daemon.ts]). */
    entryArgs: string[];
    /** ATLAS_HOME — log files land here; also injected into the daemon env. */
    atlasHome: string;
    /** Optional explicit port → injected as ATLAS_PORT in the daemon env. */
    port?: number;
}

/** XML-escape a string for inclusion in a <string> element. */
function xmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build the `com.groundfloor.atlas.plist` XML (PURE — no I/O).
 *
 * Field set + order matches the tunnel template, plus:
 *   - WorkingDirectory   (Atlas needs cwd/import.meta-relative reads to resolve)
 *   - KeepAlive as a dict {SuccessfulExit:false} (restart on crash, NOT on a
 *     clean operator unload — service-grade vs the tunnel's bare <true/>)
 *   - PATH prepends dirname(node) so node-spawned children resolve under
 *     launchd's bare environment
 *   - ATLAS_HOME (launchd does NOT inherit the shell env) + optional ATLAS_PORT
 */
export function buildAtlasPlist(opts: PlistOpts): string {
    const { label, repoRoot, nodePath, entryArgs, atlasHome, port } = opts;
    const programArgs = [nodePath, ...entryArgs];
    const stdoutPath = path.join(atlasHome, 'daemon.log');
    const stderrPath = path.join(atlasHome, 'daemon.err');
    const pathEnv = `${dirname(nodePath)}:${BASE_PATH}`;

    const env: Record<string, string> = {
        PATH: pathEnv,
        ATLAS_HOME: atlasHome,
        // RD-auth-on — the standalone/launchd daemon ships with inbound `/mcp`
        // auth ON (the default; ATLAS_MCP_AUTH intentionally UNset here). Binding
        // 127.0.0.1 + the Host/Origin allow-lists stop a malicious web page, but
        // NOT another local process (curl sends no Origin → allowed), so the
        // bearer token is the only real control against a co-resident process on
        // a shared machine. Clients present the auto-minted `<ATLAS_HOME>/mcp.token`
        // (0600): IDE clients via `atlas mcp-config`, the CLI's daemon routing via
        // readMcpAuthToken(). (The desktop Tauri app still spawns its OWN daemon
        // with auth off pending the frontend token-wiring — a separate change
        // tracked with the packaging work; it does not affect this daemon.)
        // Run Lore's native search store in a crash-isolated child process
        // (Lore ff4c30b). Atlas is the "daemon must never die" case: if a search
        // segfaults the native layer, only the worker restarts — the daemon (and
        // the whole UI/MCP surface) stays up. Small IPC overhead, big resilience.
        LORE_SEARCH_WORKER: '1',
    };
    if (typeof port === 'number') env.ATLAS_PORT = String(port);

    const progXml = programArgs
        .map((a) => `        <string>${xmlEscape(a)}</string>`)
        .join('\n');
    const envXml = Object.entries(env)
        .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  ${label}.plist — LaunchAgent for the Atlas code-intelligence daemon.
  Generated by 'atlas service install' (mode: ${opts.mode}). Do not hand-edit;
  re-run 'atlas service install' to regenerate.
-->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>

    <key>ProgramArguments</key>
    <array>
${progXml}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(repoRoot)}</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>

    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

// ── effectful: install / uninstall / status ──────────────────────────────────

export interface ServiceResult {
    ok: boolean;
    /** machine-readable outcome envelope (also what the CLI prints). */
    [k: string]: unknown;
}

/** macOS guard. Returns an error result when not darwin, else null. */
function darwinGuard(command: string): ServiceResult | null {
    if (process.platform !== 'darwin') {
        return {
            ok: false,
            command: `service.${command}`,
            error: `'service' uses macOS LaunchAgents and is only supported on macOS (got platform '${process.platform}').`,
        };
    }
    return null;
}

/** The numeric uid launchctl's modern gui/<uid> domain wants. */
function currentUid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : 0;
}

export interface InstallOpts {
    /** Run the TypeScript entry via tsx instead of the built dist/daemon.js. */
    dev?: boolean;
    /** Optional port → ATLAS_PORT in the daemon env + recorded in status. */
    port?: number;
}

/**
 * Install + load the Atlas LaunchAgent. Idempotent: always unloads any existing
 * label first, then (re)writes the plist and `launchctl load -w`s it.
 *
 * Entry selection:
 *   default → dist/daemon.js (must exist; clear "run npm run build" error else)
 *   --dev   → node_modules/tsx/dist/cli.mjs + src/daemon.ts (both must exist)
 */
export function installService(opts: InstallOpts = {}, deps?: Partial<ServiceDeps>): ServiceResult {
    const guard = darwinGuard('install');
    if (guard) return guard;

    const d = resolveDeps(deps);
    const repoRoot = resolveRepoRoot();
    const nodePath = process.execPath;

    // ── pick + preflight the entry ───────────────────────────────────────────
    let mode: 'built' | 'dev';
    let entryArgs: string[];
    if (opts.dev) {
        mode = 'dev';
        // SINGLE-PROCESS tsx: run the loader IN the node process via
        // `--require preflight.cjs --import loader.mjs daemon.ts`, NOT via the
        // `tsx` CLI wrapper. The wrapper double-forks (it spawns a child node),
        // so launchd tracks the wrapper while the real daemon runs detached —
        // `launchctl unload` then orphans the daemon (it keeps the port + DB
        // handle), which is the "daemon won't die / restart" failure mode. The
        // --import form keeps everything in ONE launchd-tracked process.
        const preflight = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
        const loader = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
        const daemonTs = path.join(repoRoot, 'src', 'daemon.ts');
        if (!fs.existsSync(loader) || !fs.existsSync(preflight)) {
            return {
                ok: false,
                command: 'service.install',
                error: `tsx loader not found under ${path.dirname(loader)} — run 'npm install' first (needed for --dev).`,
            };
        }
        if (!fs.existsSync(daemonTs)) {
            return { ok: false, command: 'service.install', error: `daemon source not found at ${daemonTs}.` };
        }
        // --import needs a file:// URL; --require takes a plain path.
        const loaderUrl = `file://${loader}`;
        entryArgs = ['--require', preflight, '--import', loaderUrl, daemonTs];
    } else {
        mode = 'built';
        const daemonJs = path.join(repoRoot, 'dist', 'daemon.js');
        if (!fs.existsSync(daemonJs)) {
            return {
                ok: false,
                command: 'service.install',
                error: `dist/daemon.js not found at ${daemonJs} — run 'npm run build' first, ` +
                    `or use 'atlas service install --dev' to run the TypeScript entry via tsx.`,
            };
        }
        entryArgs = [daemonJs];
    }

    // Ensure ATLAS_HOME exists so launchd can create daemon.log / daemon.err.
    // ATLAS_HOME holds config.json (apiKeys), the mcp/auth token files, and the
    // lore-data code graph — create it owner-only. mkdir's mode is umask-subject,
    // so chmod afterward is authoritative and also hardens an already-existing
    // 0755 dir from a prior install. Best-effort but visible.
    fs.mkdirSync(d.home, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(d.home, 0o700);
    } catch (err) {
        console.error(`[atlas] warning: failed to chmod ATLAS_HOME (${d.home}) to 0700: ${(err as Error).message}`);
    }

    const plist = buildAtlasPlist({
        label: ATLAS_LABEL,
        repoRoot,
        nodePath,
        mode,
        entryArgs,
        atlasHome: d.home,
        ...(typeof opts.port === 'number' ? { port: opts.port } : {}),
    });

    const plistPath = path.join(d.launchAgentsDir, ATLAS_PLIST_NAME);

    // Idempotent: unload any prior instance (swallow non-zero = "wasn't loaded").
    d.exec('launchctl', ['unload', plistPath]);

    fs.mkdirSync(d.launchAgentsDir, { recursive: true });
    fs.writeFileSync(plistPath, plist, { mode: 0o644 });

    // load -w clears the Disabled flag the tunnel template documents.
    const load = d.exec('launchctl', ['load', '-w', plistPath]);
    const loaded = load.status === 0;

    return {
        ok: loaded,
        command: 'service.install',
        label: ATLAS_LABEL,
        mode,
        plistPath,
        programArguments: [nodePath, ...entryArgs],
        repoRoot,
        home: d.home,
        ...(typeof opts.port === 'number' ? { port: opts.port } : {}),
        loaded,
        ...(loaded ? {} : { loadStatus: load.status, loadStderr: load.stderr.trim() }),
        hint: loaded
            ? `Atlas daemon installed + loaded. Logs: ${path.join(d.home, 'daemon.err')}`
            : `plist written but 'launchctl load' returned ${load.status}; check ${plistPath}`,
    };
}

/** Unload + remove the LaunchAgent. Reports whether the plist existed. */
export function uninstallService(deps?: Partial<ServiceDeps>): ServiceResult {
    const guard = darwinGuard('uninstall');
    if (guard) return guard;

    const d = resolveDeps(deps);
    const plistPath = path.join(d.launchAgentsDir, ATLAS_PLIST_NAME);
    const existed = fs.existsSync(plistPath);

    // Unload first (swallow non-zero = "wasn't loaded"), then remove the file.
    d.exec('launchctl', ['unload', plistPath]);
    fs.rmSync(plistPath, { force: true });

    return {
        ok: true,
        command: 'service.uninstall',
        label: ATLAS_LABEL,
        plistPath,
        removed: existed,
        hint: existed ? 'LaunchAgent unloaded + removed.' : 'No LaunchAgent plist was present (nothing to remove).',
    };
}

export interface ServiceStatus extends ServiceResult {
    installed: boolean;
    loaded: boolean;
    pid?: number;
    lastExitStatus?: number;
}

/**
 * Parse `launchctl list <label>` output. Returns {} when not loaded (launchctl
 * exits non-zero / prints "Could not find service"). Pure string parsing of the
 * injected exec output ⇒ unit-testable with canned fixtures.
 */
function parseLaunchctlList(res: ExecResult): { loaded: boolean; pid?: number; lastExitStatus?: number } {
    if (res.status !== 0) return { loaded: false };
    const out = res.stdout;
    if (/Could not find service/i.test(out)) return { loaded: false };
    const pidMatch = /"PID"\s*=\s*(\d+)/.exec(out);
    const exitMatch = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(out);
    const status: { loaded: boolean; pid?: number; lastExitStatus?: number } = { loaded: true };
    if (pidMatch) status.pid = Number(pidMatch[1]);
    if (exitMatch) status.lastExitStatus = Number(exitMatch[1]);
    return status;
}

/** Report plist presence + launchctl load state. */
export function serviceStatus(deps?: Partial<ServiceDeps>): ServiceStatus {
    const guard = darwinGuard('status');
    if (guard) return { ...guard, installed: false, loaded: false } as ServiceStatus;

    const d = resolveDeps(deps);
    const plistPath = path.join(d.launchAgentsDir, ATLAS_PLIST_NAME);
    const installed = fs.existsSync(plistPath);

    const res = d.exec('launchctl', ['list', ATLAS_LABEL]);
    const parsed = parseLaunchctlList(res);

    return {
        ok: true,
        command: 'service.status',
        label: ATLAS_LABEL,
        plistPath,
        installed,
        loaded: parsed.loaded,
        ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
        ...(parsed.lastExitStatus !== undefined ? { lastExitStatus: parsed.lastExitStatus } : {}),
    };
}

/** Convenience: ATLAS_HOME from config (the CLI wrapper uses this for `home`). */
export function configuredHome(): string {
    try {
        return loadConfig().home;
    } catch {
        return defaultHome();
    }
}

/** The numeric uid (exported for callers that build a gui/<uid> domain target). */
export { currentUid };
