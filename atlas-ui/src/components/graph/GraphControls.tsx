/**
 * GraphControls.tsx — Sprint 2 filter rail + legend + focus + search.
 *
 * The left rail now drives REAL render state (the pre-Sprint-2 "Node Types"
 * checklist was the wrong taxonomy and its toggles were dead — never wired to
 * the graph). It now has four wired sections:
 *
 *   1. SEARCH — instant client-side substring (keystroke) PLUS an explicit
 *      semantic action on Enter / the search-icon (knowledge_search via MCP).
 *   2. FOCUS DEPTH — All / 1 / 2 / 3 / 5 segmented control. On a selected node,
 *      picking a depth loads + constrains the graph to that BFS neighborhood;
 *      "All" clears the focus.
 *   3. NODE TYPES — schema-driven (NODE_TYPE_META), grouped Code / Knowledge.
 *      Deselecting a type HIDES those nodes. Each row's swatch is the exact
 *      render color, so this section doubles as the LEGEND.
 *   4. EDGE TYPES — schema-driven (EDGE_TYPE_META) typed relations. Deselecting
 *      a relation HIDES those edges. Also a legend (hue per relation).
 *
 * All colors come from the shared `@atlas-schema` leaf, so the swatches match
 * the rendered graph by construction.
 */

import { useMemo, useState } from 'react';
import { Search, RefreshCw, Sparkles, Crosshair, X } from 'lucide-react';
import {
  NODE_TYPE_META,
  EDGE_TYPE_META,
  EDGE_TYPES,
  type NodeType,
  type EdgeType,
} from '@atlas-schema';
import { colorForKey, shortProjectLabel } from '../../graph/colorScale';
import { CODE_NODE_TYPES, KNOWLEDGE_NODE_TYPES } from '../../graph/nodeTypeCategories';
import { deriveTriState, type TriState } from '../../graph/selectionState';
import type { ColorMode } from '../../graph/GraphController';
import TriStateCheckbox from './TriStateCheckbox';

/** Focus-depth options. `null` = "All" (no focus constraint). */
export type FocusDepth = null | 1 | 2 | 3 | 5;
const FOCUS_DEPTHS: FocusDepth[] = [null, 1, 2, 3, 5];

// Node-type category split (Code / Knowledge) lives in a shared module so the
// rail and WorkspacePage's category-select handler agree by construction.
// Hide the legacy `related_to` relation from the edge legend (greyed/back-compat).
const VISIBLE_EDGE_TYPES = EDGE_TYPES.filter((e) => !EDGE_TYPE_META[e].legacy);

interface GraphControlsProps {
  // node-type filter
  activeNodeTypes: Set<NodeType>;
  onToggleNodeType: (t: NodeType) => void;
  onSetAllNodeTypes: (on: boolean) => void;
  onSetNodeTypeCategory: (category: 'code' | 'knowledge', on: boolean) => void;
  onOnlyNodeType: (t: NodeType) => void;
  // edge-type filter
  activeEdgeTypes: Set<EdgeType>;
  onToggleEdgeType: (e: EdgeType) => void;
  onSetAllEdgeTypes: (on: boolean) => void;
  onOnlyEdgeType: (e: EdgeType) => void;
  // project filter (whole-graph view) + color mode
  projects?: string[];
  activeProjects?: Set<string>;
  onToggleProject?: (p: string) => void;
  onSetAllProjects?: (on: boolean) => void;
  onOnlyProject?: (p: string) => void;
  colorMode?: ColorMode;
  onColorModeChange?: (m: ColorMode) => void;
  /** Show the project filter + color-by controls (whole-graph view only). */
  showFullGraphControls?: boolean;
  // search
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** Fire the semantic (knowledge_search) action for the current query. */
  onSemanticSearch: (q: string) => void;
  semanticBusy?: boolean;
  // focus depth
  focusDepth: FocusDepth;
  onFocusDepthChange: (d: FocusDepth) => void;
  /** True when a node is selected (focus depth is actionable). */
  canFocus: boolean;
  // misc
  nodeCount: number;
  onRefresh: () => void;
}

/** One filter/legend row: swatch + checkbox + label + a hover-revealed "only". */
function TypeRow({
  color,
  label,
  checked,
  onToggle,
  onOnly,
}: {
  color: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
  onOnly?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 group select-none">
      <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="rounded border-[var(--lb-dim)] cursor-pointer"
          style={{ accentColor: color }}
        />
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span
          onClick={(e) => {
            if (e.altKey && onOnly) {
              e.preventDefault();
              onOnly();
            }
          }}
          className={`text-xs truncate ${
            checked ? 'text-[var(--lb-body)]' : 'text-[var(--lb-dim)]'
          } group-hover:text-[var(--lb-body)] transition-colors`}
        >
          {label}
        </span>
      </label>
      {onOnly && (
        <button
          type="button"
          onClick={onOnly}
          title="Show only this (Alt-click label)"
          className="text-[9px] text-[var(--lb-dim)] hover:text-[#da7756] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
        >
          only
        </button>
      )}
    </div>
  );
}

/** Small section heading. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase">
      {children}
    </span>
  );
}

/** Section heading: tri-state checkbox + label + a live "N of M" count. Replaces
 *  the old "All · None" text buttons — one click on the checkbox selects all or
 *  clears, and the count is an honest at-a-glance readout of the tri-state. */
function SectionHeader({
  label,
  state,
  selected,
  total,
  onSetAll,
}: {
  label: string;
  state: TriState['state'];
  selected: number;
  total: number;
  onSetAll: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 h-6">
      <TriStateCheckbox state={state} onSetAll={onSetAll} aria-label={`Select all ${label}`} />
      <span className="flex-1 text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase">
        {label}
      </span>
      <span
        className={`text-[10px] tabular-nums ${state === 'all' ? 'text-[var(--lb-dim)]' : 'text-[#da7756]'}`}
        title={`${selected} of ${total} selected`}
      >
        {selected}/{total}
      </span>
    </div>
  );
}

/** Sub-group heading for the Code / Knowledge node-type splits — same anatomy as
 *  SectionHeader but smaller, and indented rows underneath. */
function SubGroupHeader({
  label,
  state,
  selected,
  total,
  onSetAll,
}: {
  label: string;
  state: TriState['state'];
  selected: number;
  total: number;
  onSetAll: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 h-5">
      <TriStateCheckbox
        state={state}
        onSetAll={onSetAll}
        aria-label={`Select all ${label}`}
        className="w-3 h-3 rounded border-[var(--lb-dim)] cursor-pointer focus-visible:ring-1 focus-visible:ring-[#da7756]"
      />
      <span className="text-[10px] text-[var(--lb-dim)] flex-1">{label}</span>
      <span
        className={`text-[9px] tabular-nums ${state === 'all' ? 'text-[var(--lb-dim)]' : 'text-[#da7756]'}`}
        title={`${selected} of ${total} selected`}
      >
        {selected}/{total}
      </span>
    </div>
  );
}

/** Shown under a section/sub-group whose derived state is "none" — nothing in
 *  that category renders, so say so instead of a silently-empty list. */
function EmptySelectionHint({ type }: { type: 'type' | 'project' | 'relation' }) {
  return (
    <span className="text-[10px] text-[#da7756]">
      Nothing visible — select a {type}
    </span>
  );
}

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'community', label: 'Community' },
  { id: 'project', label: 'Project' },
  { id: 'type', label: 'Type' },
];

export default function GraphControls({
  activeNodeTypes,
  onToggleNodeType,
  onSetAllNodeTypes,
  onSetNodeTypeCategory,
  onOnlyNodeType,
  activeEdgeTypes,
  onToggleEdgeType,
  onSetAllEdgeTypes,
  onOnlyEdgeType,
  projects = [],
  activeProjects,
  onToggleProject,
  onSetAllProjects,
  onOnlyProject,
  colorMode = 'community',
  onColorModeChange,
  showFullGraphControls = false,
  searchQuery,
  onSearchChange,
  onSemanticSearch,
  semanticBusy = false,
  focusDepth,
  onFocusDepthChange,
  canFocus,
  nodeCount,
  onRefresh,
}: GraphControlsProps) {
  // Project filter's own search box (only shown when there are enough projects
  // to make scanning the list slow). Purely local UI state — the header
  // tri-state/count always operate on the FULL project list, never this filter.
  const [projectFilter, setProjectFilter] = useState('');
  const filteredProjects = useMemo(() => {
    const q = projectFilter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => shortProjectLabel(p).toLowerCase().includes(q));
  }, [projects, projectFilter]);

  const nodeTypeState = useMemo(
    () => deriveTriState(activeNodeTypes, [...CODE_NODE_TYPES, ...KNOWLEDGE_NODE_TYPES]),
    [activeNodeTypes],
  );
  const codeState = useMemo(() => deriveTriState(activeNodeTypes, CODE_NODE_TYPES), [activeNodeTypes]);
  const knowledgeState = useMemo(
    () => deriveTriState(activeNodeTypes, KNOWLEDGE_NODE_TYPES),
    [activeNodeTypes],
  );
  const edgeTypeState = useMemo(
    () => deriveTriState(activeEdgeTypes, VISIBLE_EDGE_TYPES),
    [activeEdgeTypes],
  );
  const projectState = useMemo(
    () => deriveTriState(activeProjects ?? new Set<string>(), projects),
    [activeProjects, projects],
  );

  return (
    <div className="w-52 shrink-0 border-r border-[var(--lb-border-s)] bg-[var(--lb-card)] flex flex-col p-3 gap-4 overflow-y-auto">
      {/* ── Search (instant substring + Enter→semantic) ── */}
      <div className="flex flex-col gap-1.5">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--lb-dim)] pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) onSemanticSearch(searchQuery.trim());
            }}
            placeholder="Search nodes…"
            className="w-full bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2 py-1.5 pl-7 pr-7 text-xs text-[var(--lb-body)] placeholder-gray-500 focus:outline-none focus:border-[var(--lb-dim)] focus:ring-1 focus:ring-gray-600"
          />
          <button
            type="button"
            title="Semantic search (Enter)"
            disabled={!searchQuery.trim() || semanticBusy}
            onClick={() => onSemanticSearch(searchQuery.trim())}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--lb-dim)] hover:text-violet-300 disabled:opacity-40 disabled:hover:text-[var(--lb-dim)] transition-colors"
          >
            <Sparkles size={13} className={semanticBusy ? 'animate-pulse text-violet-300' : ''} />
          </button>
        </div>
        <span className="text-[10px] text-[var(--lb-dim)] leading-tight">
          Type to filter · Enter for semantic search
        </span>
      </div>

      {/* ── Focus depth ── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Focus Depth</SectionLabel>
        <div className="flex items-center gap-1 rounded bg-[var(--lb-surface)] border border-[var(--lb-border-s)] p-0.5">
          {FOCUS_DEPTHS.map((d) => {
            const active = focusDepth === d;
            const disabled = d !== null && !canFocus;
            return (
              <button
                key={d ?? 'all'}
                type="button"
                disabled={disabled}
                onClick={() => onFocusDepthChange(d)}
                title={
                  d === null
                    ? 'Show the whole graph'
                    : canFocus
                      ? `Focus selected node + ${d} hop${d === 1 ? '' : 's'}`
                      : 'Select a node first'
                }
                className={`flex-1 text-[11px] rounded px-1 py-1 transition-colors ${
                  active
                    ? 'bg-violet-600 text-white'
                    : disabled
                      ? 'text-[var(--lb-dim)] cursor-not-allowed'
                      : 'text-[var(--lb-body)] hover:bg-[var(--lb-border-s)]'
                }`}
              >
                {d === null ? 'All' : d}
              </button>
            );
          })}
        </div>
        {focusDepth !== null && (
          <button
            type="button"
            onClick={() => onFocusDepthChange(null)}
            className="flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-100 self-start transition-colors"
          >
            <X size={11} /> Clear focus
          </button>
        )}
        {!canFocus && focusDepth === null && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--lb-dim)]">
            <Crosshair size={10} /> Select a node to focus
          </span>
        )}
      </div>

      {/* ── Color by (whole-graph view) ── */}
      {showFullGraphControls && onColorModeChange && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Color By</SectionLabel>
          <div className="flex items-center gap-1 rounded bg-[var(--lb-surface)] border border-[var(--lb-border-s)] p-0.5">
            {COLOR_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onColorModeChange(m.id)}
                className={`flex-1 text-[10px] rounded px-1 py-1 transition-colors ${
                  colorMode === m.id ? 'bg-[#da7756] text-white' : 'text-[var(--lb-body)] hover:bg-[var(--lb-border-s)]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Projects filter (whole-graph view) ── */}
      {showFullGraphControls && projects.length > 0 && activeProjects && onToggleProject && onSetAllProjects && (
        <div className="flex flex-col gap-1.5">
          <SectionHeader
            label="Projects"
            state={projectState.state}
            selected={projectState.selected}
            total={projectState.total}
            onSetAll={onSetAllProjects}
          />
          {projects.length > 8 && (
            <div className="relative">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--lb-dim)] pointer-events-none"
              />
              <input
                type="text"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="Filter projects…"
                className="w-full h-6 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2 pl-6 text-xs text-[var(--lb-body)] placeholder-gray-500 focus:outline-none focus:border-[var(--lb-dim)] focus:ring-1 focus:ring-gray-600"
              />
            </div>
          )}
          {filteredProjects.length === 0 ? (
            <span className="text-[10px] text-[var(--lb-dim)]">no matches</span>
          ) : (
            <div className="max-h-60 overflow-y-auto -mr-1 pr-1 flex flex-col gap-1.5">
              {filteredProjects.map((p) => (
                <TypeRow
                  key={p}
                  color={colorMode === 'project' ? colorForKey(p) : 'var(--lb-dim)'}
                  label={shortProjectLabel(p)}
                  checked={activeProjects.has(p)}
                  onToggle={() => onToggleProject(p)}
                  onOnly={onOnlyProject ? () => onOnlyProject(p) : undefined}
                />
              ))}
            </div>
          )}
          {projectState.state === 'none' && <EmptySelectionHint type="project" />}
        </div>
      )}

      {/* ── Node types (legend + filter) ── */}
      <div className="flex flex-col gap-1.5">
        <SectionHeader
          label="Node Types"
          state={nodeTypeState.state}
          selected={nodeTypeState.selected}
          total={nodeTypeState.total}
          onSetAll={onSetAllNodeTypes}
        />
        <SubGroupHeader
          label="Code"
          state={codeState.state}
          selected={codeState.selected}
          total={codeState.total}
          onSetAll={(on) => onSetNodeTypeCategory('code', on)}
        />
        <div className="flex flex-col gap-1.5 pl-4">
          {CODE_NODE_TYPES.map((t) => (
            <TypeRow
              key={t}
              color={NODE_TYPE_META[t].color}
              label={NODE_TYPE_META[t].label}
              checked={activeNodeTypes.has(t)}
              onToggle={() => onToggleNodeType(t)}
              onOnly={() => onOnlyNodeType(t)}
            />
          ))}
          {codeState.state === 'none' && <EmptySelectionHint type="type" />}
        </div>
        <SubGroupHeader
          label="Knowledge"
          state={knowledgeState.state}
          selected={knowledgeState.selected}
          total={knowledgeState.total}
          onSetAll={(on) => onSetNodeTypeCategory('knowledge', on)}
        />
        <div className="flex flex-col gap-1.5 pl-4">
          {KNOWLEDGE_NODE_TYPES.map((t) => (
            <TypeRow
              key={t}
              color={NODE_TYPE_META[t].color}
              label={NODE_TYPE_META[t].label}
              checked={activeNodeTypes.has(t)}
              onToggle={() => onToggleNodeType(t)}
              onOnly={() => onOnlyNodeType(t)}
            />
          ))}
          {knowledgeState.state === 'none' && <EmptySelectionHint type="type" />}
        </div>
      </div>

      {/* ── Edge types (legend + filter) ── */}
      <div className="flex flex-col gap-1.5">
        <SectionHeader
          label="Edge Types"
          state={edgeTypeState.state}
          selected={edgeTypeState.selected}
          total={edgeTypeState.total}
          onSetAll={onSetAllEdgeTypes}
        />
        {VISIBLE_EDGE_TYPES.map((e) => (
          <TypeRow
            key={e}
            color={EDGE_TYPE_META[e].color}
            label={EDGE_TYPE_META[e].label}
            checked={activeEdgeTypes.has(e)}
            onToggle={() => onToggleEdgeType(e)}
            onOnly={() => onOnlyEdgeType(e)}
          />
        ))}
        {edgeTypeState.state === 'none' && <EmptySelectionHint type="relation" />}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Node count badge */}
      <div className="flex items-center justify-center">
        <span className="text-xs text-[var(--lb-subtle)] bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-full px-3 py-1">
          {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
        </span>
      </div>

      {/* Refresh button */}
      <button
        onClick={onRefresh}
        className="flex items-center justify-center gap-1.5 w-full bg-[var(--lb-surface)] hover:bg-[var(--lb-border-s)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] text-[var(--lb-body)] hover:text-[var(--lb-fg)] rounded px-3 py-1.5 text-xs font-medium transition-colors"
      >
        <RefreshCw size={13} />
        Refresh
      </button>
    </div>
  );
}
