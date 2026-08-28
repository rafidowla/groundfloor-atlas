/**
 * expandError.test.ts — UX-truth site #1.
 *
 * `handleNodeClick` in AtlasGraph.tsx previously did:
 *   Promise.resolve(run).then(() => onMutate()).catch(() => onMutate());
 * — a failed expand/collapse (daemon-down or tool-level error) produced ZERO
 * user feedback; the click just silently did nothing.
 *
 * `classifyExpandError` is the pure decision function the fixed catch handler
 * calls to turn a caught rejection into a classification `WorkspacePage` can
 * render as a toast (rose for daemon-unreachable, red for a generic tool
 * failure). It lives in its own module (not inline in AtlasGraph.tsx) so it's
 * testable WITHOUT importing sigma/@react-sigma/core, which require a
 * WebGL-capable environment this jsdom-free suite doesn't provide. Tested the
 * same way as this codebase's other classify-/derive- helpers
 * (`classifyLoadError` in useGraphData.ts).
 */

import { describe, it, expect } from 'vitest';
import { classifyExpandError } from './expandError';
import { AtlasDaemonUnreachableError, AtlasToolError } from '../api/atlasApi';

describe('classifyExpandError', () => {
  it('classifies a daemon-unreachable rejection as daemonUnreachable with actionable copy', () => {
    const err = new AtlasDaemonUnreachableError('http://127.0.0.1:3848', new TypeError('Failed to fetch'));
    const result = classifyExpandError(err);
    expect(result.daemonUnreachable).toBe(true);
    expect(result.message).toMatch(/not reachable/i);
  });

  it('does NOT classify a tool-level AtlasToolError as daemonUnreachable, and surfaces its real message', () => {
    const err = new AtlasToolError('tool_execution_failed: subgraph query timed out');
    const result = classifyExpandError(err);
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('tool_execution_failed: subgraph query timed out');
  });

  it('does NOT classify a generic Error as daemonUnreachable and surfaces its message', () => {
    const result = classifyExpandError(new Error('boom'));
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('boom');
  });

  it('falls back to a default message for a non-Error rejection (never surfaces nothing)', () => {
    const result = classifyExpandError('a bare string rejection');
    expect(result.daemonUnreachable).toBe(false);
    expect(result.message).toBe('Failed to expand node.');
  });
});
