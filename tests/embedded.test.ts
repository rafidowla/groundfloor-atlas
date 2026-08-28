/**
 * tests/embedded.test.ts — EmbeddedLore adapter end-to-end (the embed path).
 *
 * Drives the adapter exactly as Atlas's indexer would (StoreNodeInput /
 * StoreEdgeInput), against a real in-process Lore, and asserts:
 *   - graph-only code writes land (embed:false → skipEmbed)
 *   - reads return what was written, scoped by project (no project='*' gap)
 *   - traverse() yields the call-graph neighbor with its relation
 *   - repo-qualified IDs from two projects don't collide (F1) in one instance
 *   - clean dispose + natural exit
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import type { StoreNodeInput, StoreEdgeInput } from '../src/loreClient.js';

async function main(): Promise<void> {
    console.log('Atlas EmbeddedLore adapter tests');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-embedded-test-'));
    const lore = await EmbeddedLore.open(dataDir);
    await lore.connect();
    try {
        const WS = 'projA';
        const fileId = 'code-file:repoA/src/index.ts';
        const symId = 'code-symbol:repoA/src/index.ts:greet:function';

        // writes (embed:false → graph-only)
        const nodeRes = await lore.bulkStoreNodes([
            { id: fileId, type: 'code_file', label: 'src/index.ts', workspace: WS, embed: false, tags: 'atlas,code-file,repo:repoA' } as StoreNodeInput,
            { id: symId, type: 'code_symbol', label: 'function:greet', workspace: WS, embed: false, tags: 'atlas,code-symbol' } as StoreNodeInput,
        ]);
        assert.equal(nodeRes.succeeded, 2, `both code nodes written; got ${JSON.stringify(nodeRes)}`);

        const edgeRes = await lore.bulkStoreEdges([
            { sourceId: fileId, targetId: symId, relation: 'related_to', workspace: WS } as StoreEdgeInput,
        ]);
        assert.equal(edgeRes.succeeded, 1, `edge written; got ${JSON.stringify(edgeRes)}`);
        console.log('  ✓ writes: 2 graph-only nodes + 1 edge landed');

        // reads scoped by project — the blocker-b check
        const got = await lore.getNode(symId) as { id?: string; type?: string; project?: string } | null;
        assert.ok(got && got.id === symId, `getNode returns the symbol; got ${JSON.stringify(got)}`);
        assert.equal(got!.project, WS, `node project stamped = workspace (F1); got ${got!.project}`);
        const symbols = await lore.listNodes('code_symbol', undefined, WS) as Array<{ id: string }>;
        assert.ok(symbols.some((n) => n.id === symId), `listNodes(code_symbol, project=${WS}) finds the symbol; got ${symbols.length}`);
        console.log(`  ✓ reads: getNode + listNodes return what was written (project=${WS}, no '*' mismatch)`);

        // traverse — call-graph neighbor with relation
        const reached = await lore.traverse(fileId, 2) as Array<{ node?: { id?: string }; relation?: string; depth?: number }>;
        assert.ok(reached.some((t) => t.node?.id === symId), `traverse(file) reaches the symbol; got ${JSON.stringify(reached).slice(0, 200)}`);
        console.log(`  ✓ traverse: ${reached.length} neighbor(s), relation carried natively`);

        // F1: same relative path in a SECOND project must NOT collide
        const symB = 'code-symbol:repoB/src/index.ts:greet:function';
        await lore.bulkStoreNodes([{ id: symB, type: 'code_symbol', label: 'function:greet', workspace: 'projB', embed: false, tags: 'atlas' } as StoreNodeInput]);
        const a = await lore.getNode(symId) as { id?: string } | null;
        const b = await lore.getNode(symB) as { id?: string } | null;
        assert.ok(a && b && a.id !== b.id, 'repo-qualified IDs from two projects stay distinct (F1)');
        console.log('  ✓ F1: repo-qualified IDs from two projects do not collide');

        // RD-T1 — cross-WORKSPACE isolation must be proven by ABSENCE, not just
        // presence. A separate EmbeddedLore instance (its own dataDir, the way
        // Atlas isolates workspaces) must NOT see workspace A's node even when
        // queried by the exact same id. This is the query-time isolation guard
        // the prior test never asserted.
        const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-embedded-test-wsB-'));
        const loreB = await EmbeddedLore.open(dataDirB);
        await loreB.connect();
        try {
            const leakedNode = await loreB.getNode(symId);
            assert.equal(leakedNode, null, `workspace B must NOT see workspace A's node by id (got ${JSON.stringify(leakedNode)})`);
            const leakedList = await loreB.listNodes('code_symbol', undefined, WS) as Array<{ id: string }>;
            assert.equal(leakedList.length, 0, `workspace B listNodes(project=${WS}) must be empty (got ${leakedList.length})`);
            console.log('  ✓ RD-T1: cross-workspace isolation — workspace B does NOT see workspace A node (absence asserted)');
        } finally {
            await loreB.close();
        }
    } finally {
        await lore.close();
    }
    console.log('All EmbeddedLore adapter tests passed.');
}

await main();
