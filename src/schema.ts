/**
 * schema.ts — Groundfloor Atlas's SINGLE SOURCE OF TRUTH for graph vocabulary.
 *
 * Before this module the vocab was scattered:
 *   - KNOWLEDGE_TYPES        → cli/memorySync.ts
 *   - RelationKind           → parser/types.ts
 *   - SymbolKind             → parser/types.ts
 *   - NODE_COLORS/NODE_SIZES → atlas-ui/src/types/graph.ts
 *   - inferKind (×2 copies)  → mcp/loreReader.ts + mcp/codeContext.ts
 *   - KNOWLEDGE_TYPE_SET dup → graph/subgraph.ts
 *
 * This file ABSORBS / RE-EXPORTS those so backend consumers AND the
 * (Sprint 2) UI filter-rail + legend both import ONE canonical set.
 *
 * ── Sprint 2 SPLIT ─────────────────────────────────────────────────────────
 * All the PURE-DATA display metadata (NODE_TYPE_META, EDGE_TYPE_META, the
 * `as const` vocab arrays, edgeDisplayClass, …) now lives in the dependency-
 * free leaf `./schema.display.ts`, which imports NOTHING from `parser/` or
 * `cli/`. The atlas-ui Vite build imports that leaf directly (via the
 * `@atlas-schema` alias) so the legend/filter colors match the rendered graph
 * by construction, WITHOUT dragging backend-only modules into the browser
 * bundle. This file re-exports the leaf verbatim, so every backend import path
 * (`from './schema.js'`) keeps working unchanged.
 *
 * Re-export discipline: parser/types.ts stays the STRUCTURAL source of
 * `RelationKind` / `SymbolKind`; cli/memorySync.ts keeps `KnowledgeType`.
 * schema.ts re-exports those plus the display leaf. The DRIFT GUARD below is a
 * compile-time assertion that the leaf's literal unions still equal the
 * structural ones — if parser/types.ts adds a RelationKind and the leaf isn't
 * updated, `tsc` fails here.
 */

import type { RelationKind, SymbolKind } from './parser/types.js';
import type { KnowledgeType } from './cli/memorySync.js';
import { CODE_RELATION_KINDS } from './schema.display.js';
import type {
    RelationKindLit,
    SymbolKindLit,
    KnowledgeTypeLit,
    NodeType as DisplayNodeType,
    EdgeType as DisplayEdgeType,
} from './schema.display.js';

const CODE_RELATION_KIND_SET: ReadonlySet<string> = new Set<string>(CODE_RELATION_KINDS);

// Re-export the structural unions so consumers can import from ONE place.
export type { RelationKind, SymbolKind } from './parser/types.js';
export { KNOWLEDGE_TYPES } from './cli/memorySync.js';
export type { KnowledgeType } from './cli/memorySync.js';

// Re-export ALL pure-data display metadata from the dependency-free leaf. This
// is the single source the atlas-ui legend/filter rail also imports.
export {
    CODE_NODE_TYPES,
    NODE_TYPES,
    NODE_TYPE_META,
    CODE_RELATION_KINDS,
    CONTEXT_RELATION,
    LEGACY_RELATION,
    EDGE_TYPES,
    isCodeRelationKind,
    isKnownEdgeType,
    EDGE_TYPE_META,
    edgeDisplayClass,
    SYMBOL_KINDS,
    SYMBOL_KIND_META,
} from './schema.display.js';
export type {
    CodeNodeType,
    NodeType,
    NodeTypeMeta,
    EdgeType,
    EdgeTypeMeta,
    EdgeDisplayClass,
    SymbolKindMeta,
} from './schema.display.js';

// ─────────────────────────────────────────────────────────────────────────
// DRIFT GUARD — compile-time assertion that the display leaf's inlined string
// unions still equal the STRUCTURAL sources (parser/types.ts + memorySync.ts).
// `Expect<Equal<A,B>>` evaluates to `never` (and errors) if A ≠ B, so adding a
// RelationKind/SymbolKind/KnowledgeType in the structural source without
// mirroring it in schema.display.ts breaks the build here, not silently.
// ─────────────────────────────────────────────────────────────────────────

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// These three lines fail to compile if the leaf drifts from the structural unions.
type _RelationKindParity = Expect<Equal<RelationKind, RelationKindLit>>;
type _SymbolKindParity = Expect<Equal<SymbolKind, SymbolKindLit>>;
type _KnowledgeTypeParity = Expect<Equal<KnowledgeType, KnowledgeTypeLit>>;

// The display NodeType/EdgeType remain the canonical exported names; alias them
// against the structural composition so a future structural change surfaces.
type _DisplayNodeTypeIncludesKnowledge = Expect<
    Equal<Extract<DisplayNodeType, KnowledgeType>, KnowledgeType>
>;
type _DisplayEdgeTypeIncludesRelation = Expect<
    Equal<Extract<DisplayEdgeType, RelationKind>, RelationKind>
>;

// Suppress "declared but never used" — these are intentionally type-level only.
export type _SchemaParityChecks = [
    _RelationKindParity,
    _SymbolKindParity,
    _KnowledgeTypeParity,
    _DisplayNodeTypeIncludesKnowledge,
    _DisplayEdgeTypeIncludesRelation,
];

/**
 * CANONICAL relation normalizer — the ONE copy. Both mcp/loreReader.ts and
 * mcp/codeContext.ts import this so their previously byte-identical local
 * `inferKind` copies can't drift.
 *
 * Given a stored Lore edge `relation` string, return the `RelationKind` it
 * represents for analytics (call_graph / blast_radius / dead_code / etc.):
 *
 *   1. A real `RelationKind` (typed Sprint-1 graph) → returned VERBATIM.
 *   2. A legacy alias (`called_by`, `refers_to`) → mapped.
 *   3. Legacy `related_to` (pre-Sprint-1 collapse) or anything unknown →
 *      defaults to `calls` — the lossy-but-most-useful default that keeps
 *      legacy symbol→symbol edges flowing into the call graph.
 *
 * Back-compat invariant: a graph indexed before Sprint 1 has only
 * `related_to` symbol→symbol edges; those must still classify as `calls`.
 */
export function inferRelationKind(rel: string): RelationKind {
    // 1. Already a real kind → passthrough (Sprint-1 typed graph).
    //    (Inlined membership check; isCodeRelationKind narrows to the leaf's
    //    RelationKindLit which is structurally identical to RelationKind.)
    if (CODE_RELATION_KIND_SET.has(rel)) return rel as RelationKind;
    // 2. Legacy aliases (older edge vocabularies / inbound-direction labels).
    if (rel === 'called_by') return 'calls';
    if (rel === 'refers_to') return 'imports';
    // 3. Legacy `related_to` collapse + any unknown → most-useful default.
    return 'calls';
}
