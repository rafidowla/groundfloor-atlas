/**
 * communities/detect.ts — Louvain community detection.
 *
 * Pure, deterministic clustering. Given a node list and an edge list,
 * groups nodes into communities by greedily maximizing modularity via
 * the Louvain method. This replaced the previous in-house
 * label-propagation pass: Louvain optimizes a principled global
 * objective (modularity) instead of a purely local majority vote, so
 * it produces tighter, more stable module boundaries — and it handles
 * disconnected components gracefully (each component clusters on its
 * own without leaking labels across the gap).
 *
 * Algorithm: Louvain (NOT Leiden). Backed by the official graphology
 * organization package:
 *   https://www.npmjs.com/package/graphology-communities-louvain
 *
 * Treats the graph as UNDIRECTED for clustering — a "neighborhood"
 * is a symmetric notion ("these files belong together"), and using
 * the directed call/import direction would split mutually-referencing
 * pairs into two singleton communities.
 *
 * Determinism: Louvain's local-move phase can traverse the graph in a
 * randomized order. We make every run reproducible by (a) passing a
 * seeded xorshift32 `rng` (the lib uses it wherever it would otherwise
 * call `Math.random`) and (b) setting `randomWalk: false` so traversal
 * follows a fixed order. Same seed + same input => identical labels.
 */

import GraphImport from 'graphology';
import louvainImport from 'graphology-communities-louvain';

// graphology and graphology-communities-louvain ship ESM-style
// `export default` .d.ts files over a bare CommonJS `module.exports =`
// runtime. Under module:Node16 the default import binds to the namespace
// object, which TypeScript sees as non-constructable / non-callable
// ("This expression is not constructable/callable"). The real
// constructor / callable lives on `.default` of that namespace at the
// type level — esModuleInterop's __importDefault unwraps it at runtime —
// so we re-cast each binding to the shape the runtime actually provides.
const Graph = GraphImport as unknown as typeof import('graphology').default;
const louvain =
    louvainImport as unknown as typeof import('graphology-communities-louvain').default;

export interface CommunityInput {
    nodeIds: string[];
    edges: Array<{ source: string; target: string }>;
}

export interface CommunityOutput {
    /** nodeId → dense community id (0..N-1). */
    membership: Map<string, number>;
    /** All distinct community ids produced (already dense, 0..N-1). */
    communityIds: number[];
}

interface DetectOpts {
    /** Resolution parameter for Louvain modularity. Higher values yield
     *  MORE, smaller communities; lower values yield fewer, larger ones.
     *  Default 1.0 (standard modularity). */
    resolution?: number;
    /** @deprecated Carried over from the old label-propagation impl for
     *  back-compat. Louvain does not expose an iteration cap, so this
     *  field is accepted but IGNORED. Safe to omit. */
    maxIters?: number;
    /** Seed for the xorshift RNG plumbed into Louvain as its `rng`.
     *  Same seed + same input = same output. Default 1. */
    seed?: number;
}

/**
 * Tiny seedable RNG. xorshift32 is dirt-cheap and deterministic — we
 * don't need cryptographic quality, just a stable stream of [0,1)
 * values to hand to Louvain in place of Math.random. Math.random would
 * make the output non-reproducible (annoying for tests + for users
 * diffing community labels).
 */
function makeRng(seed: number): () => number {
    // xorshift32 cannot accept 0 — fall back to a nonzero default.
    let state = (seed >>> 0) || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        // Convert to [0, 1) like Math.random().
        return (state >>> 0) / 0x100000000;
    };
}

export function detectCommunities(
    input: CommunityInput,
    opts: DetectOpts = {},
): CommunityOutput {
    // `maxIters` is intentionally destructured-and-ignored for back-compat;
    // Louvain has no iteration cap. See DetectOpts JSDoc.
    const { resolution = 1.0, seed = 1 } = opts;
    const { nodeIds, edges } = input;

    // Build an UNDIRECTED graphology graph. We add every node first so
    // isolated/singleton nodes survive into the result (Louvain assigns
    // each its own community), then add edges, deduping defensively.
    const graph = new Graph({ type: 'undirected', multi: false });
    for (const id of nodeIds) {
        if (!graph.hasNode(id)) graph.addNode(id);
    }

    for (const e of edges) {
        // Skip edges that reference nodes outside the provided node set.
        if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
        if (e.source === e.target) continue; // skip self-loops
        // Skip duplicate edges (either direction — graph is undirected).
        if (graph.hasUndirectedEdge(e.source, e.target)) continue;
        graph.addUndirectedEdge(e.source, e.target);
    }

    // Empty graph: nothing to cluster. (louvain throws on a 0-node graph.)
    if (graph.order === 0) {
        return { membership: new Map<string, number>(), communityIds: [] };
    }

    // Run Louvain. We pass a seeded rng and disable randomWalk so the
    // traversal order is fixed — together these make the result fully
    // deterministic for a given seed + input. Returns { nodeId: rawId }.
    const assignment = louvain(graph, {
        resolution,
        randomWalk: false,
        rng: makeRng(seed),
    });

    // Renumber densely so communityIds are 0..N-1 (downstream consumers
    // that index arrays by community id otherwise blow up with sparse gaps).
    // We iterate nodeIds in input order so dense ids are stable/reproducible.
    const remap = new Map<number, number>();
    const membership = new Map<string, number>();
    let nextDense = 0;
    for (const id of nodeIds) {
        const raw = assignment[id]!;
        let dense = remap.get(raw);
        if (dense === undefined) {
            dense = nextDense++;
            remap.set(raw, dense);
        }
        membership.set(id, dense);
    }

    const communityIds: number[] = [];
    for (let i = 0; i < nextDense; i++) communityIds.push(i);

    return { membership, communityIds };
}
