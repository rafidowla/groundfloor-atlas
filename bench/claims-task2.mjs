/**
 * bench/claims-task2.mjs — GitNexus 74%-token / 88%-tool-call reduction claims,
 * measured on the Task-1 symbol (slugSymbolName, src/parser/walkers/_base.ts).
 *
 * Atlas arm   : ONE atlas_blast_radius call over MCP; tokens = chars/3.5 of the
 *               tool's returned text (same toks() as bench/run.mjs).
 * Grep arm A  ("lean verified"): the exact call sequence a careful developer
 *               needs — name grep → read definition file → caller greps →
 *               spot-check reads that verify the chain is real code (the same
 *               discipline used to build the Task-1 ground truth).
 * Grep arm B  ("floor agent"): the Graphify-style floor workflow — chain three
 *               greps (slugSymbolName → buildSymbolId → makeParsedSymbol), then
 *               READ every hit file in full. Upper bound on floor cost.
 *
 * Token accounting = chars consumed / 3.5 for every artifact the developer (or
 * agent) actually ingests: grep matched-line output + file bytes read.
 *
 * Run: ATLAS_HOME=~/.groundfloor/atlas BENCH_WS=groundfloor-atlas node bench/claims-task2.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const HOME = process.env.ATLAS_HOME || path.join(process.env.HOME, '.atlas-demo');
const PORT = process.env.ATLAS_PORT || '3848';
const WS = process.env.BENCH_WS || 'atlas';
const SYMBOL = 'slugSymbolName';
const toks = (s) => Math.round((s || '').length / 3.5);

const token = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const mcp = new Client({ name: 'atlas-claims-task2', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

// ── atlas arm: 1 call ─────────────────────────────────────────────────────────
const atlasOut = (await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: 'atlas_blast_radius', args: { workspace: WS, symbol: SYMBOL } } })).content?.[0]?.text ?? '';
await mcp.close();
const atlasTok = toks(atlasOut);

// ── grep machinery (matched-line output, grep -rn equivalent) ─────────────────
const SRC = path.join(REPO, 'src');
function walk(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
    }
    return acc;
}
const files = walk(SRC).sort();
function grepLines(pattern) {
    const re = new RegExp(pattern);
    const out = [];
    for (const f of files) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        lines.forEach((l, i) => { if (re.test(l)) out.push(`${path.relative(REPO, f)}:${i + 1}:${l}`); });
    }
    return out;
}
const grep1 = grepLines(SYMBOL).join('\n');                       // slugSymbolName
const grep2 = grepLines('makeParsedSymbol|buildSymbolId').join('\n'); // callers chain
const grep2b = grepLines('buildSymbolId').join('\n');             // arm B step 2
const grep3 = grepLines('makeParsedSymbol').join('\n');           // arm B step 3
const readFull = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readRange = (rel, from, to) => readFull(rel).split('\n').slice(from - 1, to).join('\n');

// ── arm A: lean verified (the actual Task-1 workflow) ────────────────────────
const armA = [
    { call: 'grep -rn slugSymbolName src/', tok: toks(grep1) },
    { call: 'read src/parser/walkers/_base.ts (full, 296 lines)', tok: toks(readFull('src/parser/walkers/_base.ts')) },
    { call: 'grep -rnE "makeParsedSymbol|buildSymbolId" src/', tok: toks(grep2) },
    { call: 'grep -rn buildSymbolId src/parser/walkers/graphql.ts (unused-import check)', tok: toks(grep2b.split('\n').filter((l) => l.includes('graphql')).join('\n')) },
    { call: 'read ruby.ts:81-133 (verify extractInBody)', tok: toks(readRange('src/parser/walkers/ruby.ts', 81, 133)) },
    { call: 'read rust.ts:47-73 (verify pushSimple)', tok: toks(readRange('src/parser/walkers/rust.ts', 47, 73)) },
    { call: 'read typescript.ts:569-603 (verify extractCjsExports.emit)', tok: toks(readRange('src/parser/walkers/typescript.ts', 569, 603)) },
    { call: 'read aql.ts:70-113 (verify walk)', tok: toks(readRange('src/parser/walkers/aql.ts', 70, 113)) },
    { call: 'read csharp.ts:86-148 (verify extractInBody/visitChild)', tok: toks(readRange('src/parser/walkers/csharp.ts', 86, 148)) },
];

// ── arm B: floor agent (grep -l chain + full reads of every hit file) ────────
const hitFilesB = ['src/parser/walkers/_base.ts', 'src/parser/walkers/graphql.ts',
    ...['aql', 'cpp', 'csharp', 'go', 'graphql', 'java', 'kotlin', 'php', 'prisma', 'python', 'ruby', 'rust', 'sql', 'swift', 'typescript'].map((w) => `src/parser/walkers/${w}.ts`)];
const uniqB = [...new Set(hitFilesB)];
const armB = [
    { call: `grep -rnl slugSymbolName src/  (1 hit)`, tok: toks(grepLines(SYMBOL).map((l) => l.split(':').slice(0, 1)).join('\n')) },
    { call: 'read _base.ts (full)', tok: toks(readFull('src/parser/walkers/_base.ts')) },
    { call: 'grep -rnl buildSymbolId src/  (2 hits incl. comment in typescript.ts)', tok: toks([...new Set(grep2b.split('\n').map((l) => l.split(':')[0]))].join('\n')) },
    { call: 'read graphql.ts (full)', tok: toks(readFull('src/parser/walkers/graphql.ts')) },
    { call: 'grep -rnl makeParsedSymbol src/  (16 hits)', tok: toks([...new Set(grep3.split('\n').map((l) => l.split(':')[0]))].join('\n')) },
    ...uniqB.filter((f) => f !== 'src/parser/walkers/_base.ts' && f !== 'src/parser/walkers/graphql.ts')
        .map((f) => ({ call: `read ${f.replace('src/parser/walkers/', '')} (full)`, tok: toks(readFull(f)) })),
];

const sum = (a) => a.reduce((x, y) => x + y.tok, 0);
const callsA = armA.length, callsB = armB.length, tokA = sum(armA), tokB = sum(armB);

// ── report ────────────────────────────────────────────────────────────────────
const P = (s, n) => String(s).padEnd(n);
console.log(`\nTask 2 — tool-call + token accounting for "${SYMBOL}" impact question\n`);
console.log(`ATLAS arm: 1 call (atlas_blast_radius), ${atlasTok} tok (output ${atlasOut.length} chars)\n`);
console.log('GREP arm A — lean verified workflow:');
for (const s of armA) console.log(`  ${P(s.call, 72)} ${s.tok} tok`);
console.log(`  ${P('TOTAL', 72)} ${callsA} calls, ${tokA} tok`);
console.log(`  → vs atlas: ${Math.round((1 - 1 / callsA) * 100)}% fewer calls, ${Math.round((1 - atlasTok / tokA) * 100)}% fewer tokens\n`);
console.log('GREP arm B — floor agent (read every hit file in full):');
for (const s of armB) console.log(`  ${P(s.call, 72)} ${s.tok} tok`);
console.log(`  ${P('TOTAL', 72)} ${callsB} calls, ${tokB} tok`);
console.log(`  → vs atlas: ${Math.round((1 - 1 / callsB) * 100)}% fewer calls, ${Math.round((1 - atlasTok / tokB) * 100)}% fewer tokens\n`);
console.log('GitNexus claims: 74% retrieval-token reduction, 88% tool-call reduction (13,750→3,500 tok, 58→7 calls).');
console.log(`Measured here: token cut A=${Math.round((1 - atlasTok / tokA) * 100)}% B=${Math.round((1 - atlasTok / tokB) * 100)}%; call cut A=${Math.round((1 - 1 / callsA) * 100)}% B=${Math.round((1 - 1 / callsB) * 100)}%.\n`);
fs.writeFileSync(path.join(REPO, 'bench', 'results-claims-task2.json'), JSON.stringify({
    symbol: SYMBOL, workspace: WS,
    atlas: { calls: 1, tok: atlasTok, outChars: atlasOut.length },
    grepLean: { calls: callsA, tok: tokA, steps: armA },
    grepFloor: { calls: callsB, tok: tokB, steps: armB },
    claims: { gitnexusTokenPct: 74, gitnexusCallPct: 88 },
}, null, 2));
console.log('wrote bench/results-claims-task2.json\n');
