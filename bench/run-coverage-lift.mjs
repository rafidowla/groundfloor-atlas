/**
 * bench/run-coverage-lift.mjs — Graphify-protocol coverage-lift benchmark.
 *
 * Replicates the SHAPE of Graphify's BENCHMARKS.md v8 code-intelligence claim:
 * giving a floor-tools agent (grep/read/list) ONE code-intelligence tool lifted
 * key-fact coverage from 70.8% → 82.0% (+11.2pt) at ~140K tokens/query.
 *
 * Static-context proxy for that protocol: per task, judge TWO arms with the
 * SAME LLM judge as bench/run.mjs (answer-from-context, then grade-vs-gold
 * 0-100):
 *   floor       : ctxRaw() — exactly the raw grep/read file content the naive
 *                 baseline gets (the "floor" Graphify's agent starts from).
 *   floor+atlas : the SAME floor bytes CONCATENATED with the atlas tool's
 *                 structured output (ctxAtlas) — the "floor + one graph tool"
 *                 arm. Both arms see byte-identical floor content.
 *
 * The judge slices context at 60,000 chars (same as run.mjs). To guarantee the
 * appended atlas block is never the part that gets sliced off, the FLOOR is
 * pre-sliced to 48,000 chars in BOTH arms (identical bytes), leaving ≥12K for
 * the atlas block. Repo-scope floors (deadcode-scan) are therefore prefix
 * slices — a static proxy cannot replicate an agent's active grep loops; noted
 * in the report, applies equally to both arms.
 *
 * Judge noise: --passes=N (default 2) repeats both arms per task; report both
 * passes and the mean.
 *
 * Run from repo root (daemon up, workspace indexed, OPENROUTER_API_KEY set):
 *   ATLAS_HOME=~/.groundfloor/atlas BENCH_WS=groundfloor-atlas \
 *     node bench/run-coverage-lift.mjs --judge --passes=2
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const HOME = process.env.ATLAS_HOME || path.join(process.env.HOME, '.atlas-demo');
const PORT = process.env.ATLAS_PORT || '3848';
const WS = process.env.BENCH_WS || 'atlas';
const JUDGE = process.argv.includes('--judge');
const PASSES = Number((process.argv.find((a) => a.startsWith('--passes='))?.split('=')[1]) || 2);
const FLOOR_CAP = 48000; // chars; both arms identical (see header)

const toks = (s) => Math.round((s || '').length / 3.5);
const tasks = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'tasks.json'), 'utf8'));

// ── MCP client (identical to bench/run.mjs) ───────────────────────────────────
const token = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const mcp = new Client({ name: 'atlas-coverage-lift', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);
const invoke = async (tool, args) => (await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool, args } })).content?.[0]?.text ?? '';

function atlasToolFor(t) {
    if (t.type === 'impact') return 'atlas_blast_radius';
    if (t.type === 'callpath') return 'atlas_call_graph';
    if (t.type === 'deadcode') return 'atlas_find_dead_code';
    return null;
}
async function ctxAtlas(t) {
    if (t.type === 'impact') return invoke('atlas_blast_radius', { workspace: WS, symbol: t.symbol });
    if (t.type === 'callpath') return invoke('atlas_call_graph', { workspace: WS, symbol: t.symbol, direction: 'upstream' });
    if (t.type === 'deadcode') return invoke('atlas_find_dead_code', { workspace: WS, limit: 50 });
    return '';
}
function ctxRaw(t) {
    if (t.rawScope === 'repo') {
        const walk = (dir, acc = []) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walk(p, acc); }
                else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
            }
            return acc;
        };
        return walk(path.join(REPO, 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    }
    return (t.rawFiles || []).map((f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { return ''; } }).join('\n');
}

// ── judge (identical prompts/model to bench/run.mjs) ──────────────────────────
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
async function judge(question, context, gold) {
    const answer = await chat(`Context:\n${context.slice(0, 60000)}\n\nQuestion: ${question}\nAnswer concisely using ONLY the context. If the context is insufficient, say so.`);
    const grade = await chat(`Question: ${question}\nReference (correct) answer:\n${gold}\n\nCandidate answer:\n${answer}\n\nScore 0-100 for how well the candidate captures the reference's key facts (the specific file/function names and relationships). 100 = all key facts present and correct; 0 = wrong or "insufficient context". Reply with ONLY the integer.`);
    const m = grade.match(/\d{1,3}/);
    return { score: m ? Math.min(100, parseInt(m[0], 10)) : null, answer, gradeRaw: grade };
}

// ── run ───────────────────────────────────────────────────────────────────────
if (!JUDGE) { console.error('pass --judge (this benchmark is the judged arms; nothing to measure without it)'); process.exit(64); }
if (!KEY) { console.error('OPENROUTER_API_KEY not set — refusing to fabricate scores'); process.exit(64); }

const SEP = (tool) => `\n\n===== [ADDITIONAL CONTEXT] ${tool} structured output (code-graph intelligence) =====\n`;
const out = { model: JUDGE_MODEL, passes: PASSES, floorCapChars: FLOOR_CAP, tasks: [] };
let sumFloor = 0, sumCombo = 0, n = 0;
console.log('\nCoverage-lift benchmark (Graphify protocol shape): floor vs floor+atlas\n');
console.log('floor = raw grep/read context (both arms byte-identical); atlas block appended in arm 2.\n');
for (const t of tasks) {
    const atlas = await ctxAtlas(t);
    const tool = atlasToolFor(t);
    const floorFull = ctxRaw(t);
    const floor = floorFull.slice(0, FLOOR_CAP); // identical bytes in BOTH arms
    const combo = floor + SEP(tool) + atlas;
    const row = {
        id: t.id, type: t.type, atlasTool: tool,
        floorTok: toks(floor), atlasTok: toks(atlas), comboTok: toks(combo),
        floorTruncated: floorFull.length > FLOOR_CAP,
        passes: [],
    };
    for (let p = 1; p <= PASSES; p++) {
        const f = await judge(t.question, floor, t.gold);
        const c = await judge(t.question, combo, t.gold);
        row.passes.push({ pass: p, floor: f.score, combo: c.score, floorAnswer: f.answer, floorGrade: f.gradeRaw, comboAnswer: c.answer, comboGrade: c.gradeRaw });
        console.log(`  ${t.id} pass${p}: floor=${f.score} floor+atlas=${c.score}  (lift ${c.score - f.score >= 0 ? '+' : ''}${c.score - f.score})`);
    }
    const mf = row.passes.filter((x) => x.floor != null);
    const mc = row.passes.filter((x) => x.combo != null);
    row.meanFloor = mf.length ? Math.round(mf.reduce((a, x) => a + x.floor, 0) / mf.length) : null;
    row.meanCombo = mc.length ? Math.round(mc.reduce((a, x) => a + x.combo, 0) / mc.length) : null;
    row.lift = (row.meanFloor != null && row.meanCombo != null) ? row.meanCombo - row.meanFloor : null;
    row.deltaTokPct = Math.round((row.comboTok / row.floorTok - 1) * 100);
    if (row.lift != null) { sumFloor += row.meanFloor; sumCombo += row.meanCombo; n += 1; }
    out.tasks.push(row);
}
out.avgFloor = n ? Math.round((sumFloor / n) * 10) / 10 : null;
out.avgCombo = n ? Math.round((sumCombo / n) * 10) / 10 : null;
out.avgLift = n ? Math.round(((sumCombo - sumFloor) / n) * 10) / 10 : null;
fs.writeFileSync(path.join(REPO, 'bench', 'results-coverage-lift.json'), JSON.stringify(out, null, 2));

console.log('\n' + ''.padEnd(100, '-'));
console.log(`${'task'.padEnd(32)}${'floor tok'.padEnd(11)}${'+atlas tok'.padEnd(12)}${'Δtok%'.padEnd(7)}${'floor q'.padEnd(9)}${'floor+atlas q'.padEnd(14)}lift`);
for (const r of out.tasks) {
    console.log(`${r.id.padEnd(32)}${String(r.floorTok).padEnd(11)}${String(r.comboTok).padEnd(12)}${('+' + r.deltaTokPct + '%').padEnd(7)}${String(r.meanFloor).padEnd(9)}${String(r.meanCombo).padEnd(14)}${r.lift >= 0 ? '+' : ''}${r.lift}`);
}
console.log(''.padEnd(100, '-'));
console.log(`AVERAGE quality: floor=${out.avgFloor}  floor+atlas=${out.avgCombo}  LIFT=${out.avgLift >= 0 ? '+' : ''}${out.avgLift} pt   (Graphify claim shape: 70.8 → 82.0 = +11.2pt)`);
console.log(`wrote bench/results-coverage-lift.json\n`);
await mcp.close();
