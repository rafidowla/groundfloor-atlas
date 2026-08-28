/**
 * tests/memory-file.test.ts — W2-T1: the dependency-free JSONL core
 * (src/memoryFile.ts) and its delegation contract with cli/memorySync.ts.
 *
 * Guards:
 *   1. readMemoryFile's typed view (counts, header, vector stripping, junk
 *      surfaced by line — never silently dropped);
 *   2. header-validation error strings stay BYTE-IDENTICAL to the historical
 *      importMemory messages (callers match on them);
 *   3. importMemory still behaves exactly as before the parse core was
 *      extracted (error id format `line:N`, skipped bookkeeping, and the
 *      vectorless-v2 → serial-re-embed vs all-vectors-v2 → bulk-precomputed
 *      path selection in ingestPendingNodes).
 *
 * FIXTURE: tests/fixtures/memory-150.jsonl — the canonical shared fixture
 * (reused by the W2 query/append suites). Deterministic layout:
 *   line 1     v2 header (exportedAt 2026-07-01T00:00:00.000Z, ws 'fixture')
 *   125 nodes  25 per knowledge type; ids `<prefix>-NN` with prefixes
 *              dec/conv/bug/tro/arch, NN = 00..24. Per index i:
 *                topic       = TOPICS[i % 5] (in label 1×, in content 1+(i%3)×)
 *                tags        = fixture,<type>[,pm when i % 5 === 0]
 *                supersededAt= '2026-07-02T00:00:00.000Z' when i % 10 === 3
 *                              (3 per type = 15 superseded), else null
 *                embedding   = 4-dim vector when i % 7 === 0 (4 per type = 20)
 *   1 junk     an unparseable conflict-marker line at file line 62 (after the
 *              60th node) — parsers must tolerate it and report exactly one
 *   25 edges   dec-00..09→conv-00..09 relates_to; dec-10..14→arch-00..04
 *              supersedes; dec-15..19→lore/dec-Y0..4 relates_to (CROSS-SEAM
 *              foreign targets, dangling within this file); bug-00..04→
 *              tro-00..04 relates_to
 * TOPICS = ['atomic rename discipline', 'merge driver union',
 *           'kuzu writer lock', 'embedding vector sync', 'git hook install']
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMemoryFile, KNOWLEDGE_TYPES } from '../src/memoryFile.js';
import { importMemory, type MemoryImportWriter } from '../src/cli/memorySync.js';
import type { StoreNodeInput, StoreEdgeInput } from '../src/loreClient.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_150 = path.join(here, 'fixtures', 'memory-150.jsonl');

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-memfile-'));
}

/** Pure in-memory MemoryImportWriter double — records every call. */
function mockWriter(withBulk: boolean): MemoryImportWriter & {
    stored: StoreNodeInput[]; edges: StoreEdgeInput[]; bulkCalls: number; bulkNodes: number;
} {
    const m = {
        stored: [] as StoreNodeInput[],
        edges: [] as StoreEdgeInput[],
        bulkCalls: 0,
        bulkNodes: 0,
        async storeNode(input: StoreNodeInput) { m.stored.push(input); return { ok: true }; },
        async storeEdge(input: StoreEdgeInput) { m.edges.push(input); },
        ...(withBulk ? {
            async bulkStoreNodesWithVectors(nodes: StoreNodeInput[], _vectors: number[][]) {
                m.bulkCalls += 1;
                m.bulkNodes += nodes.length;
                return { ok: true, count: nodes.length, succeeded: nodes.length, results: nodes.map((n) => ({ ok: true, id: n.id })) };
            },
        } : {}),
    };
    return m as never;
}

async function main(): Promise<void> {
    console.log('memory-file (W2-T1) core + delegation tests');

    // ── CLAIM 1 — readMemoryFile: counts, header, and junk surfaced by line ──
    {
        const view = await readMemoryFile(FIXTURE_150);
        assert.equal(view.headerVersion, 2, 'fixture header is v2');
        assert.equal(view.exportedAt, '2026-07-01T00:00:00.000Z', 'exportedAt from the header');
        assert.equal(view.nodes.length, 125, '125 well-shaped nodes');
        assert.equal(view.edges.length, 25, '25 well-shaped edges');
        assert.equal(view.errors.length, 1, 'exactly the one deliberate junk line');
        assert.equal(view.errors[0]!.line, 62, 'junk line position reported (file line 62)');
        assert.match(view.errors[0]!.error, /^json parse: /, 'junk reported as a json parse error');
        // supersededAt round-trips: 15 superseded, the rest explicit null.
        const superseded = view.nodes.filter((n) => typeof n.supersededAt === 'string');
        assert.equal(superseded.length, 15, '15 superseded nodes (3 per type)');
        assert.ok(view.nodes.every((n) => 'supersededAt' in n), 'supersededAt preserved (null meaningful)');
        // All 5 knowledge types present, 25 each.
        for (const t of KNOWLEDGE_TYPES) {
            assert.equal(view.nodes.filter((n) => n.type === t).length, 25, `25 ${t} nodes`);
        }
        console.log('  ✓ CLAIM 1: view counts/header/junk-by-line are exact');
    }

    // ── CLAIM 2 — vectors stripped by default; includeVectors opts in ────────
    {
        const stripped = await readMemoryFile(FIXTURE_150);
        assert.ok(stripped.nodes.every((n) => n.embedding === undefined),
            'includeVectors defaults to false — no node carries a vector');
        const withVecs = await readMemoryFile(FIXTURE_150, { includeVectors: true });
        assert.equal(withVecs.nodes.filter((n) => Array.isArray(n.embedding)).length, 20,
            '20 nodes carry a vector when explicitly requested (i % 7 === 0, 4 per type)');
        console.log('  ✓ CLAIM 2: embedding[] stripped by default, opt-in intact');
    }

    // ── CLAIM 3 — header-validation error strings are byte-identical ─────────
    {
        const dir = tmpDir();
        try {
            const badVersion = path.join(dir, 'bad.jsonl');
            fs.writeFileSync(badVersion, JSON.stringify({ version: 3, exportedTypes: [] }) + '\n');
            await assert.rejects(
                () => readMemoryFile(badVersion),
                (err: Error) => {
                    assert.equal(err.message,
                        `memory import: unsupported or missing header version (got 3); ` +
                        `expected version 1 or 2 on line 1 of ${badVersion}`,
                        'exact historical header-version error string');
                    return true;
                });
            const empty = path.join(dir, 'empty.jsonl');
            fs.writeFileSync(empty, '\n\n');
            await assert.rejects(
                () => readMemoryFile(empty),
                (err: Error) => {
                    assert.equal(err.message, `memory import: file is empty or has no header: ${empty}`,
                        'exact historical no-header error string');
                    return true;
                });
            // importMemory throws the SAME strings through the delegated parse.
            const w = mockWriter(false);
            await assert.rejects(() => importMemory(w, 'ws', badVersion),
                (err: Error) => err.message.startsWith('memory import: unsupported or missing header version (got 3);'));
            console.log('  ✓ CLAIM 3: header-validation error strings unchanged to the byte');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 4 — importMemory over the fixture: delegation is transparent ───
    {
        // The fixture is v2 with only SOME nodes carrying vectors (20 of 125,
        // per CLAIM 2). Since the M2 per-node partition fix, ingestPendingNodes
        // routes the vector-carrying subset through bulk-precomputed and only
        // the vector-less remainder through the serial path — the old
        // all-or-nothing gate (one vector-less node forced ALL nodes serial,
        // re-embedding even the vector-carrying ones) no longer applies.
        const w = mockWriter(true);
        const r = await importMemory(w, 'ws', FIXTURE_150);
        assert.equal(r.nodeCount, 125, 'all 125 nodes ingested');
        assert.equal(w.stored.length, 105, 'serial storeNode used for exactly the 105 vector-less nodes');
        assert.equal(w.bulkCalls, 1, 'the vector-carrying subset took the bulk-precomputed path');
        assert.equal(w.bulkNodes, 20, 'bulk got exactly the 20 vector-carrying nodes');
        assert.equal(r.edgeCount, 25, 'all 25 edges applied (mock persists everything)');
        assert.equal(r.skipped, 0, 'no unknown-kind lines in the fixture');
        assert.equal(r.errors.length, 1, 'exactly the junk line error');
        assert.equal(r.errors[0]!.id, 'line:62', 'error id keeps the historical line:N format');
        assert.match(r.errors[0]!.error, /^json parse: /);
        console.log('  ✓ CLAIM 4: importMemory partitions per-node (bulk for vectors, serial for the rest)');
    }

    // ── CLAIM 5 — all-vectors v2 still routes through bulk-precomputed ───────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'vec.jsonl');
            fs.writeFileSync(p, [
                JSON.stringify({ version: 2, exportedAt: '2026-07-01T00:00:00Z', sourceWorkspace: 'ws', exportedTypes: KNOWLEDGE_TYPES }),
                JSON.stringify({ kind: 'node', id: 'a', type: 'decision', label: 'a', content: 'x', embedding: [1, 2] }),
                JSON.stringify({ kind: 'node', id: 'b', type: 'decision', label: 'b', content: 'y', embedding: [3, 4] }),
                JSON.stringify({ kind: 'unknown', id: 'zz' }), // unknown kind → skipped
            ].join('\n') + '\n');
            const w = mockWriter(true);
            const r = await importMemory(w, 'ws', p);
            assert.equal(w.bulkCalls, 1, 'v2 + every-node-vectored → ONE bulk call');
            assert.equal(w.stored.length, 0, 'no serial fallback needed');
            assert.equal(r.nodeCount, 2);
            assert.equal(r.skipped, 1, 'unknown-kind line counted as skipped, not an error');
            console.log('  ✓ CLAIM 5: bulk-precomputed fast path + skipped bookkeeping intact');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 6 — shape problems surfaced by line in the view ────────────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'shapes.jsonl');
            fs.writeFileSync(p, [
                JSON.stringify({ version: 1, exportedAt: '2026-07-01T00:00:00Z', sourceWorkspace: 'ws', exportedTypes: KNOWLEDGE_TYPES }),
                JSON.stringify({ kind: 'node', type: 'decision', label: 'no id' }),                    // line 2
                JSON.stringify({ kind: 'node', id: 'x', type: 'code_file', label: 'wrong type' }),     // line 3
                JSON.stringify({ kind: 'edge', sourceId: 'a', relation: 'r' }),                        // line 4 (no target)
                JSON.stringify({ kind: 'node', id: 'ok', type: 'decision', tags: ['a', 'b'] }),        // line 5 (array tags)
            ].join('\n') + '\n');
            const view = await readMemoryFile(p);
            assert.equal(view.nodes.length, 1, 'only the well-shaped node survives');
            assert.equal(view.nodes[0]!.tags, 'a,b', 'array tags normalized to the comma-string format');
            assert.deepEqual(view.errors.map((e) => e.line), [2, 3, 4], 'each shape problem named by line');
            assert.match(view.errors[1]!.error, /unknown node type 'code_file'/);
            console.log('  ✓ CLAIM 6: shape problems flagged by line, never silently dropped');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    console.log('memory-file: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
