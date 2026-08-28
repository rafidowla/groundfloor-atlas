/**
 * atlasApi.ts — thin client for the Groundfloor Atlas MCP shim at http://127.0.0.1:3848
 *
 * The Groundfloor Atlas MCP server exposes three meta-tools (atlas_tool_list,
 * atlas_tool_schema, atlas_tool_invoke). All real tools are invoked
 * through atlas_tool_invoke with the tool name + args.
 */

// The daemon serves this UI at its OWN origin, so a production build must talk to
// window.location.origin — this works under any ATLAS_PORT, not just the default.
// The vite dev server (5173/1421) runs the UI separately from the daemon, and
// node/tests have no window; both fall back to the default daemon port.
export const ATLAS_BASE: string = (() => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3848';
  const origin = window.location.origin;
  if (!origin || origin === 'null' || origin.startsWith('file:')) return 'http://127.0.0.1:3848';
  if (/:(5173|1421)$/.test(origin)) return 'http://127.0.0.1:3848'; // vite dev → daemon on :3848
  return origin; // served by the daemon → same origin (any port)
})();
const MCP_ENDPOINT = `${ATLAS_BASE}/mcp`;

interface McpRequest {
  jsonrpc: '2.0';
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
  id: number;
}

interface McpContentItem {
  type: string;
  text?: string;
}

interface McpResult {
  content?: McpContentItem[];
  isError?: boolean;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: McpResult;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * AtlasToolError — surfaced when the MCP transport itself succeeded (HTTP 200)
 * but the RESULT BODY reports failure. The daemon's tool endpoint intentionally
 * returns 200 on failure (see toolRegistry.ts's `{error, detail}` path and
 * atlas_index's `{ok: totals.errors.length === 0, errors: [...]}` shape), so
 * `res.ok` alone can never be trusted — every caller MUST inspect the parsed
 * body. This class carries that structured failure through the normal
 * try/catch path every `invokeAtlasTool` call site already uses, so nothing
 * downstream needs to learn a new calling convention.
 */
export class AtlasToolError extends Error {
  /** Machine-readable detail blob (validation errors, per-file index errors, etc). */
  detail?: unknown;
  /** Present only for the index tool: per-file/edge errors from a partial run. */
  errors?: unknown[];
  /** The raw parsed tool result, for callers that want the full shape
   *  (e.g. to check partial success — some files written despite errors). */
  raw?: unknown;

  constructor(message: string, opts?: { detail?: unknown; errors?: unknown[]; raw?: unknown }) {
    super(message);
    this.name = 'AtlasToolError';
    this.detail = opts?.detail;
    this.errors = opts?.errors;
    this.raw = opts?.raw;
  }
}

/**
 * AtlasDaemonUnreachableError — surfaced when the fetch itself REJECTS
 * (connection refused, daemon not running, network error — typically a
 * `TypeError: Failed to fetch`). Distinct from AtlasToolError: this means we
 * never got a response from the daemon at all, vs. getting a 200 with a
 * failure body. Callers (useGraphData, AddProjectModal) key off this type to
 * show a "daemon not reachable" state instead of a generic error/empty state.
 */
export class AtlasDaemonUnreachableError extends Error {
  url: string;
  cause?: unknown;

  constructor(url: string, cause?: unknown) {
    super(`Groundfloor Atlas daemon not reachable at ${url}`);
    this.name = 'AtlasDaemonUnreachableError';
    this.url = url;
    this.cause = cause;
  }
}

/** True for the network-level failures `fetch` throws when nothing is
 *  listening (connection refused) — as opposed to an HTTP error response,
 *  which resolves normally with a non-ok status. */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

let _sessionId: string | null = null;

// ── MCP bearer token (RC security) — the Jupyter URL-token model ─────────────
//
// The daemon now serves this browser UI at its OWN origin (same daemon, same
// port as /mcp) with `/mcp` auth ON: it mints `<ATLAS_HOME>/mcp.token` (mode
// 0600) and requires `Authorization: Bearer <token>` on /mcp, /api/chat/stream,
// and /api/fs/browse. There is no Tauri IPC anymore. Instead the token reaches
// the browser OUT-OF-BAND via the launch URL that `atlas serve` /
// `atlas service install` prints (and --open opens):
//
//     http://127.0.0.1:3848/?token=<mcp.token>
//
// On first call we read the token from the URL (query `?token=` and/or hash
// `#token=`), keep it in this module-scope variable, and IMMEDIATELY strip it
// from the address bar via history.replaceState so it isn't left in history or
// shoulder-surfed. A different local user can load the (public, secret-free)
// app shell but can't read the 0600 token file and never saw the launching
// terminal, so they can't authenticate.
//
// Fallback: if there's no token in the URL (e.g. plain browser dev against a
// daemon started with `ATLAS_MCP_AUTH=off`), this no-ops and buildAtlasHeaders()
// sends no Authorization header — which an auth-off daemon accepts, so dev keeps
// working.
let _mcpToken: string | null = null;
let _tokenRead = false;

// Persist the captured token for THIS TAB SESSION so a refresh (F5) or any full
// page reload doesn't lose it and 401 the user (the launch URL's ?token= is
// scrubbed on first read, so it isn't there on reload). sessionStorage is
// same-origin, tab-scoped, and cleared when the tab closes — it is NOT the URL
// or history (what the Jupyter-token model deliberately avoids), and the token
// is loopback-only, so this is a safe place to survive reloads.
const TOKEN_STORAGE_KEY = 'lb-mcp-token';

/**
 * Pull the token out of the current URL (query `?token=` OR hash `#token=`),
 * then scrub it from the address bar. Returns the token, or null if none.
 * Pure of network — a single synchronous DOM read + a history.replaceState.
 */
function readTokenFromUrl(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const loc = window.location;

  let token: string | null = null;
  try {
    token = new URLSearchParams(loc.search).get('token');
  } catch { /* malformed search — ignore */ }
  // Also accept a hash-carried token (`#token=…` or `#/route?token=…`) so the
  // secret can ride the fragment (never sent to the server) if preferred.
  if (!token && loc.hash) {
    const hash = loc.hash.replace(/^#/, '');
    const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
    try {
      token = new URLSearchParams(q).get('token');
    } catch { /* malformed hash — ignore */ }
  }
  const trimmed = token?.trim();
  if (!trimmed) return null;

  // Strip the token from the visible URL so it isn't left in history/shoulder-
  // surfed. Rebuild search + hash without the `token` param, preserving any
  // other params and the route.
  try {
    const search = new URLSearchParams(loc.search);
    search.delete('token');
    let newHash = loc.hash;
    if (loc.hash) {
      const raw = loc.hash.replace(/^#/, '');
      if (raw.includes('?')) {
        const [route, qs] = [raw.slice(0, raw.indexOf('?')), raw.slice(raw.indexOf('?') + 1)];
        const hp = new URLSearchParams(qs);
        hp.delete('token');
        const rest = hp.toString();
        newHash = rest ? `#${route}?${rest}` : `#${route}`;
      } else {
        const hp = new URLSearchParams(raw);
        if (hp.has('token')) {
          hp.delete('token');
          const rest = hp.toString();
          newHash = rest ? `#${rest}` : '';
        }
      }
    }
    const qs = search.toString();
    const cleaned = `${loc.pathname}${qs ? `?${qs}` : ''}${newHash}`;
    window.history.replaceState(window.history.state, '', cleaned);
  } catch { /* replaceState unavailable (e.g. test env) — token is still captured */ }

  return trimmed;
}

/**
 * Packaged-desktop fallback: read the token via the Tauri `read_mcp_token`
 * command. The bundled webview loads the app's own frontend URL (tauri://…)
 * with NO `?token=` on it, so URL capture + storage recovery find nothing and
 * every daemon call 401s — the Rust command (registered, auth-critical per
 * lib.rs) existed but was never invoked from here. Returns null outside Tauri
 * or when the daemon never mints a token in time.
 */
async function readTokenFromTauri(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // First launch races the daemon's token mint — the command returns '' until
    // the file exists, so retry briefly before concluding there is no token.
    for (let attempt = 0; attempt < 10; attempt++) {
      const raw = await invoke<string>('read_mcp_token');
      const token = (raw ?? '').trim();
      if (token) return token;
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch { /* command unavailable / invoke failed — treat as no token */ }
  return null;
}

/**
 * Capture the daemon's inbound MCP bearer token from the launch URL, once.
 * Synchronous under the hood but kept async so every existing `await
 * ensureMcpToken()` call site is unchanged. Idempotent: reads + scrubs the URL
 * on the first call only; later calls short-circuit. When the URL carries no
 * token (auth-off dev), it's a graceful no-op — no header is sent.
 */
export async function ensureMcpToken(): Promise<void> {
  if (_tokenRead) return;
  _tokenRead = true;
  const fromUrl = readTokenFromUrl();
  if (fromUrl) {
    _mcpToken = fromUrl;
    // Persist so later visits keep working. sessionStorage keeps it for THIS
    // tab; localStorage makes it durable so a FRESH tab, a bookmark, or a
    // browser restart recovers it too — the launch URL strips `?token=` after
    // the first read, so without the durable copy a bare revisit to the daemon
    // 401s (there's no token to send). The token is a local-daemon bearer on
    // 127.0.0.1, so durable local storage is an acceptable tradeoff for the UX.
    try { sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch { /* storage disabled / private mode — token still held in memory */ }
    try { localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch { /* ignore — sessionStorage / memory still hold it */ }
  } else {
    // No token in the launch URL (a refresh, a new tab, or a bookmarked bare
    // URL). Recover the one captured earlier — this-tab session first, then the
    // durable store — so the UI keeps working without re-running `serve --open`.
    try {
      _mcpToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch { /* ignore */ }
    // Packaged desktop app: no URL token and no prior capture — ask the Rust
    // side for the daemon's own token (see readTokenFromTauri). Persist it the
    // same way so later reloads skip the IPC round-trip.
    if (!_mcpToken) {
      const fromTauri = await readTokenFromTauri();
      if (fromTauri) {
        _mcpToken = fromTauri;
        try { sessionStorage.setItem(TOKEN_STORAGE_KEY, fromTauri); } catch { /* memory still holds it */ }
        try { localStorage.setItem(TOKEN_STORAGE_KEY, fromTauri); } catch { /* ignore */ }
      }
    }
  }
}

/** Test/reset seam — set or clear the in-memory token (used by unit tests). */
export function __setMcpTokenForTest(token: string | null): void {
  _mcpToken = token;
  _tokenRead = token !== null; // a set token means "already read"; null re-arms
}

/**
 * Build the request headers Groundfloor Atlas uses to talk to the daemon.
 *
 * This is the SINGLE source of truth for how the frontend authenticates to
 * the daemon. The daemon boots with mcp-auth ON, so we attach
 * `Authorization: Bearer <token>` using the token captured by ensureMcpToken()
 * from the launch URL (`?token=…`, the Jupyter model). We also forward the
 * `mcp-session-id` captured from the first MCP response so the daemon can
 * correlate requests. Any new fetch to the daemon (e.g. the streaming chat
 * route /api/chat/stream) must reuse this exact builder so it authenticates
 * identically to /mcp.
 *
 * When the launch URL carried no token (browser dev against an auth-off dev
 * daemon) no token is set, so no Authorization header is sent — which an
 * auth-off daemon accepts.
 */
export function buildAtlasHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (_mcpToken) {
    headers['Authorization'] = `Bearer ${_mcpToken}`;
  }
  if (_sessionId) {
    headers['mcp-session-id'] = _sessionId;
  }
  return headers;
}

let _reqId = 0;
let _initPromise: Promise<void> | null = null;

/**
 * Bug #1: the daemon's stateful MCP transport requires an `initialize` handshake
 * before any `tools/call` — a bare call returns 400 "Server not initialized".
 * The client never sent it. Memoized so concurrent first calls handshake once,
 * capturing the `mcp-session-id` all later calls reuse via buildAtlasHeaders().
 */
async function ensureInitialized(): Promise<void> {
  if (_sessionId) return;
  if (!_initPromise) {
    _initPromise = (async () => {
      // RC security — load the bearer token BEFORE the handshake. The
      // initialize call hits the now-auth-gated /mcp endpoint, so it must carry
      // the Authorization header (buildAtlasHeaders attaches it once loaded).
      await ensureMcpToken();
      let r: Response;
      try {
        r = await fetch(MCP_ENDPOINT, {
          method: 'POST',
          headers: buildAtlasHeaders(),
          body: JSON.stringify({
            jsonrpc: '2.0', id: 0, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'groundfloor-atlas-ui', version: '1' } },
          }),
        });
      } catch (err) {
        // The handshake fetch itself rejected — daemon isn't listening at all.
        // Surface a distinct, actionable error rather than a generic network
        // exception so the UI can render a "daemon not reachable" state.
        if (isNetworkFailure(err)) throw new AtlasDaemonUnreachableError(ATLAS_BASE, err);
        throw err;
      }
      const sid = r.headers.get('mcp-session-id');
      if (sid) _sessionId = sid;
      try {
        await fetch(MCP_ENDPOINT, {
          method: 'POST',
          headers: buildAtlasHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
      } catch { /* best-effort notification */ }
    })().catch((err: unknown) => {
      // ATL-044: a transient handshake failure (daemon not up yet, 5xx, network
      // blip) must not wedge the client forever. Clear the memoized promise so
      // the NEXT call re-handshakes instead of re-awaiting a permanently-rejected
      // one. This call still rejects so the caller sees the failure.
      _initPromise = null;
      throw err;
    });
  }
  await _initPromise;
}

async function mcpPost(body: McpRequest): Promise<McpResult> {
  await ensureInitialized();
  const headers = buildAtlasHeaders();
  // Bug #5: every call previously reused `id: 1`; concurrent calls then couldn't
  // be correlated. Assign a unique id per request and match the response to it.
  const reqId = ++_reqId;

  let res: Response;
  try {
    res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, id: reqId }),
    });
  } catch (err) {
    // Point 3: the fetch itself REJECTED — connection refused / daemon not
    // running (typically `TypeError: Failed to fetch`). This is categorically
    // different from an HTTP error response (which resolves normally): we
    // never got a response at all. Surface it distinctly so callers can show
    // a "daemon not reachable" state instead of a generic error.
    if (isNetworkFailure(err)) throw new AtlasDaemonUnreachableError(ATLAS_BASE, err);
    throw err;
  }

  // Capture session id from response headers
  const sid = res.headers.get('mcp-session-id');
  if (sid) _sessionId = sid;

  if (!res.ok) {
    throw new Error(`Groundfloor Atlas MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  // Bug #4: stream-read the SSE and resolve on the FIRST JSON-RPC frame matching
  // our request id, then cancel. The stateful server keeps the channel open for
  // server→client messages, so `await res.text()` would block forever waiting
  // for the stream to close.
  if (contentType.includes('text/event-stream') && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const parsed = JSON.parse(data) as McpResponse;
          if ((parsed.result !== undefined || parsed.error) && parsed.id === reqId) {
            void reader.cancel().catch(() => {});
            if (parsed.error) {
              throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
            }
            return parsed.result ?? {};
          }
        }
        if (done) break;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    return {};
  }

  const json: McpResponse = await res.json();
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return json.result ?? {};
}

/**
 * Parse the text content out of an MCP result.
 */
function parseResultContent(result: McpResult): unknown {
  const textItem = result.content?.find((c) => c.type === 'text');
  if (!textItem?.text) return null;
  try {
    return JSON.parse(textItem.text);
  } catch {
    return textItem.text;
  }
}

/**
 * THE FIX (audit finding): the daemon returns HTTP 200 even when a tool call
 * fails — toolRegistry.ts's catch-all returns `{error, detail}` with a 200
 * status, and atlas_index reports partial/total failure via `{ok: false,
 * errors: [...]}` while still 200. `mcpPost`'s `res.ok` check therefore never
 * catches these; the failure is only visible in the PARSED RESULT BODY. This
 * function is the single source of truth for "did the tool actually succeed,"
 * called from `invokeAtlasTool` after every response so every call site (all
 * of which already try/catch or .catch()) gets a real thrown error instead of
 * a silently-returned success-shaped object.
 *
 * Failure is detected when any of:
 *   - the MCP envelope itself reports `isError === true`
 *   - the parsed tool result has a top-level `error` (string) — the
 *     toolRegistry unknown_tool / invalid_arguments / tool_execution_failed
 *     shape, optionally with a `detail` field
 *   - the parsed tool result is the index-tool shape: `ok === false` and/or a
 *     non-empty `errors` array (atlas_index's partial/total failure report)
 *
 * A partial index (some files written despite errors) still throws — the
 * caller (AddProjectModal) inspects `err.raw` / `err.errors` to distinguish a
 * clean failure from a partial-success-with-errors and render the amber
 * "indexed with N errors" state rather than a red hard failure.
 */
function detectToolFailure(envelope: McpResult, parsed: unknown): AtlasToolError | null {
  if (envelope.isError === true) {
    const textItem = envelope.content?.find((c) => c.type === 'text');
    return new AtlasToolError(textItem?.text || 'Tool call failed', { raw: parsed });
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;

    // toolRegistry.ts error shape: { error: string, detail?, tool? }
    if (typeof obj['error'] === 'string') {
      return new AtlasToolError(obj['error'], { detail: obj['detail'], raw: parsed });
    }

    // atlas_index shape: { ok: boolean, errors?: [...] }
    const hasOkFalse = obj['ok'] === false;
    const errorsArr = Array.isArray(obj['errors']) ? (obj['errors'] as unknown[]) : undefined;
    if (hasOkFalse || (errorsArr && errorsArr.length > 0)) {
      const count = errorsArr?.length ?? 0;
      const message = count > 0
        ? `Index reported ${count} error${count === 1 ? '' : 's'}`
        : 'Tool reported ok: false';
      return new AtlasToolError(message, { errors: errorsArr, raw: parsed });
    }
  }

  return null;
}

/**
 * Invoke any Groundfloor Atlas tool by name with optional args.
 *
 * Throws `AtlasDaemonUnreachableError` if the daemon can't be reached at all,
 * or `AtlasToolError` if the daemon responded but the tool call itself failed
 * (per `detectToolFailure` above) — callers should not treat a resolved
 * promise as proof of success without also handling these rejections.
 */
export async function invokeAtlasTool(
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcpPost({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'atlas_tool_invoke',
      arguments: { tool, args: args ?? {} },
    },
    id: 1,
  });
  const parsed = parseResultContent(result);
  const failure = detectToolFailure(result, parsed);
  if (failure) throw failure;
  return parsed;
}

/**
 * List all available Groundfloor Atlas tools with their names and descriptions.
 */
export async function listAtlasTools(): Promise<Array<{ name: string; description: string }>> {
  const result = await mcpPost({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'atlas_tool_invoke',
      arguments: { tool: 'atlas_tool_list', args: {} },
    },
    id: 1,
  });
  const parsed = parseResultContent(result);
  if (
    parsed &&
    typeof parsed === 'object' &&
    'tools' in parsed &&
    Array.isArray((parsed as { tools: unknown }).tools)
  ) {
    return (parsed as { tools: Array<{ name: string; description: string }> }).tools;
  }
  return [];
}

export interface AtlasHealth {
  status: string;
  version: string;
  uptime_ms: number;
}

/**
 * Check Groundfloor Atlas daemon health. Uses the /health REST endpoint directly
 * for speed (no MCP overhead on the polling hot path).
 */
export async function checkAtlasHealth(): Promise<AtlasHealth> {
  const res = await fetch(`${ATLAS_BASE}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Groundfloor Atlas health check failed: ${res.status}`);
  }
  return res.json() as Promise<AtlasHealth>;
}
