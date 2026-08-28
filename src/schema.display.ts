/**
 * schema.display.ts — the PURE-DATA display leaf of Groundfloor Atlas's graph vocabulary.
 *
 * WHY THIS FILE EXISTS (Sprint 2 single-source-of-truth)
 * The Sprint 2 atlas-ui filter rail + legend must render with the EXACT colors,
 * labels, sizes, and type/edge vocabularies the backend graph uses — no drift.
 * The natural home for that is `src/schema.ts`, but `schema.ts` transitively
 * imports backend-only modules (`./parser/types.js`, `./cli/memorySync.js`),
 * which would drag Node16/`.js`-resolved backend code into the Vite bundle.
 *
 * So the canonical DISPLAY metadata lives HERE, in a leaf that imports NOTHING
 * from `parser/` or `cli/`. The structural string-literal unions
 * (`RelationKind`, `SymbolKind`, `KnowledgeType`) are INLINED below (they are
 * erased at compile time anyway) so this file is a truly dependency-free,
 * pure-data module that both builds resolve cleanly:
 *   - backend: `src/schema.ts` re-exports everything here (one import path,
 *     nothing breaks).
 *   - atlas-ui: imports this exact file via the `@atlas-schema` Vite alias.
 *
 * INVARIANT: keep these literal unions in sync with the structural sources
 * (`parser/types.ts` RelationKind/SymbolKind, `cli/memorySync.ts`
 * KNOWLEDGE_TYPES). `src/schema.ts` still imports the structural types from
 * their real homes and will fail to compile if THIS file's `NodeType` /
 * `EdgeType` drift away from them (see the satisfies-style cross-check there).
 */

// ─────────────────────────────────────────────────────────────────────────
// INLINED STRUCTURAL UNIONS (mirror of parser/types.ts + cli/memorySync.ts)
// These are type-only string literals — erased at compile, zero runtime cost,
// zero backend imports.
// ─────────────────────────────────────────────────────────────────────────

/** Mirror of cli/memorySync.ts KNOWLEDGE_TYPES. */
export type KnowledgeTypeLit =
    | 'decision'
    | 'convention'
    | 'bug_pattern'
    | 'troubleshooting'
    | 'architecture';

/** Mirror of parser/types.ts RelationKind. */
export type RelationKindLit =
    | 'calls'
    | 'imports'
    | 'extends'
    | 'implements'
    | 'contains'
    | 'queries'
    | 'writes'
    | 'references';

/** Mirror of parser/types.ts SymbolKind. */
export type SymbolKindLit =
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'enum'
    | 'constant'
    | 'variable'
    | 'type'
    | 'module'
    | 'decorator'
    | 'table'
    | 'query';

/** The 5 curated knowledge node types. */
export const KNOWLEDGE_TYPES = [
    'decision',
    'convention',
    'bug_pattern',
    'troubleshooting',
    'architecture',
] as const satisfies readonly KnowledgeTypeLit[];

// ─────────────────────────────────────────────────────────────────────────
// NODE TYPES
// ─────────────────────────────────────────────────────────────────────────

/** Code-typed nodes Groundfloor Atlas writes (store/codeNodes.ts).
 *  GF-3 adds `code_folder` (the synthesized directory tree) and `code_import`
 *  (one node per external/unresolved module, deduped across the workspace). */
export const CODE_NODE_TYPES = ['code_file', 'code_symbol', 'code_context', 'code_folder', 'code_import'] as const;
export type CodeNodeType = typeof CODE_NODE_TYPES[number];

/** Full node-type union: 5 knowledge + 3 code. */
export const NODE_TYPES = [...KNOWLEDGE_TYPES, ...CODE_NODE_TYPES] as const;
export type NodeType = KnowledgeTypeLit | CodeNodeType;

export interface NodeTypeMeta {
    /** Display label for legend / filter rail. */
    label: string;
    /** Hex color (mockup palette). */
    color: string;
    /** Icon name (lucide-style; the UI maps these). */
    icon: string;
    /** Coarse grouping for the two-section filter rail. */
    category: 'code' | 'knowledge';
    /** Default node radius for the force graph (absorbed from NODE_SIZES). */
    size: number;
}

/**
 * Per-node-type display metadata. Colors are the canonical palette
 * (absorbs atlas-ui NODE_COLORS/NODE_SIZES). community=purple is a UI-only
 * drill-down root style equal to schema `architecture` (#8b5cf6).
 */
export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
    // ── knowledge ──
    decision:        { label: 'Decision',        color: '#3b82f6', icon: 'git-branch', category: 'knowledge', size: 12 },
    convention:      { label: 'Convention',      color: '#22c55e', icon: 'ruler',      category: 'knowledge', size: 9 },
    bug_pattern:     { label: 'Bug Pattern',     color: '#ef4444', icon: 'bug',        category: 'knowledge', size: 11 },
    troubleshooting: { label: 'Troubleshooting', color: '#f59e0b', icon: 'wrench',     category: 'knowledge', size: 9 },
    architecture:    { label: 'Architecture',    color: '#8b5cf6', icon: 'layout',     category: 'knowledge', size: 13 },
    // ── code ──
    code_file:       { label: 'File',            color: '#06b6d4', icon: 'file-code',  category: 'code',      size: 8 },
    code_symbol:     { label: 'Symbol',          color: '#14b8a6', icon: 'box',        category: 'code',      size: 6 },
    code_context:    { label: 'Context',         color: '#a78bfa', icon: 'sparkles',   category: 'code',      size: 5 },
    // GF-3 — folder = yellow (#eab308, distinct from file cyan / symbol teal /
    // context violet, and from the troubleshooting amber #f59e0b); import =
    // emerald (#10b981, distinct from the `imports` EDGE hue #34d399 so the
    // external-module node is not confused with an import edge).
    code_folder:     { label: 'Folder',          color: '#eab308', icon: 'folder',     category: 'code',      size: 9 },
    code_import:     { label: 'Import',          color: '#10b981', icon: 'package',    category: 'code',      size: 6 },
};

// ─────────────────────────────────────────────────────────────────────────
// EDGE TYPES
// ─────────────────────────────────────────────────────────────────────────

/** The real `RelationKind` values the parser/resolver emit. */
export const CODE_RELATION_KINDS = [
    'calls',
    'imports',
    'extends',
    'implements',
    'contains',
    'queries',
    'writes',
    'references',
] as const satisfies readonly RelationKindLit[];

/** Synthetic semantic-bridge relation: code_context cards → their file/symbol. */
export const CONTEXT_RELATION = 'describes' as const;

/** Legacy `related_to` (pre-Sprint-1 collapse + free knowledge↔knowledge edges). */
export const LEGACY_RELATION = 'related_to' as const;

/** Community-drill structural relation: GraphController synthesizes inter-
 *  community `depends_on` edges in the drill view. NOT parser-emitted, but it
 *  IS a real Lore relation — and it must be in the display vocab or the edge
 *  filter hides those edges with no rail control to bring them back. */
export const COMMUNITY_RELATION = 'depends_on' as const;

/** Full edge-type union: real code kinds + context bridge + legacy +
 *  the community-drill structural relation. */
export const EDGE_TYPES = [
    ...CODE_RELATION_KINDS,
    CONTEXT_RELATION,
    LEGACY_RELATION,
    COMMUNITY_RELATION,
] as const;
export type EdgeType = typeof EDGE_TYPES[number];

const EDGE_TYPE_SET: ReadonlySet<string> = new Set<string>(EDGE_TYPES);
const CODE_RELATION_SET: ReadonlySet<string> = new Set<string>(CODE_RELATION_KINDS);

/** True iff `s` is one of the real parser `RelationKind` values. */
export function isCodeRelationKind(s: string): s is RelationKindLit {
    return CODE_RELATION_SET.has(s);
}

/** True iff `s` is any known edge type (code kind, context bridge, or legacy). */
export function isKnownEdgeType(s: string): s is EdgeType {
    return EDGE_TYPE_SET.has(s);
}

export interface EdgeTypeMeta {
    label: string;
    color: string;
    category: 'code' | 'knowledge';
    /** True for `related_to` — kept for back-compat reads, greyed in legends. */
    legacy?: boolean;
}

/**
 * Per-edge-type display metadata for the Sprint-2 legend. Distinct hue per
 * code edge type so a typed graph is legible at a glance.
 */
export const EDGE_TYPE_META: Record<EdgeType, EdgeTypeMeta> = {
    calls:      { label: 'calls',      color: '#60a5fa', category: 'code' }, // blue
    imports:    { label: 'imports',    color: '#34d399', category: 'code' }, // emerald
    extends:    { label: 'extends',    color: '#f472b6', category: 'code' }, // pink
    implements: { label: 'implements', color: '#c084fc', category: 'code' }, // purple
    contains:   { label: 'contains',   color: '#94a3b8', category: 'code' }, // slate (structural)
    queries:    { label: 'queries',    color: '#fbbf24', category: 'code' }, // amber
    writes:     { label: 'writes',     color: '#fb923c', category: 'code' }, // orange
    references: { label: 'references', color: '#22d3ee', category: 'code' }, // cyan
    describes:  { label: 'describes', color: '#a78bfa', category: 'code' }, // violet (context bridge)
    depends_on: { label: 'depends on', color: '#64748b', category: 'code' }, // dark slate (community drill)
    related_to: { label: 'related',    color: '#475569', category: 'knowledge', legacy: true }, // grey
};

/**
 * Coarse display bucket — the old UI `EdgeClass`, derived from the real edge
 * type so callers that only want call/containment/context can group.
 */
export type EdgeDisplayClass = 'containment' | 'call' | 'context' | 'data' | 'inherit' | 'other';

export function edgeDisplayClass(relation: string): EdgeDisplayClass {
    switch (relation) {
        case 'contains':
            return 'containment';
        case 'calls':
        case 'imports':
            return 'call';
        case 'extends':
        case 'implements':
            return 'inherit';
        case 'queries':
        case 'writes':
        case 'references':
            return 'data';
        case CONTEXT_RELATION:
            return 'context';
        default:
            return 'other';
    }
}

// ─────────────────────────────────────────────────────────────────────────
// SYMBOL KINDS
// ─────────────────────────────────────────────────────────────────────────

/** The 12 `SymbolKind` values, enumerated for the symbol-level filter rail. */
export const SYMBOL_KINDS = [
    'function',
    'method',
    'class',
    'interface',
    'enum',
    'constant',
    'variable',
    'type',
    'module',
    'decorator',
    'table',
    'query',
] as const satisfies readonly SymbolKindLit[];

export interface SymbolKindMeta {
    label: string;
    icon: string;
}

export const SYMBOL_KIND_META: Record<SymbolKindLit, SymbolKindMeta> = {
    function:  { label: 'Function',  icon: 'function-square' },
    method:    { label: 'Method',    icon: 'function-square' },
    class:     { label: 'Class',     icon: 'box' },
    interface: { label: 'Interface', icon: 'shapes' },
    enum:      { label: 'Enum',      icon: 'list' },
    constant:  { label: 'Constant',  icon: 'lock' },
    variable:  { label: 'Variable',  icon: 'variable' },
    type:      { label: 'Type',      icon: 'type' },
    module:    { label: 'Module',    icon: 'package' },
    decorator: { label: 'Decorator', icon: 'at-sign' },
    table:     { label: 'Table',     icon: 'table' },
    query:     { label: 'Query',     icon: 'database' },
};
