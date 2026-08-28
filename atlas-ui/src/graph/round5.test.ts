/**
 * round5.test.ts — regression tests for the roadmap-batch UI fixes:
 *  - countVisible: header counts reflect the active hard filters.
 *  - deriveProgress: terminal (done/error) snapshots expire after 60s.
 *  - depends_on is in the display vocab (edge filter can't orphan it).
 */
import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { EDGE_TYPES } from '@atlas-schema';
import { countVisible } from './visibleCount';
import { deriveProgress, TERMINAL_SNAPSHOT_VISIBLE_MS } from './indexProgress';
import { NODE_TYPES } from '@atlas-schema';

function mkGraph(): Graph {
  const g = new Graph();
  g.addNode('f1', { nodeType: 'code_file', label: 'a.ts', project: 'proj' });
  g.addNode('s1', { nodeType: 'code_symbol', label: 'fn', project: 'proj' });
  g.addNode('s2', { nodeType: 'code_symbol', label: 'gn', project: 'proj' });
  g.addEdge('f1', 's1', { relation: 'contains' });
  g.addEdge('s1', 's2', { relation: 'calls' });
  return g;
}

describe('countVisible — header counts track the filters', () => {
  it('no filters → everything counts', () => {
    const v = countVisible(mkGraph(), {
      focusSet: null, activeNodeTypes: new Set(NODE_TYPES), allTypesActive: true,
      activeEdgeTypes: new Set(EDGE_TYPES), allEdgesActive: true,
    });
    expect(v).toEqual({ nodes: 3, edges: 2 });
  });

  it('unchecking one type drops those nodes AND their edges', () => {
    const v = countVisible(mkGraph(), {
      focusSet: null,
      activeNodeTypes: new Set(NODE_TYPES.filter((t) => t !== 'code_symbol')),
      allTypesActive: false,
      activeEdgeTypes: new Set(EDGE_TYPES), allEdgesActive: true,
    });
    expect(v).toEqual({ nodes: 1, edges: 0 });
  });

  it('relation deselection hides only that relation', () => {
    const v = countVisible(mkGraph(), {
      focusSet: null, activeNodeTypes: new Set(NODE_TYPES), allTypesActive: true,
      activeEdgeTypes: new Set([...EDGE_TYPES].filter((e) => e !== 'calls')), allEdgesActive: false,
    });
    expect(v.edges).toBe(1); // contains survives, calls hidden
  });
});

describe('depends_on — in the edge display vocab', () => {
  it('community-drill edges have a rail entry (cannot be orphaned by the filter)', () => {
    expect(EDGE_TYPES).toContain('depends_on');
  });
});

describe('deriveProgress — terminal snapshots expire', () => {
  const base = { indexing: false, phase: 'done', filesDone: 40, filesTotal: 40 };

  it('a fresh done snapshot is visible', () => {
    expect(deriveProgress({ ...base, finishedAt: Date.now() - 5_000 }).visible).toBe(true);
  });

  it('a done snapshot older than the TTL is hidden (no permanent "Indexed N files" bar)', () => {
    expect(deriveProgress({ ...base, finishedAt: Date.now() - TERMINAL_SNAPSHOT_VISIBLE_MS - 1_000 }).visible).toBe(false);
  });

  it('an error snapshot also expires', () => {
    expect(deriveProgress({ indexing: false, phase: 'error', error: 'boom', finishedAt: Date.now() - 120_000 }).visible).toBe(false);
  });

  it('no finishedAt (older daemon) keeps the legacy visible behavior', () => {
    expect(deriveProgress(base).visible).toBe(true);
  });

  it('an in-flight run is always visible regardless of age', () => {
    expect(deriveProgress({ indexing: true, phase: 'writing', filesDone: 3, filesTotal: 40, finishedAt: 0 }).visible).toBe(true);
  });
});
