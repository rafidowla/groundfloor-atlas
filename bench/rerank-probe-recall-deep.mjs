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
const mcp = new Client({ name: 'rerank-recall-deep', version: '1.0' }, { capabilities: {} });
await mcp.connect(transport);

async function callTool(name, args) {
    const r = await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } });
    return r.content?.[0]?.text ?? '';
}

// Try with explicit depth / mode
console.log('=== knowledge_recall with depth=30 ===');
const r1 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', depth: 30 });
try {
    const p = JSON.parse(r1);
    console.log('shown:', p.shown, 'totalRecalled:', p.totalRecalled);
    (p.hits || []).forEach((h, i) => console.log(`#${i+1} ${h.id} [${h.type}]`));
} catch (e) { console.log('raw:', r1.slice(0, 1000)); }

console.log('\n=== knowledge_recall with limit=30 ===');
const r2 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', limit: 30 });
try {
    const p = JSON.parse(r2);
    console.log('shown:', p.shown, 'totalRecalled:', p.totalRecalled);
    (p.hits || []).forEach((h, i) => console.log(`#${i+1} ${h.id} [${h.type}]`));
} catch (e) { console.log('raw:', r2.slice(0, 1000)); }

console.log('\n=== knowledge_recall mode=detail ===');
const r3 = await callTool('knowledge_recall', { topic: 'how to handle flaky downstream APIs', workspace: 'dayjs-lockin', mode: 'detail' });
try {
    const p = JSON.parse(r3);
    console.log('shown:', p.shown, 'totalRecalled:', p.totalRecalled);
    (p.hits || []).forEach((h, i) => console.log(`#${i+1} ${h.id} [${h.type}]`));
} catch (e) { console.log('raw:', r3.slice(0, 1000)); }

await mcp.close();
process.exit(0);
