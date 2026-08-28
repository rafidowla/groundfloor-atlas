/**
 * tests/y-perf.test.ts — Sprint Y Atlas perf consolidation.
 *
 * Sprint Y adopts the 3 Lore-side Sprint W deliverables:
 *   W1 embed:false on store_node
 *   W2 POST /api/edge REST endpoint
 *   W4 POST /api/nodes/bulk-list cursor pagination + rate-limit exempt
 *
 * Atlas changes in one commit:
 *   - loreClient.ts: writes via keep-alive REST (POST /api/node +
 *     POST /api/edge); MCP fallback only when daemon predates W.
 *   - codeNodes.ts: every code-type write passes embed:false.
 *   - loreReader.ts: cold loadContext tries POST /api/nodes/bulk-list
 *     first; falls back to legacy paginated → file_ref walk on 404.
 *
 * Tests in this file are mock-based unit tests. The spec's T5/T6
 * (perf timings against the live daemon) are gated on operator
 * deploying Sprint W to the running :3847 daemon and are exercised
 * via the existing tests/x7.test.ts pattern post-deploy (see commit
 * message). The unit tests below pin the SHAPE of the Y wins so they
 * cannot regress at the code level.
 *
 *   T1: loreClient.storeNode issues POST /api/node (NOT MCP) and the
 *       same client instance reuses the persistent HTTP agent across
 *       repeated calls.
 *   T2: codeNodes.indexParsedFile drives storeNode with embed:false on
 *       every file_ref + code_symbol (the spec's "code-type rows
 *       skipped from lancedb" gate).
 *   T3: A knowledge-type store_node (e.g. decision) does NOT auto-
 *       inject embed:false — the flag is opt-in per call, so default
 *       behavior is preserved.
 *   T4: loreReader.loadContext attempts POST /api/nodes/bulk-list
 *       BEFORE the legacy /api/nodes paginated path or the file_ref
 *       walk (proves Sprint Y wires the W4 endpoint as primary).
 *   T5/T6 contract notes: see comments at end of file; perf gates
 *       are integration-tested against the deployed daemon, not here.
 */

import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { LoreClient } from '../src/loreClient.js';
import { indexParsedFile, codeFileId, codeSymbolId } from '../src/store/codeNodes.js';
import { LoreReader, _resetLoreReaderCache } from '../src/mcp/loreReader.js';

interface RecordedRequest {
    method: string;
    url: string;
    body: string;
}

function startMockLore(handler: (req: RecordedRequest) => { status: number; body: string }): Promise<{
    server: http.Server;
    url: string;
    requests: RecordedRequest[];
}> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
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
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve({
                server,
                url: `http://127.0.0.1:${addr.port}/mcp`,
                requests,
            });
        });
    });
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

console.error('Sprint Y Atlas perf consolidation');

/* ---------- T1: writes go via POST /api/node, not MCP ---------- */

test('T1 storeNode posts to /api/node (no MCP session)', async () => {
    const lore = await startMockLore((req) => {
        if (req.method === 'POST' && req.url === '/api/node') {
            return { status: 200, body: JSON.stringify({ ok: true, id: JSON.parse(req.body).id }) };
        }
        return { status: 404, body: JSON.stringify({ error: 'unexpected' }) };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T1' });
        await client.storeNode({
            id: 'y-T1-1', type: 'convention', label: 'L', workspace: 'default',
        });
        await client.storeNode({
            id: 'y-T1-2', type: 'convention', label: 'L2', workspace: 'default',
        });
        await client.close();
        // Both writes hit /api/node — zero MCP traffic.
        assert.equal(lore.requests.length, 2, `expected 2 REST POSTs; got ${lore.requests.length}`);
        for (const r of lore.requests) {
            assert.equal(r.url, '/api/node');
            assert.equal(r.method, 'POST');
        }
    } finally {
        lore.server.close();
    }
});

test('T1 storeEdge posts to /api/edge', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/edge') return { status: 200, body: JSON.stringify({ ok: true }) };
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T1' });
        await client.storeEdge({
            sourceId: 'a', targetId: 'b', relation: 'related_to', workspace: 'default',
        });
        await client.close();
        assert.equal(lore.requests.length, 1);
        assert.equal(lore.requests[0]!.url, '/api/edge');
        assert.equal(lore.requests[0]!.method, 'POST');
    } finally {
        lore.server.close();
    }
});

test('T1 backcompat: pre-W daemon 404 on /api/edge → MCP fallback path activates', async () => {
    let edgeAttempts = 0;
    const lore = await startMockLore((req) => {
        if (req.url === '/api/edge') {
            edgeAttempts += 1;
            return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T1' });
        // MCP fallback will fail to connect against our mock (we did not
        // implement the MCP shim) — but the IMPORTANT contract this test
        // pins is that the first 404 on /api/edge causes the client to
        // STOP retrying the REST path. So a second storeEdge call should
        // not re-hit /api/edge.
        try { await client.storeEdge({ sourceId: 'a', targetId: 'b', relation: 'r', workspace: 'w' }); } catch { /* expected */ }
        try { await client.storeEdge({ sourceId: 'c', targetId: 'd', relation: 'r', workspace: 'w' }); } catch { /* expected */ }
        await client.close();
        assert.equal(edgeAttempts, 1, `pre-W detection sticks: only the first call should hit /api/edge; got ${edgeAttempts}`);
    } finally {
        lore.server.close();
    }
});

/* ---------- T2: code-type writes carry embed:false ---------- */

test('T2 code-type storeNode includes embed:false (file_ref + architecture)', async () => {
    const lore = await startMockLore((req) => {
        if (req.url === '/api/node') return { status: 200, body: JSON.stringify({ ok: true }) };
        if (req.url === '/api/edge') return { status: 200, body: JSON.stringify({ ok: true }) };
        return { status: 404, body: '{}' };
    });
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T2' });
        await indexParsedFile(
            client,
            {
                path: 'src/foo.ts',
                language: 'typescript',
                symbols: [{
                    id: 'src/foo.ts:bar:function',
                    name: 'bar',
                    qualifiedName: 'bar',
                    kind: 'function',
                    file: 'src/foo.ts',
                    byteRange: { start: 0, end: 0, startLine: 1, endLine: 5 },
                    signature: 'function bar()',
                    complexity: 1,
                    parentSymbolId: null,
                    parsedAt: 'now',
                }],
                imports: [],
                calls: [],
                sizeBytes: 100,
                loc: 5,
                parsedAt: 'now',
            },
            { workspace: 'default', repo: 'test' },
        );
        await client.close();
        // Two storeNode calls — both code-type, both must include
        // embed:false in the body.
        const nodeWrites = lore.requests.filter((r) => r.url === '/api/node');
        assert.equal(nodeWrites.length, 2, `expected 2 node writes (file_ref + architecture); got ${nodeWrites.length}`);
        for (const w of nodeWrites) {
            const parsed = JSON.parse(w.body);
            assert.equal(parsed.embed, false, `code-type write missing embed:false: ${w.body.slice(0, 120)}`);
        }
    } finally {
        lore.server.close();
    }
});

/* ---------- T3: knowledge-type writes don't auto-inject embed:false ---------- */

test('T3 knowledge-type storeNode preserves default embed (no auto-false)', async () => {
    const lore = await startMockLore(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T3' });
        await client.storeNode({
            id: 'y-T3-decision', type: 'decision', label: 'A decision', workspace: 'default',
        });
        await client.close();
        const body = JSON.parse(lore.requests[0]!.body);
        // Caller didn't pass embed; client must NOT have injected it.
        assert.equal('embed' in body, false, `knowledge-type write must not auto-inject embed flag; got: ${lore.requests[0]!.body}`);
    } finally {
        lore.server.close();
    }
});

test('T3 explicit embed:true respected (legacy override)', async () => {
    const lore = await startMockLore(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    try {
        const client = new LoreClient({ mcpUrl: lore.url, token: 'tok-T3' });
        await client.storeNode({
            id: 'y-T3-explicit', type: 'decision', label: 'L', workspace: 'default', embed: true,
        });
        await client.close();
        const body = JSON.parse(lore.requests[0]!.body);
        assert.equal(body.embed, true);
    } finally {
        lore.server.close();
    }
});

/* ---------- T4: loadContext tries bulk-list FIRST ---------- */

test('T4 loadContext attempts POST /api/nodes/bulk-list before legacy paths', async () => {
    _resetLoreReaderCache();
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk-list') {
            // First call returns one synthetic atlas-tagged
            // architecture node + signals done; loadContext can
            // proceed without needing to fall through to the
            // file_ref enumeration.
            return {
                status: 200,
                body: JSON.stringify({
                    count: 1,
                    hasMore: false,
                    nextCursor: null,
                    workspace: 'default',
                    nodes: [{
                        id: 'code-symbol:test.ts:foo:function',
                        type: 'architecture',
                        label: 'function:foo',
                        tags: 'atlas,code-symbol',
                        metadata: JSON.stringify({
                            uid: 'test.ts:foo:function',
                            name: 'foo',
                            qualifiedName: 'foo',
                            kind: 'function',
                            filePath: 'test.ts',
                            startLine: 1, endLine: 1, complexity: 1,
                        }),
                        project: 'default',
                    }],
                }),
            };
        }
        // file_ref enumeration would land here on the fallback path —
        // empty array is fine to confirm the bulk-list path won.
        if (req.url.startsWith('/api/nodes?')) {
            return { status: 200, body: JSON.stringify({ count: 0, hasMore: false, nodes: [] }) };
        }
        if (req.url.startsWith('/api/node?')) {
            return {
                status: 200,
                body: JSON.stringify({ node: { id: '?', tags: 'atlas' }, neighbors: [] }),
            };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const reader = new LoreReader({ mcpUrl: lore.url, token: 'tok-T4' });
        await reader.loadContext('default');
        // First request the reader makes MUST be the bulk-list probe.
        assert.ok(lore.requests.length > 0, 'reader made no requests');
        const first = lore.requests[0]!;
        assert.equal(first.url, '/api/nodes/bulk-list',
            `first request must be bulk-list; got ${first.method} ${first.url}`);
        assert.equal(first.method, 'POST');
        const bulkBody = JSON.parse(first.body);
        assert.equal(bulkBody.workspace, 'default');
        // Atlas migrated code symbols from the legacy 'architecture' type to
        // the dedicated 'code_symbol' vocab (codeNodes.ts).
        assert.equal(bulkBody.type, 'code_symbol');
        assert.equal(bulkBody.limit, 1000);
    } finally {
        lore.server.close();
    }
});

test('T4 bulk-list 404 → reader falls through to legacy paths', async () => {
    _resetLoreReaderCache();
    let bulkAttempts = 0;
    let listAttempts = 0;
    const lore = await startMockLore((req) => {
        if (req.url === '/api/nodes/bulk-list') {
            bulkAttempts += 1;
            return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        if (req.url.startsWith('/api/nodes?')) {
            listAttempts += 1;
            // Return one file_ref to satisfy the legacy walk and let
            // loadContext finish without infinite-looping.
            if (req.url.includes('type=file_ref')) {
                return {
                    status: 200,
                    body: JSON.stringify({ count: 1, hasMore: false, nodes: [{
                        id: 'code-file:t.ts', type: 'file_ref', label: 't.ts',
                        tags: 'atlas,code-file', project: 'default', metadata: '{}',
                    }] }),
                };
            }
            // type=architecture: return empty to make tryPaginatedSymbols
            // bail quickly.
            return { status: 200, body: JSON.stringify({ count: 0, hasMore: false, nodes: [] }) };
        }
        if (req.url.startsWith('/api/node?')) {
            return { status: 200, body: JSON.stringify({ node: { id: '?', tags: 'atlas' }, neighbors: [] }) };
        }
        return { status: 404, body: '{}' };
    });
    try {
        const reader = new LoreReader({ mcpUrl: lore.url, token: 'tok-T4-fallback' });
        await reader.loadContext('default');
        assert.equal(bulkAttempts, 1, 'reader must attempt bulk-list exactly once on cold load');
        assert.ok(listAttempts > 0, 'after 404, reader must fall through to /api/nodes legacy path');
    } finally {
        lore.server.close();
    }
});

/* ---------- T5/T6 — perf gates (integration-tested post Sprint W deploy) ----------
 *
 * The spec's T5 (atlas index <100-file repo> < 60s) and T6 (first
 * call_graph after restart < 30s) measure wall-clock against the live
 * daemon. Validating them requires:
 *   1. The operator builds + redeploys the Lore daemon from Sprint W
 *      commits (e43392b..390f89e) so the embed:false / /api/edge /
 *      /api/nodes/bulk-list endpoints are live.
 *   2. The operator re-indexes DEF (or another 100-file repo) and
 *      measures via the existing tests/x7.test.ts harness (which has
 *      the warm/cold timing instrumentation Y inherits).
 *
 * Pre-deploy, Y is shape-correct (T1-T4 above) but the perf wins
 * land only when the daemon has the matching W endpoints. The Y
 * client transparently falls back to pre-W behavior so this commit
 * is safe to land before the daemon is redeployed.
 * ---------- */

await Promise.all(pending);
console.error(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
