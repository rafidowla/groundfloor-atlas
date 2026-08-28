/**
 * ChatPanel.tsx — the reusable chat surface.
 *
 * Extracted from ChatPage so the SAME chat (routing → Groundfloor Atlas retrieval → LLM
 * synthesis → citations) can render in two places with one implementation:
 *   - the full-page Chat tab (ChatPage wraps this, `embedded={false}`)
 *   - a collapsible right panel docked beside the graph (WorkspacePage,
 *     `embedded={true}`) so you can ask questions while the graph is visible.
 *
 * `embedded` only changes chrome: it drops the big page header and tightens
 * paddings so the panel fits a narrow column. All behavior is identical, and the
 * citation store is workspace-scoped, so a citation raised from the docked panel
 * highlights the very graph sitting next to it.
 */

import { useCallback, useRef, useState, useEffect, KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Loader2, Plus } from 'lucide-react';
import { invokeAtlasTool } from '../../api/atlasApi';
import { streamChat } from '../../api/chatStream';
import { classifyStreamFailure, LLM_OFF_SENTINEL_MESSAGE } from '../../api/streamOutcome';
import { routeQuery, classifyIntentLLM, GREETING_REPLY } from '../../hooks/useQueryRouter';
import ChatMessage, { Message } from './ChatMessage';
import CreateNodeModal from './CreateNodeModal';
import LLMConfigBar from './LLMConfigBar';
import type { LLMConfig } from './LLMConfigBar';
import { useCitations } from '../../graph/CitationProvider';
import { deriveCitations } from '../../graph/citationStore';
import { pickWelcomeKind, welcomeText, type WelcomeKind } from './welcomeMessage';

// ── Result shape helpers ────────────────────────────────────────────────────

interface HealthResult { status?: string; version?: string; uptime_ms?: number }
interface WorkspaceStatusResult { workspace?: string; nodeCount?: number; edgeCount?: number; typeBreakdown?: Record<string, number> }
interface DeadCodeResult { dead?: Array<{ symbol?: string; file?: string; [k: string]: unknown }>; candidates?: Array<{ name?: string; file?: string; kind?: string; [k: string]: unknown }> }
interface HotspotsResult { hotspots?: Array<{ file?: string; complexity?: number; [k: string]: unknown }>; entries?: Array<{ name?: string; file?: string; score?: number; [k: string]: unknown }> }
interface BlastRadiusResult { d1?: unknown[]; d2?: unknown[]; d3?: unknown[] }
interface KnowledgeResult { results?: Array<{ label?: string; content?: string; [k: string]: unknown }>; nodes?: Array<{ label?: string; content?: string; [k: string]: unknown }>; hits?: Array<{ label?: string; content?: string; [k: string]: unknown }> }

function formatResult(tool: string, result: unknown): string {
  if (result === null || result === undefined) return '(No response from Groundfloor Atlas)';

  if (tool === 'atlas_health') {
    const r = result as HealthResult;
    return `Groundfloor Atlas is ${r.status ?? 'unknown'}. Version ${r.version ?? '?'}, uptime ${r.uptime_ms ?? '?'}ms.`;
  }
  if (tool === 'workspace_status') {
    const r = result as WorkspaceStatusResult;
    const nodes = r.nodeCount ?? 0;
    const edges = r.edgeCount ?? 0;
    const bd = r.typeBreakdown ?? {};
    const KNOWLEDGE = new Set(['decision', 'convention', 'bug_pattern', 'troubleshooting', 'architecture']);
    let knowledge = 0;
    let code = 0;
    const lines: string[] = [];
    for (const [type, count] of Object.entries(bd)) {
      const n = typeof count === 'number' ? count : 0;
      if (KNOWLEDGE.has(type)) knowledge += n; else code += n;
      lines.push(`  • ${type}: ${n}`);
    }
    const header =
      `Workspace ${r.workspace ?? ''} — ${nodes.toLocaleString()} nodes, ${edges.toLocaleString()} edges ` +
      `(${knowledge.toLocaleString()} knowledge, ${code.toLocaleString()} code).`;
    return lines.length ? `${header}\n\nBy type:\n${lines.join('\n')}` : header;
  }
  if (tool === 'atlas_find_dead_code') {
    const r = result as DeadCodeResult;
    const dead = r.candidates ?? r.dead ?? (Array.isArray(result) ? (result as unknown[]) : []);
    if (dead.length === 0) return 'No dead code symbols found.';
    const preview = dead.slice(0, 5).map((d) => {
      const item = d as { symbol?: string; name?: string; file?: string; kind?: string };
      const sym = item.symbol ?? item.name ?? JSON.stringify(d);
      return `  • ${sym}${item.file ? ` (${item.file})` : ''}`;
    });
    const more = dead.length > 5 ? `\n  … and ${dead.length - 5} more` : '';
    return `Found ${dead.length} dead symbol${dead.length === 1 ? '' : 's'}:\n${preview.join('\n')}${more}`;
  }
  if (tool === 'atlas_hotspots') {
    const r = result as HotspotsResult;
    const hotspots = r.entries ?? r.hotspots ?? (Array.isArray(result) ? (result as unknown[]) : []);
    if (hotspots.length === 0) return 'No hotspots found.';
    const preview = hotspots.slice(0, 5).map((h) => {
      const item = h as { file?: string; name?: string; complexity?: number; score?: number };
      const sym = item.name ?? item.file ?? JSON.stringify(h);
      const metric = item.score !== undefined ? `score ${item.score}` : item.complexity !== undefined ? `complexity ${item.complexity}` : '';
      return `  • ${sym}${metric ? ` — ${metric}` : ''}`;
    });
    const more = hotspots.length > 5 ? `\n  … and ${hotspots.length - 5} more` : '';
    return `Top hotspots:\n${preview.join('\n')}${more}`;
  }
  if (tool === 'atlas_blast_radius') {
    const r = result as BlastRadiusResult;
    const d1 = r.d1 ?? [], d2 = r.d2 ?? [], d3 = r.d3 ?? [];
    return `Blast radius — D1 (will break): ${d1.length} symbol${d1.length === 1 ? '' : 's'}, D2: ${d2.length}, D3: ${d3.length}`;
  }
  if (tool === 'knowledge_recall' || tool === 'knowledge_search') {
    const r = result as KnowledgeResult;
    // knowledge_search → results[]; knowledge_recall → hits[]; some tools → nodes[].
    // Reading only results/nodes made every recall render "No knowledge nodes found."
    const results = r.results ?? r.nodes ?? r.hits ?? (Array.isArray(result) ? (result as unknown[]) : []);
    if (results.length === 0) return 'No knowledge nodes found.';
    const items = results.slice(0, 6).map((node) => {
      const n = node as { label?: string; content?: string };
      const label = n.label ?? '(untitled)';
      const snippet = n.content ? n.content.slice(0, 120) : '';
      return `  • ${label}${snippet ? `\n    ${snippet}${n.content && n.content.length > 120 ? '…' : ''}` : ''}`;
    }).join('\n\n');
    return `Found ${results.length} node${results.length === 1 ? '' : 's'}:\n\n${items}`;
  }
  return JSON.stringify(result, null, 2);
}

function makeWelcomeMessage(kind: WelcomeKind = 'code'): Message {
  return {
    id: 'welcome',
    role: 'assistant',
    text: welcomeText(kind),
    timestamp: Date.now(),
  };
}

interface LLMChatResult { response?: string; provider?: string; model?: string; passthrough?: boolean; error?: string }

async function fetchLLMInsight(query: string, context: string, toolLabel: string): Promise<{ insight: string; provider: string } | null> {
  try {
    const result = await invokeAtlasTool('llm_chat', { query, context, toolLabel }) as LLMChatResult;
    if (result.error) return null;
    if (result.passthrough) return null;
    if (result.response && result.response.trim()) {
      return { insight: result.response.trim(), provider: result.provider ?? 'llm' };
    }
  } catch { /* non-fatal */ }
  return null;
}

export interface ChatPanelProps {
  workspaceName: string;
  /** Compact chrome for the docked-beside-graph layout (no big page header). */
  embedded?: boolean;
  /** External seed for the input box — set when the user clicks "Ask in chat"
   *  on a graph node, so the question about that node lands in the composer
   *  ready to send/edit. */
  seedInput?: string;
}

export default function ChatPanel({ workspaceName, embedded = false, seedInput }: ChatPanelProps) {
  const navigate = useNavigate();
  const { setCitations } = useCitations(workspaceName);

  const [messages, setMessages] = useState<Message[]>(() => [makeWelcomeMessage()]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [createNodeOpen, setCreateNodeOpen] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Always-current snapshot of messages, so handleSend can build conversation
  // history without depending on (and re-creating on) every message change.
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Abort any in-flight chat stream on unmount — previously the daemon kept
  // generating (and the token callback kept setState-ing a dead panel).
  const streamAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { streamAbortRef.current?.abort(); }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Tailor the welcome to whether this workspace has indexed code. A knowledge-
  // only workspace (scanned:0) must not advertise dead-code/hotspot/blast-radius
  // features that can't run until a project is indexed (issue 11).
  useEffect(() => {
    let cancelled = false;
    invokeAtlasTool('workspace_status', { workspace: workspaceName })
      .then((res) => {
        if (cancelled) return;
        const bd = (res as { typeBreakdown?: Record<string, number> }).typeBreakdown;
        const kind = pickWelcomeKind(bd);
        setMessages((prev) => prev.map((m) =>
          m.id === 'welcome' ? { ...makeWelcomeMessage(kind), timestamp: m.timestamp } : m,
        ));
      })
      .catch(() => { /* keep the default welcome on error */ });
    return () => { cancelled = true; };
  }, [workspaceName]);

  // Drop an external seed (from "Ask in chat" on a node) into the composer and
  // focus it, so the user can edit or hit Enter. Runs on each new seed value.
  useEffect(() => {
    if (seedInput && seedInput.trim()) {
      setInputText(seedInput);
      textareaRef.current?.focus();
    }
  }, [seedInput]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setInputText('');
    setSending(true);

    const userMsg: Message = { id: `user-${Date.now()}`, role: 'user', text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    const thinkingId = `thinking-${Date.now()}`;
    setMessages((prev) => [...prev, { id: thinkingId, role: 'assistant', text: '…', timestamp: Date.now() }]);

    try {
      let toolCall = routeQuery(text, workspaceName);
      // Escalate uncertain routes to the language-agnostic LLM classifier, so a
      // non-English query (e.g. Bangla "কতগুলো knowledge node আছে") reaches the
      // right tool instead of blindly defaulting to a full-text search. Only the
      // query is sent — no retrieved context — so this is safe on any provider.
      if (!toolCall.confident && llmConfig && llmConfig.provider !== 'none') {
        const classified = await classifyIntentLLM(text, workspaceName, async (prompt) => {
          const res = (await invokeAtlasTool('llm_chat', { query: prompt })) as { response?: string };
          return res.response ?? '';
        });
        if (classified) toolCall = classified;
      }

      // Greeting → canned reply. No tool call, no LLM synthesis, no citations,
      // so "hi" stops running a search and surfacing unrelated "Grounded in" chips.
      if (toolCall.intent === 'greeting') {
        setCitations([]);
        setMessages((prev) => prev.map((m) =>
          m.id === thinkingId ? { ...m, text: GREETING_REPLY, toolLabel: undefined } : m,
        ));
        return;
      }

      let result = await invokeAtlasTool(toolCall.tool, toolCall.args as Record<string, unknown>);
      // bug_list recalls broadly (recall is not type-filterable server-side), then
      // narrows to actual bug_pattern nodes so the answer lists real bug fixes
      // instead of decisions/architecture that merely mention bugs.
      if (toolCall.intent === 'bug_list' && result && typeof result === 'object') {
        const hits = (result as { hits?: Array<{ type?: string }> }).hits;
        if (Array.isArray(hits)) {
          result = { ...(result as object), hits: hits.filter((h) => h?.type === 'bug_pattern') };
        }
      }
      const summary = formatResult(toolCall.tool, result);
      const citationIds = deriveCitations(result);
      // The LLM gets the tool's own already-digested summary FIRST, then the raw
      // JSON. Without the summary the model paraphrases raw fields and mislabels
      // them — e.g. reporting total nodeCount as "knowledge nodes" for a stats
      // query when the knowledge/code split is right there in the summary.
      const llmContext = `${summary}\n\nRaw tool result (JSON):\n${JSON.stringify(result, null, 2)}`;

      setMessages((prev) => prev.map((m) =>
        m.id === thinkingId
          ? { ...m, text: summary, toolLabel: toolCall.label, rawResult: result, citations: citationIds }
          : m,
      ));

      if (citationIds.length > 0) setCitations(citationIds);

      // Build multi-turn history from prior turns (skip the welcome + the current
      // placeholder). Assistant turns use the LLM insight when present, else the
      // tool summary. Capped to the last few turns to bound payload size.
      const history = messagesRef.current
        .filter((m) => m.id !== 'welcome' && m.id !== thinkingId && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.role === 'assistant' ? (m.llmInsight ?? m.text) : m.text,
        }))
        .filter((m) => m.content && m.content.trim().length > 0)
        .slice(-6);

      let streamed = '';
      try {
        if (llmConfig?.provider === 'none') throw new Error(LLM_OFF_SENTINEL_MESSAGE);
        const abort = new AbortController();
        streamAbortRef.current = abort;
        const result2 = await streamChat(
          {
            query: text,
            context: llmContext,
            toolLabel: toolCall.label,
            history,
            provider: llmConfig?.provider,
            model: llmConfig?.model,
          },
          (token) => {
            streamed += token;
            setMessages((prev) => prev.map((m) => (m.id === thinkingId ? { ...m, llmInsight: streamed } : m)));
          },
          abort.signal,
        );
        const finalInsight = (result2.fullText || streamed).trim();
        setMessages((prev) => prev.map((m) =>
          m.id === thinkingId
            ? { ...m, llmInsight: finalInsight || undefined, llmProvider: result2.provider ?? llmConfig?.provider, contextWithheld: result2.contextWithheld }
            : m,
        ));
      } catch (streamErr) {
        // UX-truth site #2: a mid-stream failure (network drop, daemon
        // restart, an `error` SSE frame from chatStream.ts) previously fell
        // through to fetchLLMInsight's non-stream retry unconditionally,
        // which — on its own failure or empty response — set
        // `llmInsight: undefined`, WIPING whatever partial tokens had already
        // rendered on screen with no explanation. `classifyStreamFailure` is
        // the pure decision (see streamOutcome.ts) that keeps a partial
        // answer intact instead of discarding it.
        const action = classifyStreamFailure(streamed, streamErr);
        if (action.kind === 'keep-partial-with-error') {
          setMessages((prev) => prev.map((m) =>
            m.id === thinkingId ? { ...m, llmInsight: streamed, streamError: action.reason } : m,
          ));
        } else {
          // 'silent-fallback' (llm-off) or 'try-fallback' (failed before any
          // token arrived — nothing on screen to protect): the non-stream
          // path is safe to attempt.
          const llmResult = await fetchLLMInsight(text, llmContext, toolCall.label);
          if (llmResult) {
            setMessages((prev) => prev.map((m) =>
              m.id === thinkingId ? { ...m, llmInsight: llmResult.insight, llmProvider: llmResult.provider } : m,
            ));
          } else if (action.kind === 'try-fallback') {
            // Neither the stream nor the non-stream fallback produced
            // anything, and this wasn't the intentional "LLM off" path —
            // surface that the insight genuinely failed rather than leaving a
            // mysteriously blank insight area under the (already-shown) tool
            // summary.
            const reason = streamErr instanceof Error ? streamErr.message : 'LLM insight unavailable';
            setMessages((prev) => prev.map((m) =>
              m.id === thinkingId ? { ...m, streamError: reason } : m,
            ));
          }
        }
      }
    } catch (err) {
      setMessages((prev) => prev.map((m) =>
        m.id === thinkingId
          ? { id: thinkingId, role: 'error' as const, text: err instanceof Error ? err.message : 'An unexpected error occurred.', timestamp: m.timestamp }
          : m,
      ));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [inputText, sending, workspaceName, llmConfig, setCitations]);

  const handleCitationClick = useCallback((id: string) => {
    setCitations([id]);
    // In the docked panel the graph is already on-screen; navigating to the graph
    // route is harmless (same workspace) and keeps the full-page tab behavior.
    navigate(`/workspace/${workspaceName}`);
  }, [setCitations, navigate, workspaceName]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNodeCreated = useCallback((nodeId: string) => {
    setMessages((prev) => [...prev, {
      id: `system-${Date.now()}`,
      role: 'assistant',
      text: `Knowledge node stored${nodeId ? ` (id: ${nodeId})` : ''}.`,
      timestamp: Date.now(),
    }]);
  }, []);

  const hasLLM = llmConfig?.provider && llmConfig.provider !== 'none';
  const inputPlaceholder = hasLLM
    ? `Ask anything — Groundfloor Atlas retrieves context, ${llmConfig?.provider} synthesises… (Enter)`
    : 'Ask about dead code, hotspots, decisions… (Enter)';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header (full page) / compact bar (embedded) ── */}
      {embedded ? (
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--lb-border-s)] bg-[var(--lb-overlay)] shrink-0">
          <LLMConfigBar onConfigChange={setLlmConfig} />
          <button
            onClick={() => setCreateNodeOpen(true)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] rounded text-[var(--lb-body)] hover:text-[var(--lb-fg)] transition-colors"
          >
            <Plus size={11} />
            Knowledge
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--lb-border-s)] bg-[var(--lb-overlay)] shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-base font-bold text-[var(--lb-fg)] leading-tight">{workspaceName || 'Workspace'}</h1>
              <p className="text-xs text-[var(--lb-dim)] mt-px">Chat</p>
            </div>
            <LLMConfigBar onConfigChange={setLlmConfig} />
          </div>
          <button
            onClick={() => setCreateNodeOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] rounded text-[var(--lb-body)] hover:text-[var(--lb-fg)] transition-colors"
          >
            <Plus size={12} />
            Add Knowledge
          </button>
        </div>
      )}

      {/* ── Message list ── */}
      <div className={`flex-1 overflow-y-auto ${embedded ? 'py-2' : 'py-4'} space-y-1`}>
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} onCitationClick={handleCitationClick} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input area ── */}
      <div className={`shrink-0 border-t border-[var(--lb-border-s)] bg-[var(--lb-overlay)] ${embedded ? 'px-2 py-2' : 'px-4 py-3'}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={1}
            placeholder={inputPlaceholder}
            className="flex-1 resize-none bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-lg px-3 py-2.5 text-sm text-[var(--lb-fg)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50 min-h-[40px] max-h-[96px] overflow-y-auto leading-relaxed"
            style={{ height: 'auto' }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
            }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !inputText.trim()}
            aria-label="Send"
            className="flex items-center justify-center w-10 h-10 shrink-0 rounded-lg bg-[#da7756] hover:bg-[#c86a47] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
        {!embedded && <p className="text-[10px] text-[var(--lb-border-s)] mt-1.5 pl-1">Shift+Enter for newline</p>}
      </div>

      <CreateNodeModal
        open={createNodeOpen}
        onOpenChange={setCreateNodeOpen}
        workspace={workspaceName}
        onCreated={handleNodeCreated}
      />
    </div>
  );
}
