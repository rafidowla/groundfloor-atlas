/**
 * GraphController.test.ts — unit tests for the framework-agnostic drill-down
 * core. Uses a FAKE Fetcher (no network) and a REAL graphology Graph. These
 * assertions are the B2 contract: ownership-inversion (single mutated graph),
 * radial placement with NO global relayout, refcounted collapse, truncation
 * surfacing, and multi-workspace isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import Graph from 'graphology';
import { GraphController, communityNodeId, type Fetcher } from './GraphController';

// GF-4: community ids are content-stable strings (label slug + anchor), not
// dense ints. The fake fetcher below models two communities with stable ids;
// these constants stand in for the old `0` / `1`.
const MAIN_C0 = 'core~a';
const MAIN_C1 = 'utils~c';

// ── Fake fetcher ───────────────────────────────────────────────────────────
//
// Models a tiny three-level graph:
//   community 0  → files A, B
//   community 1  → file C, file SHARED (also a child of file A)
//   file A       → symbols sym1, sym2, plus SHARED (so SHARED has 2 parents)
//   file B       → symbol sym3
//   symbol sym1  → neighbor symN

type SubgraphResult = Awaited<ReturnType<Fetcher['subgraph']>>;

function node(id: string, type: string, cls: string, label = id) {
  return { id, type, label, cls };
}

function makeFetcher(overrides?: Partial<Fetcher>): Fetcher {
  const base: Fetcher = {
    async communities() {
      return {
        communities: [
          { id: 'core~a', label: 'core', fileCount: 2 },
          { id: 'utils~c', label: 'utils', fileCount: 2 },
        ],
        edges: [],
      };
    },
    async subgraph(_ws, opts): Promise<SubgraphResult> {
      // community → files
      if (opts.community === 'core~a') {
        return {
          nodes: [
            node('code-file:A', 'code_file', 'file'),
            node('code-file:B', 'code_file', 'file'),
          ],
          edges: [{ source: 'code-file:A', target: 'code-file:B', relation: 'related_to' }],
          truncated: false,
        };
      }
      if (opts.community === 'utils~c') {
        return {
          nodes: [
            node('code-file:C', 'code_file', 'file'),
            node('code-file:SHARED', 'code_file', 'file'),
          ],
          edges: [],
          truncated: false,
        };
      }
      // file → symbols
      if (opts.center === 'code-file:A') {
        return {
          nodes: [
            node('code-file:A', 'code_file', 'file'), // seed echoed back — must be filtered out
            node('code-symbol:sym1', 'code_symbol', 'symbol'),
            node('code-symbol:sym2', 'code_symbol', 'symbol'),
            node('code-file:SHARED', 'code_file', 'file'), // shared with community 1
          ],
          edges: [
            { source: 'code-file:A', target: 'code-symbol:sym1', relation: 'related_to' },
            { source: 'code-file:A', target: 'code-symbol:sym2', relation: 'related_to' },
          ],
          truncated: false,
        };
      }
      if (opts.center === 'code-file:B') {
        return {
          nodes: [node('code-symbol:sym3', 'code_symbol', 'symbol')],
          edges: [],
          truncated: false,
        };
      }
      // symbol → neighbors
      if (opts.center === 'code-symbol:sym1') {
        return {
          nodes: [node('code-symbol:symN', 'code_symbol', 'symbol')],
          edges: [{ source: 'code-symbol:sym1', target: 'code-symbol:symN', relation: 'related_to' }],
          truncated: false,
        };
      }
      return { nodes: [], edges: [], truncated: false };
    },
  };
  return { ...base, ...overrides };
}

function newGraph(): Graph {
  return new Graph({ type: 'undirected', multi: false });
}

describe('GraphController.loadLevel0', () => {
  it('adds one node per community, all level 0, none expanded', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    const res = await c.loadLevel0();

    expect(res.count).toBe(2);
    expect(g.order).toBe(2);
    expect(g.hasNode(communityNodeId(MAIN_C0))).toBe(true);
    expect(g.hasNode(communityNodeId(MAIN_C1))).toBe(true);
    for (const id of g.nodes()) {
      expect(g.getNodeAttribute(id, 'level')).toBe(0);
      expect(g.getNodeAttribute(id, 'kind')).toBe('community');
      expect(g.getNodeAttribute(id, 'expanded')).toBe(false);
      expect(c.isExpanded(id)).toBe(false);
    }
  });

  it('is idempotent — re-calling loadLevel0 does not duplicate community nodes', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.loadLevel0();
    expect(g.order).toBe(2);
  });
});

describe('GraphController.expand', () => {
  it('expanding a community adds its file children + edges, sets parent expanded', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();

    const res = await c.expand(communityNodeId(MAIN_C0));
    expect(res.added).toBe(2);
    expect(g.hasNode('code-file:A')).toBe(true);
    expect(g.hasNode('code-file:B')).toBe(true);
    expect(g.hasEdge('code-file:A', 'code-file:B')).toBe(true);

    // parent flagged expanded
    expect(c.isExpanded(communityNodeId(MAIN_C0))).toBe(true);
    expect(g.getNodeAttribute(communityNodeId(MAIN_C0), 'expanded')).toBe(true);

    // children carry parentId + level 1
    for (const fid of ['code-file:A', 'code-file:B']) {
      expect(g.getNodeAttribute(fid, 'parentId')).toBe(communityNodeId(MAIN_C0));
      expect(g.getNodeAttribute(fid, 'parents')).toContain(communityNodeId(MAIN_C0));
      expect(g.getNodeAttribute(fid, 'level')).toBe(1);
      expect(g.getNodeAttribute(fid, 'kind')).toBe('file');
    }
  });

  it('is idempotent — second expand adds 0', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    const orderAfterFirst = g.order;

    const second = await c.expand(communityNodeId(MAIN_C0));
    expect(second.added).toBe(0);
    expect(g.order).toBe(orderAfterFirst);
  });

  it('three-level drill works: community → file → symbol', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0)); // → files A, B
    await c.expand('code-file:A'); // → sym1, sym2 (+ SHARED)

    expect(g.hasNode('code-symbol:sym1')).toBe(true);
    expect(g.hasNode('code-symbol:sym2')).toBe(true);
    expect(g.getNodeAttribute('code-symbol:sym1', 'level')).toBe(2);
    expect(g.getNodeAttribute('code-symbol:sym1', 'kind')).toBe('symbol');

    // drill a third level: symbol → neighbor
    await c.expand('code-symbol:sym1');
    expect(g.hasNode('code-symbol:symN')).toBe(true);
    expect(g.getNodeAttribute('code-symbol:symN', 'level')).toBe(3);
  });

  it('does NOT add the center seed itself as its own child', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    // file A slice echoes code-file:A back; it must not be re-added as a child of itself
    await c.expand('code-file:A');
    expect(g.getNodeAttribute('code-file:A', 'parents')).not.toContain('code-file:A');
  });
});

describe('GraphController.collapse', () => {
  it('removes the file subtree (and expanded symbol descendants) but not unrelated nodes', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0)); // files A, B
    await c.expand('code-file:A'); // sym1, sym2, SHARED
    await c.expand('code-symbol:sym1'); // symN (deep descendant)

    const unrelated = communityNodeId(MAIN_C1);
    expect(g.hasNode(unrelated)).toBe(true);

    const { removed } = c.collapse(communityNodeId(MAIN_C0));

    // community 0 subtree gone: files A, B, symbols sym1, sym2, symN, and SHARED
    // (SHARED is only owned by community 0's subtree so far → removed)
    expect(g.hasNode('code-file:A')).toBe(false);
    expect(g.hasNode('code-file:B')).toBe(false);
    expect(g.hasNode('code-symbol:sym1')).toBe(false);
    expect(g.hasNode('code-symbol:symN')).toBe(false);
    expect(removed).toBeGreaterThanOrEqual(5);

    // parent itself survives, marked collapsed; unrelated community untouched
    expect(g.hasNode(communityNodeId(MAIN_C0))).toBe(true);
    expect(c.isExpanded(communityNodeId(MAIN_C0))).toBe(false);
    expect(g.hasNode(unrelated)).toBe(true);
  });

  it('a node shared by two parents survives until BOTH collapse (refcount)', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    // Two parents that both reach code-file:SHARED:
    //   community 1 → SHARED ; file A → SHARED
    await c.expand(communityNodeId(MAIN_C0)); // files A, B
    await c.expand('code-file:A'); // sym1, sym2, SHARED  (SHARED parent = file A)
    await c.expand(communityNodeId(MAIN_C1)); // file C, SHARED   (SHARED parent += community 1)

    // SHARED now has two parents
    const shared = 'code-file:SHARED';
    expect(g.getNodeAttribute(shared, 'parents').sort()).toEqual(
      ['code-file:A', communityNodeId(MAIN_C1)].sort(),
    );

    // Collapse community 1 → retracts ONE parent edge; SHARED must survive
    c.collapse(communityNodeId(MAIN_C1));
    expect(g.hasNode(shared)).toBe(true);
    expect(g.getNodeAttribute(shared, 'parents')).toEqual(['code-file:A']);
    expect(g.hasNode('code-file:C')).toBe(false); // C only owned by community 1 → gone

    // Collapse file A → retracts the last parent; SHARED finally drops
    c.collapse('code-file:A');
    expect(g.hasNode(shared)).toBe(false);
  });

  it('re-sizes a hub back toward its level baseline after its child edges collapse away', async () => {
    // A community with a single hub file; expanding the hub pulls in 4 symbols,
    // each joined to the hub by a `contains` edge → the hub's degree (and so its
    // degree-aware size) inflates. Collapsing the hub drops those symbols + edges,
    // returning the hub to degree 0 — its size MUST shrink back to the level
    // baseline (regression: collapse used to leave the inflated size in place).
    const hubFetcher: Fetcher = {
      async communities() {
        return { communities: [{ id: MAIN_C0, label: 'core', fileCount: 1 }], edges: [] };
      },
      async subgraph(_ws, opts): Promise<SubgraphResult> {
        if (opts.community === MAIN_C0) {
          return { nodes: [node('code-file:HUB', 'code_file', 'file')], edges: [], truncated: false };
        }
        if (opts.center === 'code-file:HUB') {
          return {
            nodes: [
              node('code-symbol:s1', 'code_symbol', 'symbol'),
              node('code-symbol:s2', 'code_symbol', 'symbol'),
              node('code-symbol:s3', 'code_symbol', 'symbol'),
              node('code-symbol:s4', 'code_symbol', 'symbol'),
            ],
            edges: [
              { source: 'code-file:HUB', target: 'code-symbol:s1', relation: 'contains' },
              { source: 'code-file:HUB', target: 'code-symbol:s2', relation: 'contains' },
              { source: 'code-file:HUB', target: 'code-symbol:s3', relation: 'contains' },
              { source: 'code-file:HUB', target: 'code-symbol:s4', relation: 'contains' },
            ],
            truncated: false,
          };
        }
        return { nodes: [], edges: [], truncated: false };
      },
    };

    const g = newGraph();
    const c = new GraphController(g, hubFetcher, 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0)); // adds code-file:HUB (level 1, degree 0)

    const hub = 'code-file:HUB';
    const baseline = g.getNodeAttribute(hub, 'size') as number; // degree 0 → level baseline

    await c.expand(hub); // 4 symbols + 4 `contains` edges → hub degree 4
    const inflated = g.getNodeAttribute(hub, 'size') as number;
    expect(inflated).toBeGreaterThan(baseline); // hub grew with its degree

    c.collapse(hub); // drop the 4 symbols + their edges → hub degree back to 0
    expect(g.hasNode('code-symbol:s1')).toBe(false);
    expect(g.hasNode(hub)).toBe(true);
    expect(g.degree(hub)).toBe(0);

    const collapsed = g.getNodeAttribute(hub, 'size') as number;
    expect(collapsed).toBeLessThan(inflated); // shrank back
    expect(collapsed).toBeCloseTo(baseline, 5); // all the way to the level baseline
  });
});

describe('GraphController truncation', () => {
  it('truncated:true from fetcher sets parent.truncatedChildren and is returned', async () => {
    const g = newGraph();
    const fetcher = makeFetcher({
      async subgraph(_ws, opts): Promise<SubgraphResult> {
        if (opts.community === MAIN_C0) {
          return {
            nodes: [node('code-file:A', 'code_file', 'file')],
            edges: [],
            truncated: true,
          };
        }
        return { nodes: [], edges: [], truncated: false };
      },
    });
    const c = new GraphController(g, fetcher, 'ws');
    await c.loadLevel0();

    const res = await c.expand(communityNodeId(MAIN_C0));
    expect(res.truncated).toBe(true);
    expect(g.getNodeAttribute(communityNodeId(MAIN_C0), 'truncatedChildren')).toBe(true);
  });
});

describe('GraphController no-global-relayout', () => {
  it('expand never imports/calls forceatlas2 and leaves pre-existing node positions UNCHANGED', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0)); // files A, B placed around community 0

    // Snapshot every existing node position BEFORE a deeper expand.
    const before = new Map<string, { x: number; y: number }>();
    g.forEachNode((id) => {
      before.set(id, {
        x: g.getNodeAttribute(id, 'x') as number,
        y: g.getNodeAttribute(id, 'y') as number,
      });
    });

    // Expanding file A must place only the NEW symbols; it must not move A, B,
    // or the community nodes (that would mean a global relayout happened).
    await c.expand('code-file:A');

    for (const [id, pos] of before) {
      expect(g.getNodeAttribute(id, 'x')).toBe(pos.x);
      expect(g.getNodeAttribute(id, 'y')).toBe(pos.y);
    }
  });

  it('places children deterministically (sorted by id) so layout is reproducible', async () => {
    const runOnce = async () => {
      const g = newGraph();
      const c = new GraphController(g, makeFetcher(), 'ws');
      await c.loadLevel0();
      await c.expand(communityNodeId(MAIN_C0));
      return {
        ax: g.getNodeAttribute('code-file:A', 'x'),
        ay: g.getNodeAttribute('code-file:A', 'y'),
        bx: g.getNodeAttribute('code-file:B', 'x'),
        by: g.getNodeAttribute('code-file:B', 'y'),
      };
    };
    expect(await runOnce()).toEqual(await runOnce());
  });
});

describe('GraphController multi-workspace isolation', () => {
  it('two controllers over two graphs do not share state', async () => {
    const g1 = newGraph();
    const g2 = newGraph();
    const c1 = new GraphController(g1, makeFetcher(), 'ws-1');
    const c2 = new GraphController(g2, makeFetcher(), 'ws-2');

    await c1.loadLevel0();
    await c1.expand(communityNodeId(MAIN_C0)); // mutate g1 only

    // g2 untouched by g1's mutations
    expect(g2.order).toBe(0);

    await c2.loadLevel0();
    expect(g2.order).toBe(2);
    // g1 already has communities + files; g2 only communities
    expect(g1.order).toBeGreaterThan(g2.order);
    expect(g2.hasNode('code-file:A')).toBe(false);
  });
});

describe('GraphController.focus (Sprint 2 — neighborhood depth)', () => {
  it('focus(seed, depth) wraps subgraph({center, depth}) and merges via the radial path', async () => {
    const g = newGraph();
    const fetcher = makeFetcher();
    const spy = vi.spyOn(fetcher, 'subgraph');
    const c = new GraphController(g, fetcher, 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0)); // files A, B
    await c.expand('code-file:A'); // sym1, sym2, SHARED
    spy.mockClear();

    const res = await c.focus('code-symbol:sym1', 2);

    // It asked the fetcher for the seed's neighborhood at the given depth, with
    // NO nodeTypes filter (focus shows the whole neighborhood).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ center: 'code-symbol:sym1', depth: 2 });
    expect(spy.mock.calls[0][1]).not.toHaveProperty('nodeTypes');

    // The neighbor was merged in radially (new node added under the seed).
    expect(g.hasNode('code-symbol:symN')).toBe(true);
    expect(g.getNodeAttribute('code-symbol:symN', 'parents')).toContain('code-symbol:sym1');
    expect(res.added).toBe(1);
  });

  it('returns a focusSet = seed + every returned neighbor (de-duped, seed echo removed)', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    await c.expand('code-file:A');

    const { focusSet } = await c.focus('code-symbol:sym1', 1);
    // seed + the one returned neighbor.
    expect(new Set(focusSet)).toEqual(new Set(['code-symbol:sym1', 'code-symbol:symN']));
    // No duplicate seed entry even though some slices echo the seed back.
    expect(focusSet.filter((id) => id === 'code-symbol:sym1')).toHaveLength(1);
  });

  it('focus default depth is 2', async () => {
    const g = newGraph();
    const fetcher = makeFetcher();
    const spy = vi.spyOn(fetcher, 'subgraph');
    const c = new GraphController(g, fetcher, 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    await c.expand('code-file:A');
    spy.mockClear();

    await c.focus('code-symbol:sym1'); // no depth arg
    expect(spy.mock.calls[0][1]).toMatchObject({ depth: 2 });
  });

  it('does NOT mark the focused node expanded (focus is transient, not a drill step)', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    await c.expand('code-file:A');

    expect(c.isExpanded('code-symbol:sym1')).toBe(false);
    await c.focus('code-symbol:sym1', 1);
    expect(c.isExpanded('code-symbol:sym1')).toBe(false);
  });

  it('focus on a non-existent node is a safe no-op with an empty focusSet', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    const res = await c.focus('does-not-exist', 2);
    expect(res.added).toBe(0);
    expect(res.focusSet).toEqual([]);
  });

  it('focus leaves pre-existing node positions UNCHANGED (no global relayout)', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    await c.expand('code-file:A');

    const before = new Map<string, { x: number; y: number }>();
    g.forEachNode((id) => {
      before.set(id, {
        x: g.getNodeAttribute(id, 'x') as number,
        y: g.getNodeAttribute(id, 'y') as number,
      });
    });

    await c.focus('code-symbol:sym1', 1); // adds symN only

    for (const [id, pos] of before) {
      expect(g.getNodeAttribute(id, 'x')).toBe(pos.x);
      expect(g.getNodeAttribute(id, 'y')).toBe(pos.y);
    }
  });
});

describe('GraphController empty / edge-case fetcher behavior', () => {
  it('loadLevel0 with empty communities adds nothing and reports count 0', async () => {
    const g = newGraph();
    const c = new GraphController(
      g,
      makeFetcher({ async communities() { return { communities: [], edges: [] }; } }),
      'ws',
    );
    const res = await c.loadLevel0();
    expect(res.count).toBe(0);
    expect(g.order).toBe(0);
  });

  it('expanding a non-existent node is a safe no-op', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    const res = await c.expand('does-not-exist');
    expect(res.added).toBe(0);
  });

  it('collapse of an unexpanded node removes nothing', async () => {
    const g = newGraph();
    const c = new GraphController(g, makeFetcher(), 'ws');
    await c.loadLevel0();
    const { removed } = c.collapse(communityNodeId(MAIN_C0));
    expect(removed).toBe(0);
  });

  it('does not call the layout: subgraph fetcher is the only data source (spy)', async () => {
    const g = newGraph();
    const fetcher = makeFetcher();
    const spy = vi.spyOn(fetcher, 'subgraph');
    const c = new GraphController(g, fetcher, 'ws');
    await c.loadLevel0();
    await c.expand(communityNodeId(MAIN_C0));
    // community expand → exactly one subgraph call with the community seed
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ community: MAIN_C0, nodeTypes: ['code_file'] });
  });
});
