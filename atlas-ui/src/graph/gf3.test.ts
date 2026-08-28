/**
 * gf3.test.ts — GF-3 (Folder + Import nodes) frontend wiring.
 *
 * The schema leaf (NODE_TYPE_META) now carries `code_folder` + `code_import`,
 * so NODE_COLORS / NODE_SIZES / the filter rail / the legend pick them up
 * automatically. The only NON-schema-driven surfaces are the `cls`→kind→type
 * mappers (GraphController + the nodeView duplicate). These assert that:
 *   1. The new drill kinds map to the right schema NodeType and color.
 *   2. The nodeView duplicate mapper agrees (it previously lagged GraphController).
 *   3. The filter predicate hides a folder/import node exactly when its type is
 *      deselected — i.e. the rail toggle works on the new types.
 */

import { describe, it, expect } from 'vitest';
import { kindToNodeType, colorForKind, type NodeKind } from './GraphController';
import { kindToNodeType as nvKindToNodeType } from './nodeView';
import { resolveNodeType, isNodeFilteredOut } from './filterPredicates';
import { NODE_COLORS } from '../types/graph';
import { NODE_TYPE_META, NODE_TYPES } from '@atlas-schema';

describe('GF-3 — folder/import kind→type/color mapping', () => {
  it('GraphController.kindToNodeType maps the new kinds to their schema types', () => {
    expect(kindToNodeType('folder' as NodeKind)).toBe('code_folder');
    expect(kindToNodeType('import' as NodeKind)).toBe('code_import');
  });

  it('colorForKind(folder/import) === the schema palette color (legend parity)', () => {
    expect(colorForKind('folder' as NodeKind)).toBe(NODE_TYPE_META['code_folder'].color);
    expect(colorForKind('import' as NodeKind)).toBe(NODE_TYPE_META['code_import'].color);
    // And distinct from each other + from file/symbol so they're legible.
    const palette = new Set([
      colorForKind('folder' as NodeKind),
      colorForKind('import' as NodeKind),
      colorForKind('file' as NodeKind),
      colorForKind('symbol' as NodeKind),
    ]);
    expect(palette.size).toBe(4);
  });

  it('the nodeView duplicate mapper agrees with GraphController', () => {
    expect(nvKindToNodeType('folder')).toBe('code_folder');
    expect(nvKindToNodeType('import')).toBe('code_import');
    // It previously lagged on `context` too — now mirrored.
    expect(nvKindToNodeType('context')).toBe('code_context');
  });

  it('the schema leaf carries both new types so NODE_COLORS resolves them', () => {
    expect(NODE_TYPES).toContain('code_folder');
    expect(NODE_TYPES).toContain('code_import');
    expect(NODE_COLORS['code_folder']).toBeTruthy();
    expect(NODE_COLORS['code_import']).toBeTruthy();
  });
});

describe('GF-3 — filter predicate hides folder/import when toggled off', () => {
  const base = { focusSet: null, allTypesActive: false };

  it('resolveNodeType resolves folder/import kinds (root nodes carry only kind)', () => {
    expect(resolveNodeType({ kind: 'folder' })).toBe('code_folder');
    expect(resolveNodeType({ kind: 'import' })).toBe('code_import');
  });

  it('a folder node hides exactly when code_folder is deselected', () => {
    const node = { nodeType: 'code_folder', kind: 'folder' };
    const active = new Set<string>([...NODE_TYPES].filter((t) => t !== 'code_folder'));
    expect(isNodeFilteredOut('d', node, { ...base, activeNodeTypes: active })).toBe(true);
    const all = new Set<string>(NODE_TYPES);
    expect(isNodeFilteredOut('d', node, { ...base, activeNodeTypes: all })).toBe(false);
  });

  it('an import node hides exactly when code_import is deselected', () => {
    const node = { nodeType: 'code_import', kind: 'import' };
    const active = new Set<string>([...NODE_TYPES].filter((t) => t !== 'code_import'));
    expect(isNodeFilteredOut('i', node, { ...base, activeNodeTypes: active })).toBe(true);
    const all = new Set<string>(NODE_TYPES);
    expect(isNodeFilteredOut('i', node, { ...base, activeNodeTypes: all })).toBe(false);
  });
});
