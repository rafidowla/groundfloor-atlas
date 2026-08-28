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
const mcp = new Client({ name: 'rerank-probe', version: '1.0' }, { capabilities: {} });
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

function summarizeHits(hits) {
    return hits.map(h => {
        const id = h?.id || h?.node_id || h?.label || '<unknown>';
        const type = h?.type || h?.node_type || h?.kind || h?.knowledge_type || '<no-type>';
        const score = h?.score ?? h?.similarity ?? h?._score ?? null;
        return { id, type, score };
    });
}

const TARGET = 'lockin-dec-001';
const workspace = 'dayjs-lockin';
const q = 'how to handle flaky downstream APIs';

const results = {};

// (a) knowledge_recall DEFAULT LIMIT
console.log('\n=== (a) knowledge_recall DEFAULT LIMIT: "' + q + '" ===');
const aRaw = await callTool('knowledge_recall', { topic: q, workspace });
const aParsed = tryParse(aRaw);
const aHits = extractHits(aParsed);
const aSummary = summarizeHits(aHits);
const aTop5 = aSummary.slice(0, 5);
const aFoundInTop5 = aTop5.some(h => h.id === TARGET);
const aFoundAnywhere = aSummary.some(h => h.id === TARGET);
console.log('total hits:', aSummary.length);
console.log('top 5:', JSON.stringify(aTop5, null, 2));
console.log('found in top 5:', aFoundInTop5, 'found anywhere:', aFoundAnywhere);
if (!aFoundInTop5 && aFoundAnywhere) {
    const idx = aSummary.findIndex(h => h.id === TARGET);
    console.log('lockin-dec-001 at rank:', idx + 1);
}
results.a = { top5: aTop5, foundInTop5: aFoundInTop5, foundAnywhere: aFoundAnywhere, total: aSummary.length };

// (b) knowledge_search semantic limit 5
console.log('\n=== (b) knowledge_search semantic limit 5 ===');
const bRaw = await callTool('knowledge_search', { q, workspace, limit: 5, search_mode: 'semantic' });
const bParsed = tryParse(bRaw);
const bHits = extractHits(bParsed);
const bSummary = summarizeHits(bHits);
const bTop5 = bSummary.slice(0, 5);
const bFoundInTop5 = bTop5.some(h => h.id === TARGET);
console.log('top 5:', JSON.stringify(bTop5, null, 2));
console.log('found in top 5:', bFoundInTop5);
results.b = { top5: bTop5, foundInTop5: bFoundInTop5 };

// (c) knowledge_search hybrid limit 5
console.log('\n=== (c) knowledge_search hybrid limit 5 ===');
const cRaw = await callTool('knowledge_search', { q, workspace, limit: 5, search_mode: 'hybrid' });
const cParsed = tryParse(cRaw);
const cHits = extractHits(cParsed);
const cSummary = summarizeHits(cHits);
const cTop5 = cSummary.slice(0, 5);
const cFoundInTop5 = cTop5.some(h => h.id === TARGET);
console.log('top 5:', JSON.stringify(cTop5, null, 2));
console.log('found in top 5:', cFoundInTop5);
results.c = { top5: cTop5, foundInTop5: cFoundInTop5 };

// (d) CONTROL: parse date string — should still return code_context
console.log('\n=== (d) CONTROL knowledge_search hybrid "parse date string" ===');
const dRaw = await callTool('knowledge_search', { q: 'parse date string', workspace, limit: 5, search_mode: 'hybrid' });
const dParsed = tryParse(dRaw);
const dHits = extractHits(dParsed);
const dSummary = summarizeHits(dHits);
const dTop5 = dSummary.slice(0, 5);
const dHasCodeContext = dTop5.some(h => h.type === 'code_context' || String(h.type).toLowerCase().includes('code'));
console.log('top 5:', JSON.stringify(dTop5, null, 2));
console.log('has code_context in top 5:', dHasCodeContext);
results.d = { top5: dTop5, hasCodeContext: dHasCodeContext };

// (e) REGRESSION: exponential backoff thundering herd
console.log('\n=== (e) REGRESSION knowledge_recall "exponential backoff thundering herd" ===');
const eRaw = await callTool('knowledge_recall', { topic: 'exponential backoff thundering herd', workspace });
const eParsed = tryParse(eRaw);
const eHits = extractHits(eParsed);
const eSummary = summarizeHits(eHits);
const eTop5 = eSummary.slice(0, 5);
const eFoundInTop5 = eTop5.some(h => h.id === TARGET);
const eRank = eSummary.findIndex(h => h.id === TARGET) + 1;
console.log('top 5:', JSON.stringify(eTop5, null, 2));
console.log('found in top 5:', eFoundInTop5, 'rank:', eRank);
results.e = { top5: eTop5, foundInTop5: eFoundInTop5, rank: eRank };

console.log('\n===SUMMARY_JSON===');
console.log(JSON.stringify(results, null, 2));

await mcp.close();
process.exit(0);
