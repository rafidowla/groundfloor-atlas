/**
 * chatStream.ts — frontend reader for the daemon's streaming chat route
 * (POST /api/chat/stream, shipped in B3a).
 *
 * The daemon emits Server-Sent-Event frames over a plain `text/event-stream`
 * body:
 *   data: {"token":"…"}\n\n          ← one per token, many of these
 *   data: {"done":true,"fullText":"…","provider":…,"model":…}\n\n   ← terminal
 *   data: {"error":"…"}\n\n           ← terminal, on failure
 *
 * This module does two things:
 *   1. `parseSseBuffer` — a PURE, unit-testable parser that turns a growing
 *      string buffer into parsed events + any leftover partial frame.
 *   2. `streamChat` — wires `fetch` + `getReader()` + `TextDecoder` to that
 *      parser, calling `onToken` live and resolving with the final text.
 *
 * Auth/base-URL: this route lives on the SAME daemon as /mcp and uses the
 * SAME auth, so we reuse `ATLAS_BASE` + `buildAtlasHeaders()` from atlasApi
 * verbatim rather than re-deriving anything here.
 */

import { ATLAS_BASE, buildAtlasHeaders } from './atlasApi';

const STREAM_ENDPOINT = `${ATLAS_BASE}/api/chat/stream`;

/** A single parsed SSE payload. All fields optional — shape depends on frame. */
export interface ChatStreamEvent {
  token?: string;
  done?: boolean;
  fullText?: string;
  provider?: string;
  model?: string;
  /** true when repo/knowledge context was withheld from a cloud provider. */
  contextWithheld?: boolean;
  error?: string;
}

/** A prior conversation turn for multi-turn memory. */
export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatRequest {
  query?: string;
  messages?: unknown[];
  /** Prior turns (oldest first) folded in before the current query. */
  history?: ChatHistoryTurn[];
  context?: string;
  toolLabel?: string;
  provider?: string;
  model?: string;
}

export interface StreamChatResult {
  fullText: string;
  provider?: string;
  model?: string;
  contextWithheld?: boolean;
}

/**
 * PURE: parse a growing SSE buffer into complete events + leftover.
 *
 * Frames are delimited by a blank line ("\n\n"). For each COMPLETE frame we
 * take its `data: ` line(s), strip the `data:` prefix, and JSON.parse the
 * payload. The trailing partial frame (everything after the last "\n\n") is
 * returned as `rest` so the caller can prepend the next chunk to it.
 *
 * Tolerant by design: blank frames, non-`data:` lines, and payloads that are
 * not valid JSON are skipped silently rather than throwing — a half-received
 * frame must never crash the read loop.
 */
export function parseSseBuffer(buffer: string): {
  events: ChatStreamEvent[];
  rest: string;
} {
  const events: ChatStreamEvent[] = [];

  // Everything up to the last frame delimiter is complete; the remainder is
  // a (possibly empty) partial frame we must carry forward.
  const lastDelim = buffer.lastIndexOf('\n\n');
  if (lastDelim === -1) {
    // No complete frame yet — hold the whole thing.
    return { events, rest: buffer };
  }

  const complete = buffer.slice(0, lastDelim);
  const rest = buffer.slice(lastDelim + 2);

  for (const frame of complete.split('\n\n')) {
    // A frame may carry multiple lines; concatenate the `data:` ones.
    let payload = '';
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('data:')) {
        // Strip "data:" and exactly one optional leading space.
        payload += line.slice(5).replace(/^ /, '');
      }
      // Non-data lines (comments, event:, blanks) are ignored.
    }

    const trimmed = payload.trim();
    if (!trimmed) continue; // blank / no data line — skip

    try {
      events.push(JSON.parse(trimmed) as ChatStreamEvent);
    } catch {
      // Not valid JSON — tolerate and skip, never throw.
    }
  }

  return { events, rest };
}

/**
 * Stream a chat completion from the daemon, invoking `onToken` for each token
 * as it arrives and resolving with the final `{ fullText, provider, model }`.
 *
 * Reuses Atlas's base URL + headers (same auth as /mcp). Honors `signal` so
 * the caller can abort an in-flight stream. Throws on non-200, on an `error`
 * frame, or on a missing body so the caller can fall back to the non-stream
 * path.
 */
export async function streamChat(
  req: StreamChatRequest,
  onToken: (t: string) => void,
  signal?: AbortSignal,
): Promise<StreamChatResult> {
  const res = await fetch(STREAM_ENDPOINT, {
    method: 'POST',
    headers: buildAtlasHeaders(),
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Groundfloor Atlas chat stream HTTP ${res.status}: ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('Groundfloor Atlas chat stream returned no response body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let fullText = '';
  let provider: string | undefined;
  let model: string | undefined;
  let contextWithheld: boolean | undefined;
  let sawDone = false;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;

      for (const ev of events) {
        if (ev.error) {
          throw new Error(ev.error);
        }
        if (typeof ev.token === 'string') {
          fullText += ev.token;
          onToken(ev.token);
        }
        if (ev.done) {
          sawDone = true;
          if (typeof ev.fullText === 'string') fullText = ev.fullText;
          if (ev.provider) provider = ev.provider;
          if (ev.model) model = ev.model;
          if (typeof ev.contextWithheld === 'boolean') contextWithheld = ev.contextWithheld;
        }
      }

      if (sawDone) break;
    }
  } finally {
    // Release the lock; cancel the underlying stream if we stopped early.
    try {
      await reader.cancel();
    } catch {
      // already closed — ignore
    }
  }

  return { fullText, provider, model, contextWithheld };
}
