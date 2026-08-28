/**
 * resolver/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Orchestrator: routes each file's resolution work and merges results
 * into a single edge stream.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Public API:
 *   - resolveRepo(repoRoot, parsedFiles): Promise<ResolveResult>
 *
 * Strategy (locked at Phase 2 kickoff):
 *
 *   The plan originally proposed Stack Graphs as the primary cross-file
 *   resolver. At Phase 2 kickoff (2026-04-30) we audited the JS/WASM
 *   binding situation and confirmed: github/stack-graphs has only Rust
 *   crates today; the npm `tree-sitter-stack-graphs` package is a
 *   placeholder with no `main` entry and no working JS interface. The
 *   two options were (a) add a Rust sidecar binary as a build-time +
 *   ship-time dependency, or (b) use the per-language fallback
 *   resolver shims the plan already documented as the alternative.
 *
 *   Decision: ship (b) for v1. Stack Graphs becomes a future
 *   enhancement when interface-dispatch / generic-type resolution
 *   becomes a measurable bottleneck. Recorded in PHASE_2_OUTPUT.md.
 *
 * What v1 produces:
 *   - Symbol table (workspace-wide + per-file).
 *   - Import edges for TypeScript / JavaScript / Python.
 *   - Inheritance edges (extends / implements) — landed in inheritance.ts.
 *   - Containment edges (parent → child) — derived from parentSymbolId
 *     chains the parser already produces.
 *
 * Deferred to Phase 2 fast-follow (separate PR after this one merges):
 *   - Call graph edges. Requires extending the per-language walkers to
 *     emit call sites alongside ParsedSymbol (i.e., capture every
 *     `call_expression` / `function_call` / `method_invocation` node
 *     as a (callerSymbolId, calleeName, byteRange) triple). The
 *     resolver matches calleeName against the symbol table + import
 *     graph to produce ParsedRelation[kind=calls] edges. ~3 days
 *     across all 8 languages.
 *
 * The fast-follow split keeps Phase 2 v1 shippable end-to-end without
 * reworking every walker.
 */

import type { ParsedFile, ParsedRelation } from '../parser/types.js';
import {
    buildSymbolTable,
    type SymbolTable,
} from './symbolTable.js';
import {
    buildResolutionContext,
    buildImportEdges,
    type ResolutionContext,
} from './importGraph.js';
import { buildInheritanceEdges } from './inheritance.js';
import { buildCallEdges } from './callGraph.js';
import { buildDataLayerEdges } from './dataLayerLinker.js';

export interface ResolveResult {
    table: SymbolTable;
    context: ResolutionContext;
    relations: ParsedRelation[];
    diagnostics: string[];
    /** Counts for observability. */
    counts: {
        symbols: number;
        files: number;
        importEdges: number;
        importsResolved: number;
        importsUnresolved: number;
        inheritanceEdges: number;
        containsEdges: number;
        callEdges: number;
        callsResolved: number;
        callsUnresolved: number;
        dataLayerEdges: number;
        durationMs: number;
    };
}

export async function resolveRepo(
    repoRoot: string,
    parsedFiles: readonly ParsedFile[],
): Promise<ResolveResult> {
    const startedAt = Date.now();
    const diagnostics: string[] = [];

    // 1. Symbol table.
    const table = buildSymbolTable(parsedFiles);

    // 2. Resolution context (tsconfig paths, file set).
    const context = await buildResolutionContext(repoRoot, parsedFiles);

    // 3. Import edges.
    const importResult = buildImportEdges(parsedFiles, table, context);

    // 4. Inheritance edges.
    const inheritanceEdges = buildInheritanceEdges(parsedFiles, table);

    // 5. Containment edges (parent → child) — derived from parentSymbolId.
    const containsEdges: ParsedRelation[] = [];
    for (const sym of table.all) {
        if (sym.parentSymbolId) {
            containsEdges.push({
                sourceId: sym.parentSymbolId,
                targetId: sym.id,
                kind: 'contains',
                confidence: 1.0,
                reason: 'parser parentSymbolId chain',
            });
        }
    }

    // 6. Call edges (Phase 2.1).
    const callResult = buildCallEdges(parsedFiles, table, context);

    // 7. Data-layer edges (Phase 9b) — code→table queries/writes links.
    const dataLayerResult = buildDataLayerEdges(repoRoot, parsedFiles, table);

    const relations: ParsedRelation[] = [
        ...importResult.edges,
        ...inheritanceEdges,
        ...containsEdges,
        ...callResult.edges,
        ...dataLayerResult.edges,
    ];

    return {
        table,
        context,
        relations,
        diagnostics,
        counts: {
            symbols: table.all.length,
            files: parsedFiles.length,
            importEdges: importResult.edges.length,
            importsResolved: importResult.resolved,
            importsUnresolved: importResult.unresolved,
            inheritanceEdges: inheritanceEdges.length,
            containsEdges: containsEdges.length,
            callEdges: callResult.edges.length,
            callsResolved: callResult.resolved,
            callsUnresolved: callResult.unresolved,
            dataLayerEdges: dataLayerResult.linked,
            durationMs: Date.now() - startedAt,
        },
    };
}

/**
 * Sprint 1 (typed code edges) — assemble the FULL symbol→symbol relation set
 * (imports + inheritance + contains + calls) from already-parsed files plus a
 * pre-built symbol table and resolution context.
 *
 * The Lore-writing indexers (cli.ts, mcp/tools/index.ts)
 * previously threaded ONLY `buildCallEdges(...).edges` into the store, so
 * `imports` / `extends` / `implements` / symbol-level `contains` never
 * reached `store/codeNodes.ts` as typed edges. This helper gives them the
 * full set without re-parsing or re-reading the disk (they already hold
 * `table` + `ctx`). Mirrors `resolveRepo`'s relation assembly minus the
 * data-layer pass (which needs the repo root for SQL/Prisma discovery and
 * is not yet threaded through the single-file watcher path).
 *
 * NOTE: `contains` edges here are the parent→child SYMBOL edges (derived
 * from `parentSymbolId`). The file→symbol structural containment edge is
 * written separately by store/codeNodes.ts as its own `contains` edge.
 */
export function buildAllCodeEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): ParsedRelation[] {
    const importEdges = buildImportEdges(files, table, ctx).edges;
    const inheritanceEdges = buildInheritanceEdges(files, table);
    const containsEdges: ParsedRelation[] = [];
    for (const sym of table.all) {
        if (sym.parentSymbolId) {
            containsEdges.push({
                sourceId: sym.parentSymbolId,
                targetId: sym.id,
                kind: 'contains',
                confidence: 1.0,
                reason: 'parser parentSymbolId chain',
            });
        }
    }
    const callEdges = buildCallEdges(files, table, ctx).edges;
    return [...importEdges, ...inheritanceEdges, ...containsEdges, ...callEdges];
}

/**
 * GF-3 — the set of EXTERNAL/unresolved module specifiers across `files`
 * (deduped). Drives the once-per-repo `code_import` node emit in the batch
 * drivers (cli.ts / mcp/tools/index.ts). The file→import EDGES already flow
 * through `buildAllCodeEdges` → `groupRelationsBySourceFile` per file; only the
 * NODES need this whole-repo collection (a module imported by N files is ONE
 * node). Thin wrapper over buildImportEdges so externality stays defined in the
 * one place that holds the ResolutionContext.
 */
export function collectExternalModules(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): Set<string> {
    return buildImportEdges(files, table, ctx).externalModules;
}

/**
 * Sprint 1 — group a flat ParsedRelation[] by the SOURCE file path so the
 * batch indexers can hand each `buildIndexBatch` call only its own file's
 * edges. Resolves the source file from either:
 *   - a symbol-id source (`<path>:<qname>:<kind>`) → table.byId → sym.file
 *   - a `file:<path>` source (import edges emit file-level endpoints) →
 *     the embedded path.
 * Edges whose source resolves to neither are dropped (best-effort — they'll
 * be retried whenever the target file is indexed from its own side).
 */
export function groupRelationsBySourceFile(
    relations: readonly ParsedRelation[],
    table: SymbolTable,
): Map<string, ParsedRelation[]> {
    const byFile = new Map<string, ParsedRelation[]>();
    for (const rel of relations) {
        let file: string | undefined;
        if (rel.sourceId.startsWith('file:')) {
            file = rel.sourceId.slice('file:'.length);
        } else {
            file = table.byId.get(rel.sourceId)?.file;
        }
        if (!file) continue;
        const list = byFile.get(file);
        if (list) list.push(rel);
        else byFile.set(file, [rel]);
    }
    return byFile;
}

// Re-exports for callers that want lower-level access.
export { buildSymbolTable, lookupByQualifiedName, lookupInFile } from './symbolTable.js';
export type { SymbolTable } from './symbolTable.js';
export { buildResolutionContext, buildImportEdges, resolveImport } from './importGraph.js';
export type { ResolutionContext } from './importGraph.js';
export { buildInheritanceEdges } from './inheritance.js';
export { buildCallEdges } from './callGraph.js';
export { buildDataLayerEdges } from './dataLayerLinker.js';
