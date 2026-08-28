/**
 * selectionState.test.ts — the correctness core of the multi-select rails.
 *
 * The load-bearing case is the legacy edge: `activeEdgeTypes` defaults to ALL
 * `EDGE_TYPES` (which includes `related_to`), but the rail renders only
 * `VISIBLE_EDGE_TYPES` (legacy excluded). A naive `active.size / visible.length`
 * reads 10/9; `deriveTriState` must intersect and report 9/9 → "all".
 *
 * These tests reference the REAL schema vocab (not hand-copied literals) so they
 * stay honest if the schema's type lists change.
 */

import { describe, it, expect } from 'vitest';
import {
  NODE_TYPES,
  EDGE_TYPES,
  EDGE_TYPE_META,
  type NodeType,
  type EdgeType,
} from '@atlas-schema';
import { deriveTriState } from './selectionState';
import { CODE_NODE_TYPES, KNOWLEDGE_NODE_TYPES } from './nodeTypeCategories';

// Mirror the rail's VISIBLE_EDGE_TYPES (legacy `related_to` excluded).
const VISIBLE_EDGE_TYPES = EDGE_TYPES.filter((e) => !EDGE_TYPE_META[e].legacy);
const LEGACY_EDGE_TYPES = EDGE_TYPES.filter((e) => EDGE_TYPE_META[e].legacy);

describe('deriveTriState — legacy edge case (the whole reason this exists)', () => {
  it('reports 9/9 "all" when every visible edge is active AND active also holds the hidden legacy type', () => {
    // Default state: active = ALL EDGE_TYPES (10, incl. related_to).
    const active = new Set<EdgeType>(EDGE_TYPES);
    const result = deriveTriState(active, VISIBLE_EDGE_TYPES);

    expect(result.total).toBe(VISIBLE_EDGE_TYPES.length); // 9
    expect(result.selected).toBe(VISIBLE_EDGE_TYPES.length); // 9, NOT 10
    expect(result.state).toBe('all');
    // Sanity: there really is a hidden legacy member inflating active.size.
    expect(LEGACY_EDGE_TYPES.length).toBeGreaterThan(0);
    expect(active.size).toBeGreaterThan(result.total);
  });

  it('a lone active legacy edge counts as "none" against the visible list', () => {
    const active = new Set<EdgeType>(LEGACY_EDGE_TYPES);
    const result = deriveTriState(active, VISIBLE_EDGE_TYPES);
    expect(result.selected).toBe(0);
    expect(result.state).toBe('none');
    expect(result.total).toBe(VISIBLE_EDGE_TYPES.length);
  });
});

describe('deriveTriState — node-type category subsets', () => {
  it('Code category: all code types active + all knowledge active → over CODE list reads "all"', () => {
    // activeNodeTypes defaults to ALL NODE_TYPES; the Code section only shows
    // CODE_NODE_TYPES, so the header for that section must read code/code.
    const active = new Set<NodeType>(NODE_TYPES);
    const result = deriveTriState(active, CODE_NODE_TYPES);
    expect(result.selected).toBe(CODE_NODE_TYPES.length);
    expect(result.total).toBe(CODE_NODE_TYPES.length);
    expect(result.state).toBe('all');
    // Knowledge types in `active` do NOT count toward the Code header.
    expect(active.size).toBeGreaterThan(CODE_NODE_TYPES.length);
  });

  it('Knowledge category: only code types active → Knowledge header reads "none"', () => {
    const active = new Set<NodeType>(CODE_NODE_TYPES);
    const result = deriveTriState(active, KNOWLEDGE_NODE_TYPES);
    expect(result.selected).toBe(0);
    expect(result.state).toBe('none');
    expect(result.total).toBe(KNOWLEDGE_NODE_TYPES.length);
  });

  it('Knowledge category: exactly its own types active → Knowledge header reads "all", Code reads "none"', () => {
    const active = new Set<NodeType>(KNOWLEDGE_NODE_TYPES);
    expect(deriveTriState(active, KNOWLEDGE_NODE_TYPES).state).toBe('all');
    expect(deriveTriState(active, CODE_NODE_TYPES).state).toBe('none');
  });
});

describe('deriveTriState — projects', () => {
  const projects = ['/repo/a', '/repo/b', '/repo/c'] as const;

  it('all projects active → "all", 3/3', () => {
    const active = new Set<string>(projects);
    const r = deriveTriState(active, projects);
    expect(r).toEqual({ state: 'all', selected: 3, total: 3 });
  });

  it('active project not in the visible list is ignored', () => {
    // A stale/removed project lingering in the active set must not inflate.
    const active = new Set<string>([...projects, '/repo/removed']);
    const r = deriveTriState(active, projects);
    expect(r).toEqual({ state: 'all', selected: 3, total: 3 });
  });
});

describe('deriveTriState — none / some boundaries', () => {
  it('empty active → "none"', () => {
    const r = deriveTriState(new Set<string>(), ['x', 'y', 'z']);
    expect(r).toEqual({ state: 'none', selected: 0, total: 3 });
  });

  it('strict subset → "some"', () => {
    const r = deriveTriState(new Set(['x', 'y']), ['x', 'y', 'z']);
    expect(r).toEqual({ state: 'some', selected: 2, total: 3 });
  });

  it('single of many → "some"', () => {
    const r = deriveTriState(new Set(['y']), ['x', 'y', 'z']);
    expect(r).toEqual({ state: 'some', selected: 1, total: 3 });
  });

  it('empty visible list → "none", 0/0 (never divides)', () => {
    const r = deriveTriState(new Set(['x']), []);
    expect(r).toEqual({ state: 'none', selected: 0, total: 0 });
  });
});
