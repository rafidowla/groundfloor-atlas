/**
 * cli/codeGraphSync.ts — G-3 OPT-IN code-graph artifact (cross-repo traversal).
 *
 * The moat invariant (memorySync.ts) is that `.atlas/memory.jsonl` is
 * KNOWLEDGE-ONLY: code_file / code_symbol / code_context / code_folder /
 * code_import are DELIBERATELY excluded — they're regenerable from source,
 * huge, and would bloat the git-friendly moat. That invariant is preserved
 * BY CONSTRUCTION here: this module is a PHYSICALLY SEPARATE artifact
 * (`.atlas/code-graph.jsonl`) written by a SEPARATE command
 * (`atlas code-graph export`). There is NO code path by which `memory export`
 * emits a code node, and no `--include-code` flag that could let a code node
 * leak into the moat.
 *
 * G-3 — WHY this exists. Groups (G-1/G-2) co-load every member's KNOWLEDGE
 * into one store so cross-seam knowledge edges resolve, but code graphs are
 * never co-resident → there is no cross-repo CODE traversal. This artifact is
 * the missing half: a member can OPT IN to shipping its code graph alongside
 * its moat, and `loadGroup` co-loads those graphs + authors a module-level
 * bridge (`code-import:<pkg>` → member-B's root folder) so a subgraph BFS in
 * repo A can cross into repo B.
 *
 * FORMAT — reuses the moat's v2 grammar VERBATIM (memorySync.ts MemoryHeader /
 * NodeLine / EdgeLine), only the type set differs:
 *   header: {"version":2,"exportedAt":…,"sourceWorkspace":…,"exportedTypes":[5 code types]}
 *   nodes:  one {"kind":"node",…} per code node. Only code_context /
 *           code-context-sym: carry an `embedding` (the only embed:true code
 *           nodes — codeNodes.ts); the graph-only types ship vector-less.
 *   edges:  the structural code edges (contains / calls / imports / extends /
 *           describes …) whose SOURCE is a local code node.
 *
 * The A0 precomputed-vector fast path is reused as-is: a code-graph file is
 * NOT "every node carries an embedding" (the graph-only types are embed:false),
 * so ingestPendingNodes takes the legacy serial storeNode path — which re-
 * applies embed:false per node (NO re-embed cost; there is nothing to embed).
 * The code_context subset that DOES carry a vector still round-trips its
 * vector through the v2 node line, so a teammate's group-load doesn't re-embed
 * the semantic cards.
 *
 * SIZE / GIT: `.atlas/code-graph.jsonl` is large (the regenerable code graph +
 * context vectors) → it ships GITIGNORED by default; committing it is an
 * explicit opt-in. The moat stays small + diff-friendly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryExportReader, ExportResult } from './memorySync.js';
import { MEMORY_SCHEMA_VERSION } from './memorySync.js';
import { tagsToString } from '../tags.js';

/**
 * The 5 code-graph node types. The MIRROR of memorySync.KNOWLEDGE_TYPES — the
 * two sets are disjoint and together partition every Atlas-written node type.
 * Exported so loadGroup can pass this as `allowedTypes` when ingesting a
 * code-graph file (the moat-import guard otherwise rejects code types).
 */
export const CODE_TYPES = [
    'code_file',
    'code_symbol',
    'code_context',
    'code_folder',
    'code_import',
] as const;
export type CodeType = typeof CODE_TYPES[number];

/** Set form for O(1) membership checks (the allowedTypes gate in loadGroup). */
export const CODE_TYPE_SET: ReadonlySet<string> = new Set(CODE_TYPES);

/** The code types that are NEVER embedded (embed:false at index time —
 *  graph traversal only, see store/codeNodes.ts). Everything else
 *  (knowledge types + code_context) carries a vector. Group co-load uses
 *  this to avoid re-embedding thousands of graph-only nodes on import. */
export const GRAPH_ONLY_CODE_TYPES: ReadonlySet<string> = new Set(
    CODE_TYPES.filter((t) => t !== 'code_context'),
);

/**
 * RD-codegraph-oom — per-type cap on the code-graph export pull. Was fully
 * unbounded (EmbeddedLore.listNodes' materialize-everything path), so exporting
 * a very large monorepo's code graph could OOM the (CLI) export process, the
 * same class as the workspace_status / fullGraph crashes. A code-graph export
 * ideally wants ALL nodes, so this is generous — realistic repos (even v3's
 * ~12.4k code_symbol) fit well under it; only a pathological monorepo truncates,
 * and it's warned loudly rather than silently crashing. Bounds peak memory to
 * ~cap nodes per type.
 */
export const CODE_GRAPH_EXPORT_CAP = 50_000;

/** Default per-member code-graph artifact path, relative to the checkout root.
 *  Mirrors groups.MEMBER_MEMORY_RELPATH; lives beside the moat but is a
 *  separate file (and gitignored by default). */
export const MEMBER_CODEGRAPH_RELPATH = path.join('.atlas', 'code-graph.jsonl');

/** A code-graph node line. Same grammar as memorySync.NodeLine but typed to a
 *  CodeType. embedding present ONLY for code_context / code-context-sym nodes. */
interface CodeNodeLine {
    kind: 'node';
    id: string;
    type: CodeType;
    label?: string;
    content?: string;
    tags?: string;
    metadata?: unknown;
    embedding?: number[];
}

/** A code-graph edge line. Identical to memorySync.EdgeLine. */
interface CodeEdgeLine {
    kind: 'edge';
    sourceId: string;
    targetId: string;
    relation: string;
}

interface CodeGraphHeader {
    version: 1 | 2;
    exportedAt: string;
    sourceWorkspace: string;
    exportedTypes: readonly string[];
}

/**
 * Walk the embedded Lore's CODE nodes + edges and write a v2 JSONL artifact at
 * `outPath` (`.atlas/code-graph.jsonl`). Structurally identical to
 * memorySync.exportMemory EXCEPT:
 *
 *   1. Iterates CODE_TYPES instead of KNOWLEDGE_TYPES.
 *   2. The edge filter is INVERTED: keep an edge when its SOURCE is a local
 *      CODE node (build `codeIds`, not `knowledgeIds`). This keeps the
 *      structural code-graph edges (file→symbol contains, symbol→symbol
 *      calls/imports/extends, folder→file/subfolder contains, file→import
 *      imports, context→file/symbol describes) and drops any edge that
 *      "belongs" to another node set.
 *   3. The v2 vector bundling is reused EXACTLY: awaitEmbeds() then
 *      getEmbeddings(Array.from(codeIds)). Only code_context ids resolve a
 *      vector; the graph-only types are absent → no `embedding` field, which
 *      is correct (they re-"embed" to nothing on import).
 *
 * Atomic via temp+rename so a crash mid-write can't leave a half-file behind.
 *
 * NOTE: this NEVER touches `.atlas/memory.jsonl`. The moat invariant holds by
 * construction — a code node has no path into the knowledge export.
 */
export async function exportCodeGraph(
    client: MemoryExportReader,
    sourceWorkspace: string,
    outPath: string,
): Promise<ExportResult> {
    const absOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });

    // Collect code nodes per type. Same listNodes(type, _, workspace) scoping
    // as the moat export — EmbeddedLore.listNodes is unbounded, so the whole
    // code graph is enumerated.
    const codeIds = new Set<string>();
    const nodeLines: CodeNodeLine[] = [];
    for (const type of CODE_TYPES) {
        // Bounded pull (RD-codegraph-oom) — cap+1 so a type that overflows is
        // detected and warned; without this the export could OOM on a huge repo.
        const rows = await client.listNodes(type, undefined, sourceWorkspace, CODE_GRAPH_EXPORT_CAP + 1);
        if (rows.length > CODE_GRAPH_EXPORT_CAP) {
            console.error(
                `[atlas] WARNING: code-graph export truncated '${type}' at ${CODE_GRAPH_EXPORT_CAP} nodes ` +
                `(workspace has more). The exported artifact is INCOMPLETE for this type.`,
            );
        }
        for (const raw of rows.slice(0, CODE_GRAPH_EXPORT_CAP)) {
            const n = raw as Record<string, unknown>;
            const id = typeof n['id'] === 'string' ? n['id'] : undefined;
            if (!id) continue;
            codeIds.add(id);
            const line: CodeNodeLine = { kind: 'node', id, type };
            if (typeof n['label'] === 'string') line.label = n['label'];
            if (typeof n['content'] === 'string') line.content = n['content'];
            // Lore Tags Pass 3 returns string[]; normalize to the comma-string
            // export format (the old typeof-string guard dropped array tags).
            const tagStr = tagsToString(n['tags'] as string | string[] | undefined);
            if (tagStr) line.tags = tagStr;
            if (n['metadata'] !== undefined) line.metadata = n['metadata'];
            nodeLines.push(line);
        }
    }

    // Edge policy (INVERTED vs the moat): keep an edge when its SOURCE is a
    // local CODE node. This is the mirror of exportMemory's knowledgeIds gate —
    // it keeps exactly the structural code-graph edges and excludes any edge
    // whose source lives outside the code-node set (e.g. a knowledge→code
    // describe authored elsewhere). Targets need NOT be local: a file→import
    // edge's target `code-import:<module>` is a shared, repo-UNqualified node
    // that resolves at group-load when the importer is co-loaded.
    const allEdges = await client.listEdges();
    const edgeLines: CodeEdgeLine[] = [];
    for (const e of allEdges) {
        if (!codeIds.has(e.sourceId)) continue;
        edgeLines.push({ kind: 'edge', sourceId: e.sourceId, targetId: e.targetId, relation: e.relation });
    }

    // A0 — bundle vectors EXACTLY as the moat export does. Settle first so the
    // background outbox has flushed code_context embeds into LanceDB before the
    // read (otherwise an empty map → a needless v1 header). Only code_context /
    // code-context-sym ids resolve a vector; the graph-only types are absent.
    if (client.awaitEmbeds) {
        try { await client.awaitEmbeds(); } catch { /* degrade to current state */ }
    }
    const vectorMap: Map<string, number[]> = client.getEmbeddings
        ? await client.getEmbeddings(Array.from(codeIds))
        : new Map<string, number[]>();
    const haveAnyVectors = vectorMap.size > 0;
    const schemaVersion: CodeGraphHeader['version'] = haveAnyVectors ? MEMORY_SCHEMA_VERSION : 1;
    if (haveAnyVectors) {
        for (const line of nodeLines) {
            // GATE ON TYPE, not just on whether the store happens to answer —
            // GRAPH_ONLY_CODE_TYPES (code_file/code_symbol/code_folder/code_import)
            // are written embed:false and must never carry a vector in the
            // exported artifact (group co-load skips re-embedding them on that
            // exact assumption). Previously this loop trusted getEmbeddings() to
            // simply have nothing for those ids; a stray vector row for a
            // graph-only id (observed: a single-file repo's code_file, most
            // likely a leftover from the embedding pipeline's own autolink/
            // similarity bookkeeping around the code_context card that
            // `describes` it) silently rode along into the artifact. Enforcing
            // the type gate here makes the "graph-only types never carry a
            // vector" invariant hold structurally, not by convention.
            if (GRAPH_ONLY_CODE_TYPES.has(line.type)) continue;
            const vec = vectorMap.get(line.id);
            if (vec && vec.length > 0) line.embedding = vec;
        }
    }

    const header: CodeGraphHeader = {
        version: schemaVersion,
        exportedAt: new Date().toISOString(),
        sourceWorkspace,
        exportedTypes: CODE_TYPES,
    };

    const lines: string[] = [];
    lines.push(JSON.stringify(header));
    for (const n of nodeLines) lines.push(JSON.stringify(n));
    for (const e of edgeLines) lines.push(JSON.stringify(e));
    const body = lines.join('\n') + '\n';
    const bytes = Buffer.byteLength(body, 'utf8');

    const tmp = absOut + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, absOut);

    return { path: absOut, nodeCount: nodeLines.length, edgeCount: edgeLines.length, bytes };
}

/**
 * G-3 — read a member's package.json `name` field. The bridge match key:
 * `code-import:<module>` is repo-UNqualified, so a node named after member-B's
 * package name resolves to member-B's repo. Best-effort — returns undefined
 * when there's no package.json / no name / a parse error (the bridge simply
 * doesn't fire for that member, which degrades to today's knowledge-only group).
 */
export function readPackageName(checkoutRoot: string): string | undefined {
    try {
        const pkgPath = path.join(checkoutRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) return undefined;
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
        return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    } catch {
        return undefined;
    }
}
