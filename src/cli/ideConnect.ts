/**
 * cli/ideConnect.ts — `atlas connect` / `atlas disconnect`.
 *
 * The write-side counterpart to `atlas mcp-config` (which only PRINTS): detect
 * installed MCP clients and MERGE the Groundfloor Atlas server entry into their config
 * files (with the auth token + the actual running port) — JSON clients through the
 * applyOne engine below, Codex's TOML config through the targeted merger in the
 * "Codex TOML" section. OMP is not an MCP client at all: `connect omp` installs
 * the advisory hook (script + `extensions:` registration) through the "OMP hook"
 * section. Merge, never clobber; back up first; `disconnect` removes
 * the Groundfloor Atlas entry (and any pre-rename legacy-named one — see
 * SERVER_KEY/LEGACY_KEYS below).
 *
 * This is the shared core the desktop app's one-click "Connect" button calls too
 * (via a Tauri command) — keep the per-client writers here so GUI + CLI agree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureMcpAuthToken, loadConfig, mcpAuthEnabled } from '../config.js';
import { OMP_HOOK_FILENAME, OMP_HOOK_SOURCE } from './ompHook.js';

type ClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'opencode' | 'antigravity' | 'zcode' | 'vscode' | 'omp';

interface ClientSpec {
    id: ClientId;
    label: string;
    /** Absolute config file path, or null if this platform can't resolve one. */
    configPath: () => string | null;
    /** Top-level key holding the server map (or parent object when serversSubKey is
     *  set). For TOML-format clients (codex), the root table name instead —
     *  `[<serversKey>.<SERVER_KEY>]`. For the OMP hook client (omp), the YAML
     *  block-list key in config.yml (`extensions:`) instead. VS Code uses
     *  `servers` (NOT `mcpServers` — its docs call copying Cursor's shape in a
     *  config error). */
    serversKey: 'mcpServers' | 'mcp' | 'mcp_servers' | 'extensions' | 'servers';
    /** Optional second-level key (e.g. ZCode stores servers at cfg.mcp.servers). */
    serversSubKey?: string;
    /** Workspace-scoped client (vscode): configPath resolves against the CLI's
     *  cwd (the project root the command runs in), not the home dir. There is
     *  no global file to write — see the vscode spec. */
    workspaceScoped?: boolean;
    /** VS Code-only: the top-level `inputs:` array entry managed ALONGSIDE the
     *  server entry (the entry's ${input:<id>} placeholder references it).
     *  Matched by id — connect replaces ours with the canonical shape,
     *  disconnect removes ours, other inputs are never touched. */
    inputEntry?: { type: 'promptString'; id: string; description: string; password?: boolean };
    /** The written entry carries NO secret (vscode's ${input:} placeholder is
     *  all that lands in the file) and the file is meant to be committed —
     *  keep normal 0644 perms instead of the 0600 tighten the token-embedding
     *  clients get. */
    committable?: boolean;
    /** Build the Groundfloor Atlas server entry (see SERVER_KEY). Unused by
     *  clients whose apply path is fully bespoke (omp's hook script needs
     *  neither url nor token — it resolves both at runtime). */
    entry?: (url: string, token: string) => Record<string, unknown>;
    /** Heuristic: is the client installed (so `connect all` can skip absent ones)? */
    installed: () => boolean;
    /** No reliable writable config path — print instructions instead of writing. */
    printOnly?: boolean;
    /** TOML-format config (codex): route through the targeted TOML merger
     *  (applyToml) instead of the JSON read/merge/write below. 'omp' routes
     *  through the hook installer (applyOmp) instead. */
    format?: 'toml' | 'omp';
}

const home = os.homedir();

// RD-groundfloor-atlas-key-rename — the MCP server entry key IDE configs are written
// under. Was 'atlas'; every connected IDE reports the server by this key (not
// by anything the daemon self-reports), so agents were displaying "Atlas" even
// though the product is Groundfloor Atlas. LEGACY_KEYS lists every prior name a config
// on an already-connected machine might still have — applyOne ALWAYS deletes
// these before writing SERVER_KEY (connect) or in addition to it (disconnect),
// so re-running `connect`/`disconnect` self-heals a pre-rename config into the
// new key with no leftover duplicate entry, and disconnect cleans up regardless
// of which key a config happens to have.
const SERVER_KEY = 'groundfloor-atlas';
// Typed as string[] (not `as const`) so a `k !== SERVER_KEY` guard stays a
// real runtime check rather than a statically-disjoint literal comparison —
// defensive against a future edit adding SERVER_KEY's own value here by
// mistake, in which case the guard's intent (never treat "migrating from
// itself" as a migration) still matters.
const LEGACY_KEYS: readonly string[] = ['atlas', 'lorebase'];

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
// RD-Mtoken-argv — keep the bearer OUT of the spawned process's argv (visible
// in `ps`). mcp-remote expands `${VAR}` in --header values, so we reference an
// env var in the header and supply the secret via the entry's `env` block.
const ATLAS_TOKEN_ENV = 'ATLAS_MCP_TOKEN';
const bridgeArgs = (url: string) => ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer \${${ATLAS_TOKEN_ENV}}`];

function claudeDesktopConfigPath(): string | null {
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
    if (process.platform === 'linux') return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    return null;
}

// VS Code's documented secret indirection: the id of the password-masked
// promptString entry connect manages in .vscode/mcp.json's top-level
// `inputs:` array; the server entry's Authorization header references it as
// ${input:groundfloor-atlas-token} so the bearer never lands in the file.
const VSCODE_INPUT_ID = 'groundfloor-atlas-token';

/** VS Code's mcp.json is workspace-scoped: <cwd>/.vscode/mcp.json. Null when
 *  cwd is the filesystem root or the home dir — neither is a workspace, and
 *  the daemon's HTTP connect path (a launchd-started daemon sits in /) must
 *  skip honestly instead of writing a stray config VS Code would never read.
 *  Both sides are realpath'd first: process.cwd() reports the real path while
 *  $HOME may traverse a symlink (macOS /var → /private/tmpdirs), and a plain
 *  string compare then misses "cwd IS home" entirely. */
function vscodeMcpConfigPath(): string | null {
    const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    const cwd = real(process.cwd());
    if (cwd === path.parse(cwd).root || cwd === real(home)) return null;
    return path.join(cwd, '.vscode', 'mcp.json');
}

const SPECS: ClientSpec[] = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        configPath: () => path.join(home, '.claude.json'),
        serversKey: 'mcpServers',
        entry: (url, token) => ({ type: 'http', url, headers: authHeader(token) }),
        installed: () => fs.existsSync(path.join(home, '.claude.json')) || fs.existsSync(path.join(home, '.claude')),
    },
    {
        id: 'cursor',
        label: 'Cursor',
        configPath: () => path.join(home, '.cursor', 'mcp.json'),
        serversKey: 'mcpServers',
        entry: (url, token) => ({ url, headers: authHeader(token) }),
        installed: () => fs.existsSync(path.join(home, '.cursor')),
    },
    {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        configPath: claudeDesktopConfigPath,
        serversKey: 'mcpServers',
        // Desktop is stdio-only → mcp-remote bridge to the HTTP endpoint.
        // Token rides in `env` (not argv) so it isn't exposed in `ps`.
        entry: (url, token) => ({ command: 'npx', args: bridgeArgs(url), env: { [ATLAS_TOKEN_ENV]: token } }),
        installed: () => { const p = claudeDesktopConfigPath(); return p ? fs.existsSync(path.dirname(p)) : false; },
    },
    {
        id: 'codex',
        label: 'Codex',
        // TOML config — the ONE client that isn't JSON, routed through the
        // targeted TOML merger (applyToml) instead of the JSON path below.
        // Entry mirrors claude-desktop: stdio-only → mcp-remote bridge, with
        // the bearer in the entry's env subtable (not argv).
        configPath: () => path.join(home, '.codex', 'config.toml'),
        format: 'toml',
        serversKey: 'mcp_servers',
        entry: (url, token) => ({ command: 'npx', args: bridgeArgs(url), env: { [ATLAS_TOKEN_ENV]: token } }),
        installed: () => fs.existsSync(path.join(home, '.codex')),
    },
    {
        id: 'opencode',
        label: 'opencode',
        configPath: () => path.join(home, '.config', 'opencode', 'opencode.json'),
        serversKey: 'mcp',
        entry: (url, token) => ({ type: 'remote', url, headers: authHeader(token), enabled: true }),
        installed: () => fs.existsSync(path.join(home, '.config', 'opencode')),
    },
    {
        id: 'antigravity',
        label: 'Antigravity',
        // No stable, documented config path to write — print the block instead.
        configPath: () => null,
        serversKey: 'mcpServers',
        entry: (url, token) => ({ url, headers: authHeader(token) }),
        installed: () => true,
        printOnly: true,
    },
    {
        id: 'zcode',
        label: 'ZCode',
        // ZCode CLI agent MCP config: ~/.zcode/cli/config.json, key path mcp.servers
        configPath: () => path.join(home, '.zcode', 'cli', 'config.json'),
        serversKey: 'mcp',
        serversSubKey: 'servers',
        // Headers stored as plain object in the file; ZCode converts via Object.entries() to [{name,value}] for sessions.
        entry: (url, token) => ({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } }),
        installed: () => fs.existsSync(path.join(home, '.zcode')),
    },
    {
        id: 'vscode',
        label: 'VS Code',
        // The ONE workspace-scoped client. VS Code's only officially
        // documented concrete mcp.json path is <workspace>/.vscode/mcp.json
        // (code.visualstudio.com/docs/agents/reference/mcp-configuration);
        // the user-profile mcp.json is opened via the "MCP: Open User
        // Configuration" command instead of a stable path — every VS Code
        // profile keeps its own — so unlike cursor/zcode there is no reliable
        // global file to write. Resolved against the CLI's cwd (the project
        // root), the same workspace convention `atlas wire` uses.
        workspaceScoped: true,
        configPath: vscodeMcpConfigPath,
        // VS Code reads `servers` (NOT `mcpServers` — its docs call pasting
        // Cursor's shape in a config error).
        serversKey: 'servers',
        // RD-Mtoken-ide exemption: the workspace file is meant to be
        // committed (VS Code's docs recommend source-controlling it), so the
        // bearer must NOT land in it. Instead VS Code's documented secret
        // pattern: a password-masked promptString in the top-level `inputs:`
        // array + a ${input:...} placeholder in the header. VS Code prompts
        // for the token once on first server start and caches the value in
        // its secret storage, so the token still reaches the daemon at
        // connection time. (Docs caveat: VS Code's Agent Host skips
        // ${input:}-style servers — the entry serves Copilot Chat on the
        // extension host.) The token arg is deliberately unused.
        entry: (url) => ({ type: 'http', url, headers: { Authorization: `Bearer \${input:${VSCODE_INPUT_ID}}` } }),
        inputEntry: {
            type: 'promptString',
            id: VSCODE_INPUT_ID,
            description: 'Groundfloor Atlas MCP token (print it: atlas mcp-config --show-token)',
            password: true,
        },
        // No secret is ever written (the ${input:} placeholder is all that
        // lands in the file) and the file is designed to be committed — keep
        // normal 0644 perms, no 0600 tighten.
        committable: true,
        installed: () => {
            const marks = [
                path.join(home, 'Library', 'Application Support', 'Code'),
                path.join(home, '.config', 'Code'),
                path.join(home, '.vscode'),
                path.join(home, '.vscode-server'),
            ];
            if (process.env.APPDATA) marks.push(path.join(process.env.APPDATA, 'Code'));
            return marks.some((p) => fs.existsSync(p));
        },
    },
    {
        id: 'omp',
        label: 'OMP (Oh My Pi)',
        // Not an MCP client — connect installs the advisory HOOK instead: the
        // versioned script from cli/ompHook.ts copied to
        // ~/.omp/agent/hooks/pre/atlas-consult.ts, plus its path appended to
        // the `extensions:` block list in config.yml (OMP never loads a hook
        // file that isn't registered there). Routed through applyOmp, which
        // needs neither url nor token — the hook resolves both at runtime.
        configPath: () => path.join(home, '.omp', 'agent', 'config.yml'),
        format: 'omp',
        serversKey: 'extensions',
        installed: () => fs.existsSync(path.join(home, '.omp', 'agent')),
    },
];

const byId = new Map(SPECS.map((s) => [s.id, s]));

function readJson(file: string): Record<string, unknown> {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>; // throws on malformed — caller guards
}

function backup(file: string): string | null {
    if (!fs.existsSync(file)) return null;
    const bak = `${file}.bak-groundfloor-atlas-${Date.now()}`;
    fs.copyFileSync(file, bak);
    return bak;
}

// ── Codex TOML: targeted read / merge / write ─────────────────────────────
//
// ~/.codex/config.toml is TOML and shares nothing with the JSON clients above.
// This repo carries no TOML dependency and its house style is hand-rolled
// targeted parsing (wire.ts's line-scanner, groupYaml.ts's YAML-subset
// quoting), so this is a MINIMAL merger that understands exactly the shape
// `connect codex` produces: a `[<root>.<name>]` table plus optional nested
// `[<root>.<name>.env]` subtable. Every byte outside those tables is preserved
// verbatim, and any construct the scanner cannot PROVE it understood makes
// the whole operation fail closed with the file untouched — same contract as
// readJson's throw on malformed JSON. Never guess-overwrite a config file
// you can't parse.

/** One header-delimited region of a config.toml: from a table header line's
 *  first byte up to the next table header (or EOF) — the header, its
 *  key-value body, and any trailing blank lines. */
interface TomlRegion { path: string[]; start: number; end: number }

/** Scan TOML text into table regions. Understands bare-key dotted headers,
 *  key = value bodies, comments, basic/literal strings (incl. multi-line),
 *  and multi-line arrays/inline tables. Returns null on ANY construct it
 *  cannot prove it understood — unterminated header, unterminated string,
 *  unclosed array/inline table, quoted or array-of-table ([[x]]) headers,
 *  stray closers — so callers fail closed instead of guessing at offsets. */
function scanTomlRegions(text: string): TomlRegion[] | null {
    const regions: TomlRegion[] = [];
    let inBasic: false | '"' | '"""' = false;   // inside a basic ("…") string
    let inLiteral: false | "'" | "'''" = false; // inside a literal ('…') string
    let depth = 0;                              // open [/{ from a multi-line array/inline-table value
    let pos = 0;
    while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        const raw = text.slice(pos, nl === -1 ? text.length : nl);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // tolerate CRLF files
        // A header is only recognized at the top level (no open value, no
        // open string) — inside a multi-line array a `[`-leading line is a
        // continuation, not a table.
        if (!inBasic && !inLiteral && depth === 0) {
            const t = line.trimStart();
            if (t.startsWith('[')) {
                const m = /^\[\s*([A-Za-z0-9_.-]+)\s*\][ \t]*(?:#.*)?$/.exec(t);
                if (!m) return null;
                if (regions.length > 0) regions[regions.length - 1]!.end = pos;
                regions.push({ path: m[1]!.split('.'), start: pos, end: text.length });
            }
        }
        for (let i = 0; i < line.length; i++) {
            const c = line[i]!;
            if (inBasic !== false) {
                if (c === '\\') { i++; continue; } // escaped char (basic strings only)
                if (c === '"') {
                    if (inBasic === '"') inBasic = false;
                    else if (line.startsWith('"""', i)) { inBasic = false; i += 2; }
                }
                continue;
            }
            if (inLiteral !== false) {
                if (c === "'") {
                    if (inLiteral === "'") inLiteral = false;
                    else if (line.startsWith("'''", i)) { inLiteral = false; i += 2; }
                }
                continue;
            }
            if (c === '#') break; // comment runs to end of line
            if (c === '"') { inBasic = line.startsWith('"""', i) ? '"""' : '"'; continue; }
            if (c === "'") { inLiteral = line.startsWith("'''", i) ? "'''" : "'"; continue; }
            if (c === '[' || c === '{') { depth++; continue; }
            if (c === ']' || c === '}') { if (depth === 0) return null; depth--; }
        }
        // Single-line strings may not span lines; multi-line strings and
        // open arrays legitimately do.
        if (inBasic === '"' || inLiteral === "'") return null;
        pos = nl === -1 ? text.length : nl + 1;
    }
    if (depth !== 0 || inBasic === '"""' || inLiteral === "'''") return null; // unclosed at EOF
    return regions;
}

/** Regions belonging to the Groundfloor Atlas server entry: `[root.<key>]`
 *  (and any deeper subtable, e.g. its `.env`) where key is the current
 *  SERVER_KEY or a pre-rename LEGACY_KEYS name. */
function ourTomlRegions(regions: TomlRegion[], rootKey: string): TomlRegion[] {
    const keys = [SERVER_KEY, ...LEGACY_KEYS];
    return regions.filter((r) => r.path[0] === rootKey && r.path.length >= 2 && keys.includes(r.path[1]!));
}

/** Render the server entry as the exact TOML block `connect` writes: the
 *  `[root.SERVER_KEY]` table plus its nested `.env` subtable. JSON.stringify's
 *  basic-string escaping is TOML-compatible for the values that occur here
 *  (command/args/token). The block ends with a trailing blank line so an
 *  in-place re-merge is byte-stable. */
function tomlServerBlock(rootKey: string, entry: Record<string, unknown>): string {
    const command = entry['command'];
    const args = entry['args'];
    const env = entry['env'];
    if (typeof command !== 'string' || !Array.isArray(args) || !args.every((a) => typeof a === 'string')
        || (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env)))) {
        // Statically unreachable with today's codex spec — guards a future edit.
        throw new Error('codex entry is not TOML-serializable');
    }
    const lines = [
        `[${rootKey}.${SERVER_KEY}]`,
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    ];
    if (env !== undefined) {
        lines.push('', `[${rootKey}.${SERVER_KEY}.env]`);
        for (const [k, v] of Object.entries(env as Record<string, unknown>)) lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
    return lines.join('\n') + '\n\n';
}

/** Rebuild `text` with `regions` (non-overlapping) removed and, when
 *  `insertAt` equals a removed region's start offset, `block` spliced in at
 *  that position. Bytes outside the removed regions are untouched. */
function spliceToml(text: string, regions: TomlRegion[], block: string | null, insertAt: number | null): string {
    const parts: string[] = [];
    let pos = 0;
    for (const r of [...regions].sort((a, b) => a.start - b.start)) {
        parts.push(text.slice(pos, r.start));
        if (block !== null && insertAt === r.start) parts.push(block);
        pos = r.end;
    }
    parts.push(text.slice(pos));
    return parts.join('');
}

/** The TOML twin of the JSON merge below (same backup / 0600 / legacy-key
 *  self-heal / fail-closed-on-unparseable contract; same Outcome shape). */
function applyToml(spec: ClientSpec, url: string, token: string, remove: boolean): Outcome {
    const file = spec.configPath()!;
    let text = '';
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    const regions = text ? scanTomlRegions(text) : [];
    if (regions === null) {
        return { id: spec.id, status: 'failed', detail: `existing config is not TOML this writer can safely target (left untouched): ${file}` };
    }
    const ours = ourTomlRegions(regions, spec.serversKey);
    const presentKeys = [...new Set(ours.map((r) => r.path[1]!))];

    if (remove) {
        if (presentKeys.length === 0) return { id: spec.id, status: 'skipped', detail: `no ${SERVER_KEY} entry present` };
        const bak = backup(file);
        let out = spliceToml(text, ours, null, null);
        if (ours[ours.length - 1]!.end === text.length) {
            // Our block ran to EOF, so the blank separator/trailing lines its
            // removal strands at EOF are ours too — collapse them to a single
            // terminating newline so disconnect restores a pre-connect file
            // byte-for-byte (a TOML file conventionally ends with a newline).
            out = out.replace(/(?:\n[ \t]*)+\n?$/, '\n');
        }
        fs.writeFileSync(file, out, { mode: 0o600 });
        // Same CREATE-only `mode` caveat as the JSON path — tighten to
        // owner-only regardless (the file has held the bearer token).
        try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
        return { id: spec.id, status: 'disconnected', detail: `removed ${presentKeys.join('/')} from ${file}${bak ? ` (backup ${path.basename(bak)})` : ''}` };
    }

    const block = tomlServerBlock(spec.serversKey, spec.entry!(url, token)); // entry! — omp (the only entry-less spec) routes to applyOmp, never here
    const bak = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Self-heal: replacing the whole SERVER_KEY range drops any legacy-named
    // table sitting alongside it, so re-running connect on an already-
    // connected machine migrates in place instead of leaving a stale
    // duplicate entry — mirroring the JSON path's migratedFrom handling.
    const migratedFrom = LEGACY_KEYS.filter((k) => presentKeys.includes(k) && k !== SERVER_KEY);
    let out: string;
    if (ours.length > 0) {
        out = spliceToml(text, ours, block, ours[0]!.start);
    } else if (text === '') {
        out = block;
    } else {
        // Appending a NEW table at EOF — guarantee exactly one blank line
        // separates it from whatever the file already ends with.
        const base = text.endsWith('\n') ? text : `${text}\n`;
        out = base.endsWith('\n\n') ? base + block : `${base}\n${block}`;
    }
    // RD-Mtoken-ide (TOML twin) — the .env subtable embeds the bearer token;
    // keep the file owner-only, CREATE or not.
    fs.writeFileSync(file, out, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    const migratedNote = migratedFrom.length ? ` (migrated from ${migratedFrom.join('/')})` : '';
    return { id: spec.id, status: 'connected', detail: `wrote ${SERVER_KEY} → ${file}${migratedNote}${bak ? ` (backup ${path.basename(bak)})` : ''}` };
}

/** Read-only half of the codex TOML support, for `atlas wire status`: does a
 *  config.toml text carry a Groundfloor Atlas (or legacy-named)
 *  `[mcp_servers.*]` entry? 'unknown' when the text can't be safely scanned —
 *  callers must not guess a verdict from it. */
export function codexMcpEntryPresent(tomlText: string): boolean | 'unknown' {
    const regions = scanTomlRegions(tomlText);
    if (regions === null) return 'unknown';
    return ourTomlRegions(regions, 'mcp_servers').length > 0;
}

// ── OMP hook: script install + targeted YAML `extensions:` editor ──────────
//
// OMP (Oh My Pi) is not an MCP client — `connect omp` installs the advisory
// HOOK: write the versioned hook script (cli/ompHook.ts) to
// ~/.omp/agent/hooks/pre/atlas-consult.ts and append its path to the
// `extensions:` block list in ~/.omp/agent/config.yml. OMP only ever loads
// hooks listed there (an unregistered file is inert), so BOTH halves are
// required — the exact contract cli/wire.ts's ompToolStatus verifies.
//
// config.yml is YAML and this repo still carries no YAML dependency (house
// style: hand-rolled targeted parsing — groupYaml.ts's subset, wire.ts's
// line-scanner), so this is a MINIMAL block-list editor that understands
// exactly one shape: a top-level `extensions:` key whose value is a
// block-style list of scalar items at one uniform indentation. Every byte
// outside the list is preserved verbatim, and any construct the scanner
// cannot PROVE it understood — an inline/flow-style value
// (`extensions: [a, b]`), a duplicate or nested `extensions:` key, a
// column-0 (same-indent) sequence style, items at mixed indentation — makes
// the whole operation fail closed with the file untouched: the same contract
// as scanTomlRegions above. Never guess-edit a config file you can't parse.

/** The `extensions:` block list as scanOmpExtensions understands it, with
 *  line indexes into the file's split('\n') array. */
interface OmpExtensionsBlock {
    keyIdx: number;
    /** Consecutive block-list item lines immediately after the key line. */
    itemIdxs: number[];
    /** The LAST item's literal prefix (indent + `- ` + spacing) — the exact
     *  form an appended line mirrors. Null when the key has no items yet. */
    itemPrefix: string | null;
    /** Item lines that register OUR hook (tilde form or $HOME-expanded
     *  absolute form — both are the same registration to OMP). */
    oursLineIdxs: number[];
}

/** Scan OMP's config.yml for the `extensions:` block list. `block` is null
 *  when the file has no top-level `extensions:` key at all (a fresh one may
 *  then be appended). Any shape this scanner cannot prove it understood is
 *  `{ ok: false, why }` — callers must fail closed, never guess-edit. */
function scanOmpExtensions(text: string, hookFile: string): { ok: true; block: OmpExtensionsBlock | null } | { ok: false; why: string } {
    const lines = text.split('\n');
    // Classify EVERY `extensions:`-shaped line in one pass. The one shape we
    // can target is a top-level key line: `extensions:` + optional trailing
    // spaces/comment. Any OTHER line carrying the key — an inline/flow-style
    // value (`extensions: [a, b]`), a plain scalar, or a nested (indented)
    // key — is refused outright: appending a fresh top-level key beside one
    // of those could shadow or duplicate it, so never guess.
    const keyIdxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^extensions:[ \t]*(?:#.*)?$/.test(line)) { keyIdxs.push(i); continue; }
        if (/^extensions:[ \t]*\S/.test(line)) return { ok: false, why: `inline/flow-style \`extensions:\` value (\`${line.trim()}\`)` };
        if (/^[ \t]+extensions:/.test(line)) return { ok: false, why: '`extensions:` key exists only nested, not top-level' };
    }
    if (keyIdxs.length > 1) return { ok: false, why: 'duplicate top-level `extensions:` keys' };
    if (keyIdxs.length === 0) return { ok: true, block: null };
    const keyIdx = keyIdxs[0]!;

    const itemIdxs: number[] = [];
    let itemPrefix: string | null = null;
    let indent: string | null = null;
    for (let i = keyIdx + 1; i < lines.length; i++) {
        const m = /^([ \t]+-)([ \t]*)(.*)$/.exec(lines[i]!);
        if (!m) {
            // A column-0 `- item` terminating the run is YAML's same-indent
            // sequence style (or a mixed/malformed list) — both are outside
            // the one shape this editor writes, so fail closed rather than
            // splice an indented item into a column-0 list.
            if (/^-(?:[ \t]|$)/.test(lines[i]!)) return { ok: false, why: '`extensions:` uses column-0 (same-indent) sequence items' };
            break; // any other line ends the block
        }
        const thisIndent = m[1]!.slice(0, -1);
        if (indent === null) indent = thisIndent;
        else if (thisIndent !== indent) return { ok: false, why: '`extensions:` items are not at a uniform indentation (nested list?)' };
        itemIdxs.push(i);
        itemPrefix = `${m[1]!}${m[2]!}`;
    }

    // Ours = the hook path exactly as connect writes it (tilde form), or the
    // same path $HOME-expanded (identical registration), optionally quoted.
    const tildeEntry = `~${hookFile.slice(home.length)}`;
    const oursLineIdxs = itemIdxs.filter((i) => {
        let v = lines[i]!.replace(/^[ \t]+-[ \t]*/, '').trim();
        if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
        return v === tildeEntry || v === hookFile;
    });

    return { ok: true, block: { keyIdx, itemIdxs, itemPrefix, oursLineIdxs } };
}

/** The omp twin of applyToml/applyOne (same backup / fail-closed contract,
 * same Outcome shape): install (or, on remove, unregister) the advisory hook.
 * Neither artifact carries a secret — the hook resolves the MCP token at
 * runtime — so unlike the token-embedding clients there is no 0600 tighten
 * here; a pre-existing config.yml keeps its own permissions. */
function applyOmp(spec: ClientSpec, remove: boolean): Outcome {
    const configFile = spec.configPath()!;
    const hookFile = path.join(path.dirname(configFile), 'hooks', 'pre', OMP_HOOK_FILENAME);
    const tildeEntry = `~${hookFile.slice(home.length)}`;

    // Config half first, fail-closed BEFORE anything is written: a config
    // shape we can't safely target must leave BOTH halves untouched.
    const text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    const scan = text ? scanOmpExtensions(text, hookFile) : { ok: true as const, block: null };
    if (!scan.ok) {
        return { id: spec.id, status: 'failed', detail: `existing config is not YAML this writer can safely target (${scan.why}; left untouched): ${configFile}` };
    }

    if (remove) {
        // Config-only precedent (Cursor/Codex disconnect removes the config
        // entry, never files placed elsewhere): unregister the hook but leave
        // atlas-consult.ts on disk — inert once unregistered, and deleting a
        // file we can't prove we own (the user may have customized it) is
        // not ours to do.
        if (!scan.block || scan.block.oursLineIdxs.length === 0) {
            return { id: spec.id, status: 'skipped', detail: `no ${OMP_HOOK_FILENAME} entry present in ${configFile}'s extensions: list` };
        }
        const bak = backup(configFile);
        const lines = text.split('\n');
        for (let i = scan.block.oursLineIdxs.length - 1; i >= 0; i--) lines.splice(scan.block.oursLineIdxs[i]!, 1);
        fs.writeFileSync(configFile, lines.join('\n'));
        return { id: spec.id, status: 'disconnected', detail: `removed ${OMP_HOOK_FILENAME} from ${configFile}'s extensions: list${bak ? ` (backup ${path.basename(bak)})` : ''}; hook file left in place (inert once unregistered)` };
    }

    // Connect — compute the config edit (or note it's already registered)…
    let newText: string | null = null; // null = the config needs no edit
    if (scan.block === null) {
        // No `extensions:` key yet: append one, preserving every existing
        // byte and guaranteeing the last line is newline-terminated first.
        const base = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
        newText = `${base}extensions:\n  - ${tildeEntry}\n`;
    } else if (scan.block.oursLineIdxs.length === 0) {
        const lines = text.split('\n');
        // Insert right after the last item (or the key line itself when the
        // list is empty), mirroring the existing items' literal prefix.
        const at = scan.block.itemIdxs.length > 0 ? scan.block.itemIdxs[scan.block.itemIdxs.length - 1]! + 1 : scan.block.keyIdx + 1;
        lines.splice(at, 0, `${scan.block.itemPrefix ?? '  - '}${tildeEntry}`);
        newText = lines.join('\n');
    }

    // …then the hook file. Byte-identical → true no-op (no spurious backup);
    // a DIFFERENT pre-existing file is backed up before overwrite, never
    // silently clobbered.
    let hookNote: string;
    if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, 'utf8') === OMP_HOOK_SOURCE) {
        hookNote = 'hook already current';
    } else {
        const hookBak = backup(hookFile);
        fs.mkdirSync(path.dirname(hookFile), { recursive: true });
        fs.writeFileSync(hookFile, OMP_HOOK_SOURCE);
        hookNote = hookBak ? `hook updated (backup ${path.basename(hookBak)})` : 'hook written';
    }

    let configNote: string;
    if (newText === null) {
        configNote = 'extensions entry already present';
    } else {
        const bak = backup(configFile);
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, newText);
        configNote = bak ? `registered in extensions: (backup ${path.basename(bak)})` : 'registered in extensions:';
    }
    const changed = hookNote !== 'hook already current' || newText !== null;
    return { id: spec.id, status: 'connected', detail: changed ? `${hookNote}, ${configNote} → ${hookFile}` : `already installed — ${hookNote}, ${configNote} (no changes)` };
}

interface Outcome { id: ClientId; status: 'connected' | 'disconnected' | 'skipped' | 'failed' | 'print'; detail: string }

function writeJsonConfig(file: string, cfg: Record<string, unknown>, spec: ClientSpec): void {
    // Trailing newline: these are text files users (and git) look at — a
    // "No newline at end of file" wart on a committable file is needless.
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: spec.committable ? 0o644 : 0o600 });
    if (!spec.committable) {
        try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    }
}

function applyOne(spec: ClientSpec, url: string, token: string, remove: boolean): Outcome {
    // TOML-format clients (codex) never go through the JSON read/merge/write
    // below — the targeted TOML merger owns them end to end. OMP likewise:
    // the hook installer owns it (it needs neither url nor token).
    if (spec.format === 'toml') return applyToml(spec, url, token, remove);
    if (spec.format === 'omp') return applyOmp(spec, remove);
    // Everything past this point is an MCP-server-entry client — entry is
    // optional on the type only because omp (routed away above) has none.
    const buildEntry = spec.entry!;
    if (spec.printOnly) {
        if (remove) {
            return { id: spec.id, status: 'print', detail: `no auto-writable config path — remove the '${SERVER_KEY}' (or legacy 'atlas') entry from ${spec.label} MCP settings manually.` };
        }
        // RD-Mtoken-argv — redact the bearer in the printed (stdout) block so
        // the live token isn't echoed into terminal scrollback / logs. The
        // placeholder tells the user where to paste their real token.
        const TOKEN_PLACEHOLDER = '<ATLAS_TOKEN>';
        const blockObj = { [spec.serversKey]: { [SERVER_KEY]: buildEntry(url, token) } };
        const block = JSON.stringify(blockObj, null, 2).split(token).join(TOKEN_PLACEHOLDER);
        return { id: spec.id, status: 'print', detail: `no auto-writable config path — paste into ${spec.label} MCP settings (replace ${TOKEN_PLACEHOLDER} with your Groundfloor Atlas token):\n${block}` };
    }
    const file = spec.configPath();
    if (!file) return { id: spec.id, status: 'skipped', detail: spec.workspaceScoped ? 'workspace-scoped config — run from the project root (writes .vscode/mcp.json there)' : `unsupported on ${process.platform}` };

    let cfg: Record<string, unknown>;
    try { cfg = readJson(file); }
    catch { return { id: spec.id, status: 'failed', detail: `existing config is not valid JSON (left untouched): ${file}` }; }

    // VS Code's ${input:...} indirection manages a second field — a top-level
    // `inputs:` array — alongside the servers entry. A pre-existing `inputs`
    // that isn't an array is a shape we don't understand: fail closed with the
    // file untouched rather than clobber it (same contract as malformed JSON).
    if (spec.inputEntry && 'inputs' in cfg && !Array.isArray(cfg['inputs'])) {
        return { id: spec.id, status: 'failed', detail: `existing config has a non-array 'inputs' field (left untouched): ${file}` };
    }

    // Resolve the servers map — may be nested (e.g. cfg.mcp.servers for ZCode).
    const parentKey = spec.serversKey;
    const subKey = spec.serversSubKey;
    const parentObj = (cfg[parentKey] as Record<string, unknown> | undefined) ?? {};
    const servers: Record<string, unknown> = subKey
        ? (parentObj[subKey] as Record<string, unknown> | undefined) ?? {}
        : (parentObj as Record<string, unknown>);

    // RD-groundfloor-atlas-key-rename — treat SERVER_KEY and every LEGACY_KEYS entry as
    // the SAME logical connection: present under any of these names → "already
    // connected" (remove) or "already have a key to replace" (write).
    const allKeys = [SERVER_KEY, ...LEGACY_KEYS];
    const presentKeys = allKeys.filter((k) => k in servers);

    // The inputs twin of the servers map: our entry is whichever array member
    // carries our id (dedup'd to the canonical shape on connect, excised on
    // disconnect). Only consulted for specs that declare inputEntry.
    const inputId = spec.inputEntry?.id;
    const readInputs = (): Record<string, unknown>[] => (cfg['inputs'] as Record<string, unknown>[] | undefined) ?? [];
    const isOurInput = (e: unknown): boolean => !!e && typeof e === 'object' && (e as Record<string, unknown>)['id'] === inputId;
    const ourInputPresent = (): boolean => !!inputId && readInputs().some(isOurInput);

    if (remove) {
        // No server entry AND no inputs entry of ours → nothing to do. (A
        // dangling inputs entry alone still counts — disconnect self-heals
        // both fields, the same contract the legacy-key self-heal gives the
        // servers map.)
        if (presentKeys.length === 0 && !ourInputPresent()) return { id: spec.id, status: 'skipped', detail: `no ${SERVER_KEY} entry present` };
        const bak = backup(file);
        for (const k of presentKeys) delete servers[k];
        // Only re-assign when something was actually removed — with a
        // dangling inputs entry alone, `servers` is the synthetic {} above
        // and assigning it would fabricate an empty "servers": {} key.
        if (presentKeys.length) {
            if (subKey) { parentObj[subKey] = servers; cfg[parentKey] = parentObj; }
            else cfg[parentKey] = servers;
        }
        let inputNote = '';
        if (ourInputPresent()) {
            const keptInputs = readInputs().filter((e) => !isOurInput(e));
            if (keptInputs.length) cfg['inputs'] = keptInputs;
            else delete cfg['inputs']; // no empty [] husk — restore the pre-connect shape
            inputNote = ' + its inputs entry';
        }
        writeJsonConfig(file, cfg, spec);
        const removedWhat = presentKeys.length ? presentKeys.join('/') : `${SERVER_KEY} inputs entry`;
        return { id: spec.id, status: 'disconnected', detail: `removed ${removedWhat}${inputNote} from ${file}${bak ? ` (backup ${path.basename(bak)})` : ''}` };
    }

    const bak = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Self-heal: drop any legacy-named entry (e.g. 'atlas' from before the
    // rename) before writing the current key, so re-running connect on an
    // already-connected machine migrates in place instead of leaving a stale
    // duplicate entry sitting alongside the new one.
    const migratedFrom = LEGACY_KEYS.filter((k) => k in servers && k !== SERVER_KEY);
    for (const k of migratedFrom) delete servers[k];
    servers[SERVER_KEY] = buildEntry(url, token);
    if (subKey) { parentObj[subKey] = servers; cfg[parentKey] = parentObj; }
    else cfg[parentKey] = servers;
    // Exactly ONE inputs entry with our id — ours, in its canonical shape,
    // appended last. Other inputs (including a user-edited copy of ours)
    // survive untouched, and a re-run is byte-stable.
    if (spec.inputEntry) {
        cfg['inputs'] = [...readInputs().filter((e) => !isOurInput(e)), spec.inputEntry];
    }
    writeJsonConfig(file, cfg, spec);
    const migratedNote = migratedFrom.length ? ` (migrated from ${migratedFrom.join('/')})` : '';
    const inputNote = spec.inputEntry ? ` — VS Code prompts for the token once on first server start (print it: atlas mcp-config --show-token)` : '';
    return { id: spec.id, status: 'connected', detail: `wrote ${SERVER_KEY} → ${file}${migratedNote}${inputNote}${bak ? ` (backup ${path.basename(bak)})` : ''}` };
}
export interface IdeStatus {
    id: string;
    label: string;
    installed: boolean;
    connected: boolean;
    configPath: string | null;
    printOnly: boolean;
}

/** Read which IDEs are installed and whether Groundfloor Atlas is already in their config. */
export function getIdeStatuses(): IdeStatus[] {
    return SPECS.map((spec) => {
        const configPath = spec.configPath();
        let connected = false;
        if (!spec.printOnly && configPath && fs.existsSync(configPath)) {
            try {
                if (spec.format === 'omp') {
                    // omp is connected only when BOTH halves are real — the
                    // hook file on disk AND its registration in config.yml's
                    // `extensions:` list (an unregistered file is inert).
                    // Same two-part contract cli/wire.ts's ompToolStatus
                    // verifies; an unscannable config counts as not
                    // connected here (this is a best-effort UI read).
                    const hookFile = path.join(path.dirname(configPath), 'hooks', 'pre', OMP_HOOK_FILENAME);
                    const scan = scanOmpExtensions(fs.readFileSync(configPath, 'utf8'), hookFile);
                    connected = fs.existsSync(hookFile) && (scan.ok && scan.block?.oursLineIdxs.length ? true : false);
                } else if (spec.format === 'toml') {
                    // Either the current key or a pre-rename legacy key counts as
                    // connected — same rule as the JSON branch below.
                    connected = ourTomlRegions(scanTomlRegions(fs.readFileSync(configPath, 'utf8')) ?? [], spec.serversKey).length > 0;
                } else {
                    const cfg = readJson(configPath);
                    const parentKey = spec.serversKey;
                    const subKey = spec.serversSubKey;
                    const parentObj = (cfg[parentKey] as Record<string, unknown> | undefined) ?? {};
                    const servers: Record<string, unknown> = subKey
                        ? (parentObj[subKey] as Record<string, unknown> | undefined) ?? {}
                        : (parentObj as Record<string, unknown>);
                    // Either the current key or a pre-rename legacy key counts as
                    // connected — the underlying entry works either way; the status
                    // check shouldn't report "not connected" just because a machine
                    // hasn't re-run `connect` since the SERVER_KEY rename yet.
                    connected = [SERVER_KEY, ...LEGACY_KEYS].some((k) => k in servers);
                }
            } catch { /* malformed config — treat as not connected */ }
        }
        return { id: spec.id, label: spec.label, installed: spec.installed(), connected, configPath, printOnly: !!spec.printOnly };
    });
}

/** Connect or disconnect a single IDE by id. Returns a structured result suitable for HTTP responses. */
export function connectIde(clientId: string, disconnect = false): { ok: boolean; status: string; detail: string } {
    const cfg = loadConfig();
    const url = `http://127.0.0.1:${cfg.port}/mcp`;
    const authOn = mcpAuthEnabled();
    const token = authOn ? ensureMcpAuthToken(cfg.home) : '';
    const spec = byId.get(clientId as ClientId);
    if (!spec) return { ok: false, status: 'error', detail: `Unknown client '${clientId}'` };
    const outcome = applyOne(spec, url, token || '<TOKEN>', disconnect);
    return { ok: outcome.status !== 'failed', status: outcome.status, detail: outcome.detail };
}

/**
 * `atlas connect [client|all]` / `atlas disconnect [client|all]`.
 * `all` targets only *installed* clients (skips absent ones).
 */
export function runConnect(clientArg: string | undefined, opts: { disconnect?: boolean } = {}): number {
    const cfg = loadConfig();
    const url = `http://127.0.0.1:${cfg.port}/mcp`;
    const authOn = mcpAuthEnabled();
    const token = authOn ? ensureMcpAuthToken(cfg.home) : '';
    const verb = opts.disconnect ? 'disconnect' : 'connect';

    if (!authOn) console.error('# WARNING: ATLAS_MCP_AUTH=off — generated configs will have no token; the /mcp endpoint is UNAUTHENTICATED.\n');

    const want = (clientArg ?? 'all').toLowerCase();
    if (want !== 'all' && !byId.has(want as ClientId)) {
        console.error(`atlas ${verb}: unknown client '${clientArg}'. Supported: ${[...SPECS.map((s) => s.id), 'all'].join(', ')}`);
        return 64;
    }

    // `all` → only installed clients; explicit single → force (even if undetected).
    const targets = want === 'all' ? SPECS.filter((s) => s.installed()) : [byId.get(want as ClientId)!];
    if (want === 'all') {
        const absent = SPECS.filter((s) => !s.installed()).map((s) => s.id);
        if (absent.length) console.error(`# skipped (not detected): ${absent.join(', ')}\n`);
    }

    console.error(`# Groundfloor Atlas endpoint: ${url}  |  token: ${authOn ? `${cfg.home}/mcp.token` : '(none)'}\n`);

    let failures = 0;
    for (const spec of targets) {
        const r = applyOne(spec, url, token || '<TOKEN>', !!opts.disconnect);
        if (r.status === 'failed') failures++;
        const mark = r.status === 'connected' || r.status === 'disconnected' ? '✓' : r.status === 'failed' ? '✗' : '•';
        console.log(`${mark} ${spec.label}: ${r.detail}`);
    }
    if (targets.some((s) => !s.printOnly) && !opts.disconnect) {
        console.error('\n# Restart the IDE (or reload its MCP servers) to pick up Groundfloor Atlas. The daemon must be running (atlas serve / the desktop app).');
    }
    return failures > 0 ? 1 : 0;
}
