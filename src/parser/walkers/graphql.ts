/**
 * parser/walkers/graphql.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * GraphQL walker — parses .graphql / .gql files using regex (no WASM grammar).
 *
 * Phase: 9 (data-layer integration).
 *
 * GraphQL schema defines types as the "tables" of the API schema layer.
 * This walker extracts schema-definition constructs so the blast-radius tool
 * can answer "what code breaks if I remove the User type?" or "which resolvers
 * touch the Order type?".
 *
 * Extracts (from SDL files):
 *   - type, interface → kind 'table' (schema entity)
 *   - enum → kind 'enum'
 *   - input → kind 'interface' (input object, used as a parameter type)
 *   - union → kind 'type'
 *   - Query / Mutation / Subscription fields → kind 'query' (named operations)
 *
 * Does NOT extract from executable documents (query { ... }) — those are runtime
 * constructs, not schema definitions. The walker checks for SDL shape.
 *
 * Regex-based: no tree-sitter WASM dependency. rootNode is ignored.
 *
 * Original work authored for groundfloor-lore.
 */

import type { Node } from 'web-tree-sitter';
import type { ParsedSymbol, SymbolKind } from '../types.js';
import { buildSymbolId, makeParsedSymbol, type WalkerFn, type WalkerOutput } from './_base.js';

/** One-pass regex that matches top-level SDL declarations. */
const SDL_DECL_RE = /^(?:export\s+)?(?:extend\s+)?(type|interface|enum|input|union|scalar)\s+(\w+)/gm;

/** Match operation fields inside Query/Mutation/Subscription root types. */
const FIELD_RE = /^\s+(\w+)\s*(?:\([^)]*\))?\s*:/gm;

/** Map SDL keyword → SymbolKind */
function sdlKindFor(keyword: string): SymbolKind {
    switch (keyword) {
        case 'type':      return 'table';
        case 'interface': return 'table';
        case 'input':     return 'interface';
        case 'enum':      return 'enum';
        case 'union':     return 'type';
        case 'scalar':    return 'type';
        default:          return 'table';
    }
}

/** Approximate line number for a string offset. */
function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (source.charCodeAt(i) === 0x0a) line++;
    }
    return line;
}

/**
 * Regex-based GraphQL walker. `rootNode` is ignored (null for regex-only walkers).
 */
export const walk: WalkerFn = (_rootNode: Node, sourceUtf8: Uint8Array, file: string): WalkerOutput => {
    const source = new TextDecoder('utf-8').decode(sourceUtf8);
    const symbols: ParsedSymbol[] = [];

    let m: RegExpExecArray | null;
    SDL_DECL_RE.lastIndex = 0;
    while ((m = SDL_DECL_RE.exec(source)) !== null) {
        const keyword = m[1]!;
        const name = m[2]!;
        const kind = sdlKindFor(keyword);
        const startLine = lineAt(source, m.index);

        // Find the closing brace for block-type declarations (type/interface/input/enum).
        // For scalar and union (no body block), span is just the declaration line.
        let endLine = startLine;
        if (!['scalar', 'union'].includes(keyword)) {
            // Scan forward for the matching closing brace.
            let depth = 0;
            let found = false;
            for (let i = m.index; i < source.length; i++) {
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
        }

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

        // For root operation types (Query, Mutation, Subscription), also extract
        // individual fields as 'query' symbols so they're findable by name.
        if (['Query', 'Mutation', 'Subscription'].includes(name) && keyword === 'type') {
            // Slice the block body for this type.
            const bodyStart = source.indexOf('{', m.index);
            const bodyEnd = bodyStart >= 0 ? source.indexOf('}', bodyStart) : -1;
            if (bodyStart >= 0 && bodyEnd >= 0) {
                const body = source.slice(bodyStart, bodyEnd + 1);
                FIELD_RE.lastIndex = 0;
                let fm: RegExpExecArray | null;
                while ((fm = FIELD_RE.exec(body)) !== null) {
                    const fieldName = fm[1]!;
                    const fieldLine = lineAt(source, bodyStart + fm.index);
                    const fieldSym = makeParsedSymbol({
                        name: fieldName,
                        qualifiedName: `${name}.${fieldName}`,
                        kind: 'query',
                        file,
                        byteRange: {
                            start: bodyStart + fm.index,
                            end: bodyStart + fm.index + fm[0].length,
                            startLine: fieldLine,
                            endLine: fieldLine,
                        },
                        signature: fm[0].trim(),
                        complexity: 1,
                        parentSymbolId: sym.id,
                    });
                    symbols.push(fieldSym);
                }
            }
        }
    }

    return { symbols, imports: [], calls: [] };
};
