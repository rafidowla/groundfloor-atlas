/**
 * tests/audit-medium.test.ts — regression tests for the confirmed medium/low
 * audit findings (second fix round).
 *
 * Shape follows tests/audit-high-severity.test.ts: node:assert/strict, async
 * main(), '  ✓ CLAIM …' lines, ends `await main()`.
 *
 * FINDINGS COVERED:
 *  M1. Nested-function calls double-counted + misattributed (all walkers) —
 *      fixed via extractCallsInBody nested-scope skip + innermostContainingSymbol.
 *  M2. Group code-graph import re-embedded every code node — per-type embed
 *      flag + per-node bulk/serial partition in ingestPendingNodes.
 *  M3. Sidecar: crashes never auto-restarted, deliberate restarts logged as
 *      crashes, respawn raced the port, no spawn 'error' listener.
 *  M4. Writer-lock empty-payload steal window (two live writers).
 *  L1/L2. Edge-dedup keys: raw NUL bytes in subgraph.ts source; fullGraph
 *      used a space separator that collides on paths containing spaces.
 *  L3. Non-atomic config.json writes (writeLLMConfig / writeCloudSyncConfig).
 *  L5. BatchWriter reported attempted (not landed) node/edge counts.
 *  L6. serializeGroupYaml didn't quote scalars containing ':' / '#'.
 *
 * NOT directly tested here (verified by tsc + existing suites): M5
 * (alerts_dismiss embedded branch — mirrors knowledge_store's, exercised via
 * the tool contract), M6 (borrow conversion — type-checked; rc-hardening's
 * eviction tests cover the registry), M7 (ownership guard — string-level
 * change covered by groups tests), M8 (needs a live daemon mock), M9 (needs
 * the Tauri runtime), L4 (needs a long-lived SSE client).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── M1 — nested calls counted once, owned by the innermost function ─────────
async function testNestedCallAttribution(cleanup: string[]): Promise<void> {
    console.log('\n[M1] MEDIUM — nested-function calls double-counted/misattributed');
    const { parseFile } = await import('../src/parser/index.js');
    const dir = mkTmp('atlas-audit-m1-');
    cleanup.push(dir);

    // TypeScript: arrow closure + named inner function inside an outer fn.
    const tsFile = path.join(dir, 'sample.ts');
    fs.writeFileSync(tsFile, [
        'export function outer(): void {',
        '    helperA();',
        '    const inner = () => {',
        '        helperB();',
        '    };',
        '    function namedInner(): void {',
        '        helperC();',
        '    }',
        '    inner();',
        '    namedInner();',
        '}',
        'function helperA(): void {}',
        'function helperB(): void {}',
        'function helperC(): void {}',
        '',
    ].join('\n'));
    const ts = await parseFile(tsFile, dir);
    assert.ok(ts, 'TS parsed');
    const tsCalls = ts!.calls;
    const count = (name: string) => tsCalls.filter((c) => c.calleeName === name).length;
    assert.equal(count('helperB'), 1, 'CLAIM M1a: closure call counted once (was double-counted)');
    assert.equal(count('helperC'), 1, 'CLAIM M1a: named-inner call counted once');
    const cOwner = tsCalls.find((c) => c.calleeName === 'helperC')?.callerSymbolId ?? '';
    assert.ok(cOwner.includes('namedInner'), `CLAIM M1b: inner call owned by innermost fn (got ${cOwner})`);
    console.log('  ✓ CLAIM M1a/b: TS nested calls single-counted, owned by innermost function');

    // Python: inner def.
    const pyFile = path.join(dir, 'sample.py');
    fs.writeFileSync(pyFile, [
        'def outer():',
        '    helper_a()',
        '    def inner():',
        '        helper_b()',
        '    inner()',
        '',
        'def helper_a():',
        '    pass',
        '',
        'def helper_b():',
        '    pass',
        '',
    ].join('\n'));
    const py = await parseFile(pyFile, dir);
    const pyCalls = py!.calls;
    assert.equal(pyCalls.filter((c) => c.calleeName === 'helper_b').length, 1,
        'CLAIM M1c: Python inner-def call counted once');
    console.log('  ✓ CLAIM M1c: Python nested def single-counted');
}

// ── M2 — group import: per-type embed flag + per-node bulk partition ────────
async function testGroupImportEmbed(cleanup: string[]): Promise<void> {
    console.log('\n[M2] MEDIUM — group code-graph import re-embedded every code node');
    const { importMemory } = await import('../src/cli/memorySync.js');
    type MemoryImportWriter = import('../src/cli/memorySync.js').MemoryImportWriter;
    const dir = mkTmp('atlas-audit-m2-');
    cleanup.push(dir);

    const storeNodeCalls: Array<{ id: string; embed: unknown }> = [];
    const bulkCalls: Array<{ ids: string[]; vecLens: number[] }> = [];
    const client: MemoryImportWriter = {
        async storeNode(input) {
            storeNodeCalls.push({ id: input.id, embed: (input as { embed?: unknown }).embed });
            return {};
        },
        async storeEdge() { /* no edges in this fixture */ },
        async bulkStoreNodesWithVectors(nodes, vectors) {
            bulkCalls.push({ ids: nodes.map((n) => n.id), vecLens: vectors.map((v) => v.length) });
            return { ok: true, count: nodes.length, succeeded: nodes.length, results: nodes.map((n) => ({ ok: true, id: n.id })) };
        },
    };

    // The M2 fix lives in the SHARED ingest path (ingestPendingNodes), which
    // importMemory drives. Feed it a MIXED v2 batch — one node carrying a
    // precomputed vector, one without — the same shape as the G-3 code-graph
    // co-load (code_context cards carry vectors; graph-only types don't).
    const jsonl = [
        JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sourceWorkspace: 'src' }),
        JSON.stringify({ kind: 'node', id: 'k1', type: 'decision', label: 'with vec', content: 'has vector', embedding: [0.1, 0.2] }),
        JSON.stringify({ kind: 'node', id: 'k2', type: 'decision', label: 'no vec', content: 'needs re-embed' }),
        '',
    ].join('\n');
    const inPath = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(inPath, jsonl);
    const r = await importMemory(client, 'targetws', inPath);
    assert.equal(r.errors.length, 0, `import clean: ${JSON.stringify(r.errors)}`);
    assert.equal(r.nodeCount, 2, 'both nodes imported');

    // CLAIM M2a — the vector-carrying node took the bulk path; the vector-less
    // node went serial. BEFORE the fix, one vector-less node dragged BOTH into
    // the serial path (and re-embedded the vector-carrying one).
    assert.equal(bulkCalls.length, 1, 'CLAIM M2a: vector-carrying subset took the bulk path');
    assert.deepEqual(bulkCalls[0]!.ids, ['k1'], 'bulk got only the vector-carrying node');
    assert.equal(storeNodeCalls.length, 1, 'serial path got only the vector-less node');
    assert.equal(storeNodeCalls[0]!.id, 'k2');
    assert.equal(storeNodeCalls[0]!.embed, true, 'knowledge node still re-embeds');
    console.log('  ✓ CLAIM M2a: mixed batches partition per-node (bulk for vectors, serial for the rest)');

    // CLAIM M2b — graph-only code types get embed:false. Assert the type set
    // the flag keys off is exactly the 4 never-embedded types (code_context
    // keeps embed:true — it carries vectors at index time).
    const { GRAPH_ONLY_CODE_TYPES, CODE_TYPE_SET } = await import('../src/cli/codeGraphSync.js');
    assert.deepEqual([...GRAPH_ONLY_CODE_TYPES].sort(),
        ['code_file', 'code_folder', 'code_import', 'code_symbol'],
        'CLAIM M2b: graph-only set = the 4 never-embedded code types');
    assert.ok(CODE_TYPE_SET.has('code_context') && !GRAPH_ONLY_CODE_TYPES.has('code_context'),
        'code_context keeps embed:true (it carries vectors)');
    console.log('  ✓ CLAIM M2b: graph-only code types are embed:false; code_context keeps its vector path');
}

// ── M3 — sidecar crash auto-restart + quiet deliberate stop ─────────────────
async function testSidecarRestart(cleanup: string[]): Promise<void> {
    console.log('\n[M3] MEDIUM — sidecar crash/restart lifecycle races');
    const { startLore } = await import('../src/sidecar/loreSidecar.js');
    const dir = mkTmp('atlas-audit-m3-');
    cleanup.push(dir);

    // Fake Lore that dies after ~250ms (a crash loop). startLore's guards
    // require an owned, non-group/world-writable .js file.
    const crashy = path.join(dir, 'crashy-lore.js');
    fs.writeFileSync(crashy, 'setTimeout(() => process.exit(1), 250);\n', { mode: 0o600 });

    const events: string[] = [];
    const h = startLore({ loreBinPath: crashy, dataDir: dir, port: 39_991, token: 't' });
    h.on('crash', () => events.push('crash'));
    h.on('restart', () => events.push('restart'));
    const failed = new Promise<void>((resolve) => h.on('failed', () => resolve()));
    const timeout = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timed out waiting for failed event')), 20_000));
    await Promise.race([failed, timeout]);
    h.close();

    const crashes = events.filter((e) => e === 'crash').length;
    const restarts = events.filter((e) => e === 'restart').length;
    assert.ok(crashes >= 3, `CLAIM M3a: crashes detected (got ${crashes})`);
    assert.equal(restarts, 3, 'CLAIM M3a: each crash auto-restarted (3 attempts before giving up)');
    console.log('  ✓ CLAIM M3a: a crashing Lore auto-restarts up to MAX_RESTARTS, then emits failed');

    // Deliberate close: a healthy fake Lore, closed by us — NO crash event.
    const healthy = path.join(dir, 'healthy-lore.js');
    fs.writeFileSync(healthy, 'setInterval(() => {}, 1000);\n', { mode: 0o600 });
    let crashedOnClose = false;
    const h2 = startLore({ loreBinPath: healthy, dataDir: dir, port: 39_992, token: 't' });
    h2.on('crash', () => { crashedOnClose = true; });
    await new Promise((r) => setTimeout(r, 300)); // let it boot
    h2.close();
    await new Promise((r) => setTimeout(r, 800)); // outlive the 2s? no — poll is 100ms; 800ms is plenty for SIGTERM
    assert.equal(crashedOnClose, false, 'CLAIM M3b: deliberate close does not emit crash');
    console.log('  ✓ CLAIM M3b: close() stays quiet (no spurious crash event)');
}

// ── M4 — writer-lock empty-payload steal window ──────────────────────────────
async function testWriterLock(cleanup: string[]): Promise<void> {
    console.log('\n[M4] MEDIUM — writer-lock empty-payload steal window');
    const { acquireWorkspaceWriteLock, WorkspaceLockedError, WRITER_LOCK_BASENAME } = await import('../src/lore/writerLock.js');
    const dir = mkTmp('atlas-audit-m4-');
    cleanup.push(dir);
    const lockPath = path.join(dir, WRITER_LOCK_BASENAME);

    // Baseline: a live holder rejects a second acquire.
    const h1 = acquireWorkspaceWriteLock(dir);
    assert.throws(() => acquireWorkspaceWriteLock(dir), WorkspaceLockedError, 'live holder rejects');
    h1.release();

    // CLAIM M4a — a FRESH empty lock file (the openSync→writeSync race window)
    // must be treated as a live contender, NOT stolen.
    fs.writeFileSync(lockPath, '');
    assert.throws(() => acquireWorkspaceWriteLock(dir), WorkspaceLockedError,
        'CLAIM M4a: fresh empty lock is not stealable (live winner mid-write)');
    console.log('  ✓ CLAIM M4a: fresh empty-payload lock treated as locked, not stolen');

    // CLAIM M4b — an OLD empty lock file (a crash long ago) stays stealable.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const h2 = acquireWorkspaceWriteLock(dir);
    h2.release();
    console.log('  ✓ CLAIM M4b: genuinely stale empty lock still stolen');
}

// ── L1/L2 — edge dedup keys survive spaced node ids; no NUL bytes in source ──
async function testEdgeDedupKeys(cleanup: string[]): Promise<void> {
    console.log('\n[L1/L2] LOW — edge-dedup key collisions + NUL bytes in source');
    void cleanup;
    const { buildFullGraph } = await import('../src/graph/fullGraph.js');

    // Two edges that collide under a SPACE-joined key but are distinct:
    //   ("x y" → "z", calls)  vs  ("x" → "y z", calls)
    // Node ids embed repo-relative paths, which can legally contain spaces.
    const nodes = [
        { id: 'x y', type: 'code_file', label: 'x y' },
        { id: 'z', type: 'code_file', label: 'z' },
        { id: 'x', type: 'code_file', label: 'x' },
        { id: 'y z', type: 'code_file', label: 'y z' },
    ];
    const reader = {
        async listNodes(type?: string) { return type === 'code_file' ? nodes : []; },
        async listEdges() {
            return [
                { sourceId: 'x y', targetId: 'z', relation: 'calls' },
                { sourceId: 'x', targetId: 'y z', relation: 'calls' },
            ];
        },
        async getNode() { return null; },
    };
    const g = await buildFullGraph(reader as never, 'ws', { nodeTypes: ['code_file'] });
    assert.equal(g.edges.length, 2,
        `CLAIM L2: both spaced-id edges survive dedup (got ${g.edges.length} — a space-joined key drops one)`);
    console.log('  ✓ CLAIM L2: fullGraph dedup no longer collapses distinct edges with spaced ids');

    // CLAIM L1 — the subgraph source must be plain text (no raw NUL bytes).
    const src = fs.readFileSync(new URL('../src/graph/subgraph.ts', import.meta.url));
    assert.ok(!src.includes(0x00), 'CLAIM L1: subgraph.ts contains no raw NUL bytes');
    console.log('  ✓ CLAIM L1: subgraph.ts is NUL-free (tools stop classifying it as binary)');
}

// ── L3 — atomic config writes ────────────────────────────────────────────────
async function testAtomicConfigWrites(cleanup: string[]): Promise<void> {
    console.log('\n[L3] LOW — non-atomic config.json writes');
    const { writeLLMConfig, writeCloudSyncConfig, loadConfig } = await import('../src/config.js');
    const home = mkTmp('atlas-audit-l3-');
    cleanup.push(home);

    writeLLMConfig({ provider: 'openai', model: 'gpt-x', apiKey: 'k' } as never, home);
    writeCloudSyncConfig({ enabled: true, cloudMcpUrl: 'https://x', syncDirection: 'push', apiKey: 'c' } as never, home);

    const cfg = loadConfig();
    void cfg; // loadConfig reads the DEFAULT home; the assertions below read the file directly.
    const written = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(written['llm']?.['provider'], 'openai', 'llm block persisted');
    assert.equal(written['cloudSync']?.['enabled'], true, 'cloudSync block merged into the SAME file (no clobber)');
    const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0, 'CLAIM L3: temp+rename leaves no .tmp files behind');
    console.log('  ✓ CLAIM L3: config writes go through temp+rename, both blocks survive');
}

// ── L5 — BatchWriter counts landed, not attempted ────────────────────────────
async function testBatchWriterCounts(cleanup: string[]): Promise<void> {
    console.log('\n[L5] LOW — BatchWriter over-reported written counts');
    void cleanup;
    const { BatchWriter } = await import('../src/cli/batchWriter.js');

    // One node of three fails; one edge of two fails.
    const client = {
        async bulkStoreNodes(chunk: Array<{ id: string }>) {
            return { results: chunk.map((n, i) => ({ ok: i !== 0, id: n.id, error: i === 0 ? 'boom' : undefined })) };
        },
        async bulkStoreEdges(chunk: Array<{ sourceId: string }>) {
            return { results: chunk.map((e, i) => ({ ok: i !== 0, error: i === 0 ? 'edge boom' : undefined })) };
        },
    };
    let lastSummary: { nodesFlushed: number; edgesFlushed: number } | null = null;
    const writer = new BatchWriter(client as never, {
        batchSize: 1,
        onProgress: (_line: string, summary: { nodesFlushed: number; edgesFlushed: number }) => { lastSummary = summary; },
    });
    const mkNode = (id: string) => ({ id, type: 'code_file', label: id, workspace: 'ws', embed: false }) as never;
    const mkEdge = (s: string, t: string) => ({ sourceId: s, targetId: t, relation: 'calls', workspace: 'ws' }) as never;
    await writer.add('/repo/a.ts', [mkNode('n1'), mkNode('n2'), mkNode('n3')], [mkEdge('n1', 'n2'), mkEdge('n2', 'n3')]);

    assert.ok(lastSummary, 'progress summary emitted');
    assert.equal(lastSummary!.nodesFlushed, 2, 'CLAIM L5: nodesFlushed counts landed (2 of 3), not attempted');
    assert.equal(lastSummary!.edgesFlushed, 1, 'CLAIM L5: edgesFlushed counts landed (1 of 2), not attempted');
    console.log('  ✓ CLAIM L5: flushed counts reflect what actually landed');
}

// ── L6 — group.yaml scalar quoting round-trips ───────────────────────────────
async function testGroupYamlQuoting(cleanup: string[]): Promise<void> {
    console.log('\n[L6] LOW — serializeGroupYaml corrupted names containing : or #');
    void cleanup;
    const { serializeGroupYaml, parseGroupYaml } = await import('../src/cli/groupYaml.js');
    const decl = {
        name: 'my group',
        members: [
            { name: 'weird: name#1', remote: 'github.com/org/repo-one', path: '../repo-one' },
            { name: 'plain', path: '.' },
        ],
    };
    const text = serializeGroupYaml(decl);
    const back = parseGroupYaml(text);
    assert.ok(back, 'serialized yaml re-parses');
    assert.equal(back!.members[0]!.name, 'weird: name#1', 'CLAIM L6: colon+hash name survives the round-trip');
    assert.equal(back!.members[1]!.name, 'plain');
    assert.equal(back!.members[0]!.remote, 'github.com/org/repo-one');
    console.log('  ✓ CLAIM L6: names with : and # round-trip through serialize→parse');
}

async function main(): Promise<void> {
    console.log('Running audit medium/low regression tests…');
    const cleanup: string[] = [];
    try {
        await testNestedCallAttribution(cleanup);
        await testGroupImportEmbed(cleanup);
        await testSidecarRestart(cleanup);
        await testWriterLock(cleanup);
        await testEdgeDedupKeys(cleanup);
        await testAtomicConfigWrites(cleanup);
        await testBatchWriterCounts(cleanup);
        await testGroupYamlQuoting(cleanup);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log('\nAll audit medium/low regression tests passed ✓');
}

await main();
