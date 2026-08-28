/**
 * filterPredicates.test.ts — Sprint 2 filter logic + schema-color parity.
 *
 * Two contracts:
 *  1. A node/edge is hard-hidden IFF its (resolved) type / relation is
 *     deselected, or (nodes) it falls outside an active focus set. All-selected
 *     and no-focus = nothing hidden.
 *  2. The legend/filter colors (NODE_TYPE_META) match what GraphController
 *     renders (colorForKind), so the rail truly doubles as the legend.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveNodeType,
  isNodeFilteredOut,
  isEdgeFilteredOut,
} from './filterPredicates';
import { colorForKind, kindToNodeType, type NodeKind } from './GraphController';
import { NODE_TYPE_META, EDGE_TYPES, NODE_TYPES } from '@atlas-schema';

const ALL_NODE_TYPES = new Set<string>(NODE_TYPES);
const ALL_EDGE_TYPES = new Set<string>(EDGE_TYPES);

describe('resolveNodeType', () => {
  it('prefers the raw backend nodeType attr when present (expanded children)', () => {
    expect(resolveNodeType({ nodeType: 'code_symbol', kind: 'symbol' })).toBe('code_symbol');
    expect(resolveNodeType({ nodeType: 'decision', kind: 'knowledge' })).toBe('decision');
  });

  it('falls back to kind→NodeType for roots that carry only `kind`', () => {
    // community/file roots: controller never writes nodeType on them.
    expect(resolveNodeType({ kind: 'community' })).toBe('architecture');
    expect(resolveNodeType({ kind: 'file' })).toBe('code_file');
    expect(resolveNodeType({ kind: 'symbol' })).toBe('code_symbol');
    expect(resolveNodeType({ kind: 'context' })).toBe('code_context');
  });

  it('defaults missing/unknown kind to code_symbol', () => {
    expect(resolveNodeType({})).toBe('code_symbol');
  });
});

describe('isNodeFilteredOut — hidden IFF type deselected (no focus)', () => {
  const base = { focusSet: null, allTypesActive: false };

  it('all types active → never hidden by type', () => {
    const data = { kind: 'symbol' };
    expect(
      isNodeFilteredOut('n', data, {
        focusSet: null,
        activeNodeTypes: ALL_NODE_TYPES,
        allTypesActive: true,
      }),
    ).toBe(false);
  });

  it('a node is hidden exactly when its resolved type is NOT in the active set', () => {
    const fileNode = { kind: 'file' }; // → code_file
    const symbolNode = { nodeType: 'code_symbol' };

    // Active set EXCLUDES code_file → the file node hides, the symbol does not.
    const active = new Set<string>([...NODE_TYPES].filter((t) => t !== 'code_file'));
    expect(isNodeFilteredOut('f', fileNode, { ...base, activeNodeTypes: active })).toBe(true);
    expect(isNodeFilteredOut('s', symbolNode, { ...base, activeNodeTypes: active })).toBe(false);

    // Re-add code_file → file node no longer hidden.
    const active2 = new Set<string>(NODE_TYPES);
    expect(isNodeFilteredOut('f', fileNode, { ...base, activeNodeTypes: active2 })).toBe(false);
  });

  it('every node type round-trips: deselect exactly one type, only that type hides', () => {
    for (const t of NODE_TYPES) {
      const active = new Set<string>([...NODE_TYPES].filter((x) => x !== t));
      // A node OF type t hides; a node of any other type stays.
      expect(isNodeFilteredOut('x', { nodeType: t }, { ...base, activeNodeTypes: active })).toBe(true);
      const other = NODE_TYPES.find((x) => x !== t)!;
      expect(
        isNodeFilteredOut('y', { nodeType: other }, { ...base, activeNodeTypes: active }),
      ).toBe(false);
    }
  });
});

describe('isNodeFilteredOut — focus set is a hard filter', () => {
  it('with a focus set, only members survive (regardless of type)', () => {
    const focus = new Set(['keep:1', 'keep:2']);
    const opts = { focusSet: focus, activeNodeTypes: ALL_NODE_TYPES, allTypesActive: true };
    expect(isNodeFilteredOut('keep:1', { kind: 'symbol' }, opts)).toBe(false);
    expect(isNodeFilteredOut('drop:9', { kind: 'symbol' }, opts)).toBe(true);
  });

  it('focus + type filter compose: a focus member with a deselected type still hides', () => {
    const focus = new Set(['n']);
    const active = new Set<string>([...NODE_TYPES].filter((t) => t !== 'code_file'));
    expect(
      isNodeFilteredOut('n', { kind: 'file' }, { focusSet: focus, activeNodeTypes: active, allTypesActive: false }),
    ).toBe(true);
  });
});

describe('isEdgeFilteredOut — hidden IFF relation deselected', () => {
  it('all edges active → never hidden', () => {
    for (const r of EDGE_TYPES) {
      expect(isEdgeFilteredOut(r, { activeEdgeTypes: ALL_EDGE_TYPES, allEdgesActive: true })).toBe(false);
    }
  });

  it('deselect exactly one relation → only that relation hides', () => {
    for (const r of EDGE_TYPES) {
      const active = new Set<string>([...EDGE_TYPES].filter((x) => x !== r));
      expect(isEdgeFilteredOut(r, { activeEdgeTypes: active, allEdgesActive: false })).toBe(true);
      const other = EDGE_TYPES.find((x) => x !== r)!;
      expect(isEdgeFilteredOut(other, { activeEdgeTypes: active, allEdgesActive: false })).toBe(false);
    }
  });

  it('untyped edges (empty relation) are never hidden by the relation filter', () => {
    const active = new Set<string>(); // nothing selected
    expect(isEdgeFilteredOut('', { activeEdgeTypes: active, allEdgesActive: false })).toBe(false);
  });
});

describe('schema-color parity — legend swatch == rendered node color', () => {
  const KINDS: NodeKind[] = ['community', 'file', 'symbol', 'context', 'folder', 'import', 'knowledge', 'other'];

  it('colorForKind(kind) === NODE_TYPE_META[kindToNodeType(kind)].color for every kind', () => {
    for (const kind of KINDS) {
      const expected = NODE_TYPE_META[kindToNodeType(kind)].color;
      expect(colorForKind(kind)).toBe(expected);
    }
  });

  it('community renders the violet architecture color (no longer a divergent hardcode)', () => {
    expect(colorForKind('community')).toBe(NODE_TYPE_META.architecture.color);
    expect(colorForKind('community')).toBe('#8b5cf6');
  });

  it('symbol renders the schema teal (regression: was slate #64748b before Sprint 2)', () => {
    expect(colorForKind('symbol')).toBe(NODE_TYPE_META.code_symbol.color);
    expect(colorForKind('symbol')).toBe('#14b8a6');
  });
});
