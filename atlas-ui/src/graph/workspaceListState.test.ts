/**
 * workspaceListState.test.ts — UX-truth site #3.
 *
 * Pins the fix for WorkspaceSwitcher.tsx (and any other workspace-picker
 * surface): a `workspace_list` load FAILURE must never be classified the same
 * as a genuinely empty list. Previously `.catch(() => setWorkspaces([]))`
 * made "the daemon is down" and "there are truly zero workspaces" render
 * identically ("No workspaces found", no retry). `classifyWorkspaceListError`
 * is the pure decision function that keeps these distinct.
 */

import { describe, it, expect } from 'vitest';
import { classifyWorkspaceListError } from './workspaceListState';
import { AtlasDaemonUnreachableError, AtlasToolError } from '../api/atlasApi';

describe('classifyWorkspaceListError', () => {
  it('classifies a daemon-unreachable rejection as daemon-down, distinct from a tool error', () => {
    const err = new AtlasDaemonUnreachableError('http://127.0.0.1:3848', new TypeError('Failed to fetch'));
    const result = classifyWorkspaceListError(err);
    expect(result.loadState).toBe('daemon-down');
    expect(result.message).toMatch(/not reachable/i);
  });

  it('classifies a tool-level AtlasToolError as "error" (not daemon-down), carrying the real message', () => {
    const err = new AtlasToolError('tool_execution_failed: workspace registry read error');
    const result = classifyWorkspaceListError(err);
    expect(result.loadState).toBe('error');
    expect(result.message).toBe('tool_execution_failed: workspace registry read error');
  });

  it('classifies a generic Error as "error" with its message preserved', () => {
    const result = classifyWorkspaceListError(new Error('network blip'));
    expect(result.loadState).toBe('error');
    expect(result.message).toBe('network blip');
  });

  it('falls back to a default message for a non-Error rejection (never surfaces nothing)', () => {
    const result = classifyWorkspaceListError('a bare string rejection');
    expect(result.loadState).toBe('error');
    expect(result.message).toBe('Failed to load workspaces');
  });

  it('never returns the "loaded" or "loading" states — those are reserved for a genuine result, not a failure', () => {
    const result = classifyWorkspaceListError(new Error('x'));
    expect(result.loadState).not.toBe('loaded');
    expect(result.loadState).not.toBe('loading');
  });
});
