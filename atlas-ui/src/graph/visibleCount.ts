/**
 * visibleCount.ts — how many loaded nodes/edges are ACTUALLY visible under
 * the active hard filters (type/focus/project/relation), as a pure function.
 *
 * The WorkspacePage header used to report `graph.order`/`graph.size` — the
 * LOADED counts — so the "N nodes in view" readout never changed when the
 * user filtered the graph (verified live: empty canvas at 0/10 types, header
 * still said 17). This applies the SAME predicates the Sigma reducer runs
 * (filterPredicates.ts — one tested source of truth) so the number the user
 * reads matches what's on the canvas.
 *
 * Framework-light: takes the graphology instance but only iterates it; the
 * decisions all live in filterPredicates.
 */

import type Graph from 'graphology';
import { isNodeFilteredOut, isEdgeFilteredOut } from './filterPredicates';

export interface VisibleCountInput {
  focusSet: ReadonlySet<string> | null;
  activeNodeTypes: ReadonlySet<string>;
  allTypesActive: boolean;
  activeEdgeTypes: ReadonlySet<string>;
  allEdgesActive: boolean;
  /** Project filter (full-graph mode only, same as the reducer). */
  activeProjects?: ReadonlySet<string>;
  allProjectCount?: number;
}

export function countVisible(graph: Graph, opts: VisibleCountInput): { nodes: number; edges: number } {
  const projectFilterActive =
    opts.activeProjects != null &&
    typeof opts.allProjectCount === 'number' &&
    opts.allProjectCount > 0 &&
    opts.activeProjects.size < opts.allProjectCount;

  const hiddenNode = (id: string, data: Record<string, unknown>): boolean => {
    if (isNodeFilteredOut(id, data, { focusSet: opts.focusSet, activeNodeTypes: opts.activeNodeTypes, allTypesActive: opts.allTypesActive })) return true;
    if (projectFilterActive) {
      const proj = data['project'] != null ? String(data['project']) : '';
      if (proj && !opts.activeProjects!.has(proj)) return true;
    }
    return false;
  };

  let nodes = 0;
  graph.forEachNode((id, attrs) => { if (!hiddenNode(id, attrs)) nodes += 1; });

  let edges = 0;
  graph.forEachEdge((_edge, attrs, source, target, sourceAttrs, targetAttrs) => {
    if (isEdgeFilteredOut(String(attrs['relation'] ?? ''), { activeEdgeTypes: opts.activeEdgeTypes, allEdgesActive: opts.allEdgesActive })) return;
    if (hiddenNode(source, sourceAttrs) || hiddenNode(target, targetAttrs)) return;
    edges += 1;
  });

  return { nodes, edges };
}
