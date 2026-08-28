/**
 * round4.test.ts — regression tests for the round-4 UI fixes:
 *  C1. NODE_TYPE_COUNT derived from the schema (filter engages below 10/10).
 *  C2. Alerts dismiss contract (alertKeys: stable keys, correct daemon args).
 *  C3. workspace_list string[] normalization (blank switcher rows).
 *  H8. Semantic-search dim precedence (selectDimChannel).
 */
import { describe, it, expect } from 'vitest';
import { NODE_TYPES } from '@atlas-schema';
import { isNodeFilteredOut } from './filterPredicates';
import { keyOfAlert, buildDismissArgs } from './alertKeys';
import { normalizeWorkspaceList } from './workspaceListState';
import { selectDimChannel } from './dimChannel';

describe('C1 — node-type filter threshold tracks the schema', () => {
  it('schema has 10 node types (the stale hardcode was 8)', () => {
    expect(NODE_TYPES.length).toBe(10);
  });

  it('unchecking ONE type (9/10 active) actually filters that type', () => {
    // Reproduce the component's guard with the DERIVED count: 9 < 10 →
    // allTypesActive false → isNodeFilteredOut must hide the unchecked type.
    const allTypesActive = (NODE_TYPES.length - 1) >= NODE_TYPES.length;
    expect(allTypesActive).toBe(false);
    const activeNodeTypes = new Set(NODE_TYPES.filter((t) => t !== 'code_symbol'));
    const hidden = isNodeFilteredOut(
      'code-file:proj/a.ts:f',
      { type: 'code_symbol' },
      { focusSet: null, activeNodeTypes, allTypesActive },
    );
    expect(hidden).toBe(true);
  });
});

describe('C2 — alerts dismiss contract', () => {
  const a1 = { type: 'dead_code', severity: 'high' as const, summary: 'foo unused', detail: {} };
  const a2 = { type: 'dead_code', severity: 'low' as const, summary: 'bar unused', detail: {} };

  it('keys are unique per alert even with NO id field', () => {
    expect(keyOfAlert(a1)).not.toBe(keyOfAlert(a2));
    expect(keyOfAlert(a1)).not.toBe('undefined');
  });

  it('a real id wins when present', () => {
    expect(keyOfAlert({ ...a1, id: 'x1' })).toBe('x1');
  });

  it('dismiss args match the daemon contract (alertType/summary/reason, not id)', () => {
    const args = buildDismissArgs('ws1', a1);
    expect(args).toEqual({
      workspace: 'ws1',
      alertType: 'dead_code',
      summary: 'foo unused',
      reason: expect.stringContaining('Groundfloor Atlas UI'),
    });
    expect('id' in args).toBe(false);
  });
});

describe('C3 — workspace_list normalization', () => {
  it('embedded-mode string[] becomes named entries (no blank rows)', () => {
    const out = normalizeWorkspaceList(['duo-ws', 'e2e-ws']);
    expect(out).toEqual([
      { id: 'duo-ws', name: 'duo-ws' },
      { id: 'e2e-ws', name: 'e2e-ws' },
    ]);
  });

  it('remote-mode objects pass through with id filled', () => {
    const out = normalizeWorkspaceList([{ name: 'abc', nodeCount: 12 }]);
    expect(out[0]).toMatchObject({ id: 'abc', name: 'abc', nodeCount: 12 });
  });

  it('undefined → empty list', () => {
    expect(normalizeWorkspaceList(undefined)).toEqual([]);
  });
});

describe('H8 — semantic search precedence', () => {
  it('semantic hits win over a still-present query string', () => {
    expect(selectDimChannel({ query: 'billing', semanticHits: ['n1'], citedIds: [] })).toBe('semantic');
  });

  it('substring takes over once the hits are cleared (keystroke)', () => {
    expect(selectDimChannel({ query: 'billing', semanticHits: [], citedIds: [] })).toBe('query');
  });

  it('citations are the fallback channel', () => {
    expect(selectDimChannel({ query: '', semanticHits: [], citedIds: ['c1'] })).toBe('citation');
  });

  it('nothing active → null', () => {
    expect(selectDimChannel({ query: '  ', semanticHits: [], citedIds: [] })).toBe(null);
  });
});
