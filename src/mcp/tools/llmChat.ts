/**
 * mcp/tools/llmChat.ts — LLM bridge for Atlas.
 *
 * Supports four providers:
 *   - ollama    : local, no key required. POST /api/chat (OpenAI-compat format)
 *   - openai    : cloud, requires apiKey. POST /v1/chat/completions
 *   - anthropic : cloud, requires apiKey. POST /v1/messages
 *   - none      : passthrough — returns atlasContext as-is (no LLM call)
 *
 * All LLM calls are made server-side (in the Atlas daemon) so:
 *   - API keys never touch the browser
 *   - CORS is not an issue
 *   - The UI calls llm_chat via the MCP shim like any other Atlas tool
 *
 * System prompt design:
 *   Atlas is positioned as a codebase intelligence assistant.
 *   The atlas tool result becomes "context" — the LLM synthesises it
 *   into a clear, actionable insight for the developer.
 */

import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import { loadConfig, type LLMConfig } from '../../config.js';
import { scrubSecrets } from '../../security/secretScrub.js';
import { cloudUrlError, isLoopbackHost, loopbackUrlError, PlaintextTokenError } from '../../httpTransport.js';

export interface LLMChatInput {
    query: string;
    /** Raw Atlas tool result — stringified JSON or plain text. */
    context?: string;
    /** Human-readable label for the tool used, e.g. "knowledge_recall". */
    toolLabel?: string;
}

/**
 * Token usage for one llm_chat call, normalized across providers so an
 * embedding host can meter spend without knowing which backend answered.
 *
 * ABSENT, NOT ZERO, when there is nothing to bill or nothing reported:
 * provider 'none' (passthrough — no model ran) and any provider whose response
 * carried no usage block leave this undefined. A caller summing costs must
 * treat `undefined` as "no data" rather than "free", because those are
 * different things — local Ollama is genuinely free, a missing usage block on a
 * cloud call is a gap. `source` says which it was.
 */
export interface LLMUsage {
    /** Prompt/input tokens. */
    inputTokens?: number;
    /** Completion/output tokens. */
    outputTokens?: number;
    /** Provider-reported total when given; otherwise input+output if both known. */
    totalTokens?: number;
    /**
     * Where the numbers came from:
     *  - 'provider' — the backend reported them (bill against these)
     *  - 'none'     — no model call happened (passthrough); nothing to bill
     *  - 'absent'   — a model call happened but reported no usage block
     */
    source: 'provider' | 'none' | 'absent';
}

export interface LLMChatResult {
    response: string;
    provider: string;
    model: string;
    /** true when the provider is 'none' — context returned verbatim */
    passthrough?: boolean;
    /** true when repo/knowledge context was withheld from a cloud provider
     *  because ATLAS_LLM_ALLOW_CLOUD was not set (review #9). */
    contextWithheld?: boolean;
    /** Token usage for metering. See LLMUsage — absent ≠ zero. */
    usage?: LLMUsage;
}

/** What a provider call returns: the text plus whatever usage it reported. */
interface ProviderReply {
    text: string;
    usage: LLMUsage;
}

/** Read a numeric field, ignoring anything non-finite a provider might send. */
function num(o: Record<string, unknown> | undefined, k: string): number | undefined {
    const v = o?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize a provider usage block. Each backend names these differently:
 *   OpenAI    — usage.prompt_tokens / completion_tokens / total_tokens
 *   Anthropic — usage.input_tokens / output_tokens (no total; we derive it)
 *   Ollama    — top-level prompt_eval_count / eval_count (no total)
 * Returns source:'absent' when the block is missing entirely, so a caller can
 * tell "reported nothing" from "reported zero".
 */
export function normalizeUsage(input: number | undefined, output: number | undefined, total?: number): LLMUsage {
    if (input === undefined && output === undefined && total === undefined) {
        return { source: 'absent' };
    }
    const derived = total ?? (input !== undefined && output !== undefined ? input + output : undefined);
    return {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        ...(derived !== undefined ? { totalTokens: derived } : {}),
        source: 'provider',
    };
}

// ── System prompt ─────────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
    return [
        'You are Groundfloor Atlas, an AI assistant embedded in a developer knowledge graph tool.',
        'You have access to a developer\'s codebase intelligence: architecture decisions,',
        'code structure, bug patterns, conventions, and project history.',
        '',
        'Guidelines:',
        '- Answer the developer\'s question directly in the first sentence, then support it.',
        '- Be concise and actionable. Developers want answers, not essays.',
        '- When the context contains a tool summary or exact figures (counts, node/edge',
        '  totals, breakdowns), quote those numbers EXACTLY and preserve their labels —',
        '  never relabel a total as a subtotal (e.g. do not call the total node count the',
        '  "knowledge node" count) and never invent a figure that is not in the context.',
        '- If the context lists specific items (decisions, bug patterns, hits), enumerate',
        '  the actual items rather than giving generic advice about the topic.',
        '- Reference specific files, symbols, or node IDs from the context when relevant.',
        '- If the context shows a decision or convention, explain its intent.',
        '- If the context shows code structure (call graphs, dead code, hotspots), give clear next steps.',
        '- If the context is empty or unhelpful, say so honestly and suggest a better query.',
        '- Do not hallucinate file names, function names, or decisions that are not in the context.',
    ].join('\n');
}

export function buildUserMessage(input: LLMChatInput): string {
    const parts: string[] = [];
    parts.push(`Developer question: ${input.query}`);
    if (input.context && input.context.trim().length > 0) {
        const label = input.toolLabel ?? 'Groundfloor Atlas tool';
        parts.push('');
        parts.push(`Context retrieved by ${label}:`);
        parts.push('```json');
        parts.push(input.context.trim());
        parts.push('```');
        parts.push('');
        parts.push('Answer the question directly and specifically using this context. Lead with the');
        parts.push('answer. If the context contains exact counts or a list of items, quote the numbers');
        parts.push('verbatim and enumerate the actual items — do not give generic advice.');
    } else {
        parts.push('');
        parts.push('No specific context was retrieved. Answer based on general codebase intelligence principles.');
    }
    return parts.join('\n');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function postJSON(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const payload = JSON.stringify(body);

        // RD-HLLM1 — guard egress before dialing out. Loopback is the local
        // (ollama / test mock) case; any other host must be a safe cloud
        // target (https, not metadata/private) so a tampered URL cannot become
        // an SSRF or leak the API key.
        const loopback = isLoopbackHost(u.hostname);
        if (!loopback) {
            const urlErr = cloudUrlError(u.href);
            if (urlErr) {
                reject(new Error(`Blocked URL (${u.href}): ${urlErr}`));
                return;
            }
        }
        const carriesSecret = Boolean(headers['Authorization'] || headers['x-api-key']);
        if (!isHttps && !loopback && carriesSecret) {
            reject(new PlaintextTokenError(u.hostname));
            return;
        }

        const req = lib.request(
            {
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: u.pathname + (u.search ?? ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...headers,
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c as Buffer));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(new Error(`HTTP ${res.statusCode ?? '?'}: ${text.slice(0, 400)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        resolve(text);
                    }
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.setTimeout(60_000, () => { req.destroy(); reject(new Error('LLM request timed out after 60s')); });
        req.write(payload);
        req.end();
    });
}

// ── Provider implementations ──────────────────────────────────────────────────

async function callOllama(cfg: LLMConfig, system: string, user: string): Promise<ProviderReply> {
    const baseUrl = cfg.ollamaUrl?.replace(/\/$/, '') ?? 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;
    // PF-2 / RD-HLLM1 — pin ollama egress to loopback at USE time, mirroring
    // streamChat.streamOllama. The non-streaming path previously relied only on
    // postJSON's generic cloudUrlError gate, which permits any https non-private
    // host — so an out-of-band-edited ollamaUrl could exfiltrate (un-withheld)
    // ollama-provider context to an attacker. Block it before dialing out.
    const loopbackErr = loopbackUrlError(url);
    if (loopbackErr) {
        throw new Error(`Blocked ollama URL (${url}): ${loopbackErr}`);
    }

    const body = {
        model: cfg.model || 'llama3.2',
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        stream: false,
    };

    const data = await postJSON(url, body, {}) as Record<string, unknown>;
    const message = data['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (typeof content === 'string') {
        // Ollama reports counts at the TOP level, not under `usage`.
        return { text: content, usage: normalizeUsage(num(data, 'prompt_eval_count'), num(data, 'eval_count')) };
    }
    throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
}

async function callOpenAI(cfg: LLMConfig, system: string, user: string): Promise<ProviderReply> {
    if (!cfg.apiKey) throw new Error('OpenAI provider requires apiKey in Atlas LLM config.');

    const body = {
        model: cfg.model || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        max_tokens: 1024,
    };

    const data = await postJSON(
        'https://api.openai.com/v1/chat/completions',
        body,
        { Authorization: `Bearer ${cfg.apiKey}` },
    ) as Record<string, unknown>;

    const choices = data['choices'] as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.['message'] as Record<string, unknown> | undefined;
    const content = msg?.['content'];
    if (typeof content === 'string') {
        const u = data['usage'] as Record<string, unknown> | undefined;
        return { text: content, usage: normalizeUsage(num(u, 'prompt_tokens'), num(u, 'completion_tokens'), num(u, 'total_tokens')) };
    }
    throw new Error(`Unexpected OpenAI response shape: ${JSON.stringify(data).slice(0, 200)}`);
}

async function callAnthropic(cfg: LLMConfig, system: string, user: string): Promise<ProviderReply> {
    if (!cfg.apiKey) throw new Error('Anthropic provider requires apiKey in Atlas LLM config.');

    const body = {
        model: cfg.model || 'claude-haiku-4-5',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
    };

    const data = await postJSON(
        'https://api.anthropic.com/v1/messages',
        body,
        {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
        },
    ) as Record<string, unknown>;

    const contentArr = data['content'] as Array<Record<string, unknown>> | undefined;
    const first = contentArr?.[0];
    if (first?.['type'] === 'text' && typeof first['text'] === 'string') {
        // Anthropic reports input/output only — no total; normalizeUsage derives it.
        const u = data['usage'] as Record<string, unknown> | undefined;
        return { text: first['text'], usage: normalizeUsage(num(u, 'input_tokens'), num(u, 'output_tokens')) };
    }
    throw new Error(`Unexpected Anthropic response shape: ${JSON.stringify(data).slice(0, 200)}`);
}

// ── Consent + redaction (review #9) ────────────────────────────────────────────

/** Hard cap on context shipped to any LLM — bounds cost + exfil surface. */
const MAX_CONTEXT_CHARS = 60_000;

/**
 * The pattern set moved to security/secretScrub.ts so the WRITE path can share
 * it — it was egress-only for a long time, which meant secrets were scrubbed on
 * the way to an LLM but memorized verbatim into the graph. sanitizeContext is
 * now just scrubSecrets + this module's size cap.
 */
export function sanitizeContext(context: string): { text: string; truncated: boolean; redacted: boolean } {
    const scrubbed = scrubSecrets(context);
    let text = scrubbed.text;
    const redacted = scrubbed.redacted;
    let truncated = false;
    if (text.length > MAX_CONTEXT_CHARS) {
        text = text.slice(0, MAX_CONTEXT_CHARS) + '\n…[context truncated by Atlas]';
        truncated = true;
    }
    return { text, truncated, redacted };
}

/** Operator must explicitly opt in before repo/knowledge context is sent
 *  to a CLOUD provider. Local Ollama (loopback) is always allowed.
 *
 *  Consent sources, in precedence order:
 *    1. ATLAS_LLM_ALLOW_CLOUD env var — explicit operator override in EITHER
 *       direction ('1'/'true'/'yes' forces on; '0'/'false'/'no' forces off).
 *       Kept so a deployment can pin the policy regardless of UI clicks.
 *    2. The persisted Settings toggle (config.json llm.allowCloudContext) —
 *       what normal users set through the UI / llm_config_set.
 *  Neither set → false (withhold), the safe default. */
export function cloudContextAllowed(): boolean {
    const v = (process.env['ATLAS_LLM_ALLOW_CLOUD'] ?? '').trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    try {
        return loadConfig().llm?.allowCloudContext === true;
    } catch {
        return false; // unreadable config → fail closed
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runLLMChat(
    cfg: LLMConfig | undefined,
    input: LLMChatInput,
): Promise<LLMChatResult> {
    // No config or provider=none → return context verbatim
    if (!cfg || cfg.provider === 'none') {
        const passthrough = input.context ?? input.query;
        return {
            response: passthrough,
            provider: 'none',
            model: 'none',
            passthrough: true,
            // No model ran, so there is nothing to bill. Explicit 'none' rather
            // than an omitted field, so a metering caller can distinguish this
            // from a provider that simply failed to report usage.
            usage: { source: 'none' },
        };
    }

    // #9: redact secrets + cap size; withhold context from cloud providers
    // unless the operator explicitly opted in via ATLAS_LLM_ALLOW_CLOUD.
    const isCloud = cfg.provider === 'openai' || cfg.provider === 'anthropic';
    let contextWithheld = false;
    let effectiveInput = input;
    if (input.context && input.context.trim().length > 0) {
        if (isCloud && !cloudContextAllowed()) {
            effectiveInput = { ...input, context: undefined };
            contextWithheld = true;
        } else {
            effectiveInput = { ...input, context: sanitizeContext(input.context).text };
        }
    }

    const system = buildSystemPrompt();
    const user = buildUserMessage(effectiveInput);

    let reply: ProviderReply;
    switch (cfg.provider) {
        case 'ollama':
            reply = await callOllama(cfg, system, user);
            break;
        case 'openai':
            reply = await callOpenAI(cfg, system, user);
            break;
        case 'anthropic':
            reply = await callAnthropic(cfg, system, user);
            break;
        default:
            // Unknown provider → passthrough, same as 'none': no model ran.
            reply = { text: input.context ?? input.query, usage: { source: 'none' } };
    }

    return { response: reply.text, provider: cfg.provider, model: cfg.model, contextWithheld, usage: reply.usage };
}
