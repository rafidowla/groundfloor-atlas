/**
 * streamOutcome.ts — UX-truth site #2: pure decision logic for a failed
 * chat stream.
 *
 * `ChatPanel.tsx` previously handled a `streamChat` rejection with a single
 * blind fallback to the non-stream `fetchLLMInsight` call — win or lose, the
 * result of that fallback REPLACED whatever partial tokens had already
 * rendered on screen. A mid-stream failure (network drop, daemon restart, an
 * `error` SSE frame — see chatStream.ts) after several tokens had already
 * streamed in therefore wiped the visible partial answer and, if the
 * fallback also failed or returned nothing, left the insight area silently
 * blank with zero indication anything had gone wrong.
 *
 * `classifyStreamFailure` is the pure function that decides what to do,
 * extracted out of the component so it's unit-testable without React/DOM:
 *   - if the provider was explicitly turned off (`llm-off`, a sentinel this
 *     module itself throws, never a real failure) → fall back to the
 *     non-stream call silently, exactly as before.
 *   - if partial text HAD already streamed in → NEVER discard it. Keep it
 *     verbatim and report a visible error reason to attach alongside it.
 *   - otherwise (failed before any token arrived) → still fine to try the
 *     non-stream fallback, since there is nothing on screen to protect.
 */

export const LLM_OFF_SENTINEL_MESSAGE = 'llm-off';

export type StreamFailureAction =
  | { kind: 'silent-fallback' }
  | { kind: 'keep-partial-with-error'; reason: string }
  | { kind: 'try-fallback' };

/**
 * Decide how to react to a `streamChat` rejection, given the text (if any)
 * that had already streamed in before it threw.
 */
export function classifyStreamFailure(streamedSoFar: string, err: unknown): StreamFailureAction {
  const isIntentionalOff = err instanceof Error && err.message === LLM_OFF_SENTINEL_MESSAGE;
  if (isIntentionalOff) {
    return { kind: 'silent-fallback' };
  }
  if (streamedSoFar.trim().length > 0) {
    const reason = err instanceof Error ? err.message : 'connection lost';
    return { kind: 'keep-partial-with-error', reason };
  }
  return { kind: 'try-fallback' };
}
