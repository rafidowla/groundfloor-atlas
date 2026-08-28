/**
 * GraphController.ts — B2: the framework-agnostic drill-down core.
 *
 * This is the testable heart of the hierarchical viewer. It has NO React and
 * NO Sigma dependency — only graphology (the mutation API) and an injected
 * `Fetcher` (so tests use a fake, production uses the MCP client). The React
 * layer (useGraphData + AtlasGraph) wraps this; everything load-bearing lives
 * here and is unit-tested directly.
 *
 * ── THE OWNERSHIP INVERSION (the real B2 blocker) ──────────────────────────
 * The pre-B2 code did `setGraph(buildGraph(...))` on every change — a NEW
 * Graphology instance each time, with ZERO edges (a point cloud). There was no
 * live instance to mutate. This controller flips that: it receives ONE graph
 * instance in its constructor and MUTATES it in place forever
 * (addNode/addEdge/dropNode). It NEVER constructs a Graph and NEVER replaces
 * the reference. The React side keeps that single instance stable (useRef keyed
 * by workspace) so Sigma loads it once and re-renders via refresh(), not reload.
 *
 * ── DELIBERATE NO-WHOLE-GRAPH-RELAYOUT CHOICE ──────────────────────────────
 * On expand we DO NOT run graphology-layout-forceatlas2 `assign()` over the
 * whole graph. The current layout is synchronous main-thread (200 iterations);
 * re-laying-out thousands of nodes on every expand drops frames and is the
 * "freeze" risk the critique flagged. Instead, new children are placed
 * DETERMINISTICALLY on a radius around their parent (parent.x + r*cos(theta),
 * parent.y + r*sin(theta)), spread over the child count. Pre-existing node
 * positions are therefore NEVER touched by an expand — only the newly-added
 * children get coordinates. This keeps expand O(children), not O(graph), and
 * makes the layout reproducible (see DETERMINISM below).
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Children are sorted by id before radial placement, so the same expand always
 * yields the same angles → reproducible layout, stable tests.
 *
 * ── PARENT TRACKING / REFCOUNT COLLAPSE ────────────────────────────────────
 * Every added node records the set of parents it was reached from (attr
 * `parents`, a string[] kept sorted; `parentId` mirrors the FIRST parent for
 * cheap display). Collapse walks the parent's descendant subtree and drops a
 * node ONLY when this parent is its LAST remaining parent — a node reachable
 * from two expanded parents survives until BOTH collapse. This is a true
 * refcount (the parent-set IS the refcount), so collapse never orphans a node
 * another expanded parent still needs.
 */

import type Graph from 'graphology';
import { NODE_TYPE_META, EDGE_TYPE_META, type NodeType } from '@atlas-schema';
import { colorForKey } from './colorScale';

/** How the whole-graph view paints nodes: by schema type (file/symbol/…),
 *  by owning project/repo, or by semantic community cluster (graphify-style). */
export type ColorMode = 'type' | 'project' | 'community';

/** Coupling-insight overlay from the community layer (mirrors the backend
 *  CommunityInsights shape). */
export interface CommunityInsights {
  cycles: string[][];
  godClusters: Array<{ id: string; dependents: number }>;
  layerViolations: Array<{ source: string; target: string; sourceLayer: string; targetLayer: string }>;
}

/** Coupling-insight edge colors. */
const CYCLE_EDGE_COLOR = '#f59e0b';     // amber — cyclic dependency
const VIOLATION_EDGE_COLOR = '#ef4444'; // red — probable layer inversion
const NORMAL_COMMUNITY_EDGE_COLOR = '#5b6472';

/** Neutral fallback edge color for relations not in EDGE_TYPE_META. */
const DEFAULT_EDGE_COLOR = '#374151';

/** Resolve an edge color from its typed relation (Sprint-2: distinct hue per
 *  relation so a typed graph is legible). Unknown relations fall back to grey. */
function colorForRelation(relation: string): string {
  return (EDGE_TYPE_META as Record<string, { color: string }>)[relation]?.color ?? DEFAULT_EDGE_COLOR;
}

// ── Fetcher contract (injected; fake in tests, MCP-backed in prod) ───────────

/** The narrow data surface the controller needs. Production binds these to
 *  `atlas_communities` / `atlas_subgraph` via invokeAtlasTool; tests supply a
 *  hand-rolled fake (no network). */
export interface Fetcher {
  communities(
    workspace: string,
  ): Promise<{
    communities: Array<{ id: string; label: string; fileCount: number; folder?: string; project?: string; layer?: string; hub?: boolean }>;
    /** Inter-community dependency edges (the architecture map). */
    edges: Array<{ source: string; target: string; weight: number; cyclic?: boolean; violation?: boolean }>;
    /** Coupling-insight overlay (cycles / god-clusters / layer inversions). */
    insights?: CommunityInsights;
  }>;
  subgraph(
    workspace: string,
    opts: {
      center?: string;
      community?: string;
      depth?: number;
      nodeTypes?: string[];
      maxNodes?: number;
    },
  ): Promise<{
    nodes: Array<{
      id: string;
      type: string;
      label: string;
      file?: string;
      cls: string;
      // Sprint 3: optional code_symbol metadata carried through for the
      // inspector's inline code view (atlas_source uses startLine/endLine).
      startLine?: number;
      endLine?: number;
      signature?: string;
      qualifiedName?: string;
    }>;
    edges: Array<{ source: string; target: string; relation: string }>;
    truncated: boolean;
  }>;
  /** Whole-workspace fetch (atlas_fullgraph): every node + induced edges, capped
   *  server-side. Used by the "entire graph" view; the controller lays it out
   *  with the worker ForceAtlas2 (off the main thread). Optional so existing
   *  fakes/tests that only implement communities+subgraph still satisfy the
   *  contract for the drill-down path. */
  fullgraph?(
    workspace: string,
    opts?: { nodeTypes?: string[]; maxNodes?: number },
  ): Promise<{
    nodes: Array<{
      id: string;
      type: string;
      label: string;
      file?: string;
      cls: string;
      startLine?: number;
      endLine?: number;
      signature?: string;
      qualifiedName?: string;
      project?: string;
      community?: string;
    }>;
    edges: Array<{ source: string; target: string; relation: string }>;
    truncated: boolean;
    totalNodes: number;
  }>;
}

// ── Visual mapping (cls → color, level → size) ───────────────────────────────

/** Drill-down class as emitted by `atlas_subgraph` (subgraph.ts:SubgraphNodeClass),
 *  plus the synthetic 'community' class the controller assigns at level 0. */
export type NodeKind = 'community' | 'file' | 'symbol' | 'context' | 'folder' | 'import' | 'knowledge' | 'other';

/**
 * Map a drill-down `NodeKind` onto the schema's `NodeType` taxonomy. This is the
 * single bridge the renderer AND the filter reducer use so a node's color, its
 * legend swatch, and the filter toggle that hides it all agree:
 *   community → architecture (the violet root family), file → code_file,
 *   symbol → code_symbol, context → code_context, knowledge → decision (the
 *   knowledge umbrella), other → code_symbol (neutral fallback).
 *
 * NOTE: `community` is a UI-only synthetic kind; it maps to `architecture`
 * whose schema color (#8b5cf6) is exactly the violet the community root used.
 */
export function kindToNodeType(kind: NodeKind): NodeType {
  switch (kind) {
    case 'community':
      return 'architecture';
    case 'file':
      return 'code_file';
    case 'symbol':
      return 'code_symbol';
    case 'context':
      return 'code_context';
    case 'folder':
      return 'code_folder';
    case 'import':
      return 'code_import';
    case 'knowledge':
      return 'decision';
    default:
      return 'code_symbol';
  }
}

/**
 * Map a subgraph `cls` (or the synthetic 'community') to a color. Sprint 2:
 * reads the SHARED `NODE_TYPE_META` palette via `kindToNodeType`, so the
 * rendered node color == its legend/filter-rail swatch BY CONSTRUCTION (the old
 * hardcoded hexes diverged — e.g. symbol was slate #64748b vs schema teal
 * #14b8a6). community keeps the violet root via the architecture mapping.
 */
export function colorForKind(kind: NodeKind): string {
  return NODE_TYPE_META[kindToNodeType(kind)].color;
}

/** Node size by drill-down level: communities biggest, symbols smallest.
 *  This is the BASELINE size; `degreeSize` nudges it up for well-connected
 *  nodes (Sprint-2 aesthetic: size encodes both hierarchy AND connectivity). */
function sizeForLevel(level: number): number {
  switch (level) {
    case 0:
      return 16; // communities
    case 1:
      return 9; // files
    case 2:
      return 6; // symbols
    default:
      return 5; // deeper neighbors
  }
}

/**
 * Sprint-2 aesthetic — size a node by its DEGREE on top of its level baseline:
 * `base * (1 + log2(1 + degree) * 0.18)`, capped at 1.8×. Flat scaling (no
 * glow/gradient), monotonic in degree, and gentle (log) so a hub doesn't
 * dwarf the ring. Recomputed only for the handful of nodes an expand/focus
 * actually touched (O(touched), not O(graph)).
 */
function degreeSize(base: number, degree: number): number {
  const factor = Math.min(1.8, 1 + Math.log2(1 + Math.max(0, degree)) * 0.18);
  return base * factor;
}

/** Level-0 community node size, scaled by file count (sqrt so a 10× cluster
 *  isn't 10× the disc). Varies enough to read "big vs small area" at a glance. */
function communitySize(fileCount: number): number {
  return 7 + Math.sqrt(Math.max(0, fileCount)) * 1.7;
}

/** Inter-community edge thickness from its dependency weight (cross-cluster
 *  reference count). Log-scaled + clamped so a 400-weight edge is bold but a
 *  2000-weight one doesn't become a bar. */
function communityEdgeWidth(weight: number): number {
  return Math.max(1.2, Math.min(9, 1 + Math.log2(1 + Math.max(0, weight)) * 0.9));
}

/** Human-meaningful community label: the folder it lives in + its distinguishing
 *  token (`src/api · apply`), so same-folder clusters stay distinct and the
 *  cryptic single-token labels (`new`, `apply`) gain structural context. */
function communityLabel(c: { label: string; folder?: string }): string {
  const folder = c.folder && c.folder.trim() ? c.folder.trim() : '';
  if (folder && c.label && !folder.toLowerCase().includes(c.label.toLowerCase())) {
    return `${folder} · ${c.label}`;
  }
  return folder || c.label;
}

/** Whole-graph node sizing — deliberately SMALL + low-variance (graphify-style):
 *  thousands of small dots read as clusters, not a field of giant blobs. Much
 *  flatter than the drill-mode `sizeForLevel` (which has few nodes, so big is
 *  fine). Folders/communities only slightly bigger than symbols. */
function fullBaseSize(level: number): number {
  switch (level) {
    case 0: return 4.5; // folders / community roots
    case 1: return 3.5; // files
    default: return 2.5; // symbols + everything deeper
  }
}

/** Gentle degree bump for the whole-graph view — a hub reads a little bigger but
 *  never dwarfs the field (cap 1.8×, vs the small base ⇒ ~8px max). */
function fullDegreeSize(base: number, degree: number): number {
  const factor = Math.min(1.8, 1 + Math.log2(1 + Math.max(0, degree)) * 0.12);
  return base * factor;
}

/** Resolve a node's paint color for the active color mode. 'type' uses the
 *  schema palette (kind→color); 'project'/'community' hash the category key into
 *  the shared categorical scale (legend swatches use the same fn → they agree). */
function paintColor(mode: ColorMode, kind: NodeKind, project?: string, community?: string): string {
  if (mode === 'project') return colorForKey(project);
  if (mode === 'community') return colorForKey(community);
  return colorForKind(kind);
}

/** Deterministic pseudo-random in [0,1) from an integer seed (no Math.random,
 *  so a given index always seeds the same scatter position → reproducible). */
function pseudo(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Map a NodeKind to a drill "level" baseline used for sizing in the whole-graph
 *  view (which has no parent/child hierarchy to derive level from): folders read
 *  as roots, files mid, symbols/everything-else small. */
function levelForKind(kind: NodeKind): number {
  switch (kind) {
    case 'community':
    case 'folder':
      return 0;
    case 'file':
      return 1;
    default:
      return 2;
  }
}

/** Map a subgraph `cls` string onto our NodeKind union (defensive on unknowns). */
function kindFromCls(cls: string): NodeKind {
  switch (cls) {
    case 'file':
    case 'symbol':
    case 'context':
    case 'folder':
    case 'import':
    case 'knowledge':
      return cls;
    default:
      return 'other';
  }
}

// ── Radial placement geometry ────────────────────────────────────────────────

/** Ring radius per level — children sit on a ring this far from their parent.
 *  Communities (level 0) ring around the origin at a larger radius. */
function ringRadiusForChildLevel(childLevel: number): number {
  switch (childLevel) {
    case 0:
      return 400; // communities around origin
    case 1:
      return 160; // files around a community
    case 2:
      return 90; // symbols around a file
    default:
      return 70;
  }
}

/**
 * Compute a deterministic radial position for a child given its index within
 * the (sorted) sibling group being added, the total in that group, the parent
 * center, and the child level. Angles are evenly spread over the full circle.
 */
function radialPosition(
  index: number,
  count: number,
  parentX: number,
  parentY: number,
  childLevel: number,
): { x: number; y: number } {
  const r = ringRadiusForChildLevel(childLevel);
  // Spread over 2π. Offset by a small phase so a lone child isn't pinned at
  // exactly angle 0 (purely cosmetic, still deterministic).
  const theta = count > 0 ? (index / count) * 2 * Math.PI : 0;
  return {
    x: parentX + r * Math.cos(theta),
    y: parentY + r * Math.sin(theta),
  };
}

// ── Node attribute shape (what the controller writes onto graph nodes) ───────

/** The drill-down attributes the controller maintains on each graph node, in
 *  addition to the Sigma render attrs (x/y/size/color/label). Reading code
 *  (the React reducer, NodeDetail) can rely on these being present. */
export interface DrillAttrs {
  level: number;
  kind: NodeKind;
  /** First parent id (display convenience); '' for level-0 community roots. */
  parentId: string;
  /** All parents this node was reached from (the refcount set). Sorted. */
  parents: string[];
  expanded: boolean;
  childrenLoaded: boolean;
  /** True iff the slice that produced this node's children was truncated. */
  truncatedChildren: boolean;
  /** For community nodes: the content-stable string community id needed to
   *  re-expand (GF-4 — stable across re-index). */
  communityId?: string;
}

const ORIGIN_X = 0;
const ORIGIN_Y = 0;

/** Baseline children-per-expand budget assumed when the first slice used the
 *  server default (no explicit maxNodes). `refine` grows from here so the first
 *  refine asks for a concretely larger set than the (unknown) default. Chosen to
 *  comfortably exceed the typical server default so a refine is always a real
 *  step up. */
const DEFAULT_CHILD_BUDGET = 50;

export class GraphController {
  private readonly graph: Graph;
  private readonly fetcher: Fetcher;
  private readonly workspace: string;

  /**
   * @param graph     the SINGLE graphology instance to mutate (never replaced).
   * @param fetcher   data surface (communities + subgraph).
   * @param workspace Atlas workspace id; scopes every fetch. Two workspaces get
   *                  two controllers over two graphs (multi-workspace isolation).
   */
  constructor(graph: Graph, fetcher: Fetcher, workspace: string) {
    this.graph = graph;
    this.fetcher = fetcher;
    this.workspace = workspace;
  }

  // ── small attr helpers ─────────────────────────────────────────────────────

  private getParents(nodeId: string): string[] {
    if (!this.graph.hasNode(nodeId)) return [];
    return (this.graph.getNodeAttribute(nodeId, 'parents') as string[] | undefined) ?? [];
  }

  private addParent(nodeId: string, parentId: string): void {
    const parents = this.getParents(nodeId);
    if (!parents.includes(parentId)) {
      const next = [...parents, parentId].sort();
      this.graph.setNodeAttribute(nodeId, 'parents', next);
      // Keep the cheap display mirror pointing at the first (sorted) parent.
      this.graph.setNodeAttribute(nodeId, 'parentId', next[0] ?? '');
    }
  }

  isExpanded(nodeId: string): boolean {
    if (!this.graph.hasNode(nodeId)) return false;
    return this.graph.getNodeAttribute(nodeId, 'expanded') === true;
  }

  // ── Level 0: communities ────────────────────────────────────────────────────

  /**
   * Fetch the workspace's communities and add ONE node per community, placed
   * radially around the origin. Idempotent on the community ids it has already
   * added (re-call is a no-op for existing ones). Returns whether the community
   * list itself is empty so the caller can show the empty/no-communities state.
   *
   * NOTE: returns `truncated:false` always for level 0 — `atlas_communities`
   * has no truncation concept; the field exists to keep the return shape
   * uniform with `expand`.
   */
  async loadLevel0(): Promise<{ truncated: boolean; count: number; insights: CommunityInsights | null }> {
    const { communities, edges, insights } = await this.fetcher.communities(this.workspace);
    // Hub styling is applied inline per node below (hub/highlighted attrs from
    // `c.hub`); no separate hub-id lookup is needed here.

    // Deterministic placement: sort by id so the ring is reproducible
    // (string id → lexicographic).
    const sorted = [...communities].sort((a, b) => a.id.localeCompare(b.id));
    const newOnes = sorted.filter((c) => !this.graph.hasNode(communityNodeId(c.id)));

    newOnes.forEach((c, i) => {
      const id = communityNodeId(c.id);
      const { x, y } = radialPosition(i, newOnes.length, ORIGIN_X, ORIGIN_Y, 0);
      this.graph.addNode(id, {
        x,
        y,
        // Size by cluster weight (files), color by owning project — so the map
        // reads as "big/important areas" grouped by codebase.
        size: communitySize(c.fileCount),
        color: c.project ? colorForKey(c.project) : colorForKind('community'),
        label: truncateLabel(communityLabel(c)),
        // drill attrs
        level: 0,
        kind: 'community' as NodeKind,
        parentId: '',
        parents: [] as string[],
        expanded: false,
        childrenLoaded: false,
        truncatedChildren: false,
        communityId: c.id,
        // carried for the detail panel + project recolor
        project: c.project ?? '',
        fileCount: c.fileCount,
        folder: c.folder ?? '',
        layer: c.layer ?? '',
        // A god-cluster reads with a highlighted ring (sigma's hover style) so
        // "everything depends on this" is visible at a glance.
        hub: c.hub === true,
        highlighted: c.hub === true,
      });
    });

    // ── Architecture map: inter-community dependency edges. Thickness ∝ number
    // of cross-cluster references, so the tightly-coupled core reads heavy and
    // isolated clusters have no edges (and drift out under the force layout).
    for (const e of edges) {
      const s = communityNodeId(e.source);
      const t = communityNodeId(e.target);
      if (!this.graph.hasNode(s) || !this.graph.hasNode(t)) continue;
      if (this.graph.hasEdge(s, t)) continue;
      // Coupling-insight coloring: violation (red) > cycle (amber) > normal.
      const color = e.violation ? VIOLATION_EDGE_COLOR
        : e.cyclic ? CYCLE_EDGE_COLOR
        : NORMAL_COMMUNITY_EDGE_COLOR;
      this.graph.addEdge(s, t, {
        relation: 'depends_on',
        weight: e.weight,
        size: communityEdgeWidth(e.weight) * (e.cyclic || e.violation ? 1.3 : 1),
        color,
        // Flag on the edge so the reducer's typed-relation recolor can't override
        // an insight color (it checks this first).
        insight: e.violation ? 'violation' : e.cyclic ? 'cyclic' : '',
      });
    }

    return { truncated: false, count: sorted.length, insights: insights ?? null };
  }

  // ── Whole-graph: load the ENTIRE workspace at once ──────────────────────────

  /**
   * Replace the current (drill-down) view with the WHOLE workspace graph from
   * `atlas_fullgraph`. Every node gets a deterministic seed position on a
   * phyllotaxis spiral (so the initial frame isn't a degenerate ring); the React
   * layer then runs the WORKER ForceAtlas2 to settle real positions OFF the main
   * thread — the only safe way to lay out thousands of nodes without freezing.
   *
   * Nodes are marked `expanded:true, childrenLoaded:true` so a click in full mode
   * never tries to drill (there's nothing deeper to fetch — it's all here). Sizing
   * is degree-driven over a per-kind baseline, identical to the drill path, so a
   * hub reads big in either view.
   *
   * Returns the same shape the fetcher does so the hook can surface truncation
   * ("showing N of M") to the user.
   */
  async loadFullGraph(
    opts?: { maxNodes?: number; colorMode?: ColorMode },
  ): Promise<{ added: number; truncated: boolean; totalNodes: number; projects: string[]; communities: string[] }> {
    if (!this.fetcher.fullgraph) {
      throw new Error('fullgraph fetcher not available');
    }
    const full = await this.fetcher.fullgraph(this.workspace, {
      ...(opts?.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
    });
    const colorMode: ColorMode = opts?.colorMode ?? 'community';

    // Full replace: the whole-graph view is not a superset of the drill state,
    // it's a different picture. Clearing keeps positions/refcounts from the two
    // modes from interleaving.
    this.graph.clear();

    const sorted = [...full.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const n = sorted.length;
    const projects = new Set<string>();
    const communities = new Set<string>();
    // Scatter the seed across a disc (deterministic by index) rather than a tight
    // spiral — FA2 then relaxes it into ORGANIC community clusters (the graphify
    // look) instead of collapsing a concentric ring. Jitter is hash-based so it's
    // reproducible without Math.random.
    sorted.forEach((node, i) => {
      if (this.graph.hasNode(node.id)) return;
      const kind = kindFromCls(node.cls);
      const level = levelForKind(kind);
      if (node.project) projects.add(node.project);
      if (node.community) communities.add(node.community);
      const a = pseudo(i * 2 + 1) * 2 * Math.PI;
      const rad = 600 * Math.sqrt(pseudo(i * 2 + 2));
      this.graph.addNode(node.id, {
        x: rad * Math.cos(a),
        y: rad * Math.sin(a),
        size: fullBaseSize(level),
        color: paintColor(colorMode, kind, node.project, node.community),
        label: truncateLabel(node.label),
        level,
        kind,
        parentId: '',
        parents: [] as string[],
        // Nothing deeper to fetch in full mode — mark loaded so click only selects.
        expanded: true,
        childrenLoaded: true,
        truncatedChildren: false,
        nodeType: node.type,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine,
        signature: node.signature,
        qualifiedName: node.qualifiedName,
        project: node.project ?? '',
        community: node.community ?? '',
      });
    });

    for (const e of full.edges) {
      if (!this.graph.hasNode(e.source) || !this.graph.hasNode(e.target)) continue;
      if (this.graph.hasEdge(e.source, e.target)) continue;
      this.graph.addEdge(e.source, e.target, {
        relation: e.relation,
        color: colorForRelation(e.relation),
      });
    }

    // Degree-size every node now that all edges exist — small base, gentle bump.
    this.graph.forEachNode((id) => {
      const lvl = (this.graph.getNodeAttribute(id, 'level') as number | undefined) ?? 2;
      this.graph.setNodeAttribute(id, 'size', fullDegreeSize(fullBaseSize(lvl), this.graph.degree(id)));
    });

    return {
      added: n,
      truncated: full.truncated === true,
      totalNodes: full.totalNodes,
      projects: [...projects].sort(),
      communities: [...communities].sort(),
    };
  }

  /**
   * Repaint every node by the active color mode (type / project / community)
   * WITHOUT moving anything — a size/color attr pass only, so positions and the
   * no-relayout rule are untouched. Called when the user flips the "Color by"
   * control. O(nodes).
   */
  recolor(mode: ColorMode): void {
    this.graph.forEachNode((id, attrs) => {
      const kind = (attrs['kind'] as NodeKind | undefined) ?? 'other';
      const project = (attrs['project'] as string | undefined) || undefined;
      const community = (attrs['community'] as string | undefined) || undefined;
      this.graph.setNodeAttribute(id, 'color', paintColor(mode, kind, project, community));
    });
  }

  /** Drop everything (used when switching back to drill-down → reload level 0). */
  clear(): void {
    this.graph.clear();
  }

  // ── Expand: drill one level deeper from a node ──────────────────────────────

  /**
   * Expand `nodeId` one level. Idempotent: if the node is already expanded, this
   * is a no-op returning `{ added: 0 }`.
   *
   * Level → query mapping (the slice we ask `atlas_subgraph` for):
   *   - community (level 0) → its files: subgraph({ community, nodeTypes:['code_file'], depth:1 })
   *   - file      (level 1) → its symbols: subgraph({ center:fileId, nodeTypes:['code_symbol'], depth:1 })
   *   - symbol    (level 2) → its neighbors: subgraph({ center:symbolId, depth:1 }) (no type filter)
   *   - anything deeper     → neighbors: subgraph({ center:nodeId, depth:1 })
   *
   * New children are placed RADIALLY around the parent (no global relayout) and
   * each records `nodeId` in its `parents` set. Containment/relation edges
   * returned by the slice are added when BOTH endpoints exist in the graph.
   */
  async expand(
    nodeId: string,
    opts?: { maxNodes?: number; force?: boolean },
  ): Promise<{ added: number; truncated: boolean }> {
    if (!this.graph.hasNode(nodeId)) return { added: 0, truncated: false };
    // Idempotent on a plain expand. `force` (used by refine) re-fetches an
    // already-expanded node with a larger budget to pull in more children.
    if (this.isExpanded(nodeId) && !opts?.force) return { added: 0, truncated: false };

    const level = this.graph.getNodeAttribute(nodeId, 'level') as number;
    const kind = this.graph.getNodeAttribute(nodeId, 'kind') as NodeKind;
    const childLevel = level + 1;

    // Optional explicit node budget (B4 PART 3 "refine": re-query with a higher
    // maxNodes to surface the children the first, truncated slice dropped).
    const maxNodes = opts?.maxNodes;

    // Build the slice request for this node's level.
    let slice: Awaited<ReturnType<Fetcher['subgraph']>>;
    if (kind === 'community') {
      const communityId = this.graph.getNodeAttribute(nodeId, 'communityId') as string;
      slice = await this.fetcher.subgraph(this.workspace, {
        community: communityId,
        nodeTypes: ['code_file'],
        depth: 1,
        ...(maxNodes != null ? { maxNodes } : {}),
      });
    } else if (kind === 'file') {
      slice = await this.fetcher.subgraph(this.workspace, {
        center: nodeId,
        nodeTypes: ['code_symbol'],
        depth: 1,
        ...(maxNodes != null ? { maxNodes } : {}),
      });
    } else {
      // symbol or deeper: pull neighbors, no type filter.
      slice = await this.fetcher.subgraph(this.workspace, {
        center: nodeId,
        depth: 1,
        ...(maxNodes != null ? { maxNodes } : {}),
      });
    }

    // Merge the slice's nodes + induced edges under this parent (radial place,
    // refcount, typed edges). Shared with `focus` so the merge logic is ONE
    // implementation (no drift). Returns how many NEW nodes were added.
    const added = this.mergeSlice(nodeId, slice, childLevel);

    // Mark the parent expanded + record truncation so the viewer can show an
    // "N more — refine" affordance on this node.
    this.graph.setNodeAttribute(nodeId, 'expanded', true);
    this.graph.setNodeAttribute(nodeId, 'childrenLoaded', true);
    this.graph.setNodeAttribute(nodeId, 'truncatedChildren', slice.truncated === true);
    // Record the budget that produced this slice so a later refine grows from
    // it. Undefined maxNodes means the server default was used; persist null so
    // refine starts from DEFAULT_CHILD_BUDGET.
    if (maxNodes != null) this.graph.setNodeAttribute(nodeId, 'childBudget', maxNodes);

    return { added, truncated: slice.truncated === true };
  }

  /**
   * Merge a fetched `slice` under `parentId`: radially place every NEW node on
   * the `childLevel` ring around the parent, refcount nodes already present
   * (record `parentId` in their `parents` set), and add the induced typed edges.
   *
   * This is the ONE merge implementation shared by `expand` and `focus` (the
   * Sprint-2 `focus(nodeId, depth)` neighborhood load reuses the exact same
   * radial-placement + refcount + typed-edge path, so the two can't drift).
   * The center seed (a node whose id === parentId) is filtered out. Children are
   * sorted by id first → deterministic, reproducible placement. Returns the
   * count of newly-added nodes.
   */
  private mergeSlice(
    parentId: string,
    slice: Awaited<ReturnType<Fetcher['subgraph']>>,
    childLevel: number,
  ): number {
    const parentX = this.graph.getNodeAttribute(parentId, 'x') as number;
    const parentY = this.graph.getNodeAttribute(parentId, 'y') as number;

    // Children = returned nodes that are NOT the parent itself. The center seed
    // comes back in the node list for center-based slices; exclude it.
    // Deterministic order so radial placement is reproducible.
    const childNodes = slice.nodes
      .filter((n) => n.id !== parentId)
      .sort((a, b) => a.id.localeCompare(b.id));

    let added = 0;
    childNodes.forEach((n, i) => {
      const childKind = kindFromCls(n.cls);
      if (!this.graph.hasNode(n.id)) {
        const { x, y } = radialPosition(i, childNodes.length, parentX, parentY, childLevel);
        this.graph.addNode(n.id, {
          x,
          y,
          size: sizeForLevel(childLevel),
          color: colorForKind(childKind),
          label: truncateLabel(n.label),
          level: childLevel,
          kind: childKind,
          parentId,
          parents: [parentId],
          expanded: false,
          childrenLoaded: false,
          truncatedChildren: false,
          // carry source type/file through for NodeDetail / search / filtering
          nodeType: n.type,
          file: n.file,
          // Sprint 3: carry symbol metadata so NodeDetail's code view can
          // request the right slice via atlas_source.
          startLine: n.startLine,
          endLine: n.endLine,
          signature: n.signature,
          qualifiedName: n.qualifiedName,
        });
        added += 1;
      } else {
        // Already present (shared child from another expanded parent, or the
        // graph already held it). Record this parent in its refcount set so it
        // survives until BOTH parents collapse.
        this.addParent(n.id, parentId);
      }
    });

    // Add edges whose BOTH endpoints exist (induced set). Guard hasEdge so a
    // re-expand or a shared edge doesn't throw on a duplicate. Sprint 2: paint
    // the edge by its typed relation hue (EDGE_TYPE_META) so the typed graph is
    // legible; the `relation` attr remains the source of truth for filtering.
    const touched = new Set<string>([parentId]);
    for (const e of slice.edges) {
      if (!this.graph.hasNode(e.source) || !this.graph.hasNode(e.target)) continue;
      if (this.graph.hasEdge(e.source, e.target)) continue;
      this.graph.addEdge(e.source, e.target, {
        relation: e.relation,
        color: colorForRelation(e.relation),
      });
      touched.add(e.source);
      touched.add(e.target);
    }
    for (const n of childNodes) touched.add(n.id);

    // Sprint-2 aesthetic: re-size only the touched nodes by their NEW degree on
    // top of their level baseline (hubs read bigger). O(touched), and never
    // moves a node — purely a size attr update, so the no-relayout rule holds.
    for (const id of touched) {
      if (!this.graph.hasNode(id)) continue;
      const lvl = (this.graph.getNodeAttribute(id, 'level') as number | undefined) ?? 3;
      const deg = this.graph.degree(id);
      this.graph.setNodeAttribute(id, 'size', degreeSize(sizeForLevel(lvl), deg));
    }

    return added;
  }

  /**
   * Sprint 2 — FOCUS a node's neighborhood to `depth` BFS hops.
   *
   * Wraps `atlas_subgraph({ center: nodeId, depth })` and merges the returned
   * slice via the SAME `mergeSlice` path `expand` uses (radial placement, no
   * whole-graph relayout, refcount-safe). Unlike `expand`, focus does NOT
   * type-filter the slice — it shows the full neighborhood; hiding by type is
   * the render reducer's job. It also does NOT mark the node `expanded` (focus
   * is a transient "show only this neighborhood" view, not a drill step), so a
   * later collapse/expand still behaves normally.
   *
   * Returns the `focusSet` — the exact id set the caller constrains visibility
   * to (the seed + every node the slice returned). Visibility itself is a render
   * concern: the React layer feeds `focusSet` to the shared reducer, which HIDES
   * non-members (same precedence tier as the type filter). "Reset to All" is
   * just clearing that set — focus never deletes nodes, so nothing is lost.
   *
   * `depth` is the BFS hop cap (atlas_subgraph semantics): 1 = immediate
   * neighbors, 2 = two hops (default), etc. `maxNodes` clamps the slice.
   */
  async focus(
    nodeId: string,
    depth = 2,
    opts?: { maxNodes?: number },
  ): Promise<{ added: number; truncated: boolean; focusSet: string[] }> {
    if (!this.graph.hasNode(nodeId)) {
      return { added: 0, truncated: false, focusSet: [] };
    }

    const slice = await this.fetcher.subgraph(this.workspace, {
      center: nodeId,
      depth,
      ...(opts?.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
    });

    const seedLevel = this.graph.getNodeAttribute(nodeId, 'level') as number;
    // Focus children ride one ring out from the seed; reuse the level geometry.
    const added = this.mergeSlice(nodeId, slice, (seedLevel ?? 0) + 1);

    // The focus set is the seed plus every returned node (whether newly added or
    // already present), so the reducer can constrain visibility to exactly this
    // neighborhood.
    const focusSet = [nodeId, ...slice.nodes.map((n) => n.id)];
    // De-dup (seed may be echoed back in the node list).
    const unique = Array.from(new Set(focusSet));

    return { added, truncated: slice.truncated === true, focusSet: unique };
  }

  /**
   * B4 PART 3 — refine a TRUNCATED expansion: re-query this node's children with
   * a LARGER node budget (default 2× the budget that produced the current,
   * truncated slice) so the dropped children appear. Only meaningful on a node
   * whose `truncatedChildren` is true; on a non-truncated/never-expanded node it
   * still works as a force re-expand but normally won't add anything.
   *
   * New children are merged in by the same `expand` path (it skips nodes already
   * present and only adds the newly-returned ones), so positions of existing
   * children are untouched — consistent with the no-whole-graph-relayout rule.
   * Returns the new truncation flag so the viewer can hide the affordance once
   * everything fits.
   */
  async refine(
    nodeId: string,
    factor = 2,
  ): Promise<{ added: number; truncated: boolean }> {
    if (!this.graph.hasNode(nodeId)) return { added: 0, truncated: false };
    const prev =
      (this.graph.getNodeAttribute(nodeId, 'childBudget') as number | undefined) ??
      DEFAULT_CHILD_BUDGET;
    const nextBudget = Math.max(DEFAULT_CHILD_BUDGET + 1, Math.ceil(prev * factor));
    return this.expand(nodeId, { maxNodes: nextBudget, force: true });
  }

  // ── Collapse: drop the parent's descendant subtree (refcounted) ─────────────

  /**
   * Collapse `nodeId`: remove the descendant subtree that was added under it,
   * EXCEPT nodes still referenced by another expanded parent (refcount via the
   * `parents` set). The parent node itself stays; only its descendants are
   * dropped. Marks the parent collapsed.
   *
   * Algorithm: BFS from the parent's direct children downward. For each
   * candidate descendant, remove `nodeId` (or the intermediate ancestor being
   * collapsed) from its parent set; drop it ONLY when its parent set becomes
   * empty. Because we descend through nodes we actually drop, a node co-owned by
   * an unrelated expanded parent keeps a non-empty parent set and survives.
   */
  collapse(nodeId: string): { removed: number } {
    if (!this.graph.hasNode(nodeId)) return { removed: 0 };

    let removed = 0;
    // Sprint-2 size fix: dropping a node also drops its incident edges, which
    // lowers the degree of every surviving neighbor (and of the collapsed parent,
    // which loses edges to its dropped children). mergeSlice only re-sizes on
    // ADD, so without this a hub keeps an inflated size reflecting edges that no
    // longer exist. Collect the survivors to re-size — seeded with the collapsed
    // parent, then every neighbor of a dropped node.
    const resizeCandidates = new Set<string>([nodeId]);
    // Frontier holds [childId, viaParentId] — the parent edge we are retracting.
    const queue: Array<{ id: string; via: string }> = this.directChildren(nodeId).map((id) => ({
      id,
      via: nodeId,
    }));
    const seen = new Set<string>();

    while (queue.length > 0) {
      const { id, via } = queue.shift()!;
      if (!this.graph.hasNode(id)) continue;

      const parentsBefore = this.getParents(id);
      // Retract the edge from `via`. If other parents remain, this node stays
      // (shared with another expanded parent) — do NOT descend into it, its
      // surviving parent still owns its subtree.
      const parentsAfter = parentsBefore.filter((p) => p !== via);

      if (parentsAfter.length > 0) {
        this.graph.setNodeAttribute(id, 'parents', parentsAfter);
        this.graph.setNodeAttribute(id, 'parentId', parentsAfter[0] ?? '');
        continue;
      }

      // Last parent retracted → this node is going away. First descend to its
      // own children (retracting the edge from THIS node), then drop it.
      if (!seen.has(id)) {
        seen.add(id);
        for (const grandchild of this.directChildren(id)) {
          queue.push({ id: grandchild, via: id });
        }
      }
      // Record surviving neighbors BEFORE dropping — dropNode removes all incident
      // edges, so each of these loses a degree and needs a re-size.
      for (const nb of this.graph.neighbors(id)) resizeCandidates.add(nb);
      // dropNode also drops all incident edges in graphology.
      this.graph.dropNode(id);
      removed += 1;
    }

    // Re-size every survivor whose degree changed, using the SAME formula
    // mergeSlice applies (degreeSize over the level baseline). Skip candidates
    // that were themselves dropped. O(touched), size-only (never moves a node), so
    // the no-whole-graph-relayout rule still holds.
    for (const id of resizeCandidates) {
      if (!this.graph.hasNode(id)) continue;
      const lvl = (this.graph.getNodeAttribute(id, 'level') as number | undefined) ?? 3;
      this.graph.setNodeAttribute(id, 'size', degreeSize(sizeForLevel(lvl), this.graph.degree(id)));
    }

    this.graph.setNodeAttribute(nodeId, 'expanded', false);
    return { removed };
  }

  /** Direct children of `nodeId` = nodes whose `parents` set includes it. */
  private directChildren(nodeId: string): string[] {
    const out: string[] = [];
    this.graph.forEachNode((id) => {
      if (id === nodeId) return;
      const parents = (this.graph.getNodeAttribute(id, 'parents') as string[] | undefined) ?? [];
      if (parents.includes(nodeId)) out.push(id);
    });
    return out.sort();
  }
}

// ── id + label helpers ────────────────────────────────────────────────────────

/** Synthetic graph-node id for a community. The community id is itself a
 *  content-stable string (GF-4, e.g. "locale~format"); the `community:` prefix
 *  keeps it from colliding with real code-file:/code-symbol: ids. */
export function communityNodeId(communityId: string): string {
  return `community:${communityId}`;
}

/** Trim long labels for the renderer (mirrors the legacy buildGraph behavior). */
function truncateLabel(label: string): string {
  return label.length > 30 ? `${label.slice(0, 28)}…` : label;
}
