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
const mcp = new Client({ name: 'rerank-probe-extra', version: '1.0' }, { capabilities: {} });
await mcp.connect(transport);

async function callTool(name, args) {
    const r = await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } });
    return r.content?.[0]?.text ?? '';
}

// 1. Bigger limit for the target query — see where lockin-dec-001 actually ranks
console.log('=== knowledge_search hybrid limit 30 for "how to handle flaky downstream APIs" ===');
const r1 = await callTool('knowledge_search', { q: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', limit: 30, search_mode: 'hybrid' });
const p1 = JSON.parse(r1);
const h1 = p1.hits || p1.results || p1 || [];
const all = Array.isArray(h1) ? h1 : [];
all.forEach((h, i) => {
    console.log(`#${i+1} ${h.id || h.node_id} [${h.type || h.knowledge_type || 'n/a'}] score=${h.score ?? h.similarity ?? 'n/a'}`);
});
const idx = all.findIndex(h => (h.id || h.node_id) === 'lockin-dec-001');
console.log('lockin-dec-001 rank at limit 30:', idx + 1 || 'NOT FOUND');

// 2. Check default recall limit
console.log('\n=== knowledge_recall default for "how to handle flaky downstream APIs" — RAW ===');
const r2 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin' });
console.log(r2);

await mcp.close();
process.exit(0);
