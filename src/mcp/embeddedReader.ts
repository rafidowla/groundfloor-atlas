/**
 * mcp/embeddedReader.ts — in-process implementation of LoreContextReader.
 *
 * The embedded counterpart of LoreReader: instead of HTTP-enumerating symbol
 * nodes + walking per-node neighbors, it reads ALL code_symbol nodes and ALL
 * directed edges straight from the dedicated in-process Lore (kuzu), then runs
 * the shared assembleCodeContext() so the 6 code-intelligence tools get an
 * identical { table, relations }.
 *
 * Reads go through the shared per-workspace instance (embeddedRegistry), so a
 * read tool and a write (atlas_index) in the same daemon use ONE kuzu handle.
 */
import * as fs from 'node:fs';
import { loadConfig } from '../config.js';
import { assembleCodeContext, type CodeSymbolNode, type LoreContextReader, type WorkspaceIndexState } from './codeContext.js';
import { borrowEmbeddedLore, embeddedDataDir } from './embeddedRegistry.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import type { ParsedRelation } from '../parser/types.js';

type AtlasConfig = ReturnType<typeof loadConfig>;

interface RawSymbolNode {
    id: string;
    content?: string | null;
    metadata?: string | null;
}

/** Parse a positive-integer env var, falling back to `fallback` when unset,
 *  empty, non-numeric, zero, or negative — never lets a malformed env value
 *  collapse the cap to 0 (which would silently return zero nodes). Exported
 *  for the single-file incremental index path (mcp/tools/index.ts), which
 *  bounds its persisted-graph peer read with the SAME env knob. */
export function positiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** RC reconciliation — node-read cap for the code-intelligence read path.
 *  Matches the communities/processes ceiling (MAX_COMMUNITY_NODES = 50_000):
 *  high enough that no real repo is clipped (Atlas's own dogfood is ~5.8k
 *  code_symbol nodes) while still bounding the OOM cliff an unbounded
 *  listNodes() exposes against a pathological workspace. Configurable via
 *  ATLAS_MAX_CONTEXT_NODES for operators who genuinely need more. */
export const DEFAULT_MAX_CONTEXT_NODES = 50_000;

export class EmbeddedLoreReader implements LoreContextReader {
    constructor(private readonly cfg: AtlasConfig) {}

    async loadContext(workspace: string): Promise<{
        table: SymbolTable;
        relations: ParsedRelation[];
        truncated?: { nodes: number; nodeLimit: number };
    }> {
        // RC #4 — borrow the shared instance so LRU eviction can't close its
        // native handles mid-read (which crashes the process). Released in the
        // finally once both listNodes + listEdges have returned.
        const { lore, release } = await borrowEmbeddedLore(this.cfg, workspace);
        try {
        // X7 reconciliation — this is the SINGLE read path for the 6
        // code-intelligence tools (call_graph / find_dead_code / blast_radius /
        // hotspots / ...). listNodes() takes an UNBOUNDED path whenever no
        // explicit limit is passed (see embeddedLore.ts listNodes: `limit ?
        // undefined : { unbounded: true }`) — there is no implicit 10k cap here,
        // despite what an earlier comment on this line claimed. An unbounded
        // read against a pathological workspace can OOM the daemon. We now pass
        // an explicit, generous node cap (default 50_000 — see
        // DEFAULT_MAX_CONTEXT_NODES) so listNodes clamps instead of running
        // unbounded, and surface an HONEST `truncated` flag when the returned
        // count hits that cap so a caller can tell "this is the whole graph"
        // from "this is a clipped prefix" instead of silently trusting a
        // possibly-partial symbol table.
        const nodeLimit = positiveIntEnv('ATLAS_MAX_CONTEXT_NODES', DEFAULT_MAX_CONTEXT_NODES);
        const rawNodes = (await lore.listNodes('code_symbol', undefined, workspace, nodeLimit)) as RawSymbolNode[];
        // Edges are NEVER sliced. A blind edge-prefix cap is correctness-unsafe:
        // listEdges() returns edges in the backend's paginated (offset) order,
        // NOT grouped by target, so discarding the tail can drop a symbol's ONLY
        // inbound calls/imports edge and turn a referenced symbol into a FALSE
        // dead-code positive (deadCode counts inbound purely from the relations
        // array). This was the X7 bug main deliberately fixed by removing the
        // old context caps — do NOT reintroduce an edge slice here. Keep the
        // full edge set and rely on listEdges()'s own MAX_PAGES guard (now also
        // cached per-workspace — see embeddedLore.ts listEdges) for the memory
        // bound instead of a silently-wrong global slice.
        const edges = await lore.listEdges();

        const symbolNodes: CodeSymbolNode[] = rawNodes.map((n) => ({
            id: n.id,
            content: n.content ?? null,
            metadata: n.metadata ?? null,
        }));
        const assembled = assembleCodeContext(symbolNodes, edges);
        if (rawNodes.length >= nodeLimit) {
            return { ...assembled, truncated: { nodes: rawNodes.length, nodeLimit } };
        }
        return assembled;
        } finally {
            release();
        }
    }

    /**
     * RC-F4 — report whether this workspace has ever been indexed, so a read
     * tool can tell a typo'd/unknown workspace ('unknown') from a genuinely
     * empty one ('empty'). The embedded store lives at a per-workspace dataDir
     * (embeddedRegistry.embeddedDataDir); if that directory does not exist the
     * workspace was never opened/indexed. An INVALID workspace name (rejected by
     * embeddedDataDir) is likewise 'unknown'. When the dir exists we count
     * code_symbol nodes cheaply to split 'empty' from 'indexed'.
     */
    async workspaceState(workspace: string): Promise<WorkspaceIndexState> {
        let dir: string;
        try {
            dir = embeddedDataDir(this.cfg, workspace);
        } catch {
            // Invalid workspace name — definitively not a real indexed workspace.
            return 'unknown';
        }
        if (!fs.existsSync(dir)) return 'unknown';
        // Dir exists — open it and count code symbols. Borrow so eviction can't
        // close the handle mid-count.
        const { lore, release } = await borrowEmbeddedLore(this.cfg, workspace);
        try {
            const nodes = (await lore.listNodes('code_symbol', undefined, workspace)) as unknown[];
            return nodes.length > 0 ? 'indexed' : 'empty';
        } finally {
            release();
        }
    }
}
