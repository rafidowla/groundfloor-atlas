/**
 * mcp/tools/blastRadius.ts — atlas_blast_radius.
 *
 * Ported from lore-plugin-developer handlers.ts (handleBlastRadius),
 * adapted to read from Lore via LoreReader. Returns d1/d2/d3 reachability
 * over the recovered call/import graph.
 *
 * Sprint 1 (typed code edges): loreReader now recovers the REAL relation
 * kind (calls/imports/extends/contains/…) via schema.inferRelationKind, so
 * the `edgeKinds` filter below (default {calls, imports}) is now MEANINGFUL —
 * containment/inheritance/data edges are correctly excluded by default, and
 * a caller can opt them in via `edgeKinds`. Back-compat: a pre-Sprint-1
 * graph still has `related_to` edges, which inferRelationKind maps to
 * `calls`, so they continue to count under the default filter — no
 * regression on un-reindexed workspaces.
 */

import type { ParsedSymbol } from '../../parser/types.js';
import { blastRadius } from '../../analytics/index.js';
import type { LoreContextReader } from '../codeContext.js';
import { findSymbol, repoOf } from './findSymbol.js';

interface BlastRadiusArgs {
    symbol: string;
    direction?: 'upstream' | 'downstream';
    edgeKinds?: string[];
    /** RC-F3 — optional repo namespace to disambiguate a cross-repo bare name. */
    repo?: string;
    workspace?: string;
}

function thinSymbol(sym: ParsedSymbol) {
    return {
        id: sym.id,
        name: sym.qualifiedName || sym.name,
        file: sym.file,
        line: sym.byteRange.startLine,
        kind: sym.kind,
    };
}

export async function runBlastRadius(
    reader: LoreContextReader,
    args: BlastRadiusArgs,
    defaultWorkspace: string,
): Promise<unknown> {
    const workspace = args.workspace ?? defaultWorkspace;
    const { table, relations, truncated } = await reader.loadContext(workspace);
    const resolved = findSymbol(table, args.symbol, { repo: args.repo });
    if (resolved.kind === 'not_found') {
        return {
            error: `symbol not found: ${args.symbol}`,
            workspace,
            scanned: table.all.length,
            ...(truncated ? { truncated } : {}),
        };
    }
    if (resolved.kind === 'ambiguous') {
        // RC-F3 — matched >1 repo; surface candidates rather than guess a repo.
        return {
            error: `ambiguous symbol: ${args.symbol} matches ${resolved.candidates.length} symbols across ${new Set(resolved.candidates.map((c) => repoOf(c.id))).size} repos — pass a repo qualifier or the full id`,
            ambiguous: true,
            workspace,
            candidates: resolved.candidates.map((c) => ({ ...thinSymbol(c), repo: repoOf(c.id) })),
            ...(truncated ? { truncated } : {}),
        };
    }
    const sym = resolved.symbol;
    const direction = args.direction ?? 'upstream';
    const edgeKinds = args.edgeKinds && args.edgeKinds.length > 0
        ? new Set(args.edgeKinds)
        : new Set(['calls', 'imports']);
    const br = blastRadius(sym.id, table, relations, direction, { edgeKinds });
    return {
        symbol: thinSymbol(sym),
        direction,
        workspace,
        d1: br.d1.map(thinSymbol),
        d2: br.d2.map(thinSymbol),
        d3: br.d3.map(thinSymbol),
        ...(truncated ? { truncated } : {}),
    };
}
