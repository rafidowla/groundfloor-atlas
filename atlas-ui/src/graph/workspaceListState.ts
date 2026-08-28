/**
 * workspaceListState.ts — UX-truth site #3: pure classification for a failed
 * `workspace_list` load.
 *
 * `WorkspaceSwitcher.tsx` (and any other workspace-picker surface) previously
 * did `.catch(() => setWorkspaces([]))` — ANY failure (daemon down, a
 * tool-level error, a network blip) rendered EXACTLY like a workspace list
 * that is genuinely empty ("No workspaces found"), with no indication
 * anything went wrong and no way to retry. `classifyWorkspaceListError` is
 * the pure decision function (mirrors `classifyLoadError` in
 * useGraphData.ts / `classifyExpandError` in graph/expandError.ts) that
 * turns a caught rejection into a distinct state so the caller can render a
 * real error + Retry instead of a false "empty" claim.
 */

import { AtlasDaemonUnreachableError } from '../api/atlasApi';

/** Why the list is empty (or unknown) right now. A genuinely-empty list
 *  ('loaded' with zero entries) must never be conflated with a load that
 *  never completed ('error' / 'daemon-down'). */
export type WorkspaceListLoadState = 'loading' | 'loaded' | 'error' | 'daemon-down';

export interface WorkspaceListErrorClassification {
  loadState: 'error' | 'daemon-down';
  message: string;
}

export function classifyWorkspaceListError(e: unknown): WorkspaceListErrorClassification {
  if (e instanceof AtlasDaemonUnreachableError) {
    return { loadState: 'daemon-down', message: 'Groundfloor Atlas daemon not reachable' };
  }
  return {
    loadState: 'error',
    message: e instanceof Error ? e.message : 'Failed to load workspaces',
  };
}

/** Normalize a `workspace_list` response. Embedded mode (the DEFAULT
 *  deployment) returns `workspaces: string[]`; remote mode returns objects.
 *  WorkspaceSwitcher used to cast the raw array, rendering every row with an
 *  undefined name (blank menu items) in embedded mode — every other consumer
 *  (WorkspacesPage, SettingsPage, AddProjectModal) already normalized. */
export function normalizeWorkspaceList(
  raw: Array<string | { id?: string; name: string; nodeCount?: number }> | undefined,
): Array<{ id: string; name: string; nodeCount?: number }> {
  return (raw ?? []).map((w) => (typeof w === 'string' ? { id: w, name: w } : { id: w.id ?? w.name, ...w }));
}
