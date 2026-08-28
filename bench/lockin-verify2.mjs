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
const mcp = new Client({ name: 'lockin-verify2', version: '1.0' }, { capabilities: {} });
await mcp.connect(transport);

async function callTool(name, args) {
    const r = await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } });
    return r.content?.[0]?.text ?? '';
}

// Try recall with larger limit/mode
console.log('=== recall mode=full limit=50 ===');
const r1 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', limit: 50, mode: 'full' });
console.log(String(r1).slice(0, 4000));

// Try recall with type filter for decisions only
console.log('\n=== recall type=decision ===');
const r2 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', limit: 50, type: 'decision' });
console.log(String(r2).slice(0, 3000));

// Try knowledge_search with higher limit
console.log('\n=== search semantic limit=30 ===');
const r3 = await callTool('knowledge_search', { q: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', limit: 30, search_mode: 'semantic' });
const parsed = JSON.parse(r3);
console.log('count:', parsed.results?.length, 'ids:');
for (const h of (parsed.results ?? [])) console.log(' ', h.id, '|', h.type, '|', h.label);

// Search exact id
console.log('\n=== search keyword lockin ===');
const r4 = await callTool('knowledge_search', { q: 'lockin-dec-001', workspace: 'dayjs-lockin', limit: 10 });
console.log(String(r4).slice(0, 1500));

// Search for backoff
console.log('\n=== search keyword backoff ===');
const r5 = await callTool('knowledge_search', { q: 'backoff', workspace: 'dayjs-lockin', limit: 10, search_mode: 'keyword' });
console.log(String(r5).slice(0, 1500));

// Search semantic for backoff
console.log('\n=== search semantic backoff ===');
const r6 = await callTool('knowledge_search', { q: 'exponential backoff thundering herd', workspace: 'dayjs-lockin', limit: 10, search_mode: 'semantic' });
console.log(String(r6).slice(0, 2500));

await mcp.close();
process.exit(0);
