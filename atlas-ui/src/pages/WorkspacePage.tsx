import { useCallback, useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Database, Loader2, FolderPlus, Sparkles, RefreshCw, X, ChevronDown, ChevronRight, MessageSquare, Network, GitBranch, WifiOff, XCircle, AlertTriangle } from 'lucide-react';
import { NodeType, GraphNode } from '../types/graph';
import { NODE_TYPES, EDGE_TYPES, type EdgeType } from '@atlas-schema';
import { useGraphData } from '../hooks/useGraphData';
import { useIndexStatus } from '../hooks/useIndexStatus';
import { liveNodeToGraphNode } from '../graph/nodeView';
import { invokeAtlasTool } from '../api/atlasApi';
import { deriveCitations } from '../graph/citationStore';
import { deriveStats } from '../graph/statsReadout';
import { countVisible } from '../graph/visibleCount';
import { deriveProgress } from '../graph/indexProgress';
import { nodeTypesForCategory } from '../graph/nodeTypeCategories';
import AtlasGraph, { type ExpandErrorClassification } from '../components/graph/AtlasGraph';
import { classifyExpandError } from '../graph/expandError';
import GraphErrorBoundary from '../components/graph/GraphErrorBoundary';
import GraphControls, { type FocusDepth } from '../components/graph/GraphControls';
import NodeDetail from '../components/graph/NodeDetail';
import AlertsPanel from '../components/AlertsPanel';
import SchemaConfirmModal from '../components/SchemaConfirmModal';
import AddProjectModal from '../components/AddProjectModal';
import ChatPanel from '../components/chat/ChatPanel';
import { useCitations } from '../graph/CitationProvider';

// Default filter state = EVERYTHING selected (no filtering). Keyed by the
// canonical schema vocab so the rail, the reducer, and the rendered graph agree.
const DEFAULT_ACTIVE_NODE_TYPES = new Set<NodeType>(NODE_TYPES);
const DEFAULT_ACTIVE_EDGE_TYPES = new Set<EdgeType>(EDGE_TYPES);

export default function WorkspacePage() {
  const { id: workspaceName } = useParams<{ id: string }>();

  // ── B4 PART 2: chat citation highlight ───────────────────────────────────────
  // Read the workspace-scoped citation set published by the chat tab (shared via
  // the CitationProvider in WorkspaceLayout). When non-empty, AtlasGraph dims all
  // but the cited nodes. `clear` powers a dismiss affordance.
  const { citations, clear: clearCitations } = useCitations(workspaceName ?? '');

  // ── Filter / search state (Sprint 2 — now ALL wired to the render reducer) ───
  // Deselecting a node type HIDES those nodes; deselecting an edge relation HIDES
  // those edges. All-selected = no filtering (the reducer early-outs).
  const [activeNodeTypes, setActiveNodeTypes] =
    useState<Set<NodeType>>(DEFAULT_ACTIVE_NODE_TYPES);
  const [activeEdgeTypes, setActiveEdgeTypes] =
    useState<Set<EdgeType>>(DEFAULT_ACTIVE_EDGE_TYPES);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Semantic search (knowledge_search → highlight) ───────────────────────────
  const [semanticHits, setSemanticHits] = useState<string[]>([]);
  const [semanticBusy, setSemanticBusy] = useState(false);

  // ── Focus depth (neighborhood constraint around the selected node) ───────────
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(null);
  const [focusSet, setFocusSet] = useState<readonly string[] | undefined>(undefined);

  // ── Selected node ────────────────────────────────────────────────────────────
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // ── UX-truth site #1: node expand/collapse error toast ───────────────────────
  // AtlasGraph's click handler previously swallowed expand/collapse failures
  // (daemon-down or tool-error) with zero feedback. `onExpandError` now surfaces
  // a classified error here, rendered as a dismissible toast; auto-clears after
  // a few seconds so it never becomes a stuck banner over the graph.
  const [expandError, setExpandError] = useState<ExpandErrorClassification | null>(null);
  const handleExpandError = useCallback((classification: ExpandErrorClassification) => {
    setExpandError(classification);
  }, []);
  useEffect(() => {
    if (!expandError) return;
    const t = setTimeout(() => setExpandError(null), 6000);
    return () => clearTimeout(t);
  }, [expandError]);

  // ── Schema modal / Add project modal ──────────────────────────────────────────
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  // ── Projects panel ───────────────────────────────────────────────────────────
  interface ProjectEntry { path: string; addedAt: string }
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [reindexingPath, setReindexingPath] = useState<string | null>(null);

  async function loadProjects() {
    if (!workspaceName) return;
    try {
      const r = await invokeAtlasTool('workspace_list_projects', { workspace: workspaceName }) as { projects?: ProjectEntry[] };
      setProjects(r.projects ?? []);
    } catch { /* silent */ }
  }

  useEffect(() => { void loadProjects(); }, [workspaceName]);

  async function handleReindex(projPath: string) {
    if (!workspaceName) return;
    setReindexingPath(projPath);
    pingIndexStatus();
    try {
      await invokeAtlasTool('atlas_index', { workspace: workspaceName, path: projPath });
    } catch { /* error shown in progress bar */ } finally {
      setReindexingPath(null);
    }
  }

  async function handleRemoveProject(projPath: string) {
    if (!workspaceName) return;
    setProjectError('');
    try {
      await invokeAtlasTool('workspace_remove_project', { workspace: workspaceName, path: projPath });
    } catch (err) {
      // Previously an unhandled rejection: daemon-down/tool error removed the
      // row optimistically anyway (or left it with zero feedback).
      setProjectError(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setProjects((p) => p.filter((x) => x.path !== projPath));
  }

  // ── Graph data: ONE stable instance + controller, lazy drill-down ─────────────
  const {
    graph,
    controller,
    loading,
    error,
    daemonUnreachable,
    daemonUrl,
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
    projects: graphProjects,
    colorMode,
    setColorMode,
    insights,
  } = useGraphData(workspaceName);

  // Collapsible right-side chat panel (chat while the graph is visible).
  const [chatOpen, setChatOpen] = useState(false);
  // When the user clicks "Ask in chat" on a node, this seeds the chat input.
  const [chatSeed, setChatSeed] = useState<string>('');

  // Project filter (whole-graph view). Default: all projects visible. Re-seeded
  // to "all" whenever a full-graph load surfaces a new project set.
  const [activeProjects, setActiveProjects] = useState<Set<string>>(new Set());
  useEffect(() => {
    setActiveProjects(new Set(graphProjects));
  }, [graphProjects]);

  const handleToggleProject = useCallback((p: string) => {
    setActiveProjects((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);
  const handleSetAllProjects = useCallback((on: boolean) => {
    setActiveProjects(on ? new Set(graphProjects) : new Set());
  }, [graphProjects]);
  const handleSetAllNodeTypes = useCallback((on: boolean) => {
    setActiveNodeTypes(on ? new Set(NODE_TYPES) : new Set());
  }, []);
  const handleSetAllEdgeTypes = useCallback((on: boolean) => {
    setActiveEdgeTypes(on ? new Set(EDGE_TYPES) : new Set());
  }, []);

  // ── Live index progress (Sprint 4) ────────────────────────────────────────
  // Poll index_status while a run is in flight; on completion, reload the graph
  // so the new communities/counts appear. `ping` lets us start a fast poll the
  // instant an index is triggered from this page.
  const { status: indexStatusRaw, ping: pingIndexStatus } = useIndexStatus(
    workspaceName,
    reload,
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleToggleNodeType = useCallback((t: NodeType) => {
    setActiveNodeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const handleToggleEdgeType = useCallback((e: EdgeType) => {
    setActiveEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }, []);

  // Category-level node-type select: union (on) or subtract (off) exactly the
  // Code or Knowledge types WITHOUT touching the other category's rows. Powers
  // the per-section All/None so, e.g., "Code → None" leaves Knowledge intact.
  const handleSetNodeTypeCategory = useCallback(
    (category: 'code' | 'knowledge', on: boolean) => {
      const members = nodeTypesForCategory(category);
      setActiveNodeTypes((prev) => {
        const next = new Set(prev);
        for (const t of members) {
          if (on) next.add(t);
          else next.delete(t);
        }
        return next;
      });
    },
    [],
  );

  // "Only" selects — set the Set to exactly {value}. The core of a better
  // multi-select: hover a row, click "only", and everything else drops out in
  // one action instead of unchecking N others.
  const handleOnlyNodeType = useCallback((value: NodeType) => {
    setActiveNodeTypes(new Set<NodeType>([value]));
  }, []);

  // Edge solo: the legacy `related_to` relation does NOT ride along — an "only
  // calls" select yields exactly {calls}, never {calls, related_to}. (Legacy is
  // invisible in the rail, so it must be invisible to solo too.)
  const handleOnlyEdgeType = useCallback((value: EdgeType) => {
    setActiveEdgeTypes(new Set<EdgeType>([value]));
  }, []);

  const handleOnlyProject = useCallback((value: string) => {
    setActiveProjects(new Set<string>([value]));
  }, []);

  // Semantic search: explicit action (Enter / icon). Runs knowledge_search via
  // MCP, maps results → ids/paths with the SAME extractor citations use, and
  // feeds them into the highlight reducer. Unloaded hits are silently skipped
  // (matching the existing citation contract). Instant substring stays separate
  // and keystroke-driven via `searchQuery`.
  const handleSemanticSearch = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || !workspaceName) return;
      setSemanticBusy(true);
      try {
        const raw = await invokeAtlasTool('knowledge_search', {
          q: query,
          workspace: workspaceName,
          limit: 20,
          search_mode: 'semantic',
        });
        setSemanticHits(deriveCitations(raw));
      } catch {
        setSemanticHits([]);
      } finally {
        setSemanticBusy(false);
      }
    },
    [workspaceName],
  );

  // Clear semantic hits whenever the user edits the live query (so the two
  // channels don't fight): substring takes precedence in the reducer anyway,
  // but clearing keeps the UI honest once the explicit query changes.
  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    setSemanticHits([]);
  }, []);

  // Focus depth: "All" (null) clears the constraint; a numeric depth loads the
  // selected node's BFS neighborhood via controller.focus() and constrains
  // visibility to the returned set (the reducer HIDES non-members). focus()
  // only ADDS nodes (refcount-safe), so clearing is purely a render reset.
  const handleFocusDepthChange = useCallback(
    async (depth: FocusDepth) => {
      setFocusDepth(depth);
      if (depth === null) {
        setFocusSet(undefined); // reset to whole graph
        return;
      }
      const seedId = selectedNode?.id;
      if (!seedId || !graph.hasNode(seedId)) return;
      try {
        const { focusSet: ids } = await controller.focus(seedId, depth);
        setFocusSet(ids);
        bumpVersion();
      } catch (e) {
        // UX-truth site #2 — a failed focus-depth fetch previously left the
        // user with zero feedback (silent catch). Reuse the SAME classifier +
        // toast site #1 already uses (daemon-unreachable vs generic tool
        // error), so this failure surfaces consistently instead of silently.
        // The previous focus set is intentionally left intact — the request
        // failed, so the last-good neighborhood constraint still applies.
        setExpandError(classifyExpandError(e));
      }
    },
    [selectedNode, graph, controller, bumpVersion],
  );

  // Click → expand/collapse happens inside AtlasGraph; here we just resolve the
  // clicked id to a detail-panel node off the live graph.
  const handleNodeSelect = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) {
        setSelectedNode(null);
        return;
      }
      setSelectedNode(liveNodeToGraphNode(graph, nodeId, workspaceName ?? ''));
    },
    [graph, workspaceName],
  );

  // "Ask in chat" from the node detail: open the chat panel and seed its input
  // with a question about the selected node, so you can chat about it directly.
  const handleAskInChat = useCallback((node: GraphNode) => {
    const name = node.label || node.id;
    setChatSeed(`Tell me about \`${name}\` — what is it, what depends on it, and any decisions about it?`);
    setChatOpen(true);
  }, []);

  // Bumps whenever the right-rail composition changes (chat / node detail
  // open/close) so the graph canvas re-measures and never draws under a panel.
  const resizeSignal = (chatOpen ? 1 : 0) + (selectedNode ? 2 : 0);

  const handleSchemaConfirmed = useCallback(() => {
    reload();
  }, [reload]);

  // B4 PART 3: refine a truncated node — re-query with a larger budget, refresh
  // the graph, and re-read the selected node so the detail panel reflects the
  // new (possibly cleared) truncation state.
  const handleRefine = useCallback(
    async (nodeId: string) => {
      await controller.refine(nodeId);
      bumpVersion();
      setSelectedNode(liveNodeToGraphNode(graph, nodeId, workspaceName ?? ''));
    },
    [controller, bumpVersion, graph, workspaceName],
  );

  // Node/edge counts = what's ACTUALLY visible under the active filters
  // (type/focus/project/relation), not just the loaded view — the header used
  // to report graph.order/size regardless of filtering, so the readout never
  // matched the canvas (empty canvas at 0/10 types still read "17 nodes").
  // `version` bumps on every controller mutation (expand/collapse/focus), so
  // recounting here stays live as the user drills in. (Referencing `version`
  // documents the dependency for readers.)
  void version;
  const allTypesActiveNow = activeNodeTypes.size >= NODE_TYPES.length;
  const allEdgesActiveNow = activeEdgeTypes.size >= EDGE_TYPES.length;
  const focusActiveNow = focusSet != null && focusSet.length > 0;
  const visible = countVisible(graph, {
    focusSet: focusActiveNow ? new Set(focusSet) : null,
    activeNodeTypes,
    allTypesActive: allTypesActiveNow,
    activeEdgeTypes,
    allEdgesActive: allEdgesActiveNow,
    activeProjects: mode === 'full' ? activeProjects : undefined,
    allProjectCount: graphProjects.length,
  });
  const visibleNodeCount = visible.nodes;

  // Honest header stats: communities = workspace-level atlas_communities.total;
  // nodes/edges = the FILTERED view, labeled "in view".
  const stats = deriveStats({
    communities: communityTotal,
    loadedNodes: visible.nodes,
    loadedEdges: visible.edges,
  });

  // Live index progress bar state (hidden when idle).
  const progress = deriveProgress(indexStatusRaw);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="flex flex-col border-b border-[var(--lb-border-s)] bg-[var(--lb-overlay)] shrink-0">
       <div className="flex items-center justify-between px-6 py-3">
        <div>
          <h1 className="text-base font-bold text-[var(--lb-fg)] leading-tight">
            {workspaceName ?? 'Workspace'}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-xs text-[var(--lb-dim)]">Code Intelligence Graph</p>
            {/* Sprint 4 stats strip — honest labels: communities = workspace
                count, nodes/edges = loaded view. */}
            {stats.length > 0 && (
              <>
                <span className="text-[var(--lb-border-s)]">·</span>
                <div className="flex items-center gap-2 text-xs">
                  {stats.map((s, i) => (
                    <span key={s.label} className="flex items-center gap-1">
                      {i > 0 && <span className="text-[var(--lb-border-s)]">·</span>}
                      <span className="font-semibold text-[var(--lb-body)] tabular-nums">{s.value}</span>
                      <span className="text-[var(--lb-dim)]">{s.label}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode: drill-down vs whole graph */}
          <div className="flex items-center rounded-md border border-[var(--lb-border-s)] overflow-hidden">
            <button
              onClick={() => { if (mode !== 'drill') loadDrill(); }}
              title="Lazy drill-down: community → file → symbol"
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 transition-colors ${
                mode === 'drill'
                  ? 'bg-[#da7756] text-white'
                  : 'bg-[var(--lb-surface)] text-[var(--lb-body)] hover:bg-[var(--lb-surface-hover)] hover:text-[var(--lb-fg)]'
              }`}
            >
              <GitBranch size={12} />
              Drill-down
            </button>
            <button
              onClick={() => { if (mode !== 'full') loadFull(); }}
              title="Load the entire workspace graph at once"
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 transition-colors border-l border-[var(--lb-border-s)] ${
                mode === 'full'
                  ? 'bg-[#da7756] text-white'
                  : 'bg-[var(--lb-surface)] text-[var(--lb-body)] hover:bg-[var(--lb-surface-hover)] hover:text-[var(--lb-fg)]'
              }`}
            >
              <Network size={12} />
              Entire graph
            </button>
          </div>
          <button
            onClick={() => setChatOpen((o) => !o)}
            title="Chat with Groundfloor Atlas alongside the graph"
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 border rounded transition-colors ${
              chatOpen
                ? 'bg-[#da7756] text-white border-[#da7756]'
                : 'bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] text-[var(--lb-body)] hover:text-[var(--lb-fg)]'
            }`}
          >
            <MessageSquare size={12} />
            Chat
          </button>
          <button
            onClick={() => setAddProjectOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] rounded text-[var(--lb-body)] hover:text-[var(--lb-fg)] transition-colors"
          >
            <FolderPlus size={12} />
            Add Project
          </button>
          <button
            onClick={() => setSchemaModalOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] rounded text-[var(--lb-body)] hover:text-[var(--lb-fg)] transition-colors"
          >
            <Database size={12} />
            Confirm Schema Change
          </button>
        </div>
       </div>

       {/* ── Projects panel — collapsible list of indexed projects ── */}
       {projects.length > 0 && (
         <div className="px-6 pb-2 border-t border-[var(--lb-border-s)]">
           <button
             onClick={() => setProjectsOpen((o) => !o)}
             className="flex items-center gap-1.5 py-1.5 text-xs text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors"
           >
             {projectsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
             {projects.length} project{projects.length !== 1 ? 's' : ''} indexed
           </button>
           {projectsOpen && (
             <div className="flex flex-col gap-1 pb-1">
               {projectError && <p className="text-[11px] text-rose-300 px-1">{projectError}</p>}
               {projects.map((p) => (
                 <div key={p.path} className="group flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--lb-surface)] border border-[var(--lb-border-s)]">
                   <FolderPlus size={11} className="text-[#da7756] shrink-0" />
                   <span className="flex-1 text-xs font-mono text-[var(--lb-body)] truncate" title={p.path}>{p.path}</span>
                   <button
                     onClick={() => void handleReindex(p.path)}
                     disabled={reindexingPath === p.path}
                     className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--lb-dim)] hover:text-[var(--lb-body)] hover:bg-[var(--lb-border-s)] opacity-0 group-hover:opacity-100 transition-all disabled:opacity-40"
                     title="Re-index this project"
                   >
                     <RefreshCw size={10} className={reindexingPath === p.path ? 'animate-spin' : ''} />
                     Re-index
                   </button>
                   <button
                     onClick={() => void handleRemoveProject(p.path)}
                     className="p-0.5 rounded text-[var(--lb-dim)] hover:text-red-400 hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-all"
                     title="Remove project from workspace"
                   >
                     <X size={11} />
                   </button>
                 </div>
               ))}
             </div>
           )}
         </div>
       )}

       {/* ── Live index progress bar (Sprint 4) — only while a run is in flight
            or just finished/failed. Determinate fill from filesDone/filesTotal;
            indeterminate while parsing or finalizing embeds (no fabricated %). */}
       {progress.visible && (
         <div className="px-6 pb-2.5 -mt-1">
           <div className="flex items-center justify-between mb-1">
             <span
               className={`text-[11px] font-medium ${
                 progress.phase === 'error' ? 'text-red-400' : 'text-[#da7756]'
               }`}
             >
               {progress.label}
             </span>
             {progress.phase !== 'error' && (
               <span className="text-[10px] text-[var(--lb-dim)] tabular-nums">
                 {progress.nodesWritten.toLocaleString()} nodes · {progress.edgesWritten.toLocaleString()} edges
               </span>
             )}
           </div>
           <div className="w-full h-1 bg-[var(--lb-surface)] rounded-full overflow-hidden">
             {progress.phase === 'error' ? (
               <div className="h-full bg-red-600 rounded-full w-full" />
             ) : progress.fraction == null ? (
               // Indeterminate: total unknown (parsing) or finalizing embeds.
               <div className="h-full bg-[#da7756] rounded-full w-1/3 animate-pulse" />
             ) : (
               <div
                 className="h-full bg-[#da7756] rounded-full transition-[width] duration-500"
                 style={{ width: `${Math.round(progress.fraction * 100)}%` }}
               />
             )}
           </div>
         </div>
       )}
      </div>

      {/* ── Body: controls | graph canvas | node detail ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left filter panel */}
        <GraphControls
          activeNodeTypes={activeNodeTypes}
          onToggleNodeType={handleToggleNodeType}
          onSetAllNodeTypes={handleSetAllNodeTypes}
          onSetNodeTypeCategory={handleSetNodeTypeCategory}
          onOnlyNodeType={handleOnlyNodeType}
          activeEdgeTypes={activeEdgeTypes}
          onToggleEdgeType={handleToggleEdgeType}
          onSetAllEdgeTypes={handleSetAllEdgeTypes}
          onOnlyEdgeType={handleOnlyEdgeType}
          projects={graphProjects}
          activeProjects={activeProjects}
          onToggleProject={handleToggleProject}
          onSetAllProjects={handleSetAllProjects}
          onOnlyProject={handleOnlyProject}
          colorMode={colorMode}
          onColorModeChange={setColorMode}
          showFullGraphControls={mode === 'full'}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onSemanticSearch={handleSemanticSearch}
          semanticBusy={semanticBusy}
          focusDepth={focusDepth}
          onFocusDepthChange={handleFocusDepthChange}
          canFocus={selectedNode != null}
          nodeCount={visibleNodeCount}
          onRefresh={reload}
        />

        {/* Graph canvas */}
        {/* The graph canvas stays a dark "data surface" in BOTH themes — the node
            palette + label colors are tuned for a dark background and wash out on
            light. App chrome (rails, panels) still themes normally. */}
        <div className="relative flex-1 bg-[#0f0f13]">
          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--lb-overlay-mid)]">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="animate-spin text-[var(--lb-dim)]" size={28} />
                <p className="text-xs text-[var(--lb-dim)]">Loading communities…</p>
              </div>
            </div>
          )}

          {/* ── (a) Daemon unreachable — the fetch itself REJECTED (connection
               refused / daemon not running). Checked first and rendered with a
               visually distinct rose/WifiOff treatment so it can never be
               confused with (c) "indexed but zero nodes" or the generic (b)
               "never indexed" empty state below — those both imply the daemon
               answered, this means it never did. */}
          {!loading && daemonUnreachable && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-8">
              <div className="w-20 h-20 rounded-full bg-rose-950/40 border border-rose-800/60 flex items-center justify-center">
                <WifiOff size={32} className="text-rose-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-rose-300 mb-1">
                  Groundfloor Atlas daemon not reachable at {daemonUrl}
                </p>
                <p className="text-xs text-gray-600 max-w-xs">
                  The Groundfloor Atlas daemon isn't responding. Start it with{' '}
                  <code className="text-gray-400">atlas service install</code> (or{' '}
                  <code className="text-gray-400">atlas serve</code>), then retry.
                </p>
              </div>
              <button
                onClick={reload}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Error state — daemon reached but the call itself failed (tool-level
               error, not a network rejection). */}
          {!loading && !daemonUnreachable && error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={reload}
                className="text-xs px-3 py-1.5 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] rounded text-[var(--lb-body)] transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* ── (d) Last index FAILED — distinct from (b)/(c): the daemon is up
               and answered, but the most recent atlas_index run for this
               workspace ended in the terminal `error` phase, so whatever
               communities/nodes exist (if any) may be stale or incomplete. This
               must not be confused with a clean "genuinely zero nodes" (c) or
               "never indexed" (b) empty state — it's a FAILURE, shown in the
               error palette, not the neutral empty-state palette below. */}
          {!loading && !daemonUnreachable && !error && empty && progress.phase === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-8">
              <div className="w-20 h-20 rounded-full bg-red-950/40 border border-red-800/60 flex items-center justify-center">
                <XCircle size={32} className="text-red-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-red-300 mb-1">Last index failed</p>
                <p className="text-xs text-gray-600 max-w-xs">
                  {progress.error ? progress.error : 'The most recent indexing run did not complete successfully.'}
                </p>
              </div>
              <button
                onClick={() => setAddProjectOpen(true)}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
              >
                Retry Indexing
              </button>
            </div>
          )}

          {/* ── (b)/(c) Empty state — daemon up, no index-failure in flight:
               either nothing has been indexed yet (b) or the workspace is
               genuinely indexed with zero communities (c). emptyReason
               distinguishes the copy between the two. */}
          {!loading && !daemonUnreachable && !error && empty && progress.phase !== 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-8">
              <div className="w-20 h-20 rounded-full bg-[var(--lb-card)] border border-[var(--lb-border-s)] flex items-center justify-center">
                <svg
                  viewBox="0 0 64 64"
                  className="w-10 h-10 text-[var(--lb-border-s)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <circle cx="32" cy="32" r="6" />
                  <circle cx="12" cy="18" r="4" />
                  <circle cx="52" cy="18" r="4" />
                  <circle cx="12" cy="46" r="4" />
                  <circle cx="52" cy="46" r="4" />
                  <line x1="27" y1="29" x2="16" y2="21" />
                  <line x1="37" y1="29" x2="48" y2="21" />
                  <line x1="27" y1="35" x2="16" y2="43" />
                  <line x1="37" y1="35" x2="48" y2="43" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--lb-subtle)] mb-1">
                  {emptyReason === 'no-communities'
                    ? 'No communities above threshold'
                    : 'No indexed code in this workspace yet'}
                </p>
                <p className="text-xs text-[var(--lb-dim)] max-w-xs">
                  {emptyReason === 'no-communities' ? (
                    <>
                      Files exist but none clustered into a community. Try{' '}
                      <code className="font-mono text-[var(--lb-dim)]">atlas_subgraph</code> with a
                      file center, or re-index.
                    </>
                  ) : (
                    <>
                      Run <code className="font-mono text-[var(--lb-dim)]">atlas index</code> to
                      populate communities, files, and symbols.
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* UX-truth site #1: expand/collapse error toast — previously a
              failed node expand/collapse (daemon-down or tool-error) gave the
              user zero feedback. Distinct rose treatment for daemon-unreachable
              (matches the WifiOff banner's vocabulary) vs a generic red toast
              for a tool-level failure. Dismissible + auto-clears after 6s. */}
          {expandError && (
            <div
              className={`absolute top-3 right-3 z-20 flex items-start gap-2 max-w-xs rounded-lg border px-3 py-2 backdrop-blur shadow-lg ${
                expandError.daemonUnreachable
                  ? 'bg-rose-950/80 border-rose-800/70 text-rose-200'
                  : 'bg-red-950/80 border-red-800/70 text-red-200'
              }`}
            >
              {expandError.daemonUnreachable
                ? <WifiOff size={14} className="text-rose-400 shrink-0 mt-0.5" />
                : <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />}
              <span className="text-[11px] leading-snug">{expandError.message}</span>
              <button
                onClick={() => setExpandError(null)}
                className="ml-1 text-current opacity-70 hover:opacity-100 transition-opacity shrink-0"
                aria-label="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* B4: citation-highlight banner — shown when chat published a cited
              set. Search (an explicit query) overrides citation highlight, so we
              only advertise it when there's no active search. */}
          {citations.length > 0 && !searchQuery.trim() && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-violet-950/80 border border-violet-700/70 rounded-full px-3 py-1.5 backdrop-blur">
              <Sparkles size={12} className="text-violet-300" />
              <span className="text-[11px] text-violet-200">
                Highlighting {citations.length} cited node{citations.length === 1 ? '' : 's'} from chat
              </span>
              <button
                onClick={() => clearCitations()}
                className="text-[11px] text-violet-300 hover:text-violet-100 underline-offset-2 hover:underline transition-colors"
              >
                Clear
              </button>
            </div>
          )}

          {/* Sigma graph — mounted once the level-0 load has nodes */}
          {!loading && !daemonUnreachable && !error && !empty && graph.order > 0 && (
            <GraphErrorBoundary>
              <AtlasGraph
                graph={graph}
                controller={controller}
                version={version}
                onMutate={bumpVersion}
                searchQuery={searchQuery}
                semanticHits={semanticHits}
                citedIds={citations}
                activeNodeTypes={activeNodeTypes}
                activeEdgeTypes={activeEdgeTypes}
                focusSet={focusSet}
                onNodeSelect={handleNodeSelect}
                onExpandError={handleExpandError}
                mode={mode}
                activeProjects={mode === 'full' ? activeProjects : undefined}
                allProjectCount={graphProjects.length}
                resizeSignal={resizeSignal}
              />
            </GraphErrorBoundary>
          )}

          {/* Coupling-insights strip (drill / architecture-map view only). */}
          {mode === 'drill' && insights && (insights.cycles.length > 0 || insights.godClusters.length > 0 || insights.layerViolations.length > 0) && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-[var(--lb-overlay)] border border-[var(--lb-border-s)] rounded-full px-3 py-1.5 backdrop-blur text-[11px]">
              <span className="font-semibold text-[var(--lb-fg)]">Coupling insights:</span>
              {insights.cycles.length > 0 && (
                <span className="flex items-center gap-1 text-[#f59e0b]" title="Clusters that mutually depend on each other">
                  <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
                  {insights.cycles.length} cycle{insights.cycles.length === 1 ? '' : 's'} ({insights.cycles.reduce((n, c) => n + c.length, 0)} clusters)
                </span>
              )}
              {insights.godClusters.length > 0 && (
                <span className="flex items-center gap-1 text-[var(--lb-body)]" title="Clusters many others depend on (wide blast radius)">
                  <span className="w-2 h-2 rounded-full ring-1 ring-[var(--lb-fg)]" />
                  {insights.godClusters.length} god-cluster{insights.godClusters.length === 1 ? '' : 's'}
                </span>
              )}
              {insights.layerViolations.length > 0 && (
                <span className="flex items-center gap-1 text-[#ef4444]" title="Probable layer inversions (foundational code depending on surface code)">
                  <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
                  {insights.layerViolations.length} layer inversion{insights.layerViolations.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}

          {/* Full-graph truncation note — honest "showing N of M". */}
          {mode === 'full' && fullMeta && fullMeta.truncated && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-[var(--lb-overlay)] border border-[var(--lb-border-s)] rounded-full px-3 py-1.5 backdrop-blur">
              <Network size={12} className="text-[#da7756]" />
              <span className="text-[11px] text-[var(--lb-body)]">
                Showing {fullMeta.shown.toLocaleString()} of {fullMeta.total.toLocaleString()} nodes (capped for performance)
              </span>
            </div>
          )}
        </div>

        {/* Right detail panel — shown when a node is selected */}
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            onRefine={handleRefine}
            onSelectNeighbor={handleNodeSelect}
            onAskInChat={handleAskInChat}
          />
        )}

        {/* Collapsible chat panel — chat while the graph stays visible. Citations
            raised here highlight the graph sitting right next to it. Kept MOUNTED
            and hidden with CSS (not unmounted) so toggling it closed no longer
            destroys the whole conversation — the old `{chatOpen && …}` unmount
            reset the panel to the welcome message every time. */}
        <div
          className={`w-[380px] shrink-0 border-l border-[var(--lb-border-s)] bg-[var(--lb-deep)] flex-col ${chatOpen ? 'flex' : 'hidden'}`}
          aria-hidden={!chatOpen}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--lb-border-s)] bg-[var(--lb-overlay)] shrink-0">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--lb-fg)]">
              <MessageSquare size={12} className="text-[#da7756]" />
              Groundfloor Atlas Chat
            </span>
            <button
              onClick={() => setChatOpen(false)}
              className="p-0.5 rounded text-[var(--lb-dim)] hover:text-[var(--lb-fg)] hover:bg-[var(--lb-border-s)] transition-colors"
              title="Close chat"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatPanel workspaceName={workspaceName ?? ''} embedded seedInput={chatSeed} />
          </div>
        </div>
      </div>

      {/* ── Alerts strip ── */}
      {workspaceName && <AlertsPanel workspace={workspaceName} />}

      {/* ── Schema confirmation modal ── */}
      <SchemaConfirmModal
        open={schemaModalOpen}
        onOpenChange={setSchemaModalOpen}
        workspace={workspaceName ?? ''}
        onConfirmed={handleSchemaConfirmed}
      />

      {/* ── Add project modal ── */}
      <AddProjectModal
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        defaultWorkspace={workspaceName}
        onDone={() => { reload(); void loadProjects(); }}
        onIndexStart={pingIndexStatus}
      />
    </div>
  );
}
