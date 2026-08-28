/**
 * parser/walkers/cpp.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * C / C++ walker. Single walker handles both grammars (they share most
 * AST node types; tree-sitter-c is a subset of tree-sitter-cpp).
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function_definition, class_specifier (C++), struct_specifier,
 * enum_specifier, union_specifier, namespace_definition (C++),
 * preproc_include imports.
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

const C_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'case_statement',
    'conditional_expression',
    'binary_expression', // overcounts
]);

/**
 * Extract a function name from a function_definition / function_declarator.
 * C/C++ ASTs nest declarators (pointer_declarator, function_declarator,
 * identifier). Walk inward until we find the identifier.
 */
function findFunctionName(declarator: Node | null): string | null {
    if (!declarator) return null;
    let current: Node | null = declarator;
    let guard = 0;
    while (current && guard++ < 10) {
        if (current.type === 'identifier' || current.type === 'field_identifier' || current.type === 'qualified_identifier') {
            return current.text;
        }
        const inner: Node | null | undefined = current.childForFieldName('declarator')
            ?? current.namedChildren.find((n: Node) =>
                n.type.endsWith('_declarator') || n.type === 'identifier' || n.type === 'field_identifier');
        if (!inner) {
            // Last-ditch: look for any identifier in subtree.
            let found: string | null = null;
            walkSubtree(current, (n) => {
                if (!found && (n.type === 'identifier' || n.type === 'field_identifier')) {
                    found = n.text;
                }
            });
            return found;
        }
        current = inner;
    }
    return null;
}

function nameOfNamed(node: Node): string | null {
    const n = node.childForFieldName('name');
    return n ? n.text : null;
}

function extractImports(rootNode: Node): ParsedImport[] {
    const out: ParsedImport[] = [];
    walkSubtree(rootNode, (n) => {
        if (n.type !== 'preproc_include') return;
        const path = n.childForFieldName('path');
        if (!path) return;
        // path is "<header>" or "header.h"
        const text = path.text.replace(/^[<"]|[>"]$/g, '');
        out.push({
            moduleSpecifier: text,
            names: [],
            byteRange: byteRangeFromNode(n),
        });
    });
    return out;
}

function extractInBody(
    body: Node,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQ: string | null,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        if (child.type === 'function_definition') {
            const name = findFunctionName(child.childForFieldName('declarator'));
            if (!name) continue;
            const kind: SymbolKind = parentSymbolId ? 'method' : 'function';
            const qname = parentQ ? `${parentQ}::${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, C_DECISION_TYPES),
                parentSymbolId,
            }));
        } else if (
            child.type === 'class_specifier' ||
            child.type === 'struct_specifier' ||
            child.type === 'union_specifier'
        ) {
            const name = nameOfNamed(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}::${name}` : name;
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'class',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            });
            out.push(sym);
            const inner = child.childForFieldName('body');
            if (inner) extractInBody(inner, sourceUtf8, file, sym.id, qname, out);
        } else if (child.type === 'enum_specifier') {
            const name = nameOfNamed(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}::${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'enum',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            }));
        } else if (child.type === 'namespace_definition') {
            const name = nameOfNamed(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}::${name}` : name;
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'module',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            });
            out.push(sym);
            const inner = child.childForFieldName('body');
            if (inner) extractInBody(inner, sourceUtf8, file, sym.id, qname, out);
        } else if (child.type === 'template_declaration') {
            // template<...> wraps a class/function declaration; recurse on its body.
            extractInBody(child, sourceUtf8, file, parentSymbolId, parentQ, out);
        }
    }
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, symbols);

    // Phase 2.1: extract calls per function-definition body.
    // C/C++ call_expression has function child:
    //   - identifier  → free function: foo()
    //   - field_expression  → method: x.foo() or x->foo()
    //   - qualified_identifier (C++)  → ns::foo() or Class::foo()
    // Function-pointer calls and template-instantiated calls are best-effort.
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_definition') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = innermostContainingSymbol(symbols, node, FUNCTION_METHOD_KINDS);
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, C_CALL_NODE_TYPES, extractCCallee, CPP_SCOPE_TYPES));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};

// Function-scope node types the per-function loop below extracts itself —
// nested bodies are skipped during an OUTER function's call walk so
// their calls are counted once, under the innermost owner.
const CPP_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'function_definition'
]);

const C_CALL_NODE_TYPES: ReadonlySet<string> = new Set(['call_expression']);

function extractCCallee(node: Node): { name: string; isMethod: boolean; receiver: string | null } | null {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false, receiver: null };
    }
    if (fn.type === 'field_expression') {
        const argument = fn.childForFieldName('argument');
        const field = fn.childForFieldName('field');
        if (field) {
            return { name: field.text, isMethod: true, receiver: argument?.text ?? null };
        }
    }
    if (fn.type === 'qualified_identifier') {
        // C++ ns::foo or Class::foo. Extract trailing identifier.
        const last = fn.namedChild(fn.namedChildCount - 1);
        const head = fn.namedChild(0);
        if (last && (last.type === 'identifier' || last.type === 'field_identifier')) {
            return { name: last.text, isMethod: false, receiver: head?.text ?? null };
        }
    }
    return null;
}
