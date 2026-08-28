/**
 * tests/rc-webserve.test.ts — the daemon serves its own browser UI (branch
 * atlas-rc-reconcile).
 *
 * Atlas now ships as a CLI-installed daemon that ALSO serves the built browser
 * UI (atlas-ui/dist) at its own origin, replacing the Tauri desktop app. The
 * token reaches the browser out-of-band via the launch URL (the Jupyter model),
 * NOT via any daemon-served content. These checks boot `atlas serve` with auth
 * ON (the shipped default — no ATLAS_MCP_AUTH=off) and prove:
 *
 *   (a) SHELL         — GET / → 200 and looks like the app shell (index.html
 *                       with <div id="root">).
 *   (b) NO-LEAK       — the served / body does NOT contain the mcp.token string:
 *                       the token never leaks via served content, so a cross-user
 *                       loopback curl gets only the shell, never the secret.
 *   (c) GATE-UNCHANGED— GET/POST /mcp with no bearer → still 401; with the minted
 *                       token → not 401. The existing enforceMcpAuth gating is
 *                       exactly as-is; only the static UI is public.
 *   (d) SPA-FALLBACK  — a client-side route (GET /workspace/foo) → 200 index.html
 *                       so React Router resolves it.
 *   (e) STATIC-ASSET  — a real built asset (/assets/*.js, else /vite.svg) resolves
 *                       (200) — proves per-file serving + Content-Type, not just
 *                       the SPA fallback.
 *
 * atlas-ui/dist is BUILT first if absent so there's something to serve.
 *
 * Style mirrors tests/rc-security.test.ts: spawn `atlas serve` via tsx on a temp
 * ATLAS_HOME + a free port, node:assert/strict, no vitest/jsdom.
 */

import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const UI_DIR = path.join(REPO_ROOT, 'atlas-ui');
const UI_DIST = path.join(UI_DIR, 'dist');

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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-webserve-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }, null, 2));
    return home;
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
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

function initBody(): string {
    return JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'webserve-test', version: '1' } },
    });
}

async function stopChild(child: ChildProcess, exitPromise: Promise<unknown>): Promise<void> {
    child.kill('SIGTERM');
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
}

/** Ensure atlas-ui/dist exists so the daemon has something to serve. Build it
 *  once if absent (the test's precondition, not the thing under test). */
function ensureUiBuilt(): void {
    if (fs.existsSync(path.join(UI_DIST, 'index.html'))) return;
    console.log('  … atlas-ui/dist missing — building it once (npm run build)…');
    const res = spawnSync('npm', ['run', 'build'], { cwd: UI_DIR, encoding: 'utf-8', stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error(`atlas-ui build failed (status ${res.status}) — cannot test the served UI`);
    }
    assert.ok(fs.existsSync(path.join(UI_DIST, 'index.html')),
        'atlas-ui build did not produce dist/index.html');
}

/** Find a real built static asset under dist/ to probe direct-file serving.
 *  Prefers an assets/*.js chunk; falls back to vite.svg or any top-level file. */
function pickStaticAsset(): { urlPath: string; expectContentTypePrefix: string } | null {
    const assetsDir = path.join(UI_DIST, 'assets');
    if (fs.existsSync(assetsDir)) {
        const js = fs.readdirSync(assetsDir).find((f) => f.endsWith('.js'));
        if (js) return { urlPath: `/assets/${js}`, expectContentTypePrefix: 'application/javascript' };
        const css = fs.readdirSync(assetsDir).find((f) => f.endsWith('.css'));
        if (css) return { urlPath: `/assets/${css}`, expectContentTypePrefix: 'text/css' };
    }
    if (fs.existsSync(path.join(UI_DIST, 'vite.svg'))) {
        return { urlPath: '/vite.svg', expectContentTypePrefix: 'image/svg' };
    }
    return null;
}

async function testServesUi(): Promise<void> {
    ensureUiBuilt();

    const port = await freePort();
    const home = makeAtlasHome(port);
    // NOTE: env deliberately does NOT set ATLAS_MCP_AUTH — the shipped default
    // (auth ON), so the /mcp gate is live while the UI shell stays public.
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);

        const token = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        assert.ok(token.length >= 32, 'auth-ON daemon must mint a long mcp.token');
        const origin = `http://127.0.0.1:${port}`;

        // (a) GET / → 200 and looks like the app shell.
        const root = await fetch(`${origin}/`);
        assert.equal(root.status, 200, `GET / MUST be 200; got ${root.status}`);
        const rootBody = await root.text();
        assert.match(rootBody, /<div id="root">/,
            'GET / MUST return the app shell (index.html with <div id="root">)');
        const rootCt = root.headers.get('content-type') ?? '';
        assert.match(rootCt, /text\/html/, `GET / Content-Type MUST be text/html; got '${rootCt}'`);
        console.log('  ✓ SHELL: GET / → 200 text/html app shell (<div id="root">)');

        // (b) NO-LEAK — the served / body must NOT contain the token value.
        assert.ok(!rootBody.includes(token),
            'CRITICAL: the served / body leaked the mcp.token — the shell must never embed the secret');
        // Belt-and-braces: a bare cross-user curl-equivalent (Host only, no bearer,
        // no Origin) still gets a token-free shell.
        const coResident = await fetch(`${origin}/`, { headers: { Host: `127.0.0.1:${port}` } });
        const coResidentBody = await coResident.text();
        assert.equal(coResident.status, 200, 'co-resident GET / (no bearer) still 200 — shell is public');
        assert.ok(!coResidentBody.includes(token),
            'CRITICAL: co-resident curl of / leaked the mcp.token');
        console.log('  ✓ NO-LEAK: served / body contains NO mcp.token (secret never in served content)');

        // (c) GATE-UNCHANGED — /mcp still bearer-gated exactly as before.
        const mcpHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Host: `127.0.0.1:${port}`,
        };
        const mcpNoTok = await fetch(`${origin}/mcp`, { method: 'POST', headers: mcpHeaders, body: initBody() });
        assert.equal(mcpNoTok.status, 401, `POST /mcp with no bearer MUST still be 401; got ${mcpNoTok.status}`);
        const mcpGoodTok = await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: { ...mcpHeaders, Authorization: `Bearer ${token}` },
            body: initBody(),
        });
        assert.notEqual(mcpGoodTok.status, 401,
            `POST /mcp with the minted token MUST NOT 401; got ${mcpGoodTok.status}`);
        assert.notEqual(mcpGoodTok.status, 403,
            `POST /mcp with a valid token + loopback Host MUST NOT 403; got ${mcpGoodTok.status}`);
        console.log('  ✓ GATE-UNCHANGED: /mcp → 401 without bearer, not-401 with the minted token');

        // (d) SPA-FALLBACK — an app route that isn't a file → 200 index.html.
        const spa = await fetch(`${origin}/workspace/foo`);
        assert.equal(spa.status, 200, `SPA route GET /workspace/foo MUST be 200; got ${spa.status}`);
        const spaBody = await spa.text();
        assert.match(spaBody, /<div id="root">/,
            'SPA route MUST fall back to index.html (client-side routing)');
        const spaCt = spa.headers.get('content-type') ?? '';
        assert.match(spaCt, /text\/html/, `SPA fallback Content-Type MUST be text/html; got '${spaCt}'`);
        console.log('  ✓ SPA-FALLBACK: GET /workspace/foo → 200 index.html');

        // (d2) MALFORMED-PCT-DOS — a bare/invalid `%` escape in the (unauthenticated)
        // static path must NOT throw an unhandled URIError inside resolveStaticFsPath
        // (decodeURIComponent throws on `/%`), which would hang the response and
        // flood daemon.err. The handler now try/catches the decode and falls through
        // to the SPA/404 path. Assert the daemon answers cleanly (no 5xx, no hang).
        for (const bad of ['/%', '/%zz', '/assets/%E0%A4%A']) {
            const res = await fetch(`${origin}${bad}`);
            assert.ok(res.status < 500, `malformed-% path ${bad} MUST NOT 5xx (no unhandled URIError); got ${res.status}`);
            await res.text(); // drain — proves the response actually completed (no hang)
        }
        console.log('  ✓ MALFORMED-PCT-DOS: bare/invalid `%` static paths answered cleanly (no unhandled URIError)');

        // (e) STATIC-ASSET — a real built asset resolves with a sensible type.
        const asset = pickStaticAsset();
        assert.ok(asset, 'expected at least one static asset (assets/*.js|css or vite.svg) in the build');
        const assetRes = await fetch(`${origin}${asset.urlPath}`);
        assert.equal(assetRes.status, 200, `static asset ${asset.urlPath} MUST be 200; got ${assetRes.status}`);
        const assetCt = (assetRes.headers.get('content-type') ?? '').toLowerCase();
        assert.ok(assetCt.startsWith(asset.expectContentTypePrefix),
            `static asset ${asset.urlPath} Content-Type MUST start with '${asset.expectContentTypePrefix}'; got '${assetCt}'`);
        // An asset served as the SPA index.html would be text/html — assert it is NOT.
        assert.ok(!assetCt.startsWith('text/html'),
            `static asset ${asset.urlPath} MUST be served as a file, not the SPA index.html`);
        console.log(`  ✓ STATIC-ASSET: GET ${asset.urlPath} → 200 ${assetCt}`);

        // GATE-UNCHANGED extra: /api/* also still bearer-gated (fs/browse with
        // no bearer stays 401 — the static UI being public didn't open /api).
        const apiNoTok = await fetch(`${origin}/api/fs/browse?path=${encodeURIComponent(os.homedir())}`, {
            headers: { Host: `127.0.0.1:${port}` },
        });
        assert.equal(apiNoTok.status, 401,
            `/api/fs/browse with no bearer MUST still be 401; got ${apiNoTok.status}`);
        console.log('  ✓ GATE-UNCHANGED: /api/fs/browse → 401 without bearer (public UI did not open /api)');
    } finally {
        await stopChild(child, exitPromise);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('RC web-serve — daemon serves the browser UI (token via URL, shell secret-free)');
    await testServesUi();
    console.log('RC web-serve: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
