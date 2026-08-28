/**
 * mcp/workspaceProxy.ts — Groundfloor Atlas → Lore proxy for workspace management.
 *
 * Mirrors the pattern from knowledgeProxy.ts (node:http, keep-alive agent,
 * Bearer auth). All four workspace operations proxy to Lore REST endpoints:
 *
 *   POST /api/workspaces          — create a workspace
 *   GET  /api/workspaces          — list workspaces
 *   POST /api/workspaces/:name/projects — add a project folder
 *   GET  /api/workspaces/:name/status   — workspace health + node counts
 *
 * 404 from any endpoint returns a structured error instead of throwing, so
 * callers degrade gracefully when talking to a Lore daemon that predates
 * Sprint 3's workspace API.
 */

import { secureRequest } from '../httpTransport.js';

interface HttpResult { status: number; body: string }

const UNAVAILABLE = {
    error: 'workspace_api_unavailable',
    hint: 'Ensure Lore daemon is running and up to date.',
} as const;

function restBase(mcpUrl: string): string {
    return mcpUrl.replace(/\/mcp\/?$/, '');
}

// Transport centralized in httpTransport.ts (review #2/#3/#6).
async function httpPost(base: string, path: string, token: string, payload: unknown): Promise<HttpResult> {
    const r = await secureRequest('POST', `${base}${path}`, { token, body: JSON.stringify(payload) });
    return { status: r.status, body: r.body };
}

async function httpGet(base: string, path: string, token: string): Promise<HttpResult> {
    const r = await secureRequest('GET', `${base}${path}`, { token });
    return { status: r.status, body: r.body };
}

function parseOk(r: HttpResult, endpoint: string): unknown {
    if (r.status === 404) return UNAVAILABLE;
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`Lore ${endpoint} → HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    }
    if (!r.body) return null;
    try { return JSON.parse(r.body); } catch { return r.body; }
}

/** POST /api/workspaces — create a workspace with type='code_intelligence'. */
export async function createWorkspace(
    mcpUrl: string,
    token: string,
    name: string,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const r = await httpPost(base, '/api/workspaces', token, { name, type: 'code_intelligence' });
    return parseOk(r, 'POST /api/workspaces');
}

/** GET /api/workspaces — list all workspaces accessible with this token. */
export async function listWorkspaces(
    mcpUrl: string,
    token: string,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const r = await httpGet(base, '/api/workspaces', token);
    return parseOk(r, 'GET /api/workspaces');
}

/** POST /api/workspaces/:name/projects — register an absolute project path. */
export async function addWorkspaceProject(
    mcpUrl: string,
    token: string,
    workspaceName: string,
    absolutePath: string,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const encoded = encodeURIComponent(workspaceName);
    const r = await httpPost(base, `/api/workspaces/${encoded}/projects`, token, { path: absolutePath });
    return parseOk(r, `POST /api/workspaces/${workspaceName}/projects`);
}

/** GET /api/workspaces/:name/status — node counts, last indexed, indexer health. */
export async function getWorkspaceStatus(
    mcpUrl: string,
    token: string,
    workspaceName: string,
): Promise<unknown> {
    const base = restBase(mcpUrl);
    const encoded = encodeURIComponent(workspaceName);
    const r = await httpGet(base, `/api/workspaces/${encoded}/status`, token);
    return parseOk(r, `GET /api/workspaces/${workspaceName}/status`);
}
