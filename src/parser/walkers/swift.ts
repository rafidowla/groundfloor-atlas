/**
 * parser/walkers/swift.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Swift walker.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation) — v1.1 walker fast-follow #5.
 *
 * Grammar: alex-pinkus/tree-sitter-swift (vendored via tree-sitter-wasms).
 *
 * Extracts:
 *   - function_declaration → 'function' / 'method'
 *   - class_declaration / struct_declaration / actor_declaration → 'class'
 *   - protocol_declaration → 'interface'
 *   - enum_declaration → 'enum'
 *   - init_declaration → 'method' (constructor)
 *   - subscript_declaration → 'method'
 *   - property_declaration at file or type scope → 'constant' (let, UPPER) / 'variable'
 *   - import_declaration → ParsedImport
 *
 * Calls extracted from function bodies via call_expression.
 *
 * Limitations:
 *   - Extension declarations (extension Foo { ... }) lift their members
 *     into the file's top-level qname rather than splicing them under
 *     Foo. Cross-file resolution can re-anchor in Phase 2.
 *   - Property wrappers / @main / SwiftUI body builders aren't surfaced
 *     as separate symbols; they're implicit on the property/function.
 */

import type { Node } from 'web-tree-sitter';
import type { ParsedCall, ParsedImport, ParsedSymbol, SymbolKind } from '../types.js';
import {
    buildSignature,
    byteRangeFromNode,
    cyclomaticComplexity,
    extractCallsInBody,
    FUNCTION_METHOD_KINDS,
    innermostContainingSymbol,
    makeParsedSymbol,
    walkSubtree,
    type WalkerFn,
} from './_base.js';

const SWIFT_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'guard_statement',
    'switch_statement',
    'switch_entry',
    'for_statement',
    'while_statement',
    'repeat_while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
    // Swift's grammar surfaces && and || as conjunction/disjunction in
    // `additive_expression` chains — we accept the slight overcount on
    // generic binary_expression rather than miss decision points.
    'binary_expression',
]);

// Function-scope node types the per-function loop below extracts itself —
// nested bodies are skipped during an OUTER function's call walk so
// their calls are counted once, under the innermost owner.
const SWIFT_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'function_declaration',
    'init_declaration',
    'subscript_declaration',
    'deinit_declaration'
]);

const SWIFT_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'call_expression',
]);

/**
 * Look for a child with field name `name` first; fall back to the first
 * `simple_identifier` / `type_identifier` named child. Different Swift
 * grammar versions expose the name field inconsistently, so we try
 * both routes.
 */
function nameOf(node: Node): string | null {
    const fieldName = node.childForFieldName('name');
    if (fieldName) return fieldName.text;
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === 'simple_identifier' || c.type === 'type_identifier' || c.type === 'identifier') {
            return c.text;
        }
    }
    return null;
}

function extractImports(rootNode: Node): ParsedImport[] {
    const out: ParsedImport[] = [];
    walkSubtree(rootNode, (n) => {
        if (n.type !== 'import_declaration') return;
        const text = n.text.replace(/^\s*import\s+/, '').trim();
        out.push({
            moduleSpecifier: text,
            names: [],
            byteRange: byteRangeFromNode(n),
        });
    });
    return out;
}

function classKindForType(t: string): SymbolKind | null {
    switch (t) {
        case 'class_declaration': return 'class';
        case 'struct_declaration': return 'class';
        case 'actor_declaration': return 'class';
        case 'protocol_declaration': return 'interface';
        case 'enum_declaration': return 'enum';
        default: return null;
    }
}

/**
 * v1.1.1 polish — Swift's grammar collapses enum / struct / class into
 * a single `class_declaration` node type. The discriminator is the
 * BODY child: `enum_class_body` means it's an enum, `class_body`
 * means struct or class (those two we can't distinguish without
 * peeking at the source text). Inspect the named children to
 * promote a class_declaration to 'enum' when its body is
 * enum_class_body.
 *
 * Without this fix, every Swift enum surfaced as kind='class' — the
 * v1 walker's most visible polish item.
 */
function refineKindByBody(node: Node, baseKind: SymbolKind): SymbolKind {
    if (baseKind !== 'class') return baseKind;
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'enum_class_body') return 'enum';
    }
    return baseKind;
}

function findBody(node: Node): Node | null {
    // Swift's grammar names container bodies inconsistently across
    // versions: `class_body`, `protocol_body`, `enum_class_body`,
    // `body`. Try the field route first, then scan for any *_body
    // named child.
    const fielded = node.childForFieldName('body');
    if (fielded) return fielded;
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type.endsWith('_body') || c.type === 'body') return c;
    }
    return null;
}

function isUpperConst(name: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
}

function extractInBody(
    body: Node,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQ: string | null,
    parentKind: SymbolKind | null,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        const baseKind = classKindForType(child.type);
        if (baseKind) {
            const name = nameOf(child);
            if (!name) continue;
            // v1.1.1 polish — promote class_declaration → enum when
            // its body is enum_class_body (Swift grammar collapses
            // enum/struct/class into one node type).
            const classKind = refineKindByBody(child, baseKind);
            const qname = parentQ ? `${parentQ}.${name}` : name;
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: classKind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            });
            out.push(sym);
            const inner = findBody(child);
            if (inner) extractInBody(inner, sourceUtf8, file, sym.id, qname, classKind, out);
            continue;
        }

        if (child.type === 'extension_declaration') {
            // Walk extension's body; do not emit a separate symbol for
            // the extension itself. Phase 2 cross-file resolution will
            // re-attribute these members to the extended type.
            const inner = findBody(child);
            if (inner) extractInBody(inner, sourceUtf8, file, parentSymbolId, parentQ, parentKind, out);
            continue;
        }

        if (child.type === 'function_declaration') {
            const name = nameOf(child);
            if (!name) continue;
            const isMethod = parentKind === 'class' || parentKind === 'interface' || parentKind === 'enum';
            const qname = parentQ ? `${parentQ}.${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: isMethod ? 'method' : 'function',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, SWIFT_DECISION_TYPES),
                parentSymbolId,
            }));
            continue;
        }

        if (child.type === 'init_declaration' || child.type === 'subscript_declaration' || child.type === 'deinit_declaration') {
            // Constructors, subscripts, deinit — synthesize a method
            // symbol named after the keyword.
            const synth = child.type === 'init_declaration'
                ? 'init'
                : (child.type === 'subscript_declaration' ? 'subscript' : 'deinit');
            const qname = parentQ ? `${parentQ}.${synth}` : synth;
            out.push(makeParsedSymbol({
                name: synth,
                qualifiedName: qname,
                kind: 'method',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, SWIFT_DECISION_TYPES),
                parentSymbolId,
            }));
            continue;
        }

        if (child.type === 'property_declaration') {
            // Property at file or class/struct/enum scope.
            const name = nameOf(child);
            if (!name) continue;
            // Only file-scope or type-scope properties become symbols.
            if (parentKind !== null && parentKind !== 'class' && parentKind !== 'interface' && parentKind !== 'enum') {
                continue;
            }
            const isLet = /\blet\b/.test(child.text.slice(0, 24));
            const kind: SymbolKind = isLet && isUpperConst(name) ? 'constant' : 'variable';
            const qname = parentQ ? `${parentQ}.${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            }));
        }
    }
}

function extractSwiftCallee(node: Node): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type !== 'call_expression') return null;
    const first = node.namedChild(0);
    if (!first) return null;
    if (first.type === 'simple_identifier' || first.type === 'identifier') {
        return { name: first.text, isMethod: false, receiver: null };
    }
    if (first.type === 'navigation_expression') {
        let lastName: string | null = null;
        let receiver: string | null = null;
        for (let i = 0; i < first.namedChildCount; i++) {
            const c = first.namedChild(i);
            if (!c) continue;
            if (c.type === 'navigation_suffix' || c.type === 'simple_identifier' || c.type === 'identifier') {
                const segText = c.type === 'navigation_suffix'
                    ? (c.namedChild(0)?.text ?? c.text.replace(/^\./, ''))
                    : c.text;
                if (lastName) {
                    receiver = receiver ? `${receiver}.${lastName}` : lastName;
                }
                lastName = segText;
            }
        }
        if (lastName) return { name: lastName, isMethod: true, receiver };
    }
    return null;
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, null, symbols);

    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_declaration'
            && node.type !== 'init_declaration'
            && node.type !== 'subscript_declaration'
            && node.type !== 'deinit_declaration') return;
        const body = findBody(node);
        if (!body) return;
        const owner = innermostContainingSymbol(symbols, node, FUNCTION_METHOD_KINDS);
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, SWIFT_CALL_NODE_TYPES, extractSwiftCallee, SWIFT_SCOPE_TYPES));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};
