/**
 * resolver/importGraph.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Import-graph fallback — relative imports + workspace aliases.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Resolves each ParsedImport's `moduleSpecifier` to a repo-relative
 * file path when possible. Builds a map from (importingFile,
 * importedName) → [resolvedFilePath, ...] suitable for the call graph
 * resolver to look up "where does this import point?"
 *
 * Resolution strategies (per language family):
 *   - TypeScript / JavaScript: relative paths, tsconfig "paths" aliases,
 *     index.ts / .ts / .tsx / .js extension search.
 *   - Python: dotted modules with relative ('.' / '..') prefix support.
 *   - Other languages: direct file-path matching only (Go module paths,
 *     Rust crate paths, Java packages — these need package-manager
 *     awareness which is deferred to a per-language enhancement).
 *
 * Returns ParsedRelation edges of kind `imports` for every successfully
 * resolved import. Unresolved imports are logged in the diagnostics
 * stream so callers can surface them.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
    Language,
    ParsedFile,
    ParsedImport,
    ParsedRelation,
} from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';

/**
 * Resolution context: per-repo metadata that drives import resolution.
 * Built once per parseRepo call and reused across all files.
 */
export interface ResolutionContext {
    repoRoot: string;
    /** Map: alias prefix → [target-prefix, ...] from tsconfig.json `paths`. */
    tsAliases: Map<string, string[]>;
    /** Set of repo-relative file paths that exist. Used for extension search. */
    repoFileSet: Set<string>;
}

/**
 * Build a resolution context from the parsed file list + filesystem.
 * Reads tsconfig.json `paths` if present.
 *
 * `extraRepoFilePaths` — repo-relative paths of files that exist in the
 * persisted workspace graph but NOT in this parse batch (single-file
 * incremental index). Import-specifier resolution walks `repoFileSet`, so
 * without the persisted peers' paths a single-file run can't even map
 * `'./lore/embeddedLore.js'` to a repo file, let alone to its symbols.
 */
export async function buildResolutionContext(
    repoRoot: string,
    parsedFiles: readonly ParsedFile[],
    extraRepoFilePaths?: ReadonlySet<string>,
): Promise<ResolutionContext> {
    const tsAliases = new Map<string, string[]>();
    try {
        const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
        const raw = await fs.readFile(tsconfigPath, 'utf-8');
        // tsconfig is a JSON file but often contains comments; strip them.
        const cleaned = raw.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(cleaned);
        const paths = cfg?.compilerOptions?.paths;
        const baseUrl = cfg?.compilerOptions?.baseUrl ?? '.';
        if (paths && typeof paths === 'object') {
            for (const [key, valueRaw] of Object.entries(paths)) {
                const values = Array.isArray(valueRaw) ? valueRaw as string[] : [String(valueRaw)];
                // Strip the trailing /* if any.
                const aliasPrefix = key.replace(/\*$/, '').replace(/\/$/, '');
                const targets = values.map((v) => {
                    const stripped = v.replace(/\*$/, '').replace(/\/$/, '');
                    return path.posix.normalize(path.posix.join(baseUrl, stripped));
                });
                tsAliases.set(aliasPrefix, targets);
            }
        }
    } catch {
        // tsconfig absent or unreadable — fine, just no aliases.
    }

    const repoFileSet = new Set<string>(parsedFiles.map((f) => f.path));
    if (extraRepoFilePaths) for (const p of extraRepoFilePaths) repoFileSet.add(p);
    return { repoRoot, tsAliases, repoFileSet };
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
const PY_EXTENSIONS = ['.py', '.pyi'];

/**
 * Try to resolve a moduleSpecifier from a TypeScript / JavaScript file
 * to a repo-relative file path. Returns null if no match found.
 */
function resolveTypeScriptImport(
    fromFile: string,
    moduleSpecifier: string,
    ctx: ResolutionContext,
): string | null {
    // ESM convention: TS source imports use `.js` / `.jsx` / `.mjs`
    // suffixes even though the on-disk file is `.ts` / `.tsx` / `.mts`.
    // Strip the JS-side suffix so findFileWithExtensions can re-attach
    // the right TS extension and find the actual file.
    const stripped = moduleSpecifier.replace(/\.(jsx?|mjs|cjs)$/, '');

    // 1. Relative imports
    if (stripped.startsWith('./') || stripped.startsWith('../')) {
        const dir = path.posix.dirname(fromFile);
        const joined = path.posix.normalize(path.posix.join(dir, stripped));
        return findFileWithExtensions(joined, TS_EXTENSIONS, ctx);
    }

    // 2. tsconfig paths aliases
    for (const [aliasPrefix, targets] of ctx.tsAliases) {
        if (!aliasPrefix) continue;
        if (stripped === aliasPrefix || stripped.startsWith(aliasPrefix + '/')) {
            const remainder = stripped.slice(aliasPrefix.length).replace(/^\//, '');
            for (const target of targets) {
                const candidate = remainder ? path.posix.join(target, remainder) : target;
                const resolved = findFileWithExtensions(candidate, TS_EXTENSIONS, ctx);
                if (resolved) return resolved;
            }
        }
    }

    // 3. Bare specifier — likely a node_modules package; not part of repo graph.
    return null;
}

/**
 * Try to resolve a Python import. Handles relative imports (leading
 * dots) and dotted absolute imports against the repo file tree.
 */
function resolvePythonImport(
    fromFile: string,
    moduleSpecifier: string,
    ctx: ResolutionContext,
): string | null {
    if (!moduleSpecifier) return null;

    if (moduleSpecifier.startsWith('.')) {
        // Relative: count leading dots → that many levels up.
        let level = 0;
        while (moduleSpecifier[level] === '.') level += 1;
        const remainder = moduleSpecifier.slice(level).replace(/\./g, '/');
        let dir = path.posix.dirname(fromFile);
        for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
        const joined = remainder ? path.posix.join(dir, remainder) : dir;
        return findFileWithExtensions(joined, PY_EXTENSIONS, ctx)
            ?? findFileWithExtensions(path.posix.join(joined, '__init__'), PY_EXTENSIONS, ctx);
    }

    // Absolute dotted: foo.bar.baz → foo/bar/baz.py or foo/bar/baz/__init__.py
    const asPath = moduleSpecifier.replace(/\./g, '/');
    return findFileWithExtensions(asPath, PY_EXTENSIONS, ctx)
        ?? findFileWithExtensions(path.posix.join(asPath, '__init__'), PY_EXTENSIONS, ctx);
}

/**
 * Find a file in the repo with one of the given extensions appended.
 * Also tries `<base>/index.<ext>` as a last resort (Node-style index lookup).
 */
function findFileWithExtensions(
    base: string,
    extensions: readonly string[],
    ctx: ResolutionContext,
): string | null {
    // Direct hit (specifier already has extension or is exact).
    if (ctx.repoFileSet.has(base)) return base;

    for (const ext of extensions) {
        const withExt = base + ext;
        if (ctx.repoFileSet.has(withExt)) return withExt;
    }

    // index lookup
    for (const ext of extensions) {
        const indexPath = path.posix.join(base, 'index' + ext);
        if (ctx.repoFileSet.has(indexPath)) return indexPath;
    }

    return null;
}

/**
 * Resolve a single import to a file path, dispatching by language.
 */
export function resolveImport(
    fromFile: string,
    fromLanguage: Language,
    importSpec: ParsedImport,
    ctx: ResolutionContext,
): string | null {
    switch (fromLanguage) {
        case 'typescript':
        case 'tsx':
        case 'javascript':
            return resolveTypeScriptImport(fromFile, importSpec.moduleSpecifier, ctx);
        case 'python':
            return resolvePythonImport(fromFile, importSpec.moduleSpecifier, ctx);
        // Go / Rust / Java / C# / C / C++ / Ruby: resolution requires
        // package-manager awareness (go.mod, Cargo.toml, mvn pom, etc.)
        // which we don't yet model. v1 leaves these unresolved; a
        // per-language fast-follow can extend this dispatch.
        default:
            return null;
    }
}

/**
 * Resolve every import in every file, producing ParsedRelation edges
 * of kind `imports`. The edges target the FIRST symbol matched in the
 * destination file (or no edge if the file has no symbols matching the
 * imported names).
 */
export function buildImportEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): { edges: ParsedRelation[]; resolved: number; unresolved: number; externalModules: Set<string> } {
    const edges: ParsedRelation[] = [];
    let resolved = 0;
    let unresolved = 0;
    // GF-3 — every module specifier that did NOT resolve to a repo-internal
    // file is treated as EXTERNAL (npm package, stdlib, unresolved alias). We
    // record it once (deduped) so the batch driver can emit one `code_import`
    // node per module, and we emit a file→import `imports` relation per import
    // site (targetId = `import:<module>` sentinel, routed to the import node by
    // store/codeNodes.ts codeSymbolIdFromRaw). Internal imports stay as the
    // resolved file/symbol edges below — NOT duplicated here.
    const externalModules = new Set<string>();

    for (const file of files) {
        for (const imp of file.imports) {
            const targetFile = resolveImport(file.path, file.language, imp, ctx);
            if (!targetFile) {
                unresolved += 1;
                const mod = imp.moduleSpecifier;
                if (mod) {
                    externalModules.add(mod);
                    edges.push({
                        sourceId: `file:${file.path}`,
                        targetId: `import:${mod}`,
                        kind: 'imports',
                        // External module isn't resolved to a concrete file, so
                        // it's a touch below a resolved internal edge (1.0) but
                        // still a real, AST-extracted dependency fact.
                        confidence: 0.9,
                        reason: `external import from '${mod}'${imp.isRequire ? ' (require)' : ''}`,
                    });
                }
                continue;
            }
            resolved += 1;

            const fileMap = table.byFile.get(targetFile);
            const sourceId = `file:${file.path}`;
            const targetFileId = `file:${targetFile}`;

            // Wave 4.6 FIX 2 — distinguish the three import shapes:
            //   - namedImports[] → look up SYMBOL names in the target file.
            //   - defaultAlias   → bind the module's default export; the
            //                      local alias is NOT a symbol name in the
            //                      target (looking it up always misses).
            //                      Emit a single file-to-file edge — the
            //                      semantic "this file imports that file".
            //   - namespaceAlias → binds the whole module; one file-to-file
            //                      edge, NOT a wildcard-per-symbol explosion
            //                      (the old behaviour over-counted and
            //                      bloated the graph).
            //
            // Back-compat path: walkers that haven't migrated yet (non-TS
            // walkers — python, go, rust, etc.) still populate `names`
            // only. For those we fall back to the pre-4.6 behaviour: a
            // '*' entry triggers wildcard expansion, named entries
            // resolve by symbol name. Default/namespace fields being
            // undefined is the signal that we're on the legacy path.
            const hasBucketedFields =
                imp.namedImports !== undefined
                || imp.defaultAlias !== undefined
                || imp.namespaceAlias !== undefined;

            if (hasBucketedFields) {
                // Named imports — exported symbol lookups (correct semantics).
                for (const importedName of imp.namedImports ?? []) {
                    if (!fileMap) continue;
                    const matches = fileMap.get(importedName);
                    if (matches && matches.length > 0) {
                        for (const sym of matches) {
                            edges.push({
                                sourceId,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 1.0,
                                reason: `import { ${importedName} } from '${imp.moduleSpecifier}'`,
                            });
                        }
                    }
                }

                // Default-import alias — try a literal `default` export
                // first (rare in user code; ESM convention), otherwise
                // emit a file-to-file edge so the import is still visible
                // in the graph.
                if (imp.defaultAlias) {
                    const defaultMatches = fileMap?.get('default');
                    if (defaultMatches && defaultMatches.length > 0) {
                        for (const sym of defaultMatches) {
                            edges.push({
                                sourceId,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 0.9,
                                reason: `import ${imp.defaultAlias} from '${imp.moduleSpecifier}' (default)`,
                            });
                        }
                    } else {
                        edges.push({
                            sourceId,
                            targetId: targetFileId,
                            kind: 'imports',
                            confidence: 0.9,
                            reason: `import ${imp.defaultAlias} from '${imp.moduleSpecifier}' (default → file)`,
                        });
                    }
                }

                // Namespace-import alias — one file-to-file edge.
                if (imp.namespaceAlias) {
                    edges.push({
                        sourceId,
                        targetId: targetFileId,
                        kind: 'imports',
                        confidence: 0.9,
                        reason: `import * as ${imp.namespaceAlias} from '${imp.moduleSpecifier}'`,
                    });
                }

                // Side-effect-only ESM/CJS import: no names at all. Still
                // a real dependency; emit a file-to-file edge so the
                // graph reflects it.
                if ((imp.namedImports?.length ?? 0) === 0
                    && !imp.defaultAlias
                    && !imp.namespaceAlias) {
                    edges.push({
                        sourceId,
                        targetId: targetFileId,
                        kind: 'imports',
                        confidence: 0.8,
                        reason: `side-effect import from '${imp.moduleSpecifier}'`,
                    });
                }
                continue;
            }

            // ── Legacy path (non-TS walkers without bucketed fields) ──
            if (!fileMap) continue;
            const namesToFind = imp.names.length > 0 ? imp.names : ['*'];
            for (const importedName of namesToFind) {
                if (importedName === '*') {
                    // Wildcard: emit one edge per public symbol in the target file.
                    for (const [, symbols] of fileMap) {
                        for (const sym of symbols) {
                            edges.push({
                                sourceId,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 0.85,
                                reason: `wildcard import from '${imp.moduleSpecifier}'`,
                            });
                        }
                    }
                } else {
                    const matches = fileMap.get(importedName);
                    if (matches && matches.length > 0) {
                        for (const sym of matches) {
                            edges.push({
                                sourceId,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 1.0,
                                reason: `import { ${importedName} } from '${imp.moduleSpecifier}'`,
                            });
                        }
                    }
                }
            }
        }
    }

    return { edges, resolved, unresolved, externalModules };
}
