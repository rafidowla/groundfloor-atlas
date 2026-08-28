/**
 * mcp/server.ts — Atlas MCP server (shim surface).
 *
 * Exposes exactly three meta-tools to IDE clients:
 *   atlas_tool_list   — discover available tools + descriptions
 *   atlas_tool_schema — get JSON Schema for a named tool's input
 *   atlas_tool_invoke — call any tool by name with args
 *
 * All real tools live in allTools.ts and are invisible to MCP clients
 * until invoked through the shim. Adding a new tool = one register()
 * call in allTools.ts; this file never changes for new tools.
 *
 * Why shim: Atlas owns ~23+ tools across code intelligence, knowledge
 * proxy, workspace management, and schema validation. Exposing them
 * directly would bloat the IDE tool list and risk LLM mis-routing.
 * The shim keeps the MCP surface clean and stable regardless of how
 * many tools the registry grows to.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, normalize, sep, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { buildRegistry } from './allTools.js';
import { buildHookContext, type HookParams } from './hooks.js';
import { enrichPreEdit, enrichPreSearch } from './hookEnrich.js';
import { asText } from './context.js';
import { runHealth } from './tools/health.js';
import { runVerbatimStore, type VerbatimStoreArgs } from './tools/verbatim.js';
import { ensureMcpAuthToken, mcpAuthEnabled, loadConfig, hardenAtlasHome } from '../config.js';
import { resolveWorkspaceForPath } from '../pathWorkspaceResolver.js';
import { classifyProjectPath } from '../projectTier.js';
import { maybeStartBackgroundOnboard } from './backgroundOnboard.js';
import { streamChat, type ChatMessage } from '../llm/streamChat.js';
import { getIdeStatuses, connectIde } from '../cli/ideConnect.js';
import { fsBrowsePathError } from '../indexRoots.js';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.map':  'application/json',
    '.woff2': 'font/woff2',
    '.woff':  'font/woff',
    '.ttf':   'font/ttf',
    '.json':  'application/json',
    '.txt':   'text/plain; charset=utf-8',
    '.wasm':  'application/wasm',
};

/**
 * Resolve the built browser-UI directory (atlas-ui/dist) robustly across BOTH
 * the dev tree and a global npm install — never process.cwd() (the operator may
 * launch `atlas` from anywhere). Mirrors the module-relative find-up in
 * cli/service.ts / mcp/tools/health.ts: walk up from THIS compiled module
 * (src/mcp/server.ts under tsx, dist/mcp/server.js when built) trying
 * `<dir>/atlas-ui/dist` at each level. In a published package the built UI is
 * shipped inside the package root, so the same walk finds it there too.
 *
 * Returns null when no atlas-ui/dist is found anywhere — the caller then serves
 * a clear "UI not built" message at / instead of crashing.
 */
export function resolveUiDist(): string | null {
    // Env escape hatch (tests / non-standard layouts) takes precedence.
    const override = (process.env['ATLAS_UI_DIST'] ?? '').trim();
    if (override) return existsSync(join(override, 'index.html')) ? resolvePath(override) : null;

    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
        const candidate = join(dir, 'atlas-ui', 'dist');
        if (existsSync(join(candidate, 'index.html'))) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const UI_DIST = resolveUiDist();

/** The "UI not built" shell served at / when atlas-ui/dist is absent. Static,
 *  loopback-only, carries NO secret — safe to serve without the bearer. */
const UI_NOT_BUILT_HTML =
    '<!doctype html><html><head><meta charset="utf-8"><title>Atlas — UI not built</title></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">' +
    '<h1>Atlas daemon is running</h1>' +
    '<p>The browser UI has not been built yet. From the Atlas repo root, run:</p>' +
    '<pre style="background:#f4f4f4;padding:1rem;border-radius:6px">cd atlas-ui &amp;&amp; npm run build</pre>' +
    '<p>then reload this page. The <code>/mcp</code> API is already available to IDE clients.</p>' +
    '</body></html>';

/**
 * Map a request URL path to an on-disk file inside UI_DIST, defending against
 * path traversal: the normalized join must stay CONTAINED within UI_DIST so a
 * crafted `/../../etc/passwd` can never escape the static root. Returns null for
 * any path that would escape (caller then falls back to the SPA index.html).
 */
function resolveStaticFsPath(distDir: string, urlPath: string): string | null {
    // decodeURIComponent throws URIError on a malformed escape (e.g. `/%`, `/%zz`).
    // The static path is served WITHOUT the bearer, so an unauthenticated `curl /%`
    // would otherwise throw an unhandled URIError, hang the response, and flood
    // daemon.err — a DoS. Treat any un-decodable path as "not a real static file"
    // and return null so the caller falls back to the SPA index.html / 404 path.
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null;
    }
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const full = normalize(join(distDir, rel));
    // Containment: full must equal distDir or sit under distDir + separator.
    if (full !== distDir && !full.startsWith(distDir + sep)) return null;
    return full;
}

/**
 * Inbound trust boundary for Atlas's /mcp endpoint (review #1):
 *   - DNS-rebinding protection — Host must be a known loopback host:port.
 *   - Origin allow-list — browsers always send Origin; native MCP clients
 *     (Claude Code, Codex, Cursor) don't, so a missing Origin is allowed
 *     but a *foreign* Origin (a malicious web page) is rejected.
 *   - Constant-time bearer token — the primary defense; a web page cannot
 *     read the operator's mcp.token, so it cannot forge this header.
 */
interface McpAuthContext {
    token: string | null; // null only when ATLAS_MCP_AUTH=off
    allowedHosts: Set<string>;
    allowedOrigins: Set<string>;
}

function buildAuthContext(port: number, home?: string): McpAuthContext {
    const token = mcpAuthEnabled() ? ensureMcpAuthToken(home) : null;
    const allowedHosts = new Set<string>([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
    ]);
    const defaultOrigins = [
        'tauri://localhost',
        'https://tauri.localhost',
        'http://tauri.localhost',
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
    ];
    // Vite dev-server origins (:1421 / :5173) are DEV-ONLY. Previously they were
    // permanently allow-listed with Access-Control-Allow-Credentials, so the
    // SHIPPED bundle allowed a page served from those origins to make credentialed
    // cross-origin calls. Gate them behind an explicit ATLAS_DEV flag that the
    // packaged app never sets (it serves the UI same-origin from the daemon), so
    // the release build never trusts a dev origin. Off by default.
    if ((process.env['ATLAS_DEV'] ?? '').trim().toLowerCase() === '1' ||
        (process.env['ATLAS_DEV'] ?? '').trim().toLowerCase() === 'true') {
        defaultOrigins.push('http://localhost:1421'); // Atlas UI Vite dev server
        defaultOrigins.push('http://localhost:5173'); // fallback Vite default port
    }
    const extra = (process.env['ATLAS_ALLOWED_ORIGINS'] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    const allowedOrigins = new Set<string>(
        [...defaultOrigins, ...extra].map((o) => o.toLowerCase()),
    );
    return { token, allowedHosts, allowedOrigins };
}

/**
 * Write CORS response headers for browser clients (Vite dev server, Tauri WebView).
 * Must be called before writeHead() so the headers merge into the response.
 */
function setCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: Set<string>): void {
    const origin = req.headers.origin ?? '';
    if (origin && allowedOrigins.has(origin.toLowerCase())) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id');
        res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
}

function timingEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    try {
        return timingSafeEqual(ab, bb);
    } catch {
        return false;
    }
}

function writeAuthError(res: ServerResponse, code: number, error: string, detail: string): void {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error, detail }));
}

/** Returns true if the request may proceed; otherwise writes the rejection. */
function enforceMcpAuth(req: IncomingMessage, res: ServerResponse, ctx: McpAuthContext): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!ctx.allowedHosts.has(host)) {
        writeAuthError(res, 403, 'forbidden_host', 'Host header not in allow-list');
        return false;
    }
    const origin = req.headers.origin;
    if (origin && !ctx.allowedOrigins.has(origin.toLowerCase())) {
        writeAuthError(res, 403, 'forbidden_origin', 'Origin not in allow-list');
        return false;
    }
    if (ctx.token) {
        const authz = (req.headers.authorization ?? '').toString();
        const m = /^Bearer\s+(.+)$/i.exec(authz);
        if (!m || !timingEqual(m[1].trim(), ctx.token)) {
            // Only advertise Bearer negotiation when the request PRESENTED a
            // (wrong) token. On a bare unauthenticated probe, the header tells
            // spec-compliant clients — notably mcp-remote (Claude Desktop's
            // stdio→HTTP bridge) — "do OAuth discovery", and against this
            // non-OAuth server that detour hard-fails (discovery 404 → DCR
            // /register 404 → bridge dies → "Server disconnected"). A plain
            // 401 lets the bridge proceed with its configured header.
            if (authz.length > 0) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="atlas-mcp"');
            }
            writeAuthError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
            return false;
        }
    }
    return true;
}

export interface AtlasServerHandle {
    close: () => Promise<void>;
    port: number;
    bootTimeMs: number;
}

/**
 * RD-Msession — bounded MCP session map (local DoS hardening).
 *
 * `activeSessions` previously grew by one entry per request that arrived
 * without a matching mcp-session-id, evicted ONLY via `transport.onclose`. A
 * client that opens sessions and never closes them (buggy client, or a
 * malicious local process hitting /mcp directly) leaks a transport per
 * session forever — each one holds an open StreamableHTTPServerTransport +
 * its own McpServer instance. FIX: cap the map size (LRU-evict + close the
 * oldest transport past the cap) AND sweep idle sessions on a timer,
 * mirroring the daemon's embedded-storage maintenance timer (daemon.ts) —
 * same unref'd setInterval + best-effort-close shape. Neither mechanism
 * disrupts normal session correlation: a session actively used (its
 * lastActivityMs bumped on every /mcp request) is never the LRU/idle victim
 * ahead of a session that's actually gone quiet.
 */
export const MAX_ACTIVE_SESSIONS = 200;
export const SESSION_IDLE_SWEEP_MS = 5 * 60 * 1000; // sweep cadence
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // a session idle this long is swept

/** Narrow shape eviction/sweep need from a transport — just enough to close
 *  it. `StreamableHTTPServerTransport` satisfies this structurally, and unit
 *  tests can pass a minimal stub without constructing a real transport. */
export interface Closeable {
    close(): Promise<void>;
}

export interface SessionEntry<T extends Closeable = StreamableHTTPServerTransport> {
    transport: T;
    lastActivityMs: number;
}

function closeSessionBestEffort<T extends Closeable>(entry: SessionEntry<T>): void {
    try { void entry.transport.close().catch(() => undefined); } catch { /* already torn down */ }
}

/** Evict the least-recently-active session(s) until the map is back at/under
 *  the cap. Map iteration order is insertion order; we refresh an entry's
 *  position (delete+re-set) on every touch, so the FIRST entries are always
 *  the least-recently-active — the same LRU-via-Map-order trick
 *  embeddedRegistry.ts uses for its instance cache. Generic + exported for
 *  direct unit testing (no HTTP server / real transport required). */
export function evictOverCap<T extends Closeable>(sessions: Map<string, SessionEntry<T>>, cap: number = MAX_ACTIVE_SESSIONS): void {
    if (sessions.size <= cap) return;
    for (const [sid, entry] of sessions) {
        if (sessions.size <= cap) break;
        sessions.delete(sid);
        closeSessionBestEffort(entry);
    }
}

/** Sweep sessions that have been idle past the TTL — a backstop for clients
 *  that never send another request AND never close cleanly (so `onclose`
 *  never fires), independent of whether the cap was ever hit. Generic +
 *  exported for direct unit testing. */
export function sweepIdleSessions<T extends Closeable>(sessions: Map<string, SessionEntry<T>>, idleTtlMs: number = SESSION_IDLE_TTL_MS): void {
    const cutoff = Date.now() - idleTtlMs;
    for (const [sid, entry] of sessions) {
        if (entry.lastActivityMs <= cutoff) {
            sessions.delete(sid);
            closeSessionBestEffort(entry);
        }
    }
}

function makeMcpServer(bootTimeMs: number): McpServer {
    const registry = buildRegistry(bootTimeMs);

    const mcp = new McpServer(
        { name: 'Groundfloor Atlas', version: '0.5.0' },
        { capabilities: { tools: {} } },
    );

    mcp.tool(
        'atlas_tool_list',
        'List all available Atlas tools with their names and descriptions. Call this first to discover what Atlas can do before calling atlas_tool_schema or atlas_tool_invoke.',
        {},
        async () => asText({ tools: registry.list() }),
    );

    mcp.tool(
        'atlas_tool_schema',
        'Get the full JSON Schema for a named Atlas tool\'s input. Call this after atlas_tool_list to understand a tool\'s required and optional parameters before invoking it.',
        {
            tool: z.string().describe('The tool name returned by atlas_tool_list.'),
        },
        async (args) => {
            const schema = registry.schema(args.tool);
            if (!schema) {
                return asText({
                    error: `unknown_tool: ${args.tool}`,
                    available: registry.list().map((t) => t.name),
                });
            }
            return asText(schema);
        },
    );

    mcp.tool(
        'atlas_tool_invoke',
        'Invoke any Atlas tool by name with its input arguments. Use atlas_tool_list to discover tools and atlas_tool_schema to understand the required input shape before calling this.',
        {
            tool: z.string().describe('The tool name to invoke.'),
            args: z.record(z.string(), z.unknown()).optional().describe('Input arguments matching the tool\'s JSON Schema.'),
        },
        async ({ tool, args }) => {
            const result = await registry.invoke(tool, (args ?? {}) as Record<string, unknown>);
            return asText(result);
        },
    );

    return mcp;
}

export async function startAtlasMcpServer(opts: { port: number; home?: string }): Promise<AtlasServerHandle> {
    const bootTimeMs = Date.now();
    // RC security — harden ATLAS_HOME to 0700 on EVERY daemon boot, before the
    // mcp.token is minted/read below. A pre-existing 0755 home (manual mkdir,
    // old install, permissive umask) would otherwise leave the bearer token
    // world-readable, defeating the auth gate. Authoritative + best-effort.
    hardenAtlasHome(opts.home);
    // Loaded once (not per-request) — the /hooks/context handler below uses it
    // for the path->workspace resolver (auto-wire Part 2); resolveWorkspaceForPath
    // keeps its own cached reverse index, so re-reading config.json per request
    // would be the only per-call cost, not worth paying on a hot Grep/Edit path.
    const cfg = loadConfig(opts.home);
    const activeSessions = new Map<string, SessionEntry>();
    // Assigned right after bind (needs the effective port for Host checks);
    // no request can arrive before listen() resolves, so this is race-free.
    let authCtx: McpAuthContext | null = null;
    // RD-Msession — idle-session sweep, unref'd so it never holds the process
    // alive (mirrors daemon.ts's embedded-maintenance timer).
    const sessionSweepTimer = setInterval(() => sweepIdleSessions(activeSessions), SESSION_IDLE_SWEEP_MS);
    sessionSweepTimer.unref();

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // Set CORS response headers for browser clients before any writeHead() call.
        // authCtx is guaranteed non-null by the time any request arrives (set
        // synchronously after listen() resolves, before the event loop yields).
        if (authCtx) setCorsHeaders(req, res, authCtx.allowedOrigins);

        // Handle CORS preflight — browsers send OPTIONS before cross-origin POST.
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/health') {
            // Liveness only — no sensitive data, intentionally unauthenticated.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(runHealth(bootTimeMs)));
            return;
        }
        if (req.method === 'POST' && req.url === '/hooks/context') {
            // Fast context path for the Claude Code hooks — behind the SAME
            // bearer/Host/Origin gate as /mcp (enforceMcpAuth). The client
            // (scripts/atlas-hook.mjs) sends the mcp.token bearer and, when
            // rejected, announces the misconfiguration once per session instead
            // of going silently inert (tests/hook-client.test.ts pins both sides).
            // Returns { additionalContext } the agent sees before search/edit/
            // commit. MUST never error out or hang: buildHookContext swallows all
            // failures and the hook client bounds this with its own timeout.
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            try {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as Partial<HookParams> & { cwd?: string };
                // Workspace resolution (auto-wire Part 2). An explicit `workspace`
                // — what every per-repo `atlas wire install` hook has always sent —
                // ALWAYS wins, so already-wired repos keep behaving exactly as
                // before. Only when it's absent (a machine-wide hook, Part 3, which
                // has no per-repo workspace baked in) do we fall back to resolving
                // it from `cwd` via Part 1's resolver — plain-fs, cached, not the
                // embedded-Lore I/O the next comment forbids.
                const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined;
                const workspace = body.workspace || (cwd ? resolveWorkspaceForPath(cfg, cwd) ?? undefined : undefined);
                // Auto-wire Part 5: only reached when NEITHER an explicit
                // `workspace` (already-wired repo) NOR Part 1's resolver
                // (already-known project) named one — i.e. a machine-wide
                // hook (Part 3) touching a folder Atlas has never met. Ask
                // Part 4 what kind of folder this is; a tier-2 hit kicks off
                // background onboarding (workspace + index, no repo writes)
                // and earns exactly one announcement line the FIRST time
                // this workspace is seen this daemon lifetime. Never awaits
                // the onboarding run itself — see backgroundOnboard.ts.
                let onboardLine = '';
                if (!workspace && cwd) {
                    const tierResult = classifyProjectPath(cfg, cwd);
                    if (tierResult.tier === 2) {
                        const outcome = maybeStartBackgroundOnboard(cfg, cwd);
                        if (outcome.announced) {
                            onboardLine = `🌱 Atlas: new project detected — onboarding \`${outcome.workspace}\` in the background (workspace + code index). Memory/blast-radius will be thin until it finishes; poll \`index_status { workspace: "${outcome.workspace}" }\` if you need to confirm.`;
                        }
                    }
                }
                // Context layer v2: static nudges (mcp/hooks.ts) plus — when a
                // workspace resolved — LIVE graph answers for pre-edit/pre-search
                // via mcp/hookEnrich.ts. The live path is single-flight,
                // 700ms-budgeted, 60s-cached and fail-open ('' on anything but a
                // fast answer), so it cannot error, hang, or stack concurrent
                // native reads — the failure mode that kept v1 pure (hooks.ts).
                const hookContext = await buildHookContext(
                    {
                        preEdit: (ws, filePath, symbol) => enrichPreEdit(cfg, ws, filePath, symbol),
                        preSearch: (ws, query) => enrichPreSearch(cfg, ws, query),
                    },
                    {
                        event: (body.event ?? 'pre-search') as HookParams['event'],
                        ...(workspace ? { workspace } : {}),
                        toolName: body.toolName ?? '',
                        toolInput: (body.toolInput ?? {}) as Record<string, unknown>,
                    },
                );
                const additionalContext = onboardLine && hookContext ? `${onboardLine}\n${hookContext}` : (onboardLine || hookContext);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ additionalContext }));
            } catch {
                // Degrade to "no context" — the hook must never break the agent.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ additionalContext: '' }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/hooks/verbatim') {
            // WO-4 session-end capture: the Stop hook (scripts/atlas-hook.mjs
            // session-end) POSTs the transcript tail here as verbatim_store
            // args. Behind the SAME bearer/Host/Origin gate as /mcp and
            // /hooks/context (enforceMcpAuth — no new auth scheme). Enqueues
            // through the SAME code path as the verbatim_store tool
            // (runVerbatimStore → verbatimQueue; flush is the queue's
            // business) and answers 204/empty so the best-effort hook client
            // never waits on a body it doesn't read.
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            let body: Partial<VerbatimStoreArgs> & { cwd?: string };
            try {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as Partial<VerbatimStoreArgs> & { cwd?: string };
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'request body must be JSON verbatim_store args' }));
                return;
            }
            const text = typeof body.text === 'string' ? body.text : '';
            const source = typeof body.source === 'string' ? body.source : '';
            if (!text || !source) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'verbatim capture requires non-empty text and source' }));
                return;
            }
            // Same workspace resolution order as /hooks/context: an explicit
            // workspace (what a per-repo Stop hook sends) always wins; a
            // machine-wide Stop hook (no positional) resolves from cwd via
            // Part 1's plain-fs resolver. No resolvable workspace (a folder
            // Atlas has never met) → 204 no-op: capture is best-effort by
            // contract, and a verbatim node is workspace-scoped anyway.
            const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined;
            const workspace = body.workspace || (cwd ? resolveWorkspaceForPath(cfg, cwd) ?? undefined : undefined);
            try {
                if (workspace) {
                    runVerbatimStore({
                        workspace,
                        text,
                        source,
                        ...(typeof body.timestamp === 'string' && body.timestamp ? { timestamp: body.timestamp } : {}),
                        ...(typeof body.topic === 'string' && body.topic ? { topic: body.topic } : {}),
                        ...(typeof body.sessionId === 'string' && body.sessionId ? { sessionId: body.sessionId } : {}),
                    });
                }
                res.writeHead(204);
                res.end();
            } catch {
                // The enqueue is pure queue-append and cannot realistically
                // throw, but if it ever does the capture is dropped quietly —
                // this endpoint must never break the session-end hook.
                res.writeHead(204);
                res.end();
            }
            return;
        }
        if (req.method === 'POST' && (req.url === '/api/chat/stream' || req.url?.startsWith('/api/chat/stream?'))) {
            // B3a SSE egress — bypasses the atlas_tool_invoke MCP shim (which
            // cannot carry per-token frames). Same bearer-token/host/origin
            // guard as /mcp (reuses enforceMcpAuth — no new auth scheme).
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            try {
                await handleChatStream(req, res, opts.home);
            } catch (err) {
                console.error(`[atlas] /api/chat/stream failed: ${(err as Error).message}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'chat_stream_failed' }));
                } else {
                    try { res.end(); } catch { /* already torn down */ }
                }
            }
            return;
        }
        if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            try {
                await handleMcp(req, res, bootTimeMs, activeSessions);
            } catch (err) {
                // #14: log the detail server-side; don't echo internal error
                // text back over the wire.
                console.error(`[atlas] /mcp dispatch failed: ${(err as Error).message}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'mcp_dispatch_failed' }));
                }
            }
            return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/api/fs/browse')) {
            // Filesystem browser for the web UI (browser mode only — Tauri uses native dialog).
            // enforceMcpAuth applies the Host/Origin + bearer gate; on top of that,
            // the target is constrained to a bounded root set (home subtree + any
            // configured index roots) so even an authenticated caller can't
            // enumerate arbitrary system directories (/etc, other users' homes).
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            try {
                const urlObj = new URL(req.url, `http://localhost`);
                const rawPath = urlObj.searchParams.get('path') ?? homedir();
                const expandedPath = rawPath === '~'
                    ? homedir()
                    : rawPath.startsWith('~/')
                        ? homedir() + rawPath.slice(1)
                        : rawPath;
                const dirPath = resolvePath(expandedPath);
                // RC security — reject any target outside the browsable root set
                // (lexical '..' reject + realpath containment, mirroring
                // atlas_source). Refuse BEFORE touching the filesystem.
                const browseErr = fsBrowsePathError(dirPath);
                if (browseErr) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: browseErr }));
                    return;
                }
                const showHidden = urlObj.searchParams.get('hidden') === '1';
                const entries = await readdir(dirPath, { withFileTypes: true });
                const dirs: { name: string; path: string }[] = [];
                for (const e of entries) {
                    if (!e.isDirectory()) continue;
                    if (!showHidden && e.name.startsWith('.')) continue;
                    dirs.push({ name: e.name, path: join(dirPath, e.name) });
                }
                dirs.sort((a, b) => a.name.localeCompare(b.name));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ path: dirPath, parent: dirname(dirPath), dirs }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
        }

        if (req.method === 'GET' && req.url === '/api/ide/status') {
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ clients: getIdeStatuses() }));
            return;
        }
        if (req.method === 'POST' && (req.url === '/api/ide/connect' || req.url === '/api/ide/disconnect')) {
            if (!authCtx || !enforceMcpAuth(req, res, authCtx)) return;
            const disconnect = req.url === '/api/ide/disconnect';
            try {
                const raw = await new Promise<string>((resolve, reject) => {
                    const chunks: Buffer[] = [];
                    req.on('data', (c: Buffer) => chunks.push(c));
                    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                    req.on('error', reject);
                });
                const { client } = JSON.parse(raw) as { client?: string };
                if (!client) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'client required' })); return; }
                const result = connectIde(client, disconnect);
                res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
        }

        // ── Static file serving — the built Atlas browser UI (atlas-ui/dist) ──
        //
        // This is PUBLIC loopback content: the HTML/CSS/JS app shell carries NO
        // secret (the mcp.token is delivered out-of-band via the launch URL, the
        // Jupyter model — never embedded in any served asset), so it is served
        // WITHOUT the bearer. The privileged surface (/mcp, /api/*, the
        // enforceMcpAuth gate) is handled ABOVE and is untouched: a co-resident
        // `curl http://127.0.0.1:<port>/` receives only the app shell, never the
        // token. Only GET reaches here (a stray POST /api/unknown falls to the
        // JSON 404 below).
        if (req.method === 'GET') {
            // No built UI on disk → serve a clear "run npm run build" page at /
            // instead of crashing or 404-ing to a blank screen.
            if (!UI_DIST) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(UI_NOT_BUILT_HTML);
                return;
            }
            const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
            const fsPath = resolveStaticFsPath(UI_DIST, urlPath);
            if (fsPath) {
                try {
                    const st = await stat(fsPath);
                    if (st.isFile()) {
                        const content = await readFile(fsPath);
                        res.writeHead(200, { 'Content-Type': MIME[extname(fsPath).toLowerCase()] ?? 'application/octet-stream' });
                        res.end(content);
                        return;
                    }
                    // A directory (or anything non-file) falls through to the SPA index.
                } catch { /* ENOENT / not a static asset → SPA fallback below */ }
            }
            // /.well-known/* (OAuth authorization-server / protected-resource
            // metadata) must 404 for real, not fall into the SPA shell: mcp-remote
            // (used by Claude Desktop to bridge to this server) probes these paths
            // during connect, and treats a 200 HTML body as malformed OAuth
            // metadata — it JSON.parses the response and crashes instead of
            // falling back to static-header auth. A genuine 404 tells it this
            // server has no OAuth AS, so it proceeds with the bearer header.
            if (urlPath.startsWith('/.well-known/')) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not_found', path: req.url ?? '' }));
                return;
            }
            // SPA fallback: any GET that isn't /mcp, /api/*, /health, /hooks/*, or
            // an existing static asset serves index.html so the client-side router
            // (React Router) resolves the route (/workspace/foo etc.).
            try {
                const html = await readFile(join(UI_DIST, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            } catch { /* index.html vanished after boot — fall through to 404 */ }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', path: req.url ?? '' }));
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(opts.port, '127.0.0.1', () => {
            httpServer.off('error', reject);
            resolve();
        });
    });

    const addr = httpServer.address();
    const effectivePort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
    authCtx = buildAuthContext(effectivePort, opts.home);
    if (authCtx.token) {
        console.error(`[atlas] /mcp auth: ON — clients must send 'Authorization: Bearer <token>' (token at <ATLAS_HOME>/mcp.token)`);
    } else {
        console.error('[atlas] /mcp auth: OFF (ATLAS_MCP_AUTH=off) — trusted local dev only');
    }
    if (UI_DIST) {
        console.error(`[atlas] serving browser UI from ${UI_DIST} at http://127.0.0.1:${effectivePort}/`);
    } else {
        console.error('[atlas] browser UI not built (no atlas-ui/dist) — run `cd atlas-ui && npm run build`; /mcp still available');
    }

    return {
        port: effectivePort,
        bootTimeMs,
        close: () =>
            new Promise<void>((resolve) => {
                clearInterval(sessionSweepTimer);
                for (const entry of activeSessions.values()) {
                    void entry.transport.close().catch(() => undefined);
                }
                activeSessions.clear();
                // httpServer.close(cb) only fires cb once EVERY existing
                // connection drains — a single idle keep-alive socket or an
                // open SSE chat stream would stall graceful shutdown forever.
                // Give live connections a short grace period to finish, then
                // force-close them (Node ≥18.2) and resolve either way.
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(forceTimer);
                    resolve();
                };
                const forceTimer = setTimeout(() => {
                    try { httpServer.closeAllConnections?.(); } catch { /* best-effort */ }
                    try { httpServer.closeIdleConnections?.(); } catch { /* best-effort */ }
                    finish();
                }, 3_000);
                forceTimer.unref?.();
                httpServer.close(() => finish());
            }),
    };
}

async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    bootTimeMs: number,
    activeSessions: Map<string, SessionEntry>,
): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
        const entry = activeSessions.get(sessionId);
        if (entry) {
            // Touch + refresh recency (delete+re-set moves it to the END of the
            // Map, matching embeddedRegistry's LRU-via-insertion-order trick) so
            // an actively-used session is never the LRU eviction victim.
            entry.lastActivityMs = Date.now();
            activeSessions.delete(sessionId);
            activeSessions.set(sessionId, entry);
            await entry.transport.handleRequest(req, res);
            return;
        }
    }

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) activeSessions.delete(sid);
    };

    const mcp = makeMcpServer(bootTimeMs);
    await mcp.connect(transport);

    await transport.handleRequest(req, res);

    const newSid = transport.sessionId;
    if (newSid) {
        activeSessions.set(newSid, { transport, lastActivityMs: Date.now() });
        // RD-Msession — cap AFTER insert so a burst of new-session requests
        // can't grow the map past MAX_ACTIVE_SESSIONS + (in-flight burst size)
        // for longer than the current tick; the newly-inserted session is
        // itself the most-recently-active so it's never the eviction victim.
        evictOverCap(activeSessions);
    }
}

// ── B3a: SSE chat-streaming egress ──────────────────────────────────────────────

/** Cap inbound body size — a streaming POST should never carry megabytes. */
const MAX_CHAT_BODY_BYTES = 256 * 1024;

interface ChatStreamBody {
    query?: string;
    /** Pre-built chat turns. When present, used verbatim (caller owns redaction). */
    messages?: ChatMessage[];
    /** Raw Atlas tool result to fold into the prompt as context. */
    context?: string;
    toolLabel?: string;
    /** Prior conversation turns (user/assistant), oldest first, for multi-turn
     *  memory. Folded in BEFORE the current query so follow-ups resolve against
     *  earlier context. Redacted server-side like all other content. */
    history?: ChatMessage[];
    /** Override the configured provider/model for this one request. */
    provider?: string;
    model?: string;
}

function readJsonBody(req: IncomingMessage): Promise<ChatStreamBody> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_CHAT_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8').trim();
            if (text.length === 0) { resolve({}); return; }
            try {
                resolve(JSON.parse(text) as ChatStreamBody);
            } catch {
                reject(new Error('request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/** Write one SSE frame and flush past any buffering proxy. */
function writeSseFrame(res: ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    // `flush` exists when compression middleware wraps the response; harmless otherwise.
    const flushable = res as ServerResponse & { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
}

/**
 * POST /api/chat/stream — Server-Sent Events egress for token-by-token chat.
 *
 * Request body (all optional except a source of prompt):
 *   { query?, messages?, context?, toolLabel?, provider?, model? }
 * Falls back to the daemon's configured llm_config for provider/model
 * when omitted.
 *
 * Response: text/event-stream. Per token:  data: {"token":"…"}\n\n
 * On completion:                            data: {"done":true,"fullText":"…"}\n\n
 * On error:                                 data: {"error":"…"}\n\n   then end.
 *
 * Test hook: set ATLAS_LLM_FAKE_STREAM=1 to bypass real providers and
 * stream a fixed token sequence (["Hello"," ","world","!"]) with a small
 * per-token delay — proves incremental egress without a live model.
 */
async function handleChatStream(req: IncomingMessage, res: ServerResponse, home?: string): Promise<void> {
    let body: ChatStreamBody;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', detail: (err as Error).message }));
        return;
    }

    const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
    const query = typeof body.query === 'string' ? body.query : '';
    if (!hasMessages && query.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', detail: 'query or messages required' }));
        return;
    }

    // Resolve provider/model: per-request override → configured llm → none.
    const cfg = loadConfig(home);
    let llm = cfg.llm;
    if (body.provider || body.model) {
        const validProviders = ['ollama', 'openai', 'anthropic', 'none'] as const;
        const overrideProvider = validProviders.includes(body.provider as never)
            ? (body.provider as (typeof validProviders)[number])
            : (llm?.provider ?? 'none');
        llm = {
            provider: overrideProvider,
            model: body.model ?? llm?.model ?? '',
            apiKey: llm?.apiKey,
            ollamaUrl: llm?.ollamaUrl,
        };
    }

    // Open the SSE stream. Headers chosen to defeat proxy/browser buffering.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    try {
        const result = await streamChat(
            llm,
            { query, context: body.context, toolLabel: body.toolLabel },
            (token) => writeSseFrame(res, { token }),
            hasMessages ? body.messages : undefined,
            Array.isArray(body.history) ? body.history : undefined,
        );
        writeSseFrame(res, {
            done: true,
            fullText: result.fullText,
            provider: result.provider,
            model: result.model,
            contextWithheld: result.contextWithheld,
        });
    } catch (err) {
        // Stream already open → deliver the error as an SSE frame, not a status code.
        writeSseFrame(res, { error: (err as Error).message });
    } finally {
        res.end();
    }
}
