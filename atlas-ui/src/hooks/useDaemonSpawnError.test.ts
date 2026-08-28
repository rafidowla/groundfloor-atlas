/**
 * useDaemonSpawnError.test.ts — UX-truth site #5.
 *
 * The Rust side (src-tauri/src/lib.rs) previously only `eprintln!`'d when the
 * embedded Atlas daemon failed to spawn (missing bundled node, missing core
 * dist, or the OS spawn call itself erroring) — invisible to the frontend,
 * which then showed the SAME infinite "make sure Groundfloor Atlas is running"
 * spinner as an ordinary slow start, with no real cause and no way to tell
 * the two situations apart. `lib.rs` now emits a `daemon-spawn-failed` event
 * with a concrete reason; `reasonFromPayload` is the pure normalization this
 * hook applies to that payload, tested here without needing to mock
 * `@tauri-apps/api/event` (this hook is a no-op outside a Tauri runtime, so
 * mounting it under vitest's plain node environment would exercise nothing).
 */

import { describe, it, expect } from 'vitest';
import { reasonFromPayload } from './useDaemonSpawnError';

describe('reasonFromPayload', () => {
  it('surfaces the real reason Rust sent', () => {
    expect(reasonFromPayload({ reason: 'no bundled Node.js binary found in /Applications/Atlas.app/Contents/Resources/atlas-core. Reinstall Atlas.' }))
      .toBe('no bundled Node.js binary found in /Applications/Atlas.app/Contents/Resources/atlas-core. Reinstall Atlas.');
  });

  it('surfaces a port-conflict / spawn-error reason verbatim', () => {
    expect(reasonFromPayload({ reason: 'failed to start Atlas core: Address already in use (os error 48) (port 3848 may be in use, or the spawn was rejected)' }))
      .toContain('Address already in use');
  });

  it('falls back to a generic message when the payload has an empty reason (never shows a blank error)', () => {
    expect(reasonFromPayload({ reason: '' })).toBe('The Groundfloor Atlas daemon failed to start.');
  });

  it('falls back to a generic message when the payload itself is missing (never throws / never blank)', () => {
    expect(reasonFromPayload(null)).toBe('The Groundfloor Atlas daemon failed to start.');
    expect(reasonFromPayload(undefined)).toBe('The Groundfloor Atlas daemon failed to start.');
  });
});
