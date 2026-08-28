/**
 * communities/index.ts — Wave 4 orchestration. Reads the file + symbol
 * graph from embedded Lore, projects to a file-level adjacency, runs
 * label-propagation clustering, labels each community, and returns a
 * ranked list of "neighborhoods" an agent can reason about as modules.
 *
 * Same module-level pattern as cli/memorySync.ts: this is a PURE async
 * function over a duck-typed client surface; the CLI / MCP wrappers
 * supply an EmbeddedLore instance. No Lore-instance lifecycle
 * (open/close) leaks into this file.
 *
 * NON-GOAL (MVP): no persistence — communities are computed on-demand.
 * Persisting community-node membership in the graph adds query
 * complexity we don't yet need; once a real query pattern demands it
 * (e.g. "what other modules does X talk to"), revisit.
 */

import { detectCommunities } from './detect.js';
import { labelCommunity } from './label.js';

/** Public per-community record returned to CLI / MCP callers.
 *
 * GF-4: `id` is a CONTENT-STABLE string derived from the community's
 * membership (label slug + smallest-member anchor + collision hash), NOT
 * the ephemeral Louvain dense int. See communityStableId() below. */
export interface CommunityRecord {
    id: string;
    label: string;
    rationale: string;
    fileCount: number;
    symbolCount: number;
    sampleFiles: string[];
    sampleSymbols: string[];
    /** Dominant folder (most common leading path segments) across member files —
     *  the structural "where this cluster lives" label for the architecture map. */
    folder?: string;
    /** Dominant owning project/repo across member files — drives cluster color. */
    project?: string;
    /** Inferred architectural layer name (presentation/api/domain/data/infra),
     *  from the dominant folder. Absent when no layer keyword matched. */
    layer?: string;
    /** True when this cluster is a high-fan-in "god cluster" (many dependents). */
    hub?: boolean;
}

/** A weighted dependency edge between two communities: `weight` cross-cluster
 *  file→file references (calls/imports/…) collapsed onto the community pair.
 *  `cyclic` = both endpoints are in the same dependency cycle (SCC). `violation`
 *  = a probable layer inversion (a foundational cluster depending on a
 *  surface-level one). Both drive the "coupling insights" overlay. */
export interface CommunityEdge {
    source: string;
    target: string;
    weight: number;
    cyclic?: boolean;
    violation?: boolean;
}

/** Structural-debt findings over the community dependency graph. */
export interface CommunityInsights {
    /** Groups of clusters that mutually depend on each other (strongly-connected
     *  components of size ≥ 2). Each inner array is one cycle group. */
    cycles: string[][];
    /** Clusters depended on by many others (high fan-in) — a change here has a
     *  wide blast radius. Each entry carries how many distinct clusters use it. */
    godClusters: Array<{ id: string; dependents: number }>;
    /** Probable layer inversions: a more-foundational cluster (data/domain)
     *  depending on a surface-level one (api/ui). Heuristic (folder-inferred
     *  layers), so framed as "possible". */
    layerViolations: Array<{ source: string; target: string; sourceLayer: string; targetLayer: string }>;
}

/** RD-Mcommload — per-type bound on rows loaded into the clustering pass.
 *  Raised 10k→50k (RD-caps): a real workspace (v3 ~12.4k code_symbol) exceeded
 *  10k, so clustering silently ran on only the first 10k nodes → mis-assigned
 *  membership. 50k covers realistic repos while still bounding a pathological
 *  monorepo. Memory scales with ACTUAL nodes, not the cap, so this doesn't cost
 *  more on smaller workspaces. */
export const MAX_COMMUNITY_NODES = 50_000;

export interface CommunityResult {
    workspace: string;
    /** Number of (above-min-size) communities returned in `communities`. */
    total: number;
    /** Sorted by fileCount descending — biggest neighborhoods first. */
    communities: CommunityRecord[];
    /** Files that ended up in singleton / below-min-size groups. */
    uncategorized: number;
    /** Inter-community dependency edges (the architecture map). Each is the
     *  aggregate of all cross-cluster file→file coupling references between the
     *  two communities. Only pairs with weight > 0 and both above min-size. */
    edges?: CommunityEdge[];
    /** Structural-debt findings over the dependency graph (cycles, god-clusters,
     *  layer inversions) — the "coupling insights" layer. */
    insights?: CommunityInsights;
    /**
     * RC reconciliation — true when EITHER the code_file or code_symbol read
     * hit MAX_COMMUNITY_NODES (50k) and was clamped. When set, clustering ran
     * on a PREFIX of the workspace's nodes, not the whole graph — communities/
     * edges/insights above may be incomplete. Absent entirely on an
     * under-cap read (never emitted as `false`) so callers can `if (result
     * .truncated)` rather than compare numbers.
     */
    truncated?: boolean;
    /** Present only alongside `truncated: true` — the raw counts that tripped
     *  the cap, for a caller that wants to log/report the shortfall. */
    nodesCapped?: { fileRows: number; symbolRows: number; cap: number };
}

/** Minimum read surface listCommunities needs from EmbeddedLore. Kept
 *  as a duck-type interface (not an import of EmbeddedLore) so this
 *  module stays trivially testable with a hand-rolled fake. */
export interface CommunityReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
    listEdges(pageSize?: number): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
}

export interface ListCommunitiesOpts {
    /** Drop communities smaller than this. Default 2 (singletons are noise). */
    minSize?: number;
    /** Number of sample files / symbols included per community. Default 5. */
    sampleSize?: number;
}

interface CodeFileRow {
    id: string;
    label?: string; // file.path (set by buildCodeFileNode)
    metadata?: string | Record<string, unknown> | null;
}

interface CodeSymbolRow {
    id: string;
    label?: string;
    metadata?: string | Record<string, unknown> | null;
}

interface SymbolMeta {
    name?: string;
    kind?: string;
    filePath?: string;
}

interface FileMeta {
    path?: string;
}

/**
 * Shared internal: read the file/symbol graph, project to file-level edges,
 * cluster, and return the raw membership map plus the helper maps both
 * listCommunities (for labeling) and listCommunityMembership (for the
 * community → fileIds seed) need. Extracted so the expensive read + project +
 * detect pass runs ONCE per call site, not twice.
 *
 * Returns `null` when the workspace has no files (caller decides the empty
 * shape — listCommunities returns an empty result, listCommunityMembership an
 * empty map).
 */
interface MembershipComputation {
    /** fileId → communityId (Louvain dense id, 0..N-1). */
    membership: Map<string, number>;
    /** fileId → file path (label). */
    fileIdToPath: Map<string, string>;
    /** symbolId → fileId. */
    symbolIdToFileId: Map<string, string>;
    /** symbolId → {name,kind} for labeling. */
    symbolIdToMeta: Map<string, { name: string; kind: string }>;
    /** The file→file coupling edges the clustering ran on — reused to build the
     *  inter-community dependency graph (architecture map) without a second read. */
    fileEdges: Array<{ source: string; target: string }>;
    /** RC reconciliation — true when either row read landed EXACTLY at
     *  MAX_COMMUNITY_NODES (the clamp signal), meaning the workspace has AT
     *  LEAST that many rows and clustering ran on a prefix. */
    truncated: boolean;
    nodesCapped: { fileRows: number; symbolRows: number; cap: number };
}

async function computeFileMembership(
    client: CommunityReader,
    workspace: string,
): Promise<MembershipComputation | null> {
    // ── 1. Read code_file + code_symbol for this workspace.
    // RD-Mcommload — bound the row loads so a very large workspace can't OOM
    // the clustering pass. A workspace beyond the cap is clustered on the
    // first N rows. Previously this comment claimed the cap was "surfaced in
    // result metadata" — it WASN'T; listCommunities/listCommunityMembership
    // silently dropped the signal. It now actually is: see `truncated` /
    // `nodesCapped` on MembershipComputation and CommunityResult below.
    const fileRows = (await client.listNodes('code_file', undefined, workspace, MAX_COMMUNITY_NODES)) as CodeFileRow[];
    const symbolRows = (await client.listNodes('code_symbol', undefined, workspace, MAX_COMMUNITY_NODES)) as CodeSymbolRow[];
    const truncated = fileRows.length >= MAX_COMMUNITY_NODES || symbolRows.length >= MAX_COMMUNITY_NODES;
    const nodesCapped = { fileRows: fileRows.length, symbolRows: symbolRows.length, cap: MAX_COMMUNITY_NODES };

    if (fileRows.length === 0) return null;

    // ── 2. Build helper maps: fileId → path, path → fileId.
    const fileIdToPath = new Map<string, string>();
    const pathToFileId = new Map<string, string>();
    for (const f of fileRows) {
        const meta = parseMaybeJson<FileMeta>(f.metadata) ?? {};
        // Both code paths in store/codeNodes.ts set label = file.path AND
        // metadata.path; prefer label (always populated), fall back to meta.
        const filePath = (typeof f.label === 'string' && f.label) || meta.path || '';
        if (!filePath) continue;
        fileIdToPath.set(f.id, filePath);
        pathToFileId.set(filePath, f.id);
    }

    // ── 3. Build symbolId → fileId map via metadata.filePath.
    const symbolIdToFileId = new Map<string, string>();
    const symbolIdToMeta = new Map<string, { name: string; kind: string }>();
    for (const s of symbolRows) {
        const meta = parseMaybeJson<SymbolMeta>(s.metadata) ?? {};
        const fid = meta.filePath ? pathToFileId.get(meta.filePath) : undefined;
        if (!fid) continue;
        symbolIdToFileId.set(s.id, fid);
        symbolIdToMeta.set(s.id, {
            name: meta.name ?? '',
            kind: meta.kind ?? '',
        });
    }

    // ── 4. Project the symbol/file edge graph onto FILE-LEVEL edges.
    //
    // PROJECTION CHOICE: clustering is driven by CALL/IMPORT coupling
    // between files. We classify each edge STRUCTURALLY (by endpoint type),
    // not by relation string, so the projection works on both legacy and
    // typed graphs.
    //
    // Sprint 1 (typed code edges): store/codeNodes.ts now writes real
    // relation kinds. We DROP `contains` (the file→symbol AND parent→child
    // symbol containment edges) and the `describes` context bridge — neither
    // is coupling signal; containment would otherwise tie every file to its
    // own symbols and dominate clustering. Everything else is kept: the real
    // `calls`/`imports`/`extends`/`implements`/data-layer kinds AND the
    // legacy `related_to` (pre-Sprint-1 / mixed graphs — so a workspace not
    // yet re-indexed still clusters). Re-index with `atlas index --force` to
    // get fully-typed edges.
    //
    // After the relation filter, we classify by endpoint types:
    //   - file → symbol  (any stray containment): SKIPPED structurally —
    //                    becomes file→self after projection, filtered below.
    //   - symbol → symbol (calls/imports): PROJECTED to a file→file edge
    //                    via the symbol→file map built in step 3.
    //   - file → file    (direct, if any): PASSED THROUGH as-is.
    // Self-loops (intra-file edges) are dropped — they add zero
    // neighborhood information.
    // Use the FULL edge set. A `slice(0, N)` prefix here was correctness-unsafe:
    // listEdges() returns edges in the backend's paginated (offset) order, NOT
    // grouped by node, so discarding the tail could drop a node's only coupling
    // edge and split/mis-assign its community. listEdges() already self-bounds
    // via its internal MAX_PAGES guard, so memory stays bounded without the
    // target-agnostic slice (mirrors embeddedReader.ts / processes/index.ts).
    const allEdges = await client.listEdges();
    const fileEdges: Array<{ source: string; target: string }> = [];
    for (const e of allEdges) {
        // Sprint 1: skip structural containment + the context bridge; keep
        // all coupling relations (typed call/import/… AND legacy related_to).
        if (e.relation === 'contains' || e.relation === 'describes') continue;
        // GF-3 — exclude folder + external-import pseudo-nodes from the
        // file-coupling projection. Folder edges are `contains` (already dropped
        // above), but external-import edges are `imports` (KEPT by the line
        // above) and would otherwise pull an npm-package pseudo-node into
        // file clustering and pollute the coupling graph. This guard keeps
        // community detection operating on code_file ↔ code_file coupling ONLY,
        // so existing graphs cluster IDENTICALLY (folder/import are new, additive
        // nodes that never participated before).
        if (e.sourceId.startsWith('code-folder:') || e.targetId.startsWith('code-folder:')
            || e.sourceId.startsWith('code-import:') || e.targetId.startsWith('code-import:')) continue;
        const srcIsFile = fileIdToPath.has(e.sourceId);
        const tgtIsFile = fileIdToPath.has(e.targetId);
        const srcFile = srcIsFile ? e.sourceId : symbolIdToFileId.get(e.sourceId);
        const tgtFile = tgtIsFile ? e.targetId : symbolIdToFileId.get(e.targetId);
        if (!srcFile || !tgtFile) continue;
        if (srcFile === tgtFile) continue; // intra-file — no neighborhood signal
        // Skip pure containment edges (file → its own symbol becomes
        // file → file_self after the projection, already filtered above;
        // file → other-file's-symbol shouldn't exist by construction).
        fileEdges.push({ source: srcFile, target: tgtFile });
    }

    // ── 5. Cluster.
    const nodeIds = Array.from(fileIdToPath.keys());
    const { membership } = detectCommunities(
        { nodeIds, edges: fileEdges },
        { maxIters: 30, seed: 1 },
    );

    return { membership, fileIdToPath, symbolIdToFileId, symbolIdToMeta, fileEdges, truncated, nodesCapped };
}

/**
 * community id → member fileIds. Recomputes membership from scratch (one
 * read + project + detect pass via computeFileMembership) and groups by the
 * CONTENT-STABLE community id (the same id listCommunities emits). Unlike
 * listCommunities' sampleFiles (5-capped, path strings), this returns the
 * FULL set of node ids per community — the frontier a community-seeded
 * subgraph BFS needs.
 *
 * ✅ STABLE-ID GUARANTEE (GF-4): the community ids here are content-derived
 * strings (label slug + smallest-member anchor; see communityStableId), NOT
 * the ephemeral Louvain dense int. detectCommunities is deterministic within
 * one index generation (seed:1, randomWalk:false), AND the public id is now a
 * pure function of membership, so the SAME module keeps the SAME id across
 * re-index — adding/removing an unrelated file no longer reshuffles ids. A
 * community-seeded subgraph id is therefore safe to store/reference across
 * re-indexing (it only changes if that community's smallest-path anchor file
 * is itself renamed/deleted, or on a genuine slug collision). Persistence of
 * community NODES remains an explicit non-goal (see file header): the id is
 * re-derivable from membership every call, identically, so there is nothing
 * to persist. Returns an empty map for an empty workspace.
 */
export async function listCommunityMembership(
    client: CommunityReader,
    workspace: string,
): Promise<Map<string, string[]>> {
    const computed = await computeFileMembership(client, workspace);
    const out = new Map<string, string[]>();
    if (!computed) return out;

    // Group by the internal Louvain dense int first, then map each group to
    // its content-stable id (label + sorted members). This MUST agree with
    // listCommunities, so both go through the shared denseIdToStableId helper.
    const groups = groupByDense(computed.membership);
    const denseToStable = buildDenseIdToStableId(groups, computed.fileIdToPath, computed.symbolIdToFileId, computed.symbolIdToMeta);
    for (const [cid, fileIds] of groups) {
        const stableId = denseToStable.get(cid)!;
        out.set(stableId, [...fileIds].sort());
    }
    return out;
}

export async function listCommunities(
    client: CommunityReader,
    workspace: string,
    opts: ListCommunitiesOpts = {},
): Promise<CommunityResult> {
    const minSize = opts.minSize ?? 2;
    const sampleSize = opts.sampleSize ?? 5;

    const computed = await computeFileMembership(client, workspace);
    if (!computed) {
        return { workspace, total: 0, communities: [], uncategorized: 0 };
    }
    const { membership, fileIdToPath, symbolIdToFileId, symbolIdToMeta, fileEdges, truncated, nodesCapped } = computed;

    // ── 6. Group + label.
    const groups = groupByDense(membership);
    // Content-stable id per dense group (label + sorted members). Shared with
    // listCommunityMembership so the subgraph community-seed key matches the
    // id this function emits. (GF-4.)
    const denseToStable = buildDenseIdToStableId(groups, fileIdToPath, symbolIdToFileId, symbolIdToMeta);

    // Pre-bucket symbols by fileId (with full {name,kind} so the
    // label heuristic gets real kinds, not stubs). One pass over
    // symbolRows is O(symbols) total instead of O(symbols * groups).
    const fileIdToSymbols = new Map<string, Array<{ name: string; kind: string }>>();
    for (const [sid, fid] of symbolIdToFileId) {
        const m = symbolIdToMeta.get(sid);
        if (!m) continue;
        const bucket = fileIdToSymbols.get(fid);
        if (bucket) bucket.push(m);
        else fileIdToSymbols.set(fid, [m]);
    }

    // fileId → stable community id, but ONLY for above-min-size communities (the
    // ones actually returned) — so the inter-community edge build below ignores
    // coupling into uncategorized/singleton groups.
    const fileToStable = new Map<string, string>();
    const layerByCid = new Map<string, { rank: number; name: string }>();
    const communities: CommunityRecord[] = [];
    let uncategorized = 0;
    for (const [cid, fileIds] of groups) {
        if (fileIds.length < minSize) {
            uncategorized += fileIds.length;
            continue;
        }
        const stableId = denseToStable.get(cid)!;
        for (const fid of fileIds) fileToStable.set(fid, stableId);
        const memberFiles = fileIds
            .map((fid) => fileIdToPath.get(fid) ?? fid)
            .sort(); // stable sample order
        const memberSymbols: Array<{ name: string; kind: string }> = [];
        for (const fid of fileIds) {
            const syms = fileIdToSymbols.get(fid);
            if (syms) memberSymbols.push(...syms);
        }

        const { label, rationale } = labelCommunity({
            communityId: cid,
            memberFiles,
            memberSymbols,
        });

        // Build sample arrays (capped to sampleSize, sorted for stability).
        const sampleFiles = memberFiles.slice(0, sampleSize);
        const seenSym = new Set<string>();
        const sampleSymbols: string[] = [];
        for (const s of memberSymbols) {
            if (!s.name || seenSym.has(s.name)) continue;
            seenSym.add(s.name);
            sampleSymbols.push(s.name);
            if (sampleSymbols.length >= sampleSize) break;
        }

        const folder = dominantFolder(memberFiles);
        const layer = inferLayer(folder);
        if (layer) layerByCid.set(stableId, layer);
        communities.push({
            id: stableId,
            label,
            rationale,
            fileCount: fileIds.length,
            symbolCount: memberSymbols.length,
            sampleFiles,
            sampleSymbols,
            folder,
            project: dominantProject(fileIds),
            ...(layer ? { layer: layer.name } : {}),
        });
    }

    // Sort by size desc (biggest neighborhoods first), then by id for
    // a deterministic tie-break (string id → lexicographic).
    communities.sort((a, b) => (b.fileCount - a.fileCount) || a.id.localeCompare(b.id));

    // ── Inter-community dependency edges (the architecture map). Collapse every
    // cross-cluster file→file coupling edge onto its {communityA, communityB}
    // pair and sum. Direction-normalized (undirected pair key) so A→B and B→A
    // aggregate together. Only pairs where BOTH endpoints are above-min-size
    // communities survive (fileToStable only holds those).
    const edgeWeights = new Map<string, number>();
    const directed = new Map<string, number>(); // "A||B" (A depends on B) → weight
    for (const e of fileEdges) {
        const a = fileToStable.get(e.source);
        const b = fileToStable.get(e.target);
        if (!a || !b || a === b) continue;
        const key = pairKey(a, b);
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
        directed.set(`${a}||${b}`, (directed.get(`${a}||${b}`) ?? 0) + 1);
    }

    // Coupling insights (cycles / god-clusters / layer inversions) from the
    // DIRECTED graph, plus the pair-key sets used to flag the render edges.
    const ids = communities.map((c) => c.id);
    const { insights, cyclicPairs, violationPairs } = computeInsights(directed, ids, layerByCid);
    const hubIds = new Set(insights.godClusters.map((g) => g.id));
    for (const c of communities) if (hubIds.has(c.id)) c.hub = true;

    const edges: CommunityEdge[] = [...edgeWeights.entries()]
        .map(([key, weight]) => {
            const [source, target] = key.split("|");
            return {
                source: source!,
                target: target!,
                weight,
                ...(cyclicPairs.has(key) ? { cyclic: true } : {}),
                ...(violationPairs.has(key) ? { violation: true } : {}),
            };
        })
        .sort((x, y) => (y.weight - x.weight) || x.source.localeCompare(y.source));

    return {
        workspace,
        total: communities.length,
        communities,
        uncategorized,
        edges,
        insights,
        ...(truncated ? { truncated: true, nodesCapped } : {}),
    };
}

/** Most common leading 1–2 path segments across a community's member files —
 *  the "where this cluster lives" structural label (e.g. `src/api`,
 *  `CodeRunner.Common/Services`). Falls back to '' when nothing is common. */
function dominantFolder(paths: string[]): string {
    const counts = new Map<string, number>();
    for (const p of paths) {
        const segs = p.split('/').filter(Boolean);
        // Prefer a 2-segment prefix; fall back to 1 for shallow paths.
        const key = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : (segs[0] ?? '');
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [k, c] of counts) {
        if (c > bestCount) { bestCount = c; best = k; }
    }
    return best;
}

/** Direction-normalized undirected pair key, used consistently for edge weights
 *  AND the cyclic/violation flag sets so their keys can never drift (a stray
 *  whitespace mismatch previously silently broke the join). `|` is safe — a
 *  community id slug is [a-z0-9-~] only. */
function pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/* ── Coupling-insight analysis over the community dependency graph ────────── */

/** Architectural layers, foundational rank ascending (1 = surface/presentation,
 *  5 = infrastructure). A healthy dependency flows from a lower rank toward a
 *  higher (more foundational) one; the reverse is a probable inversion. */
const LAYER_DEFS: Array<{ rank: number; name: string; kw: RegExp }> = [
    { rank: 1, name: 'presentation', kw: /(^|[/.])(apps|web|ui|components|pages|views|client|frontend|screens)([/.]|$)/i },
    { rank: 2, name: 'api', kw: /(^|[/.])(api|handlers?|controllers?|endpoints?|routes?|mcp|graphql|rest)([/.]|$)/i },
    { rank: 3, name: 'domain', kw: /(^|[/.])(domain|core|services?|model|models|entities|dsl|logic|usecases?|projection)([/.]|$)/i },
    { rank: 4, name: 'data', kw: /(^|[/.])(persistence|storage|repositor(y|ies)|dao|db|database|migrations?|store|entities)([/.]|$)/i },
    { rank: 5, name: 'infra', kw: /(^|[/.])(connectors?|adapters?|infra|infrastructure|gateways?|drivers?)([/.]|$)/i },
];

/** Infer an architectural layer from a community's dominant folder. Returns null
 *  when no keyword matches (many clusters legitimately have no clear layer). */
function inferLayer(folder: string): { rank: number; name: string } | null {
    if (!folder) return null;
    for (const l of LAYER_DEFS) {
        if (l.kw.test(folder)) return { rank: l.rank, name: l.name };
    }
    return null;
}

/** Tarjan's strongly-connected-components. Returns SCCs of size ≥ 2 (i.e. the
 *  dependency CYCLES) as arrays of node ids. Pure, O(V+E), on the tiny community
 *  graph. `adj` maps a node to the nodes it depends on (directed). */
function stronglyConnectedCycles(nodes: string[], adj: Map<string, Set<string>>): string[][] {
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: string[][] = [];

    // Iterative Tarjan (avoid deep recursion on pathological graphs).
    for (const root of nodes) {
        if (idx.has(root)) continue;
        const work: Array<{ v: string; iter: Iterator<string> }> = [
            { v: root, iter: (adj.get(root) ?? new Set()).values() },
        ];
        idx.set(root, index); low.set(root, index); index++; stack.push(root); onStack.add(root);
        while (work.length > 0) {
            const top = work[work.length - 1]!;
            const next = top.iter.next();
            if (!next.done) {
                const w = next.value;
                if (!idx.has(w)) {
                    idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
                    work.push({ v: w, iter: (adj.get(w) ?? new Set()).values() });
                } else if (onStack.has(w)) {
                    low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
                }
            } else {
                if (low.get(top.v) === idx.get(top.v)) {
                    const comp: string[] = [];
                    for (;;) {
                        const w = stack.pop()!; onStack.delete(w); comp.push(w);
                        if (w === top.v) break;
                    }
                    if (comp.length >= 2) out.push(comp.sort());
                }
                work.pop();
                if (work.length > 0) {
                    const parent = work[work.length - 1]!.v;
                    low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
                }
            }
        }
    }
    return out;
}

/**
 * Compute the coupling-insight overlay from DIRECTED cross-community weights.
 * `directed` maps `"A||B"` (A depends on B) → weight. `layers` maps community id
 * → inferred layer. Returns cycles (SCC≥2), god-clusters (fan-in ≥ threshold),
 * and probable layer inversions, plus the set of cyclic/violation pair keys so
 * the undirected render edges can be flagged.
 */
function computeInsights(
    directed: Map<string, number>,
    ids: string[],
    layers: Map<string, { rank: number; name: string }>,
): { insights: CommunityInsights; cyclicPairs: Set<string>; violationPairs: Set<string> } {
    // Directed adjacency + fan-in.
    const adj = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>(); // target → set of sources
    for (const key of directed.keys()) {
        const [a, b] = key.split('||') as [string, string];
        if (!adj.has(a)) adj.set(a, new Set());
        adj.get(a)!.add(b);
        if (!dependents.has(b)) dependents.set(b, new Set());
        dependents.get(b)!.add(a);
    }

    // Cycles: SCCs of size ≥ 2.
    const cycles = stronglyConnectedCycles(ids, adj);
    const inCycle = new Map<string, number>(); // id → cycle group index
    cycles.forEach((grp, i) => grp.forEach((id) => inCycle.set(id, i)));
    const cyclicPairs = new Set<string>();
    for (const key of directed.keys()) {
        const [a, b] = key.split('||') as [string, string];
        if (inCycle.has(a) && inCycle.get(a) === inCycle.get(b)) {
            cyclicPairs.add(pairKey(a, b));
        }
    }

    // God-clusters: fan-in ≥ 3 distinct dependents (a change ripples widely).
    // EXCLUDE cycle members — a cluster in a cycle already has its coupling
    // explained by the cycle finding; flagging it as a hub too is redundant
    // noise. This surfaces the standalone "everyone depends on this" clusters.
    const godClusters = [...dependents.entries()]
        .map(([id, srcs]) => ({ id, dependents: srcs.size }))
        .filter((g) => g.dependents >= 3 && !inCycle.has(g.id))
        .sort((x, y) => y.dependents - x.dependents);

    // Layer inversions: A depends on B where A is MORE foundational than B
    // (rank(A) > rank(B)) by a clear gap. Skip infra→domain (dependency
    // inversion is legitimate there) to avoid false positives.
    const violationPairs = new Set<string>();
    const layerViolations: CommunityInsights['layerViolations'] = [];
    for (const key of directed.keys()) {
        const [a, b] = key.split('||') as [string, string];
        const la = layers.get(a);
        const lb = layers.get(b);
        if (!la || !lb) continue;
        if (la.rank === 5) continue; // infra depending on domain = valid DIP
        if (la.rank - lb.rank >= 2) {
            layerViolations.push({ source: a, target: b, sourceLayer: la.name, targetLayer: lb.name });
            violationPairs.add(pairKey(a, b));
        }
    }

    return {
        insights: { cycles, godClusters, layerViolations },
        cyclicPairs,
        violationPairs,
    };
}

/** Most common owning project/repo across member fileIds. A code_file id is
 *  `code-file:<repo>/<path>` — the repo is the first path segment after the
 *  prefix. Falls back to '' if unparseable. */
function dominantProject(fileIds: string[]): string {
    const counts = new Map<string, number>();
    for (const id of fileIds) {
        const colon = id.indexOf(':');
        if (colon < 0) continue;
        const rest = id.slice(colon + 1);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const repo = rest.slice(0, slash);
        counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [k, c] of counts) {
        if (c > bestCount) { bestCount = c; best = k; }
    }
    return best;
}

/* ─────────────────────────────────────────────────────────────────────────
 * GF-4 — content-stable community id derivation.
 *
 * The PUBLIC community id is a deterministic, pure function of the community's
 * MEMBERSHIP — never the positional Louvain dense int (which reshuffles on
 * every re-index; that was the GF-4 bug). The internal dense int still exists
 * (detect.ts produces it) but is mapped to a stable string at the public
 * boundary by buildDenseIdToStableId below.
 *
 * Derivation per community (see communityStableId):
 *   base   = slug(label)          ← the existing deterministic labelCommunity
 *   anchor = slugBasename(min path) ← lexicographically-smallest member file,
 *                                     the single most stable member under churn
 *   id     = `${base}~${anchor}`
 *
 * `~` separates the two parts and can never appear inside a slug (slug emits
 * only [a-z0-9-]), so the two halves are unambiguous.
 *
 * Special cases:
 *   - `community-<denseInt>` fallback label (no dir prefix, no symbol root):
 *     the label embeds the UNSTABLE dense int, so we DROP it and use the fixed
 *     base "community" — the id is then carried entirely by the stable anchor:
 *     `community~${anchor}`.
 *   - true collision (two distinct communities slug to the same `base~anchor`):
 *     append a short hash of the sorted member BASENAMES → `${base}~${anchor}~${hash8}`.
 *     This is the only place a full-membership hash enters, and only on the
 *     rare collision tail, so churn-brittleness is contained.
 * ───────────────────────────────────────────────────────────────────────── */

/** Group a fileId→denseId membership map into denseId→fileIds[]. Insertion
 *  order of the groups follows first-encounter in the membership map; callers
 *  that need determinism sort the member lists / derive stable ids. */
function groupByDense(membership: Map<string, number>): Map<number, string[]> {
    const groups = new Map<number, string[]>();
    for (const [fid, cid] of membership) {
        const arr = groups.get(cid);
        if (arr) arr.push(fid);
        else groups.set(cid, [fid]);
    }
    return groups;
}

/** Lowercase, collapse non-alnum runs → '-', trim leading/trailing '-'.
 *  ("NodeView" → "nodeview", "src/loc" → "src-loc"). Emits only [a-z0-9-]. */
function slug(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Basename of a path without its extension, slugged.
 *  ("src/locale/format.ts" → "format"). Empty paths → "". */
function slugBasename(filePath: string): string {
    const base = filePath.split('/').pop() ?? '';
    const noExt = base.replace(/\.[^.]+$/, '');
    return slug(noExt);
}

/** Deterministic, non-cryptographic 32-bit hash (FNV-1a), hex-encoded. Used
 *  ONLY for the collision tie-break — never on the common path — so its
 *  churn-sensitivity (membership-dependent) is contained to genuine collisions. */
function hash8(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        // 32-bit FNV prime multiply via shifts (keep it in 32-bit range).
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derive the content-stable id for ONE community from its (deterministic)
 * label and its member file paths. `memberFilesSorted` MUST be sorted (its
 * first element is the lexicographically-smallest path → the stable anchor).
 *
 * Returns the bare `base~anchor` id. Collision resolution across communities
 * is handled by the caller (buildDenseIdToStableId) since it requires the
 * full set of ids — this function is the pure per-community core.
 */
export function communityStableId(label: string, memberFilesSorted: string[]): string {
    // Drop the unstable `community-<int>` fallback label → fixed "community"
    // base, leaning entirely on the anchor.
    const base = /^community-\d+$/.test(label) ? 'community' : (slug(label) || 'community');
    const smallest = memberFilesSorted[0] ?? '';
    const anchor = slugBasename(smallest) || 'unnamed';
    return `${base}~${anchor}`;
}

/**
 * Map each dense Louvain community id to its content-stable public id, with a
 * final collision guard. Shared by listCommunities and listCommunityMembership
 * so the subgraph community-seed key matches the id listCommunities emits.
 *
 * Iterates groups in a DETERMINISTIC order (by sorted member list) so that if
 * two communities collide on `base~anchor`, the SAME one wins the bare id and
 * the SAME one gets the `~hash8` suffix on every call — the assignment can't
 * flip between runs.
 */
function buildDenseIdToStableId(
    groups: Map<number, string[]>,
    fileIdToPath: Map<string, string>,
    symbolIdToFileId: Map<string, string>,
    symbolIdToMeta: Map<string, { name: string; kind: string }>,
): Map<number, string> {
    // Bucket symbols by fileId once so each community's label gets real kinds.
    const fileIdToSymbols = new Map<string, Array<{ name: string; kind: string }>>();
    for (const [sid, fid] of symbolIdToFileId) {
        const m = symbolIdToMeta.get(sid);
        if (!m) continue;
        const bucket = fileIdToSymbols.get(fid);
        if (bucket) bucket.push(m);
        else fileIdToSymbols.set(fid, [m]);
    }

    // Build a per-group record: dense id, sorted member paths, sorted member
    // basenames (for the collision hash), and its bare stable id.
    interface GroupInfo { cid: number; memberFiles: string[]; basenames: string[]; bareId: string; }
    const infos: GroupInfo[] = [];
    for (const [cid, fileIds] of groups) {
        const memberFiles = fileIds.map((fid) => fileIdToPath.get(fid) ?? fid).sort();
        const memberSymbols: Array<{ name: string; kind: string }> = [];
        for (const fid of fileIds) {
            const syms = fileIdToSymbols.get(fid);
            if (syms) memberSymbols.push(...syms);
        }
        const { label } = labelCommunity({ communityId: cid, memberFiles, memberSymbols });
        const bareId = communityStableId(label, memberFiles);
        const basenames = memberFiles.map((p) => p.split('/').pop() ?? p).sort();
        infos.push({ cid, memberFiles, basenames, bareId });
    }

    // Deterministic processing order: by smallest member path (its sorted
    // member list's first element), then dense id. This fixes WHICH colliding
    // community keeps the bare id across runs.
    infos.sort((a, b) => {
        const am = a.memberFiles[0] ?? '';
        const bm = b.memberFiles[0] ?? '';
        return am.localeCompare(bm) || (a.cid - b.cid);
    });

    const out = new Map<number, string>();
    const used = new Set<string>();
    for (const info of infos) {
        let id = info.bareId;
        if (used.has(id)) {
            // Genuine collision: disambiguate with a short membership hash.
            id = `${info.bareId}~${hash8(info.basenames.join('|'))}`;
            // Pathological: if even that collides (same membership basenames),
            // fall back to appending the dense id — guaranteed unique per group.
            while (used.has(id)) id = `${info.bareId}~${hash8(info.basenames.join('|'))}~${info.cid}`;
        }
        used.add(id);
        out.set(info.cid, id);
    }
    return out;
}

/** metadata can come back as a JSON string OR an already-parsed object
 *  depending on the read path. Tolerate both. */
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
