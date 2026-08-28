/**
 * mcp/tools/knowledgeList.ts — `knowledge_list`: complete, deterministic
 * enumeration of a workspace's knowledge nodes.
 *
 * WHY THIS EXISTS. Neither existing read tool can answer "show me every
 * standing rule for this project":
 *   - `knowledge_search` REQUIRES a non-empty `q` and its keyword mode is a
 *     literal CONTAINS with no wildcard, so there is no "match everything".
 *   - `knowledge_recall` is semantic and ranked: it returns what is RELEVANT,
 *     never what is COMPLETE.
 * The only complete route left was exporting the whole workspace to JSONL and
 * filtering the file — which an embedding host was actually doing, in
 * production, to render a rules browser. A partial list of the rules that
 * govern your project is worse than no list, because the reader assumes they
 * have seen them all; so this tool's contract is completeness first.
 *
 * DESIGN NOTES, each one load-bearing:
 *
 *   - ORDERED BY ID, not by relevance or recency. Lore's listNodes orders by
 *     `updatedAt DESC`, which is unstable under concurrent writes: a node
 *     edited between two page fetches jumps position and the caller silently
 *     skips or repeats a row. Sorting by id gives paging that is stable across
 *     writes, which is what an offset/limit browser actually needs.
 *
 *   - `total` IS COMPUTED AFTER FILTERING, BEFORE PAGING, so a UI can say
 *     "12 rules" honestly while showing the first 10.
 *
 *   - THE RETRACTION TOMBSTONE IS EXCLUDED. knowledge_retract supersedes
 *     nodes to a per-workspace tombstone node, which is stored with
 *     type 'architecture'. Without this filter, every workspace that has ever
 *     retracted anything would show an internal bookkeeping node in its list of
 *     architecture decisions.
 *
 *   - SUPERSEDED NODES ARE HIDDEN BY DEFAULT, matching recall/search. With
 *     `includeSuperseded: true` they come back carrying `supersededBy`, which
 *     is how a caller distinguishes RETRACTED (superseded by the tombstone —
 *     "this was wrong") from REPLACED (superseded by a real successor node).
 *
 *   - TRUNCATION IS REPORTED, NEVER SILENT. The raw pull is capped; if the cap
 *     is reached, `truncated: true` is returned and `total` is explicitly a
 *     lower bound. Silence here would recreate the exact failure this tool
 *     exists to prevent.
 */

import { KNOWLEDGE_TYPES } from '../../schema.js';
import { KNOWLEDGE_TYPE_SET } from '../../memoryFile.js';

/** Minimum read surface this tool needs — duck-typed so it is trivially
 *  testable with a hand-rolled fake (same pattern as processes/subgraph). */
export interface KnowledgeListReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
}

export interface KnowledgeListArgs {
    type?: string;
    tag?: string;
    limit?: number;
    offset?: number;
    includeSuperseded?: boolean;
}

export interface KnowledgeListNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    createdAt?: string;
    updatedAt?: string;
    metadata?: unknown;
    /** Present only when the node is superseded (so only under
     *  includeSuperseded). `supersededBy` === the workspace tombstone id means
     *  the node was RETRACTED rather than replaced. */
    supersededAt?: string;
    supersededBy?: string;
    supersededReason?: string;
}

export interface KnowledgeListResult {
    ok: true;
    workspace: string;
    type: string | null;
    tag: string | null;
    /** Matching nodes after filtering, before paging. A lower bound when `truncated`. */
    total: number;
    /** Nodes actually returned in this page. */
    count: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    /** True when the raw pull hit its cap — `total` is then a LOWER BOUND. */
    truncated?: true;
    nodes: KnowledgeListNode[];
}

export interface KnowledgeListError {
    error: string;
    detail: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** Per-type ceiling on the raw pull. Matches Lore's own listNodes default cap.
 *  Knowledge nodes are curated and number in the hundreds even on old
 *  workspaces (code nodes, which are the six-figure population, are not
 *  listable here at all), so this is far above real usage — it exists so a
 *  pathological workspace degrades to an HONEST partial answer instead of
 *  materializing without bound. */
export const RAW_PULL_CAP = 10_000;

/** Id of the sink node knowledge_retract supersedes withdrawn nodes to.
 *  MUST match mcp/allTools.ts's knowledge_retract handler. */
export function tombstoneIdFor(workspace: string): string {
    return `knowledge:tombstone:${workspace}`;
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Lore returns tags as STRING[]; older/HTTP rows can carry a comma string.
 *  Normalize to an array so callers never branch on the shape. */
function toTagArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string');
    if (typeof v === 'string' && v.trim().length > 0) {
        return v.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    }
    return [];
}

export async function runKnowledgeList(
    reader: KnowledgeListReader,
    args: KnowledgeListArgs,
    workspace: string,
): Promise<KnowledgeListResult | KnowledgeListError> {
    const requestedType = args.type;
    if (requestedType !== undefined && !KNOWLEDGE_TYPE_SET.has(requestedType)) {
        return {
            error: 'invalid_arguments',
            detail: `unknown type '${requestedType}' — must be one of ${KNOWLEDGE_TYPES.join(', ')}`,
        };
    }
    const types: readonly string[] = requestedType ? [requestedType] : KNOWLEDGE_TYPES;

    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));
    const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
    const offset = Math.max(0, rawOffset);
    const includeSuperseded = args.includeSuperseded === true;
    const tombstoneId = tombstoneIdFor(workspace);

    const collected: KnowledgeListNode[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const type of types) {
        // `workspace` goes in the PROJECT slot: writes stamp project=<Atlas
        // workspace> (EmbeddedLore.storeNode), which is what scopes a read.
        // The tag filter is Lore-native (exact, case-insensitive membership).
        const rows = await reader.listNodes(type, args.tag, workspace, RAW_PULL_CAP);
        if (rows.length >= RAW_PULL_CAP) truncated = true;
        for (const raw of rows) {
            const n = raw as Record<string, unknown>;
            const id = str(n['id']);
            if (!id) continue;
            // Internal bookkeeping, not knowledge — never list it.
            if (id === tombstoneId) continue;
            // A node cannot legitimately appear twice, but ids are the paging
            // key, so a duplicate would corrupt offsets rather than just
            // repeat a row.
            if (seen.has(id)) continue;

            const supersededAt = str(n['supersededAt']);
            if (supersededAt && !includeSuperseded) continue;

            seen.add(id);
            const node: KnowledgeListNode = {
                id,
                type: str(n['type']) ?? type,
                label: str(n['label']) ?? '',
                content: str(n['content']) ?? '',
                tags: toTagArray(n['tags']),
            };
            const createdAt = str(n['createdAt']);
            if (createdAt) node.createdAt = createdAt;
            const updatedAt = str(n['updatedAt']);
            if (updatedAt) node.updatedAt = updatedAt;
            // Lore defaults metadata to the string '{}' — drop that noise.
            const metadata = n['metadata'];
            if (metadata !== undefined && metadata !== null && metadata !== '{}') node.metadata = metadata;
            if (supersededAt) {
                node.supersededAt = supersededAt;
                const by = str(n['supersededBy']);
                if (by) node.supersededBy = by;
                const reason = str(n['supersededReason']);
                if (reason) node.supersededReason = reason;
            }
            collected.push(node);
        }
    }

    // Stable order (see header) — id is the paging key, so it must be the sort key.
    collected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const total = collected.length;
    const page = collected.slice(offset, offset + limit);

    return {
        ok: true,
        workspace,
        type: requestedType ?? null,
        tag: args.tag ?? null,
        total,
        count: page.length,
        offset,
        limit,
        hasMore: offset + page.length < total,
        ...(truncated ? { truncated: true as const } : {}),
        nodes: page,
    };
}
