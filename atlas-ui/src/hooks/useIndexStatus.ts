/**
 * useIndexStatus.ts — Sprint 4 live index-progress poll hook.
 *
 * Polls the `index_status` MCP tool (the daemon's process-level progress
 * registry) and exposes the latest raw snapshot + a `refresh()` to drive the
 * header progress bar. Mirrors StatusBar's setInterval pattern, but:
 *   - polls ~1s (vs 30s health) and ONLY while a run is active;
 *   - `indexing === true` from the snapshot itself is the source of truth that a
 *     run is in flight — it survives reload and does NOT depend on which client
 *     triggered atlas_index (diagnosis §4);
 *   - when `indexing` flips false (phase done/error), it does one FINAL poll and
 *     calls `onComplete` (the page wires this to useGraphData.reload so the new
 *     communities/counts refresh).
 *
 * Polling is also kicked on mount so a reload mid-index immediately shows the
 * bar, and via `ping()` so the page can start a fast poll the instant it fires
 * atlas_index (before the first slow interval tick).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeAtlasTool } from '../api/atlasApi';
import type { IndexStatusRaw } from '../graph/indexProgress';

const POLL_MS = 1_000;

export interface UseIndexStatusReturn {
  /** Latest raw index_status snapshot (null before the first poll resolves). */
  status: IndexStatusRaw | null;
  /** Start polling immediately (call right after firing atlas_index). */
  ping: () => void;
}

export function useIndexStatus(
  workspace: string | undefined,
  onComplete?: () => void,
): UseIndexStatusReturn {
  const [status, setStatus] = useState<IndexStatusRaw | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track whether we were indexing last tick so we fire onComplete exactly once
  // on the indexing→idle transition (not on every idle poll).
  const wasIndexingRef = useRef(false);
  // Keep the latest onComplete without re-subscribing the interval.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const errorCountRef = useRef(0);
  const pollOnce = useCallback(async () => {
    if (!workspace) return;
    try {
      const raw = (await invokeAtlasTool('index_status', { workspace })) as IndexStatusRaw | null;
      errorCountRef.current = 0;
      setStatus(raw);
      const indexing = raw?.indexing === true;
      if (indexing) {
        wasIndexingRef.current = true;
      } else if (wasIndexingRef.current) {
        // indexing → idle: the run just finished. Stop, then let the page
        // refresh its graph/counts.
        wasIndexingRef.current = false;
        stop();
        onCompleteRef.current?.();
      } else {
        // Idle and was already idle — nothing in flight; stop the interval to
        // avoid a permanent 1s poll when nothing is happening.
        stop();
      }
    } catch {
      // Poll failure is non-fatal — but a DEAD daemon fails every second
      // forever. Give up after a few consecutive misses instead of polling a
      // dead port for the page's lifetime.
      errorCountRef.current += 1;
      if (errorCountRef.current >= 5) stop();
    }
  }, [workspace, stop]);

  const start = useCallback(() => {
    if (timerRef.current || !workspace) return;
    void pollOnce();
    timerRef.current = setInterval(() => void pollOnce(), POLL_MS);
  }, [pollOnce, workspace]);

  // `ping` = "an index may have just started" — begin polling now.
  const ping = useCallback(() => {
    wasIndexingRef.current = false; // re-arm the completion edge for this run
    start();
  }, [start]);

  // On mount / workspace change: one poll to catch an index already in flight
  // (e.g. after a reload). If it's running, polling continues; if idle, the
  // first poll stops the interval itself.
  useEffect(() => {
    wasIndexingRef.current = false;
    setStatus(null);
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  return { status, ping };
}
