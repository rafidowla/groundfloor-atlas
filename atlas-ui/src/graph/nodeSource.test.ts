/**
 * nodeSource.test.ts — Sprint 3: the code-inspector fetch state machine.
 *
 * Pure tests over the parse + load helpers (no React render). Pins: a good
 * response → loaded with the right slice; a backend {error} (e.g. path-safety
 * rejection) → error state; a thrown fetch → error state; arg-building omits
 * absent optional bounds.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSource, buildSourceArgs, loadSource } from './nodeSource';

describe('parseSource', () => {
  it('parses a well-formed atlas_source payload', () => {
    const out = parseSource({ content: 'a\nb', startLine: 10, endLine: 11, totalLines: 42 });
    expect(out).toEqual({ content: 'a\nb', startLine: 10, endLine: 11, totalLines: 42 });
  });

  it('surfaces a backend {error} (e.g. path escapes repo root)', () => {
    const out = parseSource({ error: 'path escapes repo root', path: '../x' });
    expect(out).toEqual({ error: 'path escapes repo root' });
  });

  it('rejects a payload with no content', () => {
    expect(parseSource({ startLine: 1 })).toEqual({ error: 'source response missing content' });
    expect(parseSource(null)).toEqual({ error: 'no source returned' });
    expect(parseSource('nope')).toEqual({ error: 'no source returned' });
  });
});

describe('buildSourceArgs', () => {
  it('includes bounds when present', () => {
    expect(buildSourceArgs({ path: 'src/a.ts', startLine: 5, endLine: 9, workspace: 'ws' })).toEqual({
      path: 'src/a.ts',
      startLine: 5,
      endLine: 9,
      workspace: 'ws',
    });
  });

  it('omits absent bounds (whole-file request)', () => {
    expect(buildSourceArgs({ path: 'src/a.ts', workspace: 'ws' })).toEqual({
      path: 'src/a.ts',
      workspace: 'ws',
    });
  });
});

describe('loadSource', () => {
  it('resolves to loaded on a good response and passes the right tool + args', async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: 'line 10\nline 11',
      startLine: 10,
      endLine: 11,
      totalLines: 30,
    });
    const next = await loadSource(invoke, { path: 'src/a.ts', startLine: 10, endLine: 11, workspace: 'ws' });
    expect(invoke).toHaveBeenCalledWith('atlas_source', {
      path: 'src/a.ts',
      startLine: 10,
      endLine: 11,
      workspace: 'ws',
    });
    expect(next.status).toBe('loaded');
    if (next.status === 'loaded') {
      expect(next.data.totalLines).toBe(30);
      expect(next.data.content).toBe('line 10\nline 11');
    }
  });

  it('resolves to error when the backend rejects the path', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: 'path escapes repo root', path: '../../etc/passwd' });
    const next = await loadSource(invoke, { path: '../../etc/passwd', workspace: 'ws' });
    expect(next.status).toBe('error');
    if (next.status === 'error') expect(next.message).toMatch(/escapes repo root/);
  });

  it('resolves to error when the fetch throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('network down'));
    const next = await loadSource(invoke, { path: 'src/a.ts', workspace: 'ws' });
    expect(next.status).toBe('error');
    if (next.status === 'error') expect(next.message).toBe('network down');
  });
});
