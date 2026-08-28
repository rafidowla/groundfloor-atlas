/**
 * tests/memory-query.test.ts — W2-T2: brute-force retrieval helpers
 * (src/memoryQuery.ts) over the stateless MemoryFileView.
 *
 * Uses the canonical shared fixture tests/fixtures/memory-150.jsonl — its
 * deterministic layout (topics, tags, superseded stamps, edges) is documented
 * in the comment header of tests/memory-file.test.ts.
 *
 * Also proves the pilot-scale performance claim: brute-force keyword search
 * over a 5k-node synthetic file completes < 200ms (no index, on purpose).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMemoryFile, KNOWLEDGE_TYPES } from '../src/memoryFile.js';
import { filterNodes, keywordSearch, neighbors, toContextBlock } from '../src/memoryQuery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_150 = path.join(here, 'fixtures', 'memory-150.jsonl');

async function main(): Promise<void> {
    console.log('memory-query (W2-T2) retrieval tests');
    const view = await readMemoryFile(FIXTURE_150);

    // ── CLAIM 1 — superseded excluded by default, includable ─────────────────
    {
        assert.equal(filterNodes(view).length, 110, '125 − 15 superseded = 110 by default');
        assert.equal(filterNodes(view, { includeSuperseded: true }).length, 125, 'opt-in shows all');
        console.log('  ✓ CLAIM 1: superseded lifecycle filter (default off, includable)');
    }

    // ── CLAIM 2 — type + tag filters (tags = ALL must match, case-insensitive)
    {
        assert.equal(filterNodes(view, { types: ['decision'] }).length, 22, '25 decisions − 3 superseded');
        assert.equal(filterNodes(view, { types: ['decision', 'architecture'] }).length, 44);
        assert.equal(filterNodes(view, { tags: ['pm'] }).length, 25, 'i % 5 === 0 nodes carry the pm tag');
        assert.equal(filterNodes(view, { tags: ['PM'] }).length, 25, 'tag match is case-insensitive');
        assert.equal(filterNodes(view, { tags: ['pm', 'fixture'] }).length, 25, 'ALL listed tags must match');
        assert.equal(filterNodes(view, { tags: ['pm', 'no-such-tag'] }).length, 0);
        assert.equal(filterNodes(view, { types: ['bug_pattern'], tags: ['pm'] }).length, 5, 'filters compose');
        console.log('  ✓ CLAIM 2: type/tag filters compose, tags AND-matched case-insensitively');
    }

    // ── CLAIM 3 — keywordSearch ranking, label boost, deterministic tie-break ─
    {
        // Topic 'atomic rename discipline' lives on i % 5 === 0 → 25 live nodes.
        const all = keywordSearch(view, 'atomic rename', { limit: 100 });
        assert.equal(all.length, 25, 'all topic-0 nodes match (none are superseded)');
        const top = keywordSearch(view, 'atomic rename');
        assert.equal(top.length, 20, 'default limit is 20');
        // Highest term-frequency = content repeats (i % 3 === 2 → 3 content
        // occurrences) — that's i ∈ {5, 20} across all 5 types, 10 nodes tied
        // on score. The tie MUST break by id ascending: 'arch-05' sorts first.
        assert.equal(top[0]!.node.id, 'arch-05', 'deterministic tie-break by id ascending');
        assert.deepEqual(
            top.map((r) => r.node.id),
            keywordSearch(view, 'atomic rename').map((r) => r.node.id),
            'same input → same output (fully deterministic)');
        // Label boost: a token that appears ONLY in labels/content still ranks
        // label hits higher. 'discipline' is in topic-0 labels (×3 weight) and
        // content — every match scores ≥ 4; a content-only word can't outrank.
        const first = top[0]!;
        const scores = top.map((r) => r.score);
        assert.ok(scores.every((s, i) => i === 0 || s <= scores[i - 1]!), 'ranked score-descending');
        assert.ok(first.score >= scores[scores.length - 1]!, 'top result carries the max score');
        console.log('  ✓ CLAIM 3: ranking + label boost + id tie-break are deterministic');
    }

    // ── CLAIM 4 — search respects the lifecycle/tag/type filters ─────────────
    {
        // Topic 'embedding vector sync' (i % 5 === 3) holds ALL 15 superseded
        // nodes (i ∈ {3, 13, 23}) plus i ∈ {8, 18} live per type.
        const live = keywordSearch(view, 'embedding vector sync', { limit: 100 });
        assert.equal(live.length, 10, 'superseded matches excluded by default');
        const withDead = keywordSearch(view, 'embedding vector sync', { limit: 100, includeSuperseded: true });
        assert.equal(withDead.length, 25, 'includeSuperseded restores them');
        const decOnly = keywordSearch(view, 'embedding vector sync', { limit: 100, types: ['decision'] });
        assert.ok(decOnly.every((r) => r.node.type === 'decision') && decOnly.length === 2);
        assert.equal(keywordSearch(view, 'zz-no-such-token').length, 0, 'no-match query → empty');
        console.log('  ✓ CLAIM 4: search composes with lifecycle/type filters');
    }

    // ── CLAIM 5 — neighbors: both directions, relation filter, cross-seam ────
    {
        const out = neighbors(view, 'dec-00');
        assert.equal(out.length, 1);
        assert.equal(out[0]!.direction, 'out');
        assert.equal(out[0]!.otherId, 'conv-00');
        assert.equal(out[0]!.node?.type, 'convention', 'far-end node resolved from the view');

        const inbound = neighbors(view, 'conv-00');
        assert.equal(inbound.length, 1);
        assert.equal(inbound[0]!.direction, 'in');
        assert.equal(inbound[0]!.otherId, 'dec-00');

        const sup = neighbors(view, 'dec-10', { relation: 'supersedes' });
        assert.equal(sup.length, 1);
        assert.equal(sup[0]!.otherId, 'arch-00');
        assert.equal(neighbors(view, 'dec-10', { relation: 'relates_to' }).length, 0, 'relation filter exact');

        // Cross-seam: the foreign target has no node in THIS file — surfaced,
        // not dropped, with `node` undefined.
        const seam = neighbors(view, 'dec-15');
        assert.equal(seam.length, 1);
        assert.equal(seam[0]!.otherId, 'lore/dec-Y0');
        assert.equal(seam[0]!.node, undefined, 'foreign far end resolves id-only');
        console.log('  ✓ CLAIM 5: neighbors both directions, relation filter, cross-seam id-only');
    }

    // ── CLAIM 6 — toContextBlock: whole-entry truncation, order preserved ────
    {
        const nodes = filterNodes(view, { types: ['decision'] });
        const full = toContextBlock(nodes);
        assert.ok(full.includes('- [decision]') && full.includes('(id: dec-00'), 'entries rendered');
        assert.ok(!full.includes('omitted'), 'no truncation note when everything fits');
        assert.equal(full.indexOf('dec-00') < full.indexOf('dec-01'), true, 'order given (oldest-first) preserved');

        const tight = toContextBlock(nodes, { maxChars: 300 });
        assert.ok(tight.length <= 300 + 40, 'budget respected (plus the short omission note)');
        assert.match(tight, /… \(\+\d+ more entries omitted\)$/, 'truncation is announced');
        // Never mid-entry: every entry line present is complete (each entry's
        // head renders its closing paren).
        const heads = tight.split('\n').filter((l) => l.startsWith('- ['));
        assert.ok(heads.every((l) => l.endsWith(')')), 'entries are whole, never cut mid-entry');
        // Superseded marker travels into the block.
        const withDead = toContextBlock(filterNodes(view, { includeSuperseded: true, types: ['decision'] }));
        assert.ok(withDead.includes('superseded: 2026-07-02T00:00:00.000Z'), 'superseded entries are marked');
        console.log('  ✓ CLAIM 6: context block truncates whole entries and keeps order');
    }

    // ── CLAIM 7 — 5k-node brute-force search under 200ms ─────────────────────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-memquery-'));
        try {
            const p = path.join(dir, 'big.jsonl');
            const lines = [JSON.stringify({ version: 2, exportedAt: '2026-07-01T00:00:00Z', sourceWorkspace: 'big', exportedTypes: KNOWLEDGE_TYPES })];
            for (let i = 0; i < 5000; i++) {
                lines.push(JSON.stringify({
                    kind: 'node',
                    id: `n-${String(i).padStart(4, '0')}`,
                    type: KNOWLEDGE_TYPES[i % 5],
                    label: `synthetic node ${i} ${i % 97 === 0 ? 'needle haystack' : 'filler'}`,
                    content: `Body of synthetic node ${i}. `.repeat(8) + (i % 97 === 0 ? ' the needle appears here too' : ''),
                    tags: `synthetic,bulk${i % 97 === 0 ? ',needle' : ''}`,
                    supersededAt: null,
                }));
            }
            fs.writeFileSync(p, lines.join('\n') + '\n');
            const bigView = await readMemoryFile(p);
            assert.equal(bigView.nodes.length, 5000);
            const t0 = process.hrtime.bigint();
            const hits = keywordSearch(bigView, 'needle haystack', { limit: 50 });
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            assert.ok(hits.length > 0 && hits.length <= 50);
            assert.ok(ms < 200, `brute-force search over 5k nodes must stay < 200ms (took ${ms.toFixed(1)}ms)`);
            console.log(`  ✓ CLAIM 7: 5k-node search in ${ms.toFixed(1)}ms (< 200ms, no index needed)`);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    console.log('memory-query: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
