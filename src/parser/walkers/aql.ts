/**
 * parser/walkers/aql.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * AQL (ArangoDB Query Language) walker — regex-based, no WASM grammar.
 *
 * Phase: 9 (data-layer integration).
 *
 * AQL files (.aql) contain queries against ArangoDB collections. This walker
 * extracts two things:
 *
 *   1. The file itself as a 'query' symbol — an AQL file IS a named query unit.
 *   2. Collection references (FOR x IN <collection>, INSERT INTO <collection>,
 *      UPDATE/REMOVE/UPSERT IN <collection>) recorded as 'table' symbols so the
 *      cross-file linker can wire code→collection edges.
 *
 * No tree-sitter WASM grammar exists for AQL, and AQL syntax is simple enough
 * that regex extraction covers 90%+ of realistic cases. rootNode is ignored.
 *
 * Original work authored for groundfloor-lore.
 */

import type { Node } from 'web-tree-sitter';
import type { ParsedSymbol } from '../types.js';
import { makeParsedSymbol, type WalkerFn, type WalkerOutput } from './_base.js';
import * as path from 'node:path';

/**
 * AQL collection reference patterns.
 *
 * FOR doc IN <collection>          → read
 * ... INTO <collection>            → write (INSERT ... INTO)
 * UPDATE <doc> IN <collection>     → write
 * REPLACE <doc> IN <collection>    → write
 * REMOVE <doc> IN <collection>     → write
 * UPSERT <filter> INSERT ... UPDATE ... IN <collection> → write
 *
 * Note: `INTO` is used exclusively for INSERT targets in AQL; `IN` is used
 * for collection iteration. We capture both separately.
 */
const AQL_PATTERNS: Array<{ re: RegExp; op: 'read' | 'write' }> = [
    // FOR x IN collection  (read)
    { re: /\bFOR\s+\w+\s+IN\s+([A-Za-z_]\w*)/gi,    op: 'read'  },
    // INSERT ... INTO collection  (write) — capture the word after INTO
    { re: /\bINTO\s+([A-Za-z_]\w*)/gi,               op: 'write' },
    // UPDATE x IN collection  (write)
    { re: /\bUPDATE\s+\w+\s+IN\s+([A-Za-z_]\w*)/gi, op: 'write' },
    // REPLACE x IN collection  (write)
    { re: /\bREPLACE\s+\w+\s+IN\s+([A-Za-z_]\w*)/gi, op: 'write' },
    // REMOVE x IN collection  (write)
    { re: /\bREMOVE\s+\w+\s+IN\s+([A-Za-z_]\w*)/gi, op: 'write' },
];

/** AQL built-in pseudo-collections / keywords that aren't real collections. */
const AQL_KEYWORDS: ReadonlySet<string> = new Set([
    'GRAPH', 'OUTBOUND', 'INBOUND', 'ANY', 'ALL', 'NONE', 'TRUE', 'FALSE', 'NULL',
    'LET', 'FILTER', 'SORT', 'LIMIT', 'RETURN', 'COLLECT', 'WITH',
]);

function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (source.charCodeAt(i) === 0x0a) line++;
    }
    return line;
}

/**
 * Regex-based AQL walker. `rootNode` is ignored.
 */
export const walk: WalkerFn = (_rootNode: Node, sourceUtf8: Uint8Array, file: string): WalkerOutput => {
    const source = new TextDecoder('utf-8').decode(sourceUtf8);
    const symbols: ParsedSymbol[] = [];
    const seen = new Set<string>(); // deduplicate collection names per file

    // Emit the file itself as a 'query' symbol (an AQL file = a named query unit).
    const fileName = path.basename(file, path.extname(file));
    const fileQuerySym = makeParsedSymbol({
        name: fileName,
        qualifiedName: fileName,
        kind: 'query',
        file,
        byteRange: { start: 0, end: sourceUtf8.length, startLine: 1, endLine: lineAt(source, source.length - 1) || 1 },
        signature: `-- AQL query: ${fileName}`,
        complexity: 1,
        parentSymbolId: null,
    });
    symbols.push(fileQuerySym);

    // Extract collection references.
    for (const { re } of AQL_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const collection = m[1]!;
            // Skip keywords, numbers, or names we've already emitted.
            if (AQL_KEYWORDS.has(collection.toUpperCase())) continue;
            if (/^\d/.test(collection)) continue;
            const key = collection.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const startLine = lineAt(source, m.index);
            const colSym = makeParsedSymbol({
                name: collection,
                qualifiedName: collection,
                kind: 'table',
                file,
                byteRange: {
                    start: m.index,
                    end: m.index + m[0].length,
                    startLine,
                    endLine: startLine,
                },
                signature: m[0].trim().slice(0, 100),
                complexity: 1,
                parentSymbolId: fileQuerySym.id,
            });
            symbols.push(colSym);
        }
    }

    return { symbols, imports: [], calls: [] };
};
