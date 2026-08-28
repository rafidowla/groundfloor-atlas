/**
 * useGraphData.ts — B2 rewrite: the ownership-inversion hook.
 *
 * BEFORE (the thing being replaced): a single useEffect fired 7 parallel
 * `knowledge_search` calls (limit 40 each), deduped them, and did
 * `setGraph(buildGraph(...))` — a BRAND-NEW Graphology instance on EVERY change,
 * with ZERO edges. The graph was a disconnected point cloud and every mutation
 * blew positions away.
 *
 * AFTER: the Graphology instance is created ONCE per workspace (useMemo keyed by
 * the workspace id, so switching workspace yields a FRESH controller + graph —
 * multi-workspace isolation) and is NEVER replaced. A `GraphController` wraps it
 * and mutates it in place (addNode/addEdge/dropNode). The hook exposes:
 *   - `graph`      the stable Graphology instance (stable identity → Sigma loads
 *                  it once, never reloads on expand).
 *   - `controller` the drill-down controller (expand/collapse/isExpanded).
 *   - loading / error / empty-state flags for the level-0 communities load.
 *   - `version`    a monotonically increasing counter the renderer reads to know
 *                  the graph mutated and it should `sigma.refresh()`.
 *   - `reload`     re-run loadLevel0 (used by the Refresh button / re-index).
 *
 * The `Fetcher` is bound to the real MCP tools here (`atlas_communities` /
 * `atlas_subgraph`); the controller itself never imports the API client, which
 * is why it is unit-testable with a fake.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import { invokeAtlasTool, AtlasDaemonUnreachableError, ATLAS_BASE } from '../api/atlasApi';
import { GraphController, type Fetcher, type ColorMode, type CommunityInsights } from '../graph/GraphController';

/** Why level-0 produced no nodes — drives which empty state the UI shows. */
export type EmptyReason = 'none' | 'no-index' | 'no-communities';

/** Outcome of classifying a rejected `loadLevel0()` promise. PURE (no React)
 *  so it's directly unit-testable — mirrors the codebase's derive* pattern
 *  (deriveProgress, deriveStats, deriveCitations). Point 3 of the UX-lie fix:
 *  a daemon-unreachable fetch rejection must be distinguished from a daemon
 *  that responded but the call still failed, so the UI can render a distinct
 *  banner instead of a generic error/empty state. */
export interface LoadErrorClassification {
  daemonUnreachable: boolean;
  /** Human-readable message for the generic error state; empty when
   *  daemonUnreachable is true (that path has its own dedicated copy). */
  message: string;
}

export function classifyLoadError(e: unknown): LoadErrorClassification {
  if (e instanceof AtlasDaemonUnreachableError) {
    return { daemonUnreachable: true, message: '' };
  }
  return { daemonUnreachable: false, message: (e as Error)?.message ?? 'Failed to load communities' };
}

export interface UseGraphDataReturn {
  /** The single, stable Graphology instance the controller mutates. */
  graph: Graph;
  /** The drill-down controller (expand / collapse / isExpanded). */
  controller: GraphController;
  loading: boolean;
  error: string | null;
  /** True when the level-0 fetch failed because the daemon itself could not be
   *  reached (connection refused / not running) — distinct from `error`,
   *  which covers a daemon that responded but the call still failed. Point 3 /
   *  4(a) of the UX-lie fix: this must render its own distinct banner, never a
   *  generic empty graph or a misleading "no communities" message. */
  daemonUnreachable: boolean;
  /** The URL the daemon was expected to be reachable at, for display in the
   *  daemon-unreachable banner. */
  daemonUrl: string;
  /** True after a successful level-0 load that yielded zero community nodes. */
  empty: boolean;
  emptyReason: EmptyReason;
  /** Bumped on every controller mutation so the renderer can refresh(). */
  version: number;
  /** Call after a controller mutation to trigger a renderer refresh. */
  bumpVersion: () => void;
  /** Re-run the level-0 communities load (Refresh button / post-index). */
  reload: () => void;
  /** Workspace-level community count from atlas_communities.total — null until
   *  the level-0 load resolves. Drives the honest header stats readout. */
  communityTotal: number | null;
  /** Current view: 'drill' (community → file → symbol) or 'full' (whole graph). */
  mode: GraphMode;
  /** Load the WHOLE workspace graph (atlas_fullgraph) and switch to full mode. */
  loadFull: () => void;
  /** Return to the lazy drill-down view (clears + reloads level 0). */
  loadDrill: () => void;
  /** Set in full mode: how many nodes are shown vs how many exist (for the
   *  "showing N of M" truncation note). Null in drill mode / before a full load. */
  fullMeta: { shown: number; total: number; truncated: boolean } | null;
  /** Projects (repos) present in the loaded full graph — drives the project filter. */
  projects: string[];
  /** Communities present in the loaded full graph. */
  communities: string[];
  /** Active node-paint mode (type / project / community). */
  colorMode: ColorMode;
  /** Change the paint mode — recolors the live graph in place (no relayout). */
  setColorMode: (m: ColorMode) => void;
  /** Coupling-insight findings for the drill-down architecture map (cycles,
   *  god-clusters, layer inversions). Null in full mode / before a drill load. */
  insights: CommunityInsights | null;
}

export type GraphMode = 'drill' | 'full';

// ── MCP-backed Fetcher ───────────────────────────────────────────────────────

/** Optional sink for workspace-level community metadata (`total`,
 *  `uncategorized`) that atlas_communities returns alongside the list. The hook
 *  passes one so the header stats readout can surface the genuine community
 *  count WITHOUT a second network call — the fetcher already has the payload,
 *  it was just being discarded (diagnosis §1 / §4). */
export interface CommunityMeta {
  total: number;
  uncategorized: number;
}

/** Bind the controller's narrow Fetcher contract to the real Groundfloor Atlas MCP tools. */
function createMcpFetcher(onMeta?: (meta: CommunityMeta) => void): Fetcher {
  return {
    async communities(workspace) {
      const result = await invokeAtlasTool('atlas_communities', { workspace });
      const r = (result ?? {}) as Record<string, unknown>;
      const list = Array.isArray(r['communities']) ? (r['communities'] as Array<Record<string, unknown>>) : [];
      const rawEdges = Array.isArray(r['edges']) ? (r['edges'] as Array<Record<string, unknown>>) : [];
      // Surface the workspace-level counts the list mapping below discards.
      onMeta?.({
        total: typeof r['total'] === 'number' ? (r['total'] as number) : list.length,
        uncategorized: typeof r['uncategorized'] === 'number' ? (r['uncategorized'] as number) : 0,
      });
      const insightsRaw = (r['insights'] ?? null) as Record<string, unknown> | null;
      return {
        communities: list.map((c) => ({
          id: String(c['id']),
          label: String(c['label'] ?? `community ${c['id']}`),
          fileCount: Number(c['fileCount'] ?? 0),
          folder: c['folder'] != null ? String(c['folder']) : undefined,
          project: c['project'] != null ? String(c['project']) : undefined,
          layer: c['layer'] != null ? String(c['layer']) : undefined,
          hub: c['hub'] === true,
        })),
        edges: rawEdges.map((e) => ({
          source: String(e['source'] ?? ''),
          target: String(e['target'] ?? ''),
          weight: Number(e['weight'] ?? 1),
          cyclic: e['cyclic'] === true,
          violation: e['violation'] === true,
        })),
        insights: insightsRaw
          ? {
              cycles: Array.isArray(insightsRaw['cycles']) ? (insightsRaw['cycles'] as string[][]) : [],
              godClusters: Array.isArray(insightsRaw['godClusters']) ? (insightsRaw['godClusters'] as Array<{ id: string; dependents: number }>) : [],
              layerViolations: Array.isArray(insightsRaw['layerViolations']) ? (insightsRaw['layerViolations'] as Array<{ source: string; target: string; sourceLayer: string; targetLayer: string }>) : [],
            }
          : undefined,
      };
    },
    async subgraph(workspace, opts) {
      const result = await invokeAtlasTool('atlas_subgraph', { workspace, ...opts });
      const r = (result ?? {}) as Record<string, unknown>;
      const nodes = Array.isArray(r['nodes'])
        ? (r['nodes'] as Array<Record<string, unknown>>).map((n) => ({
            id: String(n['id'] ?? ''),
            type: String(n['type'] ?? ''),
            label: String(n['label'] ?? n['id'] ?? ''),
            file: n['file'] != null ? String(n['file']) : undefined,
            cls: String(n['cls'] ?? 'other'),
            // Sprint 3: carry symbol line/signature metadata through so the
            // inspector's code view can request the right slice via atlas_source.
            startLine: typeof n['startLine'] === 'number' ? n['startLine'] : undefined,
            endLine: typeof n['endLine'] === 'number' ? n['endLine'] : undefined,
            signature: n['signature'] != null ? String(n['signature']) : undefined,
            qualifiedName: n['qualifiedName'] != null ? String(n['qualifiedName']) : undefined,
          }))
        : [];
      const edges = Array.isArray(r['edges'])
        ? (r['edges'] as Array<Record<string, unknown>>).map((e) => ({
            source: String(e['source'] ?? ''),
            target: String(e['target'] ?? ''),
            relation: String(e['relation'] ?? 'related_to'),
          }))
        : [];
      return { nodes, edges, truncated: r['truncated'] === true };
    },
    async fullgraph(workspace, opts) {
      const result = await invokeAtlasTool('atlas_fullgraph', { workspace, ...(opts ?? {}) });
      const r = (result ?? {}) as Record<string, unknown>;
      const nodes = Array.isArray(r['nodes'])
        ? (r['nodes'] as Array<Record<string, unknown>>).map((n) => ({
            id: String(n['id'] ?? ''),
            type: String(n['type'] ?? ''),
            label: String(n['label'] ?? n['id'] ?? ''),
            file: n['file'] != null ? String(n['file']) : undefined,
            cls: String(n['cls'] ?? 'other'),
            startLine: typeof n['startLine'] === 'number' ? n['startLine'] : undefined,
            endLine: typeof n['endLine'] === 'number' ? n['endLine'] : undefined,
            signature: n['signature'] != null ? String(n['signature']) : undefined,
            qualifiedName: n['qualifiedName'] != null ? String(n['qualifiedName']) : undefined,
            project: n['project'] != null ? String(n['project']) : undefined,
            community: n['community'] != null ? String(n['community']) : undefined,
          }))
        : [];
      const edges = Array.isArray(r['edges'])
        ? (r['edges'] as Array<Record<string, unknown>>).map((e) => ({
            source: String(e['source'] ?? ''),
            target: String(e['target'] ?? ''),
            relation: String(e['relation'] ?? 'related_to'),
          }))
        : [];
      return {
        nodes,
        edges,
        truncated: r['truncated'] === true,
        totalNodes: typeof r['totalNodes'] === 'number' ? (r['totalNodes'] as number) : nodes.length,
      };
    },
  };
}

// ── The hook ─────────────────────────────────────────────────────────────────

export function useGraphData(workspace: string | undefined): UseGraphDataReturn {
  // Workspace-level community count (atlas_communities.total). Captured from the
  // SAME level-0 fetch that loads the graph — no extra call.
  const [communityTotal, setCommunityTotal] = useState<number | null>(null);

  // Stable callback the fetcher uses to surface community meta. Defined before
  // the fetcher memo so it can close over the setter without re-creating the
  // fetcher each render.
  const handleCommunityMeta = useCallback((meta: CommunityMeta) => {
    setCommunityTotal(meta.total);
  }, []);

  // ONE fetcher for the lifetime of the hook (stateless; safe to memo once).
  const fetcher = useMemo(() => createMcpFetcher(handleCommunityMeta), [handleCommunityMeta]);

  // The single graph + controller, recreated ONLY when the workspace id
  // changes. useMemo keyed by `workspace` is the multi-workspace isolation
  // boundary: two workspaces never share a graph or expansion state.
  const { graph, controller } = useMemo(() => {
    const g = new Graph({ type: 'undirected', multi: false });
    const ctrl = new GraphController(g, fetcher, workspace ?? '');
    return { graph: g, controller: ctrl };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [daemonUnreachable, setDaemonUnreachable] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [emptyReason, setEmptyReason] = useState<EmptyReason>('none');
  const [version, setVersion] = useState(0);
  // Entire graph is the DEFAULT view (the community architecture map is a
  // secondary lens reached via the Drill-down toggle).
  const [mode, setMode] = useState<GraphMode>('full');
  const [fullMeta, setFullMeta] = useState<{ shown: number; total: number; truncated: boolean } | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [communities, setCommunities] = useState<string[]>([]);
  const [colorMode, setColorModeState] = useState<ColorMode>('community');
  const [insights, setInsights] = useState<CommunityInsights | null>(null);

  // Flip the paint mode: recolor the live graph in place (no relayout) + refresh.
  const setColorMode = useCallback((m: ColorMode) => {
    setColorModeState(m);
    controller.recolor(m);
    setVersion((v) => v + 1);
  }, [controller]);

  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  // Guard against a stale async resolving after the workspace/mode changed.
  const loadGenRef = useRef(0);

  // ONE load dispatcher for both views. `m==='full'` bulk-loads the whole graph
  // (worker layout); `m==='drill'` loads the level-0 community architecture map
  // (with the coupling-insight overlay). Every branch is generation-guarded so a
  // stale async can't clobber a newer load.
  const runLoad = useCallback((m: GraphMode) => {
    if (!workspace) return;
    const gen = ++loadGenRef.current;
    setLoading(true); setError(null); setDaemonUnreachable(false); setEmpty(false); setEmptyReason('none');
    const p = m === 'full'
      ? controller.loadFullGraph({ colorMode }).then((res) => {
          if (gen !== loadGenRef.current) return;
          setFullMeta({ shown: res.added, total: res.totalNodes, truncated: res.truncated });
          setProjects(res.projects);
          setCommunities(res.communities);
          setInsights(null);
          if (res.added === 0) { setEmpty(true); setEmptyReason('no-index'); }
        })
      : controller.loadLevel0().then((res) => {
          if (gen !== loadGenRef.current) return;
          setInsights(res.insights);
          if (res.count === 0) { setEmpty(true); setEmptyReason('no-index'); }
        });
    p.then(() => { if (gen === loadGenRef.current) bumpVersion(); })
      .catch((e: unknown) => {
        if (gen !== loadGenRef.current) return;
        // UX-truth (RC wave 5): a daemon-unreachable fetch rejection gets its
        // own distinct banner rather than the generic error state (which would
        // otherwise read like a transient/tool-level failure).
        const classified = classifyLoadError(e);
        if (classified.daemonUnreachable) { setDaemonUnreachable(true); return; }
        setError(classified.message);
      })
      .finally(() => { if (gen === loadGenRef.current) setLoading(false); });
  }, [workspace, controller, colorMode, bumpVersion]);

  // Switch to the whole-workspace view.
  const loadFull = useCallback(() => {
    setMode('full');
    setFullMeta(null);
    runLoad('full');
  }, [runLoad]);

  // Switch to the drill-down / architecture-map view.
  const loadDrill = useCallback(() => {
    setMode('drill');
    setFullMeta(null);
    setProjects([]);
    controller.clear();
    runLoad('drill');
  }, [runLoad, controller]);

  // Reload the CURRENT view (Refresh button / post-index).
  const reload = useCallback(() => {
    setFullMeta(null);
    controller.clear();
    runLoad(mode);
  }, [runLoad, controller, mode]);

  // Initial + workspace-change load: the controller is recreated per workspace
  // (useMemo), so this fires on every switch. Loads the DEFAULT mode (full).
  useEffect(() => {
    if (!workspace) return;
    controller.clear();
    setMode('full');
    runLoad('full');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, controller]);

  return {
    graph,
    controller,
    loading,
    error,
    daemonUnreachable,
    daemonUrl: ATLAS_BASE,
    empty,
    emptyReason,
    version,
    bumpVersion,
    reload,
    communityTotal,
    mode,
    loadFull,
    loadDrill,
    fullMeta,
    projects,
    communities,
    colorMode,
    setColorMode,
    insights,
  };
}
