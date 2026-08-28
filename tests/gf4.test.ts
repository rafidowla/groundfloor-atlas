/**
 * tests/gf4.test.ts — GF-4 (stable community ids) in-process unit tests.
 * No daemon, no Lore server: communities + subgraph run as pure functions
 * over a hand-rolled, duck-typed CommunityReader / SubgraphReader fake.
 *
 * The GF-4 fix replaces the POSITIONAL Louvain dense int (which reshuffled on
 * every re-index — same module, different id) with a CONTENT-STABLE string id
 * derived from membership: `slug(label)~slugBasename(smallestMemberPath)`, with
 * a membership-hash tie-break only on genuine collision. These tests pin the
 * acceptance criteria from the GF-4 design:
 *
 *   T1 (re-index stability): the SAME indexed graph, run through community
 *       detection TWICE, yields BYTE-IDENTICAL ids. (Determinism for identical
 *       input — the core regression guard.)
 *   T2 (small-churn stability): adding one unrelated file does NOT change an
 *       unaffected module's id. (Under the old positional scheme any added file
 *       could reshuffle every id; that is eliminated.)
 *   T3 (collision + fallback): two modules whose dominant-dir LAST segment
 *       collides ("utils"/"utils") still get DISTINCT ids via their different
 *       smallest-path anchors; a community with no prefix and no symbols falls
 *       back to `community~<anchor>` (no embedded dense int).
 *   T4 (subgraph seeding): buildSubgraph({ community: <stableId> }) seeds the
 *       BFS from exactly that community's member files.
 *
 * Run: tsx tests/gf4.test.ts
 */

import * as assert from 'node:assert/strict';

import { listCommunities, listCommunityMembership, communityStableId } from '../src/communities/index.js';
import { buildSubgraph } from '../src/graph/subgraph.js';

const WS = 'gf4-test-ws';

/* ─── fakes ───────────────────────────────────────────────────────── */

interface FakeNode { id: string; type: string; label: string; metadata: string }
interface FakeEdge { sourceId: string; targetId: string; relation: string }

function fileNode(path: string): FakeNode {
    return {
        id: `code-file:${path}`,
        type: 'code_file',
        label: path,
        metadata: JSON.stringify({ path }),
    };
}

/** A reader satisfying BOTH CommunityReader and SubgraphReader over in-memory
 *  node/edge arrays (listNodes filters by type; getNode does a linear lookup). */
function makeReader(nodes: FakeNode[], edges: FakeEdge[]) {
    return {
        async listNodes(type?: string): Promise<unknown[]> {
            return type ? nodes.filter((n) => n.type === type) : nodes;
        },
        async listEdges(): Promise<FakeEdge[]> {
            return edges;
        },
        async getNode(id: string): Promise<unknown> {
            return nodes.find((n) => n.id === id) ?? null;
        },
    };
}

/** Couple every pair of files in `paths` with an `imports` edge so they land in
 *  ONE community (the file-coupling projection keeps `imports`). */
function clique(paths: string[]): FakeEdge[] {
    const out: FakeEdge[] = [];
    for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
            out.push({ sourceId: `code-file:${paths[i]}`, targetId: `code-file:${paths[j]}`, relation: 'imports' });
        }
    }
    return out;
}

/* ─── T1 + T2: re-index + small-churn stability ───────────────────── */

// Two clearly-separated modules: a `locale` clique and a `parser` clique, with
// NO edge between them → two communities, each labeled by its dominant dir.
const LOCALE = ['src/locale/format.ts', 'src/locale/parse.ts', 'src/locale/index.ts'];
const PARSER = ['src/parser/ast.ts', 'src/parser/lexer.ts', 'src/parser/token.ts'];

function baseGraph(): { nodes: FakeNode[]; edges: FakeEdge[] } {
    const nodes = [...LOCALE, ...PARSER].map(fileNode);
    const edges = [...clique(LOCALE), ...clique(PARSER)];
    return { nodes, edges };
}

/** id → sorted member-path basenames, for a membership map (keyed by stable id). */
async function idToPaths(reader: ReturnType<typeof makeReader>): Promise<Map<string, string[]>> {
    const membership = await listCommunityMembership(reader, WS);
    const out = new Map<string, string[]>();
    for (const [id, fileIds] of membership) {
        out.set(id, [...fileIds].map((f) => f.replace(/^code-file:/, '')).sort());
    }
    return out;
}

async function testReindexStability(): Promise<void> {
    const { nodes, edges } = baseGraph();

    // Two independent reads over the SAME graph (== two re-index passes that
    // produced identical membership) must yield identical id → members maps.
    const run1 = await idToPaths(makeReader(nodes, edges));
    const run2 = await idToPaths(makeReader(nodes, edges));

    const norm = (m: Map<string, string[]>) =>
        JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
    assert.equal(norm(run1), norm(run2), 'T1 community id → members map is byte-identical across re-detect');

    // The ids are the expected content-stable strings (label slug + anchor),
    // not dense ints. locale anchored at format.ts (smallest path), parser at ast.ts.
    const ids = [...run1.keys()].sort();
    assert.deepEqual(ids, ['locale~format', 'parser~ast'], `T1 stable ids are label~anchor (got ${JSON.stringify(ids)})`);

    console.log('  ✓ T1: re-index identical graph → byte-identical content-stable ids (locale~format, parser~ast)');
}

async function testSmallChurnStability(): Promise<void> {
    const g0 = baseGraph();
    const before = await idToPaths(makeReader(g0.nodes, g0.edges));

    // Add ONE unrelated file to the PARSER module (a new clique member). The
    // LOCALE community is untouched: same members, same smallest-path anchor.
    const churnPaths = [...PARSER, 'src/parser/visitor.ts'];
    const nodes = [...LOCALE, ...churnPaths].map(fileNode);
    const edges = [...clique(LOCALE), ...clique(churnPaths)];
    const after = await idToPaths(makeReader(nodes, edges));

    // The locale community's id is UNCHANGED — its membership + anchor (format.ts)
    // didn't move, so its content-derived id is identical.
    assert.ok(after.has('locale~format'), 'T2 locale community keeps its id after unrelated churn');
    assert.deepEqual(
        before.get('locale~format'),
        after.get('locale~format'),
        'T2 locale members unchanged',
    );
    // Sanity: the parser community grew but is still anchored at ast.ts (still
    // the smallest path), so its id is also stable here.
    assert.ok(after.has('parser~ast'), 'T2 parser community still anchored at ast.ts');
    assert.ok(after.get('parser~ast')!.includes('src/parser/visitor.ts'), 'T2 new file joined the parser community');

    console.log('  ✓ T2: add one unrelated file → unaffected (locale) community keeps its exact id');
}

/* ─── T3: collision + fallback ────────────────────────────────────── */

async function testCollisionAndFallback(): Promise<void> {
    // (a) Two distinct modules whose dominant-dir LAST segment is identical
    //     ("utils"), in different trees → SAME label "utils", DIFFERENT anchors.
    const utilsA = ['pkg/a/utils/str.ts', 'pkg/a/utils/num.ts'];
    const utilsB = ['pkg/b/utils/date.ts', 'pkg/b/utils/uuid.ts'];
    const nodes = [...utilsA, ...utilsB].map(fileNode);
    const edges = [...clique(utilsA), ...clique(utilsB)];

    const map = await idToPaths(makeReader(nodes, edges));
    const ids = [...map.keys()].sort();
    assert.equal(ids.length, 2, 'T3a two distinct utils communities');
    // Both slug to base "utils" but disambiguate on their smallest-path anchor:
    //   utilsA smallest = pkg/a/utils/num.ts → num ; utilsB = pkg/b/utils/date.ts → date.
    assert.deepEqual(ids, ['utils~date', 'utils~num'], `T3a same label, distinct anchors (got ${JSON.stringify(ids)})`);

    // (b) Fallback: a community with NO common dir prefix and NO symbols → the
    //     label heuristic returns `community-<denseInt>`; the id derivation MUST
    //     strip that unstable int and use `community~<anchor>`.
    const scattered = ['zeta.ts', 'alpha.ts']; // root-level, no shared dir, no symbols
    const fbNodes = scattered.map(fileNode);
    const fbEdges = clique(scattered);
    const fbMap = await idToPaths(makeReader(fbNodes, fbEdges));
    const fbIds = [...fbMap.keys()];
    assert.equal(fbIds.length, 1, 'T3b one fallback community');
    // smallest path = alpha.ts → anchor "alpha"; base falls back to "community".
    assert.equal(fbIds[0], 'community~alpha', `T3b fallback id is community~<anchor>, not community-<int> (got ${fbIds[0]})`);
    assert.ok(!/community-\d+/.test(fbIds[0]!), 'T3b fallback id does NOT embed the unstable dense int');

    // (c) communityStableId unit contract: it is a pure function of label +
    //     sorted members (drops the community-<int> label, slugs the rest).
    assert.equal(communityStableId('locale', ['src/locale/format.ts', 'src/locale/zzz.ts']), 'locale~format');
    assert.equal(communityStableId('NodeView', ['ui/NodeView.tsx']), 'nodeview~nodeview');
    assert.equal(communityStableId('community-7', ['x/alpha.ts', 'x/beta.ts']), 'community~alpha');

    console.log('  ✓ T3: collision → distinct anchors (utils~num / utils~date); fallback → community~<anchor> (no dense int)');
}

/* ─── T4: subgraph seeding by the stable id ───────────────────────── */

async function testSubgraphSeeding(): Promise<void> {
    const { nodes, edges } = baseGraph();
    const reader = makeReader(nodes, edges);

    // Resolve the stable id for the locale community, then seed a subgraph from it.
    const membership = await listCommunityMembership(reader, WS);
    const localeId = [...membership.keys()].find((id) => id.startsWith('locale'));
    assert.ok(localeId, 'T4 locale community id resolved');
    assert.equal(localeId, 'locale~format', 'T4 locale id is the stable content id');

    const sg = await buildSubgraph(reader, WS, {
        community: localeId!,
        nodeTypes: ['code_file'],
        depth: 1,
    });
    const fileIds = new Set(sg.nodes.map((n) => n.id));
    for (const p of LOCALE) {
        assert.ok(fileIds.has(`code-file:${p}`), `T4 subgraph seeded by stable id includes ${p}`);
    }
    // Must NOT bleed into the unrelated parser community (no coupling edge).
    for (const p of PARSER) {
        assert.ok(!fileIds.has(`code-file:${p}`), `T4 subgraph does not include unrelated ${p}`);
    }
    assert.equal(sg.seed, `community:${localeId}`, 'T4 seed label reflects the stable community id');

    // Also confirm listCommunities emits the SAME id the membership/seed used.
    const listed = await listCommunities(reader, WS);
    const localeRec = listed.communities.find((c) => c.label === 'locale');
    assert.ok(localeRec, 'T4 listCommunities returns the locale community');
    assert.equal(localeRec!.id, localeId, 'T4 listCommunities id matches listCommunityMembership / subgraph seed key');
    assert.equal(typeof localeRec!.id, 'string', 'T4 CommunityRecord.id is a string');

    console.log('  ✓ T4: buildSubgraph({ community: <stableId> }) seeds exactly that community; listCommunities agrees');
}

/* ─── runner ──────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('Running GF-4 (stable community ids) tests…');
    await testReindexStability();
    await testSmallChurnStability();
    await testCollisionAndFallback();
    await testSubgraphSeeding();
    console.log('All GF-4 tests passed.');
}

await main();
