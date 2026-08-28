/**
 * memoryFile.ts — W2 (Groundfloor Atlas) the dependency-free `.atlas/memory.jsonl` core.
 *
 * ONE module that parses/serializes the git-synced memory file, shared by
 * (a) `importMemory`'s parser (cli/memorySync.ts delegates here), (b) the git
 * merge driver (scripts/memory-merge-driver.mjs — the union AUTHORITY, which
 * this module re-exports but never duplicates), and (c) the new stateless
 * no-DB read/append surface (`readMemoryFile` / `appendMemoryEntries`) that
 * the PM product and `atlas memory show|grep|append` stand on.
 *
 * ZERO-NATIVE-DEPS CONTRACT (load-guard-tested, tests/memory-no-native.test.ts):
 * this module imports ONLY node builtins + the pure .mjs union helper. It must
 * NEVER import kuzu, LanceDB, better-sqlite3, embeddedLore, or anything that
 * transitively loads a native module — a process that has never loaded any of
 * them can read, query, and append to `.atlas/memory.jsonl`. That property is
 * the whole point: the PM's clone has no DB, and the file surface keeps
 * working even when the CLI's native modules are ABI-broken.
 *
 * File shape (see cli/memorySync.ts header for the full spec):
 *   Line 1 (header): {"version":1|2,"exportedAt":<ISO>,...,"exportedTypes":[...]}
 *   Subsequent lines: {"kind":"node",...} or {"kind":"edge",...}
 *
 * Write discipline: every write goes through union(fresh=ours, prior=theirs)
 * + atomic temp+rename with `wx`/0o600 — the same semantics as the merge
 * driver and the pre-commit fold-back, so an append can NEVER wipe or clobber
 * entries it didn't author (union preserves everything present on either side).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
// W1 (merge-safety) — the SAME pure-JSONL union used by the git merge driver
// and the pre-commit fold-back (unionMemoryFileInPlace). Single implementation;
// this module re-exports it for stateless consumers but does NOT duplicate it.
// @ts-expect-error — pure .mjs helper, no type declarations (matches tests/memory-merge-driver.test.ts)
import { unionMemoryJsonl } from '../scripts/memory-merge-driver.mjs';

// Re-export the union authority so stateless consumers (and tests) can reach
// it through the typed core without importing the .mjs path themselves.
export { unionMemoryJsonl };

/** Knowledge node types we sync via git. Code-typed nodes are skipped
 *  on purpose — they regenerate locally from the source tree.
 *  (Moved here from cli/memorySync.ts in W2 so the stateless surface can
 *  validate types without touching the DB-coupled module; memorySync
 *  re-exports for compat.) */
export const KNOWLEDGE_TYPES = [
    'decision',
    'convention',
    'bug_pattern',
    'troubleshooting',
    'architecture',
] as const;
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

/** Exported (G-3) so the code-graph co-load path can swap in CODE_TYPE_SET as
 *  its `allowedTypes` without weakening the moat-import default. */
export const KNOWLEDGE_TYPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_TYPES);

/** A `{"kind":"node",...}` line. (Moved here from cli/memorySync.ts in W2;
 *  memorySync re-exports for compat.) */
export interface NodeLine {
    kind: 'node';
    id: string;
    type: KnowledgeType;
    label?: string;
    content?: string;
    tags?: string;
    metadata?: unknown;
    supersededAt?: string | null;
    /** The id of the node that superseded this one. Captured alongside
     *  supersededAt (Lore stamps both together via the dedicated supersede
     *  mutation — see EmbeddedLore.supersedeNode) so a DB rebuild from this
     *  file can call that SAME real mutation instead of trying to set
     *  supersededAt as a plain field, which the storage layer silently
     *  ignores (it's a protected, derived field, not a generic column). */
    supersededBy?: string | null;
    /** Optional human-readable reason recorded at supersede time. */
    supersededReason?: string | null;
    /** A0 (v2) — precomputed vector. Absent in v1 exports and in v2
     *  exports for nodes the storage layer couldn't resolve a vector for
     *  (e.g. embed:false graph-only). */
    embedding?: number[];
}

/** A `{"kind":"edge",...}` line. (Moved here from cli/memorySync.ts in W2;
 *  memorySync re-exports for compat — ImportResult.deferredEdges surfaces it.) */
export interface EdgeLine {
    kind: 'edge';
    sourceId: string;
    targetId: string;
    relation: string;
}

/**
 * Raw streamed parse of a memory.jsonl file — the SINGLE parse core that
 * cli/memorySync.ts's `parseMemoryFile` delegates to and `readMemoryFile`
 * shapes into a typed view. Records are the parsed JSON objects verbatim
 * (no coercion), each paired with its 1-based line number so downstream
 * consumers can report positions.
 */
export interface RawMemoryFile {
    /** Header `version` field (1 or 2 — anything else throws below). */
    headerVersion: number | undefined;
    /** The parsed header object (for `exportedAt` etc.). */
    header: Record<string, unknown> | undefined;
    /** `{"kind":"node"}` lines, file order. */
    nodes: Array<{ line: number; obj: Record<string, unknown> }>;
    /** `{"kind":"edge"}` lines, file order. */
    edges: Array<{ line: number; obj: Record<string, unknown> }>;
    /** JSON.parse failures — `error` is `json parse: <message>` (the exact
     *  string importMemory has always recorded). */
    parseErrors: Array<{ line: number; error: string }>;
    /** Post-header lines whose `kind` is neither node nor edge. */
    skipped: number;
}

/**
 * Stream a memory.jsonl file and split it into buffered node lines and edge
 * lines (NOTHING is applied anywhere — pure parse). Extracted from
 * cli/memorySync.ts `parseMemoryFile` in W2; behavior is byte-identical,
 * including the header-validation error strings (they keep the historical
 * `memory import:` prefix because importMemory's callers match on them).
 *
 * The header is validated as the first successfully-PARSED line (v1/v2 only)
 * — a junk line before it is recorded as a parse error and skipped, exactly
 * as the inline loop always did. Knowledge corpora are small, so buffering
 * the whole file is fine — same trade-off exportMemory makes.
 */
export async function parseMemoryJsonlFile(absIn: string): Promise<RawMemoryFile> {
    const stream = fs.createReadStream(absIn, { encoding: 'utf8' });
    // Use readline so large memory files (theoretical: thousands of
    // decisions) don't have to load all into memory at once.
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineNo = 0;
    let sawHeader = false;
    let headerVersion: number | undefined;
    let header: Record<string, unknown> | undefined;
    const nodes: RawMemoryFile['nodes'] = [];
    const edges: RawMemoryFile['edges'] = [];
    const parseErrors: RawMemoryFile['parseErrors'] = [];
    let skipped = 0;

    try {
        for await (const raw of rl) {
            lineNo += 1;
            const line = raw.trim();
            if (!line) continue;

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(line) as Record<string, unknown>;
            } catch (err) {
                parseErrors.push({
                    line: lineNo,
                    error: `json parse: ${(err as Error).message}`,
                });
                continue;
            }

            // First non-empty line MUST be a known header version. v2
            // readers accept v1 files (re-embed path); v1 readers see a
            // v2 file's vectors as unknown fields and ignore them.
            if (!sawHeader) {
                const version = parsed['version'];
                if (version !== 1 && version !== 2) {
                    throw new Error(
                        `memory import: unsupported or missing header version (got ${JSON.stringify(version)}); ` +
                        `expected version 1 or 2 on line 1 of ${absIn}`,
                    );
                }
                sawHeader = true;
                headerVersion = version;
                header = parsed;
                continue;
            }

            const kind = parsed['kind'];
            if (kind === 'node') {
                nodes.push({ line: lineNo, obj: parsed });
            } else if (kind === 'edge') {
                edges.push({ line: lineNo, obj: parsed });
            } else {
                // Unknown kind — count as skipped, don't fail the run.
                skipped += 1;
            }
        }
    } finally {
        rl.close();
        stream.destroy();
    }

    if (!sawHeader) {
        throw new Error(`memory import: file is empty or has no header: ${absIn}`);
    }

    return { headerVersion, header, nodes, edges, parseErrors, skipped };
}

/**
 * The typed, coerced view of a memory.jsonl file that the stateless retrieval
 * helpers (src/memoryQuery.ts) and the `atlas memory show|grep` CLI operate on.
 * `errors` pools JSON-parse failures AND shape problems (missing id/type,
 * unknown type, malformed edge) with line numbers — flag, never silent-drop.
 */
export interface MemoryFileView {
    headerVersion: 1 | 2;
    /** Header `exportedAt` when present and a string. */
    exportedAt?: string;
    /** Well-shaped knowledge node lines, file order (≈ oldest first). */
    nodes: NodeLine[];
    /** Well-shaped edge lines, file order. */
    edges: EdgeLine[];
    errors: Array<{ line: number; error: string }>;
}

export interface ReadMemoryFileOptions {
    /**
     * DEFAULT FALSE — strip `embedding[]` from the view. The stateless
     * consumer never needs 384-d vectors and they dominate file bytes; only
     * an explicit opt-in carries them through (e.g. a tool that re-exports).
     */
    includeVectors?: boolean;
}

/**
 * Read a memory.jsonl file into a typed `MemoryFileView` — the no-DB read
 * surface. Throws on a missing file or an invalid/missing header (same exact
 * error strings as importMemory, via the shared parse core); per-line junk
 * and shape problems land in `errors` instead of aborting, mirroring the
 * importer's junk tolerance.
 */
export async function readMemoryFile(
    absPath: string,
    opts: ReadMemoryFileOptions = {},
): Promise<MemoryFileView> {
    const absIn = path.resolve(absPath);
    if (!fs.existsSync(absIn)) {
        throw new Error(`memory read: file not found: ${absIn}`);
    }
    const includeVectors = opts.includeVectors ?? false;
    const raw = await parseMemoryJsonlFile(absIn);

    const view: MemoryFileView = {
        // parseMemoryJsonlFile only ever accepts 1 | 2 (anything else throws).
        headerVersion: (raw.headerVersion === 2 ? 2 : 1),
        nodes: [],
        edges: [],
        errors: [...raw.parseErrors],
    };
    const exportedAt = raw.header?.['exportedAt'];
    if (typeof exportedAt === 'string') view.exportedAt = exportedAt;

    for (const { line, obj } of raw.nodes) {
        const id = typeof obj['id'] === 'string' ? obj['id'] : undefined;
        const type = typeof obj['type'] === 'string' ? obj['type'] : undefined;
        if (!id || !type) {
            view.errors.push({ line, error: 'node missing id or type' });
            continue;
        }
        if (!KNOWLEDGE_TYPE_SET.has(type)) {
            // The importer counts these as skipped (allowedTypes guard); the
            // view surfaces them by line so `memory show` makes them visible.
            view.errors.push({ line, error: `unknown node type '${type}' (not in KNOWLEDGE_TYPES)` });
            continue;
        }
        const node: NodeLine = { kind: 'node', id, type: type as KnowledgeType };
        if (typeof obj['label'] === 'string') node.label = obj['label'];
        if (typeof obj['content'] === 'string') node.content = obj['content'];
        // Tolerate both tag shapes (comma-string export format / hand-authored
        // string[]) — same normalization contract as src/tags.ts, inlined here
        // to keep this module's import set builtin-only.
        const tags = obj['tags'];
        if (typeof tags === 'string' && tags.trim()) node.tags = tags;
        else if (Array.isArray(tags)) {
            const joined = tags.map((t) => String(t).trim()).filter(Boolean).join(',');
            if (joined) node.tags = joined;
        }
        if (obj['metadata'] !== undefined) node.metadata = obj['metadata'];
        // Preserve supersededAt round-trip (null is meaningful — "not superseded").
        if ('supersededAt' in obj) {
            node.supersededAt = (obj['supersededAt'] as string | null | undefined) ?? null;
        }
        // supersededBy/supersededReason travel WITH supersededAt — a DB rebuild
        // needs the replacement id to actually call supersedeNode (see NodeLine).
        if ('supersededBy' in obj) {
            node.supersededBy = (obj['supersededBy'] as string | null | undefined) ?? null;
        }
        if ('supersededReason' in obj) {
            node.supersededReason = (obj['supersededReason'] as string | null | undefined) ?? null;
        }
        if (includeVectors) {
            const emb = obj['embedding'];
            if (Array.isArray(emb) && emb.length > 0 && emb.every((v) => Number.isFinite(v))) {
                node.embedding = emb as number[];
            }
        }
        view.nodes.push(node);
    }

    for (const { line, obj } of raw.edges) {
        const sourceId = typeof obj['sourceId'] === 'string' ? obj['sourceId'] : undefined;
        const targetId = typeof obj['targetId'] === 'string' ? obj['targetId'] : undefined;
        const relation = typeof obj['relation'] === 'string' ? obj['relation'] : undefined;
        if (!sourceId || !targetId || !relation) {
            view.errors.push({ line, error: 'edge missing sourceId, targetId, or relation' });
            continue;
        }
        view.edges.push({ kind: 'edge', sourceId, targetId, relation });
    }

    return view;
}

// ── W2-T3 — stateless append/write path ─────────────────────────────────────

/**
 * Build a knowledge id matching the scheme `knowledge_store`
 * (src/mcp/allTools.ts) generates when the caller omits an id:
 * `knowledge:<type>:<suffix>` (its auto-suffix is `<Date.now()>-<rand>`).
 * A deterministic caller-chosen slug in the suffix position is the W3
 * idempotency key (e.g. `knowledge:decision:pm-REQ-42`).
 */
export function makeKnowledgeId(type: KnowledgeType, slug: string): string {
    if (!KNOWLEDGE_TYPE_SET.has(type)) {
        throw new Error(`makeKnowledgeId: unknown knowledge type '${type}'`);
    }
    const s = slug.trim();
    if (!s) throw new Error('makeKnowledgeId: slug must be non-empty');
    return `knowledge:${type}:${s}`;
}

/**
 * Normalize a loose (e.g. hand-authored / CLI-supplied JSONL) record into a
 * NodeLine or EdgeLine, applying the stateless-append defaults:
 *   - `kind` defaults to 'edge' when the record carries sourceId/targetId,
 *     else 'node';
 *   - a node's `type` defaults to 'decision' (the PM's entry type).
 * Purely shape-normalizing — validation happens in appendMemoryEntries.
 */
export function normalizeMemoryEntry(raw: Record<string, unknown>): NodeLine | EdgeLine {
    const kind = raw['kind'] ?? (raw['sourceId'] !== undefined || raw['targetId'] !== undefined ? 'edge' : 'node');
    if (kind === 'edge') {
        return {
            kind: 'edge',
            sourceId: typeof raw['sourceId'] === 'string' ? raw['sourceId'] : '',
            targetId: typeof raw['targetId'] === 'string' ? raw['targetId'] : '',
            relation: typeof raw['relation'] === 'string' ? raw['relation'] : '',
        };
    }
    const node: NodeLine = {
        kind: 'node',
        id: typeof raw['id'] === 'string' ? raw['id'] : '',
        type: (typeof raw['type'] === 'string' ? raw['type'] : 'decision') as KnowledgeType,
    };
    if (typeof raw['label'] === 'string') node.label = raw['label'];
    if (typeof raw['content'] === 'string') node.content = raw['content'];
    if (typeof raw['tags'] === 'string') node.tags = raw['tags'];
    else if (Array.isArray(raw['tags'])) {
        const joined = (raw['tags'] as unknown[]).map((t) => String(t).trim()).filter(Boolean).join(',');
        if (joined) node.tags = joined;
    }
    if (raw['metadata'] !== undefined) node.metadata = raw['metadata'];
    if ('supersededAt' in raw) node.supersededAt = (raw['supersededAt'] as string | null | undefined) ?? null;
    if ('supersededBy' in raw) node.supersededBy = (raw['supersededBy'] as string | null | undefined) ?? null;
    if ('supersededReason' in raw) node.supersededReason = (raw['supersededReason'] as string | null | undefined) ?? null;
    const emb = raw['embedding'];
    if (Array.isArray(emb) && emb.length > 0 && emb.every((v) => Number.isFinite(v))) {
        node.embedding = emb as number[];
    }
    return node;
}

export interface AppendOptions {
    /** Header `exportedAt` override (ISO string) — injectable so an append is
     *  byte-reproducible in tests; defaults to now. */
    exportedAt?: string;
    /** Optional header `sourceWorkspace` provenance (the DB export stamps its
     *  workspace here; a stateless writer usually has none). */
    sourceWorkspace?: string;
}

export interface AppendResult {
    path: string;
    /** Entries this call contributed (before union dedupe). */
    appended: number;
    /** Node/edge counts of the RESULTING file (recounted post-union — the
     *  union may carry prior entries the input didn't know about). */
    nodeCount: number;
    edgeCount: number;
    bytes: number;
}

/**
 * Append knowledge entries to an existing (or new) memory.jsonl with no DB,
 * using the same union semantics as everything else — the caller is just
 * another git participant.
 *
 * Mechanics: serialize `entries` under a fresh v2 header, then
 * `unionMemoryJsonl(newText, existingText)` with the NEW entries as `ours` —
 * so a re-run with the same deterministic ids UPSERTS (ours-wins) rather than
 * duplicates (W3 idempotency), and every prior entry not re-authored here is
 * preserved verbatim (union never drops a side). A v2 header with absent
 * `embedding[]` is legal: the importer's per-node missing-vector path falls
 * through to the serial re-embed (see ingestPendingNodes, cli/memorySync.ts).
 *
 * VALIDATION BEFORE WRITE — the ledger must never gain junk the union's
 * junk-tolerance then preserves forever: a node needs a non-empty id, a type
 * in KNOWLEDGE_TYPES, and non-empty content; an edge needs non-empty
 * endpoints + relation. Any offender rejects the WHOLE call (no partial
 * append) before anything touches disk.
 *
 * Atomic temp+rename in the same directory (same `wx`/0o600 discipline as
 * exportMemory / unionMemoryFileInPlace). Single-writer-per-clone is assumed
 * (the PM works in its own clone); deliberately NO file locking — cross-clone
 * concurrency is git's job (the W1 merge driver).
 */
export function appendMemoryEntries(
    absPath: string,
    entries: ReadonlyArray<NodeLine | EdgeLine>,
    opts: AppendOptions = {},
): AppendResult {
    if (entries.length === 0) {
        throw new Error('memory append: no entries given');
    }
    entries.forEach((entry, i) => {
        const at = `entry ${i + 1} of ${entries.length}`;
        if (entry.kind === 'edge') {
            if (!entry.sourceId || !entry.targetId || !entry.relation) {
                throw new Error(`memory append: edge missing sourceId, targetId, or relation (${at})`);
            }
            return;
        }
        if (entry.kind !== 'node') {
            throw new Error(`memory append: unknown entry kind ${JSON.stringify((entry as { kind?: unknown }).kind)} (${at})`);
        }
        if (!entry.id || !entry.id.trim()) {
            throw new Error(`memory append: node missing id (${at})`);
        }
        if (!KNOWLEDGE_TYPE_SET.has(entry.type)) {
            throw new Error(`memory append: unknown node type '${String(entry.type)}' (${at})`);
        }
        if (typeof entry.content !== 'string' || !entry.content.trim()) {
            throw new Error(`memory append: node '${entry.id}' has empty content (${at})`);
        }
    });

    const absOut = path.resolve(absPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });

    // Fresh v2 header (vectorless-v2 is legal — importer re-embeds per node).
    const header = {
        version: 2,
        exportedAt: opts.exportedAt ?? new Date().toISOString(),
        ...(opts.sourceWorkspace !== undefined ? { sourceWorkspace: opts.sourceWorkspace } : {}),
        exportedTypes: KNOWLEDGE_TYPES,
    };
    const freshText = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n';

    // Union with whatever is on disk — new entries as OURS (upsert wins),
    // prior file as THEIRS (everything it holds is preserved). A missing file
    // unions against empty and yields exactly the fresh text.
    const priorText = fs.existsSync(absOut) ? fs.readFileSync(absOut, 'utf8') : '';
    const merged: string = unionMemoryJsonl(freshText, priorText);
    const bytes = Buffer.byteLength(merged, 'utf8');

    // Same atomic temp+rename + unique-suffix + O_EXCL (`wx`) discipline as
    // exportMemory, so a crash mid-write leaves either the prior file or the
    // union, never a partial, and no symlink/concurrent-writer race on the temp.
    const tmp = `${absOut}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, merged, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, absOut);

    // Recount from the merged body — union may have preserved prior entries.
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
    return { path: absOut, appended: entries.length, nodeCount, edgeCount, bytes };
}
