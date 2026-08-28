/**
 * graph/subgraph.ts — B1: the `atlas_subgraph` data layer.
 *
 * Returns a bounded N-hop induced slice of the code graph around a single
 * `center` node OR all files of a `community`, for the UI's hierarchical
 * drill-down (community → file → symbol). The viz NEVER renders the whole
 * graph; this tool is the hard cap that enforces it (maxNodes, server-clamped
 * to <= 1000).
 *
 * SAME architectural pattern as processes/index.ts and communities/index.ts:
 * a PURE async function over a duck-typed reader surface (SubgraphReader). The
 * CLI / MCP wrappers supply an EmbeddedLore instance; this module never sees
 * the open/close lifecycle and is trivially testable with a hand-rolled fake.
 *
 * STRATEGY (the proven listEdges-then-BFS-in-memory path, mirroring
 * processes/index.ts — NOT the unverified traverse() fast-path, deferred until
 * its element shape is characterized):
 *   1. listNodes(code_file) + listNodes(code_symbol) → id → view map.
 *   2. listEdges() once → UNDIRECTED adjacency (both directions), each edge
 *      kept verbatim with its relation.
 *   3. Seed the BFS frontier: center → [center]; community → ALL member
 *      fileIds (via listCommunityMembership in communities/index.ts).
 *   4. BFS the adjacency, bounded by `depth` and `maxNodes`; mark truncated
 *      iff maxNodes cut the frontier while nodes remained unexplored.
 *   5. Emit the INDUCED edge set (both endpoints kept) + hydrated node views.
 *
 * EDGE-CLASS / node-class: every node is classified by id PREFIX (startsWith)
 * onto `cls` so the viewer can style by drill-down level. The classifier
 * treats BOTH `code-context:` AND `code-context-sym:` as 'context' (the two
 * context-card id forms written by store/codeNodes.ts).
 */

import type { EmbeddedLore } from '../lore/embeddedLore.js';
import { KNOWLEDGE_TYPES } from '../schema.js';

// ── id-prefix constants (mirror store/codeNodes.ts) ──────────────────────────
// startsWith() is the structural NODE discriminator: nodes are classified by
// id prefix (file / symbol / context), independent of edge relation. This
// module is relation-AGNOSTIC — it passes each edge's `relation` through
// verbatim (Sprint 1: that's now the real typed kind — calls/imports/contains/
// describes/… — or legacy `related_to` on un-reindexed graphs), so no edge
// logic changes here.
const CODE_FILE_PREFIX = 'code-file:';
const CODE_SYMBOL_PREFIX = 'code-symbol:';
const CODE_CONTEXT_PREFIX = 'code-context:';
const CODE_CONTEXT_SYM_PREFIX = 'code-context-sym:';
// GF-3 — folder/import node id prefixes (mirror store/codeNodes.ts). Their
// prefixes do NOT overlap any of the above, so order-of-checks is irrelevant.
const CODE_FOLDER_PREFIX = 'code-folder:';
const CODE_IMPORT_PREFIX = 'code-import:';

// Curated knowledge node types (decision/convention/bug_pattern/
// troubleshooting/architecture). Sprint 1: sourced from schema.ts's
// canonical KNOWLEDGE_TYPES so this set can't drift from the rest of Atlas.
const KNOWLEDGE_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWLEDGE_TYPES);

/** Drill-down class of a node, derived from its id prefix / type so the
 *  viewer can style by hierarchy level. */
export type SubgraphNodeClass = 'file' | 'symbol' | 'context' | 'folder' | 'import' | 'knowledge' | 'other';

/** Public per-node record returned to MCP callers. */
export interface SubgraphNode {
    id: string;
    type: string;
    label: string;
    /** Source file path when derivable from metadata.filePath / label. */
    file?: string;
    /** Drill-down class, from classifyNode(). Drives viewer styling by level. */
    cls: SubgraphNodeClass;
    /** 1-based first source line (code_symbol only — from symbol metadata). */
    startLine?: number;
    /** 1-based last source line (code_symbol only — from symbol metadata). */
    endLine?: number;
    /** Symbol signature (code_symbol only — from symbol metadata). */
    signature?: string;
    /** Fully-qualified symbol name (code_symbol only — from symbol metadata). */
    qualifiedName?: string;
    /** Owning project/repo (from metadata.repo) — drives the project filter +
     *  project-coloring in the whole-graph view. Absent on repo-unqualified nodes
     *  (external imports, curated knowledge). */
    project?: string;
    /** Content-stable community id this node belongs to (whole-graph view only;
     *  populated by buildFullGraph). Drives graphify-style community coloring.
     *  Absent for nodes outside any community (folders/imports/knowledge). */
    community?: string;
}

/** Public per-edge record. `relation` is the stored edge relation passed
 *  through verbatim — Sprint 1's real typed kind (calls/imports/contains/
 *  describes/…) or legacy `related_to` on un-reindexed graphs. The induced
 *  set: both endpoints are in `nodes`. */
export interface SubgraphEdge {
    source: string;
    target: string;
    relation: string;
    /** GF-1 — per-edge confidence tier as stored on the Lore edge:
     *  'extracted' (AST fact / structural) | 'inferred' (heuristic bridge) |
     *  'ambiguous'. Absent on legacy edges written before GF-1 (Lore then
     *  defaults the stored value to 'extracted'/1.0). */
    confidence?: string;
    /** GF-1 — 0..1 numeric confidence. For AST code edges this is the
     *  resolver's per-relation float (1.0 direct, <1 heuristic); 1.0 for
     *  structural containment; 0.6 for the code_context 'describes' bridge. */
    confidenceScore?: number;
}

export interface Subgraph {
    nodes: SubgraphNode[];
    edges: SubgraphEdge[];
    /** True iff BFS stopped because maxNodes hit while the frontier still had
     *  unexplored nodes — NOT natural exhaustion. Drives the viewer's
     *  "N more — refine" affordance. */
    truncated: boolean;
    /** The resolved seed: center id, or "community:<id>". */
    seed: string;
}

export interface SubgraphOpts {
    /** A node id (code-file:… | code-symbol:…) to BFS from. */
    center?: string;
    /** A content-stable community id (e.g. "locale~format", from
     *  atlas_communities) to expand — all its files seed the frontier.
     *  GF-4: stable across re-index, safe to store/reference. */
    community?: string;
    /** Traversal depth cap. Default 2. */
    depth?: number;
    /** If provided, only nodes whose `type` is in this set are included —
     *  applied DURING BFS (excluded nodes are not traversed into). */
    nodeTypes?: string[];
    /** Node cap. Default 200, hard-clamped to <= 1000 so the viz lever can't
     *  be bypassed. */
    maxNodes?: number;
}

/** Hard ceiling on returned nodes — the viz must never receive the whole
 *  graph regardless of what the caller asks for (GAP #6). */
const MAX_NODES_CEILING = 1000;
const DEFAULT_MAX_NODES = 200;
const DEFAULT_DEPTH = 2;

/** Minimum read surface buildSubgraph needs from EmbeddedLore. Kept as a
 *  duck-type interface (not an import of EmbeddedLore) so this module stays
 *  trivially testable with a hand-rolled fake — same pattern as ProcessReader
 *  in processes/index.ts. The compile-time assertion below guarantees the real
 *  EmbeddedLore still satisfies it. (traverse? is listed as optional for the
 *  deferred fast-path but is NOT used in v1.) */
export interface SubgraphReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
    listEdges(pageSize?: number): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>>;
    getNode(id: string): Promise<unknown>;
    traverse?(nodeId: string, depth?: number): Promise<unknown[]>;
}

// Compile-time assertion: the real EmbeddedLore must satisfy SubgraphReader.
// If a signature drifts (listNodes/listEdges/getNode), this fails tsc at the
// gate — same guarantee the duck-typed readers in processes/communities rely
// on, made explicit here.
type _AssertEmbeddedLoreSatisfiesReader = EmbeddedLore extends SubgraphReader ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertReader: _AssertEmbeddedLoreSatisfiesReader = true as const;

interface NodeRow {
    id: string;
    type?: string;
    label?: string;
    metadata?: string | Record<string, unknown> | null;
}

interface NodeMeta {
    filePath?: string;
    /** Symbol metadata (code_symbol only — written by store/codeNodes.ts). */
    startLine?: number;
    endLine?: number;
    signature?: string;
    qualifiedName?: string;
}

/** A hydrated, in-memory view of one node — built once from listNodes, then
 *  projected to the public SubgraphNode on emit. */
interface NodeView {
    id: string;
    type: string;
    label: string;
    file?: string;
    cls: SubgraphNodeClass;
    startLine?: number;
    endLine?: number;
    signature?: string;
    qualifiedName?: string;
}

/**
 * Classify a node onto its drill-down class by id PREFIX (startsWith), with a
 * knowledge-type fallback for curated nodes that lack a code-* prefix.
 *
 * Order matters: the more specific `code-context-sym:` MUST be tested before
 * `code-context:` would otherwise also match? — it would NOT (code-context:
 * is not a prefix of code-context-sym:), but we test both explicitly so the
 * intent is unmistakable. Both map to 'context'.
 */
export function classifyNode(id: string, type?: string): SubgraphNodeClass {
    if (id.startsWith(CODE_FILE_PREFIX)) return 'file';
    if (id.startsWith(CODE_SYMBOL_PREFIX)) return 'symbol';
    if (id.startsWith(CODE_CONTEXT_SYM_PREFIX) || id.startsWith(CODE_CONTEXT_PREFIX)) return 'context';
    // GF-3 — folder/import prefixes are non-overlapping with the above, so they
    // can be appended here. Explicit classes (vs folding to 'other') let the UI
    // style them with their own schema colors (see GraphController kindFromCls).
    if (id.startsWith(CODE_FOLDER_PREFIX)) return 'folder';
    if (id.startsWith(CODE_IMPORT_PREFIX)) return 'import';
    if (type && KNOWLEDGE_TYPE_SET.has(type)) return 'knowledge';
    return 'other';
}

export async function buildSubgraph(
    reader: SubgraphReader,
    workspace: string,
    opts: SubgraphOpts,
): Promise<Subgraph> {
    // ── 0. Validate the seed contract. At least one of center/community; on
    // ambiguity (both) error — explicit contract (refuse to guess).
    const hasCenter = typeof opts.center === 'string' && opts.center.length > 0;
    const hasCommunity = typeof opts.community === 'string' && opts.community.length > 0;
    if (!hasCenter && !hasCommunity) {
        throw new Error('atlas_subgraph requires at least one of `center` or `community` (refusing to materialize the whole graph)');
    }
    if (hasCenter && hasCommunity) {
        throw new Error('atlas_subgraph: pass exactly one of `center` or `community`, not both (ambiguous seed)');
    }

    const depth = opts.depth ?? DEFAULT_DEPTH;
    // Clamp maxNodes: floor 1, hard ceiling 1000. The viz lever cannot be
    // bypassed by a misbehaving client (GAP #6).
    const requestedMax = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const maxNodes = Math.max(1, Math.min(requestedMax, MAX_NODES_CEILING));
    const typeFilter = opts.nodeTypes && opts.nodeTypes.length > 0
        ? new Set(opts.nodeTypes)
        : undefined;

    // ── 1. Hydrate code_file + code_symbol views (id → view). These are the
    // structural levels the viewer drills through. listNodes is the unbounded
    // 10k path (no explicit limit). Mirrors processes/communities.
    const idToView = new Map<string, NodeView>();
    const ingestRows = (rows: unknown[]) => {
        for (const r of rows as NodeRow[]) {
            if (!r || typeof r.id !== 'string') continue;
            if (idToView.has(r.id)) continue;
            const type = typeof r.type === 'string' ? r.type : '';
            const meta = parseMaybeJson<NodeMeta>(r.metadata) ?? {};
            const label = (typeof r.label === 'string' && r.label) || r.id;
            const file = meta.filePath || (typeof r.label === 'string' ? r.label : undefined);
            idToView.set(r.id, {
                id: r.id,
                type,
                label,
                ...(file ? { file } : {}),
                ...symbolFields(meta),
                cls: classifyNode(r.id, type),
            });
        }
    };
    ingestRows(await reader.listNodes('code_file', undefined, workspace, undefined));
    ingestRows(await reader.listNodes('code_symbol', undefined, workspace, undefined));

    // ── 2. Build an UNDIRECTED adjacency from ALL edges (both directions),
    // regardless of relation kind. Each neighbor entry carries the original
    // relation so the induced edge set can re-emit it verbatim (Sprint 1:
    // real typed kind or legacy related_to). Single listEdges() pass — same
    // proven strategy as processes/index.ts.
    const allEdges = await reader.listEdges();
    const adjacency = new Map<string, Array<{ neighbor: string; relation: string }>>();
    const addAdj = (from: string, to: string, relation: string) => {
        let bucket = adjacency.get(from);
        if (!bucket) { bucket = []; adjacency.set(from, bucket); }
        bucket.push({ neighbor: to, relation });
    };
    for (const e of allEdges) {
        if (e.sourceId === e.targetId) continue; // self-loop — no structural value
        addAdj(e.sourceId, e.targetId, e.relation); // both directions: BFS is
        addAdj(e.targetId, e.sourceId, e.relation); // direction-agnostic here.
    }

    // ── 3. Resolve the seed frontier.
    let seedLabel: string;
    const seedIds: string[] = [];
    if (hasCenter) {
        const center = opts.center!;
        // Validate the center exists. Prefer the hydrated view (cheap); fall
        // back to getNode for a center that isn't a code_file/code_symbol
        // (e.g. a knowledge node) so the tool still works on any real id.
        if (!idToView.has(center)) {
            const node = await reader.getNode(center).catch(() => null) as NodeRow | null;
            if (!node || typeof node.id !== 'string') {
                throw new Error(`atlas_subgraph: center node not found: '${center}' in workspace '${workspace}'`);
            }
            const type = typeof node.type === 'string' ? node.type : '';
            const meta = parseMaybeJson<NodeMeta>(node.metadata) ?? {};
            idToView.set(node.id, {
                id: node.id,
                type,
                label: (typeof node.label === 'string' && node.label) || node.id,
                ...(meta.filePath ? { file: meta.filePath } : {}),
                ...symbolFields(meta),
                cls: classifyNode(node.id, type),
            });
        }
        seedIds.push(center);
        seedLabel = center;
    } else {
        // Community seed: take ALL files of that community as the frontier
        // (not the 5-cap sampleFiles), then expand `depth` hops. Lazy import
        // keeps the module dependency-light and avoids a load-time cycle.
        const { listCommunityMembership } = await import('../communities/index.js');
        const membership = await listCommunityMembership(reader, workspace);
        const members = membership.get(opts.community!);
        if (!members || members.length === 0) {
            throw new Error(`atlas_subgraph: community ${opts.community} has no members in workspace '${workspace}'`);
        }
        for (const fid of members) seedIds.push(fid);
        seedLabel = `community:${opts.community}`;
    }

    // ── 4. BFS the undirected adjacency, bounded by depth + maxNodes.
    //
    // Determinism: at every level we sort the frontier by id before expanding,
    // and the final node/edge arrays are sorted before return. Visit order is
    // (depth asc, id asc). Same discipline as processes/index.ts.
    //
    // truncated semantics: true iff the maxNodes cap fired WHILE the frontier
    // still had unexplored nodes (i.e. we cut the picture short), NOT on
    // natural exhaustion or the depth boundary alone.
    const included = new Set<string>();
    const visited = new Set<string>();
    let truncated = false;

    const passesFilter = (id: string): boolean => {
        if (!typeFilter) return true;
        const v = idToView.get(id);
        // Unknown nodes (no view) have no type to filter on — exclude them
        // when a filter is active so we don't traverse into unclassified ids.
        if (!v) return false;
        return typeFilter.has(v.type);
    };

    // Seed: admit seed ids that pass the filter, up to the cap.
    type Frontier = { id: string; depth: number };
    let frontier: Frontier[] = [];
    const sortedSeeds = [...new Set(seedIds)].sort();
    for (const id of sortedSeeds) {
        visited.add(id);
        if (!passesFilter(id)) continue;
        if (included.size >= maxNodes) {
            // More seeds than the cap allows — the picture is cut short.
            truncated = true;
            break;
        }
        included.add(id);
        frontier.push({ id, depth: 0 });
    }

    while (frontier.length > 0 && !truncated) {
        frontier.sort((a, b) => a.id.localeCompare(b.id));
        const nextFrontier: Frontier[] = [];

        outer:
        for (const f of frontier) {
            if (f.depth >= depth) continue; // depth boundary — don't expand
            const neighbors = adjacency.get(f.id);
            if (!neighbors) continue;
            // Deterministic neighbor expansion order.
            const sortedNeighbors = [...neighbors].sort((a, b) => a.neighbor.localeCompare(b.neighbor));
            for (const { neighbor } of sortedNeighbors) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);
                if (!passesFilter(neighbor)) continue; // excluded: don't traverse INTO it
                if (included.size >= maxNodes) {
                    // Cap bites while nodes remain to explore → truncated.
                    truncated = true;
                    break outer;
                }
                included.add(neighbor);
                nextFrontier.push({ id: neighbor, depth: f.depth + 1 });
            }
        }
        frontier = nextFrontier;
    }

    // ── 5. Emit the INDUCED edge set: every edge whose BOTH endpoints are
    // included, relation passed through verbatim. Dedupe (an undirected edge
    // appears twice in the directed source list). Hydrate node views (fall
    // back to a minimal view
    // for any included id we never hydrated — e.g. a community member with no
    // listNodes row, defensive).
    const nodes: SubgraphNode[] = [];
    for (const id of included) {
        const v = idToView.get(id);
        if (v) {
            nodes.push({
                id: v.id,
                type: v.type,
                label: v.label,
                ...(v.file ? { file: v.file } : {}),
                ...symbolFields(v),
                cls: v.cls,
            });
        } else {
            nodes.push({ id, type: '', label: id, cls: classifyNode(id) });
        }
    }

    const seenEdge = new Set<string>();
    const edges: SubgraphEdge[] = [];
    for (const e of allEdges) {
        if (e.sourceId === e.targetId) continue;
        if (!included.has(e.sourceId) || !included.has(e.targetId)) continue;
        // Dedupe on a direction-normalized key + relation so an undirected
        // pair emitted from both directed rows collapses to one edge.
        const a = e.sourceId < e.targetId ? e.sourceId : e.targetId;
        const b = e.sourceId < e.targetId ? e.targetId : e.sourceId;
        const key = `${a}\0${b}\0${e.relation}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        // GF-1 — surface per-edge confidence (+score) so the viz/consumers can
        // weight an AST fact above a heuristic bridge. Metadata, not identity:
        // the dedupe key above stays relation-only.
        edges.push({
            source: e.sourceId,
            target: e.targetId,
            relation: e.relation,
            ...(e.confidence ? { confidence: e.confidence } : {}),
            ...(e.confidenceScore !== undefined ? { confidenceScore: e.confidenceScore } : {}),
        });
    }

    // Deterministic ordering for stable output across runs.
    nodes.sort((x, y) => x.id.localeCompare(y.id));
    edges.sort((x, y) =>
        x.source.localeCompare(y.source)
        || x.target.localeCompare(y.target)
        || x.relation.localeCompare(y.relation),
    );

    return { nodes, edges, truncated, seed: seedLabel };
}

/** Conditional-spread the optional code_symbol fields (startLine/endLine/
 *  signature/qualifiedName) from a source that may carry them (parsed metadata
 *  OR a hydrated NodeView). Mirrors the existing `...(file ? {file} : {})`
 *  idiom: a field is only emitted when present + the right type, so file nodes
 *  (which lack these keys) stay clean and the public shape is additive. */
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

/** metadata can come back as a JSON string OR an already-parsed object
 *  depending on the read path. Tolerate both. (Identical helper to the one in
 *  processes/index.ts and communities/index.ts — kept local to avoid a
 *  cross-module import for a 6-line utility.) */
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
