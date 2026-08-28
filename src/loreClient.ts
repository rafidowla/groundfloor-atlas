/**
 * loreClient.ts — Groundfloor Atlas → Lore WRITE bridge (Sprint Y: keep-alive REST).
 *
 * Sprint Y swap: previously this class talked to Lore via the MCP shim
 * (lore_tool_invoke → store_node/store_edge). Sprint W shipped POST
 * /api/edge so writes can ride the same keep-alive HTTP pattern that
 * Sprint X's loreReader already uses for reads. Three wins:
 *
 *   1. ONE persistent HTTP connection across the whole indexing run,
 *      not N MCP sessions (each session = handshake + initialize +
 *      tools/list probe + notifications/initialized).
 *   2. embed:false on every code-type write — code_symbol /
 *      code_file are graph-only by design; the embedding cost
 *      was wasted work.
 *   3. Symmetric error handling with the reader (same backoff,
 *      same Retry-After honoring, same Bearer source).
 *
 * Back-compat note: the live daemon at the operator's box may predate
 * Sprint W. POST /api/edge returns 404 on pre-W daemons, and POST
 * /api/node returns 400 unknown_field:embed when the embed flag is
 * sent. We detect both and fall back to MCP store_edge / drop the
 * embed flag so this commit is safe to land before Sprint W is
 * deployed. The fall-back path keeps the legacy MCP transport handy
 * but only spins it up on first 404 — so the perf win is in effect
 * on deployed-Sprint-W daemons even though the code remains compatible.
 *
 * Auth: same Bearer-from-~/.groundfloor/atlas/auth.token as loreReader.
 * Constructor accepts the token (read by callers from disk so testing
 * stays I/O-free).
 */

import { URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secureRequest, type TransportResult } from './httpTransport.js';

export interface StoreNodeInput {
    id: string;
    type: string;
    label: string;
    content?: string;
    tags?: string;
    workspace: string;
    /** W1 (Sprint W) — when explicitly false, Lore writes the graph
     *  row only; no lancedb mirror, no autolink. Default true preserves
     *  legacy embed behavior. Code-type callers (codeNodes.ts) pass
     *  false; knowledge-type callers leave undefined. */
    embed?: boolean;
    /** Additional fields tunnelled through verbatim. */
    [extra: string]: unknown;
}

export interface StoreEdgeInput {
    sourceId: string;
    targetId: string;
    relation: string;
    workspace: string;
    bidirectional?: boolean;
    confidence?: 'extracted' | 'inferred' | 'ambiguous';
    confidenceScore?: number;
}

export interface LoreClientOpts {
    mcpUrl: string;
    token: string;
}

/**
 * The write surface Groundfloor Atlas's indexer depends on. Both the HTTP `LoreClient`
 * and the in-process `EmbeddedLore` adapter implement it, so `atlas index`
 * and the BatchWriter work against either transport (the embed-as-library
 * cutover, behind `lore.mode`).
 */
export interface LoreWriter {
    // CONTRACT (load-bearing — a 2026-06-29 CRITICAL regression came from breaking
    // it): the bulk writers are PER-ITEM tolerant, NOT all-or-nothing. A single
    // failing row sets its own `results[i].ok = false` (with `error`) and the rest
    // still land; the call NEVER rolls back the whole batch. `succeeded` counts the
    // ok rows and `results` is positional (results[i] ↔ input[i]) so a caller can
    // attribute a failure back to its source file. Forward-reference edges
    // legitimately fail with "endpoint missing" and must not take their batch down.
    // BOTH implementations (LoreClient HTTP, EmbeddedLore in-process) must match.
    connect(): Promise<void>;
    close(): Promise<void>;
    storeNode(input: StoreNodeInput): Promise<unknown>;
    storeEdge(input: StoreEdgeInput): Promise<unknown>;
    bulkStoreNodes(nodes: StoreNodeInput[]): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; id?: string; error?: string }> }>;
    bulkStoreEdges(edges: StoreEdgeInput[]): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; error?: string }> }>;
}

export class LoreAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoreAuthError';
    }
}

function backoffMs(attempt: number): number {
    return Math.min(500 * Math.pow(2, attempt), 30_000);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function restBase(mcpUrl: string): string {
    return mcpUrl.replace(/\/mcp\/?$/, '');
}

// Transport (http/https selection, no-token-over-plaintext, request
// timeout, keep-alive pool) is centralized in httpTransport.ts — review
// #2/#3/#6. This thin wrapper preserves the existing call signature.
function httpPost(urlStr: string, token: string, body: string): Promise<TransportResult> {
    return secureRequest('POST', urlStr, { token, body });
}

async function postJson(base: string, pathOnly: string, token: string, payload: unknown): Promise<TransportResult> {
    const url = `${base}${pathOnly}`;
    const body = JSON.stringify(payload);
    // ATL-064: bound TOTAL attempts (not just the no-header path) and CAP the
    // honored wait. A daemon that returns 429 + a `Retry-After-Ms` header on
    // every response would otherwise retry forever (and an absurd header value
    // would sleep for that long), hanging the caller.
    const MAX_ATTEMPTS = 8;
    const MAX_WAIT_MS = 30_000;
    let attempt = 0;
    // Same 429 handling shape as loreReader's GET helper.
    while (attempt < MAX_ATTEMPTS) {
        const r = await httpPost(url, token, body);
        if (r.status === 429) {
            const retryAfterSec = Number(r.headers['retry-after']);
            const retryAfterMs = Number(r.headers['retry-after-ms']);
            let wait: number;
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) wait = retryAfterMs;
            else if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
                wait = retryAfterSec * 1000 + Math.floor(Math.random() * 250);
            } else {
                wait = backoffMs(attempt);
            }
            attempt += 1;
            await sleep(Math.min(wait, MAX_WAIT_MS));
            continue;
        }
        return r;
    }
    throw new Error(`Lore REST ${pathOnly} → HTTP 429 after ${MAX_ATTEMPTS} retries`);
}

export class LoreClient implements LoreWriter {
    private readonly base: string;
    // Lazy MCP fallback — only created on first 404 from POST /api/edge
    // (operator running a pre-W daemon). Production-deployed Sprint W
    // never enters this branch; the keep-alive REST is the hot path.
    private mcpFallback: Client | null = null;
    private mcpTransport: StreamableHTTPClientTransport | null = null;
    private mcpConnected = false;
    // Sticky-false: once the daemon rejects embed:false with 400
    // unknown_field, every subsequent storeNode drops the flag for
    // the lifetime of this client. Per-request retry would burn an
    // extra RTT for every code-type write.
    private daemonAcceptsEmbedFlag = true;
    // Same sticky-false for the /api/edge endpoint: a single 404
    // promotes the edge path to the MCP fallback for the rest of
    // the run.
    private daemonHasEdgeEndpoint = true;
    // Y3 (Sprint Y3) — sticky-false for the W9 bulk endpoints
    // (POST /api/nodes/bulk + /api/edges/bulk). Pre-W9 daemons 404
    // both; on the first 404 we fall back to sequential per-item
    // writes for the rest of the run.
    private daemonHasBulkEndpoints = true;

    constructor(private opts: LoreClientOpts) {
        this.base = restBase(opts.mcpUrl);
    }

    /** Pre-flight no-op (kept for callsite compatibility). REST has no
     *  session to bootstrap. */
    async connect(): Promise<void> { return; }

    async close(): Promise<void> {
        const c = this.mcpFallback;
        const t = this.mcpTransport;
        this.mcpFallback = null;
        this.mcpTransport = null;
        this.mcpConnected = false;
        if (c) await c.close().catch(() => undefined);
        if (t) await t.close().catch(() => undefined);
    }

    /** Y2-friendly: storeNode honors `embed` field; falls back when
     *  daemon predates Sprint W. */
    async storeNode(input: StoreNodeInput): Promise<unknown> {
        const payload: Record<string, unknown> = { ...input };
        if (!this.daemonAcceptsEmbedFlag && 'embed' in payload) {
            // Pre-W daemon: drop the flag before sending.
            delete payload['embed'];
        }
        const r = await postJson(this.base, '/api/node', this.opts.token, payload);
        if (r.status === 400 && r.body.includes('unknown_field') && r.body.includes('embed')) {
            // Pre-W daemon rejected embed flag. Strip + retry once,
            // then stick the decision for the lifetime of this client.
            this.daemonAcceptsEmbedFlag = false;
            const fallback = { ...payload };
            delete fallback['embed'];
            const retry = await postJson(this.base, '/api/node', this.opts.token, fallback);
            return this.parseOrThrow(retry, '/api/node');
        }
        if (r.status === 401 || r.status === 403) {
            throw new LoreAuthError(
                `auth token not accepted by Lore on POST /api/node (HTTP ${r.status}); verify ~/.groundfloor/atlas/auth.token`,
            );
        }
        return this.parseOrThrow(r, '/api/node');
    }

    /** Y1: POST /api/edge (W2) with MCP fallback for pre-W daemons. */
    async storeEdge(input: StoreEdgeInput): Promise<unknown> {
        if (this.daemonHasEdgeEndpoint) {
            const r = await postJson(this.base, '/api/edge', this.opts.token, input);
            if (r.status === 404) {
                // Pre-W daemon: edge endpoint not deployed. Promote to
                // MCP for the remainder of this client's lifetime.
                this.daemonHasEdgeEndpoint = false;
                return this.storeEdgeViaMcp(input);
            }
            if (r.status === 401 || r.status === 403) {
                throw new LoreAuthError(
                    `auth token not accepted by Lore on POST /api/edge (HTTP ${r.status})`,
                );
            }
            return this.parseOrThrow(r, '/api/edge');
        }
        return this.storeEdgeViaMcp(input);
    }

    /** Legacy MCP path — only used when POST /api/edge returned 404. */
    private async storeEdgeViaMcp(input: StoreEdgeInput): Promise<unknown> {
        await this.ensureMcpConnected();
        const res = await this.mcpFallback!.callTool({
            name: 'lore_tool_invoke',
            arguments: { name: 'store_edge', input: input as unknown as Record<string, unknown> },
        });
        const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
        const text = content[0]?.text ?? '';
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }

    private async ensureMcpConnected(): Promise<void> {
        if (this.mcpConnected && this.mcpFallback) return;
        this.mcpTransport = new StreamableHTTPClientTransport(new URL(this.opts.mcpUrl), {
            requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
        });
        this.mcpFallback = new Client({ name: 'atlas-write-fallback', version: '0.2.0' });
        try {
            await this.mcpFallback.connect(this.mcpTransport);
            this.mcpConnected = true;
        } catch (err) {
            // Best-effort cleanup; the next call will retry.
            await this.mcpFallback.close().catch(() => undefined);
            await this.mcpTransport.close().catch(() => undefined);
            this.mcpFallback = null;
            this.mcpTransport = null;
            this.mcpConnected = false;
            const msg = (err as Error).message ?? String(err);
            if (/401|auth/i.test(msg)) {
                throw new LoreAuthError(
                    `MCP fallback for POST /api/edge could not authenticate (raw: ${msg})`,
                );
            }
            throw err;
        }
    }

    private parseOrThrow(r: TransportResult, where: string): unknown {
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`Lore REST ${where} → HTTP ${r.status}: ${r.body.slice(0, 200)}`);
        }
        if (!r.body) return null;
        try { return JSON.parse(r.body); } catch { return r.body; }
    }

    /**
     * Y3 (Sprint Y3) — bulk write via Lore W9's POST /api/nodes/bulk
     * (rate-limit-exempt). Returns the per-item results array verbatim
     * so the caller can correlate failures back to file paths. Falls
     * back to sequential storeNode calls on 404 from pre-W9 daemons
     * (sticky for the lifetime of the client to avoid an extra RTT per
     * subsequent batch). Empty array short-circuits without a request.
     *
     * Groundfloor Atlas indexer cadence is ~50 files per batch (default) → ~150
     * nodes per call on typical TS files — well under W9's 1000-item
     * cap. The caller chunks if it ever exceeds.
     */
    async bulkStoreNodes(
        nodes: StoreNodeInput[],
    ): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; id?: string; error?: string }> }> {
        if (nodes.length === 0) {
            return { ok: true, count: 0, succeeded: 0, results: [] };
        }
        const payload: Record<string, unknown> = { nodes };
        if (this.daemonHasBulkEndpoints) {
            const r = await postJson(this.base, '/api/nodes/bulk', this.opts.token, payload);
            if (r.status === 404) {
                this.daemonHasBulkEndpoints = false;
                return this.bulkStoreNodesFallback(nodes);
            }
            if (r.status === 401 || r.status === 403) {
                throw new LoreAuthError(
                    `auth token not accepted by Lore on POST /api/nodes/bulk (HTTP ${r.status})`,
                );
            }
            return this.parseOrThrow(r, '/api/nodes/bulk') as never;
        }
        return this.bulkStoreNodesFallback(nodes);
    }

    private async bulkStoreNodesFallback(
        nodes: StoreNodeInput[],
    ): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; id?: string; error?: string }> }> {
        const results: Array<{ ok: boolean; id?: string; error?: string }> = [];
        let succeeded = 0;
        for (const n of nodes) {
            try {
                await this.storeNode(n);
                results.push({ ok: true, id: n.id });
                succeeded++;
            } catch (err) {
                results.push({ ok: false, id: n.id, error: (err as Error).message });
            }
        }
        return { ok: succeeded === nodes.length, count: nodes.length, succeeded, results };
    }

    /** Y3 — bulk edge write via Lore W9's POST /api/edges/bulk. Same
     *  shape as bulkStoreNodes; falls back to sequential storeEdge on
     *  404 (sticky). */
    async bulkStoreEdges(
        edges: StoreEdgeInput[],
    ): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; error?: string }> }> {
        if (edges.length === 0) {
            return { ok: true, count: 0, succeeded: 0, results: [] };
        }
        if (this.daemonHasBulkEndpoints) {
            const r = await postJson(this.base, '/api/edges/bulk', this.opts.token, { edges });
            if (r.status === 404) {
                this.daemonHasBulkEndpoints = false;
                return this.bulkStoreEdgesFallback(edges);
            }
            if (r.status === 401 || r.status === 403) {
                throw new LoreAuthError(
                    `auth token not accepted by Lore on POST /api/edges/bulk (HTTP ${r.status})`,
                );
            }
            return this.parseOrThrow(r, '/api/edges/bulk') as never;
        }
        return this.bulkStoreEdgesFallback(edges);
    }

    private async bulkStoreEdgesFallback(
        edges: StoreEdgeInput[],
    ): Promise<{ ok: boolean; count: number; succeeded: number; results: Array<{ ok: boolean; error?: string }> }> {
        const results: Array<{ ok: boolean; error?: string }> = [];
        let succeeded = 0;
        for (const e of edges) {
            try {
                await this.storeEdge(e);
                results.push({ ok: true });
                succeeded++;
            } catch (err) {
                results.push({ ok: false, error: (err as Error).message });
            }
        }
        return { ok: succeeded === edges.length, count: edges.length, succeeded, results };
    }

    /** Legacy invoke surface — preserved so tests / code that depended
     *  on the MCP shim still works. Spins up MCP on first use. */
    async invoke(toolName: string, input: Record<string, unknown>): Promise<unknown> {
        await this.ensureMcpConnected();
        const res = await this.mcpFallback!.callTool({
            name: 'lore_tool_invoke',
            arguments: { name: toolName, input },
        });
        const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
        const text = content[0]?.text ?? '';
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }
}
