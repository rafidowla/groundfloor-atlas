#!/usr/bin/env node
/**
 * atlas-hook.mjs — the tiny, fast client behind Atlas's Claude Code hooks.
 *
 * Installed into a project's .claude/settings.json by `atlas wire`. It reads the
 * hook payload Claude Code writes to stdin, forwards the intercepted tool call to
 * the running Atlas daemon's POST /hooks/context, and emits the daemon's
 * `additionalContext` back as a Claude Code hook result — so the agent sees what
 * Atlas knows BEFORE it searches / edits / commits.
 *
 * Pure node (http + fs + stdin only) so it cold-starts in ~50ms — NOT via tsx,
 * which would add ~400ms to every Grep/Edit. It ALWAYS exits 0, never blocks the
 * agent, and prints nothing when Atlas is down/slow/quiet (bounded by a hard
 * timeout).
 *
 * Auth: /hooks/context sits behind the same bearer/Host/Origin gate as /mcp
 * (enforceMcpAuth, mcp/server.ts). The token is resolved EXACTLY the way every
 * other local client resolves it (config.ts readMcpAuthToken, ideConnect.ts):
 * ATLAS_MCP_TOKEN env → <ATLAS_HOME>/mcp.token → none (auth-off daemon). Never
 * mint a token here, never add a second credential source.
 *
 * Fail-open ≠ fail-silent. An earlier version swallowed the daemon's 401 into
 * "no context" and stayed inert for days with zero indication (the MCP path kept
 * working, so nothing looked wrong). The three outcomes are now distinguished:
 *   - daemon down / timeout          → quiet (expected: Atlas isn't running)
 *   - healthy 2xx, empty context     → quiet (the common case — nothing to say)
 *   - reachable but REJECTED         → announce ONCE per session, through the
 *     (401/403 auth; other non-2xx     normal additionalContext channel, naming
 *      = client/daemon version skew)   the cause and the concrete fix.
 * Once-per-session is enforced with an atomic tmpdir marker keyed by Claude
 * session + failure class, so repeat Grep/Edit calls stay quiet after the first
 * warning. If a NEW failure class appears later in the session it announces too.
 *
 * argv: node atlas-hook.mjs <event> [workspace]
 *   event = pre-search | pre-edit | post-bash | session-end
 *
 * SESSION-END (WO-4). The Stop hook fires when the agent finishes responding,
 * with transcript_path + session_id in the payload. This client reads the
 * transcript (JSONL), keeps the text of the LAST 40 user/assistant messages
 * (capped at 24KB), and POSTs it to a DIFFERENT endpoint — /hooks/verbatim —
 * whose body is verbatim_store args (the daemon enqueues; flush is the
 * verbatim queue's business). On a 2xx it prints exactly one additionalContext
 * line nudging the agent to promote anything decision-worthy. Every failure
 * (no transcript_path, unreadable transcript, daemon down, timeout, non-2xx)
 * is COMPLETELY silent — capture is best-effort and must never warn, unlike
 * the /hooks/context failure classes above.
 *
 * WORKSPACE RESOLUTION (auto-wire Part 2). The positional [workspace] arg is
 * how a per-repo `atlas wire install` hook names its workspace explicitly —
 * when present it always wins server-side, so every already-wired repo keeps
 * behaving exactly as before. When absent (a machine-wide hook, Part 3, which
 * has no per-repo workspace to bake in at install time), this client instead
 * sends `cwd` and lets the daemon resolve the owning workspace itself via
 * Part 1's path->workspace resolver. `cwd` is read from the hook payload
 * Claude Code writes to stdin (the same envelope this file already reads
 * `session_id`/`tool_name`/`tool_input` from) and falls back to this
 * process's own `process.cwd()` for a manual/scripted invocation where no
 * payload field is present.
 *
 * DE-DUP (auto-wire Part 3, `atlas wire install --global`). An empty
 * WORKSPACE is also the unambiguous signature of a machine-wide hook
 * invocation — every per-repo `atlas wire install` always bakes a non-empty,
 * slug-validated workspace (WORKSPACE_SLUG_RE in cli/wire.ts). So when
 * WORKSPACE is empty AND this cwd, or an ANCESTOR of it (up to but excluding
 * the home directory), already has its OWN Atlas-owned hook (a
 * `.claude/settings.json` containing HOOK_TAG, written by a per-repo
 * `atlas wire install`), that local hook fires for this same event with its
 * own explicit workspace — this global invocation stays silent instead of
 * sending a second, duplicate context. The walk-up matters because a tool
 * call's `cwd` can be a subdirectory of the wired project root, not the root
 * itself. No network round trip either: the check is a handful of local file
 * reads, before the daemon is ever contacted.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVENT = process.argv[2] || 'pre-search';
const WORKSPACE = process.argv[3] || '';
const PORT = Number(process.env.ATLAS_PORT || 3848);
const TIMEOUT_MS = 1500;
// session-end's own budget: reading a transcript tail off disk before the
// POST justifies slightly more than the interactive ceiling. Deliberately a
// SEPARATE constant — widening TIMEOUT_MS itself would slow every Grep/Edit
// hook's failure path for no reason.
const SESSION_END_TIMEOUT_MS = 2000;
// The budget this invocation runs under (request timeout + stdin bail).
const BUDGET_MS = EVENT === 'session-end' ? SESSION_END_TIMEOUT_MS : TIMEOUT_MS;

// Same tag cli/wire.ts's HOOK_TAG uses to mark an Atlas-owned settings.json
// hook entry — kept as a literal copy (not imported) because this file must
// stay pure-node/no-tsx for its ~50ms cold-start budget; see the header.
const HOOK_TAG = 'atlas-hook.mjs';

/** True when `dir`, or any ANCESTOR of it up to (but not including) the home
 *  directory, has its OWN per-repo Atlas hook already installed (Part 3
 *  de-dup — see this file's header). Walking up matters because a tool call's
 *  reported `cwd` can be a subdirectory of the wired project root (`atlas wire
 *  install` writes only into the root, e.g. a session working a few folders
 *  deep) — checking the literal cwd alone missed that and let both hooks fire.
 *  The walk stops BEFORE the home directory rather than at it: once a global
 *  install exists, `home/.claude/settings.json` *is* the global settings file
 *  and always contains HOOK_TAG itself, so checking it here would make every
 *  project look "locally wired" and silence the global hook everywhere.
 *  Best-effort at each level: any read failure (missing file, malformed
 *  JSON-ish content) means "no local hook at this level", never a throw. */
function hasLocalAtlasHook(dir) {
    const stopAt = path.resolve(os.homedir());
    let cur = path.resolve(dir);
    for (;;) {
        if (cur === stopAt) return false; // home dir holds the GLOBAL file — not a per-repo hook
        try {
            const raw = fs.readFileSync(path.join(cur, '.claude', 'settings.json'), 'utf-8');
            if (raw.includes(HOOK_TAG)) return true;
        } catch { /* no settings.json at this level — keep walking up */ }
        const parent = path.dirname(cur);
        if (parent === cur) return false; // filesystem root reached
        cur = parent;
    }
}

// ── token resolution (read-only mirror of config.ts readMcpAuthToken) ────────
const ATLAS_HOME = process.env.ATLAS_HOME || path.join(os.homedir(), '.groundfloor', 'atlas');
const TOKEN_PATH = path.join(ATLAS_HOME, 'mcp.token');

function readMcpToken() {
    const env = process.env.ATLAS_MCP_TOKEN;
    if (env && env.trim()) return { token: env.trim(), source: '$ATLAS_MCP_TOKEN' };
    try {
        const raw = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
        // A token with non-printable chars can't travel in a header; send nothing
        // instead — the daemon's 401 then routes to the loud path, not a crash.
        if (raw && !/[^\x21-\x7e]/.test(raw)) return { token: raw, source: TOKEN_PATH };
    } catch { /* ENOENT (auth-off daemon, or daemon never booted) → no header */ }
    return { token: null, source: null };
}

// Fail-open: any error / timeout → exit 0 with no output, so the agent proceeds.
function done(context) {
    try {
        if (context && typeof context === 'string' && context.trim()) {
            const eventName = EVENT === 'post-bash' ? 'PostToolUse' : EVENT === 'session-end' ? 'Stop' : 'PreToolUse';
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
            }));
        }
    } catch { /* even a broken stdout must not turn into a non-zero exit */ }
    process.exit(0);
}

// Claude Code puts session_id in every hook payload; the parent pid is the
// fallback for manual runs (stable per terminal, so still "once per session").
let sessionKey = `ppid-${process.ppid}`;

/** Announce a config/auth failure ONCE per session per failure class, then stay
 *  quiet. The wx-create is the atomic "am I first?" check, so two hooks firing
 *  concurrently can't both warn. If the marker can't be written at all (broken
 *  tmpdir), warn anyway — repeating beats going silently inert again. */
function warnOnce(cls, message) {
    const key = String(sessionKey).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const marker = path.join(os.tmpdir(), `atlas-hook-warned-${cls}-${key}`);
    try {
        fs.writeFileSync(marker, '', { flag: 'wx' });
    } catch (err) {
        if (err && err.code === 'EEXIST') return done(''); // already announced this session
    }
    try { process.stderr.write(`[atlas-hook] ${message}\n`); } catch { /* best-effort mirror */ }
    done(message);
}

// ── session-end (WO-4): transcript tail → POST /hooks/verbatim ──────────────

const SESSION_END_TEXT_CAP = 24 * 1024;                   // joined-text cap, chars
const SESSION_END_MAX_MESSAGES = 40;                      // keep the LAST N messages
const SESSION_END_TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;  // transcript tail window, bytes

/** Text content of one transcript line: user/assistant entries only. A string
 *  content passes through; block content keeps its text blocks (tool_use /
 *  tool_result blocks are deliberately dropped). '' for everything else. */
function messageText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.type !== 'user' && entry.type !== 'assistant') return '';
    const m = entry.message;
    const content = m && typeof m === 'object' ? m.content : entry.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n');
    }
    return '';
}

/** Read the transcript JSONL and return the joined text of the last
 *  SESSION_END_MAX_MESSAGES user/assistant messages, head-capped at
 *  SESSION_END_TEXT_CAP chars. null on ANY failure or when nothing readable
 *  is in it — the caller treats that as "nothing to capture", never a warn. */
function transcriptTail(file) {
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) return null;
        let rawText;
        if (st.size <= SESSION_END_TRANSCRIPT_READ_CAP) {
            rawText = fs.readFileSync(file, 'utf-8');
        } else {
            // Huge transcript: read only the tail window and drop the possibly
            // split first line so a half-line never masquerades as a message.
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(SESSION_END_TRANSCRIPT_READ_CAP);
                fs.readSync(fd, buf, 0, SESSION_END_TRANSCRIPT_READ_CAP, st.size - SESSION_END_TRANSCRIPT_READ_CAP);
                const s = buf.toString('utf-8');
                rawText = s.slice(s.indexOf('\n') + 1);
            } finally {
                fs.closeSync(fd);
            }
        }
        const texts = [];
        for (const line of rawText.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            let entry = null;
            try { entry = JSON.parse(t); } catch { continue; } // non-JSON line → skip
            const text = messageText(entry);
            if (text) texts.push(text);
        }
        if (!texts.length) return null;
        const joined = texts.slice(-SESSION_END_MAX_MESSAGES).join('\n');
        return joined.length > SESSION_END_TEXT_CAP ? joined.slice(0, SESSION_END_TEXT_CAP) : joined;
    } catch {
        return null;
    }
}

/** session-end flow: transcript tail → POST /hooks/verbatim (verbatim_store
 *  args), the single capture-nudge line on 2xx, COMPLETE silence on anything
 *  else — this event never uses warnOnce; capture is best-effort. */
function sessionEnd(payload, cwd) {
    const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : '';
    const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : '';
    if (!transcriptPath) return done(''); // no transcript in the payload → nothing to capture
    const text = transcriptTail(transcriptPath);
    if (!text) return done('');

    const body = JSON.stringify({
        workspace: WORKSPACE,
        cwd,
        text,
        source: `claude-code-session:${sessionId}`,
        ...(sessionId ? { sessionId } : {}),
    });
    const { token } = readMcpToken();
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/hooks/verbatim', method: 'POST', headers },
        (res) => {
            res.resume(); // 204 has no body; drain so the socket frees cleanly
            res.on('end', () => {
                try {
                    const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
                    return done(ok
                        ? '📝 Session captured to Atlas verbatim memory. Anything decision-worthy? If yes: knowledge_store it (sparingly — search what it supersedes first).'
                        : '');
                } catch { done(''); }
            });
        },
    );
    req.setTimeout(SESSION_END_TIMEOUT_MS, () => { req.destroy(); done(''); }); // slow daemon → quiet
    req.on('error', () => done(''));                                            // daemon down → quiet
    req.write(body);
    req.end();
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { raw += c; if (raw.length > 512 * 1024) raw = raw.slice(0, 512 * 1024); });
process.stdin.on('end', () => {
    try {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
        if (payload.session_id) sessionKey = String(payload.session_id);

        // cwd: prefer what Claude Code's own hook payload carries (accurate even
        // if this process were ever spawned from elsewhere); process.cwd() is the
        // fallback for a manual run or an older payload shape missing the field.
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

        // Part 3 de-dup: a workspace-less (global) invocation whose cwd already
        // has its own per-repo Atlas hook stays quiet — that local hook covers
        // this event already. No daemon request at all, so this can never be
        // mistaken for a failure (no warning, exit 0, no output).
        if (!WORKSPACE && hasLocalAtlasHook(cwd)) return done('');
        // WO-4: session-end rides a different endpoint + flow (transcript
        // capture → /hooks/verbatim), not the /hooks/context contract below.
        if (EVENT === 'session-end') return sessionEnd(payload, cwd);

        const body = JSON.stringify({
            event: EVENT,
            workspace: WORKSPACE,
            cwd,
            toolName: payload.tool_name || '',
            toolInput: payload.tool_input || {},
        });
        const { token, source } = readMcpToken();
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/hooks/context', method: 'POST', headers },
            (res) => {
                let out = '';
                res.setEncoding('utf-8');
                res.on('data', (c) => { out += c; });
                res.on('end', () => {
                    try {
                        const status = res.statusCode || 0;
                        let parsed = null;
                        try { parsed = JSON.parse(out); } catch { /* classified below */ }

                        // Healthy daemon. Empty additionalContext is the COMMON case
                        // (nothing worth saying) — quiet is correct, not a failure.
                        if (status >= 200 && status < 300 && parsed && typeof parsed === 'object') {
                            return done(typeof parsed.additionalContext === 'string' ? parsed.additionalContext : '');
                        }

                        const detail = parsed && parsed.detail ? `: "${String(parsed.detail).slice(0, 120)}"` : '';

                        // Rejected by the auth gate — the hook is configured but CANNOT
                        // work. Token drift / wrong ATLAS_HOME is a bug, never a normal
                        // state, so it must not be mistaken for "nothing to say".
                        if (status === 401 || status === 403) {
                            const cause = token
                                ? `rejected the hook's bearer token from ${source} (HTTP ${status}${detail}) — the hook and the daemon are likely reading different ATLAS_HOMEs, or the daemon re-minted its mcp.token`
                                : `requires a bearer token but the hook found none (HTTP ${status}${detail}) — checked $ATLAS_MCP_TOKEN and ${TOKEN_PATH}`;
                            return warnOnce('auth',
                                `⚠️ Atlas hooks are INERT: the Atlas daemon at 127.0.0.1:${PORT} is running but ${cause}. ` +
                                `Blast-radius / search / commit context is NOT being delivered. ` +
                                `Fix: run \`atlas service install\` (restarts the daemon, re-minting ${TOKEN_PATH} and rewiring IDE tokens), or set ATLAS_MCP_TOKEN to the daemon's token. ` +
                                `(Shown once per session.)`);
                        }

                        // Reachable but the contract broke — 404 route gone, 400 schema
                        // drift, 5xx, or a non-JSON body: this client and the daemon are
                        // version-skewed. The next skew must announce itself too.
                        const shape = parsed ? `HTTP ${status}${detail}` : `HTTP ${status} with a non-JSON body`;
                        return warnOnce('proto',
                            `⚠️ Atlas hooks are INERT: POST /hooks/context on the Atlas daemon at 127.0.0.1:${PORT} answered ${shape} instead of hook context — this hook client and the daemon are likely version-skewed. ` +
                            `Blast-radius / search / commit context is NOT being delivered. ` +
                            `Fix: update Atlas (git pull + npm run build in the Atlas repo — the rebuild auto-restarts the daemon), then re-run \`atlas wire install\`. ` +
                            `(Shown once per session.)`);
                    } catch { done(''); }
                });
            },
        );
        req.setTimeout(BUDGET_MS, () => { req.destroy(); done(''); }); // slow daemon → expected, quiet
        req.on('error', () => done(''));                                 // daemon down → expected, quiet
        req.write(body);
        req.end();
    } catch { done(''); }
});
// If stdin never closes (shouldn't happen), still bail.
setTimeout(() => done(''), BUDGET_MS + 500);
