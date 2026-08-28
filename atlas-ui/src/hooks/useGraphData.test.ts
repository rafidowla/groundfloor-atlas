/**
 * useGraphData.test.ts — daemon-unreachable classification (PURE).
 *
 * `classifyLoadError` is the pure decision function `useGraphData`'s
 * `loadLevel0().catch(...)` calls to decide whether a rejected load should
 * render the distinct "daemon not reachable" state (point 3/4(a) of the
 * UX-lie fix) or the generic error state. Kept pure (no React, no rendering)
 * so it's tested the same way as this codebase's other derive-/classify-
 * style helpers (deriveProgress, deriveStats) — render-from-state, no DOM needed.
 *
 * Point 5(ii): "a fetch rejection → assert the daemon-down state renders" —
 * here that means asserting `daemonUnreachable: true` is the classification
 * result a rejected `AtlasDaemonUnreachableError` produces, since that flag is
 * exactly what WorkspacePage branches on to render the distinct banner
 * (`daemonUnreachable && ...` in WorkspacePage.tsx).
 */

import { describe, it, expect } from 'vitest';
import { classifyLoadError } from './useGraphData';
import { AtlasDaemonUnreachableError, AtlasToolError } from '../api/atlasApi';

describe('classifyLoadError', () => {
  it('(ii) classifies a daemon-unreachable rejection (connection refused) as daemonUnreachable', () => {
    const err = new AtlasDaemonUnreachableError('http://127.0.0.1:3848', new TypeError('Failed to fetch'));
    const result = classifyLoadError(err);
    expect(result.daemonUnreachable).toBe(true);
  });

  it('does NOT classify a tool-level AtlasToolError (daemon responded, call failed) as daemonUnreachable', () => {
    const err = new AtlasToolError('Index reported 3 errors', { errors: ['a', 'b', 'c'] });
    const result = classifyLoadError(err);
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('Index reported 3 errors');
  });

  it('does NOT classify a generic Error as daemonUnreachable', () => {
    const result = classifyLoadError(new Error('boom'));
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('boom');
  });

  it('falls back to a default message when the error has none', () => {
    const result = classifyLoadError({});
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('Failed to load communities');
  });
});
