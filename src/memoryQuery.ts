/**
 * memoryQuery.ts — W2 (Groundfloor Atlas) brute-force retrieval over a MemoryFileView.
 *
 * Good-enough retrieval at pilot scale (one project, hundreds–low-thousands
 * of entries) WITHOUT any vector store: the stateless consumer (the PM, or
 * `atlas memory show|grep`) re-reads the JSONL fresh per task and either
 * keyword-filters or loads the relevant slice straight into LLM context.
 * Brute force is the point — do NOT add an index here; proven < 200ms over a
 * 5k-node synthetic file (tests/memory-query.test.ts).
 *
 * Same ZERO-NATIVE-DEPS contract as src/memoryFile.ts: node builtins only
 * (none needed, in fact) — never kuzu/LanceDB/sqlite/embedding stack.
 *
 * Every function is deterministic: stable input order in, stable output out,
 * with explicit tie-breaks (id ascending) where a sort is involved.
 */

import type { MemoryFileView, NodeLine, EdgeLine, KnowledgeType } from './memoryFile.js';

export interface FilterNodesOptions {
    /** Keep only these knowledge types (default: all). */
    types?: KnowledgeType[];
    /** Keep only nodes carrying EVERY listed tag (case-insensitive; a node's
     *  `tags` is the comma-string export format). */
    tags?: string[];
    /** DEFAULT FALSE — skip soft-superseded nodes (non-null `supersededAt`).
     *  Mirrors knowledge_recall's default lifecycle filter. */
    includeSuperseded?: boolean;
}

/** A node's tags (comma-string) as a lowercase array. */
function tagList(node: NodeLine): string[] {
    if (!node.tags) return [];
    return node.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** True when the node is soft-superseded (a non-null `supersededAt` stamp). */
function isSuperseded(node: NodeLine): boolean {
    return typeof node.supersededAt === 'string' && node.supersededAt.length > 0;
}

/**
 * Filter the view's nodes by type / tags / lifecycle. File order (≈ oldest
 * first) is preserved — no re-sort, so the output is deterministic for a
 * given file.
 */
export function filterNodes(view: MemoryFileView, opts: FilterNodesOptions = {}): NodeLine[] {
    const includeSuperseded = opts.includeSuperseded ?? false;
    const typeSet = opts.types && opts.types.length > 0 ? new Set<string>(opts.types) : undefined;
    const wantTags = opts.tags && opts.tags.length > 0
        ? opts.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)
        : undefined;

    return view.nodes.filter((n) => {
        if (!includeSuperseded && isSuperseded(n)) return false;
        if (typeSet && !typeSet.has(n.type)) return false;
        if (wantTags) {
            const have = new Set(tagList(n));
            for (const t of wantTags) if (!have.has(t)) return false;
        }
        return true;
    });
}

export interface KeywordSearchOptions extends FilterNodesOptions {
    /** Maximum results returned (default 20). */
    limit?: number;
}

export interface ScoredNode {
    node: NodeLine;
    /** Term-frequency score (label hits boosted ×3, tag hits ×2, content ×1). */
    score: number;
}

/** Non-overlapping occurrence count of `needle` in `hay` (both lowercased). */
function countOccurrences(hay: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = hay.indexOf(needle, idx + needle.length);
    }
    return count;
}

/**
 * Case-insensitive token scoring over `label` + `content` + `tags`:
 * the query is split on non-word runs, each token's occurrences are counted
 * per field, and fields weigh label ×3 / tags ×2 / content ×1 (label match
 * boost). Nodes matching NO token are excluded. Ranked score-descending with
 * a DETERMINISTIC tie-break by id ascending, capped at `limit` (default 20).
 * Filter options are applied first (superseded excluded by default).
 */
export function keywordSearch(
    view: MemoryFileView,
    query: string,
    opts: KeywordSearchOptions = {},
): ScoredNode[] {
    const limit = opts.limit ?? 20;
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    if (tokens.length === 0 || limit <= 0) return [];

    const scored: ScoredNode[] = [];
    for (const node of filterNodes(view, opts)) {
        const label = (node.label ?? '').toLowerCase();
        const content = (node.content ?? '').toLowerCase();
        const tags = (node.tags ?? '').toLowerCase();
        let score = 0;
        for (const tok of tokens) {
            score += countOccurrences(label, tok) * 3
                + countOccurrences(tags, tok) * 2
                + countOccurrences(content, tok);
        }
        if (score > 0) scored.push({ node, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
    return scored.slice(0, limit);
}

export interface NeighborsOptions {
    /** Keep only edges with this relation (exact match). */
    relation?: string;
}

export interface NeighborHit {
    edge: EdgeLine;
    /** 'out' = nodeId is the edge's source; 'in' = nodeId is its target. */
    direction: 'out' | 'in';
    /** The id at the far end (may be a cross-seam foreign id with no node in
     *  this file — `node` is then undefined). */
    otherId: string;
    /** The far-end node when it exists in this file's view. */
    node?: NodeLine;
}

/**
 * One-hop neighborhood of `nodeId` over `view.edges`, BOTH directions — for
 * "what does this decision touch". Deterministic: edges are scanned in file
 * order; a self-loop is reported once (as 'out'). Cross-seam edges whose far
 * end lives in a sibling repo's file resolve `otherId` but leave `node`
 * undefined — surfaced, not dropped.
 */
export function neighbors(
    view: MemoryFileView,
    nodeId: string,
    opts: NeighborsOptions = {},
): NeighborHit[] {
    const byId = new Map<string, NodeLine>();
    for (const n of view.nodes) byId.set(n.id, n);

    const hits: NeighborHit[] = [];
    for (const edge of view.edges) {
        if (opts.relation !== undefined && edge.relation !== opts.relation) continue;
        if (edge.sourceId === nodeId) {
            const other = byId.get(edge.targetId);
            hits.push({ edge, direction: 'out', otherId: edge.targetId, ...(other ? { node: other } : {}) });
        } else if (edge.targetId === nodeId) {
            const other = byId.get(edge.sourceId);
            hits.push({ edge, direction: 'in', otherId: edge.sourceId, ...(other ? { node: other } : {}) });
        }
    }
    return hits;
}

export interface ContextBlockOptions {
    /** Character budget for the block (default 8000). Entries are truncated
     *  WHOLE — an entry that would cross the budget is dropped entirely,
     *  never cut mid-entry. */
    maxChars?: number;
}

/**
 * Serialize a node slice to a compact markdown block for stuffing into an
 * LLM prompt. Entries render in the ORDER GIVEN — callers pass file order,
 * which is oldest-first for an append-mostly ledger. When the budget cuts
 * the list, a single trailing `… (+N more entries omitted)` line says so.
 */
export function toContextBlock(nodes: ReadonlyArray<NodeLine>, opts: ContextBlockOptions = {}): string {
    const maxChars = opts.maxChars ?? 8000;
    const blocks: string[] = [];
    let used = 0;
    let included = 0;
    for (const n of nodes) {
        const head = `- [${n.type}] ${n.label ?? n.id} (id: ${n.id}` +
            (n.tags ? `, tags: ${n.tags}` : '') +
            (isSuperseded(n) ? `, superseded: ${n.supersededAt}` : '') + ')';
        const body = n.content ? '\n  ' + n.content.replace(/\r?\n/g, '\n  ') : '';
        const block = head + body;
        // +1 for the joining newline between entries.
        const cost = block.length + (blocks.length > 0 ? 1 : 0);
        if (used + cost > maxChars) break;
        blocks.push(block);
        used += cost;
        included += 1;
    }
    const omitted = nodes.length - included;
    if (omitted > 0) blocks.push(`… (+${omitted} more entries omitted)`);
    return blocks.join('\n');
}
