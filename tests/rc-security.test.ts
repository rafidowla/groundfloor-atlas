/**
 * tests/rc-security.test.ts — RC security hardening (branch atlas-rc-reconcile).
 *
 * Proves the four fixes that close the auth-off findings and the independent
 * hardening fixes, all runnable without a live model or a Tauri app.
 *
 *   KEYSTONE (co-resident-curl proof) — boot `atlas serve` with auth ON (the
 *     SHIPPED default: no ATLAS_MCP_AUTH=off), then, using ONLY a valid loopback
 *     Host header and NO Origin (exactly what any co-resident local process can
 *     forge), POST /mcp:
 *       · with NO bearer            → 401  (the tool surface is closed)
 *       · with the minted mcp.token → NOT 401 (a legitimate holder gets in)
 *     This is the whole point of the root fix: Host/Origin gates do not stop a
 *     local process; only the 0600 bearer token does. The old build spawned the
 *     daemon with ATLAS_MCP_AUTH=off, so this same request reached every tool.
 *
 *   FS-BROWSE — /api/fs/browse now (a) requires the bearer [401 without] and
 *     (b) refuses a target outside the browsable root set [403 for /etc] even
 *     WITH a valid bearer, so an authenticated caller still can't enumerate the
 *     whole filesystem. A path inside HOME is allowed.
 *
 *   EXPORT-CONTAINMENT — knowledge_export_all rejects an out-of-root absolute
 *     outPath when an operator allowlist (ATLAS_INDEX_ROOTS) is configured
 *     (path_forbidden), and permits an in-root target. Same for import.
 *
 *   HEADERS — buildAtlasHeaders() attaches `Authorization: Bearer <token>` when
 *     a token is set (the frontend leg of the root fix), and omits it when not
 *     (so browser dev against an auth-off daemon still works).
 *
 *   HOME-HARDEN — hardenAtlasHome() tightens a pre-existing 0755 ATLAS_HOME to
 *     0700 so the minted bearer token is never group/other-readable.
 *
 *   CORS-DEV-GATED — the live daemon does NOT reflect the Vite dev origin
 *     (:1421) in Access-Control-Allow-Origin unless ATLAS_DEV is set.
 */

import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPathError, fsBrowsePathError } from '../src/indexRoots.js';
import { hardenAtlasHome } from '../src/config.js';
import { buildRegistry } from '../src/mcp/allTools.js';

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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcsec-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }, null, 2));
    return home;
}

async function waitForHealth(port: number, timeoutMs = 8000): Promise<void> {
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

/** A minimal MCP initialize body — a co-resident process would POST this. */
function initBody(): string {
    return JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'coresident', version: '1' } },
    });
}

async function stopChild(child: ChildProcess, exitPromise: Promise<unknown>): Promise<void> {
    child.kill('SIGTERM');
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
}

/* ─── KEYSTONE: auth-ON daemon rejects a bearer-less co-resident /mcp POST ─── */

async function testKeystone_authOnBlocksNoBearer(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    // NOTE: env deliberately does NOT set ATLAS_MCP_AUTH — this is the shipped
    // default (auth ON). The desktop app used to inject ATLAS_MCP_AUTH=off here.
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);

        // The daemon must have minted a token (proves auth is ON).
        const tokenPath = path.join(home, 'mcp.token');
        assert.ok(fs.existsSync(tokenPath), 'auth-ON daemon must mint <ATLAS_HOME>/mcp.token');
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        assert.ok(token.length >= 32, 'minted token should be a long random hex string');

        const url = `http://127.0.0.1:${port}/mcp`;
        // Exactly what a co-resident local process can send: a valid loopback
        // Host, NO Origin (native clients omit it), and NO bearer.
        const coResidentHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Host: `127.0.0.1:${port}`,
        };

        const noTok = await fetch(url, { method: 'POST', headers: coResidentHeaders, body: initBody() });
        assert.equal(noTok.status, 401,
            `co-resident /mcp POST with valid Host + no bearer MUST be 401; got ${noTok.status} ` +
            `(this is the whole finding — auth-off let it reach the tool surface)`);

        const badTok = await fetch(url, {
            method: 'POST',
            headers: { ...coResidentHeaders, Authorization: 'Bearer not-the-real-token' },
            body: initBody(),
        });
        assert.equal(badTok.status, 401, `wrong bearer MUST be 401; got ${badTok.status}`);

        // WITH the minted token, the same request is NOT rejected by auth.
        const goodTok = await fetch(url, {
            method: 'POST',
            headers: { ...coResidentHeaders, Authorization: `Bearer ${token}` },
            body: initBody(),
        });
        assert.notEqual(goodTok.status, 401,
            `valid minted token MUST NOT 401; got ${goodTok.status} (legitimate holder must get in)`);
        assert.notEqual(goodTok.status, 403, `valid token + loopback Host must not be 403; got ${goodTok.status}`);

        console.log('  ✓ KEYSTONE: auth-ON /mcp — 401 without bearer, 401 wrong bearer, allowed with minted token');
    } finally {
        await stopChild(child, exitPromise);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/* ─── FS-BROWSE: bearer required + target confined to the root set ─────────── */

async function testFsBrowse_authAndContainment(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);
        const token = fs.readFileSync(path.join(home, 'mcp.token'), 'utf-8').trim();
        const base = `http://127.0.0.1:${port}/api/fs/browse`;
        const authed = { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}` };

        // (a) no bearer → 401 (previously this route skipped the bearer entirely).
        const noTok = await fetch(`${base}?path=${encodeURIComponent(os.homedir())}`, {
            headers: { Host: `127.0.0.1:${port}` },
        });
        assert.equal(noTok.status, 401, `fs/browse with no bearer MUST be 401; got ${noTok.status}`);

        // (b) authed but OUTSIDE the root set (/etc) → 403.
        const outside = await fetch(`${base}?path=${encodeURIComponent('/etc')}`, { headers: authed });
        assert.equal(outside.status, 403,
            `authed fs/browse of /etc MUST be 403 (outside browsable roots); got ${outside.status}`);

        // (c) authed + INSIDE home → 200.
        const inside = await fetch(`${base}?path=${encodeURIComponent(os.homedir())}`, { headers: authed });
        assert.equal(inside.status, 200, `authed fs/browse of home MUST be 200; got ${inside.status}`);

        console.log('  ✓ FS-BROWSE: 401 without bearer, 403 outside roots (/etc), 200 inside home');
    } finally {
        await stopChild(child, exitPromise);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/* ─── EXPORT-CONTAINMENT: knowledge_export_all rejects out-of-root outPath ─── */

async function testExportContainment(): Promise<void> {
    // Confine the allowlist to a temp root; an outPath outside it must be
    // refused BEFORE any Lore handle is opened. We drive the tool handler
    // directly through the registry (no daemon needed) so the check is exercised
    // in isolation.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-exproot-')));
    const savedRoots = process.env['ATLAS_INDEX_ROOTS'];
    process.env['ATLAS_INDEX_ROOTS'] = root;
    try {
        // Sanity on the underlying containment used by the tool.
        assert.equal(scanPathError(path.join(root, 'dump.jsonl')), null, 'in-root export target allowed by scanPathError');
        assert.ok(scanPathError('/tmp/evil.jsonl'), 'out-of-root export target rejected by scanPathError');
        assert.ok(scanPathError('/root/.ssh/authorized_keys'), 'sensitive out-of-root path rejected');

        const registry = buildRegistry(Date.now());

        // Out-of-root absolute path → path_forbidden, no write attempted.
        const outResult = await registry.invoke('knowledge_export_all', {
            workspace: 'developer',
            outPath: '/tmp/atlas-rcsec-should-not-exist.jsonl',
        }) as { error?: string; tool?: string };
        assert.equal(outResult.error, 'path_forbidden',
            `out-of-root knowledge_export_all MUST return path_forbidden; got ${JSON.stringify(outResult)}`);
        assert.ok(!fs.existsSync('/tmp/atlas-rcsec-should-not-exist.jsonl'),
            'no file should have been written for a rejected export');

        // A relative path is still rejected (pre-existing invalid_arguments guard).
        const relResult = await registry.invoke('knowledge_export_all', {
            workspace: 'developer', outPath: 'relative.jsonl',
        }) as { error?: string };
        assert.equal(relResult.error, 'invalid_arguments', 'relative outPath still rejected');

        // import path is confined symmetrically.
        const impResult = await registry.invoke('knowledge_import_all', {
            workspace: 'developer', inPath: '/etc/passwd',
        }) as { error?: string };
        assert.equal(impResult.error, 'path_forbidden',
            `out-of-root knowledge_import_all MUST return path_forbidden; got ${JSON.stringify(impResult)}`);

        console.log('  ✓ EXPORT-CONTAINMENT: out-of-root export/import → path_forbidden, no write');
    } finally {
        if (savedRoots === undefined) delete process.env['ATLAS_INDEX_ROOTS'];
        else process.env['ATLAS_INDEX_ROOTS'] = savedRoots;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/* ─── HEADERS: buildAtlasHeaders attaches the bearer when a token is set ───── */

async function testBuildAtlasHeaders(): Promise<void> {
    // atlasApi.ts is frontend TS but buildAtlasHeaders/__setMcpTokenForTest touch
    // no browser globals at import or call time, so tsx can import them directly.
    const mod = await import('../atlas-ui/src/api/atlasApi.ts');
    const { buildAtlasHeaders, __setMcpTokenForTest } = mod as {
        buildAtlasHeaders: () => Record<string, string>;
        __setMcpTokenForTest: (t: string | null) => void;
    };

    // No token → no Authorization header (browser dev against auth-off daemon).
    __setMcpTokenForTest(null);
    const noAuth = buildAtlasHeaders();
    assert.equal(noAuth['Authorization'], undefined, 'no token → no Authorization header');
    assert.equal(noAuth['Content-Type'], 'application/json', 'base headers still present');

    // Token set → exact bearer header.
    __setMcpTokenForTest('deadbeefcafef00d');
    const withAuth = buildAtlasHeaders();
    assert.equal(withAuth['Authorization'], 'Bearer deadbeefcafef00d',
        `token set → 'Bearer <token>'; got ${withAuth['Authorization']}`);

    __setMcpTokenForTest(null); // reset
    console.log('  ✓ HEADERS: buildAtlasHeaders attaches Bearer when token set, omits it when not');
}

/* ─── HOME-HARDEN: pre-existing 0755 ATLAS_HOME tightened to 0700 ──────────── */

function testHomeHarden(): void {
    if (process.platform === 'win32') {
        console.log('  ⊘ HOME-HARDEN: skipped on win32 (no POSIX perms)');
        return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hardn-'));
    fs.chmodSync(home, 0o755); // simulate a permissive pre-existing home
    assert.equal(fs.statSync(home).mode & 0o777, 0o755, 'precondition: home is 0755');
    hardenAtlasHome(home);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700,
        'hardenAtlasHome must tighten a pre-existing 0755 home to 0700');
    fs.rmSync(home, { recursive: true, force: true });
    console.log('  ✓ HOME-HARDEN: pre-existing 0755 ATLAS_HOME → 0700');
}

/* ─── CORS-DEV-GATED: dev origin not reflected unless ATLAS_DEV is set ─────── */

async function testCorsDevGated(): Promise<void> {
    const port = await freePort();
    const home = makeAtlasHome(port);
    // No ATLAS_DEV → dev origins must NOT be allow-listed.
    const child = spawn(TSX, [CLI, 'serve'], {
        env: { ...process.env, ATLAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    try {
        await waitForHealth(port);
        const preflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'OPTIONS',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: 'http://localhost:1421',
                'Access-Control-Request-Method': 'POST',
            },
        });
        const allowOrigin = preflight.headers.get('access-control-allow-origin');
        assert.notEqual(allowOrigin, 'http://localhost:1421',
            `shipped build (no ATLAS_DEV) must NOT reflect the Vite dev origin; got '${allowOrigin}'`);
        console.log('  ✓ CORS-DEV-GATED: Vite dev origin not allow-listed without ATLAS_DEV');
    } finally {
        await stopChild(child, exitPromise);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/* ─── fsBrowsePathError unit sanity (no daemon) ───────────────────────────── */

function testFsBrowsePathErrorUnit(): void {
    assert.equal(fsBrowsePathError(os.homedir()), null, 'home itself is browsable');
    assert.equal(fsBrowsePathError(path.join(os.homedir(), 'anything')), null, 'under home is browsable');
    assert.ok(fsBrowsePathError('/etc'), '/etc is not browsable');
    assert.ok(fsBrowsePathError('/'), 'filesystem root is not browsable');
    assert.ok(fsBrowsePathError('/var/root'), 'another user home is not browsable');
    console.log('  ✓ FS-BROWSE-UNIT: root set = home subtree; /etc, /, other homes rejected');
}

async function main(): Promise<void> {
    console.log('RC security — auth-on root fix + hardening');
    // Pure/unit checks first (fast, no daemon).
    testHomeHarden();
    testFsBrowsePathErrorUnit();
    await testExportContainment();
    await testBuildAtlasHeaders();
    // Live-daemon checks (spawn `atlas serve`).
    await testKeystone_authOnBlocksNoBearer();
    await testFsBrowse_authAndContainment();
    await testCorsDevGated();
    console.log('RC security: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
