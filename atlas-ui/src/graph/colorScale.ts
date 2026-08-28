/**
 * colorScale.ts — stable categorical colors for project / community coloring.
 *
 * A node's color in "by project" or "by community" mode must be the SAME hue in
 * the graph and on its legend swatch, and stable across reloads. We hash the
 * category key (repo name / community id) into a fixed, hand-tuned palette so the
 * mapping is deterministic and the palette stays legible on the dark canvas
 * (saturated, mid-bright hues — the graphify look). Both GraphController (node
 * paint) and GraphControls (legend swatch) import `colorForKey`, so they agree
 * by construction.
 */

// A 16-hue categorical palette tuned for a near-black background: saturated but
// not neon, evenly spread around the wheel. Index chosen by a string hash.
const PALETTE = [
  '#60a5fa', // blue
  '#f472b6', // pink
  '#34d399', // emerald
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#f87171', // red
  '#22d3ee', // cyan
  '#a3e635', // lime
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#2dd4bf', // teal
  '#facc15', // yellow
  '#818cf8', // indigo
  '#fca5a5', // rose
  '#4ade80', // green
  '#c084fc', // purple
];

/** Neutral grey for nodes with no value in the active category (e.g. an import
 *  has no project; a folder has no community). */
export const UNCATEGORIZED_COLOR = '#6b7280';

/** FNV-1a — small, fast, well-distributed string hash. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic color for a category key (repo / community id). Empty/undefined
 *  → the neutral uncategorized grey. */
export function colorForKey(key: string | undefined | null): string {
  if (!key) return UNCATEGORIZED_COLOR;
  return PALETTE[hashKey(key) % PALETTE.length]!;
}

/** Human-friendly project label: strip a leading `<host>-<org>-` slug prefix so
 *  `bitbucket.org-someorg-some-repo` shows as
 *  `some-repo`. Names without that shape pass through unchanged. */
export function shortProjectLabel(project: string): string {
  return project.replace(/^(github\.com|bitbucket\.org|gitlab\.com)-[^-]+-/, '');
}
