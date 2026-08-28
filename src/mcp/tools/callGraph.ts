/**
 * mcp/tools/callGraph.ts — atlas_call_graph.
 *
 * Ported from lore-plugin-developer/src/mcp/handlers.ts (handleImpact
 * + handleBlastRadius with edgeKinds=['calls']), adapted to read from
 * Lore via LoreReader instead of the developer plugin's in-process
 * AtlasContext. X4 spec: see groundfloor-atlas/X4-atlas-mcp-tools.md.
 *
 * Read path: filters on Lore type='code_symbol' + tag='atlas'; symbol-
 * symbol edges come from /api/node neighbours with confidence='extracted'.
 */

import type { ParsedSymbol } from '../../parser/types.js';
import { blastRadius } from '../../analytics/index.js';
import type { LoreContextReader } from '../codeContext.js';
import { findSymbol, repoOf } from './findSymbol.js';

interface CallGraphArgs {
    symbol: string;
    direction?: 'upstream' | 'downstream';
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

export async function runCallGraph(
    reader: LoreContextReader,
    args: CallGraphArgs,
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
            hint: 'Run `atlas index <path>` to populate Lore with parser output, then retry.',
            ...(truncated ? { truncated } : {}),
        };
    }
    if (resolved.kind === 'ambiguous') {
        // RC-F3 — a bare name matched symbols in >1 repo. Surface the candidates
        // instead of silently answering for one — the caller re-invokes with a
        // `repo:` qualifier or the full id from the list.
        return {
            error: `ambiguous symbol: ${args.symbol} matches ${resolved.candidates.length} symbols across ${new Set(resolved.candidates.map((c) => repoOf(c.id))).size} repos — pass a repo qualifier or the full id`,
            ambiguous: true,
            workspace,
            candidates: resolved.candidates.map((c) => ({ ...thinSymbol(c), repo: repoOf(c.id) })),
            ...(truncated ? { truncated } : {}),
        };
    }
    const sym = resolved.symbol;
    const direction = args.direction ?? 'downstream';
    const br = blastRadius(sym.id, table, relations, direction, { edgeKinds: new Set(['calls']) });
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
