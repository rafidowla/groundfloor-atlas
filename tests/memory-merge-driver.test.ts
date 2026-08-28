/**
 * tests/memory-merge-driver.test.ts — guards the .atlas/memory.jsonl union
 * merge driver against the conflicted-merge data-loss bug.
 *
 * THE BUG (2026-07-13): when a merge of .atlas/memory.jsonl conflicted, the
 * post-merge import hook never ran and the pre-commit export then overwrote the
 * resolved file with only the local DB's contents — silently dropping every
 * remote-only entry. The union merge driver resolves the conflict correctly so
 * an entry present on EITHER side is always preserved.
 */
import * as assert from 'node:assert/strict';
// @ts-expect-error — pure .mjs helper, no types
import { unionMemoryJsonl } from '../scripts/memory-merge-driver.mjs';

const header = (ts: string) =>
  JSON.stringify({ version: 1, exportedAt: ts, sourceWorkspace: 'ws', exportedTypes: ['decision'] });
const node = (id: string, label = id) => JSON.stringify({ kind: 'node', id, type: 'decision', label });
const edge = (s: string, t: string, r = 'relates_to') =>
  JSON.stringify({ kind: 'edge', sourceId: s, targetId: t, relation: r });

function ids(jsonl: string): string[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((o) => o.kind === 'node').map((o) => o.id).sort();
}

async function main(): Promise<void> {
  console.log('memory-merge-driver union tests');

  // CLAIM 1 — the core property: entries on only ONE side are never dropped.
  {
    const ours = [header('2026-07-05T00:00:00Z'), node('local-1'), node('shared')].join('\n');
    const theirs = [header('2026-07-06T00:00:00Z'), node('remote-1'), node('remote-2'), node('shared')].join('\n');
    const merged = unionMemoryJsonl(ours, theirs);
    assert.deepEqual(ids(merged), ['local-1', 'remote-1', 'remote-2', 'shared'],
      'union must keep local-only AND remote-only nodes');
    console.log('  ✓ CLAIM 1: no side-exclusive entry is lost');
  }

  // CLAIM 2 — this is exactly the shape that regressed (few local, many remote).
  {
    const ours = [header('2026-07-05T00:00:00Z'), node('a'), node('b'), node('c')].join('\n');
    const theirsNodes = Array.from({ length: 137 }, (_, i) => node(`r${i}`));
    const theirs = [header('2026-07-06T00:00:00Z'), ...theirsNodes].join('\n');
    const merged = unionMemoryJsonl(ours, theirs);
    assert.equal(ids(merged).length, 140, '3 local + 137 remote = 140, none dropped');
    console.log('  ✓ CLAIM 2: 3-local + 137-remote merges to 140 (the reported regression shape)');
  }

  // CLAIM 3 — edges dedupe by (sourceId,targetId,relation), not lost, not doubled.
  {
    const ours = [header('2026-07-05T00:00:00Z'), edge('a', 'b'), edge('a', 'c')].join('\n');
    const theirs = [header('2026-07-06T00:00:00Z'), edge('a', 'b'), edge('x', 'y')].join('\n');
    const merged = unionMemoryJsonl(ours, theirs);
    const edges = merged.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.kind === 'edge');
    assert.equal(edges.length, 3, 'a→b deduped; a→c and x→y kept → 3 unique edges');
    console.log('  ✓ CLAIM 3: edges union+dedupe by (source,target,relation)');
  }

  // CLAIM 4 — same-id collision keeps OURS; header is the newer exportedAt.
  {
    const ours = [header('2026-07-05T00:00:00Z'), node('shared', 'OURS-LABEL')].join('\n');
    const theirs = [header('2026-07-09T00:00:00Z'), node('shared', 'THEIRS-LABEL')].join('\n');
    const merged = unionMemoryJsonl(ours, theirs);
    const shared = merged.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.id === 'shared');
    assert.equal(shared.label, 'OURS-LABEL', 'ours wins on same-id collision');
    const hdr = JSON.parse(merged.split('\n')[0]);
    assert.equal(hdr.exportedAt, '2026-07-09T00:00:00Z', 'header = newer exportedAt');
    console.log('  ✓ CLAIM 4: ours wins id collisions; newest header kept');
  }

  // CLAIM 5 — tolerate a stray conflict marker / junk line without throwing.
  {
    const ours = [header('2026-07-05T00:00:00Z'), node('a'), '<<<<<<< HEAD', node('b')].join('\n');
    const theirs = [header('2026-07-06T00:00:00Z'), node('c')].join('\n');
    const merged = unionMemoryJsonl(ours, theirs);
    assert.deepEqual(ids(merged), ['a', 'b', 'c'], 'junk line skipped, real nodes kept');
    console.log('  ✓ CLAIM 5: junk/conflict-marker lines are tolerated');
  }

  console.log('memory-merge-driver: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
