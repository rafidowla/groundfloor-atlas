/**
 * selectionState.ts — tri-state derivation for the multi-select filter rails.
 *
 * A section header (Projects / Node Types / Edge Types) shows an "All / None"
 * quick-toggle and, ideally, an at-a-glance count of how many of that section's
 * rows are selected. The subtlety this module exists for:
 *
 *   The active Set and the VISIBLE row list are NOT always the same universe.
 *   `activeEdgeTypes` defaults to ALL `EDGE_TYPES` — which includes the legacy
 *   `related_to` relation — but the edge rail renders only `VISIBLE_EDGE_TYPES`
 *   (legacy excluded). A naive `active.size / visible.length` therefore reads
 *   10/9 and the header would claim "some selected" (or overflow) when in fact
 *   every visible row is checked.
 *
 * `deriveTriState` fixes this by counting ONLY the intersection of `active` with
 * the VISIBLE list: `selected = |active ∩ visible|`, `total = visible.length`.
 * Legacy/hidden members of `active` are invisible to the header, exactly as they
 * are invisible in the rail. Pure and generic over the member type `T`.
 */

export interface TriState {
  /** "all" = every visible row selected; "none" = zero; "some" = a strict subset. */
  state: 'all' | 'some' | 'none';
  /** Count of visible rows that are active (|active ∩ visible|). */
  selected: number;
  /** Count of visible rows (visible.length). */
  total: number;
}

/**
 * Derive the header tri-state from an active Set and the visible row list.
 *
 * Counts ONLY the intersection of `active` with `visible`, so members of
 * `active` that are not in the visible list (e.g. legacy `related_to`) never
 * inflate the count. An empty visible list yields `state: "none"`, `0 / 0`.
 */
export function deriveTriState<T>(
  active: Set<T>,
  visible: readonly T[],
): TriState {
  const total = visible.length;
  let selected = 0;
  for (const v of visible) {
    if (active.has(v)) selected++;
  }
  const state: TriState['state'] =
    selected === 0 ? 'none' : selected === total ? 'all' : 'some';
  return { state, selected, total };
}
