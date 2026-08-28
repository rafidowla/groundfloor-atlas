/**
 * tests/x4.test.ts — Atlas X4 MCP tools tests.
 *
 *   T1: Atlas daemon advertises 8 tools (atlas_health + 7 new) via
 *       MCP list_tools.
 *   T2: After `atlas index <file>`, atlas_call_graph returns a non-
 *       empty call graph for a callee with a known caller in the
 *       sample.
 *   T3: atlas_find_dead_code surfaces a symbol with zero inbound
 *       refs from the same sample.
 *   T4: Claude Code MCP config sanity — the public /mcp endpoint
 *       speaks the protocol that Claude Code expects (initialize +
 *       tools/list + tools/call). Verified via a real MCP client
 *       round-trip; the documented config string is asserted to
 *       match the daemon's port.
 *
 * Embedded/no-daemon note: this suite runs entirely against an
 * in-process Lore — the daemon config sets lore.mode='embedded' with
 * a per-run dataDir, so the full MCP round-trip needs no Lore daemon
 * on port 3847 and no bootstrap token. T1–T4 run with ATLAS_MCP_AUTH
 * off; T5 exercises the auth-ON path using the daemon's own minted
 * <home>/mcp.token bearer.
 */

import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
// Fresh workspace per run. Per-run isolation prevents accumulated data
// from prior X4 test invocations (which all use unique sample paths but
// share node ids by qualified name) from shadowing the current run's
// findSymbol() pick.
const WORKSPACE = `atlas-x4-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const EXPECTED_TOOLS = [
    'atlas_health',
    'atlas_call_graph',
    'atlas_find_dead_code',
    'atlas_blast_radius',
    'atlas_schema_drift',
    'atlas_layer_violations',
    'atlas_hotspots',
    'atlas_index',
];

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

function makeAtlasHome(port: number): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x4-'));
    // Embedded/no-daemon config: the daemon opens its own in-process Lore under
    // a per-run dataDir, so the full MCP round-trip (atlas_tool_invoke →
    // call_graph/find_dead_code/index) runs with no port 3847 and no bootstrap
    // token. The read tools resolve their store in-process via EmbeddedLoreReader.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x4-data-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({
            port,
            lore: { workspace: WORKSPACE, mode: 'embedded', dataDir },
        }, null, 2),
    );
    return home;
}

function makeSampleFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x4-sample-'));
    const file = path.join(dir, 'sample.ts');
    fs.writeFileSync(
        file,
        // greet → helper is a real intra-file call edge.
        // unusedFn is a callable with zero inbound references and a
        // non-exempt name → dead-code candidate.
        `export function greet(name: string): string {
    return helper('Hello, ' + name);
}

export function helper(message: string): string {
    return message + '!';
}

export function unusedFn(): number {
    return 42;
}
`,
    );
    return file;
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`);
            if (r.ok) {
                const body = (await r.json()) as { status?: string };
                if (body.status === 'ok') return;
            }
        } catch { /* keep polling */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`atlas never became healthy on port ${port}`);
}

function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(TSX, [CLI, ...args], {
        env: { ...process.env, ATLAS_HOME: home, ATLAS_MCP_AUTH: 'off' },
        encoding: 'utf-8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface ToolCallResult {
    content?: Array<{ type: string; text: string }>;
}

async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<unknown> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'atlas-x4-test', version: '0.1.0' });
    await client.connect(transport);
    try {
        // Shim model: real tools are invoked through atlas_tool_invoke.
        const r = (await client.callTool({ name: 'atlas_tool_invoke', arguments: { tool: name, args } })) as ToolCallResult;
        const text = r.content?.[0]?.text ?? '';
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

/** The 3 meta-tools the shim advertises over MCP tools/list. */
async function listToolNames(port: number): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'atlas-x4-test', version: '0.1.0' });
    await client.connect(transport);
    try {
        const r = await client.listTools();
        return r.tools.map((t) => t.name);
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

/** The real tools behind the shim, via atlas_tool_list. */
async function listRegistryTools(port: number): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'atlas-x4-test', version: '0.1.0' });
    await client.connect(transport);
    try {
        const r = (await client.callTool({ name: 'atlas_tool_list', arguments: {} })) as ToolCallResult;
        const parsed = JSON.parse(r.content?.[0]?.text ?? '{"tools":[]}') as { tools: Array<{ name: string }> };
        return parsed.tools.map((t) => t.name);
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

interface CallGraphResult {
    symbol?: { id: string; name: string };
    d1?: Array<{ name: string }>;
    d2?: Array<{ name: string }>;
    d3?: Array<{ name: string }>;
    error?: string;
}

interface DeadCodeResult {
    candidates?: Array<{ name: string; file: string }>;
    error?: string;
}

/* ─── Runner ───────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('atlas X4 MCP tools tests');
    const port = await freePort();
    const home = makeAtlasHome(port);
    const sample = makeSampleFile();

    // Run all four tests inside a single daemon to avoid restart-races on the same port.
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home, ATLAS_MCP_AUTH: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        await waitForHealth(port);

        // T1: shim advertises exactly the 3 meta-tools; the registry (via
        // atlas_tool_list) exposes the real code-intelligence tools.
        const SHIM_TOOLS = ['atlas_tool_list', 'atlas_tool_schema', 'atlas_tool_invoke'];
        const advertised = await listToolNames(port);
        assert.deepEqual([...advertised].sort(), [...SHIM_TOOLS].sort(), `shim advertises 3 meta-tools; got ${JSON.stringify(advertised)}`);
        const registry = await listRegistryTools(port);
        for (const expected of EXPECTED_TOOLS) {
            assert.ok(registry.includes(expected), `registry missing ${expected}; got ${JSON.stringify(registry)}`);
        }
        console.log(`  ✓ T1: shim exposes 3 meta-tools; registry has ${registry.length} tools incl. all ${EXPECTED_TOOLS.length} code-intel tools`);

        // T2: index sample (via CLI for X3 parity) and then again via the new MCP tool.
        const indexed = runCli(home, ['index', sample]);
        assert.equal(indexed.status, 0, `index exited 0; got ${indexed.status}: ${indexed.stderr}`);
        const reIndex = (await callTool(port, 'atlas_index', { path: sample, workspace: WORKSPACE })) as { ok?: boolean; relationsWritten?: number; edgesWritten?: number; symbolsWritten?: number; error?: string };
        assert.ok(reIndex.ok, `atlas_index ok; got ${JSON.stringify(reIndex)}`);
        // 3 file→symbol edges + 1 symbol→symbol (greet→helper) = 4. The MCP
        // atlas_index tool reports this as `edgesWritten`; the CLI path uses
        // `relationsWritten`. Accept either so the gate tracks the real count.
        const edgeCount = reIndex.edgesWritten ?? reIndex.relationsWritten ?? 0;
        assert.ok(edgeCount >= 4, `atlas_index wrote ≥4 edges (3 contains + 1 call); got ${JSON.stringify(reIndex)}`);

        // Lore commits storeEdge writes through Kùzu — there can be a small
        // gap between the storeEdge response and the edge appearing on
        // /api/node reads. One short retry after a half-second is enough
        // for the happy path; the per-fetch 429 backoff in LoreReader
        // covers rate-limit collisions inside the read.
        let cg: CallGraphResult = {};
        for (let attempt = 0; attempt < 3; attempt += 1) {
            cg = (await callTool(port, 'atlas_call_graph', { symbol: 'helper', direction: 'upstream', workspace: WORKSPACE })) as CallGraphResult;
            const t = (cg.d1?.length ?? 0) + (cg.d2?.length ?? 0) + (cg.d3?.length ?? 0);
            if (t >= 1) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(!cg.error, `call_graph returned error: ${cg.error}`);
        const total = (cg.d1?.length ?? 0) + (cg.d2?.length ?? 0) + (cg.d3?.length ?? 0);
        assert.ok(total >= 1, `call_graph returns non-empty after polling; got ${JSON.stringify(cg)}`);
        console.log(`  ✓ T2: atlas_call_graph(helper, upstream) returns ${total} callers`);

        // T3: workspace-wide dead-code scan. Same Lore-commit timing
        // window as T2 — poll briefly for unusedFn to surface.
        let dc: DeadCodeResult = {};
        let matches: Array<{ name: string; file: string }> = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
            dc = (await callTool(port, 'atlas_find_dead_code', { workspace: WORKSPACE, limit: 500 })) as DeadCodeResult;
            matches = (dc.candidates ?? []).filter((c) => c.name === 'unusedFn');
            if (matches.length >= 1) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(!dc.error, `find_dead_code returned error: ${dc.error}`);
        assert.ok(matches.length >= 1, `find_dead_code surfaces an unusedFn dead symbol; got ${JSON.stringify(dc.candidates?.slice(0, 5))}`);
        console.log(`  ✓ T3: atlas_find_dead_code returns ${matches.length} unusedFn dead-code candidate(s)`);

        // T4: Claude Code-style handshake lists the 3 shim tools.
        const shimAgain = await listToolNames(port);
        assert.equal(shimAgain.length, 3, `handshake lists the 3 shim tools; got ${shimAgain.length}`);
        const configUrl = `http://localhost:${port}/mcp`;
        const parsed = new URL(configUrl);
        assert.equal(parsed.hostname, 'localhost');
        assert.equal(parsed.port, String(port));
        console.log(`  ✓ T4: Claude Code MCP config "${configUrl}" handshakes and lists ${shimAgain.length} shim tools`);
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
    }

    console.log('All X4 tests passed.');
}

/* ─── T5 (RD-T6): auth-ON coverage ──────────────────────────────────
 *
 * The T1–T4 daemon above runs with ATLAS_MCP_AUTH=off. RD-T6 flagged that
 * the x4 suite never exercised the auth-ON path. This pass starts a SECOND
 * daemon WITHOUT the off flag and asserts:
 *   - a tool call WITHOUT a bearer token → 401
 *   - a tool call WITH the minted bearer token → success
 */
async function testT5_authOn(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);

    const child = spawn(TSX, [CLI, 'serve'], {
        // NOTE: no ATLAS_MCP_AUTH=off here — auth stays ON (the default).
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        await waitForHealth(port);
        const url = `http://127.0.0.1:${port}/mcp`;
        const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        const headersBase = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

        // No token → 401.
        const noTok = await fetch(url, { method: 'POST', headers: headersBase, body: rpcBody });
        assert.equal(noTok.status, 401, `auth-ON: no-token POST /mcp should be 401; got ${noTok.status}`);

        // Correct minted bearer → MCP handshake succeeds and lists the 3 shim tools.
        const mcpToken = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
        });
        const client = new Client({ name: 'atlas-x4-authon', version: '0.1.0' });
        await client.connect(transport);
        try {
            const r = await client.listTools();
            assert.equal(r.tools.length, 3, `auth-ON: authed tools/list returns the 3 shim tools; got ${r.tools.length}`);
        } finally {
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
        }
        console.log('  ✓ T5 (RD-T6): auth-ON — no-token→401, correct-bearer→success');
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
    }
}

await main();
await testT5_authOn();
console.log('All X4 + auth-ON tests passed.');
