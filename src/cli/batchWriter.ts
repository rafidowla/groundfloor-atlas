/**
 * cli/batchWriter.ts — Y3 batch accumulator + flush via W9 bulk endpoints.
 *
 * Drives the recursive index path: parser yields a ParsedFile, codeNodes'
 * buildIndexBatch turns it into (nodes, edges) tuples, this writer
 * accumulates them across N files, then flushes via
 *   - POST /api/nodes/bulk  (rate-limit-exempt W9 endpoint)
 *   - POST /api/edges/bulk  (rate-limit-exempt W9 endpoint)
 *
 * Per-item bulk failures don't abort the batch — the bulk endpoint
 * returns a per-item results array; we log the file path for each
 * failed item and continue. (Y3 spec T5.)
 *
 * Connection reuse: takes a LoreClient at construction. That client
 * holds the keep-alive HTTP agent established in Sprint Y; this writer
 * does no socket bookkeeping of its own.
 *
 * Memory cap: bulk batches grow until the file count hits `batchSize`
 * (default 50). On large symbol-dense files the per-file node count
 * can exceed 100; if a single batch ever crosses 1000 nodes (W9's
 * per-call cap) we chunk before the POST so we don't get a 400 from
 * the daemon.
 *
 * Checkpoint integration: after each successful bulk flush, the caller
 * sees the list of files that just landed and updates the checkpoint
 * (so a kill mid-run resumes from the last flushed batch, not the last
 * parsed file).
 */

import type { LoreWriter, StoreNodeInput, StoreEdgeInput } from '../loreClient.js';

const W9_PER_CALL_NODE_CAP = 1000;
const W9_PER_CALL_EDGE_CAP = 1000;

export interface BatchWriterOpts {
    /** Files-per-flush. Default 50. */
    batchSize?: number;
    /** Called once per batch flush with a one-line progress string the
     *  CLI prints. Caller can also use this to drive a UI. */
    onProgress?: (line: string, summary: BatchProgress) => void;
}

export interface BatchProgress {
    filesDoneInBatch: number;
    filesDoneTotal: number;
    nodesFlushed: number;
    edgesFlushed: number;
    errors: BatchError[];
    elapsedSec: number;
}

export interface BatchError {
    filePath: string;
    item: 'node' | 'edge';
    error: string;
}

export class BatchWriter {
    private readonly batchSize: number;
    private readonly client: LoreWriter;
    private readonly onProgress?: (line: string, s: BatchProgress) => void;

    private pendingNodes: StoreNodeInput[] = [];
    private pendingEdges: StoreEdgeInput[] = [];
    // Per-file fingerprints inside the current batch — used to map a
    // bulk per-item failure back to its source file in the error log.
    private pendingFiles: Array<{ absPath: string; nodeIds: string[]; aux?: boolean }> = [];

    private filesDoneTotal = 0;
    private nodesTotal = 0;
    private edgesTotal = 0;
    private errors: BatchError[] = [];
    private startMs = Date.now();

    constructor(client: LoreWriter, opts: BatchWriterOpts = {}) {
        this.client = client;
        this.batchSize = Math.max(1, opts.batchSize ?? 50);
        this.onProgress = opts.onProgress;
    }

    /**
     * Queue one file's contribution. `absPath` is the file the caller
     * just parsed (used for error reporting + caller-side checkpoint
     * bookkeeping). Returns the array of absPaths flushed by this add
     * (empty unless the add tipped the batch).
     */
    async add(absPath: string, nodes: StoreNodeInput[], edges: StoreEdgeInput[]): Promise<string[]> {
        this.pendingNodes.push(...nodes);
        this.pendingEdges.push(...edges);
        this.pendingFiles.push({ absPath, nodeIds: nodes.map((n) => n.id) });
        if (this.pendingFiles.length >= this.batchSize) {
            return await this.flush();
        }
        return [];
    }

    /**
     * GF-3 — queue AUXILIARY (non-file) nodes/edges into the current batch:
     * whole-repo synthesized artifacts like the folder tree + external-import
     * nodes that aren't tied to any single parsed file. Unlike `add`, this does
     * NOT register a `pendingFiles` entry, so it never inflates `filesDoneTotal`
     * / the progress file count and never appears in the `landed` checkpoint
     * list. Node-level failures still surface in `errors` (attributed to a
     * synthetic source label). Buffers into the SAME batch; flushes with it.
     */
    addAux(label: string, nodes: StoreNodeInput[], edges: StoreEdgeInput[]): void {
        this.pendingNodes.push(...nodes);
        this.pendingEdges.push(...edges);
        // A pendingFiles entry with ZERO nodeIds participates in edge-error
        // attribution (fileForEdge) but contributes no nodeIds → never counted
        // as a landed file (it has no own node to fail), AND we tag it so the
        // landed-file accounting below skips it.
        this.pendingFiles.push({ absPath: label, nodeIds: [], aux: true });
    }

    /**
     * Flush the current pending batch. Returns the list of absPaths that
     * landed successfully — caller updates its checkpoint with them.
     * Items that the bulk endpoint reports failed do NOT appear in the
     * returned list (so the checkpoint stays accurate for resume).
     */
    async flush(): Promise<string[]> {
        if (this.pendingFiles.length === 0) return [];
        const filesInBatch = this.pendingFiles;
        const nodesInBatch = this.pendingNodes;
        const edgesInBatch = this.pendingEdges;
        this.pendingFiles = [];
        this.pendingNodes = [];
        this.pendingEdges = [];

        // id → underlying per-node error, so a file-level failure reports the
        // real reason (e.g. a field rejected by the store) instead of a
        // generic placeholder.
        const failedNodeIds = new Map<string, string>();
        for (let i = 0; i < nodesInBatch.length; i += W9_PER_CALL_NODE_CAP) {
            const chunk = nodesInBatch.slice(i, i + W9_PER_CALL_NODE_CAP);
            const r = await this.client.bulkStoreNodes(chunk);
            for (const item of r.results) {
                if (!item.ok && item.id) failedNodeIds.set(item.id, item.error ?? 'unknown');
            }
        }
        // Files that lost one or more outgoing edges in this flush. Such a file
        // must NOT be checkpointed as landed: its nodes wrote but some edges did
        // not, and on `--resume` needsReindex would skip it, making the dropped
        // edges permanently missing until a `--force` full re-index. Keep it out
        // of landedFiles so it is re-attempted.
        const failedEdgeFiles = new Set<string>();
        let failedEdgeCount = 0;
        for (let i = 0; i < edgesInBatch.length; i += W9_PER_CALL_EDGE_CAP) {
            const chunk = edgesInBatch.slice(i, i + W9_PER_CALL_EDGE_CAP);
            const r = await this.client.bulkStoreEdges(chunk);
            // Edge results don't carry an id; correlate by index within
            // the chunk back to a file via the file map.
            r.results.forEach((item, idx) => {
                if (!item.ok) {
                    failedEdgeCount += 1;
                    const e = chunk[idx]!;
                    const filePath = this.fileForEdge(filesInBatch, e);
                    failedEdgeFiles.add(filePath);
                    this.errors.push({
                        filePath,
                        item: 'edge',
                        error: item.error ?? 'unknown',
                    });
                }
            });
        }

        const landedFiles: string[] = [];
        for (const f of filesInBatch) {
            const failedId = f.nodeIds.find((id) => failedNodeIds.has(id));
            if (failedId) {
                this.errors.push({
                    filePath: f.absPath,
                    item: 'node',
                    error: failedNodeIds.get(failedId) ?? 'one or more nodes failed in bulk write',
                });
                continue;
            }
            // GF-3 — auxiliary (folder/import) contributions aren't files; never
            // count them as landed (no checkpoint entry, no filesDone inflation).
            if (f.aux) continue;
            // A file whose nodes wrote but whose edge(s) failed/rolled back must
            // not be checkpointed: leaving it out of landedFiles forces a re-index
            // on --resume so the dropped edges are re-attempted (HIGH: permanent
            // edge loss otherwise).
            if (failedEdgeFiles.has(f.absPath)) continue;
            landedFiles.push(f.absPath);
        }

        this.filesDoneTotal += landedFiles.length;
        // Count what actually LANDED, not what was attempted — adding the full
        // batch size on a partial failure made nodesWritten/edgesWritten (and
        // the index_status bar) over-report exactly when something went wrong.
        this.nodesTotal += nodesInBatch.length - failedNodeIds.size;
        this.edgesTotal += edgesInBatch.length - failedEdgeCount;
        const elapsed = (Date.now() - this.startMs) / 1000;
        const rate = elapsed > 0 ? Math.round(this.nodesTotal / elapsed) : 0;
        const summary: BatchProgress = {
            filesDoneInBatch: landedFiles.length,
            filesDoneTotal: this.filesDoneTotal,
            nodesFlushed: this.nodesTotal,
            edgesFlushed: this.edgesTotal,
            errors: [...this.errors],
            elapsedSec: elapsed,
        };
        const line = `[${this.filesDoneTotal} files | ${rate} nodes/sec | ${this.errors.length} errors]`;
        this.onProgress?.(line, summary);
        return landedFiles;
    }

    /** Convenience: snapshot total counters for end-of-run summary. */
    get totals(): { files: number; nodes: number; edges: number; errors: BatchError[] } {
        return {
            files: this.filesDoneTotal,
            nodes: this.nodesTotal,
            edges: this.edgesTotal,
            errors: [...this.errors],
        };
    }

    private fileForEdge(
        files: Array<{ absPath: string; nodeIds: string[] }>,
        e: StoreEdgeInput,
    ): string {
        for (const f of files) {
            if (f.nodeIds.includes(e.sourceId) || f.nodeIds.includes(e.targetId)) return f.absPath;
        }
        return '<unknown — symbol-to-symbol cross-file edge>';
    }
}
