/**
 * analytics/deadCode.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Zero-inbound symbols — filtered for exports + entry points.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Identifies symbols with zero inbound `calls` or `imports` edges.
 * Filters to "called" kinds (function / method / class) to avoid
 * flagging type aliases, constants, and other declaration shapes.
 *
 * Heuristic exemptions (since we can't perfectly detect entry points):
 *   - Symbols whose name matches an entry-point pattern (main, run,
 *     handler, default exports, register*) are NOT flagged.
 *   - Symbols whose qualifiedName ends with `.test` / `.spec` / matches
 *     test-file conventions are NOT flagged.
 *
 * Caller can pass a custom `isExempt` predicate to extend or replace
 * the defaults.
 */

import type { ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

const DEFAULT_ENTRY_NAMES = new Set([
    'main', 'run', 'start', 'init', 'register', 'default', 'index',
    'handler', 'handle', 'execute', 'serve', 'listen', 'bootstrap',
]);

function defaultIsExempt(sym: ParsedSymbol, table?: SymbolTable): boolean {
    if (DEFAULT_ENTRY_NAMES.has(sym.name)) return true;
    if (sym.name.startsWith('register')) return true;
    if (sym.file.includes('/test/') || sym.file.includes('.test.') || sym.file.includes('.spec.')) return true;
    // Nested callables scoped inside another FUNCTION/METHOD (closures,
    // object-literal handler properties like `buildRegistry.atlas_call_graph`)
    // are data-reachable through their parent — registered into handler maps,
    // passed by reference, or dispatched dynamically — none of which the
    // static call graph can see. Their parent's `contains` edge is the only
    // honest inbound signal; treat it as referenced. Class members keep the
    // full dead-code treatment (their parent is a class, not a function).
    if (table && sym.parentSymbolId) {
        const parent = table.byId.get(sym.parentSymbolId);
        if (parent && (parent.kind === 'function' || parent.kind === 'method')) return true;
    }
    return false;
}

export interface DeadCodeReport {
    /** Symbols flagged as potentially dead. */
    candidates: ParsedSymbol[];
    /** Stats for observability. */
    stats: {
        scanned: number;
        flagged: number;
        exempt: number;
    };
}
export function deadCode(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: {
        edgeKinds?: ReadonlySet<string>;
        callableKinds?: ReadonlySet<string>;
        isExempt?: (sym: ParsedSymbol) => boolean;
    } = {},
): DeadCodeReport {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);
    const callableKinds = options.callableKinds ?? new Set(['function', 'method', 'class']);
    const isExempt = options.isExempt ?? ((sym: ParsedSymbol) => defaultIsExempt(sym, table));

    // Collect inbound counts.
    const inbound = new Map<string, number>();
    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        inbound.set(rel.targetId, (inbound.get(rel.targetId) ?? 0) + 1);
    }

    let scanned = 0;
    let flagged = 0;
    let exempt = 0;
    const candidates: ParsedSymbol[] = [];

    for (const sym of table.all) {
        if (!callableKinds.has(sym.kind)) continue;
        scanned += 1;
        if ((inbound.get(sym.id) ?? 0) > 0) continue;
        if (isExempt(sym)) {
            exempt += 1;
            continue;
        }
        candidates.push(sym);
        flagged += 1;
    }

    return {
        candidates,
        stats: { scanned, flagged, exempt },
    };
}
