/**
 * tests/memory-append.test.ts — W2-T3: the stateless append/write path
 * (appendMemoryEntries / makeKnowledgeId / normalizeMemoryEntry in
 * src/memoryFile.ts).
 *
 * Guards the PM's write path: union semantics identical to the merge driver
 * (fresh entries = ours ⇒ same-id re-run UPSERTS, prior entries are NEVER
 * lost), a valid v2 header on a fresh file, validation that keeps junk out of
 * the ledger, atomic writes, and composition with the W1 two-writer layers
 * (the real merge-driver subprocess + unionMemoryFileInPlace).
 *
 * Uses the canonical fixture tests/fixtures/memory-150.jsonl (layout
 * documented in tests/memory-file.test.ts's header).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    appendMemoryEntries, makeKnowledgeId, normalizeMemoryEntry, readMemoryFile,
    KNOWLEDGE_TYPES, type NodeLine, type EdgeLine,
} from '../src/memoryFile.js';
import { importMemory, unionMemoryFileInPlace, type MemoryImportWriter } from '../src/cli/memorySync.js';
import type { StoreNodeInput, StoreEdgeInput } from '../src/loreClient.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const FIXTURE_150 = path.join(here, 'fixtures', 'memory-150.jsonl');
const DRIVER = path.join(repoRoot, 'scripts', 'memory-merge-driver.mjs');

const TS = '2026-07-10T00:00:00.000Z';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-memappend-'));
}

function pmNode(id: string, extra: Partial<NodeLine> = {}): NodeLine {
    return { kind: 'node', id, type: 'decision', label: id, content: `content of ${id}`, tags: 'pm', ...extra };
}

// Junk-tolerant (the fixture carries one deliberate unparseable line).
const lines = (text: string) =>
    text.split('\n').filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    });
const nodeIds = (text: string) =>
    lines(text).filter((o) => o['kind'] === 'node').map((o) => o['id'] as string).sort();

async function main(): Promise<void> {
    console.log('memory-append (W2-T3) stateless write-path tests');

    // ── CLAIM 1 — append to a MISSING file creates a valid v2 file ───────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, '.atlas', 'memory.jsonl'); // dir is created too
            const r = appendMemoryEntries(p, [pmNode(makeKnowledgeId('decision', 'pm-REQ-1'))], { exportedAt: TS });
            assert.equal(r.nodeCount, 1);
            assert.equal(r.appended, 1);
            const text = fs.readFileSync(p, 'utf8');
            const header = JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
            assert.equal(header['version'], 2, 'fresh header is v2 (vectorless-v2 is legal)');
            assert.equal(header['exportedAt'], TS);
            assert.deepEqual(header['exportedTypes'], [...KNOWLEDGE_TYPES]);
            // The file round-trips through the strict reader.
            const view = await readMemoryFile(p);
            assert.equal(view.headerVersion, 2);
            assert.deepEqual(view.nodes.map((n) => n.id), ['knowledge:decision:pm-REQ-1']);
            console.log('  ✓ CLAIM 1: fresh file is a valid v2 export (header on line 1)');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 2 — idempotent re-run: same call twice is byte-stable ──────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'm.jsonl');
            const entries: Array<NodeLine | EdgeLine> = [
                pmNode('knowledge:decision:pm-REQ-2'),
                { kind: 'edge', sourceId: 'knowledge:decision:pm-REQ-2', targetId: 'dec-00', relation: 'relates_to' },
            ];
            appendMemoryEntries(p, entries, { exportedAt: TS });
            const first = fs.readFileSync(p, 'utf8');
            const r2 = appendMemoryEntries(p, entries, { exportedAt: TS });
            const second = fs.readFileSync(p, 'utf8');
            assert.equal(second, first, 'same deterministic ids re-appended → byte-identical file');
            assert.equal(r2.nodeCount, 1, 'upsert, not duplicate');
            assert.equal(r2.edgeCount, 1, 'edge identity (source,target,relation) deduped too');
            console.log('  ✓ CLAIM 2: re-run with the same deterministic ids is byte-stable (W3 idempotency)');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 3 — same-id append REPLACES (ours-wins), prior entries kept ────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'm.jsonl');
            appendMemoryEntries(p, [pmNode('X', { label: 'v1' }), pmNode('keep-me')], { exportedAt: TS });
            appendMemoryEntries(p, [pmNode('X', { label: 'v2-revised' })], { exportedAt: TS });
            const objs = lines(fs.readFileSync(p, 'utf8'));
            const xs = objs.filter((o) => o['id'] === 'X');
            assert.equal(xs.length, 1, 'exactly one X after the upsert');
            assert.equal(xs[0]!['label'], 'v2-revised', 'the NEW entry wins the collision (ours)');
            assert.ok(objs.some((o) => o['id'] === 'keep-me'), 'entries not re-authored are preserved');
            console.log('  ✓ CLAIM 3: same-id upsert replaces; everything else survives');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 4 — appending to a REAL ledger loses nothing ───────────────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'memory.jsonl');
            fs.copyFileSync(FIXTURE_150, p);
            const before = nodeIds(fs.readFileSync(p, 'utf8'));
            const r = appendMemoryEntries(p, [
                pmNode(makeKnowledgeId('decision', 'pm-REQ-9'), { supersededAt: null }),
                { kind: 'edge', sourceId: makeKnowledgeId('decision', 'pm-REQ-9'), targetId: 'dec-00', relation: 'relates_to' },
            ], { exportedAt: TS });
            assert.equal(r.nodeCount, 126, '125 fixture nodes + 1 appended');
            assert.equal(r.edgeCount, 26, '25 fixture edges + 1 appended');
            const after = nodeIds(fs.readFileSync(p, 'utf8'));
            for (const id of before) assert.ok(after.includes(id), `prior entry ${id} preserved`);
            console.log('  ✓ CLAIM 4: append onto the 150-entry fixture preserves every prior entry');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 5 — validation: the ledger never gains junk ────────────────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'm.jsonl');
            appendMemoryEntries(p, [pmNode('base')], { exportedAt: TS });
            const before = fs.readFileSync(p, 'utf8');
            const rejects: Array<[Array<NodeLine | EdgeLine>, RegExp]> = [
                [[pmNode('', {})], /node missing id/],
                [[pmNode('bad-type', { type: 'code_file' as never })], /unknown node type 'code_file'/],
                [[pmNode('no-content', { content: '   ' })], /empty content/],
                [[{ kind: 'edge', sourceId: 'a', targetId: '', relation: 'r' }], /edge missing sourceId, targetId, or relation/],
                [[], /no entries given/],
                [[{ kind: 'blob' } as never], /unknown entry kind/],
            ];
            for (const [entries, re] of rejects) {
                assert.throws(() => appendMemoryEntries(p, entries, { exportedAt: TS }), re);
            }
            assert.equal(fs.readFileSync(p, 'utf8'), before, 'a rejected call never touches the file');
            console.log('  ✓ CLAIM 5: invalid entries reject the whole call before any write');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 6 — appended (vectorless v2) file round-trips through import ───
    {
        // The native stack is unavailable in this environment, so the "real
        // embedded Lore" leg runs as a pure MemoryImportWriter double — it
        // still proves the load-bearing part: a vectorless v2 file takes the
        // serial storeNode path with embed:true (ingestPendingNodes' re-embed
        // fallback), never the bulk-precomputed path.
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'm.jsonl');
            appendMemoryEntries(p, [
                pmNode(makeKnowledgeId('decision', 'pm-REQ-3'), { metadata: { source: 'pm', requestId: 'REQ-3' } }),
                pmNode(makeKnowledgeId('convention', 'pm-conv-1'), { type: 'convention' }),
            ], { exportedAt: TS });
            const stored: StoreNodeInput[] = [];
            let bulkCalls = 0;
            const writer: MemoryImportWriter = {
                async storeNode(input: StoreNodeInput) { stored.push(input); return { ok: true }; },
                async storeEdge(_input: StoreEdgeInput) { /* none in this file */ },
                async bulkStoreNodesWithVectors(nodes, _vectors) {
                    bulkCalls += 1;
                    return { ok: true, count: nodes.length, succeeded: nodes.length, results: nodes.map((n) => ({ ok: true, id: n.id })) };
                },
            };
            const r = await importMemory(writer, 'dev-ws', p);
            assert.equal(r.nodeCount, 2, 'nodeCount correct through the importer');
            assert.equal(r.errors.length, 0);
            assert.equal(bulkCalls, 0, 'vectorless v2 must NOT ride the bulk-precomputed path');
            assert.equal(stored.length, 2, 'serial path taken for both nodes');
            assert.ok(stored.every((s) => (s as { embed?: boolean }).embed === true),
                're-embedding triggered (embed:true on every serial store)');
            const meta = stored.find((s) => s.id === 'knowledge:decision:pm-REQ-3') as Record<string, unknown>;
            assert.deepEqual(meta['metadata'], { source: 'pm', requestId: 'REQ-3' }, 'metadata intact');
            console.log('  ✓ CLAIM 6: appended file imports with re-embed (vectorless v2 contract)');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 7 — composes with the W1 two-writer layers ─────────────────────
    {
        const dir = tmpDir();
        try {
            // PM side: a stateless append in its own clone.
            const pmFile = path.join(dir, 'pm.jsonl');
            appendMemoryEntries(pmFile, [pmNode('knowledge:decision:pm-REQ-4'), pmNode('knowledge:decision:pm-REQ-5')], { exportedAt: TS });
            // Dev side: a DB-export-shaped file with disjoint entries.
            const devText = [
                JSON.stringify({ version: 2, exportedAt: '2026-07-11T00:00:00Z', sourceWorkspace: 'dev', exportedTypes: KNOWLEDGE_TYPES }),
                JSON.stringify(pmNode('dev-d1', { tags: 'dev' })),
                JSON.stringify(pmNode('dev-d2', { tags: 'dev' })),
            ].join('\n') + '\n';

            // (a) the REAL merge driver subprocess, exactly as git invokes it.
            const O = path.join(dir, 'base'); const A = path.join(dir, 'ours'); const B = path.join(dir, 'theirs');
            fs.writeFileSync(O, '');
            fs.writeFileSync(A, devText);
            fs.copyFileSync(pmFile, B);
            execFileSync('node', [DRIVER, O, A, B], { stdio: 'pipe' });
            assert.deepEqual(nodeIds(fs.readFileSync(A, 'utf8')),
                ['dev-d1', 'dev-d2', 'knowledge:decision:pm-REQ-4', 'knowledge:decision:pm-REQ-5'],
                'merge driver unions the appended file with the dev export — nothing lost');

            // (b) the pre-commit fold-back: a fresh dev export overwrites a file
            // holding PM-appended entries; unionMemoryFileInPlace restores them.
            const shared = path.join(dir, 'memory.jsonl');
            fs.copyFileSync(pmFile, shared);
            const prior = fs.readFileSync(shared, 'utf8');
            fs.writeFileSync(shared, devText);
            unionMemoryFileInPlace(shared, prior);
            assert.deepEqual(nodeIds(fs.readFileSync(shared, 'utf8')),
                ['dev-d1', 'dev-d2', 'knowledge:decision:pm-REQ-4', 'knowledge:decision:pm-REQ-5'],
                'export fold-back preserves PM-appended entries the DB never saw');
            console.log('  ✓ CLAIM 7: appended files survive the W1 driver + fold-back layers');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 8 — atomic write leaves no temp file; helpers behave ───────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'm.jsonl');
            appendMemoryEntries(p, [pmNode('a')], { exportedAt: TS });
            assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no leftover .tmp');

            assert.equal(makeKnowledgeId('decision', 'pm-REQ-1'), 'knowledge:decision:pm-REQ-1',
                'id scheme matches knowledge_store (knowledge:<type>:<suffix>)');
            assert.throws(() => makeKnowledgeId('code_file' as never, 'x'), /unknown knowledge type/);
            assert.throws(() => makeKnowledgeId('decision', '  '), /slug must be non-empty/);

            const n = normalizeMemoryEntry({ id: 'n1', content: 'c', tags: ['a', 'b'] });
            assert.equal(n.kind, 'node');
            assert.equal((n as NodeLine).type, 'decision', "nodes default to type 'decision'");
            assert.equal((n as NodeLine).tags, 'a,b', 'array tags normalized');
            const e = normalizeMemoryEntry({ sourceId: 's', targetId: 't', relation: 'r' });
            assert.equal(e.kind, 'edge', 'edge inferred from endpoints when kind is absent');
            console.log('  ✓ CLAIM 8: atomicity + id scheme + normalization defaults');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    console.log('memory-append: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
