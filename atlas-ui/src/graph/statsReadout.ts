/**
 * statsReadout.ts — Sprint 4 header stats derivation (PURE).
 *
 * The honest readout for the WorkspacePage header. The numbers come from three
 * sources, each labeled for exactly what it is (diagnosis §1):
 *   - communities: `atlas_communities.total` — a genuine WORKSPACE-LEVEL count
 *     (post min-size filter). Workspace-scoped, not view-scoped.
 *   - nodes / edges: the live Graphology instance's `graph.order` / `graph.size`
 *     — the LOADED VIEW only (level-0 communities + whatever the user expanded).
 *     This is NOT the workspace total and must not be labeled as one; expanding
 *     changes it. (`workspace_status` cannot honestly provide a total against
 *     this daemon — its /status route 404s — so we don't pretend to show one.)
 *
 * Kept as a pure function over plain numbers so it is trivially unit-testable
 * without React, Sigma, or the network (mirrors the chatStream/parseSseBuffer
 * testing pattern).
 */

export interface StatsInput {
    /** atlas_communities.total — workspace-level community count, or null while
     *  it has not loaded yet. */
    communities: number | null;
    /** graph.order — nodes currently LOADED in the view. */
    loadedNodes: number;
    /** graph.size — edges currently LOADED in the view. */
    loadedEdges: number;
}

export interface StatItem {
    /** Numeric value, locale-formatted. */
    value: string;
    /** Honest label, e.g. "communities" or "nodes in view". */
    label: string;
}

/**
 * Derive the header stat items. Returns [] until there is anything truthful to
 * show (no communities loaded AND an empty graph). Community count is omitted
 * (not shown as 0) until it has actually loaded, so a slow community fetch never
 * flashes a misleading "0 communities".
 */
export function deriveStats(input: StatsInput): StatItem[] {
    const items: StatItem[] = [];

    if (input.communities != null) {
        items.push({
            value: input.communities.toLocaleString(),
            label: input.communities === 1 ? 'community' : 'communities',
        });
    }

    // Nodes / edges are always the LOADED view — labeled "in view" so the count
    // is never mistaken for a workspace total.
    items.push({
        value: input.loadedNodes.toLocaleString(),
        label: input.loadedNodes === 1 ? 'node in view' : 'nodes in view',
    });
    items.push({
        value: input.loadedEdges.toLocaleString(),
        label: input.loadedEdges === 1 ? 'edge in view' : 'edges in view',
    });

    return items;
}
