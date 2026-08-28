/**
 * parser/types.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * ParsedSymbol, ParsedFile, ParsedRelation type contracts.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * These types are the parser's public output shape. Phase 3 maps them
 * into the developer plugin's existing Kùzu schema (CodeSymbol /
 * CodeFile / CodeRelation tables) via `operations.ts`. Keeping the
 * parser output decoupled from the storage shape lets us evolve either
 * side independently and makes the in-memory model easier to test.
 */

/**
 * Languages supported in the v1 parser. The string value is used as
 * the discriminator on `ParsedFile.language` and as the key into the
 * grammar registry in `parser/grammars.ts`.
 */
export type Language =
    | 'typescript'
    | 'tsx'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'csharp'
    | 'c'
    | 'cpp'
    | 'ruby'
    | 'php'
    | 'kotlin'
    | 'swift'
    // Phase 9 — data-layer languages
    | 'sql'
    | 'graphql'
    | 'prisma'
    | 'aql';

/**
 * Symbol kinds the parser emits. A small fixed vocabulary; per-language
 * walkers map their AST node types onto these.
 */
export type SymbolKind =
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
    // Phase 9 — data-layer kinds
    | 'table'     // SQL table / view, Prisma model, GraphQL type used as schema entity
    | 'query';    // SQL stored procedure/function, GraphQL operation

/**
 * Half-open byte range in the source file: `[start, end)`.
 */
export interface ByteRange {
    /** Inclusive start byte offset. */
    start: number;
    /** Exclusive end byte offset. */
    end: number;
    /** 1-based start line number. */
    startLine: number;
    /** 1-based end line number (inclusive). */
    endLine: number;
}

/**
 * A symbol extracted from source.
 *
 * `id` strategy: `<repoRelativePath>:<qualifiedName>:<kind>`. Stable
 * across re-parses as long as path + qualified name don't change.
 * Renames produce new IDs (Phase 6's rename tool records the mapping
 * explicitly).
 */
export interface ParsedSymbol {
    id: string;
    name: string;
    qualifiedName: string;
    kind: SymbolKind;
    file: string;
    byteRange: ByteRange;
    signature: string;
    complexity: number;
    parentSymbolId: string | null;
    parsedAt: string;
}

/**
 * An import statement extracted from source.
 */
export interface ParsedImport {
    /** Raw module specifier as written in source. */
    moduleSpecifier: string;
    /**
     * Imported names. Empty = side-effect-only. `['*']` = wildcard.
     *
     * Wave 4.6 — kept for back-compat; new code should prefer the
     * bucketed fields below (namedImports / defaultAlias / namespaceAlias)
     * because the resolver needs to distinguish "look up symbol named X
     * in target file" (named) from "alias bound to the whole module"
     * (default / namespace). The flat `names` mixes these and causes
     * the resolver to chase symbol-name matches for default-import
     * aliases that will never exist in the target file.
     */
    names: string[];
    /** Wave 4.6 — names from `import { a, b } from '...'` (these ARE
     *  exported symbols in the target file and should be looked up by name). */
    namedImports?: string[];
    /** Wave 4.6 — local alias from `import X from '...'` (default import).
     *  The alias is the importer's local binding; the export it points to
     *  is `default`, not `X`. */
    defaultAlias?: string | null;
    /** Wave 4.6 — local alias from `import * as X from '...'` (namespace).
     *  Binds the whole module; should resolve to a file-to-file edge,
     *  not a per-symbol wildcard explosion. */
    namespaceAlias?: string | null;
    /** Wave 4.6 — true when this ParsedImport came from a CJS `require()`
     *  call (vs an ESM `import` statement). Resolver/store don't need
     *  this today; it's surfaced for diagnostics. */
    isRequire?: boolean;
    byteRange: ByteRange;
}

/**
 * A call site captured during parsing: a reference to another callable
 * from inside a function/method body. Phase 2.1 — the resolver matches
 * `calleeName` against the symbol table + import graph to produce
 * `calls` edges.
 *
 * `receiverHint` captures the textual receiver for method calls (e.g.,
 * `foo.bar()` → receiverHint = "foo"). Phase 2 doesn't do type
 * inference, so the hint is a heuristic — Phase 9+ Stack Graphs path
 * could turn this into a precise type binding.
 */
export interface ParsedCall {
    /** ParsedSymbol.id of the enclosing function/method (or empty for module-level call sites). */
    callerSymbolId: string;
    /** The callee name as written in source. May be `foo`, `Foo.bar`, `obj.method`, etc. */
    calleeName: string;
    /** Byte range of the call expression. */
    byteRange: ByteRange;
    /** True for method-call shapes (`obj.foo()`); false for free-function calls (`foo()`). */
    isMethodCall: boolean;
    /** For method calls, the receiver text (e.g., `obj` from `obj.foo()`). null otherwise. */
    receiverHint: string | null;
}

/**
 * The full parser output for one file.
 */
export interface ParsedFile {
    path: string;
    language: Language;
    symbols: ParsedSymbol[];
    imports: ParsedImport[];
    /** Phase 2.1: call sites captured during parsing. */
    calls: ParsedCall[];
    sizeBytes: number;
    loc: number;
    parsedAt: string;
}

/**
 * A relationship between two symbols.
 */
export type RelationKind =
    | 'calls'
    | 'imports'
    | 'extends'
    | 'implements'
    | 'contains'
    // Phase 9 — data-layer relations
    | 'queries'   // code symbol → data entity (reads)
    | 'writes'    // code symbol → data entity (writes/mutates)
    | 'references'; // data entity → data entity (FK, JOIN)

export interface ParsedRelation {
    sourceId: string;
    targetId: string;
    kind: RelationKind;
    /** 0..1; 1.0 for direct AST extraction, <1 for heuristic resolves. */
    confidence: number;
    reason: string;
}

/**
 * Diagnostic emitted during parsing. Non-fatal — the walker logs and continues.
 */
export interface ParseDiagnostic {
    file: string;
    severity: 'info' | 'warn' | 'error';
    message: string;
    byteRange?: ByteRange;
}

/**
 * Result of `parseRepo`.
 */
export interface ParseRepoResult {
    files: ParsedFile[];
    diagnostics: ParseDiagnostic[];
    durationMs: number;
    skipped: Array<{ path: string; reason: string }>;
}
