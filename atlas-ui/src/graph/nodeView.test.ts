/**
 * nodeView.test.ts — Sprint 3: degree/neighbor derivation for the inspector.
 *
 * liveNodeToGraphNode reads degree + neighbors straight off the live graphology
 * instance (FREE, no backend) and carries symbol line-fields through. These
 * tests build a tiny graph by hand and assert the derived view-model.
 */

import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { liveNodeToGraphNode, kindToNodeType } from './nodeView';

function fileNode(g: Graph, id: string, label: string, extra: Record<string, unknown> = {}) {
  g.addNode(id, { label, kind: 'file', level: 1, ...extra });
}
function symNode(g: Graph, id: string, label: string, extra: Record<string, unknown> = {}) {
  g.addNode(id, { label, kind: 'symbol', level: 2, ...extra });
}

describe('liveNodeToGraphNode — degree + neighbors', () => {
  it('derives degree and a labeled neighbor list from the live graph', () => {
    const g = new Graph({ type: 'undirected', multi: false });
    fileNode(g, 'code-file:a', 'a.ts', { file: 'src/a.ts', communityId: 3 });
    symNode(g, 'code-symbol:foo', 'function:foo');
    symNode(g, 'code-symbol:bar', 'function:bar');
    g.addEdge('code-file:a', 'code-symbol:foo', { relation: 'contains' });
    g.addEdge('code-file:a', 'code-symbol:bar', { relation: 'contains' });

    const view = liveNodeToGraphNode(g, 'code-file:a', 'ws');
    expect(view).not.toBeNull();
    expect(view!.degree).toBe(2);
    expect(view!.communityId).toBe(3);
    expect(view!.type).toBe('code_file');

    const neighborIds = (view!.neighbors ?? []).map((n) => n.id).sort();
    expect(neighborIds).toEqual(['code-symbol:bar', 'code-symbol:foo']);
    const fooN = (view!.neighbors ?? []).find((n) => n.id === 'code-symbol:foo');
    expect(fooN?.label).toBe('function:foo');
    expect(fooN?.kind).toBe('symbol');
  });

  it('a degree-0 node yields degree 0 and an empty neighbor list', () => {
    const g = new Graph({ type: 'undirected', multi: false });
    fileNode(g, 'code-file:lonely', 'lonely.ts', { file: 'src/lonely.ts' });
    const view = liveNodeToGraphNode(g, 'code-file:lonely', 'ws');
    expect(view!.degree).toBe(0);
    expect(view!.neighbors).toEqual([]);
  });

  it('carries symbol line/signature/qualifiedName fields through', () => {
    const g = new Graph({ type: 'undirected', multi: false });
    symNode(g, 'code-symbol:foo', 'function:foo', {
      file: 'src/a.ts',
      startLine: 12,
      endLine: 20,
      signature: 'function foo(): void',
      qualifiedName: 'A.foo',
    });
    const view = liveNodeToGraphNode(g, 'code-symbol:foo', 'ws');
    expect(view!.type).toBe('code_symbol');
    expect(view!.startLine).toBe(12);
    expect(view!.endLine).toBe(20);
    expect(view!.signature).toBe('function foo(): void');
    expect(view!.qualifiedName).toBe('A.foo');
    expect(view!.file).toBe('src/a.ts');
  });

  it('returns null for an absent node', () => {
    const g = new Graph({ type: 'undirected', multi: false });
    expect(liveNodeToGraphNode(g, 'nope', 'ws')).toBeNull();
  });
});

describe('kindToNodeType', () => {
  it('maps drill kinds onto schema node types', () => {
    expect(kindToNodeType('community')).toBe('architecture');
    expect(kindToNodeType('file')).toBe('code_file');
    expect(kindToNodeType('symbol')).toBe('code_symbol');
    expect(kindToNodeType('knowledge')).toBe('decision');
    expect(kindToNodeType('other')).toBe('code_symbol');
    expect(kindToNodeType('???')).toBe('code_symbol');
  });
});
