/**
 * welcomeMessage.test.ts — the welcome-kind decision (tester issue 11).
 * A knowledge-only workspace must not advertise code-analysis features.
 */

import { describe, it, expect } from 'vitest';
import { pickWelcomeKind, welcomeText } from './welcomeMessage';

describe('pickWelcomeKind', () => {
  it('knowledge-only workspace (no code) → knowledge', () => {
    expect(pickWelcomeKind({ decision: 32, bug_pattern: 13, architecture: 18 })).toBe('knowledge');
  });

  it('empty / undefined breakdown → knowledge (scanned:0)', () => {
    expect(pickWelcomeKind({})).toBe('knowledge');
    expect(pickWelcomeKind(undefined)).toBe('knowledge');
  });

  it('workspace with indexed code → code', () => {
    expect(pickWelcomeKind({ code_symbol: 12672, code_file: 636, decision: 32 })).toBe('code');
  });

  it('even a single code_file counts as code-indexed', () => {
    expect(pickWelcomeKind({ code_file: 1 })).toBe('code');
  });
});

describe('welcomeText', () => {
  it('knowledge welcome does NOT advertise code-analysis features', () => {
    const t = welcomeText('knowledge');
    expect(t).toMatch(/atlas index/);
    expect(t.toLowerCase()).not.toMatch(/ask me about your codebase/);
  });

  it('code welcome mentions the code-analysis features', () => {
    expect(welcomeText('code')).toMatch(/dead code, hotspots, blast radius/);
  });
});
