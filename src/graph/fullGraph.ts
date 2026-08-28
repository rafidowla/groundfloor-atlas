/**
 * graph/fullGraph.ts — the `atlas_fullgraph` data layer.
 *
 * Unlike buildSubgraph (a bounded N-hop slice around a center/community), this
 * returns the WHOLE workspace graph in one shot, for the UI's "see the entire
 * graph" view. There is no BFS: every node of the requested types is ingested
 * (priority-ordered so a cap keeps the structural skeleton), and the induced
 * edge set over the included nodes is emitted.
 *
 * SAME duck-typed reader surface + node/edge shapes as graph/subgraph.ts, so the
 * frontend consumes both with one mapper. The hard cap (maxNodes, server-clamped
 * to <= FULLGRAPH_CEILING) keeps a pathological monorepo from materializing
 * hundreds of thousands of nodes into the renderer.
 *
 * PRIORITY ORDER when the cap bites: folder → file → knowledge → import →
 * context → symbol. Rationale: the folder/file skeleton + curated knowledge is
 * the "shape" of the codebase the user most wants to see whole; per-symbol nodes
 * are the long tail and are the first to be dropped.
 */

import type { SubgraphNode, SubgraphEdge, SubgraphReader } from './subgraph.js';
import { classifyNode } from './subgraph.js';
import { KNOWLEDGE_TYPES } from '../schema.js';

/** Hard ceiling on returned nodes — a whole-graph view still must not hand the
 *  renderer an unbounded payload. Higher than subgraph's 1000 (this view's whole
 *  point is breadth), but bounded so layout stays interactive. */
export const FULLGRAPH_CEILING = 8000;
const DEFAULT_MAX_NODES = 3000;

export interface FullGraph {
    nodes: SubgraphNode[];
    edges: SubgraphEdge[];
    /** True iff the node cap fired before all nodes were ingested. */
    truncated: boolean;
    /** Total nodes that existed before the cap (so the UI can say "showing N of M"). */
    totalNodes: number;
}

export interface FullGraphOpts {
    /** Node types to include. Default: the full structural + knowledge set. */
    nodeTypes?: string[];
    /** Node cap. Default 3000, hard-clamped to <= FULLGRAPH_CEILING. */
    maxNodes?: number;
}

interface NodeRow {
    id: string;
    type?: string;
    label?: string;
    metadata?: string | Record<string, unknown> | null;
}

interface NodeMeta {
    filePath?: string;
    repo?: string;
    startLine?: number;
    endLine?: number;
    signature?: string;
    qualifiedName?: string;
}

const CODE_FILE_PREFIX = 'code-file:';

/** Lore node types ingested, in cap-survival priority order (first = kept). */
const DEFAULT_TYPE_PRIORITY = [
    'code_folder',
    'code_file',
    ...KNOWLEDGE_TYPES,
    'code_import',
    'code_context',
    'code_symbol',
];

export async function buildFullGraph(
    reader: SubgraphReader,
    workspace: string,
    opts: FullGraphOpts = {},
): Promise<FullGraph> {
    const requestedMax = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const maxNodes = Math.max(1, Math.min(requestedMax, FULLGRAPH_CEILING));

    // Honor a caller type filter, but ingest in the priority order so a cap drops
    // the long tail (symbols) first, not the skeleton (folders/files).
    const wanted = opts.nodeTypes && opts.nodeTypes.length > 0
        ? new Set(opts.nodeTypes)
        : null;
    const ingestOrder = wanted
        ? DEFAULT_TYPE_PRIORITY.filter((t) => wanted.has(t))
        : DEFAULT_TYPE_PRIORITY;

    // Community membership (best-effort): fileId → content-stable community id.
    // Used to color the whole-graph view by community (the graphify-style cluster
    // look). Expensive (recomputes Louvain), but this is a deliberate full load.
    // A symbol inherits its file's community via metadata.filePath + repo.
    const fileToCommunity = new Map<string, string>();
    try {
        const { listCommunityMembership } = await import('../communities/index.js');
        const membership = await listCommunityMembership(reader as never, workspace);
        for (const [communityId, fileIds] of membership) {
            for (const fid of fileIds) fileToCommunity.set(fid, communityId);
        }
    } catch {
        /* community layer unavailable — coloring falls back to type/project */
    }

    const included = new Map<string, SubgraphNode>();
    let totalNodes = 0;
    let truncated = false;

    for (const type of ingestOrder) {
        // RD-fullgraph-oom — bound the pull to the remaining node budget instead
        // of `undefined` (which took listNodes' UNBOUNDED path and materialized
        // every node's full content into JS before the cap was ever checked —
        // an OOM crash of the SHARED daemon on a large workspace, since this runs
        // via atlas_fullgraph). We never keep more than `maxNodes` (<= 8000)
        // total, and types are processed in priority order, so once the budget is
        // full further pulls only set `truncated`. Pull `budget + 1` so a type
        // that alone overflows the remaining budget is detected as truncated.
        if (included.size >= maxNodes) { truncated = true; break; }
        const budget = maxNodes - included.size;
        const rows = (await reader.listNodes(type, undefined, workspace, budget + 1)) as NodeRow[];
        if (rows.length > budget) truncated = true;
        for (const r of rows) {
            if (!r || typeof r.id !== 'string') continue;
            totalNodes += 1;
            if (included.has(r.id)) continue;
            if (included.size >= maxNodes) { truncated = true; continue; }
            const nodeType = typeof r.type === 'string' ? r.type : type;
            const meta = parseMaybeJson<NodeMeta>(r.metadata) ?? {};
            const label = (typeof r.label === 'string' && r.label) || r.id;
            const file = meta.filePath || (typeof r.label === 'string' ? r.label : undefined);
            // project: authoritative metadata.repo, else parse from the
            // repo-qualified id (code-file:<repo>/<path>) as a fallback.
            const project = meta.repo || projectFromId(r.id);
            // community: a file uses its own id; a symbol/context maps through its
            // file id (built from repo + filePath); everything else has none.
            let community: string | undefined;
            if (fileToCommunity.size > 0) {
                if (r.id.startsWith(CODE_FILE_PREFIX)) {
                    community = fileToCommunity.get(r.id);
                } else if (meta.filePath && meta.repo) {
                    community = fileToCommunity.get(`${CODE_FILE_PREFIX}${meta.repo}/${meta.filePath}`);
                }
            }
            included.set(r.id, {
                id: r.id,
                type: nodeType,
                label,
                ...(file ? { file } : {}),
                ...symbolFields(meta),
                ...(project ? { project } : {}),
                ...(community ? { community } : {}),
                cls: classifyNode(r.id, nodeType),
            });
        }
    }

    // Induced edge set: every edge whose BOTH endpoints survived the cap.
    const allEdges = await reader.listEdges();
    const seenEdge = new Set<string>();
    const edges: SubgraphEdge[] = [];
    for (const e of allEdges) {
        if (e.sourceId === e.targetId) continue;
        if (!included.has(e.sourceId) || !included.has(e.targetId)) continue;
        const a = e.sourceId < e.targetId ? e.sourceId : e.targetId;
        const b = e.sourceId < e.targetId ? e.targetId : e.sourceId;
        // NUL separator (same as subgraph.ts): node ids embed repo-relative
        // paths, which can contain SPACES — a space-separated key can collide
        // two distinct edges into one and silently drop one.
        const key = `${a}\0${b}\0${e.relation}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({
            source: e.sourceId,
            target: e.targetId,
            relation: e.relation,
            ...(e.confidence ? { confidence: e.confidence } : {}),
            ...(e.confidenceScore !== undefined ? { confidenceScore: e.confidenceScore } : {}),
        });
    }

    const nodes = [...included.values()].sort((x, y) => x.id.localeCompare(y.id));
    edges.sort((x, y) =>
        x.source.localeCompare(y.source)
        || x.target.localeCompare(y.target)
        || x.relation.localeCompare(y.relation),
    );

    return { nodes, edges, truncated, totalNodes };
}

function symbolFields(src: {
    startLine?: number;
    endLine?: number;
    signature?: string;
    qualifiedName?: string;
}): Partial<Pick<SubgraphNode, 'startLine' | 'endLine' | 'signature' | 'qualifiedName'>> {
    return {
        ...(typeof src.startLine === 'number' ? { startLine: src.startLine } : {}),
        ...(typeof src.endLine === 'number' ? { endLine: src.endLine } : {}),
        ...(typeof src.signature === 'string' && src.signature ? { signature: src.signature } : {}),
        ...(typeof src.qualifiedName === 'string' && src.qualifiedName ? { qualifiedName: src.qualifiedName } : {}),
    };
}

/** Fallback project extraction from a repo-qualified id when metadata.repo is
 *  absent. Ids are `code-file:<repo>/<path>` / `code-symbol:<repo>/<...>` /
 *  `code-folder:<repo>/<dir>` — the repo is the first path segment after the
 *  prefix. Repo-UNqualified ids (code-import:<module>, knowledge nodes) have no
 *  project → undefined. */
function projectFromId(id: string): string | undefined {
    const colon = id.indexOf(':');
    if (colon < 0) return undefined;
    const prefix = id.slice(0, colon + 1);
    if (prefix !== 'code-file:' && prefix !== 'code-symbol:' && prefix !== 'code-folder:' && prefix !== 'code-context:' && prefix !== 'code-context-sym:') {
        return undefined;
    }
    const rest = id.slice(colon + 1);
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    return rest.slice(0, slash);
}

function parseMaybeJson<T>(raw: unknown): T | null {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw as T;
    if (typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}
