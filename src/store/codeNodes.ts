/**
 * store/codeNodes.ts — Convert ParsedFile → Lore nodes/edges.
 *
 * X3 indexing pipeline:
 *   parser.parseFile(absPath) → ParsedFile
 *   indexParsedFile(file, …)  → store_node + store_edge over MCP
 *
 * Node types (Atlas-owned, Lore stores whatever type string is passed):
 *
 *   - CodeFile   → type='code_file'   (embed: false — graph traversal only)
 *   - CodeSymbol → type='code_symbol' (embed: false — looked up by UID)
 *   - CodeRelation → relation='calls' | 'imports' | 'extends' | 'contains' …
 *
 * Sprint 1 (typed code edges): mapRelationKind now passes the REAL parser
 * RelationKind through to the stored Lore edge (it used to collapse every
 * kind onto 'related_to'). The structural file→symbol containment edge is
 * written as 'contains'; the code_context bridge as 'describes'
 * (schema.CONTEXT_RELATION). Pre-Sprint-1 graphs keep their 'related_to'
 * edges until a forced re-index (see MIGRATION note at mapRelationKind).
 *
 * Atlas is the developer application. Lore is schema-agnostic — it
 * accepts any type string. No plugin registration needed.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ParsedFile, ParsedRelation, ParsedSymbol, RelationKind } from '../parser/types.js';
import { isCodeRelationKind, CONTEXT_RELATION } from '../schema.js';
import { scrubSecrets } from '../security/secretScrub.js';
import type { LoreWriter, StoreNodeInput, StoreEdgeInput } from '../loreClient.js';

export interface IndexParsedFileOpts {
    workspace: string;
    repo: string;
    /** Absolute path used to derive lastModified. Falls back to file.path. */
    absolutePath?: string;
    /**
     * GF-2 — per-run context-layer mode. When set, OVERRIDES the module-load
     * snapshot (so the whole-repo size guard can downgrade spans→file or
     * file→off for one index without mutating env). When absent, the snapshot
     * default (`defaultContextMode()`) applies — this is the path an
     * incremental single-file re-index takes, where the per-repo
     * count isn't available and embedding one file is always cheap.
     */
    contextMode?: ContextMode;
}

export interface IndexParsedFileResult {
    codeFileId: string;
    codeSymbolIds: string[];
    codeRelationCount: number;
    /** Edges skipped because an endpoint symbol wasn't a resolved node
     *  (best-effort cross-references — e.g. an unresolved member access). */
    droppedEdgeCount: number;
}

/**
 * Y3 (Sprint Y3, 2026-05-23) — pure extraction shape used by the
 * recursive/batch indexer in src/cli/batchWriter.ts. Returns the
 * (nodes, edges) the original indexParsedFile would have written
 * one-by-one, without touching the network. The single-file
 * indexParsedFile path below still drives storeNode/storeEdge per
 * item to preserve back-compat with callers that depend on the
 * one-shot write semantics; the bulk path skips the loop and POSTs
 * the whole batch in one HTTP round-trip via W9's bulk endpoints.
 */
export interface IndexBatch {
    nodes: StoreNodeInput[];
    edges: StoreEdgeInput[];
    fileNodeId: string;
    codeSymbolIds: string[];
}

const CODE_FILE_PREFIX = 'code-file:';
const CODE_SYMBOL_PREFIX = 'code-symbol:';
// GF-3 — folder nodes are repo-qualified (a directory belongs to one repo);
// import nodes are repo-UNqualified (an external npm package like `react` is a
// shared identity across every repo in a workspace, so all importers point at
// ONE `code-import:react` node — see buildImportNodes / the `import:` router).
const CODE_FOLDER_PREFIX = 'code-folder:';
const CODE_IMPORT_PREFIX = 'code-import:';
// Sentinel for the repo root directory in folder ids, so root-level files
// (e.g. `index.ts` whose posix.dirname is `.`) still attach to a folder node.
const ROOT_DIR = '.';

// Snapshot at MODULE LOAD — Lore's createLore() scrubs process.env (drops non-
// allow-listed vars) during EmbeddedLore.open(), which runs BEFORE the indexer.
// Reading the flag inline would always see it already-scrubbed (same root cause
// as the ATLAS_HOME snapshot in config.ts). Captured here, it survives.
//
// GF-2 — the context layer is the ONLY embedded code surface (code_file /
// code_symbol are written embed:false), so it IS semantic code search. It is now
// DEFAULT-ON: unset → ON, ATLAS_CONTEXT_LAYER=1 → ON (explicit, still works),
// ATLAS_CONTEXT_LAYER=0 → OFF (explicit force into the lean graph-only mode, no
// embeds). The predicate is "on unless explicitly disabled" — `!== '0'`.
const CONTEXT_LAYER_ENABLED = process.env.ATLAS_CONTEXT_LAYER !== '0';
// SPANS mode (opt-in): emit one embedded card PER SYMBOL (with its line-range in
// metadata) instead of one per file — so retrieval can return the relevant
// function and a consumer can feed just those lines, not the whole file (the
// token-cost lever). Costs ~1 embed per multi-line symbol (~5-10× file-mode), so
// it stays OPT-IN: unset/0 → file-mode (the GF-2 default), =1 → span-mode.
const CONTEXT_SPANS = process.env.ATLAS_CONTEXT_SPANS === '1';

/**
 * GF-2 — the per-run context mode. The module-load snapshot above is the
 * DEFAULT; the size guard (cli.ts / mcp/tools/index.ts) computes the repo's
 * file/symbol counts up front and may DOWNGRADE the effective mode per run
 * (spans→file above CONTEXT_SPANS_MAX_SYMBOLS; file→off above
 * CONTEXT_LAYER_MAX_FILES) so a huge monorepo never silently spends minutes
 * embedding. `opts.contextMode` overrides the snapshot when present; absent, the
 * snapshot wins (an incremental single-file re-index is exempt —
 * it embeds at most one file's worth, so it keeps the snapshot default).
 */
export type ContextMode = 'spans' | 'file' | 'off';

/** The snapshot mode, used as the default when opts.contextMode is absent. */
export function defaultContextMode(): ContextMode {
    if (!CONTEXT_LAYER_ENABLED) return 'off';
    return CONTEXT_SPANS ? 'spans' : 'file';
}

// GF-2 size-guard thresholds (tunable; anchored to the dayjs ~180-file/seconds
// measurement in docs/PERFORMANCE.md). Above the symbol cap, a requested
// span-mode falls back to file-mode; above the file cap, the layer falls back to
// off (graph-only). Env-overridable so a repo can opt back in to the heavy path.
export const CONTEXT_SPANS_MAX_SYMBOLS = numFromEnv('ATLAS_CONTEXT_SPANS_MAX_SYMBOLS', 20_000);
export const CONTEXT_LAYER_MAX_FILES = numFromEnv('ATLAS_CONTEXT_LAYER_MAX_FILES', 10_000);

function numFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * GF-2 size guard — resolve the EFFECTIVE context mode for a whole-repo index,
 * given the requested mode and the repo's total file/symbol counts (both known
 * up front, before the per-file embed loop). Returns the (possibly downgraded)
 * mode plus a human-readable `note` when a downgrade happened, so the caller can
 * emit exactly one clear stderr line stating what occurred and how to override.
 * Never silently produces a minutes-long index.
 */
export function resolveContextMode(
    requested: ContextMode,
    counts: { files: number; symbols: number },
): { mode: ContextMode; note?: string } {
    if (requested === 'off') return { mode: 'off' };
    // File-cap wins first: above it, the layer is too expensive in ANY mode.
    if (counts.files > CONTEXT_LAYER_MAX_FILES) {
        return {
            mode: 'off',
            note: `context layer: ${counts.files} files > ${CONTEXT_LAYER_MAX_FILES} → disabling semantic layer (graph-only) ` +
                `(raise ATLAS_CONTEXT_LAYER_MAX_FILES to override)`,
        };
    }
    if (requested === 'spans' && counts.symbols > CONTEXT_SPANS_MAX_SYMBOLS) {
        return {
            mode: 'file',
            note: `context layer: ${counts.symbols} symbols > ${CONTEXT_SPANS_MAX_SYMBOLS} → falling back from spans to file mode ` +
                `(raise ATLAS_CONTEXT_SPANS_MAX_SYMBOLS or unset ATLAS_CONTEXT_SPANS to override)`,
        };
    }
    return { mode: requested };
}

/**
 * F1: qualify a raw id with the repo so the SAME relative path in two
 * different projects (e.g. both have `src/index.ts`) does NOT collide
 * and overwrite each other when indexed into one workspace. Repo-less
 * callers (legacy tests) get the unqualified id.
 */
function qualify(repo: string | undefined, raw: string): string {
    return repo ? `${repo}/${raw}` : raw;
}

export function codeFileId(file: ParsedFile, repo?: string): string {
    return CODE_FILE_PREFIX + qualify(repo, file.path);
}

export function codeSymbolId(sym: ParsedSymbol, repo?: string): string {
    return CODE_SYMBOL_PREFIX + qualify(repo, sym.id);
}

/** Edge endpoints reference raw symbol-id strings (ParsedRelation.source/targetId);
 *  qualify them identically so edges still connect to the qualified nodes.
 *
 *  Wave 4.6 FIX 1 — the import-edge resolver emits sourceId = `file:<path>`
 *  for file-level import endpoints. Naively prefixing those with
 *  `code-symbol:` produces a bogus id (`code-symbol:<repo>/file:<path>`)
 *  that never matches a written node, so the strict graph store rejects
 *  the edge and `tryEdge` silently drops it. Route `file:` rawIds through
 *  CodeFile semantics so cross-file import edges actually land. */
function codeSymbolIdFromRaw(rawId: string, repo?: string): string {
    if (rawId.startsWith('file:')) {
        return CODE_FILE_PREFIX + qualify(repo, rawId.slice('file:'.length));
    }
    // GF-3 — the import-graph resolver emits targetId = `import:<moduleSpecifier>`
    // for EXTERNAL/unresolved modules (npm packages etc.). Route those to the
    // repo-UNqualified `code-import:` node so a package is one shared node per
    // workspace, and the file→import edge lands on it (same mechanism as the
    // `file:` fix above). The module specifier is the dedup key — NOT qualified.
    if (rawId.startsWith('import:')) {
        // Route through codeImportId so the edge TARGET id is byte-identical to
        // the node id it must match — including the safe-alphabet slug below.
        return codeImportId(rawId.slice('import:'.length));
    }
    return CODE_SYMBOL_PREFIX + qualify(repo, rawId);
}

/** GF-3 — id of a folder node for a repo-relative directory path. The repo
 *  root (posix.dirname → '.') uses the ROOT_DIR sentinel so root-level files
 *  still get a parent folder node. Repo-qualified (a directory is repo-local). */
export function codeFolderId(dir: string, repo?: string): string {
    return CODE_FOLDER_PREFIX + qualify(repo, dir);
}

/** GF-3 — id of an external-import node for a module specifier. NOT
 *  repo-qualified: an npm package is a shared identity across the workspace,
 *  so every importer in every repo points at the SAME node (which is the whole
 *  point of the import-coupling view).
 *
 *  RD-import-slug — the module specifier goes straight into the id, so it must
 *  stay inside Lore's safe-id alphabet ([A-Za-z0-9 :.\-_/@], enforced by
 *  assertSafeLanceId — a SQL-predicate-injection control). Most specifiers
 *  already do: npm ('@scope/pkg'), dotted/relative paths ('./foo', 'std::io')
 *  only use `@ / . : - _`, all in-alphabet. But Rust/Python GROUPED imports
 *  carry `{ } ,` (`use std::io::{Read, Write}`) and generics carry `< >` —
 *  out-of-alphabet, so Lore rejects the node write AND every file→import edge
 *  pointing at it (edge_endpoint_missing), silently dropping the import. We
 *  slug ONLY the out-of-alphabet chars (runs → single `_`); the safe structural
 *  chars stay intact so every existing package identity — and its cross-repo
 *  dedup — is byte-for-byte unchanged (no reindex churn). The human-readable
 *  raw specifier is preserved in the node's label/content/metadata. */
export function codeImportId(moduleSpecifier: string): string {
    // Space is technically in-alphabet, but a space in an id is noise — treat it
    // as a separator too. Collapse unsafe runs to one `_`, then trim edges so a
    // trailing `}`/`>` doesn't leave a dangling `_`.
    const safe = moduleSpecifier
        .replace(/[^A-Za-z0-9:.\-_/@]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return CODE_IMPORT_PREFIX + (safe.length > 0 ? safe : '_');
}

/** The basename of a posix directory path, with the root sentinel labeled
 *  cleanly. Used for folder node labels. */
function folderLabel(dir: string): string {
    if (dir === ROOT_DIR || dir === '') return '/';
    const base = dir.split('/').pop();
    return base || dir;
}

/**
 * GF-3 — synthesize the FOLDER tree for a whole repo from the file set, ONCE
 * (not per-file: a per-file pass can't dedup the tree and would re-emit a node
 * per file). Returns:
 *   - one `code_folder` node per unique directory prefix (every ancestor dir
 *     of every file, up to the ROOT_DIR sentinel), deduped via a Set.
 *   - folder→subfolder `contains` edges (each dir → its parent dir).
 *   - folder→file `contains` edges (each file → its IMMEDIATE parent dir only,
 *     so the tree stays strictly hierarchical — not file→every-ancestor).
 * Both edge tiers are extracted/1.0, matching the file→symbol containment edge.
 * embed:false (structural, no vector). Dedup across files + the store's
 * upsert-by-id makes this idempotent (re-emitting the same dir id is a no-op).
 */
export function buildFolderBatch(
    files: readonly ParsedFile[],
    opts: { workspace: string; repo: string },
): { nodes: StoreNodeInput[]; edges: StoreEdgeInput[] } {
    const nodes: StoreNodeInput[] = [];
    const edges: StoreEdgeInput[] = [];
    const dirSet = new Set<string>();
    // folder→file edges (one per file, to its immediate dir).
    const fileEdges: Array<{ dir: string; fileId: string }> = [];

    for (const f of files) {
        const dir = path.posix.dirname(f.path);
        // Normalize: posix.dirname of a root-level file is '.', which we keep as
        // the ROOT_DIR sentinel; a non-root dir is used verbatim.
        const immediate = dir === '.' ? ROOT_DIR : dir;
        fileEdges.push({ dir: immediate, fileId: codeFileId(f, opts.repo) });
        // Accumulate the immediate dir AND every ancestor prefix up to root.
        let cur = immediate;
        while (true) {
            dirSet.add(cur);
            if (cur === ROOT_DIR) break;
            const parent = path.posix.dirname(cur);
            cur = parent === '.' ? ROOT_DIR : parent;
        }
    }

    // One folder node per unique dir.
    for (const dir of dirSet) {
        nodes.push({
            id: codeFolderId(dir, opts.repo),
            type: 'code_folder',
            label: folderLabel(dir),
            content: JSON.stringify({ path: dir }),
            tags: ['atlas', 'code-folder', `repo:${opts.repo}`].join(','),
            workspace: opts.workspace,
            embed: false,
            metadata: JSON.stringify({ path: dir, repo: opts.repo }),
        });
    }

    // folder→subfolder contains edges (each non-root dir → its parent dir).
    for (const dir of dirSet) {
        if (dir === ROOT_DIR) continue;
        const parentRaw = path.posix.dirname(dir);
        const parent = parentRaw === '.' ? ROOT_DIR : parentRaw;
        edges.push({
            sourceId: codeFolderId(parent, opts.repo),
            targetId: codeFolderId(dir, opts.repo),
            relation: 'contains',
            workspace: opts.workspace,
            // GF-1 — structural containment, both endpoints just written → top tier.
            confidence: 'extracted',
            confidenceScore: 1.0,
        });
    }

    // folder→file contains edges (each file → its IMMEDIATE parent dir).
    for (const { dir, fileId } of fileEdges) {
        edges.push({
            sourceId: codeFolderId(dir, opts.repo),
            targetId: fileId,
            relation: 'contains',
            workspace: opts.workspace,
            confidence: 'extracted',
            confidenceScore: 1.0,
        });
    }

    return { nodes, edges };
}

/**
 * GF-3 — build the `code_import` NODES for a set of external module specifiers,
 * deduped. Emitted ONCE per repo in the batch driver (a module imported by 50
 * files must be ONE node — the per-file buildIndexBatch can't dedup it). The
 * file→import EDGES flow through the existing per-file path: the resolver emits
 * a `imports` ParsedRelation with targetId `import:<module>`, which
 * codeSymbolIdFromRaw routes onto these nodes. embed:false (structural).
 */
export function buildImportNodes(
    modules: Iterable<string>,
    opts: { workspace: string },
): StoreNodeInput[] {
    const nodes: StoreNodeInput[] = [];
    const seen = new Set<string>();
    for (const mod of modules) {
        if (!mod || seen.has(mod)) continue;
        seen.add(mod);
        nodes.push({
            id: codeImportId(mod),
            type: 'code_import',
            label: mod,
            content: JSON.stringify({ module: mod }),
            tags: ['atlas', 'code-import'].join(','),
            workspace: opts.workspace,
            embed: false,
            metadata: JSON.stringify({ module: mod, external: true }),
        });
    }
    return nodes;
}

/**
 * Build the (nodes, edges) batch a single file would produce, without
 * issuing any HTTP requests. Used by the Y3 recursive/batch indexer
 * which accumulates many files' worth of items before flushing through
 * the W9 bulk endpoints.
 */
export async function buildIndexBatch(
    file: ParsedFile,
    opts: IndexParsedFileOpts,
    parsedRelations: ParsedRelation[] = [],
): Promise<IndexBatch> {
    const lastModified = await fileLastModified(opts.absolutePath ?? file.path);
    const fileNodeId = codeFileId(file, opts.repo);
    const nodes: StoreNodeInput[] = [];
    const edges: StoreEdgeInput[] = [];
    const symbolIds: string[] = [];

    nodes.push(buildFileRefNode(file, fileNodeId, opts, lastModified));
    for (const sym of file.symbols) {
        const id = codeSymbolId(sym, opts.repo);
        symbolIds.push(id);
        nodes.push(buildCodeSymbolNode(file, sym, id, opts));
        // Structural file→symbol edge: a file CONTAINS its symbols. Both
        // endpoints were just written, so it never dangles. Typed as
        // 'contains' (was 'related_to' pre-Sprint-1).
        edges.push({
            sourceId: fileNodeId,
            targetId: id,
            relation: 'contains',
            workspace: opts.workspace,
            // GF-1 — structural containment: both endpoints were just written, so
            // there is zero ambiguity. Stamp the highest tier.
            confidence: 'extracted',
            confidenceScore: 1.0,
        });
    }
    for (const rel of parsedRelations) {
        edges.push({
            sourceId: codeSymbolIdFromRaw(rel.sourceId, opts.repo),
            targetId: codeSymbolIdFromRaw(rel.targetId, opts.repo),
            relation: mapRelationKind(rel.kind),
            workspace: opts.workspace,
            // GF-1 — code edges are AST-derived; reuse the resolver's already-
            // computed per-relation float verbatim (1.0 for a direct AST resolve,
            // <1 for a heuristic/workspace-wide guess — see ParsedRelation.confidence).
            confidence: 'extracted',
            confidenceScore: rel.confidence,
        });
    }
    // Context layer (GF-2: DEFAULT ON; ATLAS_CONTEXT_LAYER=0 forces off): a small
    // EMBEDDED natural-language "card" per file — path + symbol names — linked to
    // the code_file node. This is the semantic bridge for issue→file retrieval
    // (graph holds structure; this vector holds meaning) and the ONLY embedded
    // code surface, so it IS semantic code search. Small content embeds cleanly
    // (large file bodies don't). `opts.contextMode` (set by the size guard) wins
    // over the module-load snapshot; absent, the snapshot default applies.
    const contextMode = opts.contextMode ?? defaultContextMode();
    if (contextMode !== 'off') {
        let src = '';
        try { src = await fs.readFile(opts.absolutePath ?? file.path, 'utf8'); } catch { /* signatures only */ }
        const srcLines = src.split('\n');
        const identsOf = (text: string) => [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])];
        if (contextMode === 'spans' && file.symbols.length) {
            // One card per symbol: content = its identifiers; metadata carries the
            // line-range so a consumer can feed only those lines.
            for (const sym of file.symbols) {
                // Trim: skip 1-line symbols (getters/setters/type aliases/declaration shorthand).
                // They add 1 card + 1 embed each but rarely carry retrieval signal; their NAME is
                // still indexed via the file-level fallback consumers if needed.
                const lineSpan = (sym.byteRange.endLine || 0) - (sym.byteRange.startLine || 0);
                if (lineSpan < 2) continue;
                const a = Math.max(0, (sym.byteRange.startLine || 1) - 1);
                const b = Math.min(srcLines.length, sym.byteRange.endLine || a + 1);
                // SECURITY — scrub the RAW span before identifiers are pulled from
                // it. Order matters: most secret patterns key on `key = "value"`
                // adjacency, and identsOf() throws the `=` and quotes away, so a
                // scrub applied to the extracted identifiers would match almost
                // nothing while the secret value survived intact. Scrubbing the
                // span (still raw source, adjacency present) is what actually works.
                // srcLines itself is deliberately NOT mutated — the parser's line
                // ranges are computed against the original source, and a multi-line
                // match (e.g. a PRIVATE KEY block) collapsing to one placeholder
                // would shift every subsequent slice.
                const span = scrubSecrets(srcLines.slice(a, b).join('\n')).text;
                const idents = [...new Set([sym.qualifiedName || sym.name, ...identsOf(span)])].filter(Boolean).slice(0, 40);
                const cid = `code-context-sym:${qualify(opts.repo, sym.id)}`;
                nodes.push({
                    id: cid,
                    type: 'code_context',
                    // range encoded in label — recall summary hits drop `metadata`,
                    // but keep `label`, so this is how the span survives retrieval.
                    label: `${file.path}#${sym.byteRange.startLine}-${sym.byteRange.endLine}`,
                    content: `${file.path} ${sym.qualifiedName || sym.name}\n${idents.join(' ')}`.slice(0, 600),
                    tags: ['atlas', 'code-context', 'span', `repo:${opts.repo}`].join(','),
                    workspace: opts.workspace,
                    embed: true,
                    metadata: JSON.stringify({ filePath: file.path, repo: opts.repo, startLine: sym.byteRange.startLine, endLine: sym.byteRange.endLine }),
                });
                // GF-1 — the code_context 'describes' bridge is a heuristic
                // semantic link (NL card → code), not an AST fact → 'inferred'.
                edges.push({ sourceId: cid, targetId: codeSymbolId(sym, opts.repo), relation: CONTEXT_RELATION, workspace: opts.workspace, confidence: 'inferred', confidenceScore: 0.6 });
            }
        } else {
            // One card per file: path + symbol names + the file's distinct identifiers
            // (so INLINE names like `meridiem` are in the semantic surface).
            const ctxId = `code-context:${qualify(opts.repo, file.path)}`;
            // SECURITY — scrub the RAW file body before identifiers are pulled;
            // see the ordering note on the span branch above for why doing this
            // after extraction would not work.
            const idents = [...new Set([...file.symbols.map((s) => s.qualifiedName || s.name).filter(Boolean), ...identsOf(scrubSecrets(src).text)])];
            const summary = `${file.path}\n${idents.slice(0, 160).join(' ')}`;
            nodes.push({
                id: ctxId,
                type: 'code_context',
                label: file.path,
                content: summary.slice(0, 2000),
                tags: ['atlas', 'code-context', `repo:${opts.repo}`].join(','),
                workspace: opts.workspace,
                embed: true,
                metadata: JSON.stringify({ filePath: file.path, repo: opts.repo }),
            });
            // GF-1 — heuristic semantic bridge → 'inferred' (see span-card edge above).
            edges.push({ sourceId: ctxId, targetId: fileNodeId, relation: CONTEXT_RELATION, workspace: opts.workspace, confidence: 'inferred', confidenceScore: 0.6 });
        }
    }
    return { nodes, edges, fileNodeId, codeSymbolIds: symbolIds };
}

function buildFileRefNode(
    file: ParsedFile,
    fileNodeId: string,
    opts: IndexParsedFileOpts,
    lastModified: string,
): StoreNodeInput {
    return {
        id: fileNodeId,
        type: 'code_file',
        label: file.path,
        content: JSON.stringify({ language: file.language, loc: file.loc, sizeBytes: file.sizeBytes }),
        tags: ['atlas', 'code-file', `language:${file.language}`, `repo:${opts.repo}`].join(','),
        workspace: opts.workspace,
        embed: false,
        metadata: JSON.stringify({
            path: file.path,
            language: file.language,
            loc: file.loc,
            sizeBytes: file.sizeBytes,
            repo: opts.repo,
            lastModified,
            parsedAt: file.parsedAt,
        }),
    };
}

function buildCodeSymbolNode(
    file: ParsedFile,
    sym: ParsedSymbol,
    id: string,
    opts: IndexParsedFileOpts,
): StoreNodeInput {
    // SECURITY — a symbol's signature is the raw declaration line, so for a
    // constant it carries the INITIALIZER: `const AWS_KEY = "AKIA…"`. That made
    // code_symbol the highest-fidelity leak of the three code node types (the
    // value survives verbatim, not just as an extracted token). Scrub it here,
    // and use the scrubbed copy for BOTH `content` and `metadata.signature` —
    // they are the same string written twice, and missing either one re-opens it.
    const signature = scrubSecrets(sym.signature ?? '').text;
    return {
        id,
        type: 'code_symbol',
        label: `${sym.kind}:${sym.qualifiedName || sym.name}`,
        content: signature,
        tags: ['atlas', 'code-symbol', `kind:${sym.kind}`, `language:${file.language}`].join(','),
        workspace: opts.workspace,
        embed: false,
        metadata: JSON.stringify({
            uid: sym.id,
            name: sym.name,
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            filePath: file.path,
            startLine: sym.byteRange.startLine,
            endLine: sym.byteRange.endLine,
            signature,
            complexity: sym.complexity,
            parentSymbolId: sym.parentSymbolId,
            repo: opts.repo,
        }),
    };
}

export async function indexParsedFile(
    client: LoreWriter,
    file: ParsedFile,
    opts: IndexParsedFileOpts,
    parsedRelations: ParsedRelation[] = [],
): Promise<IndexParsedFileResult> {
    const lastModified = await fileLastModified(opts.absolutePath ?? file.path);

    const fileNodeId = codeFileId(file, opts.repo);
    await client.storeNode({
        id: fileNodeId,
        type: 'code_file',
        label: file.path,
        content: JSON.stringify({ language: file.language, loc: file.loc, sizeBytes: file.sizeBytes }),
        tags: ['atlas', 'code-file', `language:${file.language}`, `repo:${opts.repo}`].join(','),
        workspace: opts.workspace,
        // Sprint Y W1 — code-type nodes exist purely for graph
        // traversal; embedding them is wasted work (no recall
        // surface ever queries `code-file:foo.ts` by semantic
        // similarity). embed:false skips the lancedb mirror; pre-W
        // daemons drop the flag transparently via the sticky retry
        // in loreClient.
        embed: false,
        metadata: JSON.stringify({
            path: file.path,
            language: file.language,
            loc: file.loc,
            sizeBytes: file.sizeBytes,
            repo: opts.repo,
            lastModified,
            parsedAt: file.parsedAt,
        }),
    });

    const symbolIds: string[] = [];
    let edgeCount = 0;
    let droppedEdges = 0;
    // Edges are best-effort cross-references. An edge whose endpoint symbol
    // wasn't resolved to a node (e.g. an unresolved member access like
    // `foo.receiver`, or a cross-file target not yet indexed) is expected —
    // the embedded graph store rejects such edges strictly, so we skip-and-
    // count instead of letting one dangling edge abort the whole file. This
    // mirrors the bulk path's per-edge catch-and-continue.
    const tryEdge = async (e: StoreEdgeInput): Promise<void> => {
        try {
            await client.storeEdge(e);
            edgeCount += 1;
        } catch {
            droppedEdges += 1;
        }
    };
    for (const sym of file.symbols) {
        const id = codeSymbolId(sym, opts.repo);
        symbolIds.push(id);
        // SECURITY — see buildCodeSymbolNode: the signature carries a constant's
        // initializer verbatim. This is the single-file write path; the batch
        // path uses buildCodeSymbolNode. Both must scrub or the leak survives
        // through whichever one the caller happens to take.
        const signature = scrubSecrets(sym.signature ?? '').text;
        await client.storeNode({
            id,
            type: 'code_symbol',
            label: `${sym.kind}:${sym.qualifiedName || sym.name}`,
            content: signature,
            tags: ['atlas', 'code-symbol', `kind:${sym.kind}`, `language:${file.language}`].join(','),
            workspace: opts.workspace,
            // Sprint Y W1 — same rationale as code-file above.
            embed: false,
            metadata: JSON.stringify({
                uid: sym.id,
                name: sym.name,
                qualifiedName: sym.qualifiedName,
                kind: sym.kind,
                filePath: file.path,
                startLine: sym.byteRange.startLine,
                endLine: sym.byteRange.endLine,
                signature,
                complexity: sym.complexity,
                parentSymbolId: sym.parentSymbolId,
                repo: opts.repo,
            }),
        });

        // Structural edge: CodeFile contains CodeSymbol. Both endpoints were
        // just written, so this never dangles — but route it through tryEdge
        // for uniform accounting. Typed as 'contains' (was 'related_to'
        // pre-Sprint-1).
        await tryEdge({
            sourceId: fileNodeId,
            targetId: id,
            relation: 'contains',
            workspace: opts.workspace,
            // GF-1 — structural containment, zero ambiguity (see buildIndexBatch).
            confidence: 'extracted',
            confidenceScore: 1.0,
        });
    }

    for (const rel of parsedRelations) {
        const src = codeSymbolIdFromRaw(rel.sourceId, opts.repo);
        const tgt = codeSymbolIdFromRaw(rel.targetId, opts.repo);
        await tryEdge({
            sourceId: src,
            targetId: tgt,
            relation: mapRelationKind(rel.kind),
            workspace: opts.workspace,
            // GF-1 — AST-derived; reuse the resolver's per-relation float verbatim.
            confidence: 'extracted',
            confidenceScore: rel.confidence,
        });
    }

    return {
        codeFileId: fileNodeId,
        codeSymbolIds: symbolIds,
        codeRelationCount: edgeCount,
        droppedEdgeCount: droppedEdges,
    };
}

async function fileLastModified(absPath: string): Promise<string> {
    try {
        const st = await fs.stat(absPath);
        return st.mtime.toISOString();
    } catch {
        return new Date().toISOString();
    }
}

/**
 * Map a parser-emitted relation kind to the stored Lore edge relation.
 *
 * Sprint 1 (typed code edges): pass the REAL `RelationKind` through verbatim
 * (calls / imports / extends / implements / contains / queries / writes /
 * references) — replacing X3's collapse, which forced every kind onto the
 * single `related_to` relation. Lore's edge `relation` is a free string
 * (StoreEdgeInput.relation), so no DB migration is needed — only newly
 * indexed edges carry the typed kind.
 *
 * Any unknown/legacy kind (defensive — the resolver only emits valid
 * RelationKind today) falls back to the legacy `related_to` so a stray
 * value can never produce an un-classifiable edge; downstream consumers
 * treat `related_to` as the call-graph-friendly default.
 *
 * MIGRATION: a workspace last indexed before Sprint 1 still has its old
 * `related_to` code edges — those remain until a forced re-index
 * (`atlas index --force <root>`) repopulates the typed kinds. Every
 * consumer accepts BOTH the legacy `related_to` and the real kinds, so a
 * MIXED graph (some files re-indexed, some not) reads correctly.
 */
function mapRelationKind(kind: RelationKind): string {
    return isCodeRelationKind(kind) ? kind : 'related_to';
}

// Re-exported for tests.
export const _CODE_FILE_PREFIX = CODE_FILE_PREFIX;
export const _CODE_SYMBOL_PREFIX = CODE_SYMBOL_PREFIX;
export const _CODE_FOLDER_PREFIX = CODE_FOLDER_PREFIX;
export const _CODE_IMPORT_PREFIX = CODE_IMPORT_PREFIX;
export { path };
