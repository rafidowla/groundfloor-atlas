/**
 * indexOutcome.test.ts — UX-truth site #4.
 *
 * OnboardingPage.tsx previously polled a `workspace_status` REST route (which
 * 404s in LOCAL/HTTP mode) for a `state` field the daemon never returns, so
 * "indexing complete" only ever fired via a blunt 5-minute safety timeout —
 * even when the real `atlas_index` call had settled (successfully OR with an
 * error) seconds earlier. `classifyIndexOutcome` pins the fix: the terminal
 * phase must be derived ONLY from the `atlas_index` promise's own
 * resolved/rejected value (mirroring AddProjectModal, which already gets this
 * right), never from a poll of a dead field.
 */

import { describe, it, expect } from 'vitest';
import { classifyIndexOutcome } from './indexOutcome';
import { AtlasDaemonUnreachableError, AtlasToolError } from '../api/atlasApi';

describe('classifyIndexOutcome', () => {
  it('a daemon-unreachable rejection classifies as a real error, not an indefinite hang', () => {
    const err = new AtlasDaemonUnreachableError('http://127.0.0.1:3848', new TypeError('Failed to fetch'));
    const outcome = classifyIndexOutcome(err);
    expect(outcome.phase).toBe('error');
    if (outcome.phase === 'error') {
      expect(outcome.message).toMatch(/not reachable/i);
    }
  });

  it('a total-failure AtlasToolError (nothing written) classifies as error', () => {
    const err = new AtlasToolError('Index reported 4 errors', { errors: ['a', 'b', 'c', 'd'], raw: { filesWritten: 0, nodesWritten: 0, errors: ['a', 'b', 'c', 'd'] } });
    const outcome = classifyIndexOutcome(err);
    expect(outcome.phase).toBe('error');
    if (outcome.phase === 'error') {
      expect(outcome.message).toBe('Index reported 4 errors');
    }
  });

  it('a partial-success AtlasToolError (some files written despite errors) still completes onboarding as done, with the real message attached', () => {
    const err = new AtlasToolError('Index reported 2 errors', {
      errors: ['x', 'y'],
      raw: { filesWritten: 8, nodesWritten: 140, errors: ['x', 'y'] },
    });
    const outcome = classifyIndexOutcome(err);
    expect(outcome.phase).toBe('done');
    expect(outcome).toHaveProperty('partialErrorMessage', 'Index reported 2 errors');
  });

  it('a partial success detected via nodesWritten alone (filesWritten absent) still completes as done', () => {
    const err = new AtlasToolError('Index reported 1 error', {
      raw: { nodesWritten: 50, errors: ['z'] },
    });
    const outcome = classifyIndexOutcome(err);
    expect(outcome.phase).toBe('done');
  });

  it('a generic Error classifies as error with its message preserved', () => {
    const outcome = classifyIndexOutcome(new Error('registration failed'));
    expect(outcome.phase).toBe('error');
    if (outcome.phase === 'error') {
      expect(outcome.message).toBe('registration failed');
    }
  });

  it('a non-Error rejection falls back to a default error message (never surfaces nothing / never silently hangs)', () => {
    const outcome = classifyIndexOutcome('a bare string rejection');
    expect(outcome.phase).toBe('error');
    if (outcome.phase === 'error') {
      expect(outcome.message).toBe('Indexing failed');
    }
  });
});
