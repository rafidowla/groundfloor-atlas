/**
 * mcp/tools/hotspots.ts — atlas_hotspots.
 *
 * Ported from lore-plugin-developer handlers.ts (handleHotspots), adapted
 * to read from Lore via LoreReader. The handler in the developer plugin
 * pulled churn from git (repoChurn over repoRoot) — that path is preserved
 * when `repoRoot` is supplied. When not supplied, hotspots collapses to a
 * complexity-only ranking using the metadata.complexity captured in each
 * architecture node by Atlas at index time.
 */

import type { ParsedSymbol } from '../../parser/types.js';
import { hotspots } from '../../analytics/index.js';
import { repoChurn, churnScore } from '../../git/index.js';
import { type LoreContextReader, notIndexedError } from '../codeContext.js';

interface HotspotsArgs {
    limit?: number;
    minComplexity?: number;
    churnSinceDays?: number;
    repoRoot?: string;
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

export async function runHotspots(
    reader: LoreContextReader,
    args: HotspotsArgs,
    defaultWorkspace: string,
): Promise<unknown> {
    const workspace = args.workspace ?? defaultWorkspace;
    // RC-F4 — distinguish a never-indexed workspace from an empty result.
    const notIndexed = await notIndexedError(reader, workspace);
    if (notIndexed) return notIndexed;
    const { table, truncated } = await reader.loadContext(workspace);

    let lookup: (filePath: string) => number = () => 0;
    let hasChurnData = false;
    if (args.repoRoot) {
        try {
            const churnByFile = repoChurn(args.repoRoot, args.churnSinceDays ?? 30);
            lookup = (filePath: string) => churnScore(churnByFile.get(filePath));
            hasChurnData = churnByFile.size > 0;
        } catch {
            // Non-git repo or git unavailable — fall back to complexity-only.
        }
    }

    const report = hotspots(table, lookup, {
        topN: args.limit ?? 50,
        minComplexity: args.minComplexity ?? 2,
    });
    return {
        workspace,
        hasChurnData: hasChurnData && report.hasChurnData,
        entries: report.entries.map((e) => ({
            ...thinSymbol(e.symbol),
            complexity: e.complexity,
            churn: e.churn,
            score: Math.round(e.score * 100) / 100,
        })),
        ...(truncated ? { truncated } : {}),
    };
}
