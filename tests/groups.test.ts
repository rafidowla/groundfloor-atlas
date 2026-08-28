/**
 * tests/groups.test.ts — G-1 named group + provenance guard.
 *
 * G-2 gave us loadGroup(client, ws, files[]) + `atlas group load <f1> <f2>…`
 * (raw paths). G-1 adds ergonomics + PROVENANCE on top:
 *
 *   CLAIM A — DECLARE + RESOLVE: createGroup writes a named registry entry;
 *             resolveGroup maps each member to <path>/.atlas/memory.jsonl.
 *   CLAIM B — PROVENANCE: a named co-load stamps each member's nodes with
 *             project=<memberName> (+ metadata.sourceRepo), and recall —
 *             store-wide — finds BOTH members' decisions, each hit carrying
 *             the right source-repo provenance.
 *   CLAIM C — DEGRADE-DON'T-FAIL: a member whose memory.jsonl is missing is
 *             marked skipped (not thrown); the group still loads the rest.
 *   CLAIM D — v1 GUARD: a v1 (no-vectors) member is reported speed:'slow'
 *             (the re-embed path) while a v2-with-vectors member is 'fast'.
 *
 * Runs against a real in-process Lore (kuzu+lancedb+e5-small), like
 * memory-edges.test.ts / embedded.test.ts.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { exportMemory, loadGroup } from '../src/cli/memorySync.js';
import { createGroup, resolveGroup, listGroups, groupExists, MEMBER_MEMORY_RELPATH } from '../src/cli/groups.js';
import type { StoreNodeInput } from '../src/loreClient.js';

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-g1-${tag}-`));
}

function decisionNode(id: string, label: string, ws: string, content?: string): StoreNodeInput {
    return { id, type: 'decision', label, workspace: ws, embed: true, content: content ?? label } as StoreNodeInput;
}

/** Build a member checkout dir with a .atlas/memory.jsonl exported from `seed`. */
async function seedMember(tag: string, ws: string, seed: (lore: EmbeddedLore) => Promise<void>): Promise<string> {
    const checkout = tmpDir(`${tag}-co`);
    const dataDir = tmpDir(`${tag}-data`);
    const lore = await EmbeddedLore.open(dataDir);
    await lore.connect();
    try {
        await seed(lore);
        // Let the embedding settle into LanceDB BEFORE export so getEmbeddings
        // resolves vectors and the file is deterministically v2-with-vectors
        // (the export header is v1 iff NO node resolved a vector — and the
        // embed write races export). Without this wait the v2 fast-path
        // assertion (CLAIM D) flakes to v1/slow.
        await new Promise((res) => setTimeout(res, 1500));
        const out = path.join(checkout, MEMBER_MEMORY_RELPATH);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await exportMemory(lore, ws, out);
    } finally {
        await lore.close();
    }
    return checkout;
}

/** Pull sourceRepo out of a getNode metadata field. Lore stores object
 *  metadata back in THREE possible shapes depending on the path: a real object,
 *  a strict JSON string, or an unquoted pseudo-JSON string like
 *  "{sourceRepo: memberA, foo: bar}" (the embedded verbatim tunnel's
 *  stringification). Handle all three so the provenance assertion is robust to
 *  Lore's serialization quirk — the VALUE is what matters, not its encoding. */
function readSourceRepo(node: unknown): string | undefined {
    const meta = (node as { metadata?: unknown } | null)?.metadata;
    if (!meta) return undefined;
    if (typeof meta === 'object' && !Array.isArray(meta)) {
        const v = (meta as Record<string, unknown>)['sourceRepo'];
        return typeof v === 'string' ? v : undefined;
    }
    if (typeof meta === 'string') {
        // Try strict JSON first.
        try {
            const parsed = JSON.parse(meta) as Record<string, unknown>;
            const v = parsed['sourceRepo'];
            if (typeof v === 'string') return v;
        } catch { /* fall through to pseudo-JSON */ }
        // Unquoted pseudo-JSON: extract `sourceRepo: <value>` up to a comma/brace.
        const m = /sourceRepo:\s*([^,}]+)/.exec(meta);
        return m ? m[1]!.trim() : undefined;
    }
    return undefined;
}

async function main(): Promise<void> {
    console.log('Atlas G-1 named-group + provenance tests');

    const HOME = tmpDir('home');

    // ── Seed two distinct members. Deliberately DISSIMILAR content so the
    //    background autolink stays quiet (no flaky inferred edges/counts). ──
    const SRC_WS = 'developer';
    const atlasCheckout = await seedMember('atlas', SRC_WS, async (lore) => {
        await lore.storeNode(decisionNode(
            'atlas/dec-parse',
            'atlas parsing strategy',
            SRC_WS,
            'Atlas indexes source with tree-sitter incremental parse on save, repo-qualified symbol ids.',
        ));
    });
    const loreCheckout = await seedMember('lore', SRC_WS, async (lore) => {
        await lore.storeNode(decisionNode(
            'lore/dec-embed',
            'lore embedding model',
            SRC_WS,
            'Lore embeds knowledge with the e5-small multilingual model at 384 dimensions in LanceDB.',
        ));
    });

    // ── CLAIM A — declare + resolve a named group ─────────────────────────────
    {
        const rec = createGroup(HOME, 'lore-atlas', [atlasCheckout, loreCheckout]);
        assert.equal(rec.name, 'lore-atlas', 'group record carries its name');
        assert.equal(rec.members.length, 2, 'both members declared');
        assert.deepEqual(rec.members.map((m) => m.name).sort(), [path.basename(atlasCheckout), path.basename(loreCheckout)].sort(),
            'member names derived from checkout basenames');
        assert.ok(groupExists(HOME, 'lore-atlas'), 'group file exists after create');
        assert.ok(listGroups(HOME).some((g) => g.name === 'lore-atlas'), 'listGroups surfaces the declared group');

        const { members } = resolveGroup(HOME, 'lore-atlas');
        assert.ok(members.every((m) => !m.skipped), 'both members resolve (memory.jsonl present)');
        assert.ok(members.every((m) => m.memoryPath.endsWith(path.join('.atlas', 'memory.jsonl'))), 'memory path = <checkout>/.atlas/memory.jsonl');
        console.log('  ✓ CLAIM A: createGroup + resolveGroup declare and resolve members by name');
    }

    // ── CLAIM B — provenance: named co-load → recall finds BOTH, each tagged ──
    {
        const { members } = resolveGroup(HOME, 'lore-atlas');
        const atlasName = path.basename(atlasCheckout);
        const loreName = path.basename(loreCheckout);
        const inputs = members.map((m) => ({ file: m.memoryPath, project: m.name }));

        const groupDir = tmpDir('grp');
        const grp = await EmbeddedLore.open(groupDir);
        await grp.connect();
        try {
            const r = await loadGroup(grp, 'lore-atlas', inputs);
            assert.equal(r.nodeCount, 2, `group co-loads BOTH members' nodes; got ${r.nodeCount}`);
            // Each member result carries its provenance project + a fast/slow verdict.
            const byProject = new Map(r.members.map((m) => [m.project, m]));
            assert.ok(byProject.has(atlasName) && byProject.has(loreName), 'per-member results keyed by source-repo project');

            // project field stamped on each node = the source repo (provenance for free).
            const atlasNode = await grp.getNode('atlas/dec-parse') as { project?: string } | null;
            const loreNode = await grp.getNode('lore/dec-embed') as { project?: string } | null;
            assert.equal(atlasNode?.project, atlasName, `atlas node project = '${atlasName}' (source repo); got ${atlasNode?.project}`);
            assert.equal(loreNode?.project, loreName, `lore node project = '${loreName}' (source repo); got ${loreNode?.project}`);

            // metadata.sourceRepo belt-and-suspenders stamp (survives a project-blind consumer).
            assert.equal(readSourceRepo(atlasNode), atlasName, 'atlas node metadata.sourceRepo provenance stamp');
            assert.equal(readSourceRepo(loreNode), loreName, 'lore node metadata.sourceRepo provenance stamp');
            console.log('  ✓ CLAIM B: each member stamped project=<repo> + metadata.sourceRepo (per-node provenance)');

            // recall is store-wide → finds BOTH members; the project on each hit is provenance.
            await new Promise((res) => setTimeout(res, 1500)); // let vectors settle into LanceDB
            const res1 = await grp.recall('how does the system parse and index source code', { max: 10 }) as { hits?: Array<{ id?: string; project?: string }> };
            const res2 = await grp.recall('what embedding model represents stored knowledge', { max: 10 }) as { hits?: Array<{ id?: string; project?: string }> };
            const hits1 = res1.hits ?? [];
            const hits2 = res2.hits ?? [];
            const a = hits1.find((h) => h.id === 'atlas/dec-parse');
            const l = hits2.find((h) => h.id === 'lore/dec-embed');
            assert.ok(a, `recall finds the ATLAS decision in the group; got ${JSON.stringify(hits1.map((h) => h.id))}`);
            assert.ok(l, `recall finds the LORE decision in the group; got ${JSON.stringify(hits2.map((h) => h.id))}`);
            assert.equal(a!.project, atlasName, `recall hit carries source-repo provenance project; got ${a!.project}`);
            assert.equal(l!.project, loreName, `recall hit carries source-repo provenance project; got ${l!.project}`);
            console.log('  ✓ CLAIM B: store-wide recall finds BOTH members; each hit carries its source-repo project');
        } finally {
            await grp.close();
        }
    }

    // ── CLAIM C — degrade-don't-fail: a missing member is skipped, not fatal ──
    {
        // Declare a group whose SECOND member checkout has NO memory.jsonl.
        const goodCheckout = atlasCheckout; // has .atlas/memory.jsonl
        const emptyCheckout = tmpDir('empty-co'); // exists, but no .atlas/memory.jsonl
        createGroup(HOME, 'partial', [goodCheckout, emptyCheckout]);

        const { members } = resolveGroup(HOME, 'partial');
        const good = members.find((m) => m.path === path.resolve(goodCheckout))!;
        const empty = members.find((m) => m.path === path.resolve(emptyCheckout))!;
        assert.equal(good.skipped, false, 'present member is NOT skipped');
        assert.equal(empty.skipped, true, 'member without memory.jsonl is SKIPPED (not thrown)');
        assert.match(empty.skipReason ?? '', /memory\.jsonl missing/i, 'skip reason explains why');

        // Loading only the present member still succeeds (degrade, don't fail).
        const present = members.filter((m) => !m.skipped).map((m) => ({ file: m.memoryPath, project: m.name }));
        assert.equal(present.length, 1, 'one present member remains loadable');
        const partialDir = tmpDir('partial-grp');
        const grp = await EmbeddedLore.open(partialDir);
        await grp.connect();
        try {
            const r = await loadGroup(grp, 'partial', present);
            assert.equal(r.nodeCount, 1, 'group degrades to the single present member, no throw');
            console.log('  ✓ CLAIM C: a member with no memory.jsonl is skipped-not-fatal; the rest still load');
        } finally {
            await grp.close();
        }
    }

    // ── CLAIM D — v1 guard: v1/no-vector → slow (re-embed); v2-with-vectors → fast ──
    //
    // Both member files are HAND-AUTHORED so the fast/slow verdict is
    // DETERMINISTIC. A real `atlas memory export` of a single fresh node can
    // emit leading Arrow null/NaN sentinels in the vector (JSON.stringify(NaN)
    // → null), which the load gate (correctly) treats as a missing vector and
    // drops to re-embed — making "v2 → fast" flaky for a tiny live export. By
    // writing a clean numeric 384-dim vector we test exactly the guard
    // contract: v2 header + every node carrying a usable numeric vector ⇒ fast;
    // v1 header (or a missing vector) ⇒ slow. The guard NEVER blocks — both
    // members must still ingest.
    {
        // v1 member — no embeddings.
        const v1Checkout = tmpDir('v1-co');
        const v1File = path.join(v1Checkout, MEMBER_MEMORY_RELPATH);
        fs.mkdirSync(path.dirname(v1File), { recursive: true });
        const v1Header = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sourceWorkspace: 'x', exportedTypes: ['decision'] });
        const v1Node = JSON.stringify({ kind: 'node', id: 'old/dec-legacy', type: 'decision', label: 'legacy v1 decision with no vector', content: 'a legacy decision exported before vectors were bundled' });
        fs.writeFileSync(v1File, `${v1Header}\n${v1Node}\n`);

        // v2 member — clean precomputed 384-dim numeric vector (no null sentinels).
        const v2Checkout = tmpDir('v2-co');
        const v2File = path.join(v2Checkout, MEMBER_MEMORY_RELPATH);
        fs.mkdirSync(path.dirname(v2File), { recursive: true });
        const vec = Array.from({ length: 384 }, (_, i) => (i % 7) * 0.013 + 0.001); // all finite numbers
        const v2Header = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sourceWorkspace: 'y', exportedTypes: ['decision'] });
        const v2NodeObj = { kind: 'node', id: 'new/dec-fresh', type: 'decision', label: 'fresh v2 decision', content: 'a freshly exported decision that carries a precomputed embedding vector', embedding: vec };
        fs.writeFileSync(v2File, `${v2Header}\n${JSON.stringify(v2NodeObj)}\n`);

        const guardDir = tmpDir('guard-grp');
        const grp = await EmbeddedLore.open(guardDir);
        await grp.connect();
        try {
            const r = await loadGroup(grp, 'guard', [
                { file: v1File, project: 'old' },
                { file: v2File, project: 'new' },
            ]);
            const v1Res = r.members.find((m) => m.project === 'old')!;
            const v2Res = r.members.find((m) => m.project === 'new')!;
            assert.equal(v1Res.speed, 'slow', `v1/no-vector member rides the slow re-embed path; got ${v1Res.speed}`);
            assert.equal(v1Res.headerVersion, 1, 'v1 member header version reported as 1');
            assert.equal(v2Res.speed, 'fast', `v2-with-vectors member rides the fast precomputed path; got ${v2Res.speed}`);
            assert.equal(v2Res.headerVersion, 2, 'v2 member header version reported as 2');
            // Both still ingested — the guard informs, never blocks.
            assert.equal(r.nodeCount, 2, 'both members ingested despite the v1 warning');
            console.log('  ✓ CLAIM D: v1/no-vector member flagged speed=slow (re-embed), v2 member fast; neither blocked');
        } finally {
            await grp.close();
        }
    }

    console.log('All G-1 named-group + provenance tests passed.');
}

await main();
