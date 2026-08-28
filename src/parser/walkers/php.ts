/**
 * parser/walkers/php.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * PHP walker.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation) — v1.1 walker fast-follow #5.
 *
 * Extracts:
 *   - function_definition  → 'function'
 *   - method_declaration   → 'method' (when nested in class/interface/trait)
 *   - class_declaration    → 'class'
 *   - interface_declaration→ 'interface'
 *   - trait_declaration    → 'trait' (mapped to 'class' in core SymbolKind set)
 *   - enum_declaration     → 'enum' (PHP 8.1+)
 *   - namespace_use_declaration → ParsedImport
 *
 * Calls extracted from method/function bodies:
 *   - function_call_expression
 *   - member_call_expression  ($x->foo())
 *   - scoped_call_expression  (Foo::bar())
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

const PHP_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'else_if_clause',
    'elseif_clause',
    'while_statement',
    'do_statement',
    'for_statement',
    'foreach_statement',
    'switch_statement',
    'case_statement',
    'match_arm',
    'conditional_expression', // ternary
    'binary_expression',      // overcounts — accepts && / || / xor
    'catch_clause',
]);

// Function-scope node types the per-function loop below extracts itself —
// nested bodies are skipped during an OUTER function's call walk so
// their calls are counted once, under the innermost owner.
const PHP_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'function_definition',
    'method_declaration'
]);

const PHP_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'function_call_expression',
    'member_call_expression',
    'scoped_call_expression',
    'nullsafe_member_call_expression',
]);

function nameOf(node: Node): string | null {
    const n = node.childForFieldName('name');
    if (n) return n.text;
    // Some PHP grammar variants don't expose name as a field on every
    // declaration; fall back to the first 'name' descendant.
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'name') return c.text;
    }
    return null;
}

function extractImports(rootNode: Node): ParsedImport[] {
    const out: ParsedImport[] = [];
    walkSubtree(rootNode, (n) => {
        if (n.type !== 'namespace_use_declaration') return;
        // v1.1.1 polish — earlier extraction over-collected: every
        // namespace_name node in the subtree was treated as a name,
        // including intermediate path segments. PHP's grammar nests
        // namespace_name nodes (e.g., `App\Repository` is one node,
        // and the inner `App` may also surface). Walking subtree
        // unconditionally pulled both, producing a 2-element `names`
        // array for an import with no alias.
        //
        // Correct shape: each namespace_use_declaration has one or more
        // namespace_use_clause children; each clause has one
        // qualified_name (or namespace_name) child for the full path,
        // and OPTIONALLY a namespace_aliasing_clause for the alias.
        // Iterate clauses directly and pull at most one name per clause.
        const names: string[] = [];
        let moduleSpecifier = '';
        for (let i = 0; i < n.namedChildCount; i++) {
            const clause = n.namedChild(i);
            if (!clause) continue;
            // Most grammar variants name this `namespace_use_clause`;
            // some emit the qualified_name directly under the
            // declaration. Handle both.
            const clauseRoot = clause.type === 'namespace_use_clause' ? clause : clause;

            // Pull the full path: the first namespace_name /
            // qualified_name DIRECT named child (not subtree-walked).
            let fullPath: string | null = null;
            for (let j = 0; j < clauseRoot.namedChildCount; j++) {
                const c = clauseRoot.namedChild(j);
                if (!c) continue;
                if (c.type === 'namespace_name' || c.type === 'qualified_name') {
                    fullPath = c.text;
                    break;
                }
            }
            if (!fullPath && (clauseRoot.type === 'namespace_name' || clauseRoot.type === 'qualified_name')) {
                fullPath = clauseRoot.text;
            }
            if (!moduleSpecifier && fullPath) {
                moduleSpecifier = fullPath;
            }

            // Alias, if any. Pulled out of namespace_aliasing_clause
            // (`use Foo\Bar as Baz;` → alias = "Baz").
            let alias: string | null = null;
            for (let j = 0; j < clauseRoot.namedChildCount; j++) {
                const c = clauseRoot.namedChild(j);
                if (c && c.type === 'namespace_aliasing_clause') {
                    const aliasName = c.namedChild(0);
                    if (aliasName) alias = aliasName.text;
                    break;
                }
            }
            if (alias) names.push(alias);
        }
        out.push({
            moduleSpecifier: moduleSpecifier || n.text,
            names,
            byteRange: byteRangeFromNode(n),
        });
    });
    return out;
}

function classKindForType(t: string): SymbolKind | null {
    switch (t) {
        case 'class_declaration': return 'class';
        case 'interface_declaration': return 'interface';
        case 'trait_declaration': return 'class';   // closest fit; surfaces as class
        case 'enum_declaration': return 'enum';
        default: return null;
    }
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

        // Namespace doesn't emit a symbol — its children become qualified
        // by the namespace name. PHP namespace can be block- or file-scoped.
        if (child.type === 'namespace_definition') {
            const nsName = child.childForFieldName('name')?.text ?? null;
            const newQ = nsName ? (parentQ ? `${parentQ}\\${nsName}` : nsName) : parentQ;
            const inner = child.childForFieldName('body') ?? child;
            extractInBody(inner, sourceUtf8, file, parentSymbolId, newQ, parentKind, out);
            continue;
        }

        const classKind = classKindForType(child.type);
        if (classKind) {
            const name = nameOf(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}\\${name}` : name;
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
            // Body of class/interface/trait/enum is `declaration_list`.
            const declList = child.childForFieldName('body') ?? child;
            extractInBody(declList, sourceUtf8, file, sym.id, qname, classKind, out);
            continue;
        }

        if (child.type === 'function_definition') {
            const name = nameOf(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}\\${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'function',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, PHP_DECISION_TYPES),
                parentSymbolId,
            }));
            continue;
        }

        if (child.type === 'method_declaration') {
            const name = nameOf(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}::${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'method',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, PHP_DECISION_TYPES),
                parentSymbolId,
            }));
            continue;
        }

        // const FOO = 'bar' at file or class scope → constant
        if (child.type === 'const_declaration') {
            // const_declaration → const_element → name + initializer
            for (let j = 0; j < child.namedChildCount; j++) {
                const el = child.namedChild(j);
                if (!el || el.type !== 'const_element') continue;
                const cname = el.childForFieldName('name')?.text ?? el.namedChild(0)?.text;
                if (!cname) continue;
                const qname = parentQ ? `${parentQ}::${cname}` : cname;
                out.push(makeParsedSymbol({
                    name: cname,
                    qualifiedName: qname,
                    kind: 'constant',
                    file,
                    byteRange: byteRangeFromNode(el),
                    signature: buildSignature(sourceUtf8, el),
                    complexity: 1,
                    parentSymbolId,
                }));
            }
        }
    }
}

function extractPhpCallee(node: Node): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type === 'function_call_expression') {
        const fn = node.childForFieldName('function') ?? node.namedChild(0);
        if (!fn) return null;
        // For qualified-name calls the text is the full `Foo\Bar`; the
        // base name is the last segment.
        const text = fn.text;
        const tail = text.split(/\\/).pop() ?? text;
        return { name: tail, isMethod: false, receiver: null };
    }
    if (node.type === 'member_call_expression' || node.type === 'nullsafe_member_call_expression') {
        const obj = node.childForFieldName('object');
        const name = node.childForFieldName('name');
        if (!name) return null;
        return { name: name.text, isMethod: true, receiver: obj?.text ?? null };
    }
    if (node.type === 'scoped_call_expression') {
        const scope = node.childForFieldName('scope');
        const name = node.childForFieldName('name');
        if (!name) return null;
        return { name: name.text, isMethod: true, receiver: scope?.text ?? null };
    }
    return null;
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, null, symbols);

    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_definition' && node.type !== 'method_declaration') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = innermostContainingSymbol(symbols, node, FUNCTION_METHOD_KINDS);
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, PHP_CALL_NODE_TYPES, extractPhpCallee, PHP_SCOPE_TYPES));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};
