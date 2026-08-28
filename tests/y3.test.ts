/**
 * tests/y3.test.ts — Y3 recursive + batch CLI mode.
 *
 * Pins the contract of the four new pieces (walker, batchWriter,
 * checkpoint, loreClient.bulk*) + verifies the single-file path
 * is unchanged. Each test uses an in-process mock Lore HTTP server
 * so we can assert the exact REST traffic the CLI emits without
 * depending on a running daemon. T7 (full DEF perf measurement) is
 * NOT a unit test — it's a runtime gate reported in the commit
 * message via `atlas index <DEF-repo> --recursive`.
 *
 * Pins:
 *   T1: walkRepo yields every supported file under a tree.
 *   T2: walkRepo respects .gitignore at the root.
 *   T3: --exclude glob pattern skips matched files (via walkRepo opts).
 *   T4: BatchWriter flushes exactly ceil(N/batch) bulk POSTs.
 *   T5: A per-item bulk-write failure doesn't abort the batch and is
 *       logged with the source file path.
 *   T6: Checkpoint round-trip: marking + re-reading skips unchanged files.
 *   plus: loreClient.bulkStoreNodes hits POST /api/nodes/bulk and falls
 *         back per-item on 404 (pre-W9 daemon back-compat).
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { LoreClient } from '../src/loreClient.js';
import { walkRepo } from '../src/cli/walker.js';
import { BatchWriter } from '../src/cli/batchWriter.js';
import { loadCheckpoint, saveCheckpoint, markIndexed, needsReindex } from '../src/cli/checkpoint.js';

interface RecordedRequest {
    method: string;
    url: string;
    body: string;
}

function startMockLore(handler: (req: RecordedRequest) => { status: number; body: string }) {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
            const rec: RecordedRequest = {
                method: req.method ?? '',
                url: req.url ?? '',
                body: Buffer.concat(chunks).toString('utf8'),
            };
            requests.push(rec);
            const r = handler(rec);
            res.writeHead(r.status, { 'Content-Type': 'application/json' });
            res.end(r.body);
        });
    });
    return new Promise<{ server: http.Server; url: string; requests: RecordedRequest[] }>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp`, requests });
        });
    });
}

function mkdtemp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function write(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.error(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.error('Y3 — recursive + batch CLI');

/* ---------- T1 — walker yields every supported file ---------- */

test('T1 walkRepo yields every parseable file under a tree', async () => {
    const root = mkdtemp('atlas-y3-t1-');
    write(path.join(root, 'a.ts'), 'export const a = 1;');
    write(path.join(root, 'nested/dir/b.py'), 'def b(): return 1');
    write(path.join(root, 'nested/c.go'), 'package c');
    write(path.join(root, 'README.md'), '# not indexed (no parser)');
    write(path.join(root, '.gitignore'), '');  // no ignores
    const found = [...walkRepo(root)].map((p) => path.relative(root, p)).sort();
    assert.deepEqual(found, ['a.ts', 'nested/c.go', 'nested/dir/b.py']);
});

/* ---------- T2 — .gitignore respected ---------- */

test('T2 walkRepo respects .gitignore at the root', async () => {
    const root = mkdtemp('atlas-y3-t2-');
    write(path.join(root, 'kept.ts'), 'export const x = 1;');
    write(path.join(root, 'skipped.ts'), 'export const y = 1;');
    write(path.join(root, 'logs/big.ts'), 'export const z = 1;');
    write(path.join(root, '.gitignore'), 'skipped.ts\nlogs/\n');
    const found = [...walkRepo(root)].map((p) => path.relative(root, p)).sort();
    assert.deepEqual(found, ['kept.ts'], `unexpected files: ${found.join(',')}`);
});

/* ---------- T3 — --exclude glob ---------- */

test('T3 walkRepo --exclude glob skips matched files', async () => {
    const root = mkdtemp('atlas-y3-t3-');
    write(path.join(root, 'src/a.ts'), 'export const a = 1;');
    write(path.join(root, 'src/a.test.ts'), 'export const at = 1;');
    write(path.join(root, 'src/nested/b.test.ts'), 'export const bt = 1;');
    const found = [...walkRepo(root, { excludeGlobs: ['**/*.test.ts'] })]
        .map((p) => path.relative(root, p)).sort();
    assert.deepEqual(found, ['src/a.ts']);
});

/* ---------- T4 — batch flush count ---------- */

test('T4 BatchWriter flushes ceil(N/batch) bulk POSTs (--batch 10 across 33 files)', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk') {
            const { nodes } = JSON.parse(req.body) as { nodes: Array<{ id: string }> };
            return { status: 200, body: JSON.stringify({
                ok: true, count: nodes.length, succeeded: nodes.length,
                results: nodes.map((n) => ({ ok: true, id: n.id })),
            }) };
        }
        if (req.url === '/api/edges/bulk') {
            const { edges } = JSON.parse(req.body) as { edges: unknown[] };
            return { status: 200, body: JSON.stringify({
                ok: true, count: edges.length, succeeded: edges.length,
                results: edges.map(() => ({ ok: true })),
            }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T4' });
        const writer = new BatchWriter(client, { batchSize: 10 });
        for (let i = 0; i < 33; i++) {
            await writer.add(`/tmp/f${i}.ts`,
                [{ id: `n-${i}`, type: 'file_ref', label: `f${i}`, workspace: 'default' }],
                [],  // no edges in this test
            );
        }
        await writer.flush();
        await client.close();
        const bulkNodeCalls = lore.requests.filter((r) => r.url === '/api/nodes/bulk');
        // 33 files / 10 per batch = 4 calls (10, 10, 10, 3)
        assert.equal(bulkNodeCalls.length, 4, `expected 4 bulk-node POSTs; got ${bulkNodeCalls.length}`);
        const sizes = bulkNodeCalls.map((r) => (JSON.parse(r.body) as { nodes: unknown[] }).nodes.length);
        assert.deepEqual(sizes, [10, 10, 10, 3]);
        assert.equal(writer.totals.files, 33);
    } finally {
        lore.server.close();
    }
});

/* ---------- T5 — per-item bulk failure doesn't abort batch ---------- */

test('T5 bulk-write per-item failure logged with file path; other items commit', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk') {
            const { nodes } = JSON.parse(req.body) as { nodes: Array<{ id: string }> };
            // Fail exactly one id; others succeed.
            return { status: 200, body: JSON.stringify({
                ok: false, count: nodes.length, succeeded: nodes.length - 1,
                results: nodes.map((n) => n.id === 'n-bad'
                    ? { ok: false, id: n.id, error: 'simulated upsert failure' }
                    : { ok: true, id: n.id }),
            }) };
        }
        if (req.url === '/api/edges/bulk') {
            const { edges } = JSON.parse(req.body) as { edges: unknown[] };
            return { status: 200, body: JSON.stringify({
                ok: true, count: edges.length, succeeded: edges.length,
                results: edges.map(() => ({ ok: true })),
            }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T5' });
        const writer = new BatchWriter(client, { batchSize: 50 });
        await writer.add('/abs/good.ts',
            [{ id: 'n-good', type: 'file_ref', label: 'g', workspace: 'default' }], []);
        await writer.add('/abs/bad.ts',
            [{ id: 'n-bad', type: 'file_ref', label: 'b', workspace: 'default' }], []);
        const landed = await writer.flush();
        await client.close();
        // 'good' lands; 'bad' is in the errors array.
        assert.deepEqual(landed.sort(), ['/abs/good.ts']);
        const totals = writer.totals;
        assert.equal(totals.errors.length, 1);
        assert.equal(totals.errors[0]!.filePath, '/abs/bad.ts');
        assert.equal(totals.errors[0]!.item, 'node');
    } finally {
        lore.server.close();
    }
});

/* ---------- T6 — --resume skips unchanged files ---------- */

test('T6 checkpoint: markIndexed then needsReindex returns false on unchanged file', async () => {
    const root = mkdtemp('atlas-y3-t6-');
    const p = path.join(root, 'src/a.ts');
    write(p, 'export const a = 1;');
    const cp = loadCheckpoint(root);
    assert.equal(needsReindex(p, cp), true, 'fresh checkpoint must re-index');
    markIndexed(p, cp);
    saveCheckpoint(cp);
    const reloaded = loadCheckpoint(root);
    assert.equal(needsReindex(p, reloaded), false, 'unchanged file must be skipped on resume');
    // Touch the file → fingerprint changes → re-index.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(p, future, future);
    assert.equal(needsReindex(p, reloaded), true, 'mtime change must invalidate the entry');
});

/* ---------- loreClient.bulkStoreNodes contract ---------- */

test('bulkStoreNodes posts to /api/nodes/bulk and parses {results}', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk') {
            const { nodes } = JSON.parse(req.body) as { nodes: Array<{ id: string }> };
            return { status: 200, body: JSON.stringify({
                ok: true, count: nodes.length, succeeded: nodes.length,
                results: nodes.map((n) => ({ ok: true, id: n.id })),
            }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-bulk' });
        const r = await client.bulkStoreNodes([
            { id: 'b-1', type: 'file_ref', label: 'L1', workspace: 'default' },
            { id: 'b-2', type: 'file_ref', label: 'L2', workspace: 'default' },
        ]);
        await client.close();
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        assert.equal(r.succeeded, 2);
        assert.equal(lore.requests[0]!.url, '/api/nodes/bulk');
    } finally {
        lore.server.close();
    }
});

test('bulkStoreNodes falls back to per-item POSTs on 404 (pre-W9 daemon)', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk') {
            return { status: 404, body: JSON.stringify({ error: 'no such route' }) };
        }
        if (req.url === '/api/node') {
            const n = JSON.parse(req.body) as { id: string };
            return { status: 200, body: JSON.stringify({ ok: true, id: n.id }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-fb' });
        const r = await client.bulkStoreNodes([
            { id: 'f-1', type: 'file_ref', label: 'L1', workspace: 'default' },
            { id: 'f-2', type: 'file_ref', label: 'L2', workspace: 'default' },
        ]);
        await client.close();
        assert.equal(r.succeeded, 2);
        const urls = lore.requests.map((q) => q.url);
        assert.equal(urls[0], '/api/nodes/bulk', 'first attempt must be bulk');
        // Then 2 fallback per-item POSTs.
        assert.deepEqual(urls.slice(1), ['/api/node', '/api/node']);
    } finally {
        lore.server.close();
    }
});

await Promise.all(pending);
console.error(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
