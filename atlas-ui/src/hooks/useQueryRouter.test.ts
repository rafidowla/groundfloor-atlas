/**
 * useQueryRouter.test.ts — pure routing tests. Each of the tester-reported
 * routing bugs (1, 2, 3, 8, 9) has a case here that fails on the old regex
 * cascade and passes on the intent router.
 */

import { describe, it, expect, vi } from 'vitest';
import { routeQuery, classifyIntentLLM, intentToToolCall } from './useQueryRouter';

const WS = 'developer';

describe('routeQuery — greetings (issues 3, 13)', () => {
  it.each(['hi', 'Hi', 'hello', 'Hello there', 'hey', 'yo', 'thanks', 'thank you', 'good morning'])(
    'routes greeting %j to intent greeting with NO tool',
    (q) => {
      const r = routeQuery(q, WS);
      expect(r.intent).toBe('greeting');
      expect(r.tool).toBe('');
      expect(r.confident).toBe(true);
    },
  );

  it('does NOT treat "hidden dead code" as a greeting', () => {
    expect(routeQuery('hidden dead code', WS).intent).not.toBe('greeting');
  });

  it('does NOT treat "highlight hotspots" as a greeting', () => {
    expect(routeQuery('highlight hotspots', WS).intent).toBe('hotspots');
  });
});

describe('routeQuery — stats / counts (issues 1, 2)', () => {
  it('routes a node-count question to workspace_status, not knowledge_search', () => {
    const r = routeQuery('how many knowledge nodes do we have?', WS);
    expect(r.intent).toBe('stats');
    expect(r.tool).toBe('workspace_status');
    expect(r.args).toMatchObject({ workspace: WS });
  });

  it('routes "workspace status and stats" to stats, not atlas_health (issue 2)', () => {
    const r = routeQuery('show me the workspace status and stats', WS);
    expect(r.tool).toBe('workspace_status');
    expect(r.tool).not.toBe('atlas_health');
  });

  it('still routes an explicit health check to atlas_health', () => {
    expect(routeQuery('is atlas running?', WS).tool).toBe('atlas_health');
    expect(routeQuery('daemon health check', WS).tool).toBe('atlas_health');
  });
});

describe('routeQuery — unbacked work (flag → hire the PM)', () => {
  it.each([
    'what work has no approved change request?',
    'show me unbacked work',
    'which changes are unapproved',
    'anything with scope creep?',
    'what needs a CR',
  ])('routes %j to flag_unbacked_work', (q) => {
    const r = routeQuery(q, WS);
    expect(r.intent).toBe('unbacked_work');
    expect(r.tool).toBe('flag_unbacked_work');
    expect(r.args).toMatchObject({ workspace: WS });
    expect(r.confident).toBe(true);
  });
});

describe('routeQuery — bug list (issue 9)', () => {
  it('routes "list all bug fixes" to broad semantic recall (caller filters to bug_pattern)', () => {
    const r = routeQuery('list all bug fixes', WS);
    expect(r.intent).toBe('bug_list');
    expect(r.tool).toBe('knowledge_recall');
    expect(r.args).toMatchObject({ topic: 'list all bug fixes', max: 25 });
  });

  it.each(['what bugs have we fixed', 'show me the bug patterns', 'any known defects?'])(
    'recognizes bug-list phrasing %j',
    (q) => expect(routeQuery(q, WS).intent).toBe('bug_list'),
  );
});

describe('routeQuery — code analysis intents (unchanged)', () => {
  it('dead code', () => expect(routeQuery('find dead code', WS).tool).toBe('atlas_find_dead_code'));
  it('hotspots', () => expect(routeQuery('what are the hotspots', WS).tool).toBe('atlas_hotspots'));
  it('layer violations', () => expect(routeQuery('any layer violations?', WS).tool).toBe('atlas_layer_violations'));
  it('blast radius extracts a symbol', () => {
    const r = routeQuery('what is the blast radius of `runLLMChat`', WS);
    expect(r.tool).toBe('atlas_blast_radius');
    expect(r.args).toMatchObject({ symbol: 'runLLMChat' });
  });
  it('recall for a why-question', () => expect(routeQuery('why did we bump the engine', WS).tool).toBe('knowledge_recall'));
});

describe('routeQuery — fallback', () => {
  it('non-English / unmatched query falls back to non-confident search', () => {
    const r = routeQuery('কতগুলো knowledge node আছে?', WS);
    expect(r.tool).toBe('knowledge_search');
    expect(r.confident).toBe(false); // → caller escalates to the LLM classifier
  });
});

describe('classifyIntentLLM — language-agnostic escalation (issue 8)', () => {
  it('maps a Bangla count query to workspace_status via the LLM label', async () => {
    const invokeLLM = vi.fn().mockResolvedValue('stats');
    const r = await classifyIntentLLM('কতগুলো knowledge node আছে?', WS, invokeLLM);
    expect(r?.tool).toBe('workspace_status');
    expect(invokeLLM).toHaveBeenCalledOnce();
  });

  it('tolerates a chatty reply and still extracts the intent word', async () => {
    const invokeLLM = vi.fn().mockResolvedValue('Intent: bug_list');
    const r = await classifyIntentLLM('দেখাও সব বাগ ফিক্স', WS, invokeLLM);
    expect(r?.intent).toBe('bug_list');
  });

  it('returns null on an unrecognized label so the caller keeps the search fallback', async () => {
    const invokeLLM = vi.fn().mockResolvedValue('banana');
    expect(await classifyIntentLLM('???', WS, invokeLLM)).toBeNull();
  });

  it('returns null when the LLM call throws', async () => {
    const invokeLLM = vi.fn().mockRejectedValue(new Error('llm down'));
    expect(await classifyIntentLLM('anything', WS, invokeLLM)).toBeNull();
  });
});

describe('intentToToolCall', () => {
  it('greeting carries no tool', () => {
    expect(intentToToolCall('greeting', 'hi', WS).tool).toBe('');
  });
  it('search fallback is non-confident', () => {
    expect(intentToToolCall('search', 'anything', WS).confident).toBe(false);
  });
});
