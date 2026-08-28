import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.ATLAS_HOME || path.join(os.homedir(), '.atlas-lockin-B');
const PORT = process.env.ATLAS_PORT || '3848';
const tokenStr = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${tokenStr}` } } },
);
const mcp = new Client({ name: 'lockin-verify', version: '1.0' }, { capabilities: {} });
await mcp.connect(transport);

async function callTool(name, args) {
    const r = await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } });
    return r.content?.[0]?.text ?? '';
}

function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function extractHits(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.hits)) return parsed.hits;
    if (Array.isArray(parsed?.results)) return parsed.results;
    if (Array.isArray(parsed?.nodes)) return parsed.nodes;
    if (Array.isArray(parsed?.items)) return parsed.items;
    return [];
}

const TARGET = 'lockin-dec-001';
const workspace = 'dayjs-lockin';
const q = 'how to handle flaky downstream APIs';

const t0 = Date.now();

// QUERY 1: knowledge_recall
console.log('\n=== QUERY 1: knowledge_recall ===');
const recallRaw = await callTool('knowledge_recall', { topic: q, workspace });
const recallParsed = tryParse(recallRaw);
const recallHits = extractHits(recallParsed);
const recallIds = recallHits.map(h => h?.id || h?.node_id || h?.label || JSON.stringify(h).slice(0, 80));
const recallFoundDecision = JSON.stringify(recallParsed ?? recallRaw).includes(TARGET);
let recallTopScore = null;
if (recallHits.length > 0) {
    const h0 = recallHits[0];
    recallTopScore = h0?.score ?? h0?.similarity ?? h0?.distance ?? h0?._score ?? null;
}
console.log('ids:', recallIds.slice(0, 10));
console.log('foundDecision:', recallFoundDecision, 'topScore:', recallTopScore);
console.log('raw first 800:', String(recallRaw).slice(0, 800));

// QUERY 2: knowledge_search semantic
console.log('\n=== QUERY 2: knowledge_search semantic ===');
const searchRaw = await callTool('knowledge_search', { q, workspace, limit: 5, search_mode: 'semantic' });
const searchParsed = tryParse(searchRaw);
const searchHits = extractHits(searchParsed);
const searchIds = searchHits.map(h => h?.id || h?.node_id || h?.label || JSON.stringify(h).slice(0, 80));
const searchFoundDecision = JSON.stringify(searchParsed ?? searchRaw).includes(TARGET);
let searchTopScore = null;
if (searchHits.length > 0) {
    const h0 = searchHits[0];
    searchTopScore = h0?.score ?? h0?.similarity ?? h0?.distance ?? h0?._score ?? null;
}
console.log('ids:', searchIds.slice(0, 10));
console.log('foundDecision:', searchFoundDecision, 'topScore:', searchTopScore);
console.log('raw first 800:', String(searchRaw).slice(0, 800));

// QUERY 3: atlas_communities
console.log('\n=== QUERY 3: atlas_communities ===');
let communitiesRunsClean = false;
let communitiesCount = 0;
let communitiesTopLabels = [];
let communitiesRaw = '';
try {
    communitiesRaw = await callTool('atlas_communities', { workspace, min_size: 2 });
    const cParsed = tryParse(communitiesRaw);
    const comms = cParsed?.communities ?? extractHits(cParsed);
    communitiesCount = Array.isArray(comms) ? comms.length : 0;
    if (Array.isArray(comms)) {
        communitiesTopLabels = comms.slice(0, 5).map(c => c?.label ?? c?.name ?? c?.id ?? JSON.stringify(c).slice(0, 40));
    }
    communitiesRunsClean = cParsed !== null && (Array.isArray(comms) || comms !== undefined);
    console.log('count:', communitiesCount, 'labels:', communitiesTopLabels);
    console.log('raw first 600:', String(communitiesRaw).slice(0, 600));
} catch (e) {
    console.log('ERROR:', e?.message ?? String(e));
}

// QUERY 4: atlas_processes
console.log('\n=== QUERY 4: atlas_processes ===');
let processesRunsClean = false;
let processesStepCount = null;
let processesRaw = '';
try {
    processesRaw = await callTool('atlas_processes', { workspace, entry: 'Dayjs', max_depth: 4 });
    const pParsed = tryParse(processesRaw);
    // Documented shape: { candidates: [{steps:[], terminal: bool, ...}], chosen: {...} } or similar
    const chosen = pParsed?.chosen ?? (Array.isArray(pParsed?.candidates) && pParsed.candidates[0]);
    const steps = chosen?.steps ?? chosen?.path ?? chosen?.trace ?? [];
    processesStepCount = Array.isArray(steps) ? steps.length : (chosen?.stepCount ?? null);
    processesRunsClean = pParsed !== null && (pParsed?.candidates !== undefined || pParsed?.chosen !== undefined || pParsed?.trace !== undefined);
    console.log('stepCount:', processesStepCount, 'terminal:', chosen?.terminal);
    console.log('raw first 800:', String(processesRaw).slice(0, 800));
} catch (e) {
    console.log('ERROR:', e?.message ?? String(e));
}

const t1 = Date.now();
const queryWallClockSec = (t1 - t0) / 1000;

const summary = {
    recallHits: recallIds,
    recallFoundDecision,
    recallTopScore,
    searchTopScore,
    searchFoundDecision,
    communitiesCount,
    communitiesTopLabels,
    communitiesRunsClean,
    processesStepCount,
    processesRunsClean,
    queryWallClockSec,
};
console.log('\n===SUMMARY_JSON===');
console.log(JSON.stringify(summary, null, 2));

await mcp.close();
process.exit(0);
