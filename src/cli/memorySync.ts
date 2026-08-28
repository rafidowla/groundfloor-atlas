/**
 * cli/memorySync.ts — Wave 3 git-syncable team memory.
 *
 * Exports the knowledge-typed slice of an embedded Lore instance to a
 * line-delimited JSON file (`.atlas/memory.jsonl` by convention) that's
 * mergeable, diff-friendly, and (since A0 / schema v2) carries the
 * precomputed embedding vector per node so a teammate's first clone
 * imports vectors directly instead of re-embedding everything locally.
 *
 * Design summary (spec):
 *   Line 1 (header):
 *     v1: {"version":1,"exportedAt":<ISO>,"sourceWorkspace":<name>,"exportedTypes":[...]}
 *     v2: same fields + an implicit promise that every {"kind":"node",...}
 *         line MAY carry an "embedding": number[] field.
 *   Subsequent lines: {"kind":"node",...} or {"kind":"edge",...}
 *
 * KNOWLEDGE node types synced: decision, convention, bug_pattern,
 * troubleshooting, architecture. SKIP code_file / code_symbol /
 * code_context (regenerable from source — the whole point of the split,
 * and decided in this session: memory.jsonl is the IRREPLACEABLE moat
 * that travels in git; code vectors stay a gitignored local cache).
 *
 * Edge policy (G-2): an edge is exported when its SOURCE is a local
 * knowledge node — even if the TARGET is a foreign-qualified id pointing
 * at another repo's memory (a cross-seam reference). The owner repo (the
 * one holding the source decision) authors and carries the reference in
 * ITS .atlas/memory.jsonl; the foreign target resolves at group-load time
 * when the sibling member is co-loaded. Edges whose SOURCE is not local
 * are dropped (they belong to the other repo). Code↔knowledge edges are
 * still excluded because code-typed nodes never enter knowledgeIds.
 *
 * Import ordering (G-2): nodes are ingested BEFORE any edge is applied.
 * importMemory buffers edge lines the same way it buffers node lines, so
 * that when an in-repo edge is applied both endpoints already exist. Edges
 * whose endpoints are still missing afterward go into `deferredEdges`
 * (rather than vanishing) — for a group co-load they're applied once a
 * sibling member supplies the foreign endpoint.
 *
 * Cross-seam id convention: a knowledge id referenced ACROSS repos SHOULD
 * be member-namespaced (e.g. "atlas/dec-001", "lore/dec-Y") so it round-
 * trips verbatim and resolves to exactly one node at group-load. Bare
 * author-chosen ids (e.g. "dec-A") are fine WITHIN a single repo but risk
 * a silent upsert clobber if two co-loaded members hand-author the same
 * id — loadGroup emits a non-fatal collision WARNING for that case (it
 * does not block). Full git-aware repo-id qualification is a separate
 * hardening (migration implications) and is intentionally NOT done here.
 *
 * Import policy: when the header is v2 AND every node carries an
 * embedding field, the importer routes the whole batch through
 * EmbeddedLore.bulkStoreNodesWithVectors → lore.bulkIngest(embed:
 * 'precomputed'). Dim mismatches surface PER NODE with
 * `embedding dimension mismatch: got N, model expects M` — those ids
 * fall back to the existing serial re-embed path (StoreNode +
 * embed:true) so cross-model bundles don't silently drop nodes.
 *
 * For v1 files (no embeddings) and v2 files with missing embeddings,
 * the importer falls through to the legacy serial storeNode path —
 * each storeNode/storeEdge call is withRetry-wrapped inside
 * EmbeddedLore. (Wave 1 proved nodeUpsertBatch regresses ~2× on the
 * serial path; see embeddedLore.ts bulkStoreNodes comment +
 * docs/PERFORMANCE.md "Why batch lost".)
 *
 * `workspace` on import is the IMPORTER's target workspace, not the
 * source's (so a teammate's memory lands in *their* configured project).
 * `supersededAt` (+ `supersededBy`/`supersededReason`) is preserved through
 * the round trip so soft-superseded decisions don't re-surface — restored via
 * the real supersedeNode mutation in a post-ingest pass (applySupersedes),
 * NOT as a plain storeNode field: Lore's storage layer treats supersededAt as
 * protected/derived and silently ignores it if passed as generic node data.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { StoreNodeInput, StoreEdgeInput } from '../loreClient.js';
import type { EmbeddedLore } from '../lore/embeddedLore.js';
import { CODE_TYPE_SET, GRAPH_ONLY_CODE_TYPES } from './codeGraphSync.js';
import { codeFolderId, _CODE_IMPORT_PREFIX } from '../store/codeNodes.js';
import { tagsToString } from '../tags.js';
// W1 (merge-safety) — the SAME pure-JSONL union used by the git merge driver
// (scripts/memory-merge-driver.mjs). Single implementation, two callers: the
// driver resolves conflicts at merge time; the pre-commit export unions so it
// can never clobber file-only (remote/PM) entries the local DB hasn't imported
// yet. Zero native deps by design so it runs even when kuzu/Lance are ABI-broken.
// @ts-expect-error — pure .mjs helper, no type declarations (matches tests/memory-merge-driver.test.ts)
import { unionMemoryJsonl } from '../../scripts/memory-merge-driver.mjs';
// W2 (Groundfloor Atlas) — the dependency-free JSONL core. The knowledge-type universe,
// the NodeLine/EdgeLine shapes, and the streaming parse moved to
// src/memoryFile.ts so the stateless no-DB surface (readMemoryFile /
// appendMemoryEntries / `atlas memory show|grep|append`) can use them without
// touching this DB-coupled module. Re-exported below so every existing
// consumer (schema.ts, embeddedLore.ts, g3 tests, …) keeps its import path.
import { KNOWLEDGE_TYPES, KNOWLEDGE_TYPE_SET, parseMemoryJsonlFile } from '../memoryFile.js';
import type { KnowledgeType, NodeLine, EdgeLine, MemoryFileView } from '../memoryFile.js';

export { KNOWLEDGE_TYPES, KNOWLEDGE_TYPE_SET };
export type { KnowledgeType, NodeLine, EdgeLine };

export interface ExportResult {
    path: string;
    nodeCount: number;
    edgeCount: number;
    bytes: number;
}

export interface ImportResult {
    nodeCount: number;
    /** Edges that ACTUALLY persisted (verified via read-back — see G-2 below).
     *  Never inflated by silent addEdge no-ops anymore. */
    edgeCount: number;
    skipped: number;
    errors: Array<{ id: string; error: string }>;
    /**
     * G-2 — edges whose endpoints were STILL missing after all in-file nodes
     * were ingested. For a single-repo import these are genuinely dangling
     * (target in no member of this file). For a group co-load they're applied
     * later, once a sibling member supplies the foreign endpoint. Surfaced
     * rather than silently dropped so the caller can report "N edges deferred,
     * target in a not-yet-loaded member" instead of losing them.
     */
    deferredEdges: EdgeLine[];
}

/** Minimal read surface exportMemory depends on. Matches EmbeddedLore. */
export interface MemoryExportReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
    listEdges(pageSize?: number): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
    /**
     * RC reconciliation — edges sourced from a given set of node ids, via an
     * indexed per-source lookup rather than a full-graph scan. Optional so a
     * legacy test double without it still satisfies the interface; exportMemory
     * falls back to the unfiltered listEdges() + JS filter when this method is
     * absent (matches the pre-fix behavior — just slower on a real workspace).
     */
    listEdgesBySource?(sourceIds: Iterable<string>, pageSize?: number): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
    /**
     * A0 (v2) — bulk-fetch precomputed embedding vectors for a batch of
     * node ids. Ids without a stored vector (e.g. embed:false graph-only
     * nodes, or anything the storage layer can't find) are simply absent
     * from the returned map. Optional on the interface so legacy v1
     * exporters / test doubles can omit it; exportMemory falls back to
     * v1 (vectors-less) output when this method is missing.
     */
    getEmbeddings?(nodeIds: string[]): Promise<Map<string, number[]>>;
    /**
     * A0 (v2) — settle all pending embed + verbatim writes so the
     * getEmbeddings read below sees persisted vectors. Single-node stores
     * route through Lore's background outbox, so without this the lance row
     * may not exist yet (empty map → v1 export). Optional: legacy readers /
     * test doubles omit it and exportMemory just skips the settle.
     */
    awaitEmbeds?(): Promise<void>;
}

/** Minimal write surface importMemory depends on. Matches EmbeddedLore. */
export interface MemoryImportWriter {
    storeNode(input: StoreNodeInput): Promise<unknown>;
    storeEdge(input: StoreEdgeInput): Promise<void>;
    /**
     * Soft-supersede oldId with newId. supersededAt/supersededBy are
     * PROTECTED, derived fields in Lore's storage layer — a generic
     * storeNode/nodeUpsert call silently ignores them if passed as plain
     * data (verified directly), so a rebuild restores a superseded node's
     * status through this SAME mutation knowledge_supersede uses, not by
     * trying to set the field on storeNode's input. Optional so legacy test
     * doubles / an HTTP-mode importer without it degrade gracefully — a
     * rebuilt DB just won't have the supersede status restored, same
     * shape as every other optional capability on this interface.
     */
    supersedeNode?(oldId: string, newId: string, reason?: string): Promise<unknown>;
    /**
     * A0 (v2) — vectors-included batch ingest. When the imported file is
     * v2 AND every node carries an `embedding`, importMemory routes the
     * whole batch here so Lore writes the supplied vectors directly via
     * `bulkIngest(embed:'precomputed')`. Optional so legacy test doubles
     * and the HTTP-mode LoreClient (which doesn't expose precomputed yet)
     * can omit it; importMemory falls back to the serial storeNode path
     * for any importer without this method.
     */
    bulkStoreNodesWithVectors?(
        nodes: StoreNodeInput[],
        vectors: number[][],
    ): Promise<{
        ok: boolean;
        count: number;
        succeeded: number;
        results: Array<{ ok: boolean; id?: string; error?: string }>;
    }>;
}

// Compile-time check that EmbeddedLore satisfies both surfaces.
// (No-op at runtime; just keeps the contract honest.)
type _AssertEmbeddedSatisfiesReader = EmbeddedLore extends MemoryExportReader ? true : never;
type _AssertEmbeddedSatisfiesWriter = EmbeddedLore extends MemoryImportWriter ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _r: _AssertEmbeddedSatisfiesReader = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _w: _AssertEmbeddedSatisfiesWriter = true;

/** Header line at the top of every export.
 *
 *  v1 — text only; importers re-embed locally.
 *  v2 — node lines MAY carry `embedding: number[]`. A v1 reader can
 *       process a v2 file by ignoring the unknown field (forward-compat).
 *       A v2 reader processing a v1 file falls back to the re-embed path. */
interface MemoryHeader {
    version: 1 | 2;
    exportedAt: string;
    sourceWorkspace: string;
    exportedTypes: readonly string[];
}

/** Current export schema version. Bump in lockstep with MemoryHeader. */
export const MEMORY_SCHEMA_VERSION = 2 as const;

// NodeLine / EdgeLine live in src/memoryFile.ts since W2 (re-exported above —
// ImportResult.deferredEdges / GroupResult.deferredEdges surface EdgeLine[] in
// their public types, so declaration emit still needs the names reachable here).

/**
 * Collect a workspace's knowledge nodes + edges into an in-memory
 * MemoryFileView (no file write, no vectors). Same node/edge collection that
 * exportMemory does — reused by read-only consumers like the flag_unbacked_work
 * MCP tool so the daemon can compute developer-side flags for a live workspace
 * without exporting to disk. Vectors are intentionally omitted (flags don't use
 * them). Shares the mapping shape with exportMemory; kept separate for now to
 * avoid perturbing the merge-safety-critical export path.
 */
export async function collectKnowledgeView(
    client: MemoryExportReader,
    workspace: string,
): Promise<MemoryFileView> {
    const knowledgeIds = new Set<string>();
    const nodes: NodeLine[] = [];
    for (const type of KNOWLEDGE_TYPES) {
        const rows = await client.listNodes(type, undefined, workspace);
        for (const raw of rows) {
            const n = raw as Record<string, unknown>;
            const id = typeof n['id'] === 'string' ? n['id'] : undefined;
            if (!id) continue;
            knowledgeIds.add(id);
            const line: NodeLine = { kind: 'node', id, type };
            if (typeof n['label'] === 'string') line.label = n['label'];
            if (typeof n['content'] === 'string') line.content = n['content'];
            const tagStr = tagsToString(n['tags'] as string | string[] | undefined);
            if (tagStr) line.tags = tagStr;
            if (n['metadata'] !== undefined) line.metadata = n['metadata'];
            if ('supersededAt' in n) line.supersededAt = (n['supersededAt'] as string | null | undefined) ?? null;
            nodes.push(line);
        }
    }
    const rawEdges = client.listEdgesBySource
        ? await client.listEdgesBySource(knowledgeIds)
        : (await client.listEdges()).filter((e) => knowledgeIds.has(e.sourceId));
    const edges: EdgeLine[] = [];
    for (const e of rawEdges) {
        if (!knowledgeIds.has(e.sourceId)) continue;
        edges.push({ kind: 'edge', sourceId: e.sourceId, targetId: e.targetId, relation: e.relation });
    }
    return { headerVersion: 2, nodes, edges, errors: [] };
}

/**
 * Walk the embedded Lore's knowledge nodes + edges and write a JSONL
 * file at `outPath`. Atomic via temp+rename so a crash mid-write
 * cannot leave a half-file behind for git to commit.
 */
export async function exportMemory(
    client: MemoryExportReader,
    sourceWorkspace: string,
    outPath: string,
): Promise<ExportResult> {
    const absOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });

    // Collect knowledge nodes per type. listNodes(type, undefined, workspace)
    // scopes on the project field (which EmbeddedLore stamps with the Atlas
    // workspace on write — see embeddedLore.ts storeNode).
    const knowledgeIds = new Set<string>();
    const nodeLines: NodeLine[] = [];
    for (const type of KNOWLEDGE_TYPES) {
        const rows = await client.listNodes(type, undefined, sourceWorkspace);
        for (const raw of rows) {
            const n = raw as Record<string, unknown>;
            const id = typeof n['id'] === 'string' ? n['id'] : undefined;
            if (!id) continue;
            knowledgeIds.add(id);
            const line: NodeLine = {
                kind: 'node',
                id,
                type,
            };
            if (typeof n['label'] === 'string') line.label = n['label'];
            if (typeof n['content'] === 'string') line.content = n['content'];
            // Lore Tags Pass 3 hands tags back as string[]; normalize to the
            // comma-string export format (the old `typeof === 'string'` guard
            // silently dropped array tags).
            const tagStr = tagsToString(n['tags'] as string | string[] | undefined);
            if (tagStr) line.tags = tagStr;
            if (n['metadata'] !== undefined) line.metadata = n['metadata'];
            // Preserve supersededAt round-trip (null is meaningful — "not superseded").
            if ('supersededAt' in n) {
                line.supersededAt = (n['supersededAt'] as string | null | undefined) ?? null;
            }
            // supersededBy/supersededReason travel WITH supersededAt — importMemory
            // needs the replacement id to restore this via the real supersedeNode
            // mutation (see MemoryImportWriter / applySupersedes below).
            if ('supersededBy' in n) {
                line.supersededBy = (n['supersededBy'] as string | null | undefined) ?? null;
            }
            if ('supersededReason' in n) {
                line.supersededReason = (n['supersededReason'] as string | null | undefined) ?? null;
            }
            nodeLines.push(line);
        }
    }

    // Edge policy (G-2): keep an edge when its SOURCE is a local knowledge
    // node. The TARGET no longer has to be local — that's the whole point of
    // the cross-seam case: a local decision references a foreign-qualified id
    // in a SIBLING repo's memory (e.g. atlas/dec-001 → lore/dec-Y). The owner
    // repo (which holds the source) carries that reference into its own
    // memory.jsonl; the foreign target resolves when the sibling is co-loaded
    // (`atlas group load`). A local→local edge is the degenerate case and is
    // still kept (source is local). Dropping the target-membership requirement
    // is what previously caused cross-seam edges to silently disappear before
    // git.
    //
    // We KEEP requiring the source to be a local knowledge id, which preserves
    // two invariants the old filter gave us for free: (1) code→* edges are
    // excluded (code-typed nodes never enter knowledgeIds), and (2) we never
    // export an edge that "belongs" to another repo (its source lives there).
    //
    // RC reconciliation — query ONLY edges sourced from knowledgeIds (a small,
    // per-export set) instead of pulling the full CODE-edge set and filtering
    // in JS. The old `client.listEdges()` here materialized the ENTIRE
    // workspace edge graph (potentially the whole call/import graph of a
    // real-sized repo) on every knowledge_store, since knowledge_store's
    // mirrorKnowledgeBackup (mcp/allTools.ts) calls exportMemory on every
    // knowledge write. listEdgesBySource is optional on the interface so a
    // minimal test double still works (falls back to the old full-pull +
    // filter, functionally identical, just without the scale win).
    const rawEdges = client.listEdgesBySource
        ? await client.listEdgesBySource(knowledgeIds)
        : (await client.listEdges()).filter((e) => knowledgeIds.has(e.sourceId));
    const edgeLines: EdgeLine[] = [];
    for (const e of rawEdges) {
        // listEdgesBySource already filters by source server-side, but the
        // check stays here too — cheap, and it keeps this loop correct
        // regardless of which branch above supplied `rawEdges`.
        if (!knowledgeIds.has(e.sourceId)) continue;
        edgeLines.push({
            kind: 'edge',
            sourceId: e.sourceId,
            targetId: e.targetId,
            relation: e.relation,
        });
    }

    // A0 — bundle vectors when the reader supports it. Bulk-resolve in
    // one call (EmbeddedLore chunks internally) so a large memory export
    // doesn't N-times round-trip LanceDB. Per-node missing vectors fall
    // through silently — the v2 importer detects partial coverage and
    // routes the missing-vector subset through the re-embed path.
    //
    // SETTLE FIRST (Bug B): single-node storeNode embeds land asynchronously
    // via Lore's background outbox, so a read issued too soon sees an empty
    // lance table → an empty map → a needless v1 (re-embed) export. Drain
    // pending embeds + the outbox before reading so real vectors are present
    // and the v2 fast path actually fires. Best-effort: a settle failure must
    // not abort the export (it just degrades to whatever is currently stored).
    if (client.awaitEmbeds) {
        try { await client.awaitEmbeds(); } catch { /* degrade to current state */ }
    }
    const vectorMap: Map<string, number[]> = client.getEmbeddings
        ? await client.getEmbeddings(Array.from(knowledgeIds))
        : new Map<string, number[]>();
    const haveAnyVectors = vectorMap.size > 0;
    const schemaVersion: MemoryHeader['version'] = haveAnyVectors ? MEMORY_SCHEMA_VERSION : 1;
    if (haveAnyVectors) {
        for (const line of nodeLines) {
            const vec = vectorMap.get(line.id);
            if (vec && vec.length > 0) line.embedding = vec;
        }
    }

    const header: MemoryHeader = {
        version: schemaVersion,
        exportedAt: new Date().toISOString(),
        sourceWorkspace,
        exportedTypes: KNOWLEDGE_TYPES,
    };

    // Build the buffer line-at-a-time. JSONL is small (knowledge nodes
    // are tens-to-low-thousands, not millions) so a single in-memory
    // build + atomic write is appropriate; we don't need a write stream.
    const lines: string[] = [];
    lines.push(JSON.stringify(header));
    for (const n of nodeLines) lines.push(JSON.stringify(n));
    for (const e of edgeLines) lines.push(JSON.stringify(e));
    const body = lines.join('\n') + '\n';
    const bytes = Buffer.byteLength(body, 'utf8');

    // RD-F29tmp — unique temp name (pid + random), same pattern as
    // checkpoint.ts/groupYaml.ts. The prior fixed `<out>.tmp` path let a
    // pre-planted symlink at that exact path redirect the write (a symlink
    // race), and let two concurrent `atlas memory export` runs against the
    // same outPath collide on the same temp file (one run's partial content
    // could get renamed into place by the other). A unique per-process,
    // per-call suffix defeats both: an attacker can't pre-plant a symlink at
    // a path they can't predict, and two concurrent writers never share a
    // temp file. `wx` (O_CREAT|O_EXCL) is a further belt-and-suspenders —
    // it refuses to write through a pre-existing path (symlink or otherwise)
    // at that exact unique name, though the random suffix already makes a
    // collision astronomically unlikely.
    const tmp = `${absOut}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, absOut);

    return {
        path: absOut,
        nodeCount: nodeLines.length,
        edgeCount: edgeLines.length,
        bytes,
    };
}

/**
 * W1 (merge-safety, belt-and-suspenders) — fold prior-file-only entries back
 * into a just-written export.
 *
 * After a fresh `exportMemory` (direct OR via the daemon) has overwritten
 * `absOutPath` with the local DB's snapshot, any entry that existed in the
 * PRIOR file but not in the DB would be gone — the exact 2026-07-13 loss shape
 * (teammate/PM entries pulled into the file but not yet imported into the local
 * DB, e.g. because the post-merge import was skipped or the native modules were
 * ABI-broken). This unions the prior file back in so the pre-commit export can
 * never clobber remote-only knowledge.
 *
 * Semantics match the merge driver exactly: the FRESH export is `ours` (local
 * DB wins same-id collisions and carries the newest header), the PRIOR file is
 * `theirs` (file-only entries preserved). Pure JSONL — no native deps.
 *
 * Deletion semantics (the trap): this resurrects entries hard-deleted from the
 * DB via knowledge_delete but still present in the prior file. Ruling for this
 * wave — soft-lifecycle via knowledge_supersede is the supported deletion path:
 * `supersededAt` round-trips through export (see line ~262) and, because the
 * fresh export is `ours`, the superseded state wins the union. Hard
 * knowledge_delete under two-writer git sync is LOCAL-ONLY until tombstones
 * exist (see GROUNDFLOOR_ATLAS_IMPLEMENTATION.md Risks §6.1). Do not "fix" the
 * resurrection by making the prior file win — that reintroduces the data-loss
 * class this whole wave closes.
 *
 * Called only by the CLI export used by the pre-commit git hook. The
 * pure-DB-snapshot callers (knowledge_export_all mirror, mirrorKnowledgeBackup)
 * intentionally do NOT union — a backup/mirror must reflect the DB, not the file.
 */
export function unionMemoryFileInPlace(absOutPath: string, priorText: string): ExportResult {
    const absOut = path.resolve(absOutPath);
    const freshText = fs.readFileSync(absOut, 'utf8');
    const merged: string = unionMemoryJsonl(freshText, priorText); // fresh = ours
    const bytes = Buffer.byteLength(merged, 'utf8');

    // Same atomic temp+rename + unique-suffix + O_EXCL (`wx`) discipline as
    // exportMemory, so a crash mid-rewrite leaves either the fresh export or the
    // union, never a partial, and no symlink/concurrent-writer race on the temp.
    const tmp = `${absOut}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, merged, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, absOut);

    // Recount from the merged body — the union may have re-added entries, so the
    // DB-derived counts from the fresh export would under-report the file.
    let nodeCount = 0;
    let edgeCount = 0;
    for (const raw of merged.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let obj: { kind?: string } | undefined;
        try { obj = JSON.parse(line) as { kind?: string }; } catch { continue; }
        if (obj?.kind === 'node') nodeCount++;
        else if (obj?.kind === 'edge') edgeCount++;
    }
    return { path: absOut, nodeCount, edgeCount, bytes };
}

/**
 * Read a `.atlas/memory.jsonl` file line-by-line and upsert every
 * knowledge node + edge into the given target workspace. Serial writes
 * (each storeNode/storeEdge call is withRetry-wrapped inside
 * EmbeddedLore) — DO NOT use nodeUpsertBatch (Wave 1 regression, see
 * file header). Per-node failures are captured in `errors[]` rather
 * than aborting the run; the caller decides how to surface them.
 */
export async function importMemory(
    client: MemoryImportWriter,
    targetWorkspace: string,
    inPath: string,
): Promise<ImportResult> {
    const absIn = path.resolve(inPath);
    if (!fs.existsSync(absIn)) {
        throw new Error(`memory import: file not found: ${absIn}`);
    }

    const result: ImportResult = { nodeCount: 0, edgeCount: 0, skipped: 0, errors: [], deferredEdges: [] };

    // Parse the file into buffered nodes + edges (header validated inside).
    const { headerVersion, pendingNodes, pendingEdges } = await parseMemoryFile(absIn, result);

    // G-2: nodes first…
    await ingestPendingNodes(client, targetWorkspace, pendingNodes, headerVersion ?? 1, result);
    // …THEN restore supersede status (needs the replacement node to already
    // exist — same reasoning as edges, one line down)…
    await applySupersedes(client, pendingNodes, result);
    // …THEN edges, so every in-repo endpoint already exists. Edges whose
    // endpoints are still missing are collected into result.deferredEdges
    // (genuinely dangling for a single-repo import; resolved later by a group
    // co-load) instead of being silently dropped.
    await applyEdges(client, targetWorkspace, pendingEdges, result);

    return result;
}

interface ParsedMemoryFile {
    headerVersion: number | undefined;
    pendingNodes: Array<Record<string, unknown>>;
    pendingEdges: Array<Record<string, unknown>>;
}

/**
 * G-2 — stream a memory.jsonl file and split it into buffered node lines and
 * buffered edge lines (NOTHING is applied to the graph here). Extracted from
 * importMemory so loadGroup can parse every member up front, ingest all nodes,
 * THEN apply all edges — the ordering that lets a cross-seam edge resolve.
 *
 * W2 (Groundfloor Atlas) — the streaming loop itself moved to src/memoryFile.ts
 * (`parseMemoryJsonlFile`), the ONE parse core shared with the stateless
 * no-DB surface. Behavior is byte-identical — same header validation (first
 * successfully-parsed line must be v1/v2, same error strings), same junk
 * tolerance — this wrapper only adapts the core's positional errors and skip
 * count onto the `result` bookkeeping importMemory/loadGroup accumulate.
 */
async function parseMemoryFile(absIn: string, result: ImportResult): Promise<ParsedMemoryFile> {
    const raw = await parseMemoryJsonlFile(absIn);
    for (const e of raw.parseErrors) {
        result.errors.push({ id: `line:${e.line}`, error: e.error });
    }
    result.skipped += raw.skipped;
    return {
        headerVersion: raw.headerVersion,
        pendingNodes: raw.nodes.map((n) => n.obj),
        pendingEdges: raw.edges.map((e) => e.obj),
    };
}

/**
 * G-2 — apply a batch of buffered edge lines AFTER all relevant nodes are in
 * the graph. Each edge is verified to have actually persisted (EmbeddedLore's
 * storeEdge reads the row back and throws on the silent no-op). An edge whose
 * endpoints are still missing lands in result.deferredEdges — NOT in
 * result.errors and NOT counted — so edgeCount only ever reflects edges that
 * truly persisted. This is the single chokepoint both importMemory and
 * loadGroup drain through, so the "edgeCount lies" bug can't reappear in
 * either path.
 */
async function applyEdges(
    client: MemoryImportWriter,
    targetWorkspace: string,
    pendingEdges: Array<Record<string, unknown>>,
    result: ImportResult,
): Promise<void> {
    for (const parsed of pendingEdges) {
        await importEdgeLine(client, targetWorkspace, parsed, result);
    }
}

/**
 * Restore supersede status AFTER all nodes exist (same "nodes first" ordering
 * applyEdges relies on — supersedeNode needs BOTH oldId and its supersededBy
 * replacement already stored). A node line with no supersededAt, or one whose
 * supersededBy is absent (an export from before that field existed, or a node
 * superseded with no replacement recorded some other way), is left alone — its
 * plain storeNode write already happened in ingestPendingNodes; there is
 * nothing more this pass could correctly restore for it.
 *
 * Silently no-ops when the writer doesn't support supersedeNode at all (e.g. an
 * HTTP-mode importer) — same degrade-gracefully shape as every other optional
 * MemoryImportWriter capability; a rebuilt DB just won't have supersede status
 * restored, exactly like today, rather than throwing on every such node.
 */
async function applySupersedes(
    client: MemoryImportWriter,
    pendingNodes: Array<Record<string, unknown>>,
    result: ImportResult,
): Promise<void> {
    if (!client.supersedeNode) return;
    for (const parsed of pendingNodes) {
        const id = typeof parsed['id'] === 'string' ? parsed['id'] : undefined;
        const supersededAt = parsed['supersededAt'];
        const supersededBy = typeof parsed['supersededBy'] === 'string' ? parsed['supersededBy'] : undefined;
        if (!id || !supersededAt || !supersededBy) continue;
        const reason = typeof parsed['supersededReason'] === 'string' ? parsed['supersededReason'] : undefined;
        try {
            await client.supersedeNode(id, supersededBy, reason);
        } catch (err) {
            result.errors.push({ id, error: `supersede restore: ${(err as Error).message}` });
        }
    }
}

/**
 * G-1 — a group member to co-load, with its PROVENANCE label.
 *
 * `file` is the member's memory.jsonl; `project` is the source-repo name that
 * each of this member's nodes is stamped with (project=<project> +
 * metadata.sourceRepo=<project>) so a recall hit shows WHERE it came from. The
 * group's shared dataDir is the EmbeddedLore the caller passes — provenance is
 * per-NODE (the project field), the store stays one co-queryable space.
 */
export interface GroupMemberInput {
    /** Path to this member's memory.jsonl. */
    file: string;
    /** Provenance label stamped on every node (project + metadata.sourceRepo). */
    project: string;
    /**
     * G-3 (OPT-IN) — path to this member's `.atlas/code-graph.jsonl` artifact,
     * when present. existsSync-guarded at load: a member without one is loaded
     * knowledge-only (cross-repo CODE traversal is simply unavailable for it,
     * exactly as today). Absent on the field → no code co-load for this member.
     */
    codeGraphFile?: string;
    /**
     * G-3 — this member's repoSlug (git-aware id from repoId.ts), the prefix its
     * code-node ids are qualified with (`code-file:<slug>/…`). Needed to author
     * the bridge target `code-folder:<slug>/.` (its repo-root folder).
     */
    repoSlug?: string;
    /**
     * G-3 — this member's package.json `name`. The bridge MATCH key: a co-loaded
     * `code-import:<module>` whose module equals (or whose package root equals)
     * this name resolves to THIS member's repo, and a `resolves_to` edge is
     * authored from the import node to this member's root folder.
     */
    packageName?: string;
}

/** Per-member roll-up returned by loadGroup. */
export interface GroupMemberResult {
    /** The member file that was loaded. */
    path: string;
    /** Provenance label stamped on this member's nodes (project=<project>). */
    project: string;
    /** Knowledge nodes ingested from this member. */
    nodeCount: number;
    skipped: number;
    /**
     * G-1 v1/dim load-time guard verdict. 'fast' = the file is v2 AND every
     * node carried a precomputed vector, so it took the bulk-precomputed path
     * (seconds). 'slow' = v1, or v2 with missing vectors, so it re-embedded
     * locally (minutes for a big member). Informational — never blocks.
     */
    speed: 'fast' | 'slow';
    /** Header version (1 or 2) peeked at load time (undefined if unreadable). */
    headerVersion: number | undefined;
    /** Per-member node/parse errors (edge errors are pooled — see GroupResult). */
    errors: Array<{ id: string; error: string }>;
    /**
     * G-3 — code nodes co-loaded from this member's `.atlas/code-graph.jsonl`
     * (0 when the member shipped no artifact / didn't opt in). Knowledge-only
     * members keep this at 0, which is exactly today's behavior.
     */
    codeNodeCount: number;
}

/**
 * G-3 — a cross-repo bridge edge authored at group-load: a co-loaded
 * `code-import:<module>` node resolved to a member's package and was linked
 * to that member's repo-root folder. Surfaced so the caller can report how
 * many cross-repo hops were created.
 */
export interface BridgeEdge {
    /** The shared import node (repo-UNqualified): `code-import:<module>`. */
    importId: string;
    /** The matched module specifier (== or under the member's package name). */
    module: string;
    /** The member the import resolved to (its project/provenance label). */
    member: string;
    /** The bridge target node id: `code-folder:<memberSlug>/.` (root folder). */
    targetId: string;
}

/** Aggregate result of a group co-load. */
export interface GroupResult {
    members: GroupMemberResult[];
    /** Total knowledge nodes ingested across all members. */
    nodeCount: number;
    /** Cross-member + in-member edges that ACTUALLY persisted (read-back
     *  verified) once every member's nodes were present. */
    edgeCount: number;
    /** Edges still dangling after the WHOLE group was loaded — their target
     *  (or source) is in NO member of the group. Truly inert, surfaced not
     *  dropped. */
    deferredEdges: EdgeLine[];
    /** REAL edge failures (malformed line, or a storeEdge error that wasn't
     *  the endpoint-missing no-op). Distinct from deferredEdges. */
    edgeErrors: Array<{ id: string; error: string }>;
    /** Non-fatal id collisions: the same knowledge id appears in >1 member,
     *  so co-import upserts will clobber one with the other. WARN only — the
     *  load still completes. Fix by member-namespacing the id (e.g.
     *  "atlas/dec-001"). */
    collisions: Array<{ id: string; members: string[] }>;
    /**
     * G-3 — total code nodes co-loaded across all members (0 for a knowledge-
     * only group). When 0, no member opted into the code-graph artifact and the
     * group behaves exactly as a pre-G-3 knowledge co-load.
     */
    codeNodeCount: number;
    /**
     * G-3 — the module-level cross-repo bridge edges authored after co-load.
     * Each is a `code-import:<module>` → `code-folder:<memberSlug>/.`
     * `resolves_to` edge (confidence 'inferred', a module-level heuristic, not
     * an AST fact). Empty when no import matched a member package (or no member
     * shipped a code graph).
     */
    bridgeEdges: BridgeEdge[];
}

/**
 * G-2 — co-load a GROUP of memory.jsonl members so cross-seam edges resolve.
 *
 * The headline mechanism: a decision in repo A can reference a decision in
 * repo B (e.g. atlas/dec-001 → lore/dec-Y). Loaded ALONE, repo A's edge
 * dangles (the foreign target isn't in the graph) and is deferred. Loaded
 * TOGETHER as a group, we:
 *
 *   1. Parse every member file (buffer nodes + edges, apply nothing yet).
 *   2. Detect id collisions across members (warn, don't block — see below).
 *   3. Ingest EVERY member's NODES first (all files), so the whole union of
 *      knowledge nodes exists in the graph.
 *   4. THEN apply EVERY member's EDGES (all files). Because all nodes are
 *      present, a cross-seam edge atlasNode→loreNode now MATCHes both
 *      endpoints and persists (verified by storeEdge's read-back).
 *
 * Per-member node/skip/error counts are reported individually; edges are
 * POOLED and applied in one combined pass (an edge from member A may target a
 * node from member B, so edges can't be scoped per-member). Edges still
 * dangling after the whole group loads (target in NO member) land in
 * `deferredEdges` — inert but surfaced.
 *
 * Collision policy: if two members carry the SAME knowledge id, the second
 * ingest upserts (clobbers) the first — a silent data-merge hazard. We do NOT
 * block (the common case is distinct ids / member-namespaced ids), but we
 * record every colliding id in `collisions` so the caller can warn. The cure
 * is the cross-seam id convention: namespace ids that are referenced across
 * repos (e.g. "atlas/dec-001"). Full git-aware repo-id qualification is a
 * separate hardening, intentionally out of scope here.
 *
 * Node ingest reuses ingestPendingNodes, so the precomputed-vectors fast path
 * (bulkStoreNodesWithVectors) still kicks in per member when every node in
 * that member carries an embedding and the file is v2.
 *
 * G-1 — PROVENANCE. Two call forms:
 *
 *   loadGroup(client, "<group>", ["a.jsonl", "b.jsonl"])
 *       Legacy G-2 raw-file form. EVERY member's nodes are stamped
 *       project=<group> (the single workspace). Cross-seam edges resolve, but a
 *       recall hit can't tell you WHICH repo a decision came from.
 *
 *   loadGroup(client, "<group>", [{file:"a.jsonl", project:"atlas"}, …])
 *       G-1 named-group form. The SHARED dataDir stays the group (one
 *       co-queryable store), but each member's nodes are stamped
 *       project=<member.project> + metadata.sourceRepo=<member.project>. Because
 *       recall is store-wide (no project filter — embeddedLore.ts:407-425),
 *       querying the group finds ALL members and each hit's project field is the
 *       source repo = provenance for free.
 *
 * In BOTH forms the G-2 ordering is preserved: ALL members' nodes are ingested
 * BEFORE ANY member's edges, so a cross-seam edge atlasNode→loreNode matches
 * both endpoints and persists.
 *
 * G-1 — v1/dim LOAD-TIME GUARD. Each member's header version is peeked; a
 * member that is v1 OR whose nodes lack embeddings takes the slow re-embed path
 * and is reported speed:'slow' (the caller WARNS), vs speed:'fast' for a
 * v2-with-vectors member. Never blocks — just informs.
 *
 * G-3 — OPT-IN CODE CO-LOAD + CROSS-REPO BRIDGE. When a GroupMemberInput carries
 * a `codeGraphFile` (`.atlas/code-graph.jsonl`), its code nodes + edges are
 * co-loaded into the SAME store AFTER the knowledge co-load (steps 5), with the
 * same per-member provenance. Then a module-level bridge pass (step 6) links
 * each shared `code-import:<module>` node to the member whose package.json name
 * matches, via a `resolves_to` edge to that member's repo-root folder — so a
 * subgraph BFS centered in repo A can cross into repo B. This is STRICTLY
 * ADDITIVE: a member with no code-graph artifact contributes 0 code nodes and
 * the group behaves exactly as a pre-G-3 knowledge-only co-load (codeNodeCount
 * 0, bridgeEdges []). The moat invariant is untouched — the code graph is a
 * separate file ingested with allowedTypes=CODE_TYPE_SET, never the moat.
 */
export async function loadGroup(
    client: MemoryImportWriter,
    targetWorkspace: string,
    members: Array<string | GroupMemberInput>,
): Promise<GroupResult> {
    if (members.length === 0) {
        throw new Error('group load: no member files given');
    }

    // Normalize both call forms to {file, project}. A bare string keeps the
    // legacy behavior (project = the group workspace); an object carries the
    // per-member provenance label.
    const inputs: GroupMemberInput[] = members.map((m) =>
        typeof m === 'string' ? { file: m, project: targetWorkspace } : m,
    );

    // 1. Parse every member up front (buffer nodes + edges). We keep a
    //    per-member ImportResult for node-level counts/errors and pool all
    //    edges into a single combined list for the post-ingest apply pass.
    interface Member {
        absPath: string;
        /** project=<this> is stamped on the member's nodes (G-1 provenance). */
        project: string;
        headerVersion: number | undefined;
        pendingNodes: Array<Record<string, unknown>>;
        pendingEdges: Array<Record<string, unknown>>;
        result: ImportResult;
        /** v1/dim guard verdict — every node carried a usable vector AND v2. */
        fast: boolean;
        /** G-3 — buffered code-graph nodes (empty when no artifact / didn't opt in). */
        codeNodes: Array<Record<string, unknown>>;
        /** G-3 — buffered code-graph edges (applied after code nodes). */
        codeEdges: Array<Record<string, unknown>>;
        /** G-3 — code-graph header version (drives the precomputed fast path for
         *  the code_context vector subset; the graph-only types are embed:false). */
        codeHeaderVersion: number | undefined;
        /** G-3 — bridge inputs threaded from GroupMemberInput (undefined when the
         *  caller didn't supply them, e.g. the raw-paths G-2 form). */
        repoSlug?: string;
        packageName?: string;
        /** G-3 — per-member code ImportResult (node counts/errors, kept distinct
         *  from the knowledge `result`). */
        codeResult: ImportResult;
    }
    const parsed: Member[] = [];
    for (const input of inputs) {
        const absIn = path.resolve(input.file);
        if (!fs.existsSync(absIn)) {
            throw new Error(`group load: member file not found: ${absIn}`);
        }
        const result: ImportResult = { nodeCount: 0, edgeCount: 0, skipped: 0, errors: [], deferredEdges: [] };
        const { headerVersion, pendingNodes, pendingEdges } = await parseMemoryFile(absIn, result);
        // v1/dim load-time guard: the member rides the FAST (bulk-precomputed)
        // path only when it is v2 AND every node line carries a non-empty
        // numeric embedding — the same gate ingestPendingNodes applies. Anything
        // else (v1, or a v2 file with a missing vector) re-embeds locally.
        const fast = (headerVersion ?? 1) >= 2 &&
            pendingNodes.length > 0 &&
            pendingNodes.every((n) => {
                const emb = n['embedding'];
                return Array.isArray(emb) && emb.length > 0 && emb.every((v) => Number.isFinite(v));
            });

        // G-3 — OPT-IN code-graph parse. existsSync-guarded (degrade-don't-fail,
        // same pattern as resolveGroup's memory.jsonl check): a member without a
        // `.atlas/code-graph.jsonl` is loaded knowledge-only and contributes NO
        // code nodes — exactly the pre-G-3 behavior. A code-graph that fails to
        // parse (bad header) THROWS just like a bad moat file would, so a
        // corrupt artifact is loud, not silent.
        const codeResult: ImportResult = { nodeCount: 0, edgeCount: 0, skipped: 0, errors: [], deferredEdges: [] };
        let codeNodes: Array<Record<string, unknown>> = [];
        let codeEdges: Array<Record<string, unknown>> = [];
        let codeHeaderVersion: number | undefined;
        if (input.codeGraphFile) {
            const absCode = path.resolve(input.codeGraphFile);
            if (fs.existsSync(absCode)) {
                const cg = await parseMemoryFile(absCode, codeResult);
                codeHeaderVersion = cg.headerVersion;
                codeNodes = cg.pendingNodes;
                codeEdges = cg.pendingEdges;
            }
        }

        parsed.push({
            absPath: absIn, project: input.project, headerVersion, pendingNodes, pendingEdges, result, fast,
            codeNodes, codeEdges, codeHeaderVersion,
            repoSlug: input.repoSlug, packageName: input.packageName, codeResult,
        });
    }

    // 2. Collision detection — the same knowledge OR code-node id authored in >1
    //    member means co-import will upsert-clobber (audit ATL-037: code nodes
    //    were previously unscanned, so cross-member code clobbers were silent).
    //    Warn (record), don't block.
    const idToMembers = new Map<string, Set<string>>();
    for (const m of parsed) {
        for (const n of [...m.pendingNodes, ...m.codeNodes]) {
            const id = typeof n['id'] === 'string' ? n['id'] : undefined;
            if (!id) continue;
            let set = idToMembers.get(id);
            if (!set) { set = new Set(); idToMembers.set(id, set); }
            set.add(m.absPath);
        }
    }
    const collisions: GroupResult['collisions'] = [];
    for (const [id, memberSet] of idToMembers) {
        if (memberSet.size > 1) collisions.push({ id, members: Array.from(memberSet) });
    }

    // RD-Mmemoryforge — knowledge-node id-ownership guard (parallel to the
    // ATL-037 code-node guard in step 5). Knowledge ids are free-form, so we
    // cannot derive a single owner from a slug prefix the way code ids encode
    // one. Instead we enforce FIRST-DECLARER-WINS for any id claimed by >1
    // member: a later member's hand-edited moat file cannot clobber the
    // canonical knowledge node another member already owns. The first member
    // (in load order) that declares an id keeps it; subsequent members' copies
    // of that exact id are dropped with a warning. Same-member duplicates are
    // untouched (a member may legitimately repeat its own id).
    {
        const knowledgeOwner = new Map<string, string>(); // id → owning member.absPath
        for (const m of parsed) {
            const beforeN = m.pendingNodes.length;
            m.pendingNodes = m.pendingNodes.filter((n) => {
                const id = typeof n['id'] === 'string' ? n['id'] : undefined;
                if (!id) return true; // shape errors handled downstream
                const owner = knowledgeOwner.get(id);
                if (owner === undefined) { knowledgeOwner.set(id, m.absPath); return true; }
                return owner === m.absPath; // foreign clobber → drop
            });
            const dropped = beforeN - m.pendingNodes.length;
            if (dropped > 0) {
                console.error(
                    `[atlas] group member ${m.project} contributed ${dropped} knowledge node(s) whose id is already ` +
                    `owned by an earlier member — dropped (cross-member knowledge clobber/forge guard).`,
                );
            }
        }
    }

    // 3. Ingest EVERY member's NODES first (per-member counts preserved).
    //    G-1: stamp project=<member.project> (NOT the group) so each node
    //    carries its source-repo provenance; a belt-and-suspenders
    //    metadata.sourceRepo is added inside ingestPendingNodes too.
    for (const m of parsed) {
        await ingestPendingNodes(client, m.project, m.pendingNodes, m.headerVersion ?? 1, m.result, m.project);
    }

    // 3b. THEN restore supersede status for every member, same "all nodes exist
    //     first" reasoning as edges below — supersedeNode needs the supersededBy
    //     replacement to already be stored, and it may live in the SAME member
    //     (covered here) or a SIBLING member (only resolvable once every member's
    //     loop above has run, which it now has). A cross-member supersededBy
    //     target that a sibling member doesn't actually contribute is a no-op
    //     failure captured in that member's own result.errors, not a crash.
    for (const m of parsed) {
        await applySupersedes(client, m.pendingNodes, m.result);
    }

    // 4. THEN apply EVERY member's knowledge EDGES — pooled into one combined
    //    ImportResult so a cross-seam edge from member A→member B resolves now
    //    that ALL knowledge nodes exist. edgeCount + deferredEdges aggregate
    //    across the group. Edges carry no embeddings, so the workspace they're
    //    stamped with is immaterial to provenance — we keep the group workspace.
    const edgeResult: ImportResult = { nodeCount: 0, edgeCount: 0, skipped: 0, errors: [], deferredEdges: [] };
    for (const m of parsed) {
        await applyEdges(client, targetWorkspace, m.pendingEdges, edgeResult);
    }

    // 5. G-3 — CO-LOAD CODE GRAPHS (opt-in). Mirror of steps 3+4 for the code
    //    artifacts: ingest EVERY member's code NODES first (allowedTypes =
    //    CODE_TYPE_SET so the moat guard doesn't reject them; project=<member>
    //    so code provenance matches knowledge provenance), THEN apply EVERY
    //    member's code EDGES. A member that didn't opt in has codeNodes=[] and
    //    is a no-op here — so a knowledge-only group skips this entirely and
    //    behaves exactly as a pre-G-3 load. Code node ids are repo-qualified
    //    (`code-file:<slug>/…`) so two members never collide; the EXCEPTION is
    //    `code-import:<module>` (repo-UNqualified by design) which correctly
    //    UPSERTS onto ONE shared node when two members import the same package —
    //    that shared identity is exactly what the bridge in step 6 exploits.
    // Audit ATL-037/076 — group-import trust boundary. The "two members never
    // collide" claim above is an ASSUMPTION, not enforced: a malicious member's
    // hand-edited code-graph.jsonl can carry ids qualified under ANOTHER member's
    // slug and clobber/forge its nodes+edges on upsert. Restrict each member to
    // artifacts under ITS OWN declared repoSlug — the same git-stable slug
    // codeNodes.qualify() baked into the ids at index time, so a member's own
    // artifacts always pass. `code-import:<module>` is shared/unqualified → exempt.
    // A member may point an edge TO any node but may NOT originate one FROM a
    // foreign node. code-context:/code-context-sym: ARE repo-qualified too
    // (`<prefix><repo>/<rest>` — the same shape embeddedLore.reconcileRepoFiles
    // scopes by); leaving them out let a member forge/clobber another member's
    // context cards and describes edges — the exact attack this guard exists
    // to close. (Longer prefix first so startsWith matches exactly.)
    const CODE_QUALIFIED_PREFIXES = ['code-context-sym:', 'code-context:', 'code-file:', 'code-symbol:', 'code-folder:'];
    const ownerSlug = (id: string): string | null => {
        for (const p of CODE_QUALIFIED_PREFIXES) {
            if (id.startsWith(p)) return id.slice(p.length).split('/')[0] ?? '';
        }
        return null; // unqualified (e.g. code-import:) → no single owner
    };
    for (const m of parsed) {
        if (!m.repoSlug) continue; // can't attribute ownership without a declared slug
        const beforeN = m.codeNodes.length, beforeE = m.codeEdges.length;
        m.codeNodes = m.codeNodes.filter((n) => {
            const o = ownerSlug(typeof n['id'] === 'string' ? n['id'] : '');
            return o === null || o === m.repoSlug;
        });
        m.codeEdges = m.codeEdges.filter((e) => {
            const o = ownerSlug(typeof e['sourceId'] === 'string' ? e['sourceId'] : '');
            return o === null || o === m.repoSlug;
        });
        const droppedN = beforeN - m.codeNodes.length, droppedE = beforeE - m.codeEdges.length;
        if (droppedN > 0 || droppedE > 0) {
            console.error(
                `[atlas] group member ${m.project} (slug=${m.repoSlug}) contributed ${droppedN} code node(s) + ` +
                `${droppedE} edge(s) qualified under a FOREIGN repo slug — dropped (cross-member clobber/forge guard).`,
            );
        }
    }

    for (const m of parsed) {
        if (m.codeNodes.length === 0) continue;
        await ingestPendingNodes(client, m.project, m.codeNodes, m.codeHeaderVersion ?? 1, m.codeResult, m.project, CODE_TYPE_SET);
    }
    for (const m of parsed) {
        if (m.codeEdges.length === 0) continue;
        await applyEdges(client, targetWorkspace, m.codeEdges, edgeResult);
    }

    // 6. G-3 — MODULE-LEVEL CROSS-REPO BRIDGE. Runs AFTER all code nodes + edges
    //    are co-resident (both endpoints must exist). For each member that
    //    declared a package name + repoSlug, an import whose module equals (or
    //    whose package root equals, e.g. `@scope/pkg` from `@scope/pkg/sub`)
    //    that name resolves to that member's repo. We author a `resolves_to`
    //    edge from the shared `code-import:<module>` node to that member's
    //    repo-ROOT folder `code-folder:<slug>/.` (always present — the folder
    //    builder emits the ROOT_DIR sentinel). One module-level hop opens the
    //    entire member-B graph to a subgraph BFS centered in member A.
    //
    //    Confidence 'inferred'/0.7 (GF-1 tier): this is a module-level heuristic
    //    (A imports a package NAMED like B), not an AST-resolved symbol fact.
    //    Authored via the same storeEdge read-back path importEdgeLine uses, so a
    //    missing endpoint DEFERS rather than errors.
    const bridgeEdges: BridgeEdge[] = await applyCrossRepoBridge(
        client, targetWorkspace, parsed, edgeResult,
    );

    const memberResults: GroupMemberResult[] = parsed.map((m) => ({
        path: m.absPath,
        project: m.project,
        nodeCount: m.result.nodeCount,
        skipped: m.result.skipped,
        speed: m.fast ? 'fast' : 'slow',
        headerVersion: m.headerVersion,
        errors: [...m.result.errors, ...m.codeResult.errors],
        codeNodeCount: m.codeResult.nodeCount,
    }));
    const nodeCount = memberResults.reduce((sum, m) => sum + m.nodeCount, 0);
    const codeNodeCount = parsed.reduce((sum, m) => sum + m.codeResult.nodeCount, 0);

    return {
        members: memberResults,
        nodeCount,
        edgeCount: edgeResult.edgeCount,
        deferredEdges: edgeResult.deferredEdges,
        edgeErrors: edgeResult.errors,
        collisions,
        codeNodeCount,
        bridgeEdges,
    };
}

/**
 * G-3 — author the module-level cross-repo bridge edges for a co-loaded group.
 *
 * Inputs: the parsed members (each may carry a packageName + repoSlug) and the
 * pooled edgeResult (so a bridge edge counts toward edgeCount / defers exactly
 * like every other group edge). Returns the BridgeEdge[] actually authored.
 *
 * Mechanism:
 *   1. Build a package-root → member index from members that declared BOTH a
 *      packageName and a repoSlug (the bridge target needs the slug to name the
 *      root folder). A member missing either is simply not a bridge target.
 *   2. Scan every co-loaded member's code nodes for `code-import:<module>`
 *      ids. For each, resolve the module's PACKAGE ROOT (`@scope/pkg` from
 *      `@scope/pkg/sub`, or `pkg` from `pkg/sub`) and look it up in the index.
 *      A hit means "this import resolves to that member's repo".
 *   3. Author `code-import:<module>` --resolves_to--> `code-folder:<slug>/.`
 *      (the member's repo-root folder, always present). Self-bridges (a member
 *      importing its OWN package) are skipped — they add no cross-repo value.
 *
 * Idempotent: the same (import, target) edge re-applied is a Lore upsert no-op,
 * so re-loading a group doesn't duplicate bridges. Deduped here too so the
 * returned list has one entry per authored bridge.
 */
async function applyCrossRepoBridge(
    client: MemoryImportWriter,
    targetWorkspace: string,
    parsed: ReadonlyArray<{
        project: string;
        repoSlug?: string;
        packageName?: string;
        codeNodes: Array<Record<string, unknown>>;
    }>,
    edgeResult: ImportResult,
): Promise<BridgeEdge[]> {
    // 1. package-root → member (only members that can be a bridge TARGET).
    interface Target { member: string; repoSlug: string; packageName: string; }
    const byPackage = new Map<string, Target>();
    for (const m of parsed) {
        if (!m.packageName || !m.repoSlug) continue;
        byPackage.set(m.packageName, { member: m.project, repoSlug: m.repoSlug, packageName: m.packageName });
    }
    if (byPackage.size === 0) return [];

    // 2+3. Scan co-loaded imports, match to a member package, author the edge.
    // Use the exported prefix constant directly — NOT codeImportId(''), which now
    // slugs its argument and would yield 'code-import:_' (breaking startsWith).
    const CODE_IMPORT_PREFIX = _CODE_IMPORT_PREFIX;
    const authored = new Set<string>(); // `${importId}→${targetId}` dedup
    const bridges: BridgeEdge[] = [];
    for (const m of parsed) {
        for (const n of m.codeNodes) {
            const id = typeof n['id'] === 'string' ? n['id'] : undefined;
            if (!id || !id.startsWith(CODE_IMPORT_PREFIX)) continue;
            const module = id.slice(CODE_IMPORT_PREFIX.length);
            const root = packageRoot(module);
            const target = byPackage.get(root);
            if (!target) continue;
            // Skip a self-bridge: an import resolving to the SAME member that
            // declared it adds no cross-repo hop.
            if (target.member === m.project) continue;
            const targetId = codeFolderId('.', target.repoSlug);
            const key = `${id}→${targetId}`;
            if (authored.has(key)) continue;
            authored.add(key);
            try {
                await client.storeEdge({
                    sourceId: id,
                    targetId,
                    relation: 'resolves_to',
                    workspace: targetWorkspace,
                    // GF-1 — module-level heuristic, not an AST fact.
                    confidence: 'inferred',
                    confidenceScore: 0.7,
                });
                edgeResult.edgeCount += 1;
                bridges.push({ importId: id, module, member: target.member, targetId });
            } catch (err) {
                const msg = (err as Error).message;
                // Same defer-don't-error policy as importEdgeLine: a missing
                // endpoint (e.g. member-B shipped no folder node) defers rather
                // than failing the whole load.
                if (ENDPOINT_MISSING_RE.test(msg)) {
                    edgeResult.deferredEdges.push({ kind: 'edge', sourceId: id, targetId, relation: 'resolves_to' });
                } else {
                    edgeResult.errors.push({ id: key, error: msg });
                }
            }
        }
    }
    return bridges;
}

/**
 * G-3 — the PACKAGE ROOT of a module specifier, used as the bridge match key.
 * Scoped packages keep two segments (`@scope/pkg` from `@scope/pkg/sub`);
 * unscoped packages keep one (`pkg` from `pkg/sub`). A bare package name maps
 * to itself. Relative/absolute specifiers (`./x`, `../x`, `/x`) are NEVER
 * external imports (the resolver only emits code-import nodes for unresolved
 * externals) but are returned verbatim defensively — they won't match a
 * package name anyway.
 */
function packageRoot(moduleSpecifier: string): string {
    if (!moduleSpecifier) return moduleSpecifier;
    const parts = moduleSpecifier.split('/');
    if (moduleSpecifier.startsWith('@')) {
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleSpecifier;
    }
    return parts[0] ?? moduleSpecifier;
}

/**
 * A0 — decide between precomputed-vectors batch ingest and the legacy
 * serial storeNode path, then run the chosen path and stitch per-node
 * results back into `result`.
 *
 * Conditions for the precomputed path:
 * The batch is partitioned PER NODE:
 *   - Nodes carrying a usable embedding (number[] non-empty) take the
 *     precomputed-vector bulk path when the header is v2+ and the writer
 *     implements bulkStoreNodesWithVectors.
 *   - Every other node takes the serial storeNode path, where the per-type
 *     embed flag decides the cost: graph-only code types are embed:false
 *     (nothing to embed — cheap write); everything else re-embeds locally.
 *
 * Within the precomputed path: Lore validates dim per-node. Any node
 * Lore rejects with an `embedding dimension mismatch: got N, model
 * expects M` error gets re-tried via storeNode(embed:true) — so a
 * cross-model bundle (machine A used model X, machine B uses model Y)
 * still imports cleanly, just paying the re-embed cost for the
 * mismatched subset.
 */
async function ingestPendingNodes(
    client: MemoryImportWriter,
    targetWorkspace: string,
    pendingNodes: Array<Record<string, unknown>>,
    headerVersion: number,
    result: ImportResult,
    /**
     * G-1 — when set, every node also gets a belt-and-suspenders
     * metadata.sourceRepo=<sourceRepo> provenance stamp (in addition to
     * project=targetWorkspace) so provenance survives even for a consumer that
     * ignores the project field. Omitted for plain single-repo importMemory.
     */
    sourceRepo?: string,
    /**
     * G-3 — the set of node types this ingest is ALLOWED to write. DEFAULTS to
     * KNOWLEDGE_TYPE_SET so every existing caller (importMemory, the knowledge
     * co-load in loadGroup) keeps the exact moat-import guard: code-typed nodes
     * are refused even if someone hand-edits the moat file. The code-graph
     * co-load path passes CODE_TYPE_SET so the 5 code types can be imported
     * WITHOUT weakening the moat guard — the two paths are physically separate
     * files, and this param is the only thing that distinguishes them.
     */
    allowedTypes: ReadonlySet<string> = KNOWLEDGE_TYPE_SET,
): Promise<void> {
    if (pendingNodes.length === 0) return;

    // Pre-filter: drop bad shapes / non-knowledge types early. We do this
    // BEFORE deciding the path so both branches see the same node set.
    type Prepared = {
        raw: Record<string, unknown>;
        input: StoreNodeInput;
        embedding?: number[];
    };
    const prepared: Prepared[] = [];
    for (const parsed of pendingNodes) {
        const id = typeof parsed['id'] === 'string' ? parsed['id'] : undefined;
        const type = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;
        if (!id || !type) {
            result.errors.push({ id: id ?? '<missing-id>', error: 'node missing id or type' });
            continue;
        }
        if (!allowedTypes.has(type)) {
            // Defensive skip — refuse to import a node whose type isn't in the
            // allowed set. For the moat-import default (allowedTypes =
            // KNOWLEDGE_TYPE_SET) this still refuses code-typed nodes even if
            // someone hand-edited the file. For the G-3 code-graph co-load
            // (allowedTypes = CODE_TYPE_SET) it conversely refuses knowledge
            // types — so neither file can smuggle the other's nodes in.
            result.skipped += 1;
            continue;
        }
        const input = buildStoreNodeInput(parsed, targetWorkspace, id, type, sourceRepo);
        const emb = parsed['embedding'];
        const embedding = Array.isArray(emb) && emb.length > 0 && emb.every((v) => Number.isFinite(v))
            ? (emb as number[])
            : undefined;
        prepared.push({ raw: parsed, input, embedding });
    }

    const bulkAvailable =
        headerVersion >= 2 && typeof client.bulkStoreNodesWithVectors === 'function';

    // Partition PER NODE instead of all-or-nothing: the G-3 code-graph
    // co-load is a MIXED batch — code_context cards carry precomputed
    // vectors, the graph-only types deliberately don't. Requiring EVERY node
    // to carry a vector (the old gate) dragged the whole batch into the
    // serial path, re-embedding even the vector-carrying cards.
    const withVec: Prepared[] = [];
    const withoutVec: Prepared[] = [];
    for (const p of prepared) {
        (bulkAvailable && p.embedding !== undefined ? withVec : withoutVec).push(p);
    }

    // Serial path — nodes without a precomputed vector (or any node when bulk
    // is unavailable). The per-node embed flag decides the cost: graph-only
    // code types are embed:false (nothing to embed — a cheap write);
    // everything else re-embeds locally.
    for (const p of withoutVec) {
        try {
            await client.storeNode(p.input);
            result.nodeCount += 1;
        } catch (err) {
            result.errors.push({ id: p.input.id, error: (err as Error).message });
        }
    }
    if (withVec.length === 0) return;

    // Precomputed-vectors batch path. Toggle off the per-node embed flag
    // so Lore doesn't try to also re-embed — the bulkIngest layer reads
    // the `embedding` we pass alongside, not `embed`. We still pass the
    // text fields so a per-node dim-mismatch fallback can re-embed from
    // the same content.
    const batchNodes = withVec.map((p) => ({ ...p.input }));
    const vectors = withVec.map((p) => p.embedding as number[]);

    const ingest = await client.bulkStoreNodesWithVectors!(batchNodes, vectors);

    // Stitch results back: success → nodeCount++; dim mismatch → re-embed
    // via storeNode(embed:true); other failures → error[]. Lore's result
    // order matches input order (bulkIngest preserves indexing) but we
    // also key by id for safety against any future re-ordering.
    const byId = new Map<string, Prepared>();
    for (const p of withVec) byId.set(p.input.id, p);

    const DIM_MISMATCH_RE = /embedding dimension mismatch/i;
    for (let i = 0; i < ingest.results.length; i++) {
        const r = ingest.results[i];
        if (!r) continue;
        const id = r.id ?? batchNodes[i]?.id;
        const p = (id && byId.get(id)) || withVec[i];
        if (!p) continue;
        if (r.ok) {
            result.nodeCount += 1;
            continue;
        }
        const errMsg = r.error ?? 'unknown bulk error';
        if (DIM_MISMATCH_RE.test(errMsg)) {
            // Cross-model bundle — re-embed THIS node locally.
            try {
                await client.storeNode(p.input);
                result.nodeCount += 1;
            } catch (err) {
                result.errors.push({
                    id: p.input.id,
                    error: `re-embed fallback failed: ${(err as Error).message}`,
                });
            }
        } else {
            result.errors.push({ id: p.input.id, error: errMsg });
        }
    }
}

/** Shared StoreNodeInput builder (extracted so both ingest paths agree
 *  on the v1 vs v2 → input mapping — workspace, embed flag, supersededAt
 *  round-trip).
 *
 *  G-1 — when `sourceRepo` is given, merge `sourceRepo` into the node's
 *  metadata object (preserving any metadata the source authored) as a
 *  provenance stamp that survives even when a consumer ignores the project
 *  field. We never mutate the original parsed.metadata — a shallow copy is
 *  taken so the same parsed node could be re-ingested cleanly. */
function buildStoreNodeInput(
    parsed: Record<string, unknown>,
    targetWorkspace: string,
    id: string,
    type: string,
    sourceRepo?: string,
): StoreNodeInput {
    const label = typeof parsed['label'] === 'string' ? parsed['label'] : '';
    const input: StoreNodeInput = {
        id,
        type,
        label,
        workspace: targetWorkspace, // IMPORTER's workspace, not source's.
        // Per-type embed decision — graph-only code types are embed:false BY
        // DESIGN at index time (store/codeNodes.ts: graph traversal only, no
        // vector). Re-embedding them on import is pure waste (thousands of
        // nodes on a group co-load) and pollutes the vector store. Knowledge
        // types and code_context cards keep embed:true (regenerate vectors
        // locally — a no-op when the precomputed path supplies them upstream).
        embed: !GRAPH_ONLY_CODE_TYPES.has(type),
    };
    if (typeof parsed['content'] === 'string') input.content = parsed['content'];
    // Accept both the comma-string export format and a Pass-3 string[].
    const importTags = tagsToString(parsed['tags'] as string | string[] | undefined);
    if (importTags) input.tags = importTags;

    // Merge the authored metadata with the G-1 sourceRepo provenance stamp.
    let metadata: Record<string, unknown> | undefined;
    const authored = parsed['metadata'];
    if (authored && typeof authored === 'object' && !Array.isArray(authored)) {
        metadata = { ...(authored as Record<string, unknown>) };
    } else if (authored !== undefined) {
        // Non-object authored metadata (rare) — keep it under a key so we don't
        // drop it while still attaching sourceRepo.
        metadata = sourceRepo ? { value: authored } : undefined;
        if (!sourceRepo) (input as Record<string, unknown>)['metadata'] = authored;
    }
    if (sourceRepo) {
        metadata = { ...(metadata ?? {}), sourceRepo };
    }
    if (metadata !== undefined) (input as Record<string, unknown>)['metadata'] = metadata;

    // supersededAt is deliberately NOT set here — Lore's storeNode/nodeUpsert
    // silently ignores it (a protected, derived field; verified directly).
    // Every node is stored plain; applySupersedes (below) restores supersede
    // status afterward via the real supersedeNode mutation, once the
    // replacement node it needs also exists.
    return input;
}

async function importEdgeLine(
    client: MemoryImportWriter,
    targetWorkspace: string,
    parsed: Record<string, unknown>,
    result: ImportResult,
): Promise<void> {
    const sourceId = typeof parsed['sourceId'] === 'string' ? parsed['sourceId'] : undefined;
    const targetId = typeof parsed['targetId'] === 'string' ? parsed['targetId'] : undefined;
    const relation = typeof parsed['relation'] === 'string' ? parsed['relation'] : undefined;
    if (!sourceId || !targetId || !relation) {
        result.errors.push({
            id: `${sourceId ?? '?'}→${targetId ?? '?'}`,
            error: 'edge missing sourceId, targetId, or relation',
        });
        return;
    }

    const edge: StoreEdgeInput = {
        sourceId,
        targetId,
        relation,
        workspace: targetWorkspace,
    };

    try {
        await client.storeEdge(edge);
        // storeEdge read the row back; reaching here means it truly persisted.
        result.edgeCount += 1;
    } catch (err) {
        const msg = (err as Error).message;
        // G-2 — EmbeddedLore.storeEdge throws `edge endpoint missing: ...`
        // when addEdge's MATCH..CREATE no-op'd because an endpoint is absent.
        // That's NOT a failure for a multi-member group co-load: a sibling
        // member may still supply the foreign endpoint, after which this edge
        // can be re-applied. Route it to deferredEdges (inert-but-recoverable)
        // rather than errors. Any OTHER storeEdge failure is a real error.
        if (ENDPOINT_MISSING_RE.test(msg)) {
            result.deferredEdges.push({ kind: 'edge', sourceId, targetId, relation });
        } else {
            result.errors.push({
                id: `${sourceId}→${targetId}`,
                error: msg,
            });
        }
    }
}

/** Matches the `edge endpoint missing: ...` message EmbeddedLore.storeEdge
 *  throws when Lore's addEdge silently no-op'd on an absent endpoint. */
const ENDPOINT_MISSING_RE = /edge[_ ]endpoint[_ ]missing/i;
