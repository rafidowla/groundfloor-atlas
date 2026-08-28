/**
 * mcp/statsSnapshot.ts — the per-workspace KPI snapshot (`stats.json`).
 *
 * WHY THIS EXISTS: the workspaces LIST page wants per-workspace KPIs (node/edge
 * counts, type breakdown, project list, last-indexed time) for EVERY workspace
 * at once. Computing those live means opening each workspace's Kuzu store — but
 * the embeddedRegistry rations open stores behind a MAX_OPEN LRU precisely
 * because each open holds kuzu+lancedb+sqlite handles. A list endpoint that
 * opened one store per workspace would thrash that LRU (and, on a real-sized
 * store, risk the OOM that RD-status-oom fixed for a SINGLE workspace).
 *
 * So we snapshot the KPIs to `<workspaceDataDir>/stats.json` at the moments we
 * ALREADY have the store open and its counts computed — at the end of a full
 * `atlas_index`, and lazily on `workspace_status`. The list endpoint then reads
 * KPIs as a pure `fs` read and NEVER opens a store.
 *
 * The snapshot travels with the workspace dir: `workspace_rename` moves the dir
 * (stats.json rides along), `workspace_delete` removes the dir (stats.json goes
 * with it). Nothing here needs to special-case either.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** On-disk snapshot schema. `version` gates forward-compatible reads. */
export interface StatsSnapshot {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
    /** DISTINCT node.project values in the store (the indexed project names). */
    projects: string[];
    /** ISO timestamp of the run that wrote this snapshot. */
    indexedAt: string;
}

/** The GraphStats shape getStats returns (node/edge counts + type breakdown). */
interface GraphStatsLike {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
}

/** The minimal EmbeddedLore surface a snapshot needs: getStats + distinctProjects. */
interface StatsSource {
    getStats(projectFilter?: string): Promise<GraphStatsLike>;
    distinctProjects(): Promise<string[]>;
}

/** Absolute path of a workspace's stats snapshot. `dataDir` is the workspace dir
 *  (embeddedDataDir), NOT the inner `.lore/`. */
export function statsSnapshotPath(dataDir: string): string {
    return path.join(dataDir, 'stats.json');
}

/**
 * Kuzu graph file whose mtime is the honest "last indexed" fallback when no
 * snapshot exists. Lore stores the graph at `<dataDir>/.lore/graph` — a real
 * file that is only rewritten on a checkpoint/index, NOT on a mere open. Its
 * `.wal`/`.shm` siblings DO move on every open (a read touches the WAL), so we
 * deliberately stat `graph` itself, never `graph.wal`.
 *
 * STALE as of the vendored Lore 3.16.0 bump (Kùzu fully removed there,
 * 2026-08-21): `.lore/graph` never exists on any workspace anymore, since
 * every workspace is SurrealDB-backed and stores at `.lore/surreal/` (a
 * directory: manifest/, sstables/, vlog/, wal/ — not a single file, so there's
 * no drop-in mtime-file equivalent). `buildWorkspaceStatsEntry`'s
 * `fs.existsSync` guard means this degrades safely — the fallback
 * `lastIndexed` just stays `null` when no stats.json snapshot exists — not a
 * crash, just a lost signal in that one rare case. Left as-is rather than
 * guessing at a SurrealDB/surrealkv-internal file to stat instead; revisit
 * with real knowledge of surrealkv's checkpoint semantics before picking one.
 */
export function kuzuGraphFile(dataDir: string): string {
    return path.join(dataDir, '.lore', 'graph');
}

/**
 * Compute + write `<dataDir>/stats.json` from an OPEN lore instance. Callers
 * already hold the store open with its counts in hand (atlas_index at run end,
 * workspace_status), so this is a cheap getStats (count()) + one DISTINCT query
 * + an fs write — it never opens a store itself.
 *
 * Best-effort by contract: `atlas_index` must not fail a successful index just
 * because the snapshot write hiccuped, so callers can swallow a throw. Returns
 * the snapshot it wrote so a caller (workspace_status) can reuse it.
 */
export async function writeStatsSnapshot(lore: StatsSource, dataDir: string): Promise<StatsSnapshot> {
    // UNFILTERED getStats: each workspace has its own store, so its node.project
    // is the INDEXED project name, not the workspace name — filtering by the
    // workspace name would wrongly zero out counts (see workspace_status bug).
    const stats = await lore.getStats();
    const projects = await lore.distinctProjects();
    const snapshot: StatsSnapshot = {
        version: 1,
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        typeBreakdown: stats.typeBreakdown,
        projects,
        indexedAt: new Date().toISOString(),
    };
    // Atomic-ish write: temp + rename so a concurrent list read never sees a
    // half-written file. Same dir → rename is atomic on the same filesystem.
    const target = statsSnapshotPath(dataDir);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, target);
    return snapshot;
}

/** Parsed snapshot if present + well-formed, else null. Never throws. */
export function readStatsSnapshot(dataDir: string): StatsSnapshot | null {
    const file = statsSnapshotPath(dataDir);
    try {
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const s = parsed as Partial<StatsSnapshot>;
        if (s.version !== 1 || typeof s.nodeCount !== 'number' || typeof s.edgeCount !== 'number') return null;
        return {
            version: 1,
            nodeCount: s.nodeCount,
            edgeCount: s.edgeCount,
            typeBreakdown: s.typeBreakdown ?? {},
            projects: Array.isArray(s.projects) ? s.projects : [],
            indexedAt: typeof s.indexedAt === 'string' ? s.indexedAt : '',
        };
    } catch {
        return null;
    }
}

/** One workspace's list entry when `includeStats` is requested. */
export interface WorkspaceStatsEntry {
    name: string;
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
    projects: string[];
    projectCount: number;
    /** ISO timestamp: snapshot's indexedAt, or the kuzu graph file's mtime. */
    lastIndexed: string | null;
    statsSource: 'snapshot' | 'none';
}

/**
 * Build a workspace's stats entry as a PURE fs read — reads stats.json if
 * present, else falls back to the kuzu graph-file mtime for `lastIndexed` and
 * zeroed counts. NEVER opens a Kuzu store (that is what the MAX_OPEN LRU
 * rations). `dataDir` is the workspace dir; `name` is the workspace name.
 */
export function buildWorkspaceStatsEntry(name: string, dataDir: string): WorkspaceStatsEntry {
    const snap = readStatsSnapshot(dataDir);
    if (snap) {
        return {
            name,
            nodeCount: snap.nodeCount,
            edgeCount: snap.edgeCount,
            typeBreakdown: snap.typeBreakdown,
            projects: snap.projects,
            projectCount: snap.projects.length,
            lastIndexed: snap.indexedAt || null,
            statsSource: 'snapshot',
        };
    }
    // No snapshot: fall back to the kuzu graph file's mtime (the last real
    // index/checkpoint), never the .wal/.shm (those move on mere opens).
    let lastIndexed: string | null = null;
    try {
        const graph = kuzuGraphFile(dataDir);
        if (fs.existsSync(graph)) lastIndexed = fs.statSync(graph).mtime.toISOString();
    } catch {
        lastIndexed = null;
    }
    return {
        name,
        nodeCount: 0,
        edgeCount: 0,
        typeBreakdown: {},
        projects: [],
        projectCount: 0,
        lastIndexed,
        statsSource: 'none',
    };
}
