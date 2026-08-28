/**
 * tests/audit-untested.test.ts — regression tests for the four fixes the first
 * two rounds couldn't cover: L4 (server close hang), M5 (alerts_dismiss in
 * embedded mode), M8 (CLI hang on daemon fall-through). (M9, the Tauri token
 * fallback, lives in atlas-ui/src/api/atlasApi.tauri.test.ts — vitest.)
 *
 * Shape follows tests/audit-high-severity.test.ts.
 *
 * Run under the ABI-matched node (native modules): see test:audit-untested.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootOfAtlas = path.dirname(here);
const CLI = path.join(repoRootOfAtlas, 'src', 'cli.ts');
const require2 = createRequire(import.meta.url);
const TSX_CLI = require2.resolve('tsx/cli');

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── L4 — server close() must not hang on a held-open connection ─────────────
async function testServerCloseWithStuckConnection(cleanup: string[]): Promise<void> {
    console.log('\n[L4] LOW — graceful close hung on open connections');
    const home = mkTmp('atlas-audit-l4-');
    cleanup.push(home);
    process.env['ATLAS_MCP_AUTH'] = 'off'; // trusted-local mode; no token minting needed
    try {
        const { startAtlasMcpServer } = await import('../src/mcp/server.js');
        const srv = await startAtlasMcpServer({ port: 0, home });

        // Sanity: it serves.
        const health = await fetch(`http://127.0.0.1:${srv.port}/health`);
        assert.ok(health.ok, 'server answers /health');

        // Hold a connection HOSTAGE: connected, never sends a request, never
        // closes. Pre-fix, httpServer.close(cb) waited for this socket to
        // drain — i.e. forever; the callback (and graceful shutdown) never ran.
        const sock = net.connect(srv.port, '127.0.0.1');
        await new Promise<void>((resolve) => sock.once('connect', resolve));

        const t0 = Date.now();
        await Promise.race([
            srv.close(),
            sleep(8_000).then(() => { throw new Error('close() hung >8s with a stuck connection'); }),
        ]);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 8_000, `CLAIM L4: close resolved in ${elapsed}ms despite the stuck socket`);
        console.log(`  ✓ CLAIM L4: close() force-closes stuck connections and resolves (${elapsed}ms, grace is 3s)`);
        sock.destroy();
    } finally {
        delete process.env['ATLAS_MCP_AUTH'];
    }
}

// ── M5 — alerts_dismiss writes the decision node in EMBEDDED mode ───────────
async function testAlertsDismissEmbedded(cleanup: string[]): Promise<void> {
    console.log('\n[M5] MEDIUM — alerts_dismiss broken in embedded (default) mode');
    const home = mkTmp('atlas-audit-m5-');
    cleanup.push(home);
    process.env['ATLAS_HOME'] = home; // must precede the config import's load-time snapshot
    try {
        const { buildRegistry } = await import('../src/mcp/allTools.js');
        const registry = buildRegistry(0);
        // ToolRegistry exposes schemas publicly; the handler map is private —
        // reach in (this is a white-box regression test of the handler itself).
        const tools = (registry as unknown as {
            tools: Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
        }).tools;
        const dismiss = tools.get('alerts_dismiss');
        assert.ok(dismiss, 'alerts_dismiss registered');

        const res = await dismiss.handler({
            alertType: 'dead_code',
            summary: 'util.legacyHelper never called',
            reason: 'kept for the v1 import path; removal scheduled next quarter',
            workspace: 'alertws',
        }) as { ok?: boolean; embedded?: boolean; error?: string };

        assert.equal(res.error, undefined, `no error (pre-fix: tokenMissingError in embedded mode): ${res.error}`);
        assert.equal(res.ok, true, 'CLAIM M5a: dismiss succeeds in embedded mode');
        assert.equal(res.embedded, true, 'stored via the embedded branch');
        console.log('  ✓ CLAIM M5a: alerts_dismiss works in embedded mode (was always broken there)');

        // The auditable-trail contract: the decision node actually landed.
        //
        // Root cause of the flake this used to have (NOT a SurrealDB
        // async-lock-release timing issue — that was ruled out: widening
        // LORE_SURREAL_OPEN_BUDGET_MS to 45s still failed deterministically,
        // every attempt timing out, which means something was actively still
        // holding the handle, not merely slow to release it).
        //
        // The real cause: `alerts_dismiss`'s handler (allTools.ts) calls
        // `mirrorKnowledgeBackup(lore, workspace, cfg.home)`, which schedules a
        // DEBOUNCED, UNAWAITED `setTimeout(..., 1500)` that later calls
        // `exportMemory(lore, ...)` against the SAME EmbeddedLore instance —
        // by design, so a burst of dismissals in quick succession only
        // triggers one backup write. The handler returns long before that
        // timer fires. This test used to call closeAllEmbedded() (and then
        // reopen the same dataDir) within milliseconds of the handler
        // returning — racing its own pending background export: the timer
        // fires mid-close (or mid-reopen), touches the same on-disk store, and
        // the two opens fight over the surrealkv directory lock for the rest
        // of the retry budget. Waiting out the debounce window before closing
        // lets that background export run to completion (or be a no-op if it
        // already lost the race harmlessly) against the still-open instance,
        // so the close + reopen that follows has nothing left to contend with.
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const { closeAllEmbedded } = await import('../src/mcp/embeddedRegistry.js');
        await closeAllEmbedded();
        const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
        const lore = await EmbeddedLore.open(path.join(home, 'lore-data', 'alertws'));
        try {
            const nodes = await lore.listNodes('decision', undefined, 'alertws') as Array<{ label?: string; content?: string; tags?: string }>;
            const hit = nodes.find((n) => (n.label ?? '').includes('Alert dismissed: dead_code'));
            assert.ok(hit, 'CLAIM M5b: decision node persisted with the dismissal label');
            assert.ok((hit!.content ?? '').includes('kept for the v1 import path'), 'dismissal reason recorded');
            assert.ok((hit!.tags ?? '').includes('alert-dismissed'), 'tagged alert-dismissed');
            console.log('  ✓ CLAIM M5b: the audit-trail decision node actually landed in the store');
        } finally {
            await lore.close();
        }
    } finally {
        delete process.env['ATLAS_HOME'];
    }
}

// ── M8 — CLI must EXIT after the daemon-confirm fall-through ─────────────────
async function testCliExitAfterDaemonFallthrough(cleanup: string[]): Promise<void> {
    console.log('\n[M8] MEDIUM — CLI hung after the daemon fall-through direct index');
    const home = mkTmp('atlas-audit-m8-home-');
    cleanup.push(home);
    const repo = mkTmp('atlas-audit-m8-repo-');
    cleanup.push(repo);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function a(): number { return 1; }\n');
    spawnSync('git', ['init', '-q'], { cwd: repo });

    // A REAL MCP server (the same SDK the daemon uses) whose atlas_index never
    // answers and whose index_status says "not indexing" — the exact condition
    // that makes the CLI fall through to a direct embedded index with the
    // 600s daemon call still dangling.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = await import('zod');

    const mcp = new McpServer({ name: 'mock-daemon', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.tool(
        'atlas_tool_invoke',
        'mock shim',
        { tool: z.string(), args: z.record(z.string(), z.any()).optional() },
        async ({ tool }) => {
            if (tool === 'atlas_index') {
                await new Promise(() => { /* hangs — the CLI must NOT wait for this */ });
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify({ indexing: false }) }] };
        },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    const daemon = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        if (req.url === '/mcp' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined).catch(() => {
                    if (!res.headersSent) res.writeHead(500);
                    res.end();
                });
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
    const port = (daemon.address() as net.AddressInfo).port;
    cleanup.push(); // no-op placeholder to keep the cleanup array shape obvious

    // Point the CLI's config at the mock daemon's port.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (/^(ATLAS_|LORE_)/.test(k)) continue;
        env[k] = v;
    }
    env['ATLAS_HOME'] = home;
    env['ATLAS_CONTEXT_LAYER'] = '0';

    // 5s queue-wait + index_status confirm + a tiny direct index should take
    // well under a minute. WITHOUT the fix, the dangling 600s daemon call pins
    // the event loop and this process does not exit at all (spawn times out).
    const t0 = Date.now();
    const proc = spawnSync(process.execPath, [TSX_CLI, CLI, 'index', repo, '--workspace', 'mockws'], {
        cwd: repoRootOfAtlas,
        env,
        encoding: 'utf8',
        timeout: 90_000,
    });
    const elapsed = Date.now() - t0;
    daemon.close();

    assert.notEqual(proc.status, null, 'CLAIM M8: CLI exited (null = killed by the 90s timeout — the hang is back)');
    assert.ok(elapsed < 90_000, `exit took ${elapsed}ms`);
    assert.ok(!proc.error, `spawn error: ${proc.error ?? ''}`);
    assert.ok(
        proc.stdout.includes('"ok": true'),
        `direct index reported success after fall-through.\nstdout: ${proc.stdout}\nstderr: ${proc.stderr.slice(-800)}`,
    );
    console.log(`  ✓ CLAIM M8: CLI finished the direct index and EXITED (${Math.round(elapsed / 1000)}s; pre-fix it hung)`);
}

// ── M7 — group-import ownership guard covers code-context ids ───────────────
async function testGroupImportOwnershipGuard(cleanup: string[]): Promise<void> {
    console.log('\n[M7] MEDIUM — code-context ids escaped the group-import ownership guard');
    const { loadGroup } = await import('../src/cli/memorySync.js');
    type MemoryImportWriter = import('../src/cli/memorySync.js').MemoryImportWriter;
    const dir = mkTmp('atlas-audit-m7-');
    cleanup.push(dir);

    const header = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sourceWorkspace: 'x', exportedTypes: [] });
    const memoryFile = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(memoryFile, header + '\n'); // knowledge-only, zero nodes

    // Member A's code-graph: its own legitimate context card.
    const cgA = path.join(dir, 'cg-a.jsonl');
    fs.writeFileSync(cgA, [
        header,
        JSON.stringify({ kind: 'node', id: 'code-context:slug-a/real-card', type: 'code_context', label: 'A card', content: 'legit' }),
        '',
    ].join('\n'));

    // Member B's code-graph: hand-edited to FORGE nodes under A's slug — the
    // exact attack the guard exists to stop. code-context:/code-context-sym:
    // slipped past it before the fix (only file/symbol/folder were covered).
    const cgB = path.join(dir, 'cg-b.jsonl');
    fs.writeFileSync(cgB, [
        header,
        JSON.stringify({ kind: 'node', id: 'code-context:slug-a/forged', type: 'code_context', label: 'forged card', content: 'malicious edit' }),
        JSON.stringify({ kind: 'node', id: 'code-context-sym:slug-a/forged-sym', type: 'code_context', label: 'forged sym', content: 'malicious edit' }),
        JSON.stringify({ kind: 'node', id: 'code-file:slug-b/own.ts', type: 'code_file', label: 'own.ts', content: '{}' }),
        '',
    ].join('\n'));

    const stored: string[] = [];
    const client: MemoryImportWriter = {
        async storeNode(input) { stored.push(input.id); return {}; },
        async storeEdge() { /* none */ },
    };

    await loadGroup(client, 'groupws', [
        { file: memoryFile, project: 'memberA', codeGraphFile: cgA, repoSlug: 'slug-a' },
        { file: memoryFile, project: 'memberB', codeGraphFile: cgB, repoSlug: 'slug-b' },
    ]);

    assert.ok(stored.includes('code-context:slug-a/real-card'), "A's own card loaded");
    assert.ok(stored.includes('code-file:slug-b/own.ts'), "B's own file loaded");
    assert.ok(!stored.includes('code-context:slug-a/forged'),
        'CLAIM M7a: forged code-context node under a foreign slug is dropped');
    assert.ok(!stored.includes('code-context-sym:slug-a/forged-sym'),
        'CLAIM M7b: forged code-context-sym node under a foreign slug is dropped');
    console.log('  ✓ CLAIM M7a/b: code-context + code-context-sym forgeries are dropped by the guard');
}

async function main(): Promise<void> {
    console.log('Running audit "previously untested" regression tests…');
    const cleanup: string[] = [];
    try {
        await testServerCloseWithStuckConnection(cleanup);
        await testAlertsDismissEmbedded(cleanup);
        await testCliExitAfterDaemonFallthrough(cleanup);
        await testGroupImportOwnershipGuard(cleanup);
    } finally {
        for (const d of cleanup) {
            if (d) fs.rmSync(d, { recursive: true, force: true });
        }
    }
    console.log('\nAll audit previously-untested regression tests passed ✓');
}

await main();
