/**
 * mcp/tools/findDeadCode.ts — atlas_find_dead_code.
 *
 * Ported from lore-plugin-developer/src/mcp/handlers.ts (handleDeadCode),
 * adapted to read from Lore via LoreReader. Read path: filters on
 * Lore type='code_symbol' + tag='atlas'; uses edges recovered from
 * /api/node neighbours (extracted-confidence only) to compute inbound
 * reference counts.
 */

import type { ParsedSymbol } from '../../parser/types.js';
import { deadCode } from '../../analytics/index.js';
import { type LoreContextReader, notIndexedError } from '../codeContext.js';

interface DeadCodeArgs {
    file?: string;
    limit?: number;
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

export async function runFindDeadCode(
    reader: LoreContextReader,
    args: DeadCodeArgs,
    defaultWorkspace: string,
): Promise<unknown> {
    const workspace = args.workspace ?? defaultWorkspace;
    // RC-F4 — a typo'd/never-indexed workspace must NOT read back as a clean
    // empty "all clear" (identical to a genuinely-empty index). Surface it.
    const notIndexed = await notIndexedError(reader, workspace);
    if (notIndexed) return notIndexed;
    const { table, relations, truncated } = await reader.loadContext(workspace);
    const report = deadCode(table, relations);
    let candidates = report.candidates;
    if (args.file) candidates = candidates.filter((c) => c.file === args.file);
    return {
        workspace,
        stats: report.stats,
        candidates: candidates.slice(0, args.limit ?? 100).map(thinSymbol),
        ...(truncated ? { truncated } : {}),
    };
}
