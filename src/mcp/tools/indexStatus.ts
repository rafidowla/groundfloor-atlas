/**
 * mcp/tools/indexStatus.ts — index_status.
 *
 * Sprint 4. Pollable, NON-blocking read of the live index progress the indexer
 * publishes to the process-level registry (mcp/indexProgress.ts). The header
 * progress bar and AddProjectModal poll this every ~1s; `indexing === true` is
 * the source of truth for "a run is in flight" (survives reload, independent of
 * which client triggered atlas_index).
 *
 * WHY a poll tool, not SSE (diagnosis §3): the frontend already speaks exactly
 * one transport (invokeAtlasTool JSON-RPC); the signal is coarse + monotonic
 * (files X/Y); AddProjectModal already polls. A poll tool needs ZERO new client
 * plumbing. SSE buys nothing here.
 *
 * HONESTY: returns ONLY genuinely observable numbers — phase + filesDone/Total +
 * running nodesWritten/edgesWritten. `embedsPending` is forwarded only if the
 * indexer set it (context layer on); never a fabricated denominator.
 */

import { getProgress, type IndexProgress } from '../indexProgress.js';

interface IndexStatusArgs {
    workspace?: string;
}

/**
 * Return the latest progress snapshot for `workspace` (or an idle snapshot if
 * no index has run). Pure read — never mutates state, never blocks.
 */
export function runIndexStatusTool(
    args: IndexStatusArgs,
    defaultWorkspace: string,
): IndexProgress & { workspace: string } {
    const workspace = args.workspace ?? defaultWorkspace;
    return { workspace, ...getProgress(workspace) };
}
