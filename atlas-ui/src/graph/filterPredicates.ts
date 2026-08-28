/**
 * filterPredicates.ts — the PURE filter logic behind the Sprint-2 reducer.
 *
 * The Sigma node/edge reducers in AtlasGraph.tsx are framework-bound (they call
 * sigma.setSetting and read off a live graph), so the load-bearing DECISIONS —
 * "is this node hidden by the active type filter / focus set?" and "is this edge
 * hidden by the active relation filter?" — are factored out HERE as pure
 * functions over plain attr records. That makes them unit-testable with no Sigma
 * and keeps the reducer a thin adapter. AtlasGraph imports these so the tested
 * predicate IS the one that runs in production.
 */

import { kindToNodeType, type NodeKind } from './GraphController';

/**
 * Resolve a node's schema `NodeType` (as a string) for filtering. Expanded
 * children carry the raw backend `nodeType` attr; community/file roots set only
 * `kind` (the controller writes `nodeType` ONLY in the child-merge path), so
 * fall back to the `kind → NodeType` map. The SAME resolver backs the node's
 * color and its legend swatch, so the filter toggle that hides a node, the
 * node's color, and its legend entry all agree.
 */
export function resolveNodeType(data: Record<string, unknown>): string {
  const raw = data['nodeType'];
  if (typeof raw === 'string' && raw) return raw;
  return kindToNodeType((data['kind'] as NodeKind) ?? 'other');
}

/**
 * A node is hard-hidden iff:
 *   - a focus set is active and the node is NOT in it, OR
 *   - not all node types are active AND the node's resolved type is deselected.
 *
 * `allTypesActive` is passed in (computed once per reducer pass) so the common
 * "no type filter" case skips the resolveNodeType call entirely.
 */
export function isNodeFilteredOut(
  id: string,
  data: Record<string, unknown>,
  opts: {
    focusSet: ReadonlySet<string> | null;
    activeNodeTypes: ReadonlySet<string>;
    allTypesActive: boolean;
  },
): boolean {
  if (opts.focusSet && !opts.focusSet.has(id)) return true;
  if (!opts.allTypesActive && !opts.activeNodeTypes.has(resolveNodeType(data))) return true;
  return false;
}

/**
 * An edge is hard-hidden BY ITS RELATION iff not all edge types are active and
 * its `relation` attr is deselected. (Endpoint-driven hiding — an edge whose
 * node is filtered out — is handled in the reducer, which has graph access.)
 */
export function isEdgeFilteredOut(
  relation: string,
  opts: { activeEdgeTypes: ReadonlySet<string>; allEdgesActive: boolean },
): boolean {
  if (opts.allEdgesActive) return false;
  if (!relation) return false; // untyped edges are never hidden by relation filter
  return !opts.activeEdgeTypes.has(relation);
}
