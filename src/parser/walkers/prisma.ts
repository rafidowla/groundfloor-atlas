/**
 * parser/walkers/prisma.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Prisma schema walker — parses .prisma files using regex (no WASM grammar).
 *
 * Phase: 9 (data-layer integration).
 *
 * Prisma schema is the most common ORM schema format in the TypeScript ecosystem.
 * `model` declarations map directly to database tables. This walker extracts them
 * so the blast-radius tool can answer "what code breaks if I rename the User model?"
 * or "which functions write to the orders table?"
 *
 * Extracts:
 *   - model → kind 'table' (maps to a DB table)
 *   - enum → kind 'enum'
 *   - type (Prisma composite types) → kind 'type'
 *   - view (Prisma @view) → kind 'table'
 *
 * Regex-based: no tree-sitter WASM dependency. rootNode is ignored.
 *
 * Original work authored for groundfloor-lore.
 */

import type { Node } from 'web-tree-sitter';
import type { ParsedSymbol, SymbolKind } from '../types.js';
import { makeParsedSymbol, type WalkerFn, type WalkerOutput } from './_base.js';

/** Matches top-level Prisma block declarations. */
const BLOCK_RE = /^(model|enum|type|view)\s+(\w+)\s*\{/gm;

function prismaKindFor(keyword: string): SymbolKind {
    switch (keyword) {
        case 'model': return 'table';
        case 'view':  return 'table';
        case 'enum':  return 'enum';
        case 'type':  return 'type';
        default:      return 'table';
    }
}

function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (source.charCodeAt(i) === 0x0a) line++;
    }
    return line;
}

/**
 * Regex-based Prisma walker. `rootNode` is ignored (null for regex-only walkers).
 */
export const walk: WalkerFn = (_rootNode: Node, sourceUtf8: Uint8Array, file: string): WalkerOutput => {
    const source = new TextDecoder('utf-8').decode(sourceUtf8);
    const symbols: ParsedSymbol[] = [];

    let m: RegExpExecArray | null;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(source)) !== null) {
        const keyword = m[1]!;
        const name = m[2]!;
        const kind = prismaKindFor(keyword);
        const startLine = lineAt(source, m.index);

        // Find the end of the block — scan for matching closing brace.
        let endLine = startLine;
        let depth = 0;
        let found = false;
        for (let i = m.index + m[0].length - 1; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') {
                depth--;
                if (depth === 0) {
                    endLine = lineAt(source, i);
                    found = true;
                    break;
                }
            }
        }
        if (!found) endLine = startLine;

        const sym = makeParsedSymbol({
            name,
            qualifiedName: name,
            kind,
            file,
            byteRange: {
                start: m.index,
                end: m.index + m[0].length,
                startLine,
                endLine,
            },
            signature: m[0].trim(),
            complexity: 1,
            parentSymbolId: null,
        });
        symbols.push(sym);
    }

    return { symbols, imports: [], calls: [] };
};
