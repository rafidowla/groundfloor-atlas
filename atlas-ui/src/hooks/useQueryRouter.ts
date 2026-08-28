/**
 * useQueryRouter — decide which Atlas tool answers a chat query.
 *
 * Two-stage routing:
 *   1. routeQuery() — a synchronous keyword router. Fast, zero-latency, and
 *      confident for the common English phrasings. When it recognizes an intent
 *      it returns confident:true; when it can only fall back to a generic search
 *      it returns confident:false so the caller may escalate.
 *   2. classifyIntentLLM() — an async, language-agnostic fallback. When the
 *      keyword router is not confident AND an LLM is configured, the caller asks
 *      the model to classify the query into one known intent. This is what makes
 *      non-English queries (e.g. Bangla "কতগুলো knowledge node আছে") route to the
 *      right tool instead of defaulting to a full-text search.
 *
 * Greetings resolve to intent 'greeting' with NO tool — the caller short-circuits
 * to a canned reply, so "hi" no longer runs a search or raises citation chips.
 */

export type Intent =
  | 'greeting'
  | 'stats'
  | 'bug_list'
  | 'dead_code'
  | 'hotspots'
  | 'layer_violations'
  | 'blast_radius'
  | 'schema'
  | 'recall'
  | 'unbacked_work'
  | 'search';

export interface ToolCall {
  /** Atlas tool to invoke. Empty string for intents that call no tool (greeting). */
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable description of what was chosen. */
  label: string;
  /** Which intent this routing represents. */
  intent: Intent;
  /**
   * true  → the keyword router recognized this intent; use it as-is.
   * false → only the generic search fallback matched; the caller may escalate
   *         to classifyIntentLLM() before falling back to search.
   */
  confident: boolean;
}

/** Canned reply used when intent === 'greeting' (no tool, no citations). */
export const GREETING_REPLY =
  "Hi! I'm Groundfloor Atlas. Ask me about your team's decisions, conventions, and bug " +
  'patterns — or, for an indexed codebase, dead code, hotspots, blast radius, and ' +
  'layer violations. You can also ask how many nodes are in this workspace.';

/** Build a ToolCall for a known intent. Shared by the keyword router and the
 *  LLM-classifier escalation so both produce identical tool wiring. */
export function intentToToolCall(intent: Intent, query: string, workspace: string): ToolCall {
  switch (intent) {
    case 'greeting':
      return { tool: '', args: {}, label: 'Greeting', intent, confident: true };
    case 'stats':
      return { tool: 'workspace_status', args: { workspace }, label: 'Workspace Stats', intent, confident: true };
    case 'bug_list':
      // Semantic recall, NOT full-text search: a "list all bug fixes" request is
      // an enumeration, and type-filtered knowledge_search is relevance-capped
      // (returned 2 of 13 bug nodes in testing) whereas recall surfaces the bug
      // corpus broadly. The caller narrows the hits to bug_pattern nodes.
      return {
        tool: 'knowledge_recall',
        args: { topic: query, workspace, mode: 'summary', max: 25 },
        label: 'Bug Patterns',
        intent,
        confident: true,
      };
    case 'dead_code':
      return { tool: 'atlas_find_dead_code', args: { workspace }, label: 'Dead Code Analysis', intent, confident: true };
    case 'hotspots':
      return { tool: 'atlas_hotspots', args: { workspace, limit: 10 }, label: 'Hotspot Analysis', intent, confident: true };
    case 'layer_violations':
      return { tool: 'atlas_layer_violations', args: { workspace }, label: 'Layer Violations', intent, confident: true };
    case 'blast_radius': {
      const symbol = extractSymbol(query);
      return {
        tool: 'atlas_blast_radius',
        args: { workspace, ...(symbol ? { symbol } : {}) },
        label: `Blast Radius${symbol ? ` — ${symbol}` : ''}`,
        intent,
        confident: true,
      };
    }
    case 'schema':
      return {
        tool: 'knowledge_search',
        args: { q: query, workspace, limit: 10, type: 'decision' },
        label: 'Schema Knowledge Search',
        intent,
        confident: true,
      };
    case 'recall':
      return {
        tool: 'knowledge_recall',
        args: { topic: query, workspace, mode: 'full', max: 8 },
        label: 'Semantic Recall',
        intent,
        confident: true,
      };
    case 'unbacked_work':
      return {
        tool: 'flag_unbacked_work',
        args: { workspace },
        label: 'Unbacked Work',
        intent,
        confident: true,
      };
    case 'search':
    default:
      return {
        tool: 'knowledge_search',
        args: { q: query, workspace, limit: 10 },
        label: 'Knowledge Search',
        intent: 'search',
        confident: false,
      };
  }
}

/** Grab a likely symbol name from a blast-radius question. */
function extractSymbol(query: string): string | undefined {
  const m =
    query.match(/`([^`]+)`/) ??
    query.match(/["']([^"']+)["']/) ??
    query.match(/\b([A-Z][a-zA-Z0-9_]+)\b/);
  return m?.[1];
}

/**
 * Synchronous keyword router. Returns a confident ToolCall when it recognizes an
 * intent, otherwise a non-confident 'search' fallback the caller may escalate.
 */
export function routeQuery(query: string, workspace: string): ToolCall {
  const q = query.toLowerCase().trim();

  // Greeting / small-talk — a SHORT message that is essentially just a greeting.
  // Anchored so "hi" matches but "hidden dead code" does not.
  if (/^(hi|hii+|hey|hey there|hiya|yo|hello|hello there|greetings|howdy|sup|good (morning|afternoon|evening|day)|thanks|thank you|thx|ty|cheers)[\s!.,?]*$/.test(q)) {
    return intentToToolCall('greeting', query, workspace);
  }

  // Stats / counts — "how many nodes", "node count", "workspace stats/status".
  // MUST come before the health check so "workspace status and stats" reports
  // KPIs, not daemon uptime. Also catches the common "node"+count phrasing that
  // shows up transliterated in non-English queries.
  if (
    /how many|number of|count of|\bnodes?\b.*\bcount\b|\bcount\b.*\bnodes?\b|node count|edge count|workspace (stats|status|statistics|kpis?)|(stats|statistics|kpis?)\b|how big|graph size/.test(q)
  ) {
    return intentToToolCall('stats', query, workspace);
  }

  // Bug list — "list bug fixes", "what bugs", "bug patterns".
  if (/\b(bug|bugs|bug fix|bug fixes|bug pattern|bug patterns|defects?|fixes)\b/.test(q)) {
    return intentToToolCall('bug_list', query, workspace);
  }

  // Dead code / unused
  if (/dead.?code|unused\s+(symbol|function|export)|unreachable/.test(q)) {
    return intentToToolCall('dead_code', query, workspace);
  }

  // Hotspots / complexity / risk
  if (/hotspot|most complex|high.?churn|risky (file|code)|complexity/.test(q)) {
    return intentToToolCall('hotspots', query, workspace);
  }

  // Layer violations
  if (/layer.?violation|arch(itecture)?.?(violation|break)|wrong.?layer/.test(q)) {
    return intentToToolCall('layer_violations', query, workspace);
  }

  // Blast radius
  if (/blast.?radius|impact.?of.?(changing|modifying)|what.?breaks/.test(q)) {
    return intentToToolCall('blast_radius', query, workspace);
  }

  // Schema drift
  if (/schema.?(drift|diff|change|migrate)|migration/.test(q)) {
    return intentToToolCall('schema', query, workspace);
  }

  // Unbacked work — "what has no approved change request", "unbacked",
  // "unapproved work", "scope creep", "flag(ged) work". Kept before schema's
  // "change" would over-match by requiring the change-request / approval framing.
  if (/unbacked|unapproved|no approved|without.*(approval|change request)|change request|scope creep|flagged? work|what needs.*(approval|a cr)\b/.test(q)) {
    return intentToToolCall('unbacked_work', query, workspace);
  }

  // Semantic recall: why/decision/convention/how-do-we questions
  if (/^why |decision|convention|how do we|what's our|troubleshoot/.test(q)) {
    return intentToToolCall('recall', query, workspace);
  }

  // Atlas/daemon health — narrow: only explicit health/liveness of the service,
  // NOT the bare word "status" (that belongs to workspace stats above).
  if (/atlas health|daemon health|health check|is (atlas|groundfloor-atlas|the daemon) (running|up|ok|alive|healthy)/.test(q)) {
    return { tool: 'atlas_health', args: {}, label: 'Groundfloor Atlas Health', intent: 'search', confident: true };
  }

  // Default: full-text search — NOT confident, so the caller can escalate to the
  // LLM classifier (this is the path a non-English query falls through).
  return intentToToolCall('search', query, workspace);
}

/** The intents the LLM classifier is allowed to return. */
const CLASSIFIABLE: Intent[] = [
  'greeting', 'stats', 'bug_list', 'dead_code', 'hotspots',
  'layer_violations', 'blast_radius', 'schema', 'recall', 'unbacked_work', 'search',
];

/**
 * Language-agnostic intent classification via the configured LLM. Used only when
 * the keyword router is not confident. `invokeLLM` runs an llm_chat call and
 * returns the model's raw text; we constrain it to reply with a single intent
 * label and map that back to a ToolCall. Returns null if the LLM is unavailable
 * or the reply doesn't match a known intent (caller then keeps the search fallback).
 *
 * Note: only the QUERY is sent for classification — no retrieved context — so this
 * works even against a cloud provider without ATLAS_LLM_ALLOW_CLOUD.
 */
export async function classifyIntentLLM(
  query: string,
  workspace: string,
  invokeLLM: (prompt: string) => Promise<string>,
): Promise<ToolCall | null> {
  // Kept compact and single-line: a long multi-line bulleted prompt intermittently
  // tripped the local ollama provider with an internal error. The query is in any
  // language; the model classifies cross-lingually.
  const prompt =
    'Classify the query into ONE word from: greeting, stats, bug_list, dead_code, ' +
    'hotspots, layer_violations, blast_radius, schema, recall, unbacked_work, search. ' +
    'stats = how many nodes/edges or workspace size. bug_list = list bugs/fixes. ' +
    'recall = why a decision was made or team conventions. ' +
    'unbacked_work = work/changes with no approved change request (unapproved scope). ' +
    `Query: ${query} — reply with only the intent word.`;

  let reply: string;
  try {
    reply = await invokeLLM(prompt);
  } catch {
    return null;
  }
  // Scan for the first token that IS a known intent, so a chatty reply like
  // "Intent: bug_list" still resolves (the leading "intent" token is skipped).
  const tokens = (reply || '').toLowerCase().replace(/[^a-z_]/g, ' ').split(/\s+/).filter(Boolean);
  const intent = tokens.find((t) => (CLASSIFIABLE as string[]).includes(t)) as Intent | undefined;
  if (!intent) return null;
  return intentToToolCall(intent, query, workspace);
}
