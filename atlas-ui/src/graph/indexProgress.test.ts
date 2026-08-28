/**
 * indexProgress.test.ts — Sprint 4 progress-bar derivation (PURE).
 *
 * deriveProgress maps a raw index_status snapshot (as the poll returns) into the
 * bar's render state. These cases pin the HONESTY contract (diagnosis §2): a
 * determinate fill ONLY from filesDone/filesTotal, indeterminate while parsing
 * (total unknown) — never a fabricated percentage — and the bar hidden when idle.
 *
 * This is the "render-from-state, mock the poll" frontend test: each `raw` is
 * exactly what a polled index_status tick would yield; we assert the derived
 * view the bar renders from.
 */

import { describe, it, expect } from 'vitest';
import { deriveProgress } from './indexProgress';

describe('deriveProgress', () => {
  it('hides the bar when idle / never run', () => {
    expect(deriveProgress({ indexing: false, phase: 'idle', filesDone: 0, filesTotal: 0 }).visible).toBe(false);
    // A null poll (not yet returned) is also hidden.
    expect(deriveProgress(null).visible).toBe(false);
    expect(deriveProgress(undefined).visible).toBe(false);
  });

  it('is INDETERMINATE while parsing (filesTotal unknown → no fabricated %)', () => {
    const v = deriveProgress({ indexing: true, phase: 'parsing', filesDone: 0, filesTotal: 0 });
    expect(v.visible).toBe(true);
    expect(v.fraction).toBeNull(); // indeterminate, NOT 0% and NOT a guessed %
    expect(v.label).toMatch(/parsing/i);
  });

  it('renders a determinate fill from filesDone/filesTotal while writing', () => {
    const v = deriveProgress({
      indexing: true,
      phase: 'writing',
      filesDone: 12,
      filesTotal: 40,
      nodesWritten: 300,
      edgesWritten: 120,
    });
    expect(v.visible).toBe(true);
    expect(v.writing).toBe(true);
    expect(v.fraction).toBeCloseTo(12 / 40, 5);
    expect(v.label).toBe('Indexing 12/40 files');
    // Running totals surface for the secondary readout.
    expect(v.nodesWritten).toBe(300);
    expect(v.edgesWritten).toBe(120);
  });

  it('reflects the TERMINAL done state as a full bar', () => {
    const v = deriveProgress({
      indexing: false,
      phase: 'done',
      filesDone: 40,
      filesTotal: 40,
      nodesWritten: 901,
      edgesWritten: 410,
    });
    expect(v.visible).toBe(true);
    expect(v.fraction).toBe(1);
    expect(v.writing).toBe(false);
    expect(v.label).toMatch(/indexed 40 files/i);
  });

  it('shows the error state with the message and no fabricated fill', () => {
    const v = deriveProgress({ indexing: false, phase: 'error', error: 'no parser for .xyz' });
    expect(v.visible).toBe(true);
    expect(v.phase).toBe('error');
    expect(v.label).toMatch(/index failed: no parser for \.xyz/i);
  });

  it('flips to indeterminate "finalizing embeds" only when context layer reports pending embeds', () => {
    const v = deriveProgress({
      indexing: true,
      phase: 'writing',
      filesDone: 40,
      filesTotal: 40,
      embedsPending: 6,
    });
    expect(v.finalizingEmbeds).toBe(true);
    expect(v.writing).toBe(false);
    expect(v.fraction).toBe(1); // files all done
    expect(v.label).toMatch(/finalizing embeds \(6\)/i);
  });

  it('does NOT show an embed phase when embedsPending is absent (code index path)', () => {
    const v = deriveProgress({ indexing: true, phase: 'writing', filesDone: 40, filesTotal: 40 });
    expect(v.finalizingEmbeds).toBe(false);
    expect(v.embedsPending).toBeUndefined();
    expect(v.label).toBe('Indexing 40/40 files');
  });

  it('clamps the fraction to 1 if filesDone overruns filesTotal', () => {
    const v = deriveProgress({ indexing: true, phase: 'writing', filesDone: 42, filesTotal: 40 });
    expect(v.fraction).toBe(1);
  });

  it('degrades gracefully on a malformed snapshot (non-numeric fields)', () => {
    const v = deriveProgress({
      indexing: true,
      phase: 'writing',
      // @ts-expect-error — deliberately malformed to prove graceful coercion
      filesDone: 'x',
      // @ts-expect-error
      filesTotal: null,
    });
    expect(v.filesDone).toBe(0);
    expect(v.filesTotal).toBe(0);
    expect(v.fraction).toBeNull();
  });
});
