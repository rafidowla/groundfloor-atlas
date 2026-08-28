/**
 * tests/health.test.ts — Atlas X2 sanity test.
 *
 * Covers all 3 X2 spec scenarios:
 *   T1 (build): tsc runs cleanly. Tested out-of-band via `npm run build`;
 *       this file is a build artifact.
 *   T2 (daemon lifecycle): spawn `atlas serve`, call `atlas health`,
 *       expect status=ok; send SIGTERM and verify the process exits 0.
 *   T3 (MCP client): connect to /mcp via StreamableHTTPClientTransport,
 *       call `atlas_health` tool, verify the response payload.
 *
 * Each test uses an ephemeral port via ATLAS_HOME → config.json so the
 * suite can run in parallel with the real launchd-managed Atlas daemon
 * if one is ever installed locally.
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x2-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }, null, 2));
    return home;
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`);
            if (r.ok) {
                const body = (await r.json()) as { status?: string };
                if (body.status === 'ok') return;
            }
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`daemon never became healthy on port ${port}: ${String(lastErr)}`);
}

/* ─── T2: daemon lifecycle ──────────────────────────────────────── */

async function testT2_serveHealthShutdown(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
    });

    try {
        await waitForHealth(port);

        // `atlas health` against this daemon's port should print status:ok.
        const healthOut = await new Promise<string>((resolve, reject) => {
            const r = spawn(TSX, [CLI, 'health', '--port', String(port)], {
                env: { ...process.env, ATLAS_HOME: home },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            r.stdout.on('data', (d: Buffer) => { out += d.toString(); });
            r.once('exit', (code) => {
                if (code === 0) resolve(out);
                else reject(new Error(`atlas health exited ${code}`));
            });
        });
        const parsed = JSON.parse(healthOut.trim()) as { status?: string };
        assert.equal(parsed.status, 'ok', `expected status=ok; got ${healthOut}`);
        console.log('  ✓ T2: atlas serve + atlas health returns status=ok');
    } finally {
        child.kill('SIGTERM');
    }
    const exitCode = await Promise.race([
        exitPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    assert.equal(exitCode, 0, `daemon should exit 0 on SIGTERM; got ${exitCode}`);
    console.log('  ✓ T2: daemon exits cleanly on SIGTERM (code 0)');
}

/* ─── T3: MCP client connects + shim surface works ──────────────── */

async function testT3_mcpClientCallsAtlasHealth(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
    });

    try {
        await waitForHealth(port);

        // Auth is ON by default; the daemon mints mcp.token in ATLAS_HOME on boot.
        const token = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        const client = new Client({ name: 'atlas-x2-test', version: '0.1.0' });
        await client.connect(transport);

        // Shim exposes exactly three meta-tools; real tools are hidden behind them.
        const tools = await client.listTools();
        const toolNames = tools.tools.map((t) => t.name);
        const SHIM_TOOLS = ['atlas_tool_list', 'atlas_tool_schema', 'atlas_tool_invoke'];
        for (const shimTool of SHIM_TOOLS) {
            assert.ok(toolNames.includes(shimTool), `tools/list contains ${shimTool}; got ${JSON.stringify(toolNames)}`);
        }
        assert.equal(toolNames.length, SHIM_TOOLS.length, `MCP surface has exactly ${SHIM_TOOLS.length} tools; got ${toolNames.length}`);

        // atlas_tool_list returns atlas_health in the registry.
        const listRes = await client.callTool({ name: 'atlas_tool_list', arguments: {} });
        const listContent = listRes.content as Array<{ type: string; text: string }>;
        const listed = JSON.parse(listContent[0]!.text) as { tools: Array<{ name: string }> };
        const registeredNames = listed.tools.map((t) => t.name);
        assert.ok(registeredNames.includes('atlas_health'), `atlas_tool_list includes atlas_health; got ${JSON.stringify(registeredNames)}`);

        // atlas_tool_invoke dispatches to atlas_health correctly.
        const callRes = await client.callTool({ name: 'atlas_tool_invoke', arguments: { tool: 'atlas_health', args: {} } });
        const content = callRes.content as Array<{ type: string; text: string }>;
        assert.ok(Array.isArray(content) && content.length > 0, 'callTool returns content');
        const payload = JSON.parse(content[0]!.text) as { status?: string; version?: string; uptime_ms?: number };
        assert.equal(payload.status, 'ok', `atlas_health via shim status === "ok"; got ${JSON.stringify(payload)}`);
        assert.ok(typeof payload.version === 'string' && payload.version.length > 0, 'version present');
        assert.ok(typeof payload.uptime_ms === 'number' && payload.uptime_ms >= 0, 'uptime_ms numeric');

        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        console.log('  ✓ T3: MCP shim surface — 3 meta-tools, atlas_health reachable via atlas_tool_invoke');
    } finally {
        child.kill('SIGTERM');
        await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    }
}

/* ─── T4: /mcp auth gate rejects unauthorized callers (review #1) ── */

async function testT4_authGateRejects(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
    });
    const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headersBase = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    try {
        await waitForHealth(port);
        const url = `http://127.0.0.1:${port}/mcp`;

        // No token → 401.
        const noTok = await fetch(url, { method: 'POST', headers: headersBase, body: rpcBody });
        assert.equal(noTok.status, 401, `no-token POST /mcp should be 401; got ${noTok.status}`);

        // Wrong token → 401.
        const badTok = await fetch(url, {
            method: 'POST',
            headers: { ...headersBase, Authorization: 'Bearer not-the-real-token' },
            body: rpcBody,
        });
        assert.equal(badTok.status, 401, `bad-token POST /mcp should be 401; got ${badTok.status}`);

        // Foreign Origin (simulated malicious web page) → 403, even with a token.
        const token = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        const badOrigin = await fetch(url, {
            method: 'POST',
            headers: { ...headersBase, Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' },
            body: rpcBody,
        });
        assert.equal(badOrigin.status, 403, `foreign-Origin POST /mcp should be 403; got ${badOrigin.status}`);

        console.log('  ✓ T4: /mcp rejects no-token (401), bad-token (401), foreign-Origin (403)');
    } finally {
        child.kill('SIGTERM');
        await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    }
}

/* ─── Runner ───────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('atlas X2 sanity tests');
    await testT2_serveHealthShutdown();
    await testT3_mcpClientCallsAtlasHealth();
    await testT4_authGateRejects();
    console.log('All X2 tests passed.');
}

await main();
