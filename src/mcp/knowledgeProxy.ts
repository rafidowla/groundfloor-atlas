/**
 * mcp/knowledgeProxy.ts — Groundfloor Atlas → Lore proxy for semantic knowledge.
 *
 * Groundfloor Atlas is the single write path for all node types. When an IDE or AI
 * agent wants to store a decision, bug_pattern, convention, troubleshooting,
 * or architecture node it goes through these functions, which proxy to Lore
 * with embed:true so the node lands in both Kuzu (graph) and LanceDB (vector).
 *
 * Code-structural nodes (code_file, code_symbol) use embed:false and go
 * through loreClient.ts + batchWriter.ts — not through here.
 *
 * Lore REST endpoints used:
 *   POST /api/node                — store a single knowledge node
 *   POST /api/edge                — store an edge between nodes
 *   GET  /api/recall              — semantic recall by topic
 *   GET  /api/search              — full-text search
 *   POST /api/node/supersede      — soft-supersede an old node with a new one
 */

import { URL } from 'node:url';
import { secureRequest } from '../httpTransport.js';

export interface KnowledgeNodeInput {
    id?: string;
    type: 'decision' | 'convention' | 'bug_pattern' | 'troubleshooting' | 'architecture';
    label: string;
    content: string;
    tags?: string;
    workspace: string;
    metadata?: string;
}

export interface KnowledgeEdgeInput {
    sourceId: string;
    targetId: string;
    relation: string;
    workspace: string;
}

export interface SupersedeInput {
    oldId: string;
    newId: string;
    reason?: string;
    workspace: string;
}

export interface RecallOpts {
    topic: string;
    workspace: string;
    max?: number;
    mode?: 'summary' | 'full';
    crossProject?: boolean;
    includeSuperseded?: boolean;
}

export interface SearchOpts {
    q: string;
    workspace: string;
    limit?: number;
    type?: string;
    /** Retrieval mode forwarded to Lore's /api/search. Defaults to Lore's own
     *  default ('hybrid') when omitted. Added after Lore 84d65e1 wired the
     *  mode through searchTool so semantic/hybrid actually hit LanceDB. */
    search_mode?: 'keyword' | 'semantic' | 'hybrid';
}

interface HttpResult { status: number; body: string }

function restBase(mcpUrl: string): string {
    return mcpUrl.replace(/\/mcp\/?$/, '');
}

// Transport centralized in httpTransport.ts (review #2/#3/#6): http/https
// by protocol, no token over plaintext to non-loopback, request timeout.
async function httpPost(base: string, path: string, token: string, payload: unknown): Promise<HttpResult> {
    const r = await secureRequest('POST', `${base}${path}`, { token, body: JSON.stringify(payload) });
    return { status: r.status, body: r.body };
}

async function httpGet(base: string, path: string, token: string): Promise<HttpResult> {
    const r = await secureRequest('GET', `${base}${path}`, { token });
    return { status: r.status, body: r.body };
}

function parseBody(r: HttpResult, endpoint: string): unknown {
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`Lore ${endpoint} → HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    }
    if (!r.body) return null;
    try { return JSON.parse(r.body); } catch { return r.body; }
}

/** Store a semantic knowledge node in Lore. embed:true is always set — these
 *  nodes are recalled by semantic similarity, never by exact UID lookup. */
export async function storeKnowledgeNode(
    mcpUrl: string,
    token: string,
    input: KnowledgeNodeInput,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const payload = { ...input, embed: true };
    const r = await httpPost(base, '/api/node', token, payload);
    return parseBody(r, 'POST /api/node');
}

/** Store an edge between two knowledge nodes. */
export async function storeKnowledgeEdge(
    mcpUrl: string,
    token: string,
    input: KnowledgeEdgeInput,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const r = await httpPost(base, '/api/edge', token, input);
    return parseBody(r, 'POST /api/edge');
}

/** Semantic recall — proxies GET /api/recall. Returns Lore's ranked result
 *  list. Groundfloor Atlas optionally enriches with related code_symbol nodes (future). */
export async function recallKnowledge(
    mcpUrl: string,
    token: string,
    opts: RecallOpts,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const params = new URLSearchParams({
        topic: opts.topic,
        workspace: opts.workspace,
    });
    if (opts.max) params.set('max', String(opts.max));
    if (opts.mode) params.set('mode', opts.mode);
    if (opts.crossProject) params.set('crossProject', 'true');
    if (opts.includeSuperseded) params.set('include_superseded', 'true');
    const r = await httpGet(base, `/api/recall?${params.toString()}`, token);
    return parseBody(r, 'GET /api/recall');
}

/** Full-text search — proxies GET /api/search. */
export async function searchKnowledge(
    mcpUrl: string,
    token: string,
    opts: SearchOpts,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const params = new URLSearchParams({ q: opts.q, workspace: opts.workspace });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.type) params.set('type', opts.type);
    if (opts.search_mode) params.set('search_mode', opts.search_mode);
    const r = await httpGet(base, `/api/search?${params.toString()}`, token);
    return parseBody(r, 'GET /api/search');
}

/** Soft-supersede an old node with a new one. The old node stays in Kuzu
 *  with supersededAt set — hidden from default recall but visible in history. */
export async function supersedeNode(
    mcpUrl: string,
    token: string,
    input: SupersedeInput,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const r = await httpPost(base, '/api/node/supersede', token, input);
    return parseBody(r, 'POST /api/node/supersede');
}
