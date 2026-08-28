/**
 * tests/b3a-stream.test.ts — B3a server-side LLM streaming.
 *
 * Two layers, both runnable without a live model:
 *
 *   U1 (pure parser): parseOllamaChunk handles split chunks, multi-line
 *       chunks, /api/chat vs /api/generate delta shapes, the terminal
 *       done:true line (no token), and partial-line carry-over.
 *
 *   S1 (SSE egress): spawn `atlas serve`, POST /api/chat/stream with the
 *       ATLAS_LLM_FAKE_STREAM hook set so the daemon streams a fixed token
 *       sequence WITHOUT a live model. Assert the response is
 *       text/event-stream, that token frames arrive INCREMENTALLY (more
 *       than one read, frames spread over time), and that a final
 *       done:true frame carries the full text.
 *
 *   S2 (auth reuse): POST /api/chat/stream with no/invalid token → 401,
 *       proving the route reuses the same bearer guard as /mcp.
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOllamaChunk } from '../src/llm/streamChat.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

function makeAtlasHome(port: number): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b3a-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }, null, 2));
    return home;
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`);
            if (r.ok) {
                const body = (await r.json()) as { status?: string };
                if (body.status === 'ok') return;
            }
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`daemon never became healthy on port ${port}: ${String(lastErr)}`);
}

/* ─── U1: pure NDJSON parser ─────────────────────────────────────── */

function testU1_parseOllamaChunk(): void {
    // Single complete /api/chat line → one token, no remainder.
    {
        const { tokens, rest } = parseOllamaChunk('{"message":{"content":"Hel"},"done":false}\n');
        assert.deepEqual(tokens, ['Hel']);
        assert.equal(rest, '');
    }
    // Partial line held back as `rest`.
    {
        const { tokens, rest } = parseOllamaChunk('{"message":{"content":"Hel"');
        assert.deepEqual(tokens, []);
        assert.equal(rest, '{"message":{"content":"Hel"');
    }
    // Split across two chunks: rest of chunk 1 prepended to chunk 2.
    // chunk 1 ends mid-token ("Hel) so its closing quote arrives in chunk 2.
    {
        const a = parseOllamaChunk('{"message":{"content":"Hel');
        const b = parseOllamaChunk(a.rest + '"},"done":false}\n{"message":{"content":"lo"},"done":false}\n');
        assert.deepEqual(b.tokens, ['Hel', 'lo']);
        assert.equal(b.rest, '');
    }
    // /api/generate shape ({response}) also yields a token.
    {
        const { tokens } = parseOllamaChunk('{"response":"world","done":false}\n');
        assert.deepEqual(tokens, ['world']);
    }
    // Terminal done:true line carries no content delta → no token.
    {
        const { tokens } = parseOllamaChunk('{"message":{"content":""},"done":true}\n');
        assert.deepEqual(tokens, []);
    }
    // Blank + unparseable lines are skipped, valid ones pass through.
    {
        const { tokens } = parseOllamaChunk('\nnot-json\n{"message":{"content":"ok"},"done":false}\n');
        assert.deepEqual(tokens, ['ok']);
    }
    console.log('  ✓ U1: parseOllamaChunk — split/multi-line/generate/done/noise');
}

/* ─── SSE reader helper ──────────────────────────────────────────── */

interface SseObservation {
    contentType: string | null;
    frames: unknown[];
    readCount: number; // how many separate stream reads delivered data
}

async function readSse(res: Response): Promise<SseObservation> {
    const contentType = res.headers.get('content-type');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: unknown[] = [];
    let readCount = 0;

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) readCount += 1;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = block.split('\n').find((l) => l.startsWith('data:'));
            if (line) frames.push(JSON.parse(line.slice('data:'.length).trim()));
        }
    }
    return { contentType, frames, readCount };
}

/* ─── S1: SSE egress streams incrementally (fake provider) ───────── */

async function testS1_sseStreamsIncrementally(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home, ATLAS_LLM_FAKE_STREAM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);
        const token = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ query: 'hi' }),
        });
        assert.equal(res.status, 200, `expected 200; got ${res.status}`);
        assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'),
            `expected text/event-stream; got ${res.headers.get('content-type')}`);

        const obs = await readSse(res);
        const tokenFrames = obs.frames.filter((f): f is { token: string } =>
            typeof (f as { token?: unknown }).token === 'string');
        const doneFrame = obs.frames.find((f): f is { done: true; fullText: string } =>
            (f as { done?: unknown }).done === true);

        // The fake provider emits 4 token frames + 1 done frame.
        assert.equal(tokenFrames.length, 4, `expected 4 token frames; got ${tokenFrames.length}`);
        assert.ok(doneFrame, 'expected a done:true frame');
        assert.equal(doneFrame!.fullText, 'Hello world!', `fullText mismatch; got ${doneFrame!.fullText}`);
        // Incremental: tokens arrived over multiple reads, not one terminal blob.
        assert.ok(obs.readCount > 1, `expected multiple incremental reads; got ${obs.readCount}`);

        console.log('  ✓ S1: /api/chat/stream streams 4 tokens incrementally + done frame');
    } finally {
        child.kill('SIGTERM');
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
    }
}

/* ─── S2: route reuses the /mcp bearer auth guard ────────────────── */

async function testS2_streamAuthGate(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);
        const url = `http://127.0.0.1:${port}/api/chat/stream`;
        const headers = { 'Content-Type': 'application/json' };
        const body = JSON.stringify({ query: 'hi' });

        const noTok = await fetch(url, { method: 'POST', headers, body });
        assert.equal(noTok.status, 401, `no-token stream POST should be 401; got ${noTok.status}`);

        const badTok = await fetch(url, {
            method: 'POST',
            headers: { ...headers, Authorization: 'Bearer not-the-real-token' },
            body,
        });
        assert.equal(badTok.status, 401, `bad-token stream POST should be 401; got ${badTok.status}`);

        console.log('  ✓ S2: /api/chat/stream reuses bearer guard (401 no-token, 401 bad-token)');
    } finally {
        child.kill('SIGTERM');
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
    }
}

async function main(): Promise<void> {
    console.log('B3a — server-side LLM streaming');
    testU1_parseOllamaChunk();
    await testS1_sseStreamsIncrementally();
    await testS2_streamAuthGate();
    console.log('B3a: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
