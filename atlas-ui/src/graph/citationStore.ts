/**
 * citationStore.ts — B4 PART 2: the framework-agnostic citation store.
 *
 * WHAT THIS IS
 * When a chat answer is grounded in retrieved nodes (knowledge_recall hits,
 * atlas_subgraph file fields, blast-radius symbols, etc.), those node ids /
 * file paths are the answer's "citations". This store holds the current cited
 * set so the GRAPH tab can highlight them — even though chat and graph are
 * different routes that never share React state today (the B0 critique flagged
 * the all-prop-drilling problem; a single global store would clobber across
 * workspaces).
 *
 * WHY A PLAIN CLASS (like GraphController)
 * No React, no Sigma — just a Map + a Set of listeners. That makes it
 * pure/unit-testable in isolation (citationStore.test.ts) and lets the React
 * Context wrapper (CitationProvider) be a thin adapter over it. Same shape as
 * GraphController: load-bearing logic here, framework glue elsewhere.
 *
 * WORKSPACE SCOPING (the isolation boundary)
 * Citations are keyed by workspace id. setCitations('A', …) NEVER affects
 * getCitations('B'). Two open workspaces (two graph tabs) keep independent
 * highlight sets — a citation produced on workspace A's chat tab highlights
 * only workspace A's graph, never B's. This is the explicit fix for the
 * "single shared store would clobber across workspaces" critique.
 *
 * LISTENERS
 * subscribe(cb) returns an unsubscribe fn. Every mutation (set/clear) fires all
 * listeners with the workspace that changed, so the graph layer can re-derive
 * its nodeReducer reactively. set() is idempotent: setting the SAME set of ids
 * (order-independent) does NOT fire listeners, so a re-render that re-sends the
 * same citations won't thrash the graph.
 */

/** Callback fired on every citation mutation, with the workspace that changed. */
export type CitationListener = (workspace: string) => void;

export class CitationStore {
  /** workspace id → set of cited node ids / file paths. */
  private readonly byWorkspace = new Map<string, Set<string>>();
  private readonly listeners = new Set<CitationListener>();

  /**
   * Replace the cited set for `workspace` with `ids` (deduped). Empty/blank ids
   * are dropped. Idempotent: if the resulting set equals the existing one (same
   * members, order-independent), this is a no-op and listeners do NOT fire.
   */
  setCitations(workspace: string, ids: readonly string[]): void {
    if (!workspace) return;
    const next = new Set<string>();
    for (const raw of ids) {
      const id = (raw ?? '').trim();
      if (id) next.add(id);
    }

    const current = this.byWorkspace.get(workspace);
    if (current && setsEqual(current, next)) return; // idempotent — no churn
    if (!current && next.size === 0) return; // nothing to nothing — no-op

    if (next.size === 0) {
      this.byWorkspace.delete(workspace);
    } else {
      this.byWorkspace.set(workspace, next);
    }
    this.emit(workspace);
  }

  /** Current cited ids for `workspace` as a fresh array (never the internal Set). */
  getCitations(workspace: string): string[] {
    const set = this.byWorkspace.get(workspace);
    return set ? [...set] : [];
  }

  /** True iff `id` is currently cited in `workspace` (cheap graph-reducer check). */
  isCited(workspace: string, id: string): boolean {
    const set = this.byWorkspace.get(workspace);
    return set ? set.has(id) : false;
  }

  /** Clear all citations for `workspace`. Fires listeners only if there were any. */
  clear(workspace: string): void {
    if (!this.byWorkspace.has(workspace)) return; // already empty — no-op
    this.byWorkspace.delete(workspace);
    this.emit(workspace);
  }

  /**
   * Subscribe to citation changes. The callback receives the workspace id that
   * mutated. Returns an unsubscribe function.
   */
  subscribe(cb: CitationListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(workspace: string): void {
    // Snapshot so an unsubscribe during emit doesn't mutate the live set.
    for (const cb of [...this.listeners]) {
      cb(workspace);
    }
  }
}

/** Order-independent Set equality (members only). */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

// ── Citation derivation (pure) ────────────────────────────────────────────────

/**
 * Derive cited node ids / file paths from a raw Atlas retrieval result.
 *
 * The citation SOURCE is the structured retrieval result the tools returned —
 * NOT the LLM prose. Different tools surface ids/files in different shapes; we
 * pull whatever is reliably present and union it:
 *   - knowledge_search                     → results[] .id (and .file)
 *   - knowledge_recall                     → hits[] .id (and .file)
 *   - atlas_subgraph / call graphs         → nodes[] .id and/or .file
 *   - atlas_blast_radius                   → d1/d2/d3[] .symbol/.id/.file
 *   - atlas_find_dead_code                 → candidates[]/dead[] .symbol/.file
 *   - atlas_hotspots                       → entries[]/hotspots[] .file/.name
 * Anything we can't recognize yields an empty list (no throw). A returned id
 * that isn't currently loaded in the graph is simply skipped by the highlighter.
 */
export function deriveCitations(rawResult: unknown): string[] {
  if (rawResult == null || typeof rawResult !== 'object') return [];
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out.add(s);
    }
  };

  // Pull id-ish + file-ish fields off an arbitrary record.
  const harvest = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const r = item as Record<string, unknown>;
    add(r['id']);
    add(r['nodeId']);
    add(r['symbol']);
    add(r['name']);
    add(r['file']);
    add(r['path']);
    add(r['filePath']);
  };

  const harvestArray = (arr: unknown) => {
    if (Array.isArray(arr)) for (const item of arr) harvest(item);
  };

  const r = rawResult as Record<string, unknown>;

  // knowledge_recall / knowledge_search
  harvestArray(r['results']);
  harvestArray(r['nodes']);
  // knowledge_recall returns its ranked matches under hits[] — without this the
  // recall flow raised zero citations (no "Grounded in" chips, no graph highlight).
  harvestArray(r['hits']);
  // atlas_subgraph
  harvestArray(r['nodes']);
  // atlas_find_dead_code
  harvestArray(r['candidates']);
  harvestArray(r['dead']);
  // atlas_hotspots
  harvestArray(r['entries']);
  harvestArray(r['hotspots']);
  // atlas_blast_radius (degree rings)
  harvestArray(r['d1']);
  harvestArray(r['d2']);
  harvestArray(r['d3']);

  // A bare array result (some tools return a top-level array).
  if (Array.isArray(rawResult)) harvestArray(rawResult);

  return [...out];
}
