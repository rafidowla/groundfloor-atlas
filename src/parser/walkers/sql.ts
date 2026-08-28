/**
 * parser/walkers/sql.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * SQL walker — parses .sql / .ddl / .dml files via tree-sitter-sql (lumis-sh grammar).
 *
 * Phase: 9 (data-layer integration).
 *
 * Extracts:
 *   - CREATE TABLE / CREATE VIEW → kind 'table'
 *   - CREATE FUNCTION / CREATE PROCEDURE → kind 'query'
 *   - CREATE INDEX → skipped (not a call-graph node)
 *
 * No imports or calls are extracted from SQL files (SQL doesn't import other files
 * and inline calls aren't meaningful at the schema level). The Phase 9 cross-file
 * linker handles code→table edges separately via string-matching in TS/Python/etc. bodies.
 *
 * Original work authored for groundfloor-lore.
 */

import type { Node } from 'web-tree-sitter';
import type { ParsedSymbol } from '../types.js';
import {
    buildSignature,
    byteRangeFromNode,
    makeParsedSymbol,
    walkSubtree,
    type WalkerFn,
    type WalkerOutput,
} from './_base.js';

/**
 * SQL node types that we extract as symbols.
 */
const TABLE_NODE_TYPES: ReadonlySet<string> = new Set([
    'create_table',
    'create_view',
]);

const QUERY_NODE_TYPES: ReadonlySet<string> = new Set([
    'create_function',
    // PROCEDURE nodes parse as create_function with a 'procedure' keyword child;
    // tree-sitter-sql (lumis-sh) wraps them under the same type.
]);

/**
 * Extract the object name from a SQL declaration node.
 * In tree-sitter-sql, the name is the first `object_reference` child.
 * An object_reference may itself contain a `identifier` child (unqualified)
 * or `schema.table` (qualified via two identifiers). We return just the
 * final identifier as the symbol name and the full text as qualifiedName.
 */
function extractSqlName(node: Node): { name: string; qualifiedName: string } | null {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'object_reference') {
            const fullText = child.text.trim();
            // For schema-qualified names like public.users, take last part as name.
            const parts = fullText.split('.');
            const name = parts[parts.length - 1] ?? fullText;
            return { name, qualifiedName: fullText };
        }
    }
    return null;
}

/**
 * SQL walker entry point. rootNode is the program node from tree-sitter-sql.
 */
export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];

    walkSubtree(rootNode, (node) => {
        if (TABLE_NODE_TYPES.has(node.type)) {
            const names = extractSqlName(node);
            if (!names) return;
            const sym = makeParsedSymbol({
                name: names.name,
                qualifiedName: names.qualifiedName,
                kind: 'table',
                file,
                byteRange: byteRangeFromNode(node),
                signature: buildSignature(sourceUtf8, node),
                complexity: 1,
                parentSymbolId: null,
            });
            symbols.push(sym);
        } else if (QUERY_NODE_TYPES.has(node.type)) {
            const names = extractSqlName(node);
            if (!names) return;
            const sym = makeParsedSymbol({
                name: names.name,
                qualifiedName: names.qualifiedName,
                kind: 'query',
                file,
                byteRange: byteRangeFromNode(node),
                signature: buildSignature(sourceUtf8, node),
                complexity: 1,
                parentSymbolId: null,
            });
            symbols.push(sym);
        }
    });

    return { symbols, imports: [], calls: [] } satisfies WalkerOutput;
};
