import type { ReactNode } from 'react';

export type MessageRole = 'user' | 'assistant' | 'error';

/** Inline markdown: **bold** and `code`. Everything else is literal text. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={key++} className="font-semibold text-[var(--lb-fg)]">{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={key++} className="px-1 py-px rounded bg-[var(--lb-surface)] border border-[var(--lb-border-s)] text-[0.85em] font-mono break-all">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_RE = /^\s*(\d+[.)]|[-*•])\s+/;

/**
 * Lightweight, dependency-free markdown renderer for chat answers. Handles what
 * the models actually emit — paragraphs, **bold**, `code`, and numbered/bulleted
 * lists — so the answer reads cleanly instead of showing raw `**` and cramped
 * lines. (Not a full CommonMark parser; deliberately small.)
 */
function Markdown({ text, tone = 'body' }: { text: string; tone?: 'body' | 'muted' }) {
  const color = tone === 'muted' ? 'text-[var(--lb-subtle)]' : 'text-[var(--lb-body)]';
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className={`flex flex-col gap-2 break-words leading-relaxed ${color}`}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const listLines = lines.filter((l) => l.trim());
        const isList = listLines.length > 0 && listLines.every((l) => LIST_RE.test(l));
        if (isList) {
          return (
            <ul key={bi} className="flex flex-col gap-1.5">
              {listLines.map((l, li) => {
                const mk = l.match(LIST_RE);
                const marker = mk ? mk[1].replace(/[.)]/, '.') : '•';
                const body = l.replace(LIST_RE, '');
                return (
                  <li key={li} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-[var(--lb-dim)] min-w-[1.4em] text-right">{marker}</span>
                    <span className="min-w-0">{renderInline(body)}</span>
                  </li>
                );
              })}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {renderInline(l)}
                {li < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export interface Message {
  id: string;
  role: MessageRole;
  text: string;         // user's original text OR assistant summary (Groundfloor Atlas-formatted)
  toolLabel?: string;   // e.g. "Semantic Recall"
  rawResult?: unknown;  // raw JSON from Groundfloor Atlas tool
  llmInsight?: string;  // LLM synthesis of the Groundfloor Atlas result (may be undefined when provider=none)
  llmProvider?: string; // e.g. "anthropic", "ollama"
  /** UX-truth: set when the LLM stream died mid-flight (network drop, daemon
   *  restart, an `error` SSE frame). The partial `llmInsight` accumulated so
   *  far is NEVER cleared for this — it stays visible with this indicator
   *  appended, instead of the old behavior of silently blanking everything. */
  streamError?: string;
  /** Set when retrieved context was withheld from a cloud LLM because
   *  ATLAS_LLM_ALLOW_CLOUD is not enabled — the model answered WITHOUT the
   *  retrieved nodes. Surfaced so the tool result vs. answer mismatch is
   *  explained rather than looking like a broken retrieval. */
  contextWithheld?: boolean;
  citations?: string[]; // B4: cited node ids / file paths derived from rawResult
  timestamp: number;
}

interface ChatMessageProps {
  message: Message;
  /** B4: click a citation chip → focus that node in the graph. */
  onCitationClick?: (id: string) => void;
}

/** Short display label for a citation id / file path (last path segment). */
function citationLabel(id: string): string {
  const trimmed = id.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop() || trimmed;
  return seg.length > 28 ? `…${seg.slice(-27)}` : seg;
}

/** Returns true if rawResult is worth showing in a collapsible details panel. */
function hasExpandableResult(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (Array.isArray(raw) && raw.length > 0) return true;
  if (typeof raw === 'object') {
    const keys = Object.keys(raw as object);
    return keys.some((k) =>
      ['results', 'alerts', 'dead', 'hotspots', 'd1', 'd2', 'd3'].includes(k),
    );
  }
  return false;
}

export default function ChatMessage({ message, onCitationClick }: ChatMessageProps) {
  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  // ── User bubble ──────────────────────────────────────────────────────────────
  if (message.role === 'user') {
    return (
      <div className="flex justify-end px-4 py-1">
        <div className="flex flex-col items-end gap-1 max-w-[75%]">
          <div className="bg-[#da7756]/10 border border-[#da7756]/20 rounded-2xl rounded-tr-sm px-4 py-2.5">
            <p className="text-sm text-[var(--lb-fg)] whitespace-pre-wrap break-words">
              {message.text}
            </p>
          </div>
          <span className="text-[10px] text-[var(--lb-dim)]">{timeStr}</span>
        </div>
      </div>
    );
  }

  // ── Error bubble ─────────────────────────────────────────────────────────────
  if (message.role === 'error') {
    return (
      <div className="flex justify-start px-4 py-1">
        <div className="flex flex-col gap-1 max-w-[75%]">
          <div className="bg-red-950 border border-red-900 rounded-2xl rounded-tl-sm px-4 py-2.5">
            <p className="text-sm text-red-300 whitespace-pre-wrap break-words">
              {message.text}
            </p>
          </div>
          <span className="text-[10px] text-[var(--lb-dim)] pl-1">{timeStr}</span>
        </div>
      </div>
    );
  }

  // ── Assistant bubble ─────────────────────────────────────────────────────────
  return (
    <div className="flex justify-start px-4 py-1">
      <div className="flex flex-col gap-1 max-w-[80%]">
        <div className="bg-[var(--lb-card)] border border-[var(--lb-border-s)] rounded-2xl rounded-tl-sm px-4 py-3 flex flex-col gap-2">
          {/* Tool label chip */}
          {message.toolLabel && (
            <span className="self-start text-[10px] text-[var(--lb-dim)] bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2 py-px">
              {message.toolLabel}
            </span>
          )}

          {/* LLM insight — shown prominently when available */}
          {message.llmInsight ? (
            <>
              <div className="text-sm">
                <Markdown text={message.llmInsight} />
              </div>
              {/* Groundfloor Atlas summary shown as collapsible secondary info */}
              <details className="mt-1">
                <summary className="text-[10px] text-[var(--lb-dim)] cursor-pointer select-none hover:text-[var(--lb-subtle)] transition-colors">
                  Groundfloor Atlas summary
                </summary>
                <div className="mt-1.5 text-xs pl-2 border-l border-[var(--lb-border-s)]">
                  <Markdown text={message.text} tone="muted" />
                </div>
              </details>
            </>
          ) : (
            /* No LLM — show Groundfloor Atlas summary as main content */
            <div className="text-sm">
              <Markdown text={message.text} />
            </div>
          )}

          {/* LLM provider badge */}
          {message.llmProvider && message.llmProvider !== 'none' && (
            <span className="self-start text-[9px] text-emerald-600 opacity-70">
              ✦ {message.llmProvider}
            </span>
          )}

          {/* UX-truth: mid-stream error indicator. The partial llmInsight/text
              above is left exactly as it rendered — this only APPENDS a clear
              "stream interrupted" notice, it never replaces or blanks it. */}
          {message.streamError && (
            <div className="flex items-start gap-1.5 mt-0.5 text-xs text-amber-400/90 bg-amber-950/30 border border-amber-900/50 rounded px-2 py-1.5">
              <span aria-hidden="true">⚠</span>
              <span>Stream interrupted: {message.streamError}</span>
            </div>
          )}

          {/* Context-withheld notice: the retrieval found nodes (shown above /
              cited below), but they were NOT sent to the cloud model, so the
              answer is generic. Explains the mismatch instead of leaving it
              looking like a retrieval failure. */}
          {message.contextWithheld && (
            <div className="flex items-start gap-1.5 mt-0.5 text-xs text-amber-400/90 bg-amber-950/30 border border-amber-900/50 rounded px-2 py-1.5">
              <span aria-hidden="true">🔒</span>
              <span>
                Retrieved context was withheld from the cloud model, so this answer is
                generic. The tool result above is what Groundfloor Atlas actually found. Turn on
                {' '}<span className="font-medium">"Send workspace context"</span> in
                Settings → LLM (secrets &amp; personal info are always redacted), or use
                a local model, to have the answer use it.
              </span>
            </div>
          )}

          {/* B4: clickable citation chips — sourced from the retrieval result.
              Clicking one highlights that node in the graph (and navigates). */}
          {message.citations && message.citations.length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              <span className="text-[9px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase">
                Grounded in
              </span>
              <div className="flex flex-wrap gap-1">
                {message.citations.slice(0, 12).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onCitationClick?.(id)}
                    title={id}
                    className="text-[10px] font-mono bg-violet-950/50 border border-violet-800/60 text-violet-300 hover:bg-violet-900/60 hover:border-violet-600 rounded px-1.5 py-0.5 transition-colors max-w-full truncate"
                  >
                    {citationLabel(id)}
                  </button>
                ))}
                {message.citations.length > 12 && (
                  <span className="text-[10px] text-[var(--lb-dim)] self-center">
                    +{message.citations.length - 12} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Collapsible raw JSON for power users */}
          {hasExpandableResult(message.rawResult) && (
            <details className="mt-1">
              <summary className="text-[10px] text-[var(--lb-dim)] cursor-pointer select-none hover:text-[var(--lb-subtle)] transition-colors">
                Raw result
              </summary>
              <pre className="mt-2 text-[10px] text-[var(--lb-dim)] bg-[var(--lb-deep)] border border-[var(--lb-border-s)] rounded p-2 overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                {JSON.stringify(message.rawResult, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <span className="text-[10px] text-[var(--lb-dim)] pl-1">{timeStr}</span>
      </div>
    </div>
  );
}
