/**
 * nodeView.ts — derive a NodeDetail-shaped GraphNode from a LIVE graphology
 * node's attributes.
 *
 * Extracted from WorkspacePage so the derivation (kind→type mapping, the
 * Sprint-3 degree/neighbors read, and the symbol line-field passthrough) is
 * unit-testable WITHOUT mounting the page (no React / router). The page imports
 * this; tests call it against a hand-built graphology instance.
 *
 * degree + neighbors come straight off the graphology instance (graph.degree /
 * graph.neighbors) — FREE, no backend call. neighbors() reflects the
 * MATERIALIZED adjacency (only nodes already drilled into are present), which is
 * the intended semantics: the inspector mirrors the visible subgraph.
 */

import type Graph from 'graphology';
import type { GraphNode, NodeType } from '../types/graph';

/** Map the controller's drill `kind` onto a schema NodeType the detail panel +
 *  NODE_COLORS understand. Mirrors GraphController.kindToNodeType. */
export function kindToNodeType(kind: string): NodeType {
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

export function liveNodeToGraphNode(
  graph: Graph,
  id: string,
  workspace: string,
): GraphNode | null {
  if (!graph.hasNode(id)) return null;
  const a = graph.getNodeAttributes(id) as Record<string, unknown>;
  const kind = String(a['kind'] ?? 'other');
  const type = kindToNodeType(kind);

  const level = a['level'] as number | undefined;
  const file = a['file'] as string | undefined;
  const truncated = a['truncatedChildren'] === true;
  const contentLines = [
    `id: ${id}`,
    level != null ? `level: ${level} (${kind})` : `kind: ${kind}`,
    file ? `file: ${file}` : null,
    truncated ? '⚠ children truncated — refine to see all' : null,
  ].filter(Boolean);

  // Sprint 3: degree + neighbors are FREE off the live graphology instance.
  const degree = graph.degree(id);
  const neighbors = graph.neighbors(id).map((nId) => ({
    id: nId,
    label: String(graph.getNodeAttribute(nId, 'label') ?? nId),
    kind: String(graph.getNodeAttribute(nId, 'kind') ?? 'other'),
  }));

  return {
    id,
    type,
    label: String(a['label'] ?? id),
    content: contentLines.join('\n'),
    tags: '',
    workspace,
    parentId: a['parentId'] as string | undefined,
    level,
    communityId: a['communityId'] as string | undefined,
    file,
    truncatedChildren: truncated,
    degree,
    neighbors,
    startLine: a['startLine'] as number | undefined,
    endLine: a['endLine'] as number | undefined,
    signature: a['signature'] as string | undefined,
    qualifiedName: a['qualifiedName'] as string | undefined,
  };
}
