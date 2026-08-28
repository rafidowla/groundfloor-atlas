/**
 * mcp/indexInFlight.ts — the cross-tool "an index of this workspace is
 * already running" guard.
 *
 * Lives in its own module (not allTools.ts) so BOTH the `atlas_index`
 * handler and the `atlas_onboard` background launcher share ONE Set without
 * a circular import (allTools.ts imports the onboard runner).
 *
 * RD-index-reentrancy — a second concurrent index of the SAME workspace
 * would contend with the first on the one shared kuzu handle and corrupt
 * the single per-workspace index_status progress record. Reject the overlap
 * instead; the caller polls index_status and retries when it's clear.
 */
export const indexInFlight = new Set<string>();
