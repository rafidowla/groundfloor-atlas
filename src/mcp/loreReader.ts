/**
 * mcp/loreReader.ts — READ Atlas-written nodes/edges back from Lore (X7).
 *
 * Sprint X7 swap: previous read path hit Lore via REST but capped at Lore's
 * server-side 1,000-node listNodes cap and re-issued HTTP handshakes on
 * every call. X6.6 dogfood confirmed the cap broke call_graph, blast_radius,
 * find_dead_code, and hotspots on the 5,829-symbol atlas dataset. X7 keeps
 * REST as the transport but:
 *
 *   1. Reuses ONE keep-alive http.Agent for the lifetime of the process —
 *      every call rides an open TCP connection. No per-call handshake.
 *   2. Works around Lore's `/api/nodes` pagination bug (offset is silently
 *      ignored and limit caps at 1,000). The 477 atlas-tagged `file_ref`
 *      nodes always fit under the cap; each carries explicit `neighbors[]`
 *      pointing at every code-symbol declared in that file, so we enumerate
 *      symbols via file→symbol traversal instead of paginated list_nodes.
 *      When Lore's `/api/nodes` honors offset (separate chain), the
 *      `paginate()` helper below can take over without a callsite change.
 *   3. Exponential backoff on 429 (500ms → 1s → 2s → 4s → 8s, cap 30s,
 *      max 5 retries). Lore's slowapi rate-limiter trips when we burst the
 *      per-symbol /api/node calls.
 *   4. Caches `loadContext(workspace)` result process-wide (module-scoped
 *      Map keyed by mcpUrl|token|workspace). T5 perf gate (4 read tools in
 *      <30s) requires the four sequential tool invocations share one load.
 *
 * Bearer auth: token is passed through opts (same as X4) — Atlas writes its
 * bootstrap token to ~/.groundfloor/atlas/auth.token and the server passes
 * it in via opts.token.
 *
 * Out of scope: write path (`loreClient.ts`) still rides MCP per X4. Write
 * swap to REST is Sprint Y2.
 */

import { secureRequest, type TransportResult } from '../httpTransport.js';

import * as crypto from 'node:crypto';
import type { ParsedRelation, ParsedSymbol, RelationKind, SymbolKind } from '../parser/types.js';
import { inferRelationKind } from '../schema.js';
import { qualifyParentSymbolId } from './codeContext.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import { buildSymbolTable } from '../resolver/symbolTable.js';
import { tagsToArray } from '../tags.js';

/**
 * RD-E7 — derive a short, non-reversible fingerprint of the bearer token for
 * use as a cache-key component, so the raw token is never retained in a
 * module-level Map key (memory-dump / heap-snapshot exposure).
 */
function tokenFingerprint(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export interface LoreReaderOpts {
    /** Same MCP URL as loreClient — e.g., http://127.0.0.1:3847/mcp. The REST base is derived by stripping the `/mcp` suffix. */
    mcpUrl: string;
    token: string;
}

interface LoreNodeRecord {
    id: string;
    type: string;
    label: string;
    content?: string;
    // Lore Tags Pass 3 returns string[]; older Lore returned a comma-string.
    tags?: string | string[];
    metadata?: string;
    project?: string;
}

interface LoreNeighbor {
    id: string;
    label: string;
    type: string;
    relation: string;
    confidence?: string;
}

interface NodeWithNeighbors {
    node: LoreNodeRecord;
    neighbors?: LoreNeighbor[];
}

interface ListResponse {
    count: number;
    hasMore: boolean;
    nodes: LoreNodeRecord[];
}

const ATLAS_TAG = 'atlas';
const PAGE_LIMIT = 500;
const SYMBOL_FETCH_CONCURRENCY = 4;
const FILE_FETCH_CONCURRENCY = 4;
const PROGRESS = process.env.X7_PROGRESS === '1';

// Process-wide keep-alive pool. maxSockets matches worker concurrency so
// each parallel worker holds a warm socket without contention. Concurrency
// is intentionally low (4) — Lore's slowapi rate-limiter trips above ~8
// concurrent /api/node calls and the resulting 429 storm + backoff is
// dramatically slower than running gently in the first place.
// Keep-alive pool + transport (http/https, no-token-over-plaintext,
// timeout) are centralized in httpTransport.ts — review #2/#3/#6.

function progress(msg: string): void {
    if (!PROGRESS) return;
    process.stderr.write(`[loreReader] ${msg}\n`);
}

// Module-level loadContext cache. Key: mcpUrl|tokenFingerprint|workspace|epoch
// (the raw bearer is hashed, never stored — RD-E7). Value: the
// in-flight or resolved Promise. T5 perf requires that 4 sequential MCP
// tool calls share one load — server.ts instantiates a fresh LoreReader
// per tool call, so the cache cannot live on the instance.
const contextCache = new Map<string, Promise<{ table: SymbolTable; relations: ParsedRelation[] }>>();

// RC-F2 — per-workspace cache epoch. The cache above has NO natural
// invalidation: in HTTP/standalone mode server.ts holds the process open across
// an atlas_index, so a stale loadContext(workspace) result would be served
// FOREVER after a re-index (every read tool answers from pre-reindex data). The
// index path (runIndexTool → invalidateLoreContext) bumps the workspace epoch,
// which is folded into the cache key so the next loadContext misses and re-loads
// the freshly-written graph — mirroring the embedded reader, which re-reads kuzu
// every call and is never stale. Keyed by BARE workspace (transport/token
// agnostic): a re-index invalidates every reader pointed at that workspace.
const workspaceEpoch = new Map<string, number>();

function epochOf(workspace: string): number {
    return workspaceEpoch.get(workspace) ?? 0;
}

/**
 * RC-F2 — invalidate the cached loadContext for a workspace so the next read
 * re-loads from Lore. Called by the index path (runIndexTool) after a write so
 * HTTP/standalone read tools stop serving pre-reindex data. Bumping the epoch
 * (rather than deleting by key) is transport/token-independent: any reader for
 * this workspace, regardless of mcpUrl or bearer, misses on its next load. Also
 * proactively drops resolved entries for the workspace to free memory.
 */
export function invalidateLoreContext(workspace: string): void {
    workspaceEpoch.set(workspace, epochOf(workspace) + 1);
    // Drop any cached promises for this workspace (all prior epochs) so a
    // resolved (stale) context is not pinned in memory until the process exits.
    // The new epoch would already miss on the key, but freeing here is cheaper
    // than holding the whole SymbolTable + relations for a dead epoch.
    for (const key of [...contextCache.keys()]) {
        if (key.includes(`|${workspace}|`)) contextCache.delete(key);
    }
}

/**
 * Test-only — number of cached loadContext entries, optionally scoped to a
 * workspace (matches the `|<workspace>|` key segment). Used by rc-correctness to
 * assert invalidation actually clears the workspace entry.
 */
export function _loreContextCacheSize(workspace?: string): number {
    if (workspace === undefined) return contextCache.size;
    let n = 0;
    for (const key of contextCache.keys()) {
        if (key.includes(`|${workspace}|`)) n += 1;
    }
    return n;
}

function restBase(mcpUrl: string): string {
    return mcpUrl.replace(/\/mcp\/?$/, '');
}

function hasAtlasTag(tags: string | string[] | undefined | null): boolean {
    // Lore Tags Pass 3 returns tags as string[]; older Lore as a comma-string.
    // tagsToArray accepts both — calling .split on an array threw before this.
    return tagsToArray(tags).includes(ATLAS_TAG);
}

/**
 * F1: Atlas writes code nodes without a `project` field, so Lore stores
 * the column default '*'. A strict `project === workspace` filter would
 * then never match Atlas's own writes (the write/read mismatch that made
 * reads return 0 rows). Accept both the workspace-scoped value and the
 * '*' default so Atlas reliably reads what it wrote.
 */
function projectMatches(nodeProject: string | undefined | null, workspace: string): boolean {
    return nodeProject === workspace || nodeProject === '*';
}

function safeJson<T>(raw: string | undefined | null): T | null {
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
    // 500ms, 1s, 2s, 4s, 8s — capped at 30s.
    return Math.min(500 * Math.pow(2, attempt), 30_000);
}

// GET/POST now go through the centralized secure transport (review
// #2/#3/#6). Return shape (status/body/headers) is preserved.
function httpGet(urlStr: string, token: string): Promise<TransportResult> {
    return secureRequest('GET', urlStr, { token });
}

function httpPost(urlStr: string, token: string, body: string): Promise<TransportResult> {
    return secureRequest('POST', urlStr, { token, body });
}

async function getJson<T>(base: string, pathAndQuery: string, token: string): Promise<T> {
    const url = `${base}${pathAndQuery}`;
    // 429 with Retry-After is the common case (Lore's token-bucket
     // hands back exact wait time), so don't count those toward the
     // 5-retry budget — they're polite waits, not failures. The 5-retry
     // budget guards against an actually-broken server returning 429
     // without a sane Retry-After hint.
    // ATL-064: bound TOTAL 429 attempts (not just the no-header path) and CAP
    // the honored wait. A daemon that returns 429 + Retry-After forever can no
    // longer loop infinitely. Mirrors loreClient.postJson.
    const MAX_ATTEMPTS = 8;
    const MAX_WAIT_MS = 30_000;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
        const r = await httpGet(url, token);
        if (r.status === 429) {
            const retryAfterSec = Number(r.headers['retry-after']);
            const retryAfterMs = Number(r.headers['retry-after-ms']);
            let wait: number;
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
                wait = retryAfterMs;
            } else if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
                // Lore sends whole seconds; jitter +0-250ms so 4 workers
                // don't all retry on the same tick and re-collide.
                wait = retryAfterSec * 1000 + Math.floor(Math.random() * 250);
            } else {
                wait = backoffMs(attempt);
            }
            attempt += 1;
            await sleep(Math.min(wait, MAX_WAIT_MS));
            continue;
        }
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`Lore REST ${pathAndQuery} → HTTP ${r.status}`);
        }
        return JSON.parse(r.body) as T;
    }
    throw new Error(`Lore REST ${pathAndQuery} → HTTP 429 after ${MAX_ATTEMPTS} retries`);
}

/**
 * Paginate `/api/nodes` with offset/limit. Kept for the day Lore honors
 * offset — today it is silently ignored, so we never reach the second
 * iteration. Callers that need full enumeration today use the file_ref
 * walk in `loadContext()` instead.
 */
async function* paginate(
    base: string,
    pathAndBaseQuery: string,
    token: string,
): AsyncGenerator<LoreNodeRecord> {
    let offset = 0;
    let lastFirstId: string | undefined;
    while (true) {
        const sep = pathAndBaseQuery.includes('?') ? '&' : '?';
        const page = await getJson<ListResponse>(
            base,
            `${pathAndBaseQuery}${sep}limit=${PAGE_LIMIT}&offset=${offset}`,
            token,
        );
        const nodes = page.nodes ?? [];
        if (nodes.length === 0) return;
        // Detect Lore's broken offset (same first id across pages) and bail
        // out rather than loop forever. The first page is still useful.
        if (offset > 0 && nodes[0]?.id === lastFirstId) return;
        lastFirstId = nodes[0]?.id;
        for (const n of nodes) yield n;
        if (!page.hasMore || nodes.length < PAGE_LIMIT) return;
        offset += PAGE_LIMIT;
    }
}

/** Run `work` over `items` with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await work(items[i]!, i);
        }
    }
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
    await Promise.all(workers);
    return out;
}

export class LoreReader {
    constructor(private opts: LoreReaderOpts) {}

    private get base(): string {
        return restBase(this.opts.mcpUrl);
    }

    /** Fetch one node detail with neighbours — public for testing/diagnostics. */
    async getNode(workspace: string, id: string): Promise<NodeWithNeighbors | null> {
        const q = `/api/node?id=${encodeURIComponent(id)}&workspace=${encodeURIComponent(workspace)}`;
        try {
            const body = await getJson<NodeWithNeighbors>(this.base, q, this.opts.token);
            if (body.neighbors) {
                // Drop inferred semantic neighbours — only explicit (extracted)
                // edges are real graph edges.
                body.neighbors = body.neighbors.filter((n) => n.confidence !== 'inferred');
            }
            return body;
        } catch {
            return null;
        }
    }

    /**
     * Enumerate atlas-tagged file_ref nodes for a workspace. File_ref count
     * (~477 on the 5,829-symbol dataset) fits under Lore's 1,000-cap, so the
     * single bounded request returns everything.
     */
    async listFileRefs(workspace: string): Promise<LoreNodeRecord[]> {
        const q = `/api/nodes?workspace=${encodeURIComponent(workspace)}&type=code_file&limit=${PAGE_LIMIT * 2}`;
        const page = await getJson<ListResponse>(this.base, q, this.opts.token);
        return (page.nodes ?? [])
            .filter((n) => hasAtlasTag(n.tags))
            .filter((n) => projectMatches(n.project, workspace));
    }

    /**
     * Sprint Y W4 — POST /api/nodes/bulk-list cursor-paginated
     * enumeration. The W4 spec adds this endpoint with rate-limit
     * exemption and 1,000-row pages; on a 5,829-symbol workspace
     * this resolves in ~6 calls instead of the ~6,000 the
     * file_ref-walk path used.
     *
     * Returns null on 404 (pre-Sprint-W daemon) or any non-success
     * status so the caller can fall through to the legacy pagination
     * / file_ref-walk path. Empty array on a workspace with no
     * matching nodes (distinct from null — endpoint worked, no rows).
     */
    private async tryBulkList(workspace: string): Promise<LoreNodeRecord[] | null> {
        const collected: LoreNodeRecord[] = [];
        let cursor: string | null = null;
        for (let safety = 0; safety < 200; safety += 1) {
            const payload: Record<string, unknown> = {
                workspace,
                type: 'code_symbol',
                limit: 1000,
            };
            if (cursor) payload['cursor'] = cursor;
            const r = await httpPost(
                `${this.base}/api/nodes/bulk-list`,
                this.opts.token,
                JSON.stringify(payload),
            );
            if (r.status === 404) return null;
            if (r.status < 200 || r.status >= 300) return null;
            const page = JSON.parse(r.body) as { nodes?: LoreNodeRecord[]; nextCursor?: string | null; hasMore?: boolean };
            const nodes = page.nodes ?? [];
            for (const n of nodes) collected.push(n);
            if (!page.hasMore || !page.nextCursor) {
                return collected
                    .filter((n) => hasAtlasTag(n.tags))
                    .filter((n) => projectMatches(n.project, workspace));
            }
            cursor = page.nextCursor;
        }
        // Safety break — shouldn't fire (200 × 1,000 = 200k rows).
        return collected
            .filter((n) => hasAtlasTag(n.tags))
            .filter((n) => projectMatches(n.project, workspace));
    }

    /**
     * Try paginated enumeration of architecture nodes. Returns null if the
     * server returned a clearly capped/non-paginating response so the caller
     * can fall back to file_ref-walk enumeration. We treat "first page is
     * full and hasMore=true but offset returns the same nodes" as the broken
     * pagination signal.
     */
    private async tryPaginatedSymbols(workspace: string): Promise<LoreNodeRecord[] | null> {
        const base = `/api/nodes?workspace=${encodeURIComponent(workspace)}&type=code_symbol`;
        const collected: LoreNodeRecord[] = [];
        let pageCount = 0;
        for await (const n of paginate(this.base, base, this.opts.token)) {
            collected.push(n);
            pageCount += 1;
        }
        // If we got exactly PAGE_LIMIT nodes back and the paginator gave up
        // (broken offset), we can't trust this as exhaustive — fall back.
        if (collected.length === PAGE_LIMIT) {
            return null;
        }
        return collected.filter((n) => hasAtlasTag(n.tags)).filter((n) => projectMatches(n.project, workspace));
    }

    /**
     * Rebuild a SymbolTable + ParsedRelation[] from atlas-tagged Lore data.
     *
     * Strategy:
     *   1. Try paginated `/api/nodes?type=code_symbol`. If Lore returns
     *      exhaustively, use that.
     *   2. Otherwise fall back to file_ref enumeration:
     *      a. List all file_ref nodes (always under cap).
     *      b. For each file_ref, fetch its detail to recover the list of
     *         child symbol IDs via `neighbors[]`.
     *      c. Deduplicate symbol IDs across files (a symbol can be neighbor
     *         of multiple files via re-export/imports).
     *      d. Fetch each symbol detail in parallel (bounded by
     *         SYMBOL_FETCH_CONCURRENCY) to recover metadata + outbound edges.
     *
     * Result is cached at module scope so the next loadContext for the same
     * (mcpUrl, token, workspace) tuple returns instantly. T5 requires 4
     * sequential tool calls to complete in <30s; without sharing the load
     * the perf gate is unachievable on a 5,829-symbol dataset.
     */
    async loadContext(workspace: string): Promise<{ table: SymbolTable; relations: ParsedRelation[] }> {
        // RD-E7 — hash the token into the key; never store the raw bearer.
        // RC-F2 — fold the per-workspace epoch in so a re-index (which bumps the
        // epoch via invalidateLoreContext) forces the next load to miss + refetch
        // the fresh graph. The `|${workspace}|` segment is kept intact so the
        // invalidation/size helpers can match by workspace substring.
        const cacheKey = `${this.opts.mcpUrl}|${tokenFingerprint(this.opts.token)}|${workspace}|${epochOf(workspace)}`;
        const cached = contextCache.get(cacheKey);
        if (cached) return cached;

        const pending = this.loadContextUncached(workspace);
        contextCache.set(cacheKey, pending);
        try {
            return await pending;
        } catch (err) {
            // On failure, drop the cache entry so retries don't pin the error.
            contextCache.delete(cacheKey);
            throw err;
        }
    }

    private async loadContextUncached(workspace: string): Promise<{ table: SymbolTable; relations: ParsedRelation[] }> {
        // Step 0 (Sprint Y W4): try POST /api/nodes/bulk-list with
        // cursor pagination + rate-limit exemption. On a Sprint-W-
        // deployed daemon this completes the whole workspace
        // enumeration in ~N/1000 calls (vs ~N file_ref + per-symbol
        // fetches on the legacy path). Returns null on pre-W daemons
        // (404), falling through to the legacy paths below.
        let symbolNodes: LoreNodeRecord[] | null = await this.tryBulkList(workspace);

        // Step 1: try the paginated path; it's a no-op fast-fail today but
        // becomes the happy path once Lore honors offset.
        if (!symbolNodes) symbolNodes = await this.tryPaginatedSymbols(workspace);

        let symbolNeighborMap: Map<string, LoreNeighbor[]> | null = null;

        if (!symbolNodes) {
            // Step 2 (workaround): walk file_ref nodes → discover symbol IDs.
            const fileRefs = await this.listFileRefs(workspace);
            progress(`fileRefs=${fileRefs.length}`);
            let fileDone = 0;
            const fileDetails = await mapLimit(fileRefs, FILE_FETCH_CONCURRENCY, async (f) => {
                const r = await this.getNode(workspace, f.id);
                fileDone += 1;
                if (PROGRESS && fileDone % 100 === 0) progress(`file ${fileDone}/${fileRefs.length}`);
                return r;
            });
            progress(`fileDetails done (${fileDetails.length})`);

            const symbolIdSet = new Set<string>();
            for (const detail of fileDetails) {
                if (!detail) continue;
                for (const nb of detail.neighbors ?? []) {
                    if (nb.id.startsWith('code-symbol:')) symbolIdSet.add(nb.id);
                }
            }
            const symbolIds = Array.from(symbolIdSet);
            progress(`unique symbol ids=${symbolIds.length}`);

            // Step 3: fetch every symbol detail to recover metadata + edges.
            let symDone = 0;
            const symbolDetails = await mapLimit(symbolIds, SYMBOL_FETCH_CONCURRENCY, async (sid) => {
                const r = await this.getNode(workspace, sid);
                symDone += 1;
                if (PROGRESS && symDone % 500 === 0) progress(`symbol ${symDone}/${symbolIds.length}`);
                return r;
            });
            progress(`symbolDetails done (${symbolDetails.length})`);

            symbolNodes = [];
            symbolNeighborMap = new Map();
            for (const detail of symbolDetails) {
                if (!detail || !detail.node) continue;
                const n = detail.node;
                if (!hasAtlasTag(n.tags)) continue;
                if (!projectMatches(n.project, workspace)) continue;
                symbolNodes.push(n);
                symbolNeighborMap.set(n.id, detail.neighbors ?? []);
            }
            progress(`assembled ${symbolNodes.length} symbol nodes`);
        }

        // Always need file_ref records for file id set (cheap; same call as
        // step 2 inputs).
        const fileNodes = await this.listFileRefs(workspace);
        const fileIds = new Set(fileNodes.map((f) => f.id));

        // Reconstruct ParsedSymbol[] from architecture metadata.
        const symbols: ParsedSymbol[] = [];
        for (const node of symbolNodes!) {
            const meta = safeJson<Record<string, unknown>>(node.metadata) ?? {};
            // Graph identity is the (prefix-stripped) NODE id, not metadata.uid:
            // edges reference node ids, and F1 qualified node ids with the repo
            // (`code-symbol:<repo>/<uid>`) while leaving metadata.uid the raw
            // `<uid>`. Keying on the node id keeps symbols and edges on the same
            // identifier (line ~502 strips the same way) so call_graph resolves.
            const uid = node.id.replace(/^code-symbol:/, '');
            const sym: ParsedSymbol = {
                id: uid,
                name: (meta['name'] as string) ?? '',
                qualifiedName: (meta['qualifiedName'] as string) ?? (meta['name'] as string) ?? '',
                kind: ((meta['kind'] as SymbolKind) ?? 'function'),
                file: (meta['filePath'] as string) ?? '',
                byteRange: {
                    start: 0,
                    end: 0,
                    startLine: (meta['startLine'] as number) ?? 1,
                    endLine: (meta['endLine'] as number) ?? 1,
                },
                signature: (meta['signature'] as string) ?? node.content ?? '',
                complexity: (meta['complexity'] as number) ?? 1,
                parentSymbolId: qualifyParentSymbolId(uid, (meta['parentSymbolId'] as string | null) ?? null),
                parsedAt: '',
            };
            symbols.push(sym);
        }

        // Group symbols by file → ParsedFile-like shells for buildSymbolTable.
        const filesByPath = new Map<string, ParsedSymbol[]>();
        for (const sym of symbols) {
            const list = filesByPath.get(sym.file);
            if (list) list.push(sym);
            else filesByPath.set(sym.file, [sym]);
        }
        const fileShells = Array.from(filesByPath.entries()).map(([p, syms]) => ({
            path: p,
            language: 'typescript' as const,
            symbols: syms,
            imports: [],
            calls: [],
            sizeBytes: 0,
            loc: 0,
            parsedAt: '',
        }));
        const table = buildSymbolTable(fileShells);

        // Recover edges. If we have a pre-fetched neighbor map (file_ref
        // walk), use it; otherwise sequentially fetch per symbol (paginated
        // happy path).
        if (!symbolNeighborMap) {
            symbolNeighborMap = new Map();
            const fetched = await mapLimit(symbolNodes!, SYMBOL_FETCH_CONCURRENCY, async (sNode) => {
                const detail = await this.getNode(workspace, sNode.id);
                return { id: sNode.id, neighbours: detail?.neighbors ?? [] };
            });
            for (const f of fetched) symbolNeighborMap.set(f.id, f.neighbours);
        }

        const relations: ParsedRelation[] = [];
        const seen = new Set<string>();
        const pushRelation = (sourceUid: string, targetUid: string, kind: RelationKind, rawRelation: string): void => {
            const key = `${sourceUid}→${targetUid}→${kind}`;
            if (seen.has(key)) return;
            seen.add(key);
            relations.push({
                sourceId: sourceUid,
                targetId: targetUid,
                kind,
                confidence: 1.0,
                reason: `recovered from Lore edge relation="${rawRelation}"`,
            });
        };
        for (const sNode of symbolNodes!) {
            const neighbours = symbolNeighborMap.get(sNode.id) ?? [];
            for (const n of neighbours) {
                // /api/node returns BOTH inbound and outbound explicit edges;
                // inbound entries are prefixed with "← ". Skip those to avoid
                // double-counting (recorded as outbound from the source end).
                if (n.relation.startsWith('←')) {
                    // RC-F1 (HTTP parity) — EXCEPT an inbound `imports` edge FROM a
                    // file: `import { X } from './x'` is stored code-file:importer →
                    // code-symbol:X, so on X it surfaces ONLY as inbound `←imports`
                    // from a code-file: node. The outbound end is a FILE, never a
                    // symbol, so it is NOT recorded anywhere else — dropping it makes
                    // an only-imported symbol a FALSE dead-code positive (matches the
                    // embedded assembleCodeContext rescue). Reconstruct it in its true
                    // direction (file → this symbol) so deadCode counts the inbound.
                    const rawKind = inferRelationKind(n.relation.replace(/^←\s*/, ''));
                    if (rawKind === 'imports' && n.id.startsWith('code-file:')) {
                        const targetUid = sNode.id.replace(/^code-symbol:/, '');
                        // Strip the shared repo prefix so the file source path is
                        // repo-relative (aligned with a symbol's `.file`), matching
                        // the embedded assembleCodeContext rescue so layer globs fire.
                        const targetRepo = targetUid.includes('/') ? targetUid.slice(0, targetUid.indexOf('/')) : '';
                        let fileSource = n.id.replace(/^code-file:/, '');
                        if (targetRepo && fileSource.startsWith(targetRepo + '/')) {
                            fileSource = fileSource.slice(targetRepo.length + 1);
                        }
                        pushRelation('file:' + fileSource, targetUid, 'imports', n.relation);
                    }
                    continue;
                }
                if (n.id.startsWith('code-file:') || fileIds.has(n.id)) continue;
                // Sprint 1 (typed edges): only keep symbol→symbol CODE edges
                // in the recovered call/blast graph. Skip the code_context
                // bridge ('describes') and any context-card endpoint — those
                // are semantic links, not structural call/import edges.
                if (n.id.startsWith('code-context')) continue;
                if (n.relation === 'describes') continue;
                const sourceUid = sNode.id.replace(/^code-symbol:/, '');
                const targetUid = n.id.replace(/^code-symbol:/, '');
                // Dedup on the (source, target, KIND) triple — NOT just the pair.
                // A symbol pair can carry co-existing typed edges (e.g. `contains`
                // AND `calls`); keying on the pair alone drops the second kind, so
                // a real call/import edge vanished from analytics that filter to
                // {calls,imports}. Mirrors the embedded reader (codeContext.ts).
                const kind: RelationKind = inferRelationKind(n.relation);
                pushRelation(sourceUid, targetUid, kind, n.relation);
            }
        }

        return { table, relations };
    }
}

/** Clear the module-level loadContext cache. Test-only escape hatch. */
export function _resetLoreReaderCache(): void {
    contextCache.clear();
    // RC-F2 — also reset per-workspace epochs so a test starting fresh sees the
    // baseline (epoch 0) cache keys, not keys carrying a bumped epoch from a
    // prior test's invalidateLoreContext call.
    workspaceEpoch.clear();
}

// Relation-kind inference is now the canonical `inferRelationKind` in
// schema.ts (Sprint 1) — imported above so loreReader + codeContext can't
// drift. It returns a real RelationKind verbatim for typed graphs and falls
// back to `calls` for legacy `related_to` symbol→symbol edges.
