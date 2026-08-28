import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.ATLAS_HOME || path.join(os.homedir(), '.atlas-demo');
const PORT = process.env.ATLAS_PORT || '3848';
const tokenStr = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${tokenStr}` } } },
);
const mcp = new Client({ name: 'probe', version: '1.0' }, { capabilities: {} });
await mcp.connect(transport);

async function callTool(name, args) {
    // Atlas exposes Lore tools via atlas_tool_invoke wrapper
    const r = await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } });
    return r.content?.[0]?.text ?? '';
}

const q = 'how to handle flaky downstream APIs';
const workspace = 'memtest-dst';
const TARGET = 'dec-backoff-2026-06';

function hitsOf(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.hits)) return parsed.hits;
    if (Array.isArray(parsed?.results)) return parsed.results;
    if (Array.isArray(parsed?.nodes)) return parsed.nodes;
    if (Array.isArray(parsed?.items)) return parsed.items;
    return [];
}

async function probe(label, args) {
    const raw = await callTool('knowledge_search', args);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const hits = hitsOf(parsed);
    const ids = hits.map((h) => h?.id || h?.node_id || h?.label || JSON.stringify(h).slice(0, 60));
    const containsTarget = JSON.stringify(parsed ?? raw).includes(TARGET);
    console.log(`\n=== ${label} ===`);
    console.log('args:', JSON.stringify(args));
    console.log('count:', hits.length, 'foundTarget:', containsTarget);
    console.log('ids:', ids.slice(0, 10));
    if (hits.length === 0) {
        console.log('raw (first 500):', String(raw).slice(0, 500));
    }
    return { label, args, count: hits.length, foundTarget: containsTarget, ids };
}

const a = await probe('a) semantic',
    { q, workspace, limit: 5, search_mode: 'semantic' });
const b = await probe('b) hybrid',
    { q, workspace, limit: 5, search_mode: 'hybrid' });
const c = await probe('c) default (no search_mode)',
    { q, workspace, limit: 5 });
const d = await probe('d) keyword: backoff',
    { q: 'backoff', workspace, limit: 5, search_mode: 'keyword' });

// Regression check: knowledge_recall
const rRaw = await callTool('knowledge_recall', { topic: q, workspace });
let rParsed;
try { rParsed = JSON.parse(rRaw); } catch { rParsed = null; }
const recallHasTarget = JSON.stringify(rParsed ?? rRaw).includes(TARGET);
console.log('\n=== knowledge_recall regression check ===');
console.log('hasTarget:', recallHasTarget);
console.log('raw (first 600):', String(rRaw).slice(0, 600));

const summary = {
    a, b, c, d,
    recallHasTarget,
};
console.log('\nSUMMARY:', JSON.stringify(summary));

await mcp.close();
process.exit(0);
