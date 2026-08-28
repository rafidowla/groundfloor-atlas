/**
 * tests/b3a-cloud-stream.test.ts — B3a real cloud streaming (OpenAI + Anthropic).
 *
 * Two offline layers, NO real API calls:
 *
 *   U2/U3 (pure parsers): parseOpenAiChunk + parseAnthropicChunk turn canned
 *       provider SSE bytes into the UNIFIED token sequence, skipping non-text
 *       events ([DONE], role-only delta, message_start/stop, ping, …) and
 *       carrying split frames via `rest`. Mirrors `testU1_parseOllamaChunk`.
 *
 *   S3/S4 (mock-server e2e): a local http server replays canned provider SSE
 *       bytes; the cloud branches are pointed at it via the
 *       ATLAS_OPENAI_BASE_URL / ATLAS_ANTHROPIC_BASE_URL override seam, and
 *       `streamChat()` is driven end-to-end. Asserts: tokens pump
 *       incrementally into `onToken`, the request carries the right auth
 *       (Bearer for OpenAI; x-api-key + anthropic-version for Anthropic),
 *       `stream:true` is set, Anthropic splits `system` to the top level, and
 *       the no-key path gracefully falls back instead of crashing.
 */

import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseOpenAiChunk, parseAnthropicChunk, streamChat } from '../src/llm/streamChat.js';
import type { LLMConfig } from '../src/config.js';

/* ─── U2: OpenAI SSE parser ──────────────────────────────────────── */

function testU2_parseOpenAiChunk(): void {
    // Full canned stream: role-only first delta → 2 content deltas → [DONE].
    {
        const sse =
            'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
            'data: [DONE]\n\n';
        const { tokens, rest } = parseOpenAiChunk(sse);
        assert.deepEqual(tokens, ['Hel', 'lo']);
        assert.equal(rest, '');
    }
    // Role-only first frame yields no token (delta has no `content`).
    {
        const { tokens } = parseOpenAiChunk('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
        assert.deepEqual(tokens, []);
    }
    // [DONE] sentinel yields no token (HTTP end resolves the stream).
    {
        const { tokens } = parseOpenAiChunk('data: [DONE]\n\n');
        assert.deepEqual(tokens, []);
    }
    // Partial frame (cut mid-payload) is held back as `rest`, no token yet.
    {
        const { tokens, rest } = parseOpenAiChunk('data: {"choices":[{"delta":{"content":"Hel');
        assert.deepEqual(tokens, []);
        assert.equal(rest, 'data: {"choices":[{"delta":{"content":"Hel');
    }
    // Split across two chunks: rest of chunk 1 prepended to chunk 2 recovers it.
    {
        const a = parseOpenAiChunk('data: {"choices":[{"delta":{"content":"Hel');
        const b = parseOpenAiChunk(
            a.rest +
            '"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        );
        assert.deepEqual(b.tokens, ['Hel', 'lo']);
        assert.equal(b.rest, '');
    }
    // Blank + non-JSON `data:` lines skipped; valid content passes through.
    {
        const { tokens } = parseOpenAiChunk(
            '\n\n' +
            'data: not-json\n\n' +
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        );
        assert.deepEqual(tokens, ['ok']);
    }
    console.log('  ✓ U2: parseOpenAiChunk — content deltas / role-only / [DONE] / split / noise');
}

/* ─── U3: Anthropic SSE parser ───────────────────────────────────── */

function testU3_parseAnthropicChunk(): void {
    // Full canned stream: lifecycle events around 2 text deltas.
    {
        const sse =
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        const { tokens, rest } = parseAnthropicChunk(sse);
        assert.deepEqual(tokens, ['Hel', 'lo']);
        assert.equal(rest, '');
    }
    // Non-text events yield no tokens (lifecycle + ping).
    {
        const { tokens } = parseAnthropicChunk(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n' +
            'event: ping\ndata: {"type":"ping"}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        );
        assert.deepEqual(tokens, []);
    }
    // A content_block_delta whose delta is NOT text_delta yields no token.
    {
        const { tokens } = parseAnthropicChunk(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\n',
        );
        assert.deepEqual(tokens, []);
    }
    // Partial frame (cut mid-payload) is held back as `rest`, no token yet.
    {
        const { tokens, rest } = parseAnthropicChunk(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
        );
        assert.deepEqual(tokens, []);
        assert.ok(rest.endsWith('"text":"Hel'), `expected partial held in rest; got ${rest}`);
    }
    // Split across two chunks recovers the token once completed.
    {
        const a = parseAnthropicChunk(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
        );
        const b = parseAnthropicChunk(
            a.rest +
            '"}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
        );
        assert.deepEqual(b.tokens, ['Hel', 'lo']);
        assert.equal(b.rest, '');
    }
    // Blank + non-JSON `data:` lines skipped; valid text_delta passes through.
    {
        const { tokens } = parseAnthropicChunk(
            '\n\n' +
            'data: not-json\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        );
        assert.deepEqual(tokens, ['ok']);
    }
    console.log('  ✓ U3: parseAnthropicChunk — text deltas only / lifecycle skipped / split / noise');
}

/* ─── Mock SSE server (replays canned provider bytes) ────────────── */

interface CapturedRequest {
    path: string;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

/**
 * Spin up a local http server that, on POST, captures the request, then
 * streams `sseBytes` back in small slices (to force incremental reads) with a
 * tiny inter-slice delay. Returns the base URL, a promise of the captured
 * request, and a close fn. No TLS — the override seam points at http://.
 */
function startMockSse(sseBytes: string): Promise<{
    baseUrl: string;
    captured: Promise<CapturedRequest>;
    close: () => Promise<void>;
}> {
    return new Promise((resolveServer) => {
        let resolveCapture!: (r: CapturedRequest) => void;
        const captured = new Promise<CapturedRequest>((r) => { resolveCapture = r; });

        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c as Buffer));
            req.on('end', () => {
                let body: unknown;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
                catch { body = null; }
                resolveCapture({ path: req.url ?? '', headers: req.headers, body });

                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                // Slice into ~24-char pieces so the client reads incrementally.
                const slices: string[] = [];
                for (let i = 0; i < sseBytes.length; i += 24) slices.push(sseBytes.slice(i, i + 24));
                let i = 0;
                const pump = (): void => {
                    if (i >= slices.length) { res.end(); return; }
                    res.write(slices[i++]);
                    setTimeout(pump, 5);
                };
                pump();
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolveServer({
                baseUrl: `http://127.0.0.1:${port}`,
                captured,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

/* ─── S3: OpenAI end-to-end via mock server ──────────────────────── */

async function testS3_openAiStreamE2E(): Promise<void> {
    const sse =
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
        'data: [DONE]\n\n';
    const mock = await startMockSse(sse);
    const prev = process.env['ATLAS_OPENAI_BASE_URL'];
    process.env['ATLAS_OPENAI_BASE_URL'] = mock.baseUrl;
    try {
        const cfg: LLMConfig = { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test-123' };
        const seen: string[] = [];
        const result = await streamChat(cfg, { query: 'hi' }, (t) => seen.push(t));

        assert.deepEqual(seen, ['Hel', 'lo', ' world'], `tokens streamed wrong; got ${JSON.stringify(seen)}`);
        assert.equal(result.fullText, 'Hello world');
        assert.equal(result.streamed, true, 'openai should report streamed:true');
        assert.equal(result.provider, 'openai');
        assert.ok(seen.length > 1, 'expected multiple incremental onToken calls');

        const req = await mock.captured;
        assert.equal(req.path, '/v1/chat/completions', `bad path: ${req.path}`);
        assert.equal(req.headers['authorization'], 'Bearer sk-test-123', 'missing/incorrect Bearer auth');
        const body = req.body as Record<string, unknown>;
        assert.equal(body['stream'], true, 'request body must set stream:true');
        assert.equal(body['model'], 'gpt-4o-mini');

        console.log('  ✓ S3: streamChat(openai) e2e — incremental tokens, Bearer auth, stream:true');
    } finally {
        process.env['ATLAS_OPENAI_BASE_URL'] = prev;
        if (prev === undefined) delete process.env['ATLAS_OPENAI_BASE_URL'];
        await mock.close();
    }
}

/* ─── S4: Anthropic end-to-end via mock server ───────────────────── */

async function testS4_anthropicStreamE2E(): Promise<void> {
    const sse =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const mock = await startMockSse(sse);
    const prev = process.env['ATLAS_ANTHROPIC_BASE_URL'];
    process.env['ATLAS_ANTHROPIC_BASE_URL'] = mock.baseUrl;
    // The messages-override + cloud-provider path fail-closes unless cloud
    // context is consented (security #9 / RD-HLLM3). Opt in for the e2e.
    const prevAllowCloud = process.env['ATLAS_LLM_ALLOW_CLOUD'];
    process.env['ATLAS_LLM_ALLOW_CLOUD'] = '1';
    try {
        const cfg: LLMConfig = { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test-456' };
        const seen: string[] = [];
        // Drive with explicit messages so we can assert the system split.
        const result = await streamChat(
            cfg,
            { query: 'hi' },
            (t) => seen.push(t),
            [
                { role: 'system', content: 'You are Atlas.' },
                { role: 'user', content: 'hi' },
            ],
        );

        assert.deepEqual(seen, ['Hel', 'lo'], `tokens streamed wrong; got ${JSON.stringify(seen)}`);
        assert.equal(result.fullText, 'Hello');
        assert.equal(result.streamed, true, 'anthropic should report streamed:true');
        assert.equal(result.provider, 'anthropic');
        assert.ok(seen.length > 1, 'expected multiple incremental onToken calls');

        const req = await mock.captured;
        assert.equal(req.path, '/v1/messages', `bad path: ${req.path}`);
        assert.equal(req.headers['x-api-key'], 'sk-ant-test-456', 'missing/incorrect x-api-key');
        assert.equal(req.headers['anthropic-version'], '2023-06-01', 'missing anthropic-version header');
        const body = req.body as Record<string, unknown>;
        assert.equal(body['stream'], true, 'request body must set stream:true');
        assert.equal(body['system'], 'You are Atlas.', 'system prompt must be split to top-level field');
        const msgs = body['messages'] as Array<Record<string, unknown>>;
        assert.ok(msgs.every((m) => m['role'] !== 'system'), 'system turn must NOT remain in messages[]');

        console.log('  ✓ S4: streamChat(anthropic) e2e — incremental tokens, x-api-key, system split, stream:true');
    } finally {
        process.env['ATLAS_ANTHROPIC_BASE_URL'] = prev;
        if (prev === undefined) delete process.env['ATLAS_ANTHROPIC_BASE_URL'];
        process.env['ATLAS_LLM_ALLOW_CLOUD'] = prevAllowCloud;
        if (prevAllowCloud === undefined) delete process.env['ATLAS_LLM_ALLOW_CLOUD'];
        await mock.close();
    }
}

/* ─── S4b: messages-override + cloud provider fail-closes w/o consent ─ */

async function testS4b_cloudContextRequiresConsent(): Promise<void> {
    // Mirror S4 but assert the fail-closed guard: a cloud provider + explicit
    // messages override WITHOUT ATLAS_LLM_ALLOW_CLOUD must throw, never stream.
    const prevAllowCloud = process.env['ATLAS_LLM_ALLOW_CLOUD'];
    delete process.env['ATLAS_LLM_ALLOW_CLOUD'];
    try {
        const cfg: LLMConfig = { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test-456' };
        let threw: Error | null = null;
        try {
            await streamChat(
                cfg,
                { query: 'hi' },
                () => { /* no tokens expected */ },
                [
                    { role: 'system', content: 'You are Atlas.' },
                    { role: 'user', content: 'hi' },
                ],
            );
        } catch (err) {
            threw = err as Error;
        }
        assert.ok(threw, 'expected the cloud-consent guard to throw without ATLAS_LLM_ALLOW_CLOUD');
        assert.match(threw!.message, /ATLAS_LLM_ALLOW_CLOUD/i, `unexpected error: ${threw!.message}`);
        console.log('  ✓ S4b: messages-override + cloud provider fail-closes without ATLAS_LLM_ALLOW_CLOUD');
    } finally {
        process.env['ATLAS_LLM_ALLOW_CLOUD'] = prevAllowCloud;
        if (prevAllowCloud === undefined) delete process.env['ATLAS_LLM_ALLOW_CLOUD'];
    }
}

/* ─── S5: no-key cloud provider falls back gracefully ────────────── */

async function testS5_noKeyFallback(): Promise<void> {
    // No apiKey → must NOT crash; falls back to the non-stream path. With
    // provider=openai and no key, runLLMChat would throw on a real call, but
    // the fallback only runs when there IS no key AND context allows — here we
    // assert streamChat does not attempt a real stream (streamed:false) and
    // surfaces the buffered path. We give it no context so runLLMChat builds a
    // prompt and would try OpenAI; instead we assert the guard short-circuits
    // to the buffered branch by catching its key error (proving we did NOT
    // silently stream). The contract: no crash before the buffered call.
    const cfg: LLMConfig = { provider: 'openai', model: 'gpt-4o-mini' /* no apiKey */ };
    let threw: Error | null = null;
    try {
        await streamChat(cfg, { query: 'hi' }, () => { /* no tokens expected */ });
    } catch (err) {
        threw = err as Error;
    }
    // The buffered fallback (runLLMChat → callOpenAI) requires a key and throws
    // a CLEAR config error rather than an unhandled stream crash. That proves
    // the dispatch chose the fallback branch, not streamOpenAI.
    assert.ok(threw, 'expected the buffered fallback to surface a key error');
    assert.match(threw!.message, /requires apiKey/i, `unexpected error: ${threw!.message}`);
    console.log('  ✓ S5: no-key cloud provider takes buffered fallback (no stream crash)');
}

async function main(): Promise<void> {
    console.log('B3a — real cloud (OpenAI + Anthropic) streaming');
    testU2_parseOpenAiChunk();
    testU3_parseAnthropicChunk();
    await testS3_openAiStreamE2E();
    await testS4_anthropicStreamE2E();
    await testS4b_cloudContextRequiresConsent();
    await testS5_noKeyFallback();
    console.log('B3a-cloud: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
