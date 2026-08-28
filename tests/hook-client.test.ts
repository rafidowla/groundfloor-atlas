/**
 * tests/hook-client.test.ts — scripts/atlas-hook.mjs sends the daemon bearer
 * and ANNOUNCES (once per session) when it is rejected, instead of going
 * silently inert.
 *
 * Regression: the daemon put /hooks/context behind the same enforceMcpAuth
 * bearer gate as /mcp, but the hook client sent no Authorization header. The
 * 401 body parsed as JSON with no additionalContext, so the client emitted
 * nothing and exited 0 — indistinguishable from "healthy but quiet". Every
 * wired project ran with inert hooks (no blast-radius / search / commit
 * context) with zero indication, while the authenticated MCP path kept
 * working — so nothing looked wrong.
 *
 * Every claim here asserts on the ACTUAL stdout/exit of a spawned hook
 * process, not on internal state — a test that passes when the hook emits
 * nothing would be the same defect one level up.
 *
 *   CLAIM A — ATLAS_MCP_TOKEN env reaches the daemon as `Bearer <token>`;
 *             healthy context flows to stdout as hookSpecificOutput JSON.
 *   CLAIM B — token falls back to <ATLAS_HOME>/mcp.token (trimmed), the same
 *             file config.ts readMcpAuthToken reads. No second credential path.
 *   CLAIM C — no token anywhere → NO Authorization header (auth-off daemon
 *             still works); healthy-but-empty context stays QUIET (stdout '').
 *   CLAIM D — 401 → warning on stdout EXACTLY ONCE per session (repeat calls
 *             quiet), naming the cause + fix; exit 0 always; a NEW session
 *             announces once again; token-was-rejected wording names source.
 *   CLAIM E — daemon down (connection refused) → quiet path: stdout '', exit 0.
 *   CLAIM F — non-auth non-2xx (500) → version-skew warning, once, in a class
 *             separate from auth (both may announce in one session).
 *   CLAIM H — cold start stays pure-node fast (median spawn→exit well under
 *             the 1500ms budget; guards against a tsx/dep regression).
 *   CLAIM I — session-end (WO-4): the transcript tail (LAST 40 user/assistant
 *             messages, 24KB-capped) is POSTed to /hooks/verbatim as
 *             verbatim_store args {workspace, text, source, sessionId} with
 *             source = claude-code-session:<id>, and a 2xx prints exactly the
 *             one-line capture nudge wrapped as Stop.
 *   CLAIM J — session-end failures are COMPLETELY silent (daemon down,
 *             unreadable transcript, missing transcript_path): exit 0, no
 *             output — no warnOnce classes apply to capture.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'scripts', 'atlas-hook.mjs');

// ── stub daemon ──────────────────────────────────────────────────────────────

type StubMode = 'ok' | 'ok-empty' | 'unauthorized' | 'server-error';

interface Stub {
    port: number;
    mode: StubMode;
    lastAuth: string | undefined; // Authorization header of the last request ('' = header absent)
    lastPath: string | undefined; // path of the last request (session-end targets /hooks/verbatim)
    lastBody: string | undefined; // raw body of the last request
    close: () => Promise<void>;
}

function startStub(): Promise<Stub> {
    const stub: Partial<Stub> & { mode: StubMode } = { mode: 'ok', lastAuth: undefined };
    const server = http.createServer((req, res) => {
        stub.lastAuth = (req.headers.authorization ?? '').toString();
        stub.lastPath = req.url;
        let body = '';
        req.setEncoding('utf-8');
        req.on('data', (c: string) => { body += c; });
        req.on('end', () => {
            stub.lastBody = body;
            if (stub.mode === 'unauthorized') {
                res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="atlas-mcp"' });
                res.end(JSON.stringify({ error: 'unauthorized', detail: 'Missing or invalid bearer token' }));
            } else if (stub.mode === 'server-error') {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('boom');
            } else {
                const ctx = stub.mode === 'ok-empty' ? '' : `CTX auth=[${stub.lastAuth}]`;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ additionalContext: ctx }));
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            stub.port = typeof addr === 'object' && addr ? addr.port : 0;
            stub.close = () => new Promise((r) => server.close(() => r()));
            resolve(stub as Stub);
        });
    });
}

// ── hook runner ──────────────────────────────────────────────────────────────

interface HookRun { stdout: string; stderr: string; code: number | null; ms: number }

interface HookEnv {
    port: number;
    home: string;       // ATLAS_HOME for the child (token file location)
    tmp: string;        // tmpdir for the child (once-per-session markers)
    token?: string;     // ATLAS_MCP_TOKEN env for the child
}

function runHook(cfg: HookEnv, sessionId: string, event = 'pre-edit', payloadExtra: Record<string, unknown> = {}): Promise<HookRun> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never let the developer machine's real Atlas config leak into a claim.
    delete env['ATLAS_MCP_TOKEN'];
    delete env['ATLAS_HOME'];
    delete env['ATLAS_PORT'];
    env['ATLAS_PORT'] = String(cfg.port);
    env['ATLAS_HOME'] = cfg.home;
    env['TMPDIR'] = cfg.tmp; // os.tmpdir() in the child resolves markers here
    env['TMP'] = cfg.tmp;
    env['TEMP'] = cfg.tmp;
    if (cfg.token !== undefined) env['ATLAS_MCP_TOKEN'] = cfg.token;

    const payload = JSON.stringify({
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/example.ts' },
        ...payloadExtra,
    });

    return new Promise((resolve) => {
        const t0 = performance.now();
        const child = spawn(process.execPath, [HOOK, event, 'test-ws'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
        child.on('close', (code) => resolve({ stdout, stderr, code, ms: performance.now() - t0 }));
        child.stdin.end(payload);
    });
}

/** Parse the hook's stdout contract; fails the test on malformed output. */
function contextOf(run: HookRun): { eventName: string; context: string } {
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    const h = parsed.hookSpecificOutput;
    assert.ok(h, 'stdout must be a hookSpecificOutput envelope');
    return { eventName: h.hookEventName ?? '', context: h.additionalContext ?? '' };
}

function freshDirs(tag: string): { home: string; tmp: string } {
    return {
        home: fs.mkdtempSync(path.join(os.tmpdir(), `atlas-hookt-${tag}-home-`)),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), `atlas-hookt-${tag}-tmp-`)),
    };
}

async function main(): Promise<void> {
    const stub = await startStub();
    const cleanups: string[] = [];

    // ── CLAIM A — env token travels as a bearer; healthy context flows ───────
    {
        const { home, tmp } = freshDirs('a');
        cleanups.push(home, tmp);
        stub.mode = 'ok';
        const run = await runHook({ port: stub.port, home, tmp, token: 'sekret-env' }, 'sess-a');
        assert.equal(run.code, 0, 'A: exit 0');
        assert.equal(stub.lastAuth, 'Bearer sekret-env', 'A: daemon must receive Authorization: Bearer <env token>');
        const { eventName, context } = contextOf(run);
        assert.equal(eventName, 'PreToolUse', 'A: pre-edit wraps as PreToolUse');
        assert.match(context, /CTX auth=\[Bearer sekret-env\]/, 'A: daemon context reaches stdout');
        assert.ok(!/INERT/.test(context), 'A: healthy path must not warn');
        console.log('CLAIM A ok — env token sent, context flows');
    }

    // ── CLAIM B — file fallback: <ATLAS_HOME>/mcp.token, trimmed ─────────────
    {
        const { home, tmp } = freshDirs('b');
        cleanups.push(home, tmp);
        fs.writeFileSync(path.join(home, 'mcp.token'), 'sekret-file\n'); // daemon writes token + '\n'
        stub.mode = 'ok';
        const run = await runHook({ port: stub.port, home, tmp }, 'sess-b');
        assert.equal(run.code, 0, 'B: exit 0');
        assert.equal(stub.lastAuth, 'Bearer sekret-file', 'B: mcp.token file token sent (trailing newline trimmed)');
        console.log('CLAIM B ok — mcp.token file fallback, same path as readMcpAuthToken');
    }

    // ── CLAIM C — no token → no header; healthy-empty stays quiet ────────────
    {
        const { home, tmp } = freshDirs('c');
        cleanups.push(home, tmp);
        stub.mode = 'ok-empty';
        const run = await runHook({ port: stub.port, home, tmp }, 'sess-c');
        assert.equal(run.code, 0, 'C: exit 0');
        assert.equal(stub.lastAuth, '', 'C: no token anywhere → no Authorization header (auth-off daemon)');
        assert.equal(run.stdout, '', 'C: healthy daemon with nothing to say must stay QUIET');
        console.log('CLAIM C ok — auth-off request shape, healthy-quiet stays quiet');
    }

    // ── CLAIM D — 401 announces once per session, naming cause + fix ─────────
    {
        const { home, tmp } = freshDirs('d');
        cleanups.push(home, tmp);
        stub.mode = 'unauthorized';

        // No token found: the warning must say so and point at the token path.
        const first = await runHook({ port: stub.port, home, tmp }, 'sess-d');
        assert.equal(first.code, 0, 'D: exit 0 even when rejected');
        const { context } = contextOf(first);
        assert.match(context, /Atlas hooks are INERT/, 'D: warning announces inertness');
        assert.match(context, /found none/, 'D: names the cause (no token found)');
        assert.match(context, new RegExp(path.join(home, 'mcp.token').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'D: names the token path checked');
        assert.match(context, /atlas service install|ATLAS_MCP_TOKEN/, 'D: names a concrete fix');
        assert.match(first.stderr, /\[atlas-hook\]/, 'D: warning mirrored to stderr for humans');

        // Same session, repeat calls: quiet. The whole point is once, not never
        // and not every-call.
        for (let i = 0; i < 3; i++) {
            const rerun = await runHook({ port: stub.port, home, tmp }, 'sess-d');
            assert.equal(rerun.code, 0, `D: repeat ${i} exit 0`);
            assert.equal(rerun.stdout, '', `D: repeat ${i} must stay quiet (already announced this session)`);
        }

        // A different session gets its own single announcement.
        const other = await runHook({ port: stub.port, home, tmp }, 'sess-d2');
        assert.match(contextOf(other).context, /Atlas hooks are INERT/, 'D: new session announces again');

        // Token present but rejected: wording must name the rejected source.
        const { home: home2, tmp: tmp2 } = freshDirs('d3');
        cleanups.push(home2, tmp2);
        const rejected = await runHook({ port: stub.port, home: home2, tmp: tmp2, token: 'wrong-token' }, 'sess-d3');
        const rejCtx = contextOf(rejected).context;
        assert.match(rejCtx, /rejected the hook's bearer token/, 'D: token-rejected wording');
        assert.match(rejCtx, /\$ATLAS_MCP_TOKEN/, 'D: names the source the bad token came from');
        console.log('CLAIM D ok — 401 announces exactly once per session, with cause + fix');
    }

    // ── CLAIM E — daemon down: the expected state stays quiet ────────────────
    let downPort: number;
    {
        const { home, tmp } = freshDirs('e');
        cleanups.push(home, tmp);
        // Grab a port that is definitely free, then close it → connection refused.
        const probe = await startStub();
        downPort = probe.port;
        await probe.close();
        const run = await runHook({ port: downPort, home, tmp }, 'sess-e');
        assert.equal(run.code, 0, 'E: exit 0');
        assert.equal(run.stdout, '', 'E: daemon down is expected — no warning, no context');
        assert.ok(run.ms < 1500, `E: refused connection resolves fast (took ${run.ms.toFixed(0)}ms)`);
        console.log('CLAIM E ok — daemon down stays quiet');
    }

    // ── CLAIM F — non-auth non-2xx: version-skew warning, its own class ──────
    {
        const { home, tmp } = freshDirs('f');
        cleanups.push(home, tmp);
        stub.mode = 'unauthorized';
        const authWarn = await runHook({ port: stub.port, home, tmp }, 'sess-f');
        assert.match(contextOf(authWarn).context, /INERT/, 'F: auth warning fires first');
        stub.mode = 'server-error';
        const skewWarn = await runHook({ port: stub.port, home, tmp }, 'sess-f');
        const skewCtx = contextOf(skewWarn).context;
        assert.match(skewCtx, /version-skewed/, 'F: 500 classified as version skew, announced despite earlier auth warning');
        assert.match(skewCtx, /HTTP 500/, 'F: names the status');
        const rerun = await runHook({ port: stub.port, home, tmp }, 'sess-f');
        assert.equal(rerun.stdout, '', 'F: skew class also announces only once');
        console.log('CLAIM F ok — version skew announces once, separate class from auth');
    }

    // ── CLAIM G — post-bash wraps as PostToolUse ─────────────────────────────
    {
        const { home, tmp } = freshDirs('g');
        cleanups.push(home, tmp);
        stub.mode = 'unauthorized';
        const run = await runHook({ port: stub.port, home, tmp }, 'sess-g', 'post-bash');
        assert.equal(contextOf(run).eventName, 'PostToolUse', 'G: post-bash warnings ride PostToolUse');
        console.log('CLAIM G ok — post-bash envelope');
    }

    // ── CLAIM H — cold start guard (pure node, no tsx/deps) ──────────────────
    {
        const { home, tmp } = freshDirs('h');
        cleanups.push(home, tmp);
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const run = await runHook({ port: downPort, home, tmp }, `sess-h-${i}`);
            times.push(run.ms);
        }
        times.sort((a, b) => a - b);
        const median = times[2]!;
        // Pure-node spawn→exit is ~60–120ms; tsx or a dependency would add 400ms+.
        // 500ms keeps the guard meaningful with headroom for loaded CI machines.
        assert.ok(median < 500, `H: median cold start ${median.toFixed(0)}ms must stay well under the 1500ms budget`);
        console.log(`CLAIM H ok — median cold start ${median.toFixed(0)}ms (5 runs: ${times.map((t) => t.toFixed(0)).join(', ')}ms)`);
    }

    // ── CLAIM I — session-end: transcript tail → POST /hooks/verbatim ───────
    {
        const { home, tmp } = freshDirs('i');
        cleanups.push(home, tmp);
        stub.mode = 'ok';

        // A transcript with 50 user messages (only the LAST 40 may survive),
        // then a 30KB assistant message (the 24KB cap must bite, head kept),
        // then noise that must NOT be captured at all (a non-message entry).
        const lines: string[] = [];
        for (let i = 0; i < 50; i++) {
            lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `marker-${i}-alpha` } }));
        }
        lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(30 * 1024) }] } }));
        lines.push(JSON.stringify({ type: 'system', message: { content: 'noise' } }));
        const transcript = path.join(tmp, 'transcript.jsonl');
        fs.writeFileSync(transcript, lines.join('\n') + '\n');

        stub.lastPath = undefined;
        stub.lastBody = undefined;
        const run = await runHook({ port: stub.port, home, tmp, token: 'sekret-env' }, 'sess-i', 'session-end', { transcript_path: transcript });
        assert.equal(run.code, 0, 'I: exit 0');
        assert.equal(stub.lastPath, '/hooks/verbatim', 'I: session-end POSTs /hooks/verbatim, not /hooks/context');
        assert.ok(stub.lastBody, 'I: a body was posted');
        const posted = JSON.parse(stub.lastBody!) as { workspace: unknown; text: unknown; source: unknown; sessionId: unknown };
        assert.equal(posted.workspace, 'test-ws', 'I: workspace positional travels verbatim');
        assert.equal(posted.source, 'claude-code-session:sess-i', 'I: source names the claude-code session');
        assert.equal(posted.sessionId, 'sess-i', 'I: sessionId field travels');
        assert.equal(typeof posted.text, 'string', 'I: text is a string');
        const text = posted.text as string;
        // Last-40 window: 51 messages total → window starts at marker-11.
        assert.ok(text.startsWith('marker-11-alpha'), 'I: joined text starts at the 40th-from-last message');
        assert.ok(!text.includes('marker-10-alpha'), 'I: messages older than the last 40 are dropped');
        assert.ok(!text.includes('noise'), 'I: non-user/assistant entries are never captured');
        assert.equal(text.length, 24 * 1024, 'I: joined text capped at 24KB');

        const { eventName, context } = contextOf(run);
        assert.equal(eventName, 'Stop', 'I: session-end envelope wraps as Stop');
        assert.equal(context, '📝 Session captured to Atlas verbatim memory. Anything decision-worthy? If yes: knowledge_store it (sparingly — search what it supersedes first).', 'I: exact one-line capture nudge');
        console.log('CLAIM I ok — session-end POSTs verbatim_store args to /hooks/verbatim with the capture nudge');
    }

    // ── CLAIM J — session-end failures are COMPLETELY silent ────────────────
    {
        // Daemon down (connection refused): exit 0, no output.
        {
            const { home, tmp } = freshDirs('j1');
            cleanups.push(home, tmp);
            const transcript = path.join(tmp, 't.jsonl');
            fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
            const run = await runHook({ port: downPort, home, tmp }, 'sess-j1', 'session-end', { transcript_path: transcript });
            assert.equal(run.code, 0, 'J: daemon down → exit 0');
            assert.equal(run.stdout, '', 'J: daemon down → no output');
        }
        // Transcript unreadable: exit 0, no output, and NO request at all.
        {
            const { home, tmp } = freshDirs('j2');
            cleanups.push(home, tmp);
            stub.mode = 'ok';
            stub.lastPath = undefined;
            stub.lastBody = undefined;
            const run = await runHook({ port: stub.port, home, tmp, token: 'sekret-env' }, 'sess-j2', 'session-end', { transcript_path: path.join(tmp, 'missing.jsonl') });
            assert.equal(run.code, 0, 'J: unreadable transcript → exit 0');
            assert.equal(run.stdout, '', 'J: unreadable transcript → no output');
            assert.equal(stub.lastPath, undefined, 'J: unreadable transcript → no daemon request at all');
        }
        // No transcript_path in the payload: nothing to capture, quiet.
        {
            const { home, tmp } = freshDirs('j3');
            cleanups.push(home, tmp);
            stub.lastPath = undefined;
            const run = await runHook({ port: stub.port, home, tmp }, 'sess-j3', 'session-end');
            assert.equal(run.code, 0, 'J: no transcript_path → exit 0');
            assert.equal(run.stdout, '', 'J: no transcript_path → no output');
            assert.equal(stub.lastPath, undefined, 'J: no transcript_path → no daemon request at all');
        }
        console.log('CLAIM J ok — session-end failures completely silent (down / unreadable / absent transcript)');
    }

    await stub.close();
    for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
    console.log('hook-client: ALL CLAIMS PASS');
}

await main();
