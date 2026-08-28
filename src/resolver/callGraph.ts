/**
 * resolver/callGraph.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Call-graph resolver fallback — same-file + imported-function + heuristic method dispatch.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2.1 (call-graph fast-follow).
 *
 * Strategy: each ParsedFile carries a `calls: ParsedCall[]` populated
 * by the per-language walker. Each ParsedCall is a triple of
 * `(callerSymbolId, calleeName, byteRange)` plus a method-call flag
 * and receiver hint. The resolver matches each calleeName against:
 *
 *   0. Receiver-qualified match (`EmbeddedLore.open(x)` → the symbol whose
 *      qualified name is exactly `EmbeddedLore.open`) — the identity a
 *      member call on a class/namespace binding actually names, tried
 *      BEFORE any bare-name matching so common method names (open/close/
 *      get/…) can't collide with unrelated same-file or cross-file symbols
 *   1. Same-file local symbols of CALLABLE kinds only (highest confidence —
 *      direct AST proximity; a call can never target a local variable)
 *   2. Symbols imported into the calling file (resolved via the import
 *      graph context built during Phase 2's resolver pass)
 *   3. Workspace-wide qualified-name match (e.g., `Foo.bar`)
 *   4. Workspace-wide bare-name match, callable + module-level symbols
 *      only (lowest confidence — a bare identifier binds a module-level
 *      name, never another file's class member; we pick the first and
 *      flag low confidence so analytics can weight accordingly)
 *
 * Calls that don't match anywhere are dropped silently in v1; the
 * unresolved-rate is logged at the orchestrator level. Phase 9 (data
 * layer) and a possible future Stack Graphs path can sharpen this.
 */

import type { ParsedFile, ParsedRelation, ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';
import { resolveImport, type ResolutionContext } from './importGraph.js';

interface FileImportTargets {
    /** importedName → resolvedFilePath (where the symbol was imported FROM). */
    namedImports: Map<string, string>;
    /** Wildcard / namespace imports — list of file paths brought in via `import * as ns from ...`. */
    wildcardSources: string[];
}

/**
 * Pre-compute, per file, a name→destinationFile map for resolved
 * imports. Used by the call resolver to handle "this name was imported,
 * so look in that file."
 */
function buildPerFileImportTargets(
    files: readonly ParsedFile[],
    ctx: ResolutionContext,
): Map<string, FileImportTargets> {
    const out = new Map<string, FileImportTargets>();
    for (const file of files) {
        const targets: FileImportTargets = { namedImports: new Map(), wildcardSources: [] };
        for (const imp of file.imports) {
            const resolved = resolveImport(file.path, file.language, imp, ctx);
            if (!resolved) continue;
            if (imp.names.length === 0 || imp.names.includes('*')) {
                targets.wildcardSources.push(resolved);
                continue;
            }
            for (const name of imp.names) {
                if (name === '*') continue;
                targets.namedImports.set(name, resolved);
            }
        }
        out.set(file.path, targets);
    }
    return out;
}
/**
 * Kinds a call expression can actually target. A call site invokes a
 * function, a method, or a constructor (class) — never a local variable,
 * a constant binding, a type, or an interface. The same-file match below
 * used to accept ANY kind, which let `EmbeddedLore.open(...)` resolve to
 * an unrelated local `let open` in the same file (cli.ts's parseArgs),
 * silently swallowing the real edge (and emitting a bogus one).
 */
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'class']);

/** A plain JS/TS identifier — receiver hints like `(await x)` or `a.b` aren't. */
const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Resolve a single ParsedCall to its target ParsedSymbol, using the
 * priority chain documented above. Returns null if no match.
 */
function resolveCall(
    call: ParsedFile['calls'][number],
    callerFile: string,
    table: SymbolTable,
    importTargets: FileImportTargets,
): { target: ParsedSymbol; confidence: number; reason: string } | null {
    const callee = call.calleeName;

    // 0. Receiver-qualified match — `EmbeddedLore.open(x)`, `Foo.bar(x)`.
    // A member call whose receiver is itself a plain identifier names a
    // CLASS/namespace binding in scope; the qualified name `Receiver.callee`
    // is the exact symbol identity. Trying this FIRST (before same-file and
    // bare-name matches) prevents the callee's bare property name from
    // colliding with unrelated same-file locals (variables, other classes'
    // same-named methods) — the `open`-style collision class.
    if (call.isMethodCall
        && call.receiverHint !== null
        && call.receiverHint !== 'this'
        && SIMPLE_IDENTIFIER_RE.test(call.receiverHint)) {
        const qualified = `${call.receiverHint}.${callee}`;
        const candidates = table.byQualifiedName.get(qualified) ?? [];
        if (candidates.length > 0) {
            const viaImport = importTargets.namedImports.get(call.receiverHint);
            const target = candidates.find((s) => s.file === callerFile)
                ?? candidates.find((s) => viaImport !== undefined && s.file === viaImport)
                ?? candidates[0]!;
            return {
                target,
                confidence: 0.95,
                reason: `receiver-qualified match (${qualified}${candidates.length > 1 ? `, ${candidates.length} candidates` : ''})`,
            };
        }
    }

    // 1. Same-file local symbol (callable kinds only — see CALLABLE_KINDS).
    const localCandidates = (table.byFile.get(callerFile)?.get(callee) ?? [])
        .filter((s) => CALLABLE_KINDS.has(s.kind));
    if (localCandidates.length === 1) {
        return {
            target: localCandidates[0]!,
            confidence: 1.0,
            reason: 'same-file local match',
        };
    }
    if (localCandidates.length > 1) {
        // Pick first; method overloads / multiple impls are common.
        return {
            target: localCandidates[0]!,
            confidence: 0.85,
            reason: `same-file with ${localCandidates.length} candidates; picked first`,
        };
    }

    // 2. Imported into this file.
    const importedFromFile = importTargets.namedImports.get(callee);
    if (importedFromFile) {
        const targets = table.byFile.get(importedFromFile)?.get(callee) ?? [];
        if (targets.length > 0) {
            return {
                target: targets[0]!,
                confidence: 0.95,
                reason: `imported from ${importedFromFile}`,
            };
        }
    }

    // 2b. Wildcard import — search every wildcard source for a match.
    for (const wildcardFile of importTargets.wildcardSources) {
        const targets = table.byFile.get(wildcardFile)?.get(callee) ?? [];
        if (targets.length > 0) {
            return {
                target: targets[0]!,
                confidence: 0.8,
                reason: `wildcard import from ${wildcardFile}`,
            };
        }
    }

    // 3. Workspace-wide qualified-name match (e.g. callee was 'Foo.bar').
    const qualMatch = table.byQualifiedName.get(callee);
    if (qualMatch && qualMatch.length > 0) {
        return {
            target: qualMatch[0]!,
            confidence: 0.7,
            reason: `workspace-wide qualified-name match (${qualMatch.length} candidate${qualMatch.length === 1 ? '' : 's'})`,
        };
    }

    // 4. Workspace-wide bare-name match — callable AND module-level only
    // (qualifiedName === name). A bare identifier binds a module-level name
    // in its own file's scope; it can never reference another file's CLASS
    // MEMBER like `EmbeddedLore.open`. Allowing scoped members here matched
    // unrelated same-named calls across the workspace (a Tauri dialog's
    // `open()` in atlas-ui became a caller of `EmbeddedLore.open`).
    // RD-P2 — O(1) lookup via the prebuilt byName index instead of scanning
    // every file's local map (was O(files) per call → O(C·F) overall).
    const bareCandidates: ParsedSymbol[] = table.byName.get(callee) ?? [];
    const callable = bareCandidates.filter(
        (s) => CALLABLE_KINDS.has(s.kind) && s.qualifiedName === s.name,
    );
    if (callable.length > 0) {
        return {
            target: callable[0]!,
            confidence: 0.5,
            reason: `workspace-wide bare-name match (${callable.length} candidates)`,
        };
    }

    return null;
}

/**
 * Build call-graph edges across the workspace. One ParsedRelation
 * (kind=calls) per resolved ParsedCall.
 */
export function buildCallEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): { edges: ParsedRelation[]; resolved: number; unresolved: number } {
    const importTargets = buildPerFileImportTargets(files, ctx);
    const edges: ParsedRelation[] = [];
    let resolved = 0;
    let unresolved = 0;

    for (const file of files) {
        const targetsForFile = importTargets.get(file.path) ?? { namedImports: new Map(), wildcardSources: [] };
        for (const call of file.calls) {
            const match = resolveCall(call, file.path, table, targetsForFile);
            if (!match) {
                unresolved += 1;
                continue;
            }
            resolved += 1;
            edges.push({
                sourceId: call.callerSymbolId,
                targetId: match.target.id,
                kind: 'calls',
                confidence: match.confidence,
                reason: match.reason,
            });
        }
    }

    return { edges, resolved, unresolved };
}
