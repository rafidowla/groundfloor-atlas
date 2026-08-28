/**
 * indexCore.ts — the SINGLE directory-indexing core shared by both entry points:
 * the CLI (`atlas index <dir>`, src/cli.ts runRecursiveIndex) and the MCP tool
 * (`atlas_index`, src/mcp/tools/index.ts runIndexTool).
 *
 * WHY THIS EXISTS: the two callers used to each carry their own copy of this
 * node-pass-then-edge-pass orchestration. A fix to one (e.g. the 2026-06-29
 * node-before-edge ordering fix) had to be hand-mirrored to the other, and pass 3
 * of that audit caught the MCP copy still broken after the CLI copy was fixed.
 * Collapsing both onto this one function makes that class of divergence impossible:
 * fix the ordering here once and BOTH paths get it.
 *
 * The callers keep ONLY their genuinely-different edges:
 *   - CLI: resume/checkpoint, walkRepo + --exclude/--max-files, JSON+exit output.
 *   - MCP: live `setProgress` publishing, parseRepo enumeration, object output.
 * Everything between "we have the parsed files" and "the graph is written" lives
 * here. Enumeration/parsing stays caller-side because that is exactly where the
 * two legitimately differ (resume-aware walk vs parseRepo).
 */

import type { ParsedFile } from './parser/types.js';
import { buildSymbolTable } from './resolver/symbolTable.js';
import { buildResolutionContext } from './resolver/importGraph.js';
import { buildAllCodeEdges, groupRelationsBySourceFile, collectExternalModules } from './resolver/index.js';
import {
    buildIndexBatch,
    buildFolderBatch,
    buildImportNodes,
    defaultContextMode,
    resolveContextMode,
} from './store/codeNodes.js';
import type { BatchWriter } from './cli/batchWriter.js';
import type { StoreNodeInput, StoreEdgeInput } from './loreClient.js';

/** One parsed file plus whether it should be (re-)written this run.
 *  `write: false` files are parsed for RESOLUTION ONLY (so cross-file edges from
 *  changed files resolve against the whole repo) but are not re-written or
 *  checkpointed — this is how `--resume` stays correct without re-writing the
 *  whole tree. Non-resume callers set `write: true` on every item. */
export interface IndexItem {
    pf: ParsedFile;
    abs: string;
    write: boolean;
}

export interface IndexCoreResult {
    /** Files actually landed (checkpoint-eligible). From BatchWriter.totals.files. */
    filesIndexed: number;
    /** DISTINCT node count (folder + import + each file's nodes once). The edge
     *  pass re-sends per-file nodes as an idempotent upsert, so totals.nodes
     *  double-counts; this is the honest figure for the caller's summary. */
    nodesWritten: number;
    edgesWritten: number;
    errors: BatchWriter['totals']['errors'];
    /** RC #2 — file-derived code nodes deleted by the post-index reconcile
     *  (deleted/renamed files' stale nodes). 0 when reconcile didn't run
     *  (incremental --resume) or the store had no capability. */
    staleNodesDeleted: number;
}

/** RC #2 — the minimal delete-by-repo capability the reconcile needs. EmbeddedLore
 *  implements it; the HTTP LoreWriter does not (reconcile is a no-op there). */
interface RepoReconciler {
    reconcileRepoFiles(
        workspace: string,
        repo: string,
        liveNodeIds: Set<string>,
    ): Promise<{ deleted: string[]; errors: Array<{ id: string; error: string }> }>;
}

export function canReconcile(w: unknown): w is RepoReconciler {
    return typeof (w as RepoReconciler | undefined)?.reconcileRepoFiles === 'function';
}

/**
 * Resolve cross-file edges over the full parsed set, then write the graph with a
 * strict node-pass-then-edge-pass so every edge's target node exists before the
 * edge is attempted (a single run yields a complete call/import/contains graph).
 *
 * The caller owns the `writer` (so it can wire its own onProgress) and is called
 * back via `onLanded` after each edge-pass write + the final flush so it can
 * checkpoint landed files incrementally.
 */
export async function indexRepoFiles(opts: {
    writer: BatchWriter;
    rootAbs: string;
    workspace: string;
    repo: string;
    items: IndexItem[];
    batchSize?: number;
    onLanded?: (landed: string[]) => void;
    log?: (msg: string) => void;
    /** RC #2 — the write client, used ONLY for the post-index stale-file
     *  reconcile (delete-by-repo). Optional so read-only callers / the HTTP
     *  path can omit it; reconcile silently no-ops when it can't delete. */
    client?: unknown;
    /** RC #2 — run the stale-node reconcile after the write. ONLY safe on a
     *  FULL index (every item write-flagged), where the built batches cover the
     *  WHOLE repo — the reconcile deletes any file-scoped node for this repo not
     *  in that set. MUST be false for an incremental --resume (its batches are a
     *  subset, so a reconcile would wrongly delete every unchanged file's
     *  nodes). Default false. */
    reconcile?: boolean;
}): Promise<IndexCoreResult> {
    const { writer, rootAbs, workspace, repo, items, batchSize, onLanded, log } = opts;

    // Resolution runs over the FULL parsed set (changed + unchanged) so cross-file
    // edges from changed files resolve against the whole repo; the WRITE batches
    // below are filtered back down to the write-flagged subset.
    const files = items.map((i) => i.pf);
    const writeItems = items.filter((i) => i.write);

    const table = buildSymbolTable(files);
    const ctx = await buildResolutionContext(rootAbs, files);
    // Full typed edge set (calls + imports + inheritance + contains), grouped by
    // source file so each file's edges flow with its batch in the edge pass.
    const relsByFile = groupRelationsBySourceFile(buildAllCodeEdges(files, table, ctx), table);

    // GF-3 — synthesize the folder tree + external-import NODES once per repo
    // (they dedup across the whole file set, which per-file buildIndexBatch can't).
    // Their `contains` EDGES are deferred to the edge pass (they target per-file
    // `code-file:` nodes built in buildIndexBatch).
    const folderBatch = buildFolderBatch(files, { workspace, repo });
    const importNodes = buildImportNodes(collectExternalModules(files, table, ctx), { workspace });

    // GF-2 size guard — counts are known up front; resolve the effective context
    // mode once so a huge monorepo never silently spends minutes embedding.
    const totalSymbols = files.reduce((n, f) => n + f.symbols.length, 0);
    const guard = resolveContextMode(defaultContextMode(), { files: files.length, symbols: totalSymbols });
    if (guard.note && log) log(guard.note);
    const contextMode = guard.mode;

    // Build every write-flagged file's batch ONCE so we can write all NODES before
    // any EDGE.
    const batches: Array<{ abs: string; nodes: StoreNodeInput[]; edges: StoreEdgeInput[] }> = [];
    for (const { pf, abs } of writeItems) {
        const batch = await buildIndexBatch(
            pf,
            { workspace, repo, absolutePath: abs, contextMode },
            relsByFile.get(pf.path) ?? [],
        );
        batches.push({ abs, nodes: batch.nodes, edges: batch.edges });
    }

    // ── Pass 1 — NODE pass ────────────────────────────────────────────────────
    // Write every file's nodes (no edges) via addAux, flushing every nodeFlushEvery
    // files to bound the pending-node buffer (addAux does NOT auto-flush on
    // batchSize the way add does). addAux is deliberate: node-only writes must NOT
    // be counted as landed files / checkpointed / inflate filesIndexed — the EDGE
    // pass is the authoritative per-file landing. Folder/import NODES go first;
    // their `contains` edges follow in the edge pass once every target file exists.
    const nodeFlushEvery = Math.max(1, batchSize ?? 50);
    let nodeBuffered = 0;
    if (folderBatch.nodes.length > 0 || importNodes.length > 0) {
        writer.addAux('<gf3-folder-import-nodes>', [...folderBatch.nodes, ...importNodes], []);
    }
    for (const b of batches) {
        writer.addAux(`<nodes:${b.abs}>`, b.nodes, []);
        if (++nodeBuffered >= nodeFlushEvery) {
            await writer.flush();
            nodeBuffered = 0;
        }
    }
    await writer.flush();

    // ── Pass 2 — EDGE pass ────────────────────────────────────────────────────
    // Every node now exists, so write each file's edges. Re-send the file's nodes
    // with embed:false so BatchWriter keeps its per-file edge-failure attribution +
    // self-heal checkpoint guard (it maps edge errors back to a file via that
    // file's nodeIds, and withholds a file from the checkpoint when any of its
    // edges failed). The re-send is an idempotent upsert-by-id; embed:false makes
    // it a cheap graph-only write (no re-embed of already-persisted context cards).
    // The whole-repo folder/import `contains` edges flow here too (aux, so they
    // never land in the file checkpoint): every target file node now exists.
    if (folderBatch.edges.length > 0) {
        writer.addAux('<gf3-folder-import-edges>', [], folderBatch.edges);
    }
    for (const b of batches) {
        const nodesNoEmbed = b.nodes.map((n) => ({ ...n, embed: false }));
        const landed = await writer.add(b.abs, nodesNoEmbed, b.edges);
        if (landed.length > 0) onLanded?.(landed);
    }
    const landed = await writer.flush();
    if (landed.length > 0) onLanded?.(landed);

    const totals = writer.totals;
    const distinctNodesWritten =
        folderBatch.nodes.length + importNodes.length +
        batches.reduce((n, b) => n + b.nodes.length, 0);

    // ── RC #2 — post-index stale-file reconcile ────────────────────────────────
    // On a FULL index, `batches` covers the WHOLE repo, so their node ids are the
    // complete live set of this repo's file-derived code nodes. Any code_file /
    // code_symbol / code_context node still in the store for THIS repo but not in
    // that set belongs to a file that was DELETED or RENAMED since the last index
    // — purge it (and its edges, which the graph delete cascades) so it stops
    // showing up as a phantom caller/callee. Scoped to `repo` so sibling repos in
    // the same workspace are never touched. Guarded to full indexes only: on an
    // incremental --resume the batches are a subset and a reconcile would delete
    // every unchanged file's nodes.
    let staleNodesDeleted = 0;
    if (opts.reconcile && canReconcile(opts.client)) {
        const liveNodeIds = new Set<string>();
        for (const b of batches) for (const n of b.nodes) liveNodeIds.add(n.id);
        try {
            const r = await opts.client.reconcileRepoFiles(workspace, repo, liveNodeIds);
            staleNodesDeleted = r.deleted.length;
            if (r.deleted.length > 0 && log) {
                log(`reconcile: removed ${r.deleted.length} stale node(s) from deleted/renamed files`);
            }
            if (r.errors.length > 0 && log) {
                log(`reconcile: ${r.errors.length} node(s) failed to delete (first: ${r.errors[0]?.error})`);
            }
        } catch (err) {
            if (log) log(`reconcile skipped (error): ${(err as Error).message}`);
        }
    }

    return {
        filesIndexed: totals.files,
        nodesWritten: distinctNodesWritten,
        edgesWritten: totals.edges,
        errors: totals.errors,
        staleNodesDeleted,
    };
}
