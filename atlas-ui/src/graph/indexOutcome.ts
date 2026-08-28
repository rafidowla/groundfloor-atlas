/**
 * indexOutcome.ts — UX-truth site #4: pure classification for how
 * `atlas_index`'s settled promise should terminate the onboarding flow.
 *
 * OnboardingPage.tsx previously drove its "indexing complete" transition off
 * a `workspace_status` poll reading a `nodeCount`/`state` field — but that
 * REST route 404s in LOCAL/HTTP mode, and the daemon never returns a `state`
 * field at all, so `status.state === 'idle'` was always false and the flow
 * only ever completed via the blunt 5-minute safety timeout, even when
 * indexing had genuinely finished (or failed) seconds earlier — a fake
 * indeterminate bar that could hang for minutes after the real work was done.
 *
 * The fix (mirroring AddProjectModal, which already gets this right) is to
 * treat the `atlas_index` call's own resolved/rejected value as the ONLY
 * terminal-phase signal — `index_status` still drives the LIVE progress
 * readout, but never decides done/error. `classifyIndexOutcome` is the pure
 * decision extracted here so it's unit-testable without mounting the page.
 */

import { AtlasDaemonUnreachableError, AtlasToolError } from '../api/atlasApi';

export type IndexOutcome =
  | { phase: 'done' }
  | { phase: 'done'; partialErrorMessage: string }
  | { phase: 'error'; message: string };

/**
 * Classify a REJECTED `atlas_index` promise. (A resolved promise is always
 * `{ phase: 'done' }` — call sites don't need this helper for the success
 * path, only to interpret a caught rejection.)
 */
export function classifyIndexOutcome(err: unknown): IndexOutcome {
  if (err instanceof AtlasDaemonUnreachableError) {
    return { phase: 'error', message: err.message };
  }
  if (err instanceof AtlasToolError) {
    const raw = err.raw as { filesWritten?: number; nodesWritten?: number } | undefined;
    const wroteSomething = (raw?.filesWritten ?? 0) > 0 || (raw?.nodesWritten ?? 0) > 0;
    if (wroteSomething) {
      // Partial success: some files landed despite errors. Onboarding has no
      // dedicated amber "partial" phase (unlike AddProjectModal) — treat it as
      // done (the workspace has real content) but keep the truthful message
      // so the UI can still show "completed with issues" rather than
      // pretending it was perfectly clean.
      return { phase: 'done', partialErrorMessage: err.message };
    }
    return { phase: 'error', message: err.message };
  }
  return { phase: 'error', message: err instanceof Error ? err.message : 'Indexing failed' };
}
