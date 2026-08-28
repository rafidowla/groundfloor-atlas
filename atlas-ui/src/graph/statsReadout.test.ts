/**
 * statsReadout.test.ts — Sprint 4 header stats derivation (PURE).
 *
 * Pins the HONEST-LABEL contract (diagnosis §1): communities are a workspace
 * count; nodes/edges are the LOADED view and are labeled "in view" so they're
 * never mistaken for a workspace total. Community count is omitted (not shown as
 * 0) until atlas_communities.total has actually loaded.
 */

import { describe, it, expect } from 'vitest';
import { deriveStats } from './statsReadout';

describe('deriveStats', () => {
  it('labels nodes/edges as the LOADED view, not a total', () => {
    const items = deriveStats({ communities: 4, loadedNodes: 12, loadedEdges: 7 });
    expect(items).toEqual([
      { value: '4', label: 'communities' },
      { value: '12', label: 'nodes in view' },
      { value: '7', label: 'edges in view' },
    ]);
    // No item implies a workspace total for nodes/edges.
    expect(items.every((i) => !/total/i.test(i.label))).toBe(true);
  });

  it('omits the community stat until total has loaded (null), never flashing 0', () => {
    const items = deriveStats({ communities: null, loadedNodes: 3, loadedEdges: 1 });
    expect(items.map((i) => i.label)).toEqual(['nodes in view', 'edge in view']);
    expect(items.find((i) => /communit/.test(i.label))).toBeUndefined();
  });

  it('singularizes labels for a count of 1', () => {
    const items = deriveStats({ communities: 1, loadedNodes: 1, loadedEdges: 1 });
    expect(items).toEqual([
      { value: '1', label: 'community' },
      { value: '1', label: 'node in view' },
      { value: '1', label: 'edge in view' },
    ]);
  });

  it('shows a genuine zero community count once loaded (0, not omitted)', () => {
    const items = deriveStats({ communities: 0, loadedNodes: 0, loadedEdges: 0 });
    expect(items[0]).toEqual({ value: '0', label: 'communities' });
  });

  it('locale-formats large counts', () => {
    const items = deriveStats({ communities: 1234, loadedNodes: 65710, loadedEdges: 254230 });
    expect(items[0].value).toBe('1,234');
    expect(items[1].value).toBe('65,710');
    expect(items[2].value).toBe('254,230');
  });
});
