/**
 * parser/walkers/typescript.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * TypeScript walker — also handles .tsx / .jsx / .js (shared grammar).
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function declarations, class declarations, methods,
 * interfaces, enums, type aliases, top-level const/let bindings, and
 * import statements. Maps tree-sitter-typescript node types onto the
 * Atlas `SymbolKind` vocabulary.
 *
 * Coverage notes:
 *   - Decorators are extracted as `decorator` symbols (the decorator
 *     declaration itself, not the use).
 *   - Arrow-function / function-expression values assigned to top-level
 *     `const`/`let` are extracted as `function` symbols (common pattern:
 *     `export const foo = () => ...`, `export const handler = async
 *     function() {...}`). Bare constants (`const MAX = 3`) are still
 *     `constant` symbols.
 *   - Class fields whose value is an arrow_function or function_expression
 *     are extracted as `method` symbols (`handleClick = () => {...}`).
 *     Plain data fields (`name = 'foo'`) are skipped — they're not
 *     call-graph nodes.
 *   - Anonymous inline arrow functions inside call expressions
 *     (`router.get('/path', (req, res) => {...})`) are NOT extracted as
 *     symbols — they're noise at the call-graph level.
 *   - Methods include constructors, getters, setters, and static methods.
 *   - The walker does NOT resolve cross-file references; that's Phase 2.
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

// Function-scope node types the per-function loop below extracts itself —
// nested bodies are skipped during an OUTER function's call walk so
// their calls are counted once, under the innermost owner.
const TYPESCRIPT_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression'
]);

const TS_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'call_expression',
    'new_expression',
]);

/**
 * TypeScript / JavaScript callee extraction. Handles:
 *   - foo()  → free function call, callee = 'foo'
 *   - obj.foo()  → method call, callee = 'foo', receiver = 'obj'
 *   - Foo.bar()  → static / namespace, callee = 'bar', receiver = 'Foo'
 *   - new Foo()  → constructor, callee = 'Foo', isMethod = false
 *   - (await x)()  → dynamic; returns null
 */
function extractTsCallee(node: Node): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type === 'new_expression') {
        const constructor = node.childForFieldName('constructor');
        if (!constructor) return null;
        if (constructor.type === 'identifier' || constructor.type === 'type_identifier') {
            return { name: constructor.text, isMethod: false, receiver: null };
        }
        // member_expression — e.g. `new ns.Foo()`. Take the property as name.
        if (constructor.type === 'member_expression') {
            const prop = constructor.childForFieldName('property');
            const obj = constructor.childForFieldName('object');
            if (prop) return { name: prop.text, isMethod: false, receiver: obj?.text ?? null };
        }
        return null;
    }

    // call_expression
    const fn = node.childForFieldName('function');
    if (!fn) return null;

    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false, receiver: null };
    }
    if (fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        const obj = fn.childForFieldName('object');
        if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) {
            return { name: prop.text, isMethod: true, receiver: obj?.text ?? null };
        }
    }
    return null; // dynamic / unhandled
}

/**
 * Tree-sitter node types that count as decision points for cyclomatic
 * complexity in the TypeScript / JavaScript grammar.
 */
const TS_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
    'logical_expression',     // covers && and ||
    'optional_chain',         // ?. is a runtime decision
]);

/**
 * AST node types that introduce named symbols at module / class scope.
 * Walker iterates all named children of the file (and class bodies)
 * matching this set.
 */
const SYMBOL_NODE_TYPES: ReadonlySet<string> = new Set([
    'function_declaration',
    'class_declaration',
    'method_definition',
    'method_signature',           // interface method declaration
    'interface_declaration',
    'enum_declaration',
    'type_alias_declaration',
    'abstract_class_declaration',
    'abstract_method_signature',
    'lexical_declaration',        // const/let — emitted as 'function' when value is arrow/fn, 'constant' otherwise
    'variable_declaration',       // var — same rule
    'function_signature',         // function f(): X declared in .d.ts
    'public_field_definition',    // class fields — only emitted when value is arrow/fn (method kind)
    // property_signature (interface property) still skipped — plain type
    // annotations are not call-graph nodes.
    'export_statement',           // wraps another declaration; we recurse
]);

/** Map a tree-sitter node type to our SymbolKind. */
function kindFor(nodeType: string, parentKind: SymbolKind | null): SymbolKind {
    switch (nodeType) {
        case 'function_declaration':
        case 'function_signature':
            return 'function';
        case 'method_definition':
        case 'method_signature':
        case 'abstract_method_signature':
            return 'method';
        case 'class_declaration':
        case 'abstract_class_declaration':
            return 'class';
        case 'interface_declaration':
            return 'interface';
        case 'enum_declaration':
            return 'enum';
        case 'type_alias_declaration':
            return 'type';
        case 'lexical_declaration':
        case 'variable_declaration':
            // Caller checks the value node type before calling kindFor and
            // will pass 'function' when the declarator's value is an
            // arrow_function or function_expression. Here we handle the
            // non-function case: module-level constant vs local variable.
            return parentKind === null ? 'constant' : 'variable';
        case 'public_field_definition':
            // Class field with arrow/fn value — always a method (class member).
            return 'method';
        default:
            return 'function';
    }
}

/** Extract the symbol name from a node. Returns null if no name found. */
function extractName(node: Node): string | null {
    // Most declarations expose name via a field.
    const named = node.childForFieldName('name');
    if (named) return nameFromNode(named);

    // lexical_declaration / variable_declaration wrap variable_declarator
    // children — for these, return the first declarator's name.
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type === 'variable_declarator') {
                const id = child.childForFieldName('name');
                if (id) return nameFromNode(id);
            }
        }
    }

    // public_field_definition: `name = () => ...` in a class body.
    // The name field is a property_identifier or identifier.
    if (node.type === 'public_field_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) return nameNode.text;
    }

    // export_statement wraps a child declaration; we'll recurse on it
    // separately, so return null here.
    if (node.type === 'export_statement') return null;

    return null;
}

/**
 * Build a qualified name by walking up the symbol chain. Top-level
 * symbols have qualifiedName === name; methods inside a class have
 * `ClassName.methodName`; methods inside nested classes chain further.
 */
function buildQualifiedName(name: string, parentQName: string | null): string {
    return parentQName ? `${parentQName}.${name}` : name;
}

/**
 * Strip surrounding quotes from a tree-sitter string-literal node's text.
 * The grammar exposes the literal with its quote characters intact.
 */
function stripStringQuotes(text: string): string {
    return text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Wave 4.6 — pull out the property names from a CJS destructuring
 * binding, e.g. `const { helper, other: o } = require('./lib')` →
 * ['helper', 'other']. We capture the SOURCE property name (not the
 * local alias) because that's what's looked up in the target file's
 * symbol table. Returns null if the pattern isn't an object_pattern
 * we can read.
 */
function extractObjectPatternNames(pattern: Node): string[] | null {
    if (pattern.type !== 'object_pattern') return null;
    const names: string[] = [];
    for (let i = 0; i < pattern.namedChildCount; i++) {
        const child = pattern.namedChild(i);
        if (!child) continue;
        // shorthand_property_identifier_pattern → `{ helper }` (name === alias)
        if (child.type === 'shorthand_property_identifier_pattern' || child.type === 'shorthand_property_identifier') {
            names.push(child.text);
            continue;
        }
        // pair_pattern → `{ other: o }` — the key is the source name.
        if (child.type === 'pair_pattern') {
            const key = child.childForFieldName('key');
            if (key) names.push(key.text);
            continue;
        }
        // object_assignment_pattern → `{ x = default }` — still a shorthand source name.
        if (child.type === 'object_assignment_pattern') {
            const left = child.childForFieldName('left');
            if (left) names.push(left.text);
            continue;
        }
    }
    return names;
}

/**
 * Bound identifier names of an array destructuring pattern, in order:
 * `const [a, b] = …` → ['a','b']. Handles defaults (`[a = 1]`), rest
 * (`[...rest]`), holes (`[, b]` → skipped), and nested object/array patterns
 * (recursed). Mirror of extractObjectPatternNames for the array case.
 */
function extractArrayPatternNames(pattern: Node): string[] {
    const names: string[] = [];
    for (let i = 0; i < pattern.namedChildCount; i++) {
        const child = pattern.namedChild(i);
        if (!child) continue;
        if (child.type === 'identifier') { names.push(child.text); continue; }
        // `[a = 1]` — the left side is the bound name.
        if (child.type === 'assignment_pattern') {
            const left = child.childForFieldName('left');
            if (left && left.type === 'identifier') names.push(left.text);
            continue;
        }
        // `[...rest]` — the inner identifier.
        if (child.type === 'rest_pattern') {
            const inner = child.namedChild(0);
            if (inner && inner.type === 'identifier') names.push(inner.text);
            continue;
        }
        // Nested destructuring — flatten best-effort.
        if (child.type === 'object_pattern') { const n = extractObjectPatternNames(child); if (n) names.push(...n); continue; }
        if (child.type === 'array_pattern') { names.push(...extractArrayPatternNames(child)); continue; }
    }
    return names;
}

/**
 * Resolve a declarator's `name` node to a clean symbol name. For a destructuring
 * binding (object_pattern / array_pattern) the node's `.text` is the raw pattern
 * (`{ where, params }` / `[a, b]`) — out-of-alphabet for Lore ids AND ugly in the
 * UI. Derive a name from the bound identifiers instead (`where_params` / `a_b`).
 * buildSymbolId still slugs as a backstop; this just yields nicer names at source.
 */
function nameFromNode(nameNode: Node): string {
    if (nameNode.type === 'object_pattern') {
        const n = extractObjectPatternNames(nameNode);
        if (n && n.length > 0) return n.join('_');
    }
    if (nameNode.type === 'array_pattern') {
        const n = extractArrayPatternNames(nameNode);
        if (n.length > 0) return n.join('_');
    }
    return nameNode.text;
}

/**
 * Wave 4.6 — find a `require('./lib')` call expression inside an
 * arbitrary expression (handles `require('./lib')` as well as
 * `require('./lib').foo` member access). Returns the string-literal
 * specifier text (without quotes) or null if this isn't a require call
 * we can statically resolve.
 */
function extractRequireSpecifier(expr: Node): string | null {
    // Drill through member_expression on the LHS so `require('./x').y` still works.
    let target: Node | null = expr;
    while (target && target.type === 'member_expression') {
        target = target.childForFieldName('object');
    }
    if (!target || target.type !== 'call_expression') return null;
    const fn = target.childForFieldName('function');
    if (!fn || fn.type !== 'identifier' || fn.text !== 'require') return null;
    const args = target.childForFieldName('arguments');
    if (!args || args.namedChildCount !== 1) return null;
    const arg = args.namedChild(0);
    if (!arg) return null;
    if (arg.type !== 'string') return null;
    return stripStringQuotes(arg.text);
}

/** Find imports in the file's top-level. */
function extractImports(rootNode: Node): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;

        // ── ESM import_statement ────────────────────────────────
        if (child.type === 'import_statement') {
            const sourceNode = child.childForFieldName('source');
            const moduleSpec = sourceNode ? stripStringQuotes(sourceNode.text) : '';

            // Wave 4.6 — bucket the import_clause shapes separately so
            // the resolver knows which aliases are SYMBOL names (look
            // up in target) vs MODULE aliases (file-to-file edge).
            const namedImports: string[] = [];
            let defaultAlias: string | null = null;
            let namespaceAlias: string | null = null;

            const clause = child.namedChildren.find((n: Node) => n.type === 'import_clause');
            if (clause) {
                for (let j = 0; j < clause.namedChildCount; j++) {
                    const part = clause.namedChild(j);
                    if (!part) continue;
                    if (part.type === 'identifier') {
                        // Default import: `import X from '...'`
                        defaultAlias = part.text;
                    } else if (part.type === 'namespace_import') {
                        // `import * as X from '...'` — the alias is an identifier child.
                        const alias = part.namedChildren.find((n: Node) => n.type === 'identifier');
                        namespaceAlias = alias ? alias.text : '*';
                    } else if (part.type === 'named_imports') {
                        // `import { a, b as c } from '...'` — collect SOURCE names.
                        for (let k = 0; k < part.namedChildCount; k++) {
                            const spec = part.namedChild(k);
                            if (!spec || spec.type !== 'import_specifier') continue;
                            // `name` field is the source export; `alias` field is the local binding.
                            const nameField = spec.childForFieldName('name');
                            if (nameField) namedImports.push(nameField.text);
                        }
                    }
                }
            }

            // Keep `names` populated for back-compat. Namespace imports
            // historically expanded to '*' (wildcard); preserve that so
            // existing wildcard handling in buildImportEdges still works
            // for callers that haven't migrated to the bucketed fields.
            const flatNames: string[] = [...namedImports];
            if (namespaceAlias) flatNames.push('*');

            out.push({
                moduleSpecifier: moduleSpec,
                names: Array.from(new Set(flatNames)),
                namedImports,
                defaultAlias,
                namespaceAlias,
                isRequire: false,
                byteRange: byteRangeFromNode(child),
            });
            continue;
        }

        // ── CJS require — top-level lexical_declaration / variable_declaration ──
        // Wave 4.6 FIX 3 — `const x = require('./y')` and
        // `const { a, b } = require('./y')` are completely invisible to
        // the ESM-only import_statement walker. Recognise them here.
        if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
            for (let j = 0; j < child.namedChildCount; j++) {
                const decl = child.namedChild(j);
                if (!decl || decl.type !== 'variable_declarator') continue;
                const value = decl.childForFieldName('value');
                if (!value) continue;
                const moduleSpec = extractRequireSpecifier(value);
                if (!moduleSpec) continue;

                const binding = decl.childForFieldName('name');
                let defaultAlias: string | null = null;
                let namedImports: string[] = [];
                if (binding) {
                    if (binding.type === 'identifier') {
                        defaultAlias = binding.text;
                    } else {
                        const props = extractObjectPatternNames(binding);
                        if (props) namedImports = props;
                    }
                }

                const flatNames: string[] = [...namedImports];
                if (defaultAlias) flatNames.push(defaultAlias);

                out.push({
                    moduleSpecifier: moduleSpec,
                    names: Array.from(new Set(flatNames)),
                    namedImports,
                    defaultAlias,
                    namespaceAlias: null,
                    isRequire: true,
                    byteRange: byteRangeFromNode(child),
                });
            }
            continue;
        }

        // ── Bare `require('./y')` as an expression statement (side-effect-only) ──
        if (child.type === 'expression_statement') {
            const inner = child.namedChild(0);
            if (!inner) continue;
            const moduleSpec = extractRequireSpecifier(inner);
            if (!moduleSpec) continue;
            out.push({
                moduleSpecifier: moduleSpec,
                names: [],
                namedImports: [],
                defaultAlias: null,
                namespaceAlias: null,
                isRequire: true,
                byteRange: byteRangeFromNode(child),
            });
            continue;
        }
    }
    return out;
}

/**
 * Recursive descent: extract symbols inside `parent` (a class, file
 * root, or namespace body). Pushes into `out`. Tracks parent chain via
 * `parentSymbolId` and `parentQName`.
 */
function extractSymbolsIn(
    parent: Node,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQName: string | null,
    parentKind: SymbolKind | null,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < parent.namedChildCount; i++) {
        const child = parent.namedChild(i);
        if (!child) continue;

        // Unwrap `export ...` to the underlying declaration.
        let target: Node = child;
        if (child.type === 'export_statement') {
            // Export statements have a `declaration` field for inline
            // declarations and a different shape for re-exports. Find
            // the inner declaration if present.
            const inner = child.childForFieldName('declaration')
                ?? child.namedChildren.find((n: Node) => SYMBOL_NODE_TYPES.has(n.type) && n.type !== 'export_statement');
            if (!inner) continue;
            target = inner;
        }

        if (!SYMBOL_NODE_TYPES.has(target.type)) continue;
        if (target.type === 'export_statement') continue; // recursion guard

        const name = extractName(target);
        if (!name) continue;

        // ── Arrow/function-value refinements ─────────────────────
        // For const/let/var declarators and class fields, only include
        // when the assigned value is a function. Plain `const MAX = 3`
        // stays as 'constant'; `const fn = () => {}` becomes 'function'.
        // Class fields with non-function values (data) are skipped.
        let arrowValueNode: Node | null | undefined = null;
        if (target.type === 'lexical_declaration' || target.type === 'variable_declaration') {
            for (let j = 0; j < target.namedChildCount; j++) {
                const declarator = target.namedChild(j);
                if (declarator?.type === 'variable_declarator') {
                    const val = declarator.childForFieldName('value');
                    if (val && (val.type === 'arrow_function' || val.type === 'function_expression')) {
                        arrowValueNode = val;
                    }
                    break; // first declarator only
                }
            }
        } else if (target.type === 'public_field_definition') {
            const val = target.childForFieldName('value');
            if (!val || (val.type !== 'arrow_function' && val.type !== 'function_expression')) {
                continue; // skip non-function class fields (data fields)
            }
            arrowValueNode = val;
        }

        const kind: SymbolKind = (arrowValueNode && (
            target.type === 'lexical_declaration' || target.type === 'variable_declaration'
        ))
            ? 'function'                            // const foo = () => {} → function
            : kindFor(target.type, parentKind);     // everything else → normal kind logic
        const qname = buildQualifiedName(name, parentQName);
        const sym = makeParsedSymbol({
            name,
            qualifiedName: qname,
            kind,
            file,
            byteRange: byteRangeFromNode(target),
            signature: buildSignature(sourceUtf8, target),
            complexity: cyclomaticComplexity(target, TS_DECISION_TYPES),
            parentSymbolId,
        });
        out.push(sym);

        // Recurse into class / interface bodies to extract methods.
        const body = target.childForFieldName('body');
        if (body) {
            extractSymbolsIn(body, sourceUtf8, file, sym.id, qname, kind, out);
        }
    }
}

/**
 * Wave 4.6 FIX 3 (export half) — register CJS exports as synthetic
 * symbols so destructured-require imports (`const { foo } = require('./x')`)
 * can match a real symbol name in the target file's symbol table.
 *
 * Handled shapes (top-level expression statements only):
 *   - `module.exports = { foo, bar }`  → one symbol per property (foo, bar)
 *   - `module.exports.foo = ...`       → symbol 'foo'
 *   - `exports.foo = ...`              → symbol 'foo'
 *
 * Symbols are emitted with kind 'constant' since we can't always tell
 * whether the value is a function without deeper analysis — the
 * resolver only cares about name-matching, not kind.
 *
 * Synthetic symbols are appended only when no real symbol with that
 * name already exists in `existing` (which would have come from an
 * earlier `function foo()` + `module.exports = { foo }` re-export
 * pattern — the real declaration is the source of truth).
 */
function extractCjsExports(
    rootNode: Node,
    sourceUtf8: Uint8Array,
    file: string,
    existing: ParsedSymbol[],
): ParsedSymbol[] {
    const existingNames = new Set(existing.map((s) => s.name));
    const out: ParsedSymbol[] = [];

    const emit = (name: string, anchor: Node): void => {
        if (!name) return;
        if (existingNames.has(name)) return;
        if (out.some((s) => s.name === name)) return;
        const sym = makeParsedSymbol({
            name,
            qualifiedName: name,
            kind: 'constant',
            file,
            byteRange: byteRangeFromNode(anchor),
            signature: buildSignature(sourceUtf8, anchor),
            complexity: 1,
            parentSymbolId: null,
        });
        out.push(sym);
    };

    /** Match `module.exports` / `exports` LHS of an assignment.
     *  Returns 'module' for `module.exports[.x]?`, 'exports' for `exports.x`, null otherwise. */
    const classifyExportsLhs = (lhs: Node): { root: 'module' | 'exports'; tail: string | null } | null => {
        if (lhs.type !== 'member_expression') return null;
        const obj = lhs.childForFieldName('object');
        const prop = lhs.childForFieldName('property');
        if (!obj || !prop) return null;
        // `exports.foo = ...`
        if (obj.type === 'identifier' && obj.text === 'exports') {
            return { root: 'exports', tail: prop.text };
        }
        // `module.exports = ...` (no tail) or `module.exports.foo = ...` (tail = 'foo')
        if (obj.type === 'identifier' && obj.text === 'module' && prop.text === 'exports') {
            return { root: 'module', tail: null };
        }
        if (obj.type === 'member_expression') {
            const innerObj = obj.childForFieldName('object');
            const innerProp = obj.childForFieldName('property');
            if (innerObj?.type === 'identifier' && innerObj.text === 'module'
                && innerProp?.text === 'exports') {
                return { root: 'module', tail: prop.text };
            }
        }
        return null;
    };

    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child || child.type !== 'expression_statement') continue;
        const inner = child.namedChild(0);
        if (!inner || inner.type !== 'assignment_expression') continue;

        const lhs = inner.childForFieldName('left');
        const rhs = inner.childForFieldName('right');
        if (!lhs || !rhs) continue;

        const cls = classifyExportsLhs(lhs);
        if (!cls) continue;

        if (cls.tail) {
            // `module.exports.foo = ...` or `exports.foo = ...`
            emit(cls.tail, child);
            continue;
        }

        // `module.exports = ...` — only the object-literal shape gives us names.
        if (rhs.type === 'object') {
            for (let j = 0; j < rhs.namedChildCount; j++) {
                const prop = rhs.namedChild(j);
                if (!prop) continue;
                if (prop.type === 'shorthand_property_identifier' || prop.type === 'shorthand_property_identifier_pattern') {
                    emit(prop.text, prop);
                } else if (prop.type === 'pair') {
                    const key = prop.childForFieldName('key');
                    if (key) emit(key.text, prop);
                } else if (prop.type === 'method_definition') {
                    const name = prop.childForFieldName('name');
                    if (name) emit(name.text, prop);
                }
            }
        }
        // Other RHS shapes (`module.exports = SomeIdentifier`,
        // `module.exports = function () {}`) don't yield discoverable
        // names; skipped on purpose.
    }
    return out;
}

/**
 * Object-literal function properties → symbols (the handler-map fix).
 *
 * `registry.register({ name: 'atlas_call_graph', handler: async (args) => { …resolveCodeReader()… } })`
 * — the handler is a real, separately-invoked function, but it has no
 * declaration of its own, so nothing in `symbols` covers its body. Call
 * attribution then walks up (innermostContainingSymbol) to the nearest
 * NAMED enclosing function, so every call inside every handler of a
 * registry/route/command map collapses onto the enclosing builder — the
 * call graph claims `buildRegistry` called `resolveCodeReader`, and the
 * per-tool-handler breakdown is unrecoverable from the graph.
 *
 * This pass emits one symbol per function-valued object property
 * (arrow functions, function expressions, and shorthand object methods),
 * following the existing function-local naming convention seen elsewhere
 * in the graph (`outerFn.localName`):
 *
 *   - when the object carries an identifying string sibling — a `name` or
 *     `id` pair with a string value, the descriptor-object idiom used by
 *     tool registries, route tables, and command maps — the symbol is
 *     named after it: `buildRegistry.atlas_call_graph`.
 *   - otherwise the property key names it: `MyComponent.onClick`.
 *
 * Deliberately NOT extracted (unchanged noise policy): bare callback
 * arguments (`arr.map(x => …)`, `useEffect(() => …)`) — those aren't
 * property values and don't carry an identity.
 *
 * Runs BEFORE extractCjsExports so `module.exports = { foo() {} }` gets a
 * real `function` symbol and the CJS synthetic-export pass (which defers
 * to existing names) doesn't emit a duplicate `constant` for it.
 */
function extractObjectHandlerSymbols(
    rootNode: Node,
    sourceUtf8: Uint8Array,
    file: string,
    symbols: ParsedSymbol[],
): void {
    const seen = new Set(symbols.map((s) => s.id));
    walkSubtree(rootNode, (node) => {
        let fnNode: Node;
        let key: string | null = null;
        if (node.type === 'arrow_function' || node.type === 'function_expression') {
            const parent = node.parent;
            if (!parent || parent.type !== 'pair') return; // call arg / declarator value / anything else
            const keyNode = parent.childForFieldName('key');
            if (!keyNode) return;
            if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
                key = keyNode.text;
            } else if (keyNode.type === 'string') {
                key = stripStringQuotes(keyNode.text);
            } else {
                return; // computed / dynamic key — no stable identity
            }
            fnNode = node;
        } else if (node.type === 'method_definition') {
            // Shorthand object method (`{ foo() {} }`). class_body methods
            // were already extracted by extractSymbolsIn — object literals only.
            const parent = node.parent;
            if (!parent || parent.type !== 'object') return;
            const nameNode = node.childForFieldName('name');
            if (!nameNode) return;
            key = nameNode.text;
            fnNode = node;
        } else {
            return;
        }
        if (!key) return;

        // Identity: prefer a string `name`/`id` sibling (descriptor-object
        // idiom) over the property key. First candidate whose id isn't
        // already taken wins; a fallback keeps multi-function descriptors
        // (`{ id: 'x', get: fn, set: fn }`) from collapsing onto one node.
        // The object literal this function lives in: for a `pair` value the
        // chain is object → pair → fn; for a shorthand method it's object → fn.
        const ownerObj = fnNode.parent!.type === 'pair'
            ? fnNode.parent!.parent
            : fnNode.parent!;
        let siblingName: string | null = null;
        if (ownerObj && ownerObj.type === 'object') {
            for (let i = 0; i < ownerObj.namedChildCount; i++) {
                const sib = ownerObj.namedChild(i);
                if (!sib || sib.type !== 'pair' || sib === fnNode.parent) continue;
                const sibKey = sib.childForFieldName('key');
                if (!sibKey || (sibKey.text !== 'name' && sibKey.text !== 'id')) continue;
                const sibVal = sib.childForFieldName('value');
                if (sibVal?.type === 'string') {
                    siblingName = stripStringQuotes(sibVal.text);
                    break;
                }
            }
        }

        // The enclosing named symbol (function/method). innermostContainingSymbol
        // sees handler symbols added by earlier iterations of this same walk
        // (pre-order), so nested handler maps chain their qualified names.
        const owner = innermostContainingSymbol(symbols, fnNode, FUNCTION_METHOD_KINDS);
        const parentQName = owner?.qualifiedName ?? null;

        const candidates = siblingName && siblingName !== key
            ? [siblingName, key, `${siblingName}.${key}`]
            : [key, `${key}.${key}`];
        for (const candidate of candidates) {
            if (!candidate) continue;
            const qname = buildQualifiedName(candidate, parentQName);
            const sym = makeParsedSymbol({
                name: candidate,
                qualifiedName: qname,
                kind: 'function',
                file,
                byteRange: byteRangeFromNode(fnNode),
                signature: buildSignature(sourceUtf8, fnNode),
                complexity: cyclomaticComplexity(fnNode, TS_DECISION_TYPES),
                parentSymbolId: owner?.id ?? null,
            });
            if (seen.has(sym.id)) continue; // same identity already emitted — keep first
            seen.add(sym.id);
            symbols.push(sym);
            return;
        }
    });
}

/**
 * Walker entry point — see WalkerFn contract in `_base.ts`.
 */
export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractSymbolsIn(rootNode, sourceUtf8, file, null, null, null, symbols);
    // Handler-map fix — function-valued object properties get their own
    // symbols (before the CJS-export synthetics, which defer to real names).
    extractObjectHandlerSymbols(rootNode, sourceUtf8, file, symbols);
    // Wave 4.6 FIX 3 — register CJS-only exports as synthetic symbols.
    // No-op for pure ESM files (no top-level `module.exports = ...`).
    symbols.push(...extractCjsExports(rootNode, sourceUtf8, file, symbols));
    const imports = extractImports(rootNode);

    // Phase 2.1: extract calls per function/method symbol body.
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_declaration'
            && node.type !== 'method_definition'
            && node.type !== 'arrow_function'
            && node.type !== 'function_expression') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        // Find the enclosing symbol id for this body.
        const ownerSym = innermostContainingSymbol(symbols, node, FUNCTION_METHOD_KINDS);
        if (!ownerSym) return;
        calls.push(...extractCallsInBody(body, ownerSym.id, TS_CALL_NODE_TYPES, extractTsCallee, TYPESCRIPT_SCOPE_TYPES));
    });

    return { symbols, imports, calls };
};
