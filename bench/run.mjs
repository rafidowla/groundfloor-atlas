/**
 * bench/run.mjs — Atlas context benchmark (token efficiency + optional quality).
 *
 * Per task, assembles the context each APPROACH would put in front of an agent,
 * counts tokens, and (with --judge + an API key) scores answer quality so the
 * real metric — tokens-per-task at equal-or-better quality — can be computed.
 *
 * Approaches:
 *   raw       : the fair naive baseline. Symbol-scoped tasks → the relevant
 *               file(s); whole-repo tasks (rawScope:"repo") → the whole src tree.
 *   atlas     : the structured tool output (blast_radius / call_graph / dead_code).
 *   aider-map : Aider's tree-sitter+PageRank repo-map (graph-vs-graph). Requires
 *               aider-chat; set AIDER_PY to the venv python. Skipped if absent.
 *
 * Quality judge (--judge): OpenRouter + DeepSeek (JUDGE_MODEL, default
 * deepseek/deepseek-v4-flash; NOT Anthropic). Key read from OPENROUTER_API_KEY
 * (env only — never stored). LLM-as-judge: answers from each approach's context,
 * then grades 0–100 vs the task's `gold` reference. Skipped without a key.
 *
 * Token counts use chars/3.5 (code approx), applied identically to every approach
 * — relative comparison holds; swap a real tokenizer for publishable absolute nums.
 *
 * Run from repo root, daemon up + `atlas` workspace indexed:
 *   ATLAS_HOME=~/.atlas-demo node bench/run.mjs [--judge] [--aider-tokens 2048]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const HOME = process.env.ATLAS_HOME || path.join(process.env.HOME, '.atlas-demo');
const PORT = process.env.ATLAS_PORT || '3848';
const WS = process.env.BENCH_WS || 'atlas';
const AIDER_PY = process.env.AIDER_PY || '/tmp/aidervenv/bin/python';
const AIDER_TOKENS = Number((process.argv.find((a) => a.startsWith('--aider-tokens='))?.split('=')[1]) || 2048);
const JUDGE = process.argv.includes('--judge');

const toks = (s) => Math.round((s || '').length / 3.5);
const tasks = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'tasks.json'), 'utf8'));

// ── MCP client (atlas approach) ───────────────────────────────────────────────
const token = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const mcp = new Client({ name: 'atlas-bench', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);
const invoke = async (tool, args) => (await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool, args } })).content?.[0]?.text ?? '';

// ── source walk (for raw repo + checks) ───────────────────────────────────────
function walkSrc(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walkSrc(p, acc); }
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
    }
    return acc;
}

// ── approaches ────────────────────────────────────────────────────────────────
async function ctxAtlas(t) {
    if (t.type === 'impact') return invoke('atlas_blast_radius', { workspace: WS, symbol: t.symbol });
    if (t.type === 'callpath') return invoke('atlas_call_graph', { workspace: WS, symbol: t.symbol, direction: 'upstream' });
    if (t.type === 'deadcode') return invoke('atlas_find_dead_code', { workspace: WS, limit: 50 });
    return '';
}
function ctxRaw(t) {
    if (t.rawScope === 'repo') return walkSrc(path.join(REPO, 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    return (t.rawFiles || []).map((f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { return ''; } }).join('\n');
}
let aiderOk = fs.existsSync(AIDER_PY);
function ctxAiderMap(t) {
    if (!aiderOk) return null;
    const focus = t.rawScope === 'repo' ? [] : (t.rawFiles || []);
    try {
        return execFileSync(AIDER_PY, [path.join(REPO, 'bench', 'aider_map.py'), REPO, String(AIDER_TOKENS), ...focus],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return null; }
}
const APPROACH_NAMES = ['raw', 'atlas', 'aider-map'];

// ── optional quality judge (OpenRouter + DeepSeek only; NOT Anthropic) ─────────
// Reads OPENROUTER_API_KEY from env (never hard-coded). Model is pinned to a
// DeepSeek slug via JUDGE_MODEL (default deepseek/deepseek-v4-flash).
const KEY = process.env.OPENROUTER_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek/deepseek-v4-flash';
async function chat(prompt) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
}
// LLM-as-judge with a reference (gold) answer — robust to phrasing, unlike keyword
// matching. Step 1: answer the question from THIS approach's context. Step 2: grade
// that answer against the gold (0–100). Quality = "can the model answer correctly
// given this much context?", which is the real arbiter for tokens-at-equal-quality.
async function judge(question, context, gold) {
    const answer = await chat(`Context:\n${context.slice(0, 60000)}\n\nQuestion: ${question}\nAnswer concisely using ONLY the context. If the context is insufficient, say so.`);
    const grade = await chat(`Question: ${question}\nReference (correct) answer:\n${gold}\n\nCandidate answer:\n${answer}\n\nScore 0-100 for how well the candidate captures the reference's key facts (the specific file/function names and relationships). 100 = all key facts present and correct; 0 = wrong or "insufficient context". Reply with ONLY the integer.`);
    const m = grade.match(/\d{1,3}/);
    return { score: m ? Math.min(100, parseInt(m[0], 10)) : null };
}

// ── run ───────────────────────────────────────────────────────────────────────
// Phase 1: collect all atlas contexts over the live MCP session FIRST. (Don't
// interleave the blocking aider subprocess here — it stalls the event loop and
// resets the MCP keep-alive.)
const atlasCtx = {};
for (const t of tasks) atlasCtx[t.id] = await ctxAtlas(t);
await mcp.close();

// Phase 2: local + subprocess contexts (no MCP), then optional judge.
const matrix = [];
for (const t of tasks) {
    const ctxs = { raw: ctxRaw(t), atlas: atlasCtx[t.id], 'aider-map': ctxAiderMap(t) };
    const row = { id: t.id, type: t.type };
    for (const name of APPROACH_NAMES) {
        const ctx = ctxs[name];
        if (ctx == null) { row[name] = { tok: null, skip: true }; continue; }
        const cell = { tok: toks(ctx), empty: !ctx || ctx.includes('"error"') };
        if (JUDGE && KEY) cell.q = await judge(t.question, ctx, t.gold);
        row[name] = cell;
    }
    matrix.push(row);
}

// ── report ────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log('\nAtlas context benchmark\n');
if (!aiderOk) console.log(`(aider-map skipped — ${AIDER_PY} not found; install aider-chat in a venv to enable)`);
if (JUDGE && !KEY) console.log('(quality judge skipped — OPENROUTER_API_KEY not set)');
if (JUDGE && KEY) console.log(`(quality judge: ${JUDGE_MODEL} via OpenRouter)`);
console.log(`\n${pad('task', 28)}${pad('type', 9)}${pad('raw', 8)}${pad('atlas', 8)}${pad('aider-map', 11)}${pad('atlas vs raw', 13)}${JUDGE && KEY ? 'quality raw/atlas/aider (0-100)' : ''}`);
console.log('-'.repeat(95));
let sRaw = 0, sAtlas = 0;
for (const r of matrix) {
    const rt = r.raw.tok, at = r.atlas.tok, am = r['aider-map'].skip ? '—' : r['aider-map'].tok;
    sRaw += rt || 0; sAtlas += at || 0;
    const red = rt ? `${Math.round((1 - at / rt) * 100)}%` : '—';
    const qf = (c) => (c?.q && c.q.score != null) ? String(c.q.score) : '—';
    const q = (JUDGE && KEY) ? `${qf(r.raw)}  ${qf(r.atlas)}  ${qf(r['aider-map'])}` : '';
    console.log(`${pad(r.id, 28)}${pad(r.type, 9)}${pad(rt, 8)}${pad(at, 8)}${pad(am, 11)}${pad(red, 13)}${q}`);
}
console.log('-'.repeat(95));
console.log(`${pad('TOTAL', 37)}${pad(sRaw, 8)}${pad(sAtlas, 8)}${pad('', 11)}${Math.round((1 - sAtlas / sRaw) * 100)}%`);
console.log(`\nAtlas: ~${Math.round((1 - sAtlas / sRaw) * 100)}% fewer context tokens than raw across ${matrix.length} tasks.`);
console.log('NOTE: approx token counter; quality = LLM-graded (0-100) vs the gold reference (--judge + OPENROUTER_API_KEY). Small sample — see docs/BENCHMARK.md.\n');
fs.writeFileSync(path.join(REPO, 'bench', 'results.json'), JSON.stringify({ matrix, totals: { raw: sRaw, atlas: sAtlas } }, null, 2));
