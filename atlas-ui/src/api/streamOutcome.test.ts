/**
 * streamOutcome.test.ts — UX-truth site #2.
 *
 * Pins the fix for ChatPanel.tsx's mid-stream error handling: previously a
 * `streamChat` rejection unconditionally fell back to the non-stream
 * `fetchLLMInsight` call, whose result (or lack of one) REPLACED whatever
 * partial tokens had already streamed onto screen — silently blanking a
 * visible partial answer. `classifyStreamFailure` is the pure decision this
 * codebase's derive-/classify- helpers pattern extracts so the "never
 * discard partial text" rule is independently testable (no React/DOM).
 */

import { describe, it, expect } from 'vitest';
import { classifyStreamFailure, LLM_OFF_SENTINEL_MESSAGE } from './streamOutcome';

describe('classifyStreamFailure', () => {
  it('keeps the partial answer and reports the real error when tokens had already streamed in', () => {
    const action = classifyStreamFailure('The blast radius of `foo` includes', new Error('Failed to fetch'));
    expect(action).toEqual({ kind: 'keep-partial-with-error', reason: 'Failed to fetch' });
  });

  it('never discards partial text even for a non-Error rejection — falls back to a generic reason', () => {
    const action = classifyStreamFailure('partial tokens already rendered', 'raw string throw');
    expect(action.kind).toBe('keep-partial-with-error');
    if (action.kind === 'keep-partial-with-error') {
      expect(action.reason).toBe('connection lost');
    }
  });

  it('treats whitespace-only streamed text as "nothing streamed yet" (still safe to fall back)', () => {
    const action = classifyStreamFailure('   \n  ', new Error('boom'));
    expect(action.kind).toBe('try-fallback');
  });

  it('tries the non-stream fallback when nothing streamed before the failure', () => {
    const action = classifyStreamFailure('', new Error('daemon unreachable'));
    expect(action).toEqual({ kind: 'try-fallback' });
  });

  it('silently falls back (no error surfaced) when the provider was intentionally turned off', () => {
    const action = classifyStreamFailure('', new Error(LLM_OFF_SENTINEL_MESSAGE));
    expect(action).toEqual({ kind: 'silent-fallback' });
  });

  it('the llm-off sentinel always wins over partial text (not a real code path — llm-off throws before any token — but pins the intended precedence)', () => {
    // llm-off means the provider was intentionally disabled, not a failure —
    // there is nothing to "protect" or report as an error even if some text
    // were present, so silent-fallback takes precedence.
    const action = classifyStreamFailure('already have content', new Error(LLM_OFF_SENTINEL_MESSAGE));
    expect(action.kind).toBe('silent-fallback');
  });
});
