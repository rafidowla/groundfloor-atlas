/**
 * tests/gf1.test.ts — GF-1 in-process unit tests (no daemon, no Lore server).
 *
 *   T1 (edge confidence — build sites): parse a fixture + resolveRepo, run
 *       buildIndexBatch, and assert the produced edges carry confidence:
 *         - a parsed intra-file CALL edge is high ('extracted' / score 1.0)
 *         - the structural file→symbol 'contains' edge is high
 *         - the code_context 'describes' bridge is lower ('inferred' / 0.6)
 *   T2 (edge confidence — surfaced on the subgraph): feed those edges into a
 *       hand-rolled SubgraphReader fake and assert buildSubgraph re-emits the
 *       confidence (+score) on its SubgraphEdge.
 *   T3 (atlas_source whole-file cap): omitting the range on a >N-line file
 *       returns ≤N lines + truncated:true + a notice; an explicit range over
 *       the SAME file is uncapped; a small whole file is uncapped.
 *   T4 (crossProject dropped): the knowledge_recall schema no longer advertises
 *       `crossProject`, and the description points at `atlas group load`.
 *
 * Pure-function tests: parser + resolver + store builders + subgraph + source
 * are all in-process and need no network. The context layer is gated on
 * ATLAS_CONTEXT_LAYER=1, snapshotted at codeNodes module load, so we set it on
 * process.env BEFORE the first dynamic import below.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// MUST precede the codeNodes import: CONTEXT_LAYER_ENABLED is snapshotted at
// module load (codeNodes.ts:71). Per-file card mode (CONTEXT_SPANS unset).
process.env['ATLAS_CONTEXT_LAYER'] = '1';
delete process.env['ATLAS_CONTEXT_SPANS'];

const REPO = 'gf1-fixture-repo';
const WORKSPACE = 'gf1-test-ws';

/* ─── helpers ───────────────────────────────────────────────────── */

function makeFixtureFile(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf1-fixture-'));
    const file = path.join(dir, 'sample.ts');
    fs.writeFileSync(
        file,
        // greet → helper is a real intra-file CALL edge resolved by direct AST
        // proximity → confidence 1.0 in callGraph.ts.
        `export function greet(name: string): string {
    return helper('Hello, ' + name);
}

export function helper(message: string): string {
    return message + '!';
}
`,
    );
    return { dir, file };
}

/** A SubgraphReader fake backed by in-memory node/edge arrays — same duck-type
 *  pattern the module documents (ProcessReader). Carries confidence through. */
function makeReader(
    nodes: Array<{ id: string; type: string; label?: string; metadata?: string }>,
    edges: Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>,
) {
    return {
        async listNodes(type?: string): Promise<unknown[]> {
            return type ? nodes.filter((n) => n.type === type) : nodes;
        },
        async listEdges(): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }>> {
            return edges;
        },
        async getNode(id: string): Promise<unknown> {
            return nodes.find((n) => n.id === id) ?? null;
        },
    };
}

/* ─── T1 + T2: edge confidence at build sites + on the subgraph ──── */

async function testEdgeConfidence(): Promise<void> {
    const { parseFile } = await import('../src/parser/index.js');
    const { resolveRepo } = await import('../src/resolver/index.js');
    const { buildIndexBatch, codeSymbolId, codeFileId } = await import('../src/store/codeNodes.js');
    const { buildSubgraph } = await import('../src/graph/subgraph.js');

    const { dir, file } = makeFixtureFile();
    try {
        const parsed = await parseFile(file, dir);
        assert.ok(parsed, 'fixture parsed');
        const resolved = await resolveRepo(dir, [parsed!]);

        // Repo-relative path is what the indexer feeds; ParsedFile.path is already
        // repo-relative because parseFile got repoRoot=dir.
        const batch = await buildIndexBatch(parsed!, { workspace: WORKSPACE, repo: REPO }, resolved.relations);

        // (a) Parsed CALL edge greet→helper: high confidence, score 1.0 (direct
        //     same-file AST resolve).
        const greetId = codeSymbolId(parsed!.symbols.find((s) => s.name === 'greet')!, REPO);
        const helperId = codeSymbolId(parsed!.symbols.find((s) => s.name === 'helper')!, REPO);
        const callEdge = batch.edges.find((e) => e.relation === 'calls' && e.sourceId === greetId && e.targetId === helperId);
        assert.ok(callEdge, `parsed call edge greet→helper present; got ${JSON.stringify(batch.edges.map((e) => [e.relation, e.sourceId, e.targetId]))}`);
        assert.equal(callEdge!.confidence, 'extracted', 'call edge confidence tier high');
        assert.equal(callEdge!.confidenceScore, 1.0, 'call edge score 1.0 (direct AST resolve)');

        // (b) Structural file→symbol 'contains' edge: high confidence.
        const fileId = codeFileId(parsed!, REPO);
        const containsEdge = batch.edges.find((e) => e.relation === 'contains' && e.sourceId === fileId);
        assert.ok(containsEdge, 'structural contains edge present');
        assert.equal(containsEdge!.confidence, 'extracted', 'contains tier high');
        assert.equal(containsEdge!.confidenceScore, 1.0, 'contains score 1.0');

        // (c) code_context 'describes' bridge: LOWER confidence ('inferred'/0.6).
        const describesEdge = batch.edges.find((e) => e.relation === 'describes');
        assert.ok(describesEdge, `describes bridge present (ATLAS_CONTEXT_LAYER=1); got relations ${JSON.stringify([...new Set(batch.edges.map((e) => e.relation))])}`);
        assert.equal(describesEdge!.confidence, 'inferred', 'describes tier inferred');
        assert.equal(describesEdge!.confidenceScore, 0.6, 'describes score 0.6');

        // Strictly-lower invariant: the heuristic bridge ranks below the AST fact.
        assert.ok((describesEdge!.confidenceScore ?? 1) < (callEdge!.confidenceScore ?? 0), 'describes score < call score');
        console.log('  ✓ T1: build sites stamp confidence (call=extracted/1.0, contains=extracted/1.0, describes=inferred/0.6)');

        // ── T2: buildSubgraph surfaces confidence on its SubgraphEdge. ──
        const readerNodes = batch.nodes.map((n) => ({ id: n.id as string, type: n.type as string, label: n.label as string | undefined, metadata: n.metadata as string | undefined }));
        const readerEdges = batch.edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation, confidence: e.confidence, confidenceScore: e.confidenceScore }));
        const reader = makeReader(readerNodes, readerEdges);

        const sub = await buildSubgraph(reader, WORKSPACE, { center: fileId, depth: 2, maxNodes: 100 });
        const subCall = sub.edges.find((e) => e.relation === 'calls');
        assert.ok(subCall, `subgraph emits the call edge; got ${JSON.stringify(sub.edges.map((e) => e.relation))}`);
        assert.equal(subCall!.confidence, 'extracted', 'subgraph call edge confidence surfaced');
        assert.equal(subCall!.confidenceScore, 1.0, 'subgraph call edge score surfaced');

        const subDescribes = sub.edges.find((e) => e.relation === 'describes');
        assert.ok(subDescribes, 'subgraph emits the describes bridge');
        assert.equal(subDescribes!.confidence, 'inferred', 'subgraph describes confidence surfaced');
        assert.equal(subDescribes!.confidenceScore, 0.6, 'subgraph describes score surfaced');
        console.log('  ✓ T2: buildSubgraph surfaces confidence (+score) on SubgraphEdge');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ─── T3: atlas_source whole-file cap ───────────────────────────── */

async function testSourceCap(): Promise<void> {
    const { runSourceTool } = await import('../src/mcp/tools/source.js');

    const WHOLE_FILE_MAX_LINES = 400;
    const loreHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gf1-lorehome-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gf1-srcrepo-'));
    const bigName = 'big.txt';
    const totalLines = 1000;
    fs.writeFileSync(path.join(repoRoot, bigName), Array.from({ length: totalLines }, (_, i) => `line ${i + 1}`).join('\n'));
    const smallName = 'small.txt';
    const smallTotal = 50;
    fs.writeFileSync(path.join(repoRoot, smallName), Array.from({ length: smallTotal }, (_, i) => `s ${i + 1}`).join('\n'));

    // Registry the tool reads fresh on every call (LORE_HOME/atlas-registry.json).
    fs.writeFileSync(
        path.join(loreHome, 'atlas-registry.json'),
        JSON.stringify([{ name: REPO, path: repoRoot, storagePath: '', indexedAt: '', lastCommit: '', stats: { files: 0, nodes: 0, edges: 0, communities: 0, processes: 0, embeddings: 0 } }]),
    );

    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = loreHome;
    try {
        // (a) No range on a >N-line file → capped to N from the top + truncated + notice.
        const capped = await runSourceTool({ path: bigName, repo: REPO });
        assert.ok(!('error' in capped), `capped read ok; got ${JSON.stringify(capped)}`);
        const c = capped as { startLine: number; endLine: number; totalLines: number; content: string; truncated?: boolean; notice?: string };
        assert.equal(c.startLine, 1, 'cap starts at line 1');
        assert.equal(c.endLine, WHOLE_FILE_MAX_LINES, `cap ends at ${WHOLE_FILE_MAX_LINES}`);
        assert.equal(c.content.split('\n').length, WHOLE_FILE_MAX_LINES, `returns exactly ${WHOLE_FILE_MAX_LINES} lines`);
        assert.equal(c.totalLines, totalLines, 'totalLines unchanged (reports real size)');
        assert.equal(c.truncated, true, 'truncated flag set');
        assert.ok(typeof c.notice === 'string' && c.notice.includes(String(totalLines)) && c.notice.includes(String(WHOLE_FILE_MAX_LINES)) && /startLine\/endLine/.test(c.notice), `notice explains the cap + how to read more; got ${JSON.stringify(c.notice)}`);

        // (b) Explicit range over the SAME big file → UNCAPPED (caller controls).
        const ranged = await runSourceTool({ path: bigName, repo: REPO, startLine: 500, endLine: 900, contextMargin: 0 });
        assert.ok(!('error' in ranged), `ranged read ok; got ${JSON.stringify(ranged)}`);
        const r = ranged as { startLine: number; endLine: number; content: string; truncated?: boolean };
        assert.equal(r.startLine, 500, 'explicit range honored (start)');
        assert.equal(r.endLine, 900, 'explicit range honored (end)');
        assert.equal(r.content.split('\n').length, 401, 'explicit range uncapped (401 lines, >N)');
        assert.ok(!r.truncated, 'explicit range not flagged truncated');

        // (c) Small whole file (≤ N) → uncapped, no truncation.
        const small = await runSourceTool({ path: smallName, repo: REPO });
        assert.ok(!('error' in small), `small read ok; got ${JSON.stringify(small)}`);
        const s = small as { endLine: number; totalLines: number; truncated?: boolean };
        assert.equal(s.totalLines, smallTotal, 'small file total');
        assert.equal(s.endLine, smallTotal, 'small whole file returned in full');
        assert.ok(!s.truncated, 'small whole file not truncated');
        console.log(`  ✓ T3: whole-file fallback capped to ${WHOLE_FILE_MAX_LINES} + truncated + notice; explicit range + small file uncapped`);
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prevHome;
        fs.rmSync(loreHome, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

/* ─── T4: crossProject dropped from knowledge_recall ────────────── */

async function testCrossProjectDropped(): Promise<void> {
    // buildRegistry materializes every Atlas tool's schema + description inline
    // (handlers stay lazy). We inspect knowledge_recall without invoking it.
    const { buildRegistry } = await import('../src/mcp/allTools.js');
    const registry = buildRegistry(0);
    const recall = registry.schema('knowledge_recall');
    assert.ok(recall, 'knowledge_recall registered');
    const props = (recall!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(!('crossProject' in props), `crossProject removed from schema; got props ${JSON.stringify(Object.keys(props))}`);
    assert.ok(/atlas group load/.test(recall!.description ?? ''), `description points at \`atlas group load\`; got ${JSON.stringify(recall!.description)}`);
    console.log('  ✓ T4: knowledge_recall no longer advertises crossProject; description redirects to `atlas group load`');
}

/* ─── runner ────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('atlas GF-1 tests');
    await testEdgeConfidence();
    await testSourceCap();
    await testCrossProjectDropped();
    console.log('All GF-1 tests passed.');
}

await main();
