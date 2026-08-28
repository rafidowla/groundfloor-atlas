/**
 * expandError.ts — UX-truth site #1: pure classification for a failed
 * node expand/collapse.
 *
 * Extracted out of AtlasGraph.tsx (rather than defined inline there) so it is
 * unit-testable WITHOUT importing sigma/@react-sigma/core — those packages
 * require a WebGL-capable environment (`WebGL2RenderingContext`) that doesn't
 * exist under vitest's default node environment, and this suite deliberately
 * stays jsdom-free (pure-logic / mocked-fetch style, matching
 * useGraphData.ts's `classifyLoadError`). AtlasGraph.tsx re-exports this for
 * backward-compatible imports.
 */

import { AtlasDaemonUnreachableError } from '../api/atlasApi';

export interface ExpandErrorClassification {
  daemonUnreachable: boolean;
  message: string;
}

export function classifyExpandError(e: unknown): ExpandErrorClassification {
  if (e instanceof AtlasDaemonUnreachableError) {
    return { daemonUnreachable: true, message: 'Groundfloor Atlas daemon not reachable — could not expand node.' };
  }
  return {
    daemonUnreachable: false,
    message: (e instanceof Error && e.message) ? e.message : 'Failed to expand node.',
  };
}
