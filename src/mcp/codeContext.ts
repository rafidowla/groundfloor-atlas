/**
 * mcp/codeContext.ts — transport-agnostic reconstruction of the code graph
 * ({ SymbolTable, ParsedRelation[] }) from stored Lore nodes + edges.
 *
 * This is the assembly logic the 6 code-intelligence tools depend on, lifted
 * out of the HTTP LoreReader so the in-process EmbeddedLoreReader produces a
 * BYTE-FOR-BYTE identical context. Both transports normalize their raw rows
 * to CodeSymbolNode[] + CodeEdge[] and call assembleCodeContext().
 *
 * The embedded path is cleaner than HTTP: EmbeddedLore.listEdges() returns
 * already-directed (sourceId→targetId) edges, so there's no '←'-prefixed
 * inbound double-counting to filter — we just keep symbol→symbol edges.
 */
import type { ParsedFile, ParsedSymbol, ParsedRelation, SymbolKind } from '../parser/types.js';
import { inferRelationKind } from '../schema.js';
import { buildSymbolTable, type SymbolTable } from '../resolver/symbolTable.js';

const CODE_SYMBOL_PREFIX = 'code-symbol:';
const CODE_FILE_PREFIX = 'code-file:';

/** The minimal symbol-node view both transports normalize to. */
export interface CodeSymbolNode {
    id: string;
    content?: string | null;
    /** Architecture metadata as a JSON string (matches LoreNode.metadata). */
    metadata?: string | null;
}

/** A directed code edge (sourceId → targetId). */
export interface CodeEdge {
    sourceId: string;
    targetId: string;
    relation: string;
}

/**
 * RC-F4 — coarse index state for a workspace, so a tool can distinguish a
 * NEVER-INDEXED (typo'd / unknown) workspace from a genuinely-empty one:
 *   - 'unknown'  — no store for this workspace (never indexed). A read here is
 *                  a false "all clear"; surface it as a not-indexed signal.
 *   - 'empty'    — the store exists but holds zero code_symbol nodes.
 *   - 'indexed'  — the store exists and holds code symbols.
 */
export type WorkspaceIndexState = 'unknown' | 'empty' | 'indexed';

/**
 * RC read-path bound — set on the loadContext result when the node read hit
 * its cap (ATLAS_MAX_CONTEXT_NODES / embeddedReader.ts DEFAULT_MAX_CONTEXT_NODES).
 * `nodes` is the count actually returned (== nodeLimit when truncated); absent
 * entirely on an under-cap read so callers can `if (result.truncated)` rather
 * than compare numbers. Edges are NEVER truncated (see embeddedReader.ts) —
 * this flag only ever describes the NODE read.
 */
export interface ContextTruncation {
    nodes: number;
    nodeLimit: number;
}

/** The read surface the code-intelligence tools consume. Both LoreReader
 *  (HTTP) and EmbeddedLoreReader (in-process) satisfy it. */
export interface LoreContextReader {
    loadContext(workspace: string): Promise<{
        table: SymbolTable;
        relations: ParsedRelation[];
        truncated?: ContextTruncation;
    }>;
    /**
     * RC-F4 (optional) — report whether the workspace has ever been indexed.
     * Optional so a minimal/test reader need not implement it; a tool treats a
     * missing implementation as "can't tell" and does not fabricate a warning.
     */
    workspaceState?(workspace: string): Promise<WorkspaceIndexState>;
}

/**
 * RC-F4 — if the reader can tell us the workspace was never indexed, return a
 * distinguishable "not indexed" error object; otherwise return null so the
 * caller proceeds with a normal (possibly empty-but-valid) result. A reader
 * without workspaceState (test/minimal) yields null — no fabricated warning.
 */
export async function notIndexedError(
    reader: LoreContextReader,
    workspace: string,
): Promise<{ error: string; workspace: string; state: 'unknown' } | null> {
    if (typeof reader.workspaceState !== 'function') return null;
    const state = await reader.workspaceState(workspace);
    if (state !== 'unknown') return null;
    return {
        error: `workspace not indexed: '${workspace}' has no code graph — check the workspace name and run \`atlas index <path>\`. (An unknown workspace returns empty, NOT an all-clear.)`,
        workspace,
        state: 'unknown',
    };
}

function safeJson<T>(raw: string | null | undefined): T | undefined {
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

/**
 * Map a stored Lore edge relation to a ParsedRelation kind.
 *
 * Sprint 1 (typed code edges): this now delegates to the CANONICAL
 * `inferRelationKind` in schema.ts — the single copy shared with
 * loreReader.ts (they used to be byte-identical and could drift). A typed
 * graph returns the real kind verbatim; a legacy `related_to` symbol→symbol
 * edge still falls back to `calls` so analytics (call_graph / dead_code /
 * blast_radius) don't shift on pre-Sprint-1 graphs. Re-exported as
 * `inferKind` to keep any existing import path working.
 */
export const inferKind = inferRelationKind;

/** Normalize a stored parentSymbolId (the parser's RAW id) into the same
 * identity space as the reconstructed symbol id. Stored node ids are
 * repo-qualified (`<repo>/<uid>`), but meta.parentSymbolId holds the raw
 * parser id — prefix it with the child's repo segment so consumers (e.g.
 * deadCode's parent lookup via table.byId) actually resolve it. Legacy
 * unqualified ids pass through unchanged. */
export function qualifyParentSymbolId(id: string, parentSymbolId: string | null): string | null {
    if (!parentSymbolId) return null;
    const slash = id.indexOf('/');
    if (slash <= 0) return parentSymbolId;
    const repoPrefix = id.slice(0, slash + 1);
    return parentSymbolId.startsWith(repoPrefix) ? parentSymbolId : `${repoPrefix}${parentSymbolId}`;
}

/** Reconstruct a ParsedSymbol from a stored code_symbol node's metadata.
 *
 * The symbol's graph identity is the (prefix-stripped) NODE id, NOT
 * metadata.uid: edges reference node ids, and F1 qualified node ids with the
 * repo (`code-symbol:<repo>/<uid>`) while leaving metadata.uid the raw `<uid>`.
 * Keying on the node id keeps symbols and edges on the same identifier so the
 * call graph actually resolves (the meta.uid path silently mismatched post-F1).
 */
export function symbolFromNode(node: CodeSymbolNode): ParsedSymbol {
    const meta = safeJson<Record<string, unknown>>(node.metadata) ?? {};
    const id = node.id.replace(/^code-symbol:/, '');
    return {
        id,
        name: (meta['name'] as string) ?? '',
        qualifiedName: (meta['qualifiedName'] as string) ?? (meta['name'] as string) ?? '',
        kind: ((meta['kind'] as SymbolKind) ?? 'function'),
        file: (meta['filePath'] as string) ?? '',
        byteRange: {
            start: 0,
            end: 0,
            startLine: (meta['startLine'] as number) ?? 1,
            endLine: (meta['endLine'] as number) ?? 1,
        },
        signature: (meta['signature'] as string) ?? node.content ?? '',
        complexity: (meta['complexity'] as number) ?? 1,
        parentSymbolId: qualifyParentSymbolId(id, (meta['parentSymbolId'] as string | null) ?? null),
        parsedAt: '',
    };
}

/** Reconstruct a ParsedSymbol for the WRITE path — resolution candidates when
 *  a single-file incremental re-index enriches its symbol table from the
 *  persisted graph. Identity here is the RAW parser uid (metadata.uid,
 *  `<repoRelativePath>:<qualifiedName>:<kind>`), NOT the repo-qualified node
 *  id `symbolFromNode` returns: edge targetIds coming out of the resolver are
 *  re-qualified by store/codeNodes.ts `codeSymbolIdFromRaw` at write time, so
 *  raw uids make the freshly-resolved cross-file edges land on the EXISTING
 *  persisted node ids (idempotent upsert) instead of minting duplicate
 *  `<repo>/<repo>/…` nodes. parentSymbolId is likewise kept RAW (same-file
 *  chain, exactly as the parser emits it). Returns null for nodes missing the
 *  uid/filePath metadata (malformed or foreign writes). */
export function rawSymbolFromNode(node: CodeSymbolNode): ParsedSymbol | null {
    const meta = safeJson<Record<string, unknown>>(node.metadata) ?? {};
    const uid = typeof meta['uid'] === 'string' ? meta['uid'] : '';
    const filePath = typeof meta['filePath'] === 'string' ? meta['filePath'] : '';
    if (!uid || !filePath) return null;
    return {
        id: uid,
        name: (meta['name'] as string) ?? '',
        qualifiedName: (meta['qualifiedName'] as string) ?? (meta['name'] as string) ?? '',
        kind: ((meta['kind'] as SymbolKind) ?? 'function'),
        file: filePath,
        byteRange: {
            start: 0,
            end: 0,
            startLine: (meta['startLine'] as number) ?? 1,
            endLine: (meta['endLine'] as number) ?? 1,
        },
        signature: (meta['signature'] as string) ?? node.content ?? '',
        complexity: (meta['complexity'] as number) ?? 1,
        parentSymbolId: (meta['parentSymbolId'] as string | null) ?? null,
        parsedAt: '',
    };
}

/** Group symbols into minimal ParsedFile shells (empty imports/calls) for
 *  buildSymbolTable. Shells contribute SYMBOLS to the table only — edges are
 *  always derived from freshly-parsed files, never from shells. The language
 *  field is inert for table building (no consumer reads it); 'typescript'
 *  matches the historical default. */
export function fileShellsFromSymbols(symbols: readonly ParsedSymbol[]): ParsedFile[] {
    const filesByPath = new Map<string, ParsedSymbol[]>();
    for (const sym of symbols) {
        const list = filesByPath.get(sym.file);
        if (list) list.push(sym);
        else filesByPath.set(sym.file, [sym]);
    }
    return Array.from(filesByPath.entries()).map(([p, syms]) => ({
        path: p,
        language: 'typescript' as const,
        symbols: syms,
        imports: [],
        calls: [],
        sizeBytes: 0,
        loc: 0,
        parsedAt: '',
    }));
}

/**
 * Assemble the SymbolTable + ParsedRelation[] from stored code_symbol nodes
 * and directed code edges. Edges are filtered to symbol→symbol (structural
 * file→symbol edges dropped), deduped on source→target, and kind-inferred —
 * exactly mirroring the HTTP LoreReader's reconstruction.
 */
export function assembleCodeContext(
    symbolNodes: CodeSymbolNode[],
    edges: CodeEdge[],
): { table: SymbolTable; relations: ParsedRelation[] } {
    const symbols = symbolNodes.map(symbolFromNode);
    const table = buildSymbolTable(fileShellsFromSymbols(symbols));

    const relations: ParsedRelation[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
        // The target must always be a real symbol — analytics key inbound
        // reference counts (deadCode) and adjacency (blast/layer) on it.
        if (!e.targetId.startsWith(CODE_SYMBOL_PREFIX)) continue;
        const symbolSource = e.sourceId.startsWith(CODE_SYMBOL_PREFIX);
        // RC-F1 — a file→symbol `imports` edge (a named / re-export / type-only
        // import: `import { X } from './x'`) is stored with sourceId=code-file:…
        // because the resolver emits the IMPORTING FILE as the edge source
        // (importGraph.ts). The old symbol→symbol-only filter dropped every such
        // edge, so a symbol that is ONLY imported (barrel re-export, type-only,
        // side-effect) received ZERO inbound-edge credit and became a FALSE
        // dead-code positive. Rescue file→symbol edges of kind `imports` so
        // deadCode counts the inbound reference; keep dropping ALL OTHER
        // file→symbol structural edges (notably `contains`), which are not
        // "uses". A consumer that must exclude imports filters LOCALLY on kind.
        const fileImportSource =
            e.sourceId.startsWith(CODE_FILE_PREFIX) && inferKind(e.relation) === 'imports';
        if (!symbolSource && !fileImportSource) continue;
        const targetUid = e.targetId.replace(/^code-symbol:/, '');
        // Preserve the file identity as a `file:`-prefixed source uid so
        // layerViolations' existing `startsWith('file:')` path resolves the
        // file's own path (its symbol lookup would otherwise miss). blast/
        // call graph resolve endpoints through table.byId, which never holds a
        // file id, so a file source simply doesn't surface as a symbol tier —
        // exactly right (files aren't symbols).
        //
        // The stored file id is repo-qualified (`code-file:<repo>/<path>`, F1)
        // while a symbol exposes its REPO-RELATIVE `.file` (`<path>`), which is
        // what layerViolations matches its globs against. Strip the SAME repo
        // prefix the target symbol carries so the file source path is
        // repo-relative too — otherwise a real cross-layer import edge would
        // silently miss every default `ui/**`/`core/**` glob (anchored `^…$`).
        const targetRepo = targetUid.includes('/') ? targetUid.slice(0, targetUid.indexOf('/')) : '';
        let fileSource = e.sourceId.replace(/^code-file:/, '');
        if (targetRepo && fileSource.startsWith(targetRepo + '/')) {
            fileSource = fileSource.slice(targetRepo.length + 1);
        }
        const sourceUid = symbolSource
            ? e.sourceId.replace(/^code-symbol:/, '')
            : 'file:' + fileSource;
        const kind = inferKind(e.relation);
        // Include kind in the dedup key so co-existing typed edges between the
        // same ordered pair (e.g. contains + calls) both survive; collapsing on
        // (source,target) alone silently drops a real call/import relationship.
        const key = `${sourceUid}→${targetUid}→${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
            sourceId: sourceUid,
            targetId: targetUid,
            kind,
            confidence: 1.0,
            reason: `recovered from Lore edge relation="${e.relation}"`,
        });
    }

    return { table, relations };
}
