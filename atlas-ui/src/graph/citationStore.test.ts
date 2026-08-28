/**
 * citationStore.test.ts — unit tests for the B4 framework-agnostic citation
 * store. Pure (no React, no network). Covers the load-bearing contract:
 *   - setCitations / getCitations round-trip
 *   - workspace isolation (set on A never affects B)
 *   - subscribe fires on change, returns an unsubscribe
 *   - clear empties + fires
 *   - idempotent set (same members → no listener churn)
 *   - deriveCitations pulls ids/files from real retrieval-result shapes
 */

import { describe, it, expect, vi } from 'vitest';
import { CitationStore, deriveCitations } from './citationStore';

describe('CitationStore', () => {
  it('setCitations / getCitations round-trips (deduped)', () => {
    const s = new CitationStore();
    s.setCitations('A', ['n1', 'n2', 'n2', 'n3']);
    expect(s.getCitations('A').sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('returns a fresh array, never the internal Set', () => {
    const s = new CitationStore();
    s.setCitations('A', ['n1']);
    const a = s.getCitations('A');
    a.push('mutated');
    // The store's copy is unaffected by mutating the returned array.
    expect(s.getCitations('A')).toEqual(['n1']);
  });

  it('drops blank/whitespace ids', () => {
    const s = new CitationStore();
    s.setCitations('A', ['n1', '', '   ', 'n2']);
    expect(s.getCitations('A').sort()).toEqual(['n1', 'n2']);
  });

  it('isolates workspaces — set on A does not affect B', () => {
    const s = new CitationStore();
    s.setCitations('A', ['a1', 'a2']);
    s.setCitations('B', ['b1']);
    expect(s.getCitations('A').sort()).toEqual(['a1', 'a2']);
    expect(s.getCitations('B')).toEqual(['b1']);
    // Clearing A leaves B intact.
    s.clear('A');
    expect(s.getCitations('A')).toEqual([]);
    expect(s.getCitations('B')).toEqual(['b1']);
  });

  it('isCited reflects the current set per workspace', () => {
    const s = new CitationStore();
    s.setCitations('A', ['a1']);
    expect(s.isCited('A', 'a1')).toBe(true);
    expect(s.isCited('A', 'a2')).toBe(false);
    expect(s.isCited('B', 'a1')).toBe(false); // isolation
  });

  it('subscribe fires on change with the workspace id; unsubscribe stops it', () => {
    const s = new CitationStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);

    s.setCitations('A', ['n1']);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith('A');

    s.setCitations('B', ['n2']);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('B');

    unsub();
    s.setCitations('A', ['n3']);
    expect(cb).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });

  it('clear empties the workspace and fires listeners', () => {
    const s = new CitationStore();
    s.setCitations('A', ['n1']);
    const cb = vi.fn();
    s.subscribe(cb);

    s.clear('A');
    expect(s.getCitations('A')).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith('A');
  });

  it('clear on an already-empty workspace is a no-op (no listener fire)', () => {
    const s = new CitationStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.clear('A');
    expect(cb).not.toHaveBeenCalled();
  });

  it('idempotent set — same members (order-independent) does not fire listeners', () => {
    const s = new CitationStore();
    const cb = vi.fn();
    s.subscribe(cb);

    s.setCitations('A', ['n1', 'n2']);
    expect(cb).toHaveBeenCalledTimes(1);

    // Same set, different order + a duplicate → no change → no fire.
    s.setCitations('A', ['n2', 'n1', 'n1']);
    expect(cb).toHaveBeenCalledTimes(1);

    // Genuinely different set → fires.
    s.setCitations('A', ['n1', 'n3']);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('setting empty on a never-set workspace is a no-op', () => {
    const s = new CitationStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.setCitations('A', []);
    expect(cb).not.toHaveBeenCalled();
    expect(s.getCitations('A')).toEqual([]);
  });

  it('setting empty on a populated workspace clears it and fires', () => {
    const s = new CitationStore();
    s.setCitations('A', ['n1']);
    const cb = vi.fn();
    s.subscribe(cb);
    s.setCitations('A', []);
    expect(s.getCitations('A')).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty workspace id', () => {
    const s = new CitationStore();
    s.setCitations('', ['n1']);
    expect(s.getCitations('')).toEqual([]);
  });
});

describe('deriveCitations', () => {
  it('pulls ids + files from knowledge_search results', () => {
    const raw = {
      results: [
        { id: 'node:1', label: 'Auth decision', file: 'src/auth.ts' },
        { id: 'node:2', label: 'JWT rotation' },
      ],
    };
    expect(deriveCitations(raw).sort()).toEqual(['node:1', 'node:2', 'src/auth.ts']);
  });

  it('pulls ids from knowledge_recall hits[] (the recall shape, not results[])', () => {
    // Regression: knowledge_recall returns its ranked matches under `hits`, not
    // `results`/`nodes`. deriveCitations previously ignored `hits`, so the recall
    // flow produced zero citations — no "Grounded in" chips, no graph highlight.
    const raw = {
      topic: 'why did we bump the engine',
      mode: 'full',
      totalRecalled: 92,
      shown: 2,
      hits: [
        { id: 'lore-engine-bump-8fcc6e0-v3.11.0', type: 'decision', label: 'Engine bump' },
        { id: 'wave0-packaging-ci-shipped', type: 'decision', label: 'Wave 0' },
      ],
    };
    expect(deriveCitations(raw).sort()).toEqual([
      'lore-engine-bump-8fcc6e0-v3.11.0',
      'wave0-packaging-ci-shipped',
    ]);
  });

  it('pulls ids/files from atlas_subgraph nodes', () => {
    const raw = {
      nodes: [
        { id: 'code-file:src/a.ts', file: 'src/a.ts', cls: 'file' },
        { id: 'code-symbol:foo', file: 'src/a.ts', cls: 'symbol' },
      ],
    };
    expect(deriveCitations(raw)).toContain('code-file:src/a.ts');
    expect(deriveCitations(raw)).toContain('code-symbol:foo');
    expect(deriveCitations(raw)).toContain('src/a.ts');
  });

  it('pulls symbols/files from blast radius rings', () => {
    const raw = {
      d1: [{ symbol: 'doThing', file: 'src/x.ts' }],
      d2: [{ symbol: 'helper' }],
    };
    expect(deriveCitations(raw).sort()).toEqual(['doThing', 'helper', 'src/x.ts']);
  });

  it('pulls from dead-code candidates', () => {
    const raw = { candidates: [{ symbol: 'unusedFn', file: 'src/dead.ts' }] };
    expect(deriveCitations(raw).sort()).toEqual(['src/dead.ts', 'unusedFn']);
  });

  it('returns [] for null / primitives / unknown shapes', () => {
    expect(deriveCitations(null)).toEqual([]);
    expect(deriveCitations(undefined)).toEqual([]);
    expect(deriveCitations('hello')).toEqual([]);
    expect(deriveCitations(42)).toEqual([]);
    expect(deriveCitations({ unrelated: true })).toEqual([]);
  });

  it('dedupes ids appearing across multiple fields', () => {
    const raw = {
      results: [{ id: 'n1', file: 'shared.ts' }],
      nodes: [{ id: 'n1', file: 'shared.ts' }],
    };
    expect(deriveCitations(raw).sort()).toEqual(['n1', 'shared.ts']);
  });
});
