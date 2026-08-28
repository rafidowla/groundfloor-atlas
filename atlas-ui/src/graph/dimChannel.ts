/**
 * dimChannel.ts — which soft-dim channel wins, as a pure function.
 *
 * Channels: semantic hits (Enter-for-semantic-search), substring query
 * (instant keystroke filter), citation ids (chat citations).
 *
 * Semantic comes FIRST: WorkspacePage clears semanticHits on every keystroke
 * (handleSearchChange), so while hits are present the query text is exactly
 * what the user searched for semantically. The OLD order (substring first)
 * made Enter-for-semantic-search a dead end — the query was still in the
 * box, so the substring branch always won and the hits never highlighted
 * anything. As soon as the user edits the query, the hits clear and the
 * substring filter takes over again.
 */
export type DimChannel = 'semantic' | 'query' | 'citation' | null;

export function selectDimChannel(args: {
  query: string;
  semanticHits: readonly string[];
  citedIds: readonly string[];
}): DimChannel {
  if (args.semanticHits.length > 0) return 'semantic';
  if (args.query.trim().length > 0) return 'query';
  if (args.citedIds.length > 0) return 'citation';
  return null;
}
