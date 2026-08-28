/**
 * mcp/backgroundOnboard.ts — Atlas auto-wire Part 5: background onboarding
 * for a tier-2 (Part 4) path with no existing workspace.
 *
 * WHAT THIS DOES. server.ts's /hooks/context handler calls
 * `maybeStartBackgroundOnboard` when a hook's `cwd` resolves to no known
 * workspace (Part 2) AND `classifyProjectPath` (Part 4) says the folder looks
 * like a real, unindexed project (tier 2). It kicks off workspace creation +
 * project registration + indexing WITHOUT blocking the hook response, and
 * tells the caller whether this is the first time this workspace has been
 * seen this daemon lifetime — the caller uses that to add exactly ONE
 * announcement line to `additionalContext` (invariant 2: announce, never
 * sneak, never spammy).
 *
 * REUSE, NOT REINVENTION. This deliberately calls the SAME `runOnboard`
 * (mcp/tools/onboard.ts) that the `atlas_onboard` MCP tool and `atlas
 * onboard` CLI already use for workspace_create + workspace_add_project +
 * atlas_index — same workspace derivation, same registerProject/cache
 * invalidation, same indexInFlight guard (mcp/indexInFlight.ts), same
 * daemon-first fire-and-forget index path. The one difference: `wire:false`,
 * so it does NOT install the per-repo hook/CLAUDE.md/AGENTS.md harness —
 * that would defeat the entire point of auto-wire, which is memory for a
 * project with NOTHING written into its own repo. Wiring stays an explicit,
 * separate step.
 *
 * WHY THIS MUST NOT BE AWAITED. `runOnboard` runs its own workspace
 * creation synchronously (before its first `await`), so by the time the
 * call below RETURNS the workspace is already registered and claimed in
 * `indexInFlight` — but the promise it returns does not settle until
 * indexing finishes (which can take tens of minutes on a large repo) or,
 * in non-wait mode, until `confirmLiftoff`'s up-to-2s poll resolves. The
 * hook response must return in well under a second regardless, so the
 * call below is deliberately fire-and-forget (`.catch()`ed, never awaited).
 *
 * ANNOUNCE-ONCE TRACKING. `announced` is an in-memory Set<workspace>,
 * checked-and-claimed synchronously (a plain Set add has no await point, so
 * two hook calls racing for the SAME derived workspace name can never both
 * see it unclaimed — whichever runs first in the single JS thread wins the
 * claim before the other's check runs). Resets on daemon restart — that is
 * fine and deliberately not "fixed": invariant 2 is about not repeating the
 * announcement on every subsequent Grep/Edit within one daemon lifetime, not
 * about surviving a restart, and re-announcing once after a genuine restart
 * is reasonable signal, not noise.
 */

import * as path from 'node:path';
import type { AtlasConfig } from '../config.js';
import { runOnboard } from './tools/onboard.js';
import { repoSlug } from '../cli/repoId.js';
import { slugify } from '../cli/wire.js';

const announced = new Set<string>();

/** Same derivation `runOnboard` uses internally when no explicit workspace
 *  is given (repo-slug from the git origin remote, falling back to the
 *  folder basename) — computed here too so the announce-once Set is keyed
 *  by the SAME name the workspace actually gets created under. */
export function deriveOnboardWorkspace(abs: string): string {
    return slugify(repoSlug(abs) || path.basename(abs));
}

export interface BackgroundOnboardResult {
    /** true only the FIRST time this workspace is seen this daemon lifetime
     *  — the caller should add the one-line announcement. false means either
     *  a repeat touch (already announced) or onboarding was already claimed
     *  by a racing call; either way nothing new was kicked off here. */
    announced: boolean;
    workspace: string;
}

/**
 * Kick off background onboarding for `projectPath` (a tier-2 classification
 * result) if this is the first time its derived workspace has been seen this
 * daemon lifetime. Synchronous claim, fire-and-forget index — never awaits
 * the onboarding run, never throws.
 */
export function maybeStartBackgroundOnboard(cfg: AtlasConfig, projectPath: string): BackgroundOnboardResult {
    const abs = path.resolve(projectPath);
    const workspace = deriveOnboardWorkspace(abs);
    if (announced.has(workspace)) return { announced: false, workspace };
    announced.add(workspace); // claim FIRST, synchronously — closes the two-near-simultaneous-first-touches race
    runOnboard(cfg, { path: abs, workspace, wait: false, wire: false })
        .catch((err) => process.stderr.write(`[atlas] background onboard failed for '${workspace}': ${(err as Error)?.message ?? err}\n`));
    return { announced: true, workspace };
}

/** Test-only: clear the announce-once tracking between test runs — mirrors
 *  what a daemon restart does (see header), which is the only other thing
 *  that ever resets it. */
export function _resetBackgroundOnboardAnnouncedForTests(): void {
    announced.clear();
}
