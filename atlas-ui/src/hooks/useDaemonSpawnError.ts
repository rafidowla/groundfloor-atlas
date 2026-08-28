/**
 * useDaemonSpawnError.ts — UX-truth site #5.
 *
 * The desktop app's Rust side (src-tauri/src/lib.rs, `spawn_atlas_daemon`)
 * previously only `eprintln!`'d when it couldn't start the embedded Atlas
 * daemon (missing bundled Node.js binary, missing bundled core dist, or the
 * OS `Command::spawn()` call itself erroring — e.g. a port conflict on some
 * platforms). That output is invisible to the frontend, which has no access
 * to the Rust process's stderr. The result: the UI just saw :3848 never
 * answer and showed the SAME infinite "Retry / make sure Groundfloor Atlas is running"
 * state as an ordinary slow-starting daemon — no real cause, no way to tell
 * the two apart.
 *
 * `lib.rs` now emits a `daemon-spawn-failed` Tauri event with the concrete
 * reason the instant the spawn fails. This hook listens for it (no-op outside
 * Tauri — a plain browser dev server / vitest has no `@tauri-apps/api/event`
 * runtime to talk to) and exposes the latest reason so a page can render an
 * ACTIONABLE error instead of a spinner that can never resolve.
 */

import { useEffect, useState } from 'react';

/** Duck-type check for Tauri internals (mirrors useFolderPicker's detectTauri). */
function detectTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface DaemonSpawnFailedPayload {
  reason: string;
}

/** Normalize the event payload Rust sends into the display string. Extracted
 *  as a pure function (rather than inlined in the `listen` callback) so the
 *  "never show a blank/undefined reason" fallback is directly unit-testable
 *  without mocking `@tauri-apps/api/event`. */
export function reasonFromPayload(payload: DaemonSpawnFailedPayload | null | undefined): string {
  return payload?.reason || 'The Groundfloor Atlas daemon failed to start.';
}

export interface UseDaemonSpawnErrorResult {
  /** The most recent spawn-failure reason from the Rust side, or null if none
   *  has been reported (or we're not running inside Tauri at all). */
  spawnError: string | null;
  /** Dismiss the current error (e.g. after the user acknowledges it). A NEW
   *  spawn failure (there generally won't be one without an app restart) would
   *  still re-populate this. */
  clear: () => void;
}

export function useDaemonSpawnError(): UseDaemonSpawnErrorResult {
  const [spawnError, setSpawnError] = useState<string | null>(null);

  useEffect(() => {
    if (!detectTauri()) return; // plain browser / test environment — no-op
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Dynamic import so non-Tauri builds (dev server, vitest) never need this
    // module resolvable — mirrors useFolderPicker's dynamic plugin-dialog import.
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<DaemonSpawnFailedPayload>('daemon-spawn-failed', (event) => {
          if (cancelled) return;
          setSpawnError(reasonFromPayload(event.payload));
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        // Tauri event API unavailable for some reason — degrade to no signal
        // rather than throwing; the existing daemon-unreachable UI still applies.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { spawnError, clear: () => setSpawnError(null) };
}
