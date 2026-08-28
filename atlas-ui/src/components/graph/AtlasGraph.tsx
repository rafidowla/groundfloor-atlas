/**
 * AtlasGraph.tsx — B2: the Sigma shell, now driven by a live mutated graph.
 *
 * PRESERVED from B1: SigmaContainer config, the GraphLoader/GraphLayout/
 * GraphEventHandler/GraphSearchHighlighter component split, the nodeReducer
 * search-highlight path, and the hover/select wiring.
 *
 * CHANGED for B2:
 *  - The graph is a SINGLE stable instance owned by useGraphData. GraphLoader
 *    loads it ONCE (on the graph identity, which only changes on workspace
 *    switch). Expansion no longer swaps the graph — it mutates it in place.
 *  - GraphLayout runs ForceAtlas2 ONCE, on the initial level-0 mount, to spread
 *    the community ring. It DELIBERATELY does NOT re-run on expand: new children
 *    are radially placed by the controller, so a global relayout (synchronous,
 *    main-thread, 200 iterations over thousands of nodes) — the freeze risk — is
 *    avoided. See GraphController's "no-whole-graph-relayout" note.
 *  - clickNode is now a TOGGLE: clicking an expandable node expands it (or
 *    collapses it if already expanded) via the controller, then calls
 *    sigma.refresh() (NOT a relayout). It always also selects the node.
 *  - GraphSearchHighlighter reads labels straight off the live graph (the old
 *    `nodes: GraphNode[]` snapshot is gone) and also dims the collapsed/dimmed
 *    set in the same single reducer (single-slot constraint).
 */

import { useCallback, useEffect, useRef } from 'react';
import { SigmaContainer, useRegisterEvents, useSigma } from '@react-sigma/core';
import { useLayoutForceAtlas2, useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import { GraphController } from '../../graph/GraphController';
import { isNodeFilteredOut, isEdgeFilteredOut } from '../../graph/filterPredicates';
import { selectDimChannel } from '../../graph/dimChannel';
import { EDGE_TYPE_META, NODE_TYPES } from '@atlas-schema';
// UX-truth site #1: node expand/collapse previously swallowed every error —
// `handleNodeClick` below did `.catch(() => onMutate())`, so a daemon-down or
// tool-level failure produced ZERO user feedback (the node just silently
// failed to open). `classifyExpandError` is the pure decision function
// (mirrors `classifyLoadError` in useGraphData.ts) that turns a caught
// rejection into a distinct, human-readable classification the caller can
// render. It lives in its own module (not inline here) so it's unit-testable
// without importing sigma (which needs a WebGL-capable environment this
// jsdom-free test suite doesn't provide). Re-exported for existing callers.
import { classifyExpandError, type ExpandErrorClassification } from '../../graph/expandError';
export type { ExpandErrorClassification };
export { classifyExpandError };

/** Dim paint applied to soft-de-emphasized (search/semantic/citation) nodes. */
const DIM_COLOR = '#1f2937';
const HIDDEN_EDGE_COLOR = '#1f2937';

// ── No GraphLoader, by design ────────────────────────────────────────────────
//
// Sigma is handed the controller's LIVE graph instance via SigmaContainer's
// `graph={graph}` prop, so `sigma.getGraph()` IS that instance — the controller's
// in-place mutations (expand/collapse) are visible to Sigma with no re-import,
// and GraphRefresher just calls sigma.refresh().
//
// DO NOT re-add a `useLoadGraph()(graph)` loader here. Because sigma's graph
// already IS `graph`, loadGraph degenerates to `sigma.getGraph().clear()` followed
// by importing the now-empty graph into itself — it WIPES the data and the graph
// renders blank with the chrome still showing "N nodes in view". Verified in a
// real browser: with the loader present, `graph.order` went 5→0 the instant
// loadGraph ran; removing it made all 5 community nodes paint.

// ── Layout: ForceAtlas2 ONCE, after the level-0 communities load ─────────────

function GraphLayout({ version }: { version: number }) {
  // v5: synchronous layout — assign() runs N iterations then stops. We run it
  // EXACTLY ONCE, the first time the graph is non-empty (the level-0 community
  // ring), to spread the seed nodes. It DELIBERATELY never re-runs on expand:
  // expand children are radially placed by the controller, so a whole-graph
  // FA2 pass (synchronous, main-thread, 200 iters over thousands of nodes) —
  // the freeze risk — never happens during drill-down. `version` is only a
  // trigger to re-check graph.order after the async load resolves.
  const sigma = useSigma();
  const didRun = useRef(false);
  const { assign } = useLayoutForceAtlas2({
    // High repulsion + adjustSizes so the tightly-coupled community clique
    // spreads into distinct, non-overlapping nodes (with the dependency edges
    // visible BETWEEN them) instead of collapsing into one blob. Isolated
    // communities drift to the periphery under gravity — showing separability.
    iterations: 300,
    settings: { gravity: 0.9, scalingRatio: 40, slowDown: 4, adjustSizes: true },
  });
  useEffect(() => {
    if (didRun.current) return;
    if (sigma.getGraph().order === 0) return;
    didRun.current = true;
    assign();
    // Bug #6: fit the camera to the laid-out nodes. With allowInvalidContainer
    // the first paint can be 0-width, so Sigma's auto-fit was computed against a
    // degenerate viewport and the nodes sit off-screen. Reset now AND on each
    // resize so the fit is redone once the container has real dimensions.
    const fit = (): void => {
      try {
        sigma.resize(); // re-measure the container (it was 0/1-width at init)
        sigma.refresh();
        // Center the camera with a little margin so the outermost community ring
        // (level-0 seeds at a fixed radius) isn't flush against the viewport edge.
        // Direct setState — animatedReset is async and would clobber this.
        sigma.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1.25 });
      } catch {
        /* sigma not ready */
      }
    };
    fit();
    const timers = [80, 250, 600].map((d) => setTimeout(fit, d));
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [version, sigma, assign]);
  return null;
}

// ── Full-graph layout: ForceAtlas2 in a WEB WORKER (off the main thread) ─────
//
// The whole-workspace view can hold thousands of nodes. The synchronous assign()
// GraphLayout uses (200 iterations on the main thread) would freeze the UI at
// that scale — the exact freeze the drill path avoids by NOT relaying out. So in
// full mode we run FA2 in a worker: it streams positions into the live graph and
// Sigma repaints each frame, the page stays responsive, and we stop it after a
// settle window so it doesn't spin forever. `active` gates it to full mode; it
// re-runs whenever `version` bumps (a fresh full-graph load).
function FullGraphLayout({ active, version }: { active: boolean; version: number }) {
  const sigma = useSigma();
  const { start, stop, kill } = useWorkerLayoutForceAtlas2({
    // LinLog mode + outbound-attraction-distribution pulls connected nodes into
    // tight, well-separated clusters (the graphify look) instead of one dense
    // ball. barnesHut keeps it fast at thousands of nodes; adjustSizes stops big
    // hubs from overlapping their neighbors.
    settings: {
      gravity: 1,
      scalingRatio: 10,
      slowDown: 7,
      barnesHutOptimize: true,
      linLogMode: true,
      outboundAttractionDistribution: true,
    },
  });
  useEffect(() => {
    if (!active) return;
    if (sigma.getGraph().order === 0) return;
    start();
    // Fit the camera once the worker has nudged the first frame.
    const fitTimers = [120, 500, 1500].map((d) =>
      setTimeout(() => {
        try {
          sigma.resize();
          sigma.getCamera().animatedReset({ duration: 300 });
        } catch { /* sigma not ready */ }
      }, d),
    );
    // Stop after a settle window — LinLog FA2 needs longer to converge into
    // clusters; a perpetually-running worker then just burns CPU and jitters.
    const stopTimer = setTimeout(() => stop(), 8000);
    return () => {
      fitTimers.forEach(clearTimeout);
      clearTimeout(stopTimer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, version, sigma]);
  // Kill the worker entirely on unmount (mode switch / navigation).
  useEffect(() => () => { try { kill(); } catch { /* already gone */ } }, [kill]);
  return null;
}

// ── Refresh bridge: re-render Sigma when the controller mutates the graph ────

function GraphRefresher({ version }: { version: number }) {
  const sigma = useSigma();
  useEffect(() => {
    // The controller mutated the graph in place (added/dropped nodes/edges);
    // tell Sigma to re-render. No relayout — positions are already set.
    sigma.refresh();
  }, [version, sigma]);
  return null;
}

// ── Resizer: re-measure the canvas when the right-rail layout changes ────────
//
// NodeDetail / Chat are flex siblings, so the graph column shrinks when they
// open — but Sigma sizes its <canvas> in explicit pixels and only re-measures on
// its own ResizeObserver, which lags the flex reflow. The stale (too-wide)
// canvas then bleeds UNDER the panels (nodes rendered behind the detail panel).
// Bumping `signal` on every panel toggle forces a re-measure once the flex
// settles, so the canvas matches its container and never draws under a panel.
function GraphResizer({ signal }: { signal: number }) {
  const sigma = useSigma();
  useEffect(() => {
    const timers = [50, 200].map((d) =>
      setTimeout(() => {
        try { sigma.resize(); sigma.refresh(); } catch { /* not ready */ }
      }, d),
    );
    return () => timers.forEach(clearTimeout);
  }, [signal, sigma]);
  return null;
}

// ── Dragger: move a node by dragging it (the standard Sigma drag recipe) ─────
//
// downNode starts a drag; mousemovebody updates the node's x/y from the cursor
// and suppresses the camera pan (preventSigmaDefault) so the node follows the
// mouse instead of the whole view panning; mouseup ends it. A genuine click (no
// movement) still fires clickNode → select, so drag and select coexist.
function GraphDragger() {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const dragged = useRef<string | null>(null);
  useEffect(() => {
    registerEvents({
      downNode: ({ node }: { node: string }) => {
        dragged.current = node;
        sigma.getGraph().setNodeAttribute(node, 'highlighted', true);
      },
      mousemovebody: (e: {
        x: number; y: number;
        preventSigmaDefault: () => void;
        original: { preventDefault: () => void; stopPropagation: () => void };
      }) => {
        if (!dragged.current) return;
        const pos = sigma.viewportToGraph(e);
        const g = sigma.getGraph();
        g.setNodeAttribute(dragged.current, 'x', pos.x);
        g.setNodeAttribute(dragged.current, 'y', pos.y);
        // Stop the camera from panning while a node is being dragged.
        e.preventSigmaDefault();
        e.original.preventDefault();
        e.original.stopPropagation();
      },
      mouseup: () => {
        if (dragged.current) {
          sigma.getGraph().removeNodeAttribute(dragged.current, 'highlighted');
        }
        dragged.current = null;
      },
    });
  }, [registerEvents, sigma]);
  return null;
}

// ── Events: hover + click-to-toggle-expand / select ──────────────────────────

function GraphEventHandler({
  onNodeClick,
  onNodeHover,
  onNodeLeave,
}: {
  onNodeClick: (id: string) => void;
  onNodeHover: (id: string) => void;
  onNodeLeave: () => void;
}) {
  const registerEvents = useRegisterEvents();
  useEffect(() => {
    registerEvents({
      clickNode({ node }: { node: string }) { onNodeClick(node); },
      enterNode({ node }: { node: string }) { onNodeHover(node); },
      leaveNode() { onNodeLeave(); },
    });
  }, [registerEvents, onNodeClick, onNodeHover, onNodeLeave]);
  return null;
}

// ── GraphSearchHighlighter (dims non-matching nodes) — reads the live graph ──
//
// SINGLE-SLOT CONSTRAINT: Sigma exposes ONE nodeReducer + ONE edgeReducer slot.
// B4 adds a second highlight source (chat citations) alongside the existing
// search highlight, so both must share this one reducer. We reconcile them by
// priority: an ACTIVE search query (an explicit user action) wins; otherwise we
// fall back to the citation highlight. The DIM mechanism is IDENTICAL for both
// (the B4 requirement to "reuse the GraphSearchHighlighter pattern"): matching
// nodes keep full color and get a size bump + zIndex:1; everything else is
// painted '#1f2937', label cleared, zIndex:0, and edges hidden. A cited id that
// isn't currently loaded in the graph just never appears in `matchingIds`, so
// it is silently skipped (no error).
function GraphSearchHighlighter({
  searchQuery,
  semanticHits,
  citedIds,
  activeNodeTypes,
  activeEdgeTypes,
  focusSet,
  activeProjects,
  allProjectCount,
}: {
  searchQuery: string;
  semanticHits: readonly string[];
  citedIds: readonly string[];
  activeNodeTypes: ReadonlySet<string>;
  activeEdgeTypes: ReadonlySet<string>;
  focusSet?: readonly string[];
  activeProjects?: ReadonlySet<string>;
  allProjectCount?: number;
}) {
  const sigma = useSigma();

  // Order-independent keys so the effect re-runs when a SET's CONTENT changes,
  // not on every array/Set identity churn.
  const citedKey = [...citedIds].sort().join(' ');
  const semanticKey = [...semanticHits].sort().join(' ');
  const focusKey = focusSet ? [...focusSet].sort().join(' ') : '';
  const nodeTypeKey = [...activeNodeTypes].sort().join(' ');
  const edgeTypeKey = [...activeEdgeTypes].sort().join(' ');
  const projectKey = activeProjects ? [...activeProjects].sort().join(' ') : '';

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    const graph = sigma.getGraph();

    // -- Hard-filter inputs --------------------------------------------------
    const focusActive = focusSet != null && focusSet.length > 0;
    const focus = focusActive ? new Set(focusSet) : null;
    const allTypesActive = activeNodeTypes.size >= NODE_TYPE_COUNT;
    const allEdgesActive = activeEdgeTypes.size >= EDGE_TYPE_COUNT;
    // Project filter is active only when a strict subset is selected.
    const projectFilterActive =
      activeProjects != null &&
      typeof allProjectCount === 'number' &&
      allProjectCount > 0 &&
      activeProjects.size < allProjectCount;

    // A node is hard-hidden iff outside the focus set, its type is deselected,
    // OR (project filter active) its project is deselected. The first two
    // delegate to the PURE, unit-tested predicate; the project clause is layered
    // on for the whole-graph view.
    const isNodeHidden = (id: string, data: Record<string, unknown>): boolean => {
      if (isNodeFilteredOut(id, data, { focusSet: focus, activeNodeTypes, allTypesActive })) return true;
      if (projectFilterActive) {
        const proj = data['project'] != null ? String(data['project']) : '';
        if (proj && !activeProjects!.has(proj)) return true;
      }
      return false;
    };

    // -- Soft-dim inputs (semantic > search > citation — see dimChannel.ts) --
    let dimMatches: Set<string> | null = null;
    const dimChannel = selectDimChannel({ query: q, semanticHits, citedIds });
    if (dimChannel === 'semantic') {
      const hits = new Set(semanticHits);
      dimMatches = new Set<string>();
      graph.forEachNode((id, attrs) => {
        const file = attrs['file'] != null ? String(attrs['file']) : '';
        if (hits.has(id) || (file && hits.has(file))) dimMatches!.add(id);
      });
      if (dimMatches.size === 0) dimMatches = null; // none loaded -> no dim
    } else if (dimChannel === 'query') {
      dimMatches = new Set<string>();
      graph.forEachNode((id, attrs) => {
        const label = String(attrs['label'] ?? '').toLowerCase();
        if (label.includes(q) || id.toLowerCase().includes(q)) dimMatches!.add(id);
      });
    } else if (dimChannel === 'citation') {
      const cited = new Set(citedIds);
      dimMatches = new Set<string>();
      graph.forEachNode((id, attrs) => {
        const file = attrs['file'] != null ? String(attrs['file']) : '';
        if (cited.has(id) || (file && cited.has(file))) dimMatches!.add(id);
      });
      if (dimMatches.size === 0) dimMatches = null;
    }

    const anyHardFilter = focusActive || !allTypesActive || !allEdgesActive || projectFilterActive;
    const anyDim = dimMatches != null;

    // Nothing constrains the view -> clear both reducers (full graph, cheapest).
    if (!anyHardFilter && !anyDim) {
      sigma.setSetting('nodeReducer', null);
      sigma.setSetting('edgeReducer', null);
      sigma.refresh();
      return;
    }

    const dim = dimMatches;
    sigma.setSetting('nodeReducer', (node: string, data: Record<string, unknown>) => {
      // 1-2. HARD hide by focus / type filter -- wins over everything.
      if (isNodeHidden(node, data)) {
        return { ...data, hidden: true };
      }
      // 3-5. SOFT dim by search / semantic / citation.
      if (dim) {
        if (dim.has(node)) {
          return { ...data, size: (data['size'] as number ?? 6) * 1.3, zIndex: 1 };
        }
        return { ...data, color: DIM_COLOR, label: '', zIndex: 0 };
      }
      // 6. Visible, unfiltered, no active dim layer -> untouched.
      return data;
    });

    sigma.setSetting('edgeReducer', (edge: string, data: Record<string, unknown>) => {
      const relation = data['relation'] != null ? String(data['relation']) : '';
      // 1. HARD hide by relation filter (pure, unit-tested predicate).
      if (isEdgeFilteredOut(relation, { activeEdgeTypes, allEdgesActive })) {
        return { ...data, hidden: true };
      }
      // 2. HARD hide if either endpoint is filter-hidden (focus/type).
      if (anyHardFilter) {
        const s = graph.source(edge);
        const t = graph.target(edge);
        if (
          isNodeHidden(s, graph.getNodeAttributes(s) as Record<string, unknown>) ||
          isNodeHidden(t, graph.getNodeAttributes(t) as Record<string, unknown>)
        ) {
          return { ...data, hidden: true };
        }
      }
      // 3. While a dim layer is active, hide edges (legacy highlight behavior).
      if (anyDim) {
        return { ...data, color: HIDDEN_EDGE_COLOR, hidden: true };
      }
      // 4. Coupling-insight edges (cycle amber / violation red) keep their color
      //    — the insight overlay wins over the generic typed-relation hue.
      if (data['insight']) return data;
      // 5. Visible -> typed-relation hue.
      const color = (EDGE_TYPE_META as Record<string, { color: string }>)[relation]?.color;
      return color ? { ...data, color } : data;
    });

    sigma.refresh();
  }, [
    searchQuery,
    semanticKey,
    semanticHits,
    citedKey,
    citedIds,
    focusKey,
    focusSet,
    nodeTypeKey,
    activeNodeTypes,
    edgeTypeKey,
    activeEdgeTypes,
    projectKey,
    activeProjects,
    allProjectCount,
    sigma,
  ]);

  return null;
}

// Total counts of the canonical vocab -- used to detect "all selected" (the
// no-filter early-out). DERIVED from the schema: this used to be a hardcoded 8,
// and when the schema grew to 10 types (GF-3 added code_folder/code_import)
// the stale threshold let a user uncheck 1-2 types with NOTHING being filtered
// (activeNodeTypes.size >= 8 stayed true) — the rail showed the deselection
// while those nodes kept rendering.
const NODE_TYPE_COUNT = NODE_TYPES.length;
const EDGE_TYPE_COUNT = Object.keys(EDGE_TYPE_META).length;

// ── Public component ──────────────────────────────────────────────────────────

interface AtlasGraphProps {
  graph: Graph;
  controller: GraphController;
  /** Bumped by the hook on each controller mutation; also re-run after expand. */
  version: number;
  /** Notify the hook a mutation happened so it bumps `version` → refresh. */
  onMutate: () => void;
  searchQuery?: string;
  /** B4: cited node ids / file paths to highlight (from the chat citation store). */
  citedIds?: readonly string[];
  /** Sprint 2: semantic-search hit ids/paths (knowledge_search → deriveCitations). */
  semanticHits?: readonly string[];
  /** Sprint 2: selected schema node types — nodes whose type is NOT here are HIDDEN. */
  activeNodeTypes: ReadonlySet<string>;
  /** Sprint 2: selected edge relations — edges whose relation is NOT here are HIDDEN. */
  activeEdgeTypes: ReadonlySet<string>;
  /** Sprint 2: focus neighborhood id set — when present, non-members are HIDDEN. */
  focusSet?: readonly string[];
  /** Fires on every node click with the clicked node id (for the detail panel). */
  onNodeSelect: (nodeId: string | null) => void;
  /** UX-truth: fires when an expand/collapse fails, so the page can surface a
   *  visible error instead of the click silently doing nothing. Optional so
   *  existing callers/tests that don't care about this still compile. */
  onExpandError?: (classification: ExpandErrorClassification) => void;
  /** 'drill' = lazy community→file→symbol (click expands); 'full' = whole graph
   *  loaded at once (worker layout; click only selects, nothing deeper to fetch). */
  mode?: 'drill' | 'full';
  /** Whole-graph project filter: nodes whose `project` is NOT in this set are
   *  hidden. Undefined = no project filtering (drill mode / all selected). */
  activeProjects?: ReadonlySet<string>;
  /** Total project count — a filter is "active" only when fewer are selected. */
  allProjectCount?: number;
  /** Bumped whenever the right-rail panel layout changes (node detail / chat
   *  open/close) so the canvas re-measures and never draws under a panel. */
  resizeSignal?: number;
}

export default function AtlasGraph({
  graph,
  controller,
  version,
  onMutate,
  searchQuery = '',
  citedIds = [],
  semanticHits = [],
  activeNodeTypes,
  activeEdgeTypes,
  focusSet,
  onNodeSelect,
  onExpandError,
  mode = 'drill',
  activeProjects,
  allProjectCount,
  resizeSignal = 0,
}: AtlasGraphProps) {
  const handleNodeClick = useCallback(
    (id: string) => {
      if (!graph.hasNode(id)) {
        onNodeSelect(null);
        return;
      }
      // Always surface the node in the detail panel.
      onNodeSelect(id);

      // Full mode: the whole graph is already loaded — clicking only selects,
      // there's nothing deeper to drill into.
      if (mode === 'full') return;

      const expandable = graph.getNodeAttribute(id, 'kind') !== 'other';
      if (!expandable) return;

      // Toggle: collapse if expanded, else expand. Both mutate the SAME graph
      // instance in place; we then bump version → GraphRefresher.refresh().
      // No relayout — controller already positioned the children radially.
      const run = controller.isExpanded(id)
        ? Promise.resolve(controller.collapse(id))
        : controller.expand(id);
      Promise.resolve(run)
        .then(() => onMutate())
        .catch((e: unknown) => {
          // UX-truth fix: previously this catch was `.catch(() => onMutate())`
          // — a daemon-down or tool-level failure produced ZERO feedback, the
          // click just silently did nothing. Still bump version (a partial
          // mutation may have been recorded before the throw), but ALSO
          // surface the classified error so the page can show a toast/banner.
          onMutate();
          onExpandError?.(classifyExpandError(e));
        });
    },
    [graph, controller, onNodeSelect, onMutate, onExpandError, mode],
  );

  const handleNodeHover = useCallback(() => {
    document.body.style.cursor = 'pointer';
  }, []);

  const handleNodeLeave = useCallback(() => {
    document.body.style.cursor = 'default';
  }, []);

  return (
    <SigmaContainer
      graph={graph}
      style={{ width: '100%', height: '100%', background: 'transparent' }}
      settings={{
        // Bug #6: the flex graph container can be momentarily 0-width when
        // SigmaContainer mounts (layout not settled / hidden tab / headless
        // render); Sigma otherwise THROWS "Container has no width" and, with no
        // boundary, blanks the app. Tolerate it — Sigma renders once the
        // ResizeObserver reports a real size.
        allowInvalidContainer: true,
        renderEdgeLabels: false,
        defaultEdgeColor: '#2a2f3a',
        defaultNodeColor: '#6b7280',
        labelColor: { color: '#cbd5e1' },
        labelSize: 12,
        labelWeight: '500',
        labelFont: 'Inter, ui-sans-serif, system-ui, sans-serif',
        minCameraRatio: 0.05,
        maxCameraRatio: 12,
        // Declutter: only label nodes whose RENDERED size clears this threshold,
        // so the whole-graph view doesn't drown in overlapping text (the #1
        // eyesore in the dense view). Bigger/hub nodes keep their labels.
        labelRenderedSizeThreshold: mode === 'full' ? 14 : 8,
        labelDensity: 0.7,
        labelGridCellSize: 70,
        // Perf on large graphs: drop labels/edges while panning or zooming so
        // interaction stays at 60fps, then repaint them when the camera settles.
        hideLabelsOnMove: mode === 'full',
        hideEdgesOnMove: mode === 'full',
        // Edge hover events are unused and cost a hit-test per frame — off.
        enableEdgeEvents: false,
        minEdgeThickness: 0.6,
        zIndex: true,
      }}
    >
      {mode === 'full' ? (
        <FullGraphLayout active version={version} />
      ) : (
        <GraphLayout version={version} />
      )}
      <GraphRefresher version={version} />
      <GraphResizer signal={resizeSignal} />
      <GraphDragger />
      <GraphSearchHighlighter
        searchQuery={searchQuery}
        semanticHits={semanticHits}
        citedIds={citedIds}
        activeNodeTypes={activeNodeTypes}
        activeEdgeTypes={activeEdgeTypes}
        focusSet={focusSet}
        activeProjects={activeProjects}
        allProjectCount={allProjectCount}
      />
      <GraphEventHandler
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onNodeLeave={handleNodeLeave}
      />
    </SigmaContainer>
  );
}
