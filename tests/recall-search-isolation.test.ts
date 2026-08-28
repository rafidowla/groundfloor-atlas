/**
 * tests/recall-search-isolation.test.ts — cross-workspace isolation for
 * recall() and search()'s hybrid/semantic path.
 *
 * embedded.test.ts's RD-T1 proves getNode/listNodes isolation between two
 * EmbeddedLore instances, but only against an EMPTY second instance — it
 * never asserts that a SECOND instance holding its OWN real, embedded data
 * stays invisible to the first instance's semantic queries. That's the
 * scenario a workspace-scoping bug would actually manifest in (two live
 * workspaces, e.g. "alex-admin" and "developer", both populated).
 *
 * Both recall() and search()'s hybrid/semantic branch build their call to
 * the underlying engine with a hardcoded workspace constant and no `project`
 * filter at all — relying entirely on "one dataDir = one project" directory
 * isolation rather than a row-level filter. This pins that assumption
 * actually holds: instance A's recall/hybrid-search must never surface
 * instance B's node, and vice versa, even when both are populated with
 * content that would strongly match the same query.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import type { StoreNodeInput } from '../src/loreClient.js';

interface RecallResult { hits?: Array<{ id?: string }> }
interface SearchEnvelope { results?: Array<{ id?: string }> }

async function main(): Promise<void> {
    console.log('Atlas recall()/search() cross-workspace isolation tests');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-iso-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-iso-b-'));
    const loreA = await EmbeddedLore.open(dirA);
    const loreB = await EmbeddedLore.open(dirB);
    await loreA.connect();
    await loreB.connect();
    try {
        const idA = 'dec-iso-duckdb';
        const idB = 'dec-iso-clickhouse';

        await loreA.storeNode({
            id: idA, type: 'decision', label: 'analytics engine: DuckDB',
            content: 'We chose DuckDB as the embedded analytics database engine for local reporting because it runs in-process with zero setup.',
            workspace: 'workspace-a', embed: true,
        } as StoreNodeInput);
        await loreB.storeNode({
            id: idB, type: 'decision', label: 'analytics engine: ClickHouse',
            content: 'We chose ClickHouse as the analytics database engine for the reporting cluster because it scales horizontally across nodes.',
            workspace: 'workspace-b', embed: true,
        } as StoreNodeInput);
        await loreA.awaitEmbeds();
        await loreB.awaitEmbeds();

        const topic = 'which analytics database engine did we choose';

        // ── recall() ─────────────────────────────────────────────────────
        const recallA = (await loreA.recall(topic, { mode: 'full', max: 10 })) as RecallResult;
        const recallAIds = (recallA.hits ?? []).map((h) => h.id);
        assert.ok(recallAIds.includes(idA), `recall on A finds A's own node; got ${JSON.stringify(recallAIds)}`);
        assert.ok(!recallAIds.includes(idB), `recall on A must NOT surface B's node; got ${JSON.stringify(recallAIds)}`);

        const recallB = (await loreB.recall(topic, { mode: 'full', max: 10 })) as RecallResult;
        const recallBIds = (recallB.hits ?? []).map((h) => h.id);
        assert.ok(recallBIds.includes(idB), `recall on B finds B's own node; got ${JSON.stringify(recallBIds)}`);
        assert.ok(!recallBIds.includes(idA), `recall on B must NOT surface A's node; got ${JSON.stringify(recallBIds)}`);
        console.log('  ✓ recall(): A and B each see only their own node, never the other\'s');

        // ── search(), hybrid mode (Atlas's own default search_mode) ────────
        const searchA = (await loreA.search('analytics database engine', 10, undefined, 'workspace-a', 'hybrid')) as SearchEnvelope;
        const searchAIds = (searchA.results ?? []).map((r) => r.id);
        assert.ok(searchAIds.includes(idA), `hybrid search on A finds A's own node; got ${JSON.stringify(searchAIds)}`);
        assert.ok(!searchAIds.includes(idB), `hybrid search on A must NOT surface B's node; got ${JSON.stringify(searchAIds)}`);

        const searchB = (await loreB.search('analytics database engine', 10, undefined, 'workspace-b', 'hybrid')) as SearchEnvelope;
        const searchBIds = (searchB.results ?? []).map((r) => r.id);
        assert.ok(searchBIds.includes(idB), `hybrid search on B finds B's own node; got ${JSON.stringify(searchBIds)}`);
        assert.ok(!searchBIds.includes(idA), `hybrid search on B must NOT surface A's node; got ${JSON.stringify(searchBIds)}`);
        console.log('  ✓ search(hybrid): A and B each see only their own node, never the other\'s');
    } finally {
        await loreA.close();
        await loreB.close();
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
    console.log('All recall()/search() cross-workspace isolation tests passed.');
}

await main();
