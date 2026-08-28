/**
 * config.ts — Groundfloor Atlas configuration loader.
 *
 * Reads `~/.groundfloor/atlas/config.json` (override via $ATLAS_HOME).
 * Missing file is fine: returns defaults so a fresh install runs without
 * the operator having to write JSON first. Malformed JSON throws so
 * misconfigurations surface loudly instead of silently degrading.
 *
 * X3 extension: a `lore` section pointing Groundfloor Atlas at its Lore daemon
 * (workspace + MCP URL) so `atlas index <file>` knows where to write.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LLMConfig {
    /** LLM provider. 'none' disables LLM — Groundfloor Atlas tool results shown as-is. */
    provider: 'ollama' | 'openai' | 'anthropic' | 'none';
    /** Model name. e.g. "llama3.2", "gpt-4o-mini", "claude-sonnet-4-5". */
    model: string;
    /** API key for cloud providers (OpenAI / Anthropic). */
    apiKey?: string;
    /** Base URL for Ollama. Default: http://localhost:11434 */
    ollamaUrl?: string;
    /**
     * Consent to send recalled repo/knowledge context to a CLOUD provider
     * (OpenAI/Anthropic). Default false → context is withheld and the chat
     * answers without it (the UI shows a banner). Local Ollama is unaffected.
     * Context that IS sent is always secret+PII-redacted first regardless of
     * this flag (see llmChat.ts sanitizeContext). The ATLAS_LLM_ALLOW_CLOUD
     * env var remains an explicit operator override in either direction.
     */
    allowCloudContext?: boolean;
}

export interface LoreClientConfig {
    /** Target workspace for Groundfloor Atlas writes. Required for index/write paths. */
    workspace: string;
    /** Lore MCP endpoint. Default points at the local daemon. */
    mcpUrl: string;
    /**
     * Write/read transport. 'http' = talk to a separate Lore daemon (legacy);
     * 'embedded' = run a dedicated in-process Lore (own kuzu+lancedb+sqlite)
     * with no daemon, no port, no token. Default 'http' until the cutover.
     */
    mode: 'http' | 'embedded';
    /**
     * Embedded mode only: base dir for the dedicated Lore's storage. Each
     * workspace gets its own subdir (true per-project separation). Default
     * <home>/lore-data.
     */
    dataDir?: string;
}

export interface SidecarConfig {
    /**
     * Whether Groundfloor Atlas should manage the Lore process lifecycle.
     * When true, Groundfloor Atlas spawns Lore on startup, monitors it with a 5-minute
     * watchdog, and kills it on shutdown.
     * When false (default), Groundfloor Atlas expects Lore to be running externally.
     */
    enabled: boolean;
    /** Absolute path to the compiled Lore server entry-point (server.js). */
    loreBinPath: string;
    /**
     * LORE_HOME passed to the spawned Lore process — where Kuzu + LanceDB
     * data lives. Must point at your existing data dir to preserve history.
     */
    loreDataDir: string;
    /** Port Lore should listen on. Must match lore.mcpUrl. Default 3847. */
    lorePort: number;
    /**
     * Extra CLI args forwarded to the Lore binary.
     * The running launchd Lore uses ["--http"]; include it here.
     */
    loreArgs: string[];
}

export interface CloudSyncConfig {
    /**
     * Whether cloud sync is enabled. When true, Groundfloor Atlas routes MCP calls
     * to cloudMcpUrl instead of the local Lore sidecar.
     * Default: false.
     */
    enabled: boolean;
    /**
     * Groundfloor cloud Lore MCP endpoint.
     * e.g. https://api.groundfloor.io/lore/mcp
     */
    cloudMcpUrl: string;
    /**
     * Cloud API key (Groundfloor account key or team token).
     * Stored in config.json (use auth.token for the local Lore bootstrap token).
     */
    apiKey?: string;
    /**
     * Sync direction. 'push' = local → cloud only (default for privacy-first).
     * 'pull' = cloud → local merge. 'bidirectional' = both.
     */
    syncDirection: 'push' | 'pull' | 'bidirectional';
}

export interface IndexConfig {
    /**
     * Opt-in scan-path allowlist (audit ATL-004/005/006). When non-empty, every
     * caller-supplied filesystem path handed to a scanning/indexing/git tool
     * (atlas_index, schema_drift, hotspots, blast_radius, atlas_source) must
     * resolve to a descendant of one of these roots; paths that escape every
     * root are refused. EMPTY/absent = permissive (DEFAULT — no restriction, no
     * behavior change). Also settable via the ATLAS_INDEX_ROOTS env var
     * (PATH-style, os.delimiter-separated), which takes precedence. Operator-set
     * only — an MCP caller can never widen it.
     */
    roots?: string[];
}

export interface AtlasConfig {
    /** HTTP port the daemon listens on. */
    port: number;
    /** Groundfloor Atlas home directory (where config.json + future state live). */
    home: string;
    /** Where to write nodes when running `atlas index <file>`. */
    lore: LoreClientConfig;
    /** Optional Lore sidecar management. */
    sidecar?: SidecarConfig;
    /** LLM provider used by the llm_chat tool. Default: none. */
    llm?: LLMConfig;
    /** Optional cloud sync provision. Default: disabled. */
    cloudSync?: CloudSyncConfig;
    /** Optional opt-in scan-path allowlist. Default: permissive (absent). */
    index?: IndexConfig;
}

export const DEFAULT_PORT = 3848;
export const DEFAULT_LORE_MCP_URL = 'http://127.0.0.1:3847/mcp';
export const DEFAULT_LORE_WORKSPACE = 'developer';

// Snapshot ATLAS_HOME at module load. Embedded Lore's env-scrubber DELETES
// ATLAS_HOME from process.env on boot (it's not in Lore's ALLOWED_VARS), so a
// later loadConfig() in the daemon's read path would otherwise lose it and
// silently fall back to the DEFAULT home (and the wrong lore.mode → an HTTP
// reader hitting a dead port). config.ts is imported before any createLore()
// call, so this captures the real value first. Prefer the live env if still
// present (covers a host that sets it after import).
const ATLAS_HOME_AT_LOAD = process.env['ATLAS_HOME'];

export function defaultHome(): string {
    return process.env['ATLAS_HOME']
        ?? ATLAS_HOME_AT_LOAD
        ?? path.join(os.homedir(), '.groundfloor', 'atlas');
}

/**
 * Apply the ATLAS_PORT env override to a base port. ATLAS_PORT is injected by
 * `atlas service install --port N` into the LaunchAgent plist env (and by
 * `atlas serve --port N`); without honoring it here the override was silently
 * dropped and the daemon still bound DEFAULT_PORT. Validated identically to
 * config.port; a set-but-invalid value throws (loud misconfig, not silent).
 */
function applyPortEnvOverride(basePort: number): number {
    const portEnv = process.env['ATLAS_PORT'];
    if (portEnv === undefined || portEnv.trim().length === 0) return basePort;
    const n = Number(portEnv);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`ATLAS_PORT must be 1..65535; got ${portEnv}`);
    }
    return n;
}

export function loadConfig(homeOverride?: string): AtlasConfig {
    const home = homeOverride ?? defaultHome();
    const configPath = path.join(home, 'config.json');

    const defaults: AtlasConfig = {
        port: applyPortEnvOverride(DEFAULT_PORT),
        home,
        lore: { workspace: DEFAULT_LORE_WORKSPACE, mcpUrl: DEFAULT_LORE_MCP_URL, mode: 'embedded' },
    };

    // RD-F26toctou — read directly and treat ENOENT as "no config" instead of
    // an existsSync→readFileSync pair (which races a concurrent unlink/replace).
    let raw: string;
    try {
        raw = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `Groundfloor Atlas config at ${configPath} is not valid JSON: ${(err as Error).message}`,
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Groundfloor Atlas config at ${configPath} must be a JSON object.`);
    }
    const obj = parsed as Record<string, unknown>;

    const cfgPort = typeof obj['port'] === 'number' ? obj['port'] : DEFAULT_PORT;
    if (!Number.isInteger(cfgPort) || cfgPort < 1 || cfgPort > 65535) {
        throw new Error(`Groundfloor Atlas config.port must be 1..65535; got ${String(obj['port'])}`);
    }
    // ATLAS_PORT env (if set) overrides config.json's port — see helper.
    const port = applyPortEnvOverride(cfgPort);

    const loreRaw = (obj['lore'] && typeof obj['lore'] === 'object' && !Array.isArray(obj['lore']))
        ? (obj['lore'] as Record<string, unknown>)
        : {};
    const workspace = typeof loreRaw['workspace'] === 'string' && loreRaw['workspace'].length > 0
        ? loreRaw['workspace']
        : DEFAULT_LORE_WORKSPACE;
    const mcpUrl = typeof loreRaw['mcpUrl'] === 'string' && loreRaw['mcpUrl'].length > 0
        ? loreRaw['mcpUrl']
        : DEFAULT_LORE_MCP_URL;
    // #2 — Groundfloor Atlas is a STANDALONE product: with no explicit mode it embeds
    // Lore as a library (self-contained, no sidecar to start). Only the literal
    // 'http' opts into the legacy sidecar path (pointing at DEFAULT_LORE_MCP_URL),
    // so a deployment that genuinely runs a separate Lore daemon must say so.
    const mode: 'http' | 'embedded' = loreRaw['mode'] === 'http' ? 'http' : 'embedded';
    const dataDir = typeof loreRaw['dataDir'] === 'string' && loreRaw['dataDir'].length > 0
        ? loreRaw['dataDir']
        : undefined;

    // ── Sidecar config (optional) ────────────────────────────────────────────
    let sidecar: SidecarConfig | undefined;
    const scRaw = (obj['sidecar'] && typeof obj['sidecar'] === 'object' && !Array.isArray(obj['sidecar']))
        ? (obj['sidecar'] as Record<string, unknown>)
        : null;
    if (scRaw) {
        const enabled = scRaw['enabled'] === true;
        const loreBinPath = typeof scRaw['loreBinPath'] === 'string' ? scRaw['loreBinPath'] : '';
        const loreDataDir = typeof scRaw['loreDataDir'] === 'string' ? scRaw['loreDataDir'] : '';
        const lorePort = typeof scRaw['lorePort'] === 'number' && scRaw['lorePort'] > 0
            ? scRaw['lorePort'] : 3847;
        const loreArgs = Array.isArray(scRaw['loreArgs'])
            ? (scRaw['loreArgs'] as unknown[]).filter((a): a is string => typeof a === 'string')
            : ['--http'];
        if (loreBinPath && loreDataDir) {
            sidecar = { enabled, loreBinPath, loreDataDir, lorePort, loreArgs };
        } else if (enabled) {
            throw new Error(
                'Groundfloor Atlas config sidecar.enabled=true but loreBinPath or loreDataDir is missing.',
            );
        }
    }

    // ── LLM config (optional) ────────────────────────────────────────────────
    let llm: LLMConfig | undefined;
    const llmRaw = (obj['llm'] && typeof obj['llm'] === 'object' && !Array.isArray(obj['llm']))
        ? (obj['llm'] as Record<string, unknown>)
        : null;
    if (llmRaw) {
        const validProviders = ['ollama', 'openai', 'anthropic', 'none'] as const;
        const provider = validProviders.includes(llmRaw['provider'] as never)
            ? (llmRaw['provider'] as LLMConfig['provider'])
            : 'none';
        const model = typeof llmRaw['model'] === 'string' ? llmRaw['model'] : '';
        const apiKey = typeof llmRaw['apiKey'] === 'string' ? llmRaw['apiKey'] : undefined;
        const ollamaUrl = typeof llmRaw['ollamaUrl'] === 'string' ? llmRaw['ollamaUrl'] : undefined;
        // Strict === true: consent to ship context to a cloud LLM must be an
        // explicit boolean, never a truthy string that snuck into the JSON.
        const allowCloudContext = llmRaw['allowCloudContext'] === true;
        llm = { provider, model, apiKey, ollamaUrl, allowCloudContext };
    }

    // ── Cloud sync config (optional) ─────────────────────────────────────────
    let cloudSync: CloudSyncConfig | undefined;
    const csRaw = (obj['cloudSync'] && typeof obj['cloudSync'] === 'object' && !Array.isArray(obj['cloudSync']))
        ? (obj['cloudSync'] as Record<string, unknown>)
        : null;
    if (csRaw) {
        const validDirections = ['push', 'pull', 'bidirectional'] as const;
        const enabled = csRaw['enabled'] === true;
        const cloudMcpUrl = typeof csRaw['cloudMcpUrl'] === 'string' ? csRaw['cloudMcpUrl'] : '';
        const apiKey = typeof csRaw['apiKey'] === 'string' && csRaw['apiKey'].length > 0
            ? csRaw['apiKey'] : undefined;
        const syncDirection = validDirections.includes(csRaw['syncDirection'] as never)
            ? (csRaw['syncDirection'] as CloudSyncConfig['syncDirection'])
            : 'push';
        if (cloudMcpUrl) {
            cloudSync = { enabled, cloudMcpUrl, apiKey, syncDirection };
        }
    }

    // ── Index scan-path allowlist (optional; opt-in) ─────────────────────────
    let index: IndexConfig | undefined;
    const idxRaw = (obj['index'] && typeof obj['index'] === 'object' && !Array.isArray(obj['index']))
        ? (obj['index'] as Record<string, unknown>)
        : null;
    if (idxRaw && Array.isArray(idxRaw['roots'])) {
        const roots = (idxRaw['roots'] as unknown[]).filter((r): r is string => typeof r === 'string' && r.length > 0);
        if (roots.length > 0) index = { roots };
    }

    return { port, home, lore: { workspace, mcpUrl, mode, dataDir }, sidecar, llm, cloudSync, index };
}

/**
 * Persist updated LLM config back to config.json in place.
 * All other fields are preserved; only the `llm` key is merged.
 */
export function writeLLMConfig(llm: LLMConfig, homeOverride?: string): void {
    const home = homeOverride ?? defaultHome();
    const configPath = path.join(home, 'config.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
        try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; }
        catch { /* ignore parse error — overwrite */ }
    }

    // Strip apiKey if empty to avoid storing blank strings
    const llmToWrite: Record<string, unknown> = {
        provider: llm.provider,
        model: llm.model,
    };
    if (llm.apiKey && llm.apiKey.trim().length > 0) llmToWrite['apiKey'] = llm.apiKey;
    if (llm.ollamaUrl && llm.ollamaUrl.trim().length > 0) llmToWrite['ollamaUrl'] = llm.ollamaUrl;
    // Persist only an explicit true — absent means "not consented" (default),
    // so an old config.json and a never-touched toggle read identically.
    if (llm.allowCloudContext === true) llmToWrite['allowCloudContext'] = true;

    const updated = { ...existing, llm: llmToWrite };
    // #10: config.json can hold API keys — restrict to owner-only.
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(home, 0o700); } catch { /* best-effort on platforms without chmod */ }
    writeJsonAtomic(configPath, updated);
}

/**
 * Persist updated cloud sync config back to config.json in place.
 * All other fields are preserved; only the `cloudSync` key is merged.
 */
export function writeCloudSyncConfig(cloudSync: CloudSyncConfig, homeOverride?: string): void {
    const home = homeOverride ?? defaultHome();
    const configPath = path.join(home, 'config.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
        try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; }
        catch { /* ignore parse error — overwrite */ }
    }

    const csToWrite: Record<string, unknown> = {
        enabled: cloudSync.enabled,
        cloudMcpUrl: cloudSync.cloudMcpUrl,
        syncDirection: cloudSync.syncDirection,
    };
    if (cloudSync.apiKey && cloudSync.apiKey.trim().length > 0) {
        csToWrite['apiKey'] = cloudSync.apiKey;
    }

    const updated = { ...existing, cloudSync: csToWrite };
    // #10: config.json can hold API keys — restrict to owner-only.
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(home, 0o700); } catch { /* best-effort on platforms without chmod */ }
    writeJsonAtomic(configPath, updated);
}

/** Temp-write + rename, so a crash mid-write can never leave a truncated
 *  config.json that silently reads back as "no config" (the bare writeFileSync
 *  this replaced had exactly that failure mode). Owner-only throughout —
 *  config.json can hold API keys. */
function writeJsonAtomic(configPath: string, value: unknown): void {
    const tmp = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmp, configPath);
}

/**
 * Resolve the Groundfloor Atlas auth token used to talk to Lore.
 *
 * Precedence:
 *   1. LORE_AUTH_TOKEN env (testing + CI override)
 *   2. <ATLAS_HOME>/auth.token (operator-managed)
 *
 * X3 caveat (documented per spec): the file currently holds a Lore
 * BOOTSTRAP token copied by the operator from /api/auth/bootstrap.
 * TODO: switch to a P3-issued scoped token via `lore auth issue
 * --workspace developer --label "Atlas"` once Lore exposes the CLI
 * via a stable surface — see X3 spec doc.
 */
export function readAtlasToken(homeOverride?: string): string | null {
    const env = process.env['LORE_AUTH_TOKEN'];
    if (env && env.trim().length > 0) return env.trim();

    const home = homeOverride ?? defaultHome();
    const tokenPath = path.join(home, 'auth.token');
    // RD-F26toctou — read-and-catch instead of existsSync→readFileSync.
    let raw: string;
    try {
        raw = fs.readFileSync(tokenPath, 'utf-8').trim();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
    return raw.length > 0 ? raw : null;
}

/**
 * Resolve (and if absent, mint) the INBOUND auth token that MCP clients
 * must present to Groundfloor Atlas's own `/mcp` endpoint.
 *
 * This is deliberately SEPARATE from `auth.token` (Groundfloor Atlas's OUTBOUND
 * credential to Lore) so a client never needs the privileged Lore
 * bootstrap token to talk to Groundfloor Atlas.
 *
 * Precedence:
 *   1. ATLAS_MCP_TOKEN env (testing/CI override)
 *   2. <ATLAS_HOME>/mcp.token (auto-minted on first boot, mode 0600)
 */
export function ensureMcpAuthToken(homeOverride?: string): string {
    const env = process.env['ATLAS_MCP_TOKEN'];
    if (env && env.trim().length > 0) return env.trim();

    const home = homeOverride ?? defaultHome();
    const tokenPath = path.join(home, 'mcp.token');
    // RD-F26toctou — read-and-catch instead of existsSync→readFileSync.
    try {
        const raw = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (raw.length > 0) return raw;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // ENOENT → fall through to mint a fresh token.
    }
    const token = randomBytes(32).toString('hex');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
    return token;
}

/**
 * READ (never mint) the inbound MCP auth token, for a CLI process that needs
 * to authenticate to an ALREADY-running daemon's `/mcp` (e.g. the daemon-first
 * routing in `atlas memory export/import`). Same precedence as
 * `ensureMcpAuthToken` (ATLAS_MCP_TOKEN env → `<home>/mcp.token`) but returns
 * null instead of minting — a client must present the daemon's EXISTING token,
 * not a fresh one that wouldn't match. Returns null when the daemon runs with
 * auth off (no token file), in which case the caller simply sends no header
 * (an auth-off daemon ignores a bearer anyway).
 */
export function readMcpAuthToken(homeOverride?: string): string | null {
    const env = process.env['ATLAS_MCP_TOKEN'];
    if (env && env.trim().length > 0) return env.trim();
    const home = homeOverride ?? defaultHome();
    try {
        const raw = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        return raw.length > 0 ? raw : null;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Whether inbound `/mcp` auth is enforced. On by default; set
 * `ATLAS_MCP_AUTH=off` only for trusted single-user local dev.
 */
export function mcpAuthEnabled(): boolean {
    return (process.env['ATLAS_MCP_AUTH'] ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Authoritatively harden ATLAS_HOME to owner-only (0700) on daemon boot.
 *
 * ATLAS_HOME holds config.json (may contain LLM/cloud API keys), the mcp.token
 * / auth.token bearer files, and the lore-data code graph. `installService`
 * already mkdir+chmods it 0700, but a home created some OTHER way — a manual
 * `mkdir`, an old install, `ensureMcpAuthToken` running before any 0700 mkdir,
 * or a fresh dir under a permissive umask — could be left 0755 (group/other
 * READABLE, so a co-resident user could read the mcp.token and defeat the
 * bearer gate). This mirrors installService: mkdir with mode 0700 (umask can
 * only REMOVE bits, so it never widens) THEN an explicit chmod, which is
 * authoritative and also tightens a PRE-EXISTING 0755 dir. Best-effort chmod:
 * platforms without POSIX perms (Windows) simply skip it.
 */
export function hardenAtlasHome(homeOverride?: string): void {
    const home = homeOverride ?? defaultHome();
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(home, 0o700);
    } catch { /* best-effort on platforms without chmod */ }
}
