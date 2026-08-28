/**
 * llm/streamChat.ts — B3a server-side LLM streaming layer.
 *
 * This is the SERVER half of B3 (streaming chat). The existing
 * `mcp/tools/llmChat.ts` (`runLLMChat`) buffers the whole completion
 * (`stream:false` + a body-buffering `postJSON`) and the MCP shim
 * `atlas_tool_invoke` returns one awaited result — neither path can
 * carry per-token frames. This module provides a real incremental
 * token stream the daemon can pump out over Server-Sent Events
 * (see the `/api/chat/stream` route in `mcp/server.ts`).
 *
 * Provider policy:
 *   - ollama    : TRUE token-by-token streaming. POST /api/chat with
 *                 stream:true, read the chunked NDJSON response, parse
 *                 one JSON object per line, emit each message.content
 *                 delta to `onToken` as it arrives.
 *   - openai    : TRUE token-by-token streaming. POST /v1/chat/completions
 *                 with stream:true (Bearer auth), read the SSE response,
 *                 parse each `choices[0].delta.content` via
 *                 `parseOpenAiChunk`. Falls back to the non-streaming
 *                 `runLLMChat` path (ONE token frame) ONLY when no API key
 *                 is configured, so a misconfigured provider never crashes.
 *   - anthropic : TRUE token-by-token streaming. POST /v1/messages with
 *                 stream:true (x-api-key + anthropic-version), read the SSE
 *                 response, parse each `content_block_delta` text delta via
 *                 `parseAnthropicChunk`. Same no-key fallback as openai.
 *   - none      : passthrough — emits the context/query verbatim as one token.
 *
 * The per-provider SSE/NDJSON line parsers are extracted into the pure,
 * exported `parseOllamaChunk` / `parseOpenAiChunk` / `parseAnthropicChunk`
 * so they are unit-testable without a live model or network.
 *
 * Reuses the prompt-building + consent/redaction helpers from
 * `llmChat.ts` (now exported) so streaming and non-streaming share the
 * EXACT same system/user prompt and the same cloud-context withholding
 * rules — no drift between the two paths.
 */

import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import type { LLMConfig } from '../config.js';
import { cloudUrlError, isLoopbackHost, loopbackUrlError, PlaintextTokenError } from '../httpTransport.js';
import {
    runLLMChat,
    buildSystemPrompt,
    buildUserMessage,
    sanitizeContext,
    cloudContextAllowed,
    type LLMChatInput,
} from '../mcp/tools/llmChat.js';

// ── Public types ───────────────────────────────────────────────────────────────

export interface StreamChatProvider {
    name: string;
}

/** Called once per token (or text delta) as it streams in. */
export type TokenSink = (token: string) => void;

/** Message shape passed to a provider. Mirrors the OpenAI/Ollama chat schema. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface StreamChatResult {
    fullText: string;
    tokenCount: number;
    provider: string;
    model: string;
    /** true when the provider streamed token-by-token (ollama / fake). */
    streamed: boolean;
    /** true when repo/knowledge context was withheld from a cloud provider. */
    contextWithheld?: boolean;
}

// ── Pure NDJSON parser (unit-testable, no I/O) ──────────────────────────────────

/**
 * Parse a buffer of Ollama NDJSON output incrementally.
 *
 * Ollama's `/api/chat` with `stream:true` emits ONE JSON object per line:
 *   {"message":{"role":"assistant","content":"Hel"},"done":false}\n
 *   {"message":{"role":"assistant","content":"lo"},"done":false}\n
 *   {"message":{"role":"assistant","content":""},"done":true,...}\n
 * (`/api/generate` uses `{"response":"...","done":false}` instead —
 * both delta shapes are handled.)
 *
 * Network chunks split arbitrarily, so a chunk may end mid-line. This
 * function pulls every COMPLETE line out of `buffer`, returns the content
 * deltas found, and returns the trailing partial line as `rest` to be
 * prepended to the next chunk. Pure: no side effects, no I/O.
 *
 * Blank lines and unparseable lines are skipped (Ollama only ever emits
 * well-formed JSON lines, but we tolerate noise defensively). The
 * terminal `done:true` line carries no content delta, so it contributes
 * no token.
 */
export function parseOllamaChunk(buffer: string): { tokens: string[]; rest: string } {
    const tokens: string[] = [];
    // Keep the trailing partial line (everything after the last newline).
    const lastNl = buffer.lastIndexOf('\n');
    if (lastNl === -1) {
        // No complete line yet — hold the whole buffer back.
        return { tokens, rest: buffer };
    }
    const complete = buffer.slice(0, lastNl);
    const rest = buffer.slice(lastNl + 1);

    for (const rawLine of complete.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue; // tolerate non-JSON noise
        }
        // /api/chat shape: { message: { content } }
        const message = obj['message'] as Record<string, unknown> | undefined;
        const chatDelta = typeof message?.['content'] === 'string' ? (message['content'] as string) : undefined;
        // /api/generate shape: { response }
        const genDelta = typeof obj['response'] === 'string' ? (obj['response'] as string) : undefined;
        const delta = chatDelta ?? genDelta;
        if (delta && delta.length > 0) tokens.push(delta);
    }
    return { tokens, rest };
}

/**
 * Parse a buffer of OpenAI `chat/completions` SSE output incrementally.
 *
 * OpenAI's streaming wire is `\n\n`-delimited event blocks, each carrying a
 * single `data:` line:
 *   data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n   (role-only first frame)
 *   data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n
 *   data: {"choices":[{"delta":{"content":"lo"}}]}\n\n
 *   data: [DONE]\n\n                                          (terminal marker)
 *
 * Like `parseOllamaChunk` this is pure and incremental: it pulls every
 * COMPLETE `\n\n`-delimited block out of `buffer`, returns the content
 * deltas found, and returns the trailing partial block as `rest` to be
 * prepended to the next network chunk.
 *
 * Only `choices[0].delta.content` strings yield a unified token. The
 * role-only first frame (delta with no `content`), the `[DONE]` sentinel,
 * blank blocks, and any unparseable JSON are skipped defensively — the HTTP
 * `res.on('end')` is what resolves the stream, not `[DONE]`.
 */
export function parseOpenAiChunk(buffer: string): { tokens: string[]; rest: string } {
    const tokens: string[] = [];
    // Carry the trailing partial block (everything after the last "\n\n").
    const lastSep = buffer.lastIndexOf('\n\n');
    if (lastSep === -1) {
        return { tokens, rest: buffer };
    }
    const complete = buffer.slice(0, lastSep);
    const rest = buffer.slice(lastSep + 2);

    for (const block of complete.split('\n\n')) {
        // A block may carry multiple lines; only `data:` lines matter.
        for (const rawLine of block.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            if (!line.startsWith('data:')) continue; // skip event:/comment/blank
            const payload = line.slice('data:'.length).replace(/^ /, '').trim();
            if (payload.length === 0) continue;
            if (payload === '[DONE]') continue; // terminal marker — no token
            let obj: Record<string, unknown>;
            try {
                obj = JSON.parse(payload) as Record<string, unknown>;
            } catch {
                continue; // tolerate non-JSON noise
            }
            const choices = obj['choices'] as Array<Record<string, unknown>> | undefined;
            const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
            const content = typeof delta?.['content'] === 'string' ? (delta['content'] as string) : undefined;
            if (content && content.length > 0) tokens.push(content);
        }
    }
    return { tokens, rest };
}

/**
 * Parse a buffer of Anthropic `/v1/messages` SSE output incrementally.
 *
 * Anthropic's streaming wire is `\n\n`-delimited event blocks. Each block
 * carries an `event:` line and a `data:` line:
 *   event: message_start\ndata: {"type":"message_start",...}\n\n
 *   event: content_block_start\ndata: {"type":"content_block_start",...}\n\n
 *   event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n
 *   event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n
 *   event: message_delta\ndata: {"type":"message_delta",...}\n\n
 *   event: message_stop\ndata: {"type":"message_stop"}\n\n
 *
 * We read only the `data:` line and switch on `obj.type`. The ONLY
 * token-bearing case is `content_block_delta` with `delta.type ===
 * 'text_delta'` → push `delta.text`. Every other event type
 * (`message_start`, `content_block_start`, `content_block_stop`,
 * `message_delta`, `message_stop`, `ping`) yields no token. Pure and
 * incremental: trailing partial block carried forward via `rest`.
 */
export function parseAnthropicChunk(buffer: string): { tokens: string[]; rest: string } {
    const tokens: string[] = [];
    const lastSep = buffer.lastIndexOf('\n\n');
    if (lastSep === -1) {
        return { tokens, rest: buffer };
    }
    const complete = buffer.slice(0, lastSep);
    const rest = buffer.slice(lastSep + 2);

    for (const block of complete.split('\n\n')) {
        for (const rawLine of block.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            if (!line.startsWith('data:')) continue; // ignore the event: line
            const payload = line.slice('data:'.length).replace(/^ /, '').trim();
            if (payload.length === 0) continue;
            let obj: Record<string, unknown>;
            try {
                obj = JSON.parse(payload) as Record<string, unknown>;
            } catch {
                continue; // tolerate non-JSON noise
            }
            if (obj['type'] !== 'content_block_delta') continue;
            const delta = obj['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] !== 'text_delta') continue;
            const text = typeof delta['text'] === 'string' ? (delta['text'] as string) : undefined;
            if (text && text.length > 0) tokens.push(text);
        }
    }
    return { tokens, rest };
}

// ── Ollama true streaming ───────────────────────────────────────────────────────

interface OllamaStreamOutcome {
    fullText: string;
    tokenCount: number;
}

/**
 * POST to Ollama with stream:true and pump each NDJSON content delta to
 * `onToken` as chunks arrive. Does NOT buffer the whole body — it reads
 * the response stream incrementally and parses line-by-line via
 * `parseOllamaChunk`.
 */
function streamOllama(
    cfg: LLMConfig,
    messages: ChatMessage[],
    onToken: TokenSink,
): Promise<OllamaStreamOutcome> {
    return new Promise((resolve, reject) => {
        const baseUrl = cfg.ollamaUrl?.replace(/\/$/, '') ?? 'http://localhost:11434';
        const target = new URL(`${baseUrl}/api/chat`);
        // RD-HLLM1 — pin ollama to loopback so a tampered ollamaUrl cannot be
        // used as an SSRF egress channel.
        const loopbackErr = loopbackUrlError(target.href);
        if (loopbackErr) {
            reject(new Error(`Blocked ollama URL (${target.href}): ${loopbackErr}`));
            return;
        }
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;

        const payload = JSON.stringify({
            model: cfg.model || 'llama3.2',
            messages,
            stream: true,
        });

        const req = lib.request(
            {
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: target.pathname + (target.search ?? ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 400) {
                    // Read the (small) error body for a useful message, then reject.
                    const errChunks: Buffer[] = [];
                    res.on('data', (c) => errChunks.push(c as Buffer));
                    res.on('end', () => {
                        const text = Buffer.concat(errChunks).toString('utf-8');
                        reject(new Error(`Ollama HTTP ${status}: ${text.slice(0, 400)}`));
                    });
                    res.on('error', reject);
                    return;
                }

                res.setEncoding('utf-8');
                let buffer = '';
                let fullText = '';
                let tokenCount = 0;

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const { tokens, rest } = parseOllamaChunk(buffer);
                    buffer = rest;
                    for (const tok of tokens) {
                        fullText += tok;
                        tokenCount += 1;
                        onToken(tok);
                    }
                });
                res.on('end', () => {
                    // Flush any trailing complete line left without a final newline.
                    if (buffer.trim().length > 0) {
                        const { tokens } = parseOllamaChunk(buffer + '\n');
                        for (const tok of tokens) {
                            fullText += tok;
                            tokenCount += 1;
                            onToken(tok);
                        }
                    }
                    resolve({ fullText, tokenCount });
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.setTimeout(120_000, () => {
            req.destroy();
            reject(new Error('Ollama stream timed out after 120s'));
        });
        req.write(payload);
        req.end();
    });
}

// ── Generic cloud SSE pump (OpenAI + Anthropic share this loop) ─────────────────

type CloudParser = (buffer: string) => { tokens: string[]; rest: string };

/**
 * Low-level POST → read an SSE response token-by-token, parsing each network
 * chunk with `parser` and pumping every content delta to `onToken`. This is
 * the cloud analogue of `streamOllama`: same incremental read loop, same
 * partial-line carry-over, same 120s timeout, just a different SSE shape.
 *
 * The endpoint base URL is taken from `baseUrlOverride` if provided, else the
 * `envOverride` env var, else `defaultBaseUrl`. The override seam lets a
 * spawned-daemon S-level test point the cloud branches at a local mock SSE
 * server without a real API call. `path` is appended to the resolved base.
 */
function streamCloudSse(opts: {
    baseUrl: string;
    path: string;
    headers: Record<string, string>;
    payload: string;
    parser: CloudParser;
    providerLabel: string;
    onToken: TokenSink;
}): Promise<OllamaStreamOutcome> {
    const { baseUrl, path: reqPath, headers, payload, parser, providerLabel, onToken } = opts;
    return new Promise((resolve, reject) => {
        const target = new URL(baseUrl.replace(/\/$/, '') + reqPath);
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;

        // RD-HLLM1/RD-HLLM2 — guard the (env-overridable) cloud base URL before
        // dialing out. A loopback host is the legitimate test-seam / local-proxy
        // case; anything else must be a safe cloud target (https, not
        // metadata/private) so an attacker-controlled ATLAS_*_BASE_URL cannot
        // turn this into an SSRF or exfiltrate the API key.
        const loopback = isLoopbackHost(target.hostname);
        if (!loopback) {
            const urlErr = cloudUrlError(target.href);
            if (urlErr) {
                reject(new Error(`Blocked URL (${target.href}): ${urlErr}`));
                return;
            }
        }
        // Never send the API key (in headers) over plaintext http to a
        // non-loopback host — that would leak the credential on the wire.
        const carriesSecret = Boolean(headers['Authorization'] || headers['x-api-key']);
        if (!isHttps && !loopback && carriesSecret) {
            reject(new PlaintextTokenError(target.hostname));
            return;
        }

        const req = lib.request(
            {
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: target.pathname + (target.search ?? ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...headers,
                },
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 400) {
                    const errChunks: Buffer[] = [];
                    res.on('data', (c) => errChunks.push(c as Buffer));
                    res.on('end', () => {
                        const text = Buffer.concat(errChunks).toString('utf-8');
                        reject(new Error(`${providerLabel} HTTP ${status}: ${text.slice(0, 400)}`));
                    });
                    res.on('error', reject);
                    return;
                }

                res.setEncoding('utf-8');
                let buffer = '';
                let fullText = '';
                let tokenCount = 0;

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const { tokens, rest } = parser(buffer);
                    buffer = rest;
                    for (const tok of tokens) {
                        fullText += tok;
                        tokenCount += 1;
                        onToken(tok);
                    }
                });
                res.on('end', () => {
                    // Flush any trailing complete block left without a final "\n\n".
                    if (buffer.trim().length > 0) {
                        const { tokens } = parser(buffer + '\n\n');
                        for (const tok of tokens) {
                            fullText += tok;
                            tokenCount += 1;
                            onToken(tok);
                        }
                    }
                    resolve({ fullText, tokenCount });
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.setTimeout(120_000, () => {
            req.destroy();
            reject(new Error(`${providerLabel} stream timed out after 120s`));
        });
        req.write(payload);
        req.end();
    });
}

/**
 * Resolve the cloud base URL: explicit env override (test seam) → default.
 * Mirrors the hard-coded literals in `llmChat.ts` but lets an offline test
 * redirect the request to a local mock server.
 */
function cloudBaseUrl(envVar: string, fallback: string): string {
    const v = (process.env[envVar] ?? '').trim();
    return v.length > 0 ? v : fallback;
}

// ── OpenAI true streaming ───────────────────────────────────────────────────────

/**
 * POST to OpenAI `/v1/chat/completions` with stream:true and pump each
 * `choices[0].delta.content` delta to `onToken` as chunks arrive. Auth via
 * `Authorization: Bearer <key>`. Model + key from `cfg`. Defaults mirror the
 * proven non-stream `callOpenAI` (model `gpt-4o-mini`, `max_tokens:1024`).
 */
function streamOpenAI(
    cfg: LLMConfig,
    messages: ChatMessage[],
    onToken: TokenSink,
): Promise<OllamaStreamOutcome> {
    if (!cfg.apiKey) throw new Error('OpenAI provider requires apiKey in Atlas LLM config.');

    const payload = JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages,
        max_tokens: 1024,
        stream: true,
    });

    return streamCloudSse({
        baseUrl: cloudBaseUrl('ATLAS_OPENAI_BASE_URL', 'https://api.openai.com'),
        path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        payload,
        parser: parseOpenAiChunk,
        providerLabel: 'OpenAI',
        onToken,
    });
}

// ── Anthropic true streaming ────────────────────────────────────────────────────

/**
 * POST to Anthropic `/v1/messages` with stream:true and pump each
 * `content_block_delta` text delta to `onToken`. Auth via `x-api-key` +
 * `anthropic-version: 2023-06-01`. The Anthropic wire keeps the system prompt
 * in a top-level `system` field (NOT in `messages`), so we split the leading
 * `system` turn out of `messages` and shape the rest as user/assistant turns.
 * Defaults mirror the non-stream `callAnthropic` (model `claude-haiku-4-5`,
 * `max_tokens:1024`).
 */
function streamAnthropic(
    cfg: LLMConfig,
    messages: ChatMessage[],
    onToken: TokenSink,
): Promise<OllamaStreamOutcome> {
    if (!cfg.apiKey) throw new Error('Anthropic provider requires apiKey in Atlas LLM config.');

    // Anthropic wants `system` at the top level, not as a message turn.
    const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
    const convo = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

    const payload = JSON.stringify({
        model: cfg.model || 'claude-haiku-4-5',
        max_tokens: 1024,
        ...(system.length > 0 ? { system } : {}),
        messages: convo,
        stream: true,
    });

    return streamCloudSse({
        baseUrl: cloudBaseUrl('ATLAS_ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        path: '/v1/messages',
        headers: {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
        },
        payload,
        parser: parseAnthropicChunk,
        providerLabel: 'Anthropic',
        onToken,
    });
}

// ── Fake provider (test hook) ───────────────────────────────────────────────────

/**
 * Deterministic fixed-token stream for tests. Enabled when
 * `process.env.ATLAS_LLM_FAKE_STREAM` is set (any non-empty value).
 * Lets `verify` prove the SSE egress streams INCREMENTALLY without a
 * live model: each token is emitted with a small delay so the reader
 * observes multiple frames over time, not one terminal blob.
 */
const FAKE_TOKENS = ['Hello', ' ', 'world', '!'];

export function fakeStreamEnabled(): boolean {
    return (process.env['ATLAS_LLM_FAKE_STREAM'] ?? '').trim().length > 0;
}

async function streamFake(onToken: TokenSink): Promise<OllamaStreamOutcome> {
    let fullText = '';
    for (const tok of FAKE_TOKENS) {
        await new Promise((r) => setTimeout(r, 15));
        fullText += tok;
        onToken(tok);
    }
    return { fullText, tokenCount: FAKE_TOKENS.length };
}

// ── Context consent (shared with runLLMChat) ────────────────────────────────────

/**
 * Apply the SAME cloud-context withholding + secret-redaction policy as
 * `runLLMChat`, so streaming does not become a context-exfil bypass.
 * Returns the (possibly context-stripped) input and whether context was
 * withheld from a cloud provider.
 */
function applyContextConsent(
    provider: LLMConfig['provider'],
    input: LLMChatInput,
): { effective: LLMChatInput; contextWithheld: boolean } {
    const isCloud = provider === 'openai' || provider === 'anthropic';
    if (!input.context || input.context.trim().length === 0) {
        return { effective: input, contextWithheld: false };
    }
    if (isCloud && !cloudContextAllowed()) {
        return { effective: { ...input, context: undefined }, contextWithheld: true };
    }
    return { effective: { ...input, context: sanitizeContext(input.context).text }, contextWithheld: false };
}

// ── Public entry point ──────────────────────────────────────────────────────────

/**
 * Stream a chat completion token-by-token to `onToken`, resolving when
 * complete. Throws on provider error.
 *
 * `messages` is optional: when omitted (or empty) the system/user prompt
 * is built from `input` using the SAME helpers as `runLLMChat`, so the
 * SSE route can be driven with just `{ query, context, toolLabel }`.
 * When `messages` IS supplied (already-shaped chat turns), it is used
 * verbatim and the consent layer is skipped (the caller owns redaction).
 *
 * Provider behavior:
 *   - ATLAS_LLM_FAKE_STREAM set → fixed fake token sequence (test hook).
 *   - ollama  → true token-by-token streaming.
 *   - openai/anthropic → true token-by-token streaming when an API key is
 *     configured; otherwise the non-streaming fallback (ONE token).
 *   - none / no cfg → passthrough, emitted as ONE token.
 */
export async function streamChat(
    cfg: LLMConfig | undefined,
    input: LLMChatInput,
    onToken: TokenSink,
    messages?: ChatMessage[],
    history?: ChatMessage[],
): Promise<StreamChatResult> {
    // Test hook: bypass all real providers entirely.
    if (fakeStreamEnabled()) {
        const out = await streamFake(onToken);
        return {
            fullText: out.fullText,
            tokenCount: out.tokenCount,
            provider: 'fake',
            model: 'fake',
            streamed: true,
        };
    }

    const provider = cfg?.provider ?? 'none';

    // provider=none or no config → passthrough as a single token.
    if (!cfg || provider === 'none') {
        const text = input.context ?? input.query;
        onToken(text);
        return { fullText: text, tokenCount: 1, provider: 'none', model: 'none', streamed: false };
    }

    // Build the chat turns. Honour caller-supplied messages verbatim;
    // otherwise construct them with the shared prompt builders + consent.
    let chatMessages: ChatMessage[];
    let contextWithheld = false;
    if (messages && messages.length > 0) {
        // RD-HLLM3 — caller-supplied messages must NOT bypass consent +
        // redaction. Cloud providers require explicit opt-in; either way the
        // content is run through the same secret-redaction/size-cap as the
        // normal path.
        const isCloud = provider === 'openai' || provider === 'anthropic';
        if (isCloud && !cloudContextAllowed()) {
            throw new Error('Cloud context not allowed — set ATLAS_LLM_ALLOW_CLOUD to use the messages override with a cloud provider');
        }
        chatMessages = messages.map((m) => ({
            ...m,
            content: sanitizeContext(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).text,
        }));
    } else {
        const { effective, contextWithheld: withheld } = applyContextConsent(provider, input);
        contextWithheld = withheld;
        // Fold prior conversation turns (user/assistant only) between the system
        // prompt and the current question, so follow-ups resolve against earlier
        // context. History content is redacted/size-capped like everything else.
        const priorTurns: ChatMessage[] = (history ?? [])
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
                role: m.role,
                content: sanitizeContext(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).text,
            }));
        chatMessages = [
            { role: 'system', content: buildSystemPrompt() },
            ...priorTurns,
            { role: 'user', content: buildUserMessage(effective) },
        ];
    }

    if (provider === 'ollama') {
        const out = await streamOllama(cfg, chatMessages, onToken);
        return {
            fullText: out.fullText,
            tokenCount: out.tokenCount,
            provider: 'ollama',
            model: cfg.model,
            streamed: true,
            contextWithheld,
        };
    }

    // Real SSE streaming for the cloud providers. Each drives the SAME
    // `onToken(deltaString)` callback as ollama, so `server.ts` re-frames the
    // tokens identically and the frontend reader needs ZERO change.
    //
    // Graceful fallback: if a cloud provider has no API key configured we keep
    // the proven non-streaming `runLLMChat` path (emitted as ONE token frame)
    // rather than crashing the stream. `streamOpenAI`/`streamAnthropic` throw
    // synchronously on a missing key, so we only attempt the stream when a key
    // is present.
    if (provider === 'openai' || provider === 'anthropic') {
        if (cfg.apiKey && cfg.apiKey.trim().length > 0) {
            const out = provider === 'openai'
                ? await streamOpenAI(cfg, chatMessages, onToken)
                : await streamAnthropic(cfg, chatMessages, onToken);
            return {
                fullText: out.fullText,
                tokenCount: out.tokenCount,
                provider,
                model: cfg.model,
                streamed: true,
                contextWithheld,
            };
        }
        // No key → non-streaming fallback (functional, not incremental).
        const result = await runLLMChat(cfg, input);
        const text = result.response;
        onToken(text);
        return {
            fullText: text,
            tokenCount: 1,
            provider: result.provider,
            model: result.model,
            streamed: false,
            contextWithheld: result.contextWithheld,
        };
    }

    // Unknown provider — passthrough.
    const text = input.context ?? input.query;
    onToken(text);
    return { fullText: text, tokenCount: 1, provider, model: cfg.model, streamed: false };
}
