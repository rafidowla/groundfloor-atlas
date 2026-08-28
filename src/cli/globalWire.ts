/**
 * cli/globalWire.ts — `atlas wire install --global`: machine-wide hook install
 * (Atlas auto-wire Part 3, docs/plans/ATLAS-AUTOWIRE-PLAN.md).
 *
 * WHY. `atlas wire install` (cli/wire.ts) bakes the workspace name into each
 * repo's OWN .claude/settings.json hook command at install time, so every new
 * project needs its own `atlas wire install` run — nobody remembers, and two
 * live examples were found unwired 2026-08-22 (this repo itself, and
 * groundfloor-lore pointing at the wrong workspace). Part 1's path->workspace
 * resolver (src/pathWorkspaceResolver.ts) plus Part 2's workspace-less hook
 * client (scripts/atlas-hook.mjs sends `cwd`; src/mcp/server.ts resolves it
 * server-side when no explicit workspace is present) together make ONE
 * machine-wide hook possible. This module installs it once into the user's
 * GLOBAL Claude Code settings (`~/.claude/settings.json`, whose `hooks` key
 * already exists and starts empty) instead of a per-repo file, so every
 * project — past, present, future — gets Atlas context with no per-repo step.
 *
 * DE-DUP (no double-firing). A repo that already ran plain `atlas wire
 * install` has its OWN .claude/settings.json with an Atlas hook that bakes an
 * explicit workspace — that command keeps firing exactly as before. The
 * global hook installed here must NOT ALSO fire for that same repo, or the
 * agent sees the same nudge twice. Rather than reaching into every registered
 * repo's local settings.json to strip its hook — invasive, and this module
 * does not own those files — the fix lives in the hook CLIENT:
 * scripts/atlas-hook.mjs, invoked with NO workspace argv (exactly what
 * `globalHookCmd` below writes — the unambiguous signature of a global-hook
 * invocation, since every per-repo install always bakes a non-empty,
 * slug-validated workspace), checks whether its cwd already has a local
 * Atlas-owned hook (.claude/settings.json containing HOOK_TAG) and, if so,
 * stays silent — the local hook already covers that repo. See that file's own
 * header comment for the mechanism; tests/global-wire.test.ts proves exactly
 * one invocation reaches the daemon per event when both are installed.
 *
 * SAFETY. Same bar as cli/ideConnect.ts's applyOne(): back up the file first
 * (if it exists), merge — never clobber — so every key outside
 * `hooks.PreToolUse` / `hooks.PostToolUse`'s Atlas-owned entries is left
 * exactly alone (including any OTHER tool's hook entries already present),
 * and chmod 0600 to match that file's convention. Nothing secret actually
 * lives in this file — the hook command only names a local script path and an
 * event string — the permission is kept for consistency, not because it
 * guards a credential.
 *
 * Idempotent: re-running strips the entries a prior `--global` install added
 * (by HOOK_TAG) before re-adding them, so the result is stable rather than
 * accumulating duplicate entries on every run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRoot as atlasRepoRoot } from './service.js';
import { HOOK_TAG } from './wire.js';

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }
interface Settings { hooks?: { PreToolUse?: HookEntry[]; PostToolUse?: HookEntry[]; [k: string]: HookEntry[] | undefined }; [k: string]: unknown }

interface WireResult { ok: boolean; [k: string]: unknown }

export interface GlobalWireOpts {
    /** Override for tests — the directory whose .claude/settings.json is the
     *  target. Defaults to the real machine home (os.homedir()). Never used
     *  by the CLI; production callers always take the default. */
    home?: string;
}

/** Absolute path to the GLOBAL Claude Code settings file this module writes
 *  into — NOT a per-repo .claude/settings.json (cli/wire.ts owns those). */
export function globalSettingsPath(home?: string): string {
    return path.join(home ?? os.homedir(), '.claude', 'settings.json');
}

function globalHookCmd(atlasRoot: string, event: string): string {
    // Deliberately NO workspace positional — see this module's header and
    // scripts/atlas-hook.mjs's header for why that absence is exactly what
    // makes this the machine-wide hook (both the server-side cwd resolution
    // and the client-side de-dup key off it).
    return `node ${path.join(atlasRoot, 'scripts', 'atlas-hook.mjs')} ${event}`;
}

function readSettings(file: string): Settings {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as Settings; // throws on malformed — caller guards
}

function backup(file: string): string | null {
    if (!fs.existsSync(file)) return null;
    const bak = `${file}.bak-groundfloor-atlas-${Date.now()}`;
    fs.copyFileSync(file, bak);
    return bak;
}

/** Drop every Atlas-owned hook entry (matched by command substring) from an
 *  event array, returning the survivors. Mirrors cli/wire.ts's
 *  stripAtlasHooks but kept local: this operates on the GLOBAL settings file,
 *  never a repo's own .claude/settings.json, and the two must never be
 *  conflated. */
function stripAtlasHooks(entries: HookEntry[] | undefined): HookEntry[] {
    return (entries ?? []).filter((e) => !(e.hooks ?? []).some((h) => h.command?.includes(HOOK_TAG)));
}

/** `atlas wire install --global` — merge the Atlas PreToolUse/PostToolUse/Stop
 *  hook entries into ~/.claude/settings.json. */
export function installGlobalWire(opts: GlobalWireOpts = {}): WireResult {
    const home = opts.home ?? os.homedir();
    const atlasRoot = atlasRepoRoot();
    const file = globalSettingsPath(home);

    let s: Settings;
    try {
        s = readSettings(file);
    } catch {
        return { ok: false, error: `existing global settings is not valid JSON (left untouched): ${file}` };
    }

    const bak = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (typeof s.hooks !== 'object' || s.hooks === null || Array.isArray(s.hooks)) s.hooks = {};

    const pre = stripAtlasHooks(s.hooks.PreToolUse);
    pre.push({ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: globalHookCmd(atlasRoot, 'pre-search') }] });
    pre.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: globalHookCmd(atlasRoot, 'pre-edit') }] });
    s.hooks.PreToolUse = pre;

    const post = stripAtlasHooks(s.hooks.PostToolUse);
    post.push({ matcher: 'Bash', hooks: [{ type: 'command', command: globalHookCmd(atlasRoot, 'post-bash') }] });
    s.hooks.PostToolUse = post;

    // WO-4 session-end capture — same no-workspace-positional rule as the
    // other global entries: the daemon resolves the workspace from cwd, and
    // the client-side de-dup keeps a wired repo's own Stop hook authoritative.
    const stop = stripAtlasHooks(s.hooks.Stop);
    stop.push({ hooks: [{ type: 'command', command: globalHookCmd(atlasRoot, 'session-end') }] });
    s.hooks.Stop = stop;

    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    // `mode` on writeFileSync only applies on CREATE — a pre-existing file
    // keeps its old perms otherwise. chmod authoritatively tightens it every
    // time, mirroring cli/ideConnect.ts's applyOne().
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }

    return {
        ok: true,
        command: 'wire.install.global',
        settingsFile: file,
        backup: bak,
        hint: `Machine-wide Atlas hooks installed into ${file}. Restart the IDE (or reload hooks) so every project gets Atlas context — wired or not. Already-wired repos are unaffected: their local hook keeps firing and this global one steps aside for them.`,
    };
}

/** `atlas wire uninstall --global` — the Part 6 counterpart to
 *  `installGlobalWire`: strip the Atlas-owned PreToolUse/PostToolUse/Stop
 *  hook entries this module added from ~/.claude/settings.json, leaving every
 *  other key (including any OTHER tool's hooks) exactly alone. Same
 *  merge-never-clobber discipline as install: back up before an in-place
 *  edit, refuse on malformed JSON rather than guessing, chmod 0600 after.
 *  A missing file or a file with no Atlas entries is a no-op success
 *  (removed:false) — uninstalling something that was never installed isn't
 *  an error, mirroring cli/wire.ts's removeSettings/uninstallWire. */
export function uninstallGlobalWire(opts: GlobalWireOpts = {}): WireResult {
    const home = opts.home ?? os.homedir();
    const file = globalSettingsPath(home);

    if (!fs.existsSync(file)) {
        return {
            ok: true,
            command: 'wire.uninstall.global',
            settingsFile: file,
            backup: null,
            removed: false,
            hint: `No global settings file at ${file} — nothing to remove.`,
        };
    }

    let s: Settings;
    try {
        s = readSettings(file);
    } catch {
        return { ok: false, error: `existing global settings is not valid JSON (left untouched): ${file}` };
    }

    if (typeof s.hooks !== 'object' || s.hooks === null || Array.isArray(s.hooks)) {
        return {
            ok: true,
            command: 'wire.uninstall.global',
            settingsFile: file,
            backup: null,
            removed: false,
            hint: `No Atlas hooks present in ${file} — nothing to remove.`,
        };
    }

    const preBefore = s.hooks.PreToolUse ?? [];
    const postBefore = s.hooks.PostToolUse ?? [];
    const stopBefore = s.hooks.Stop ?? [];
    const hadAtlas =
        preBefore.some((e) => (e.hooks ?? []).some((h) => h.command?.includes(HOOK_TAG))) ||
        postBefore.some((e) => (e.hooks ?? []).some((h) => h.command?.includes(HOOK_TAG))) ||
        stopBefore.some((e) => (e.hooks ?? []).some((h) => h.command?.includes(HOOK_TAG)));
    if (!hadAtlas) {
        return {
            ok: true,
            command: 'wire.uninstall.global',
            settingsFile: file,
            backup: null,
            removed: false,
            hint: `No Atlas hooks present in ${file} — nothing to remove.`,
        };
    }

    const bak = backup(file);

    s.hooks.PreToolUse = stripAtlasHooks(s.hooks.PreToolUse);
    s.hooks.PostToolUse = stripAtlasHooks(s.hooks.PostToolUse);
    s.hooks.Stop = stripAtlasHooks(s.hooks.Stop);
    for (const k of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
        if (s.hooks[k] && s.hooks[k]!.length === 0) delete s.hooks[k];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;

    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    // Same reasoning as installGlobalWire: `mode` on writeFileSync only
    // applies on CREATE, and this path always edits a pre-existing file, so
    // chmod authoritatively tightens it every time.
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }

    return {
        ok: true,
        command: 'wire.uninstall.global',
        settingsFile: file,
        backup: bak,
        removed: true,
        hint: `Removed the machine-wide Atlas hook from ${file}. Restart the IDE (or reload hooks) so the change takes effect.`,
    };
}
