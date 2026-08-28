/**
 * parser/walkers/kotlin.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Kotlin walker.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation) — v1.1 walker fast-follow #5.
 *
 * Grammar: fwcd/tree-sitter-kotlin (vendored via tree-sitter-wasms).
 *
 * Extracts:
 *   - function_declaration → 'function' (top-level) or 'method' (in class)
 *   - class_declaration → 'class' (or 'interface'/'enum' depending on modifier/body)
 *   - object_declaration → 'class' (singleton; closest fit)
 *   - property_declaration at file or class scope → 'constant' / 'variable'
 *   - import_header → ParsedImport
 *
 * Calls extracted from function bodies via call_expression nodes.
 *
 * Limitations:
 *   - Top-level vs. companion-object membership: companion_object is
 *     not yet promoted to a separate class symbol; its members appear
 *     under the enclosing class's namespace.
 *   - Sealed-class hierarchy isn't surfaced as inheritance edges
 *     (Phase 2 cross-file work).
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

const KOTLIN_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_expression',
    'when_expression',
    'when_entry',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'try_expression',
    'catch_block',
    'conjunction_expression', // && — adds one decision point per `&&`
    'disjunction_expression', // ||
    'elvis_expression',       // ?: — short-circuit
]);

// Function-scope node types the per-function loop below extracts itself —
// nested bodies are skipped during an OUTER function's call walk so
// their calls are counted once, under the innermost owner.
const KOTLIN_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'function_declaration'
]);

const KOTLIN_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'call_expression',
]);

/**
 * Kotlin's grammar uses `type_identifier` for class/interface/object/enum
 * names and `simple_identifier` for function/property names. Both appear
 * as anonymous (non-field) children — find the first one.
 */
function findIdentifier(node: Node, idType: 'type_identifier' | 'simple_identifier'): string | null {
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === idType) return c.text;
    }
    return null;
}

/**
 * Inspect a class_declaration's modifiers + body to disambiguate
 * class / interface / enum / data class. Default is 'class'.
 */
function classKindFor(node: Node): SymbolKind {
    // Walk the modifiers child (if any) for `interface` / `enum` keywords.
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === 'modifiers' || c.type === 'class_modifier') {
            const text = c.text;
            if (/\benum\b/.test(text)) return 'enum';
        }
    }
    // The grammar lifts `interface` / `class` / `enum` keywords to
    // anonymous nodes. Inspect the raw declaration prefix for them.
    const prefix = node.text.slice(0, 64);
    if (/\binterface\b/.test(prefix)) return 'interface';
    if (/\benum\s+class\b/.test(prefix)) return 'enum';
    // Body type also discriminates enum.
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'enum_class_body') return 'enum';
    }
    return 'class';
}

function extractImports(rootNode: Node): ParsedImport[] {
    const out: ParsedImport[] = [];
    walkSubtree(rootNode, (n) => {
        if (n.type !== 'import_header') return;
        // Drop the `import ` prefix; the rest is the module path
        // (possibly with `as Alias` or `.*`).
        const text = n.text.replace(/^\s*import\s+/, '').trim();
        // Remove trailing semicolon (optional in Kotlin).
        const stripped = text.replace(/;$/, '');
        out.push({
            moduleSpecifier: stripped,
            names: [],
            byteRange: byteRangeFromNode(n),
        });
    });
    return out;
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

        if (child.type === 'class_declaration' || child.type === 'object_declaration') {
            const name = findIdentifier(child, 'type_identifier');
            if (!name) continue;
            const kind: SymbolKind = child.type === 'object_declaration' ? 'class' : classKindFor(child);
            const qname = parentQ ? `${parentQ}.${name}` : name;
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            });
            out.push(sym);
            // Body is class_body / enum_class_body.
            for (let j = 0; j < child.namedChildCount; j++) {
                const inner = child.namedChild(j);
                if (inner && (inner.type === 'class_body' || inner.type === 'enum_class_body')) {
                    extractInBody(inner, sourceUtf8, file, sym.id, qname, kind, out);
                    break;
                }
            }
            continue;
        }

        if (child.type === 'function_declaration') {
            const name = findIdentifier(child, 'simple_identifier');
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
                complexity: cyclomaticComplexity(child, KOTLIN_DECISION_TYPES),
                parentSymbolId,
            }));
            continue;
        }

        if (child.type === 'property_declaration') {
            // v1.1.1 polish — Kotlin's property_declaration wraps the
            // name in a `variable_declaration` child, not a direct
            // simple_identifier. Find that child first, then pull the
            // identifier out of it. Without this, top-level `val
            // MAX_RETRIES = 3` style constants get skipped because
            // findIdentifier(child, 'simple_identifier') returns null
            // (the simple_identifier is one level deeper).
            let name: string | null = null;
            for (let j = 0; j < child.namedChildCount; j++) {
                const c = child.namedChild(j);
                if (!c) continue;
                if (c.type === 'variable_declaration') {
                    // Inside variable_declaration: simple_identifier holds the name.
                    for (let k = 0; k < c.namedChildCount; k++) {
                        const inner = c.namedChild(k);
                        if (inner && inner.type === 'simple_identifier') {
                            name = inner.text;
                            break;
                        }
                    }
                    break;
                }
                // Some properties (multi-variable destructuring) put
                // simple_identifier directly. Fall back to that.
                if (c.type === 'simple_identifier' && !name) {
                    name = c.text;
                }
            }
            if (!name) continue;

            // val vs var via binding_pattern_kind child (more reliable
            // than text regex — modifiers can appear before binding).
            // Constant detection adds: val + UPPER_SNAKE. The `const`
            // modifier is also a strong signal but we'd need to scan
            // the modifiers child; UPPER_SNAKE is the dominant case.
            let isVal = false;
            for (let j = 0; j < child.namedChildCount; j++) {
                const c = child.namedChild(j);
                if (c && c.type === 'binding_pattern_kind') {
                    isVal = c.text.includes('val');
                    break;
                }
            }
            const kind: SymbolKind = isVal && isUpperConst(name) ? 'constant' : 'variable';
            // Skip locals — only emit at file (parentKind null) or
            // class/object scope. Kotlin grammar nests locals under
            // statements_list which we don't recurse into.
            if (parentKind !== null && parentKind !== 'class' && parentKind !== 'interface' && parentKind !== 'enum') {
                continue;
            }
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
            continue;
        }

        if (child.type === 'companion_object') {
            // Walk into companion_object's class_body and attribute its
            // members to the enclosing class's qname (no nested symbol).
            for (let j = 0; j < child.namedChildCount; j++) {
                const inner = child.namedChild(j);
                if (inner && inner.type === 'class_body') {
                    extractInBody(inner, sourceUtf8, file, parentSymbolId, parentQ, parentKind, out);
                    break;
                }
            }
            continue;
        }
    }
}

function extractKotlinCallee(node: Node): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type !== 'call_expression') return null;
    // call_expression children typically: [receiver?, simple_identifier, call_suffix]
    // For `foo()`: just simple_identifier
    // For `obj.foo()`: navigation_expression with receiver + simple_identifier
    const first = node.namedChild(0);
    if (!first) return null;
    if (first.type === 'simple_identifier') {
        return { name: first.text, isMethod: false, receiver: null };
    }
    if (first.type === 'navigation_expression') {
        // Last simple_identifier in the navigation chain is the callee.
        let lastName: string | null = null;
        let receiver: string | null = null;
        for (let i = 0; i < first.namedChildCount; i++) {
            const c = first.namedChild(i);
            if (!c) continue;
            if (c.type === 'simple_identifier') {
                if (lastName) {
                    receiver = receiver ? `${receiver}.${lastName}` : lastName;
                }
                lastName = c.text;
            }
        }
        if (lastName) return { name: lastName, isMethod: true, receiver };
    }
    return null;
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];

    // Resolve the file's package as the root qname so all declarations
    // are package-qualified. Kotlin file root contains an optional
    // package_header followed by import_header(s) and declarations.
    let packageQ: string | null = null;
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const c = rootNode.namedChild(i);
        if (c && c.type === 'package_header') {
            // Strip leading `package ` keyword and trailing `;`
            packageQ = c.text.replace(/^\s*package\s+/, '').replace(/;\s*$/, '').trim() || null;
            break;
        }
    }

    extractInBody(rootNode, sourceUtf8, file, null, packageQ, null, symbols);

    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_declaration') return;
        // function_body child holds the method body (block or expression).
        let body: Node | null = null;
        for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c && c.type === 'function_body') { body = c; break; }
        }
        if (!body) return;
        const owner = innermostContainingSymbol(symbols, node, FUNCTION_METHOD_KINDS);
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, KOTLIN_CALL_NODE_TYPES, extractKotlinCallee, KOTLIN_SCOPE_TYPES));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};
