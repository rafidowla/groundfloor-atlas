/**
 * mcp/tools/verbatim.ts — the verbatim memory tools (WO-2).
 *
 * verbatim_store / verbatim_recall / verbatim_import preserve RAW text —
 * agent turns, doc excerpts, transcript quotes — byte-for-byte, append-only
 * (D6: no verbatim tool ever edits or deletes a stored entry). This is the
 * complement of knowledge_store, which stays sparing and supersede-first for
 * curated institutional knowledge; verbatim is the high-fidelity quote bank.
 *
 * Storage layout (one 'note' node per entry, id = verbatim:<sha256(text)[0..12]>):
 *
 *     SOURCE: <source>
 *     AT: <ISO-8601 timestamp>
 *     <blank>
 *     <raw text, unmodified, capped at 32KB (tail-truncated + [truncated])>
 *
 * The two header lines are what verbatim_recall parses back out (`at`, `source`);
 * everything after them is the untouched original.
 *
 * recall status model — each hit is annotated against the OTHER hits in the
 * result set (never mutated in the store):
 *   - `superseded-by:<newerId>`: an inbound `supersedes` edge from another hit
 *     (edge source = newer node, target = superseded one — the same direction
 *     knowledge_store_edge documents for its `supersedes` relation).
 *   - `outdated-by:<newestId> (by time)`: a co-topic (`topic:<t>` tag) hit with
 *     a strictly newer AT timestamp.
 *   - `current`: neither. Current hits lead the result, newest first.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StoreNodeInput } from '../../loreClient.js';
import { scanPathError } from '../../indexRoots.js';
import { enqueueVerbatim, verbatimIdFor } from '../verbatimQueue.js';

/** Cap on the raw text body (characters). Over-cap text keeps its head and is
 *  marked with a trailing `\n[truncated]` line so the cut is always visible. */
export const VERBATIM_TEXT_CAP = 32 * 1024;

/** How deep verbatim_recall looks for an ISO date in an imported file's head. */
export const IMPORT_DATE_HEAD_LINES = 20;

/** Common ISO-8601 shapes: YYYY-MM-DD, optionally with time (+ optional
 *  seconds / fraction / zone). Used for verbatim_import's timestamp sniff. */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/;

// ── shared node building / parsing ───────────────────────────────────────────

export interface VerbatimStoreArgs {
    workspace: string;
    text: string;
    source: string;
    /** ISO-8601 capture time. Default: now. */
    timestamp?: string;
    topic?: string;
    sessionId?: string;
}

/** Build the stored content: two header lines, blank separator, then the raw
 *  text (tail-truncated at the cap with a visible marker). */
export function buildVerbatimContent(source: string, at: string, rawText: string): string {
    const body = rawText.length > VERBATIM_TEXT_CAP
        ? `${rawText.slice(0, VERBATIM_TEXT_CAP)}\n[truncated]`
        : rawText;
    return `SOURCE: ${source}\nAT: ${at}\n\n${body}`;
}

/** Inverse of buildVerbatimContent: pull the header fields and the raw body
 *  back apart. Tolerant — a node without the expected header shape yields
 *  empty source/at rather than throwing. */
export function parseVerbatimContent(content: string): { source: string; at: string; text: string } {
    const lines = content.split('\n');
    const source = lines[0]?.startsWith('SOURCE: ') ? lines[0]!.slice('SOURCE: '.length) : '';
    const at = lines[1]?.startsWith('AT: ') ? lines[1]!.slice('AT: '.length) : '';
    const text = lines.length > 3 ? lines.slice(3).join('\n') : '';
    return { source, at, text };
}

/** Build the StoreNodeInput for a verbatim entry. Id is the text hash, so a
 *  re-store of identical text is an idempotent upsert onto the same node. */
export function buildVerbatimNode(args: VerbatimStoreArgs): StoreNodeInput {
    const at = args.timestamp ?? new Date().toISOString();
    const node: StoreNodeInput = {
        id: verbatimIdFor(args.text),
        type: 'note',
        label: args.text.slice(0, 80),
        content: buildVerbatimContent(args.source, at, args.text),
        tags: args.topic ? `verbatim,topic:${args.topic}` : 'verbatim',
        workspace: args.workspace,
        embed: true,
    };
    if (args.sessionId) node.metadata = JSON.stringify({ sessionId: args.sessionId });
    return node;
}

// ── verbatim_store ───────────────────────────────────────────────────────────

/** Queue the entry; returns immediately ({ok, queued, id}) without touching
 *  the store — the flush (30s tick / shutdown) lands it in bulk. */
export function runVerbatimStore(args: VerbatimStoreArgs): { ok: true; queued: true; id: string } {
    const node = buildVerbatimNode(args);
    enqueueVerbatim(args.workspace, node);
    return { ok: true, queued: true, id: node.id };
}

// ── verbatim_recall ──────────────────────────────────────────────────────────

/** Minimum read surface: the tag-scoped fetch rides lore.recall (mode:'full'
 *  so the complete content — headers + raw body — comes back), and supersedes
 *  detection rides listEdgesBySource (indexed per-source lookups, the same
 *  escape hatch exportMemory uses — not a full-graph edge pull). */
export interface VerbatimRecallLore {
    recall(topic: string, opts?: { max?: number; mode?: 'summary' | 'full'; includeSuperseded?: boolean }): Promise<unknown>;
    listEdgesBySource(sourceIds: Iterable<string>): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
}

export interface VerbatimRecallArgs {
    workspace: string;
    topic: string;
    limit?: number;
}

export interface VerbatimHit {
    id: string;
    label: string;
    at: string;
    source: string;
    status: string;
    content: string;
}

interface RawHit {
    id: string;
    label?: string | null;
    content?: string | null;
    tags?: string | string[];
}

/** Lore returns tags as string[]; older/HTTP rows can carry a comma string.
 *  Same normalization knowledge_list applies. */
function toTagArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string');
    if (typeof v === 'string' && v.length > 0) return v.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    return [];
}

function atMs(at: string): number {
    const t = Date.parse(at);
    return Number.isNaN(t) ? 0 : t;
}

/**
 * Recall verbatim entries for a topic: semantic recall on the topic text,
 * narrowed to nodes tagged 'verbatim', each annotated with its standing
 * (superseded-by / outdated-by / current) against the rest of the result set.
 * Current hits lead (newest first); the rest follow by AT descending.
 */
export async function runVerbatimRecall(
    lore: VerbatimRecallLore,
    args: VerbatimRecallArgs,
): Promise<{ hits: VerbatimHit[] }> {
    const limit = Math.max(1, Math.min(500, args.limit ?? 10));
    // Over-fetch (same shape as lore.recall's own re-rank) so the verbatim-tag
    // narrowing below doesn't shrink a small limit to nothing when unrelated
    // knowledge outranks the quotes.
    const overfetch = Math.min(limit * 5, 100);
    const r = await lore.recall(args.topic, { max: overfetch, mode: 'full', includeSuperseded: true }) as { hits?: RawHit[] } | null;
    const raw = (r?.hits ?? []).filter((h) => toTagArray(h.tags).includes('verbatim'));
    const parsed = raw.map((h) => {
        const { source, at } = parseVerbatimContent(h.content ?? '');
        const topics = new Set(toTagArray(h.tags).filter((t) => t.startsWith('topic:')));
        return { id: h.id, label: h.label ?? '', content: h.content ?? '', source, at, topics };
    });
    const byId = new Map(parsed.map((h) => [h.id, h]));

    // supersedes edges BETWEEN hits: listEdgesBySource(hit ids) → edges whose
    // source is a hit; an edge (newer →supersedes→ older) marks the TARGET.
    const edges = await lore.listEdgesBySource(parsed.map((h) => h.id));
    const supersededBy = new Map<string, string>();
    for (const e of edges) {
        if (e.relation !== 'supersedes') continue;
        if (byId.has(e.sourceId) && byId.has(e.targetId) && !supersededBy.has(e.targetId)) {
            supersededBy.set(e.targetId, e.sourceId);
        }
    }

    const status = new Map<string, string>();
    for (const h of parsed) {
        const newer = supersededBy.get(h.id);
        if (newer !== undefined) {
            status.set(h.id, `superseded-by:${newer}`);
            continue;
        }
        // Time rule: a co-topic hit with a strictly newer AT outranks this one.
        let newest: { id: string; at: string } | null = null;
        for (const other of parsed) {
            if (other.id === h.id || atMs(other.at) <= atMs(h.at)) continue;
            let sharesTopic = false;
            for (const t of other.topics) {
                if (h.topics.has(t)) { sharesTopic = true; break; }
            }
            if (!sharesTopic) continue;
            if (!newest || atMs(other.at) > atMs(newest.at)) newest = other;
        }
        if (newest) status.set(h.id, `outdated-by:${newest.id} (by time)`);
        else status.set(h.id, 'current');
    }

    const sorted = [...parsed].sort((a, b) => {
        const tier = (id: string) => (status.get(id) === 'current' ? 0 : 1);
        if (tier(a.id) !== tier(b.id)) return tier(a.id) - tier(b.id);
        const d = atMs(b.at) - atMs(a.at);
        if (d !== 0) return d;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
        hits: sorted.slice(0, limit).map((h) => ({
            id: h.id,
            label: h.label,
            at: h.at,
            source: h.source,
            status: status.get(h.id) ?? 'current',
            content: h.content,
        })),
    };
}

// ── verbatim_import ──────────────────────────────────────────────────────────

export interface VerbatimImportArgs {
    workspace: string;
    files: string[];
    topic?: string;
}

/** First ISO-8601-looking date in the file's first 20 lines, else null. */
export function firstIsoDateInHead(text: string): string | null {
    const head = text.split('\n', IMPORT_DATE_HEAD_LINES).join('\n');
    return head.match(ISO_DATE_RE)?.[0] ?? null;
}

/**
 * Import files as verbatim entries (one per file). Every path is gated through
 * scanPathError — the SAME opt-in allowlist atlas_index enforces — BEFORE any
 * file is read; a forbidden path rejects the whole call with a typed error
 * (nothing is silently skipped, nothing is read). Timestamp = first ISO date
 * in the head of the file, else mtime. Source = `doc:<absolute path>`.
 */
export async function runVerbatimImport(
    args: VerbatimImportArgs,
): Promise<{ ok: true; queued: true; files: number; ids: string[] } | { error: string; tool: string; detail: string }> {
    const abs = args.files.map((f) => path.resolve(f));
    for (let i = 0; i < abs.length; i++) {
        const scanErr = scanPathError(abs[i]!);
        if (scanErr) {
            return { error: 'path_forbidden', tool: 'verbatim_import', detail: `${scanErr} (file: ${args.files[i]})` };
        }
    }
    const ids: string[] = [];
    for (const file of abs) {
        let text: string;
        let mtimeMs: number;
        try {
            text = fs.readFileSync(file, 'utf-8');
            mtimeMs = fs.statSync(file).mtimeMs;
        } catch (err) {
            return { error: 'read_failed', tool: 'verbatim_import', detail: `${file}: ${(err as Error).message}` };
        }
        const node = buildVerbatimNode({
            workspace: args.workspace,
            text,
            source: `doc:${file}`,
            timestamp: firstIsoDateInHead(text) ?? new Date(mtimeMs).toISOString(),
            topic: args.topic,
        });
        enqueueVerbatim(args.workspace, node);
        ids.push(node.id);
    }
    return { ok: true, queued: true, files: ids.length, ids };
}
