/**
 * types/graph.ts — UI graph view-model types.
 *
 * ── Sprint 2: NO LONGER the color source of truth ──────────────────────────
 * `NodeType`, `NODE_COLORS`, and `NODE_SIZES` are now DERIVED from the shared
 * schema-display leaf (`@atlas-schema` → backend `src/schema.display.ts`) so the
 * filter rail, legend, and rendered nodes all read ONE canonical palette. The
 * old hand-maintained literals here drifted from the backend (e.g. code_symbol
 * was '#64748b' vs schema '#14b8a6'); deriving them removes that class of bug.
 * `GraphNode`, `AtlasAlert`, and `EdgeClass` stay local — they are UI-only
 * view-model shapes the backend has no opinion about.
 */

import {
  NODE_TYPE_META,
  type NodeType as SchemaNodeType,
} from '@atlas-schema';

/** Re-exported from the shared schema so the whole UI uses the same union. */
export type NodeType = SchemaNodeType;

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  content: string;
  // Lore Tags Pass 3 can hand tags back as string[] (older Lore + the current
  // nodeView use a comma-string); readers must tolerate both.
  tags: string | string[];
  workspace: string;
  createdAt?: string;
  supersededAt?: string;
  // ── B2 drill-down fields (optional; present on hierarchical nodes) ──
  /** Parent node id in the drill-down tree ('' for level-0 community roots). */
  parentId?: string;
  /** Drill-down level: 0 = community, 1 = file, 2 = symbol, 3+ = neighbors. */
  level?: number;
  /** Content-stable string community id (community nodes only) — needed to
   *  re-expand. GF-4: stable across re-index (e.g. "locale~format"). */
  communityId?: string;
  /** Source file path, when known (file/symbol nodes). */
  file?: string;
  /** True iff this node's children slice was truncated (drives the B4 refine
   *  affordance in NodeDetail). */
  truncatedChildren?: boolean;
  // ── Sprint 3 inspector enrichment (read off the live graphology instance /
  //    carried through from atlas_subgraph metadata) ──
  /** Undirected degree on the live graph — graph.degree(id). FREE from the
   *  graphology instance, no backend call. */
  degree?: number;
  /** Immediate neighbors on the live graph — graph.neighbors(id), each with a
   *  display label + drill kind so the inspector can render a clickable list. */
  neighbors?: Array<{ id: string; label: string; kind: string }>;
  /** 1-based first source line (code_symbol nodes — from subgraph metadata). */
  startLine?: number;
  /** 1-based last source line (code_symbol nodes). */
  endLine?: number;
  /** Symbol signature (code_symbol nodes). */
  signature?: string;
  /** Fully-qualified symbol name (code_symbol nodes). */
  qualifiedName?: string;
}

/**
 * Structural class of a code edge. Superseded by the typed `relation` attr +
 * EDGE_TYPE_META (Sprint 2); retained for any legacy reads.
 */
export type EdgeClass = 'containment' | 'call' | 'context';

export interface AtlasAlert {
  /** Optional — alerts_get does NOT return ids. Present only for sources
   *  that synthesize one; UI code must key off type+summary otherwise. */
  id?: string;
  type: 'dead_code' | 'hotspot' | 'schema_drift' | string;
  severity: 'low' | 'medium' | 'high';
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * Per-node-type render color — DERIVED from the shared schema metadata so it
 * cannot drift from what the legend/filter rail shows or what the controller
 * paints. Keyed by the full schema `NodeType` (8 types incl. code_context).
 */
export const NODE_COLORS: Record<NodeType, string> = Object.fromEntries(
  (Object.keys(NODE_TYPE_META) as NodeType[]).map((t) => [t, NODE_TYPE_META[t].color]),
) as Record<NodeType, string>;

/** Per-node-type default render size — likewise derived from the schema. */
export const NODE_SIZES: Record<NodeType, number> = Object.fromEntries(
  (Object.keys(NODE_TYPE_META) as NodeType[]).map((t) => [t, NODE_TYPE_META[t].size]),
) as Record<NodeType, number>;
