/**
 * tests/knowledge-list.test.ts — `knowledge_list` (integrator ask #5).
 *
 * The tool exists because a partial list of the rules governing a project is
 * WORSE than no list: the reader assumes they have seen them all. So every
 * claim here is about completeness and honesty, not about ranking.
 *
 * CLAIM A — lists every knowledge node, ordered by id, with `total` counting
 *           all matches BEFORE paging.
 * CLAIM B — offset/limit paging neither skips nor repeats a row, and `hasMore`
 *           tells the truth at the boundary.
 * CLAIM C — the knowledge_retract tombstone is NEVER listed, superseded nodes
 *           are hidden by default, and includeSuperseded brings them back with
 *           `supersededBy` naming the tombstone (= retracted, not replaced).
 * CLAIM D — hitting the raw pull cap reports `truncated: true` rather than
 *           silently presenting a partial list as complete.
 * CLAIM E — against a REAL EmbeddedLore: store → list round-trips, the type
 *           filter works, and a retracted node drops out of the default list.
 *           (A hand-rolled fake cannot catch a wrong listNodes ARGUMENT ORDER;
 *           this claim is what pins tag/project/limit to the right slots.)
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import {
    runKnowledgeList,
    tombstoneIdFor,
    RAW_PULL_CAP,
    type KnowledgeListReader,
    type KnowledgeListResult,
} from '../src/mcp/tools/knowledgeList.js';

const WS = 'test-ws';

/** Fake reader over an in-memory row set, mimicking Lore's listNodes:
 *  filters by type/tag/project and caps at `limit`. */
function fakeReader(rows: Array<Record<string, unknown>>): KnowledgeListReader & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
        calls,
        async listNodes(type?: string, tag?: string, project?: string, limit?: number) {
            calls.push([type, tag, project, limit]);
            let out = rows.filter((r) => (type ? r['type'] === type : true));
            if (tag) out = out.filter((r) => (r['tags'] as string[] | undefined)?.includes(tag.toLowerCase()));
            if (project) out = out.filter((r) => r['project'] === project);
            return typeof limit === 'number' ? out.slice(0, limit) : out;
        },
    };
}

function node(id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, type, label: `label ${id}`, content: `content ${id}`, tags: [], project: WS, ...extra };
}

/** Narrow the union — every call in this suite is expected to succeed. */
function ok(r: unknown): KnowledgeListResult {
    assert.ok((r as KnowledgeListResult).ok === true, `expected success, got ${JSON.stringify(r)}`);
    return r as KnowledgeListResult;
}

async function main(): Promise<void> {
    console.log('Running knowledge_list tests…');

    // ── CLAIM A ─────────────────────────────────────────────────────────────
    {
        // Deliberately out of id order, and spread across types.
        const reader = fakeReader([
            node('k-c', 'decision'),
            node('k-a', 'convention'),
            node('k-b', 'decision'),
        ]);
        const res = ok(await runKnowledgeList(reader, {}, WS));
        assert.deepEqual(res.nodes.map((n) => n.id), ['k-a', 'k-b', 'k-c'], 'must be ordered by id');
        assert.equal(res.total, 3);
        assert.equal(res.count, 3);
        assert.equal(res.hasMore, false);
        // Type filter narrows both the page AND the total.
        const decisions = ok(await runKnowledgeList(reader, { type: 'decision' }, WS));
        assert.deepEqual(decisions.nodes.map((n) => n.id), ['k-b', 'k-c']);
        assert.equal(decisions.total, 2, 'total must reflect the filter, not the workspace');
        // An unknown type is refused rather than silently returning nothing.
        const bad = await runKnowledgeList(reader, { type: 'code_file' }, WS) as { error?: string };
        assert.equal(bad.error, 'invalid_arguments', 'a non-knowledge type must be refused, not silently empty');
        console.log('  ✓ CLAIM A: complete, id-ordered, total counts matches before paging');
    }

    // ── CLAIM B ─────────────────────────────────────────────────────────────
    {
        const rows = Array.from({ length: 25 }, (_, i) => node(`k-${String(i).padStart(2, '0')}`, 'convention'));
        const reader = fakeReader(rows);
        const seen: string[] = [];
        let offset = 0;
        for (;;) {
            const page = ok(await runKnowledgeList(reader, { limit: 10, offset }, WS));
            assert.equal(page.total, 25, 'total must stay constant across pages');
            seen.push(...page.nodes.map((n) => n.id));
            if (!page.hasMore) {
                assert.equal(page.count, 5, 'last page holds the remainder');
                break;
            }
            offset += page.limit;
            assert.ok(offset <= 25, 'paging must terminate');
        }
        assert.equal(seen.length, 25, 'paging must not skip rows');
        assert.equal(new Set(seen).size, 25, 'paging must not repeat rows');
        assert.deepEqual(seen, rows.map((r) => r['id']), 'concatenated pages must equal the full ordered set');
        // Past the end: empty, honest, no error.
        const past = ok(await runKnowledgeList(reader, { limit: 10, offset: 99 }, WS));
        assert.equal(past.count, 0);
        assert.equal(past.total, 25);
        assert.equal(past.hasMore, false);
        console.log('  ✓ CLAIM B: paging skips nothing, repeats nothing, hasMore is honest');
    }

    // ── CLAIM C ─────────────────────────────────────────────────────────────
    {
        const tombstone = tombstoneIdFor(WS);
        const reader = fakeReader([
            node('k-live', 'convention'),
            node('k-retracted', 'convention', {
                supersededAt: '2026-08-10T00:00:00Z',
                supersededBy: tombstone,
                supersededReason: 'wrong',
            }),
            node('k-replaced', 'decision', {
                supersededAt: '2026-08-10T00:00:00Z',
                supersededBy: 'k-successor',
            }),
            // The tombstone itself is stored as an 'architecture' node.
            node(tombstone, 'architecture'),
        ]);

        const def = ok(await runKnowledgeList(reader, {}, WS));
        assert.deepEqual(def.nodes.map((n) => n.id), ['k-live'], 'default list = live knowledge only');
        assert.equal(def.total, 1);
        assert.ok(!def.nodes.some((n) => n.id === tombstone), 'the tombstone is bookkeeping, never knowledge');

        const all = ok(await runKnowledgeList(reader, { includeSuperseded: true }, WS));
        const ids = all.nodes.map((n) => n.id);
        assert.ok(ids.includes('k-retracted') && ids.includes('k-replaced'), 'includeSuperseded restores both');
        assert.ok(!ids.includes(tombstone), 'the tombstone stays hidden even under includeSuperseded');
        const retracted = all.nodes.find((n) => n.id === 'k-retracted')!;
        const replaced = all.nodes.find((n) => n.id === 'k-replaced')!;
        assert.equal(retracted.supersededBy, tombstone, 'a retraction is identified by its tombstone target');
        assert.equal(retracted.supersededReason, 'wrong');
        assert.equal(replaced.supersededBy, 'k-successor', 'a replacement points at its successor, not the tombstone');
        console.log('  ✓ CLAIM C: tombstone never listed; retracted vs replaced is distinguishable');
    }

    // ── CLAIM D ─────────────────────────────────────────────────────────────
    {
        // One type returning exactly the cap = "there may be more".
        const rows = Array.from({ length: RAW_PULL_CAP }, (_, i) => node(`k-${String(i).padStart(6, '0')}`, 'decision'));
        const reader = fakeReader(rows);
        const res = ok(await runKnowledgeList(reader, { limit: 5 }, WS));
        assert.equal(res.truncated, true, 'hitting the pull cap must be reported');
        assert.equal(res.count, 5);
        assert.ok(res.total <= RAW_PULL_CAP, 'total is a lower bound when truncated');
        // Normal-sized workspaces must NOT carry the flag.
        const small = ok(await runKnowledgeList(fakeReader([node('k-1', 'decision')]), {}, WS));
        assert.equal(small.truncated, undefined, 'truncated must be absent, not false, in the normal case');
        console.log('  ✓ CLAIM D: truncation reported, never silent');
    }

    // ── CLAIM E — real EmbeddedLore ─────────────────────────────────────────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-klist-'));
        const lore = await EmbeddedLore.open(dir);
        await lore.connect();
        try {
            const ws = path.basename(dir);
            const store = (id: string, type: string, tags?: string) => lore.storeNode({
                id, type, workspace: ws, embed: false,
                label: `L ${id}`, content: `C ${id}`, ...(tags ? { tags } : {}),
            } as never);
            await store('kl-dec-1', 'decision', 'rules,api');
            await store('kl-con-1', 'convention', 'rules');
            await store('kl-con-2', 'convention');

            const all = ok(await runKnowledgeList(lore, {}, ws));
            assert.deepEqual(all.nodes.map((n) => n.id), ['kl-con-1', 'kl-con-2', 'kl-dec-1'],
                'store → list must round-trip every node, id-ordered');
            assert.equal(all.total, 3);
            // Content and tags survive the round trip (a rules browser renders both).
            assert.equal(all.nodes.find((n) => n.id === 'kl-dec-1')!.content, 'C kl-dec-1');
            assert.deepEqual(all.nodes.find((n) => n.id === 'kl-con-1')!.tags.sort(), ['rules']);

            // Type filter — proves `type` lands in the type slot.
            const cons = ok(await runKnowledgeList(lore, { type: 'convention' }, ws));
            assert.deepEqual(cons.nodes.map((n) => n.id), ['kl-con-1', 'kl-con-2']);

            // Tag filter — proves `tag` lands in the TAG slot, not the project slot
            // (a swap there would silently return everything, or nothing).
            const tagged = ok(await runKnowledgeList(lore, { tag: 'rules' }, ws));
            assert.deepEqual(tagged.nodes.map((n) => n.id), ['kl-con-1', 'kl-dec-1'],
                'tag filter must select exactly the tagged nodes');

            // A wrong workspace must return nothing — proves project scoping.
            const other = ok(await runKnowledgeList(lore, {}, 'some-other-workspace'));
            assert.equal(other.total, 0, 'listing must be scoped to the workspace');

            // Retract one node the way knowledge_retract does, then re-list.
            const tombstone = tombstoneIdFor(ws);
            await lore.storeNode({
                id: tombstone, type: 'architecture', workspace: ws, embed: false,
                label: 'Retracted knowledge (tombstone)', content: 'sink', tags: 'atlas,tombstone',
            } as never);
            await lore.supersedeNode('kl-con-2', tombstone, 'no longer true');

            const afterRetract = ok(await runKnowledgeList(lore, {}, ws));
            assert.deepEqual(afterRetract.nodes.map((n) => n.id), ['kl-con-1', 'kl-dec-1'],
                'a retracted node must leave the default list, and the tombstone must never enter it');
            assert.equal(afterRetract.total, 2);

            const withSuperseded = ok(await runKnowledgeList(lore, { includeSuperseded: true }, ws));
            const back = withSuperseded.nodes.find((n) => n.id === 'kl-con-2');
            assert.ok(back, 'includeSuperseded must restore the retracted node');
            assert.equal(back.supersededBy, tombstone, 'and identify it as retracted');
            assert.ok(!withSuperseded.nodes.some((n) => n.id === tombstone), 'still no tombstone in the list');
            console.log('  ✓ CLAIM E: real store → list round-trip, filters land in the right slots');
        } finally {
            await lore.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    console.log('knowledge_list: all checks passed');
}

void main();
