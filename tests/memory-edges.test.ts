/**
 * tests/memory-edges.test.ts — G-2 edge foundation guard.
 *
 * The Wave-3 memory.jsonl round-trip (export → import) had ZERO coverage, so
 * the silent edge-drop bug (in-repo edges vanished on import while edgeCount
 * still claimed success) was completely unguarded. This test locks in the
 * fixes:
 *
 *   CLAIM 1 — in-repo edge survives export → import (nodes-before-edges).
 *   CLAIM 2 — a cross-seam edge (local source → foreign target) is CARRIED
 *             by export (the owner repo's memory.jsonl).
 *   CLAIM 3 — storeEdge READS the row back and THROWS on the silent
 *             MATCH..CREATE no-op, so edgeCount can never lie again.
 *   loadGroup — co-loading two members resolves the cross-seam edge that a
 *             single-repo import correctly defers; the collision detector
 *             warns (non-fatally) when an id appears in two members.
 *
 * Runs against a real in-process Lore (kuzu+lancedb+e5-small), the same way
 * embedded.test.ts does.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { exportMemory, importMemory, loadGroup } from '../src/cli/memorySync.js';
import type { StoreNodeInput } from '../src/loreClient.js';

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-g2-${tag}-`));
}

function decisionNode(id: string, label: string, ws: string): StoreNodeInput {
    return { id, type: 'decision', label, workspace: ws, embed: true, content: label } as StoreNodeInput;
}

async function main(): Promise<void> {
    console.log('Atlas G-2 edge foundation tests');

    // ── CLAIM 3 — storeEdge surfaces the silent no-op as a throw ──────────────
    {
        const dir = tmpDir('claim3');
        const lore = await EmbeddedLore.open(dir);
        await lore.connect();
        try {
            const WS = 'p3';
            await lore.storeNode(decisionNode('dec-A', 'decision A', WS));
            // Target node was never stored → addEdge's MATCH..CREATE no-ops.
            let threw = false;
            try {
                await lore.storeEdge({ sourceId: 'dec-A', targetId: 'ghost-Z', relation: 'related_to', workspace: WS });
            } catch (err) {
                threw = true;
                assert.match((err as Error).message, /endpoint[_ ]missing/i, 'throws endpoint-missing, not a generic error');
            }
            assert.ok(threw, 'storeEdge THROWS when an endpoint is missing (no silent no-op)');
            const edges = await lore.listEdges();
            assert.equal(edges.length, 0, 'no phantom edge persisted');
            console.log('  ✓ CLAIM 3: storeEdge throws on missing endpoint; nothing persisted');

            // And the happy path still persists + verifies clean.
            await lore.storeNode(decisionNode('dec-B', 'decision B', WS));
            await lore.storeEdge({ sourceId: 'dec-A', targetId: 'dec-B', relation: 'related_to', workspace: WS });
            const after = await lore.listEdges();
            assert.ok(after.some((e) => e.sourceId === 'dec-A' && e.targetId === 'dec-B'), 'real edge persists when both endpoints exist');
            console.log('  ✓ CLAIM 3: real edge (both endpoints present) persists + read-back verifies');
        } finally {
            await lore.close();
        }
    }

    // ── CLAIM 1 — in-repo edge survives export → import ───────────────────────
    {
        const srcDir = tmpDir('claim1-src');
        const dstDir = tmpDir('claim1-dst');
        const file = path.join(tmpDir('claim1-file'), 'memory.jsonl');
        const WS = 'p1';

        // NOTE: we assert on the AUTHORED `related_to` edge specifically, not on
        // the raw edge COUNT. Lore's background autolink can add an extra
        // `semantic_neighbor:<score>` edge between two semantically-similar
        // decisions (non-deterministic timing), so a hard `edgeCount === 1`
        // is flaky. We use deliberately DISSIMILAR content to keep the autolink
        // quiet, and verify the authored edge survives by relation, which is the
        // behaviour the shipped bug actually regressed.
        const src = await EmbeddedLore.open(srcDir);
        await src.connect();
        try {
            await src.storeNode(decisionNode('dec-A', 'auth token rotation: rotate JWT signing keys every 24h via KMS', WS));
            await src.storeNode(decisionNode('dec-B', 'postgres pooling: pgbouncer transaction mode, 200 max client conns', WS));
            await src.storeEdge({ sourceId: 'dec-A', targetId: 'dec-B', relation: 'related_to', workspace: WS });
            const exp = await exportMemory(src, WS, file);
            assert.equal(exp.nodeCount, 2, `export carries 2 nodes; got ${exp.nodeCount}`);
            assert.ok(exp.edgeCount >= 1, `export carries the in-repo edge; got ${exp.edgeCount}`);
            // The AUTHORED edge must be in the file (an inferred autolink edge,
            // if present, is extra — never a substitute for the authored one).
            const body = fs.readFileSync(file, 'utf8');
            assert.match(body, /"sourceId":"dec-A","targetId":"dec-B","relation":"related_to"/,
                'authored dec-A→dec-B related_to edge is in the export file');
        } finally {
            await src.close();
        }

        // Import into a FRESH dataDir.
        const dst = await EmbeddedLore.open(dstDir);
        await dst.connect();
        try {
            const imp = await importMemory(dst, WS, file);
            assert.equal(imp.nodeCount, 2, `import lands 2 nodes; got ${imp.nodeCount}`);
            // edgeCount must EQUAL the number of edge lines in the file (verified,
            // never inflated by silent no-ops) — whether that's 1 (authored only)
            // or 2 (authored + an autolink edge that rode along in the export).
            const exportedEdgeLines = fs.readFileSync(file, 'utf8')
                .split('\n').filter((l) => l.includes('"kind":"edge"')).length;
            assert.equal(imp.edgeCount, exportedEdgeLines,
                `import lands exactly the exported edges (verified, not inflated); got ${JSON.stringify(imp)} vs ${exportedEdgeLines} lines`);
            assert.equal(imp.deferredEdges.length, 0, 'no deferred edges — both endpoints were in-file');

            // Hard proof: the AUTHORED edge ACTUALLY persisted by relation (the
            // old bug reported edgeCount:1 while listEdges() returned 0).
            const edges = await dst.listEdges();
            assert.ok(edges.some((e) => e.sourceId === 'dec-A' && e.targetId === 'dec-B' && e.relation === 'related_to'),
                `authored edge truly persisted after import; got ${JSON.stringify(edges)}`);
            const reached = await dst.traverse('dec-A', 1) as Array<{ node?: { id?: string } }>;
            assert.ok(reached.some((t) => t.node?.id === 'dec-B'), 'traverse(dec-A) reaches dec-B after import');
            console.log('  ✓ CLAIM 1: in-repo edge survives export→import (persisted + traversable)');
        } finally {
            await dst.close();
        }
    }

    // ── CLAIM 2 + loadGroup — cross-seam edge carried, deferred alone, resolved together ──
    {
        const atlasDir = tmpDir('claim2-atlas');
        const loreDir = tmpDir('claim2-lore');
        const groupDir = tmpDir('claim2-grp');
        const atlasFile = path.join(tmpDir('claim2-af'), 'atlas-memory.jsonl');
        const loreFile = path.join(tmpDir('claim2-lf'), 'lore-memory.jsonl');
        const WS = 'pg';

        // Atlas repo: a local decision references a FOREIGN (lore) decision.
        // Decisively isolate the export-filter relax (diagnosis CLAIM 2): the
        // target lore/dec-Y is stored under a DIFFERENT workspace in the same
        // dataDir, so the node physically EXISTS (the author-time storeEdge
        // read-back passes) but it is NOT in knowledgeIds for sourceWorkspace.
        // The OLD both-endpoints-local filter would have dropped this edge; the
        // relaxed source-only filter must carry it.
        // Use deliberately DISSIMILAR content for the two decisions so Lore's
        // background autolink does NOT add an inferred `semantic_neighbor` edge
        // between them — that would inflate the cross-seam edge count and make
        // the exact-count assertions below flaky (the authored `depends_on`
        // edge is what this claim is actually about).
        const FOREIGN_WS = 'lore-ws';
        const atlas = await EmbeddedLore.open(atlasDir);
        await atlas.connect();
        try {
            await atlas.storeNode(decisionNode('atlas/dec-001', 'atlas indexing: tree-sitter incremental parse on save', WS));
            await atlas.storeNode(decisionNode('lore/dec-Y', 'lore embeddings: e5-small multilingual at 384 dims', FOREIGN_WS));
            await atlas.storeEdge({ sourceId: 'atlas/dec-001', targetId: 'lore/dec-Y', relation: 'depends_on', workspace: WS });

            // Sanity: lore/dec-Y is NOT in the source workspace's knowledge set.
            const localDecisions = await atlas.listNodes('decision', undefined, WS) as Array<{ id?: string }>;
            assert.ok(!localDecisions.some((n) => n.id === 'lore/dec-Y'),
                'foreign target is genuinely out-of-workspace (isolation precondition)');

            const exp = await exportMemory(atlas, WS, atlasFile);
            const body = fs.readFileSync(atlasFile, 'utf8');
            assert.match(body, /"sourceId":"atlas\/dec-001".*"targetId":"lore\/dec-Y"/, 'cross-seam edge present in atlas export');
            assert.ok(exp.edgeCount >= 1, `relaxed source-only filter carries the cross-seam edge; got ${exp.edgeCount}`);
            // And the foreign-scope target is NOT itself exported (only WS nodes).
            assert.ok(!/"kind":"node".*"id":"lore\/dec-Y"/.test(body), 'foreign-scope target node is not exported (owner repo carries only the reference)');
            console.log('  ✓ CLAIM 2: cross-seam edge (local src → foreign tgt) carried; foreign node not exported');
        } finally {
            await atlas.close();
        }

        // Lore repo: owns the real lore/dec-Y, no edge.
        const lore = await EmbeddedLore.open(loreDir);
        await lore.connect();
        try {
            await lore.storeNode(decisionNode('lore/dec-Y', 'lore decision', WS));
            await exportMemory(lore, WS, loreFile);
        } finally {
            await lore.close();
        }

        // Single-file import of ONLY atlas into a fresh store: the atlas export
        // already contains just atlas/dec-001 + the cross-seam edge (the
        // foreign target was out-of-workspace, so it was never exported). The
        // edge must DEFER (target absent), not vanish and not error.
        const soloDir = tmpDir('claim2-solo');
        const solo = await EmbeddedLore.open(soloDir);
        await solo.connect();
        try {
            const imp = await importMemory(solo, WS, atlasFile);
            assert.equal(imp.nodeCount, 1, `solo import lands only atlas node; got ${imp.nodeCount}`);
            assert.equal(imp.edgeCount, 0, 'cross-seam edge does NOT persist alone (target absent)');
            // The authored depends_on edge must be among the deferred edges (every
            // exported edge whose target is the absent foreign node defers — that's
            // ≥1; we assert specifically on the authored one rather than an exact
            // count so a stray autolink edge can't make this flaky).
            assert.ok(imp.deferredEdges.length >= 1, `at least the cross-seam edge defers; got ${JSON.stringify(imp.deferredEdges)}`);
            assert.ok(imp.deferredEdges.some((e) => e.sourceId === 'atlas/dec-001' && e.targetId === 'lore/dec-Y' && e.relation === 'depends_on'),
                `authored cross-seam edge is DEFERRED, not lost; got ${JSON.stringify(imp.deferredEdges)}`);
            assert.equal(imp.errors.length, 0, 'deferral is not an error');
            console.log('  ✓ loadGroup precondition: cross-seam edge defers (surfaced) on single-repo import');
        } finally {
            await solo.close();
        }

        // Group co-load: atlas + lore together → the cross-seam edge resolves.
        const grp = await EmbeddedLore.open(groupDir);
        await grp.connect();
        try {
            const r = await loadGroup(grp, WS, [atlasFile, loreFile]);
            assert.equal(r.nodeCount, 2, `group loads atlas + lore node; got ${r.nodeCount}`);
            assert.ok(r.edgeCount >= 1, `cross-seam edge RESOLVES in group co-load; got ${JSON.stringify(r)}`);
            assert.equal(r.deferredEdges.length, 0, 'no deferred edges — foreign target supplied by sibling member');
            const edges = await grp.listEdges();
            assert.ok(edges.some((e) => e.sourceId === 'atlas/dec-001' && e.targetId === 'lore/dec-Y' && e.relation === 'depends_on'),
                `authored cross-seam edge persisted via group co-load; got ${JSON.stringify(edges)}`);
            // Core proof: the cross-seam edge is TRAVERSABLE after co-load.
            const reached = await grp.traverse('atlas/dec-001', 1) as Array<{ node?: { id?: string } }>;
            assert.ok(reached.some((t) => t.node?.id === 'lore/dec-Y'),
                `traverse(atlas/dec-001) reaches lore/dec-Y after co-load; got ${JSON.stringify(reached.map((t) => t.node?.id))}`);
            console.log('  ✓ loadGroup: cross-seam edge atlas/dec-001 → lore/dec-Y resolves + traverses when co-loaded');
        } finally {
            await grp.close();
        }

        // Collision detector: co-load two members that both carry the SAME id.
        // Build a second member that re-uses lore/dec-Y (an un-namespaced id a
        // careless author might duplicate across repos).
        const dupFile = path.join(tmpDir('claim2-dup'), 'dup-memory.jsonl');
        {
            const header = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sourceWorkspace: WS, exportedTypes: ['decision'] });
            const node = JSON.stringify({ kind: 'node', id: 'lore/dec-Y', type: 'decision', label: 'duplicate id in another member' });
            fs.writeFileSync(dupFile, `${header}\n${node}\n`);
        }
        const collDir = tmpDir('claim2-coll');
        const coll = await EmbeddedLore.open(collDir);
        await coll.connect();
        try {
            // Both loreFile and dupFile carry lore/dec-Y → collision.
            const r = await loadGroup(coll, WS, [loreFile, dupFile]);
            assert.ok(r.collisions.some((c) => c.id === 'lore/dec-Y' && c.members.length === 2),
                `collision detector flags the duplicated id; got ${JSON.stringify(r.collisions)}`);
            console.log('  ✓ loadGroup: collision detector WARNS (non-fatally) on duplicated knowledge id');
        } finally {
            await coll.close();
        }
    }

    // ── Wave-3 moat guard: the FULL lockin round-trip (export/import didn't
    //    regress it). Seed a decision (embed:true) → export → import into a
    //    FRESH workspace → recall with a query that shares NO literal keyword
    //    with the content → the decision must still be found semantically. This
    //    is the irreplaceable moat; if it breaks, G-2 broke memory sync. ──
    {
        const srcDir = tmpDir('moat-src');
        const dstDir = tmpDir('moat-dst');
        const file = path.join(tmpDir('moat-file'), 'memory.jsonl');
        const WS = 'pm';
        const MOAT_ID = 'dec-moat-transport';
        const CONTENT = 'We adopted an in-process embedded engine instead of a separate networked daemon so memory sync needs no port, token, or running service.';
        // No-shared-keyword query: none of these words appear in CONTENT.
        const QUERY = 'how do teammates share institutional knowledge without standing up infrastructure';

        const src = await EmbeddedLore.open(srcDir);
        await src.connect();
        try {
            await src.storeNode({ id: MOAT_ID, type: 'decision', label: 'transport choice for memory sync', content: CONTENT, workspace: WS, embed: true } as StoreNodeInput);
            await exportMemory(src, WS, file);
        } finally {
            await src.close();
        }

        const dst = await EmbeddedLore.open(dstDir);
        await dst.connect();
        try {
            const imp = await importMemory(dst, WS, file);
            assert.equal(imp.nodeCount, 1, `moat decision imported into fresh workspace; got ${imp.nodeCount}`);
            // The embedding write settles into LanceDB a beat after import returns.
            await new Promise((r) => setTimeout(r, 1500));
            const res = await dst.recall(QUERY, { max: 10 }) as { hits?: Array<{ id?: string }> };
            const hits = res.hits ?? [];
            assert.ok(hits.some((h) => h.id === MOAT_ID),
                `WAVE-3 MOAT: decision recalled by no-shared-keyword query after export→import into a fresh workspace; got ${JSON.stringify(hits.map((h) => h.id))}`);
            console.log(`  ✓ moat: Wave-3 lockin round-trip intact — no-shared-keyword recall finds the imported decision`);
        } finally {
            await dst.close();
        }
    }

    console.log('All G-2 edge foundation tests passed.');
}

await main();
