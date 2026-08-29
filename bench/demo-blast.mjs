// demo: one live atlas_blast_radius call — the compact structured answer an agent gets back
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.ATLAS_HOME || path.join(process.env.HOME, '.atlas-demo');
const PORT = process.env.ATLAS_PORT || '3848';
const WS = process.env.BENCH_WS || 'atlas';
const token = fs.readFileSync(path.join(HOME, 'mcp.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const mcp = new Client({ name: 'atlas-demo-blast', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);
const out = (await mcp.callTool({ name: 'atlas_tool_invoke', arguments: { tool: 'atlas_blast_radius', args: { workspace: WS, symbol: 'slugSymbolName' } } })).content?.[0]?.text ?? '';
await mcp.close();
const j = JSON.parse(out);
console.log(`atlas_blast_radius(workspace="${WS}", symbol="slugSymbolName") →`);
console.log(JSON.stringify({
    symbol: j.symbol.name,
    kind: j.symbol.kind,
    at: `${j.symbol.file}:${j.symbol.line}`,
    callers: {
        d1: j.d1.map((e) => e.name),
        d2: j.d2.map((e) => e.name),
        d3_call_sites: j.d3.length, d3_files: new Set(j.d3.map((e) => e.file)).size,
        d3_fns: [...new Set(j.d3.map((e) => e.name))],
    },
}, null, 2));
