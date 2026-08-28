/**
 * nodeTypeCategories.ts — the single definition of which NodeTypes belong to
 * the "Code" vs "Knowledge" category, derived from the schema's NODE_TYPE_META.
 *
 * Both the filter rail (GraphControls — renders the two grouped sections) and
 * the page reducer (WorkspacePage — `handleSetNodeTypeCategory`, which
 * unions/subtracts one category into `activeNodeTypes` without touching the
 * other) MUST agree on this partition. Defining it once here and importing it in
 * both places prevents the two from drifting: a category-select in the header
 * always toggles exactly the rows that render under that heading.
 *
 * Note: the schema leaf also exports a raw `CODE_NODE_TYPES` literal tuple; these
 * arrays are the render-ordered, category-filtered views over NODE_TYPES used by
 * the UI, kept here so the UI has one source of truth for the split.
 */

import { NODE_TYPE_META, NODE_TYPES, type NodeType } from '@atlas-schema';

/** NodeTypes in the "code" category, in NODE_TYPES render order. */
export const CODE_NODE_TYPES: readonly NodeType[] = NODE_TYPES.filter(
  (t) => NODE_TYPE_META[t].category === 'code',
);

/** NodeTypes in the "knowledge" category, in NODE_TYPES render order. */
export const KNOWLEDGE_NODE_TYPES: readonly NodeType[] = NODE_TYPES.filter(
  (t) => NODE_TYPE_META[t].category === 'knowledge',
);

/** Resolve a category key to its NodeType list (used by the union/subtract handler). */
export function nodeTypesForCategory(category: 'code' | 'knowledge'): readonly NodeType[] {
  return category === 'code' ? CODE_NODE_TYPES : KNOWLEDGE_NODE_TYPES;
}
