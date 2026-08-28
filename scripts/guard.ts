#!/usr/bin/env tsx
/**
 * scripts/guard.ts — Atlas continuous health + progress monitor.
 *
 * Runs in the background every 5 minutes. Checks:
 *   1. Atlas daemon /health on :3848
 *   2. Lore daemon /health on :3847 (INFORMATIONAL — embedded in-process is the
 *      supported model; a missing :3847 daemon never degrades the summary)
 *   3. TypeScript typecheck (groundfloor-atlas + atlas-app)
 *   4. Health test pass rate
 *   5. Embedded-mode suites (write path, code-intel read tools, memory edges)
 *   6. Lore outbox lag (silent death detector, only when a daemon is reachable)
 *
 * Usage:
 *   npx tsx scripts/guard.ts             # single run
 *   npx tsx scripts/guard.ts --watch     # continuous 5-min loop
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// The desktop app lives at ./atlas-ui (was previously a sibling repo
// named atlas-app — the stale path made the frontend check always fail).
const ATLAS_APP = path.resolve(REPO_ROOT, 'atlas-ui');

// ── Health probe ──────────────────────────────────────────────────────────────

function httpGet(port: number, urlPath: string, timeoutMs = 4000): Promise<{ ok: boolean; body: unknown }> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, body: 'timeout' }); }, timeoutMs);
        const req = http.request(
            { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c as Buffer));
                res.on('end', () => {
                    clearTimeout(timer);
                    const text = Buffer.concat(chunks).toString('utf-8');
                    const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
                    try { resolve({ ok, body: JSON.parse(text) }); }
                    catch { resolve({ ok, body: text }); }
                });
                res.on('error', () => { clearTimeout(timer); resolve({ ok: false, body: 'read_error' }); });
            },
        );
        req.on('error', () => { clearTimeout(timer); resolve({ ok: false, body: 'connect_error' }); });
        req.end();
    });
}

// ── Typecheck ─────────────────────────────────────────────────────────────────

function typecheck(cwd: string, label: string, extraArgs = ''): { ok: boolean; error?: string } {
    try {
        execSync(`npx tsc --noEmit ${extraArgs} 2>&1`.trim(), { cwd, stdio: 'pipe', timeout: 120_000 });
        return { ok: true };
    } catch (e: unknown) {
        const err = e as { stdout?: Buffer };
        const out = err.stdout?.toString().slice(0, 300) ?? 'unknown error';
        return { ok: false, error: `${label}: ${out}` };
    }
}

// ── Health tests ──────────────────────────────────────────────────────────────

function runHealthTests(): { ok: boolean; passed: number; failed: number; duration: number } {
    const t0 = Date.now();
    try {
        const out = execSync('npx tsx tests/health.test.ts 2>&1', {
            cwd: REPO_ROOT,
            timeout: 60_000,
            stdio: 'pipe',
        }).toString();
        const passed = (out.match(/✓/g) ?? []).length;
        const failed = (out.match(/✗/g) ?? []).length;
        return { ok: failed === 0, passed, failed, duration: Date.now() - t0 };
    } catch {
        return { ok: false, passed: 0, failed: 1, duration: Date.now() - t0 };
    }
}

// ── Embedded-mode suites ────────────────────────────────────────────────────────
// These cover the supported in-process config: the write path, the 7 code-intel
// read tools, and the cross-seam memory-edge plumbing. They signal failure by
// throwing (assert), so a clean run = exit 0. We do NOT gate x3/x4/e2e here:
// those require a remote Lore daemon on :3847 that project policy forbids, so
// gating them would make guard permanently red.
const EMBEDDED_SUITES = [
    'tests/embedded.test.ts',
    'tests/embedded-read.test.ts',
    'tests/memory-edges.test.ts',
] as const;

function runEmbeddedSuite(file: string): { ok: boolean; checks: number; duration: number } {
    const t0 = Date.now();
    try {
        const out = execSync(`npx tsx ${file} 2>&1`, {
            cwd: REPO_ROOT,
            timeout: 120_000,
            stdio: 'pipe',
        }).toString();
        // Each suite prints one "✓ …" line per asserted claim and throws on
        // failure, so a non-throwing run is green; count ✓ for visibility.
        const checks = (out.match(/✓/g) ?? []).length;
        return { ok: true, checks, duration: Date.now() - t0 };
    } catch {
        return { ok: false, checks: 0, duration: Date.now() - t0 };
    }
}

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Bundle-staleness check. The self-contained `dist-bundle/` is what end users
 * actually run (run-atlas.sh / the Tauri app exec `dist-bundle/dist/cli.js`),
 * but it is a git-ignored build artifact that must be regenerated with `npm run
 * bundle` after any source change. It has silently shipped pre-fix code more than
 * once. Skips cleanly (ok, not built) when no bundle is present — CI / fresh
 * clones have none and must not be failed for it.
 *
 * CONTENT-BASED, not timestamp-based. The bundle is `npm run bundle` of the
 * CURRENT source: tsc compiles `src/` → `dist/`, then `bundle.mjs` copies that
 * `dist/` verbatim into `dist-bundle/dist/`. So the bundle is fresh iff
 * `dist-bundle/dist/` is byte-identical to the freshly-built `dist/`. A git
 * checkout / merge bumps `src/` mtimes with no content change, which a timestamp
 * comparison would (and did) flag as a false-positive STALE; comparing the
 * compiled output side-by-side instead is immune to that. `builtAt` in the
 * manifest is kept only for telemetry, not as a freshness signal.
 *
 * Compares relative-path content hashes (sha256) of every file under `dist/`
 * against `dist-bundle/dist/`. A file present in only one side, or present in
 * both but differing in bytes, is a divergence → STALE. Rebuild `dist/` first so
 * the comparison is against the *current* source, not a stale prior build.
 */
function checkBundleFresh(): { ok: boolean; built: boolean; stale?: string } {
    const manifestPath = path.join(REPO_ROOT, 'dist-bundle', 'bundle-manifest.json');
    if (!fs.existsSync(manifestPath)) return { ok: true, built: false };
    const distDir = path.join(REPO_ROOT, 'dist');
    const bundleDistDir = path.join(REPO_ROOT, 'dist-bundle', 'dist');
    // No bundle output to compare against → treat as not-built (skip, don't fail).
    if (!fs.existsSync(distDir) || !fs.existsSync(bundleDistDir)) return { ok: true, built: false };

    /** Map every file under `root` to its relative path → sha256(content). */
    const hashTree = (root: string): Map<string, string> => {
        const out = new Map<string, string>();
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile()) {
                    const buf = fs.readFileSync(p);
                    out.set(path.relative(root, p), crypto.createHash('sha256').update(buf).digest('hex'));
                }
            }
        };
        walk(root);
        return out;
    };

    let dist: Map<string, string>;
    let bundle: Map<string, string>;
    try {
        dist = hashTree(distDir);
        bundle = hashTree(bundleDistDir);
    } catch { return { ok: true, built: false }; }

    // First divergence wins — name the file so the STALE message is actionable.
    for (const [rel, hash] of dist) {
        const b = bundle.get(rel);
        if (b === undefined) return { ok: false, built: true, stale: `dist/${rel} missing from dist-bundle/dist/ — run \`npm run bundle\`` };
        if (b !== hash) return { ok: false, built: true, stale: `dist/${rel} differs from dist-bundle/dist/${rel} — run \`npm run bundle\`` };
    }
    const extra = [...bundle.keys()].filter((rel) => !dist.has(rel));
    if (extra.length > 0) return { ok: false, built: true, stale: `dist-bundle/dist/${extra[0]} not in dist/ (stale leftover) — run \`npm run bundle\`` };

    return { ok: true, built: true };
}

interface GuardReport {
    timestamp: string;
    atlas: { ok: boolean; version?: string; uptime_ms?: number };
    lore: { ok: boolean; version?: string; sessions?: number; outboxLagSecs?: number };
    build: { backend: boolean; frontend: boolean };
    healthTests: { ok: boolean; passed: number; failed: number; duration: number };
    embeddedTests: { ok: boolean; results: { file: string; ok: boolean; checks: number; duration: number }[] };
    bundle: { ok: boolean; built: boolean; stale?: string };
    summary: 'HEALTHY' | 'DEGRADED' | 'DOWN';
    issues: string[];
}

async function runGuard(): Promise<GuardReport> {
    const issues: string[] = [];

    // 1. Atlas health
    const atlasRes = await httpGet(3848, '/health');
    const atlasBody = atlasRes.body as Record<string, unknown>;
    const atlas = {
        ok: atlasRes.ok,
        version: atlasBody['version'] as string | undefined,
        uptime_ms: atlasBody['uptime_ms'] as number | undefined,
    };
    if (!atlas.ok) issues.push('❌ Atlas daemon OFFLINE on :3848');

    // 2. Lore health — INFORMATIONAL ONLY.
    // Atlas embeds Lore in-process; project policy forbids a machine-wide local
    // Lore daemon on :3847, so its absence is the normal/supported state and must
    // NOT degrade the guard summary. We still surface outbox lag if a daemon
    // happens to be reachable, but never push :3847-down into `issues`.
    const loreRes = await httpGet(3847, '/health');
    const loreBody = loreRes.body as Record<string, unknown>;
    // Parse outbox lag from Lore health response
    let outboxLagSecs: number | undefined;
    if (typeof loreBody['outboxLag'] === 'object' && loreBody['outboxLag'] !== null) {
        const ol = loreBody['outboxLag'] as Record<string, unknown>;
        outboxLagSecs = ol['lagSeconds'] as number | undefined;
    }
    const lore = {
        ok: loreRes.ok,
        version: loreBody['version'] as string | undefined,
        sessions: loreBody['sessions'] as number | undefined,
        outboxLagSecs,
    };
    if (lore.ok && outboxLagSecs !== undefined && outboxLagSecs > 60) {
        issues.push(`⚠️  Lore outbox lag ${outboxLagSecs}s — embedding pipeline backed up`);
    }

    // 3. TypeScript typecheck
    const backendCheck = typecheck(REPO_ROOT, 'groundfloor-atlas');
    const frontendCheck = typecheck(ATLAS_APP, 'atlas-app', '-p tsconfig.app.json');
    const build = { backend: backendCheck.ok, frontend: frontendCheck.ok };
    if (!backendCheck.ok) issues.push(`❌ Backend TypeScript errors: ${backendCheck.error ?? ''}`);
    if (!frontendCheck.ok) issues.push(`❌ Frontend TypeScript errors: ${frontendCheck.error ?? ''}`);

    // 4. Health tests
    const healthTests = runHealthTests();
    if (!healthTests.ok) issues.push(`❌ Health tests failing (${healthTests.failed} failed)`);

    // 5. Embedded-mode suites — the supported in-process config (write path,
    // 7 code-intel read tools, cross-seam memory edges). Gate the guard on these.
    const embeddedResults = EMBEDDED_SUITES.map((file) => ({ file, ...runEmbeddedSuite(file) }));
    const embeddedTests = { ok: embeddedResults.every((r) => r.ok), results: embeddedResults };
    for (const r of embeddedResults) {
        if (!r.ok) issues.push(`❌ Embedded suite failing: ${r.file}`);
    }

    // 6. Bundle freshness — the shipped self-contained artifact must not lag src/.
    const bundle = checkBundleFresh();
    if (!bundle.ok) issues.push(`❌ dist-bundle STALE: ${bundle.stale}`);

    // 7. Summary
    const criticalDown = !atlas.ok;
    const summary: 'HEALTHY' | 'DEGRADED' | 'DOWN' = criticalDown ? 'DOWN' : issues.length > 0 ? 'DEGRADED' : 'HEALTHY';

    return { timestamp: new Date().toISOString(), atlas, lore, build, healthTests, embeddedTests, bundle, summary, issues };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const watchMode = process.argv.includes('--watch');
const INTERVAL_MS = 5 * 60 * 1000;

async function cycle(): Promise<GuardReport> {
    const r = await runGuard();
    const icon = r.summary === 'HEALTHY' ? '✅' : r.summary === 'DEGRADED' ? '⚠️ ' : '🔴';
    console.log(`\n${icon} [${r.timestamp}] ${r.summary}`);
    console.log(`   Atlas : ${r.atlas.ok ? `v${r.atlas.version ?? '?'} · uptime ${Math.floor((r.atlas.uptime_ms ?? 0) / 1000)}s` : 'OFFLINE'}`);
    console.log(`   Lore  : ${r.lore.ok ? `v${r.lore.version ?? '?'} · sessions=${r.lore.sessions ?? '?'}${r.lore.outboxLagSecs !== undefined ? ` · outbox_lag=${r.lore.outboxLagSecs}s` : ''}` : 'OFFLINE'}`);
    console.log(`   Build : backend=${r.build.backend ? 'OK' : 'FAIL'} · frontend=${r.build.frontend ? 'OK' : 'FAIL'}`);
    console.log(`   Tests : ${r.healthTests.passed} passed · ${r.healthTests.failed} failed · ${r.healthTests.duration}ms`);
    console.log(`   Embed : ${r.embeddedTests.results.map((s) => `${s.file.replace('tests/', '').replace('.test.ts', '')}=${s.ok ? 'OK' : 'FAIL'}`).join(' · ')}`);
    console.log(`   Bundle: ${!r.bundle.built ? 'not built' : r.bundle.ok ? 'fresh' : 'STALE'}`);
    if (r.issues.length > 0) {
        console.log(`   Issues:`);
        r.issues.forEach((i) => console.log(`     ${i}`));
    }
    return r;
}

async function main() {
    console.log(`[guard] Atlas Guard v1.0 started ${watchMode ? '— watching every 5 minutes' : '— single run'}`);
    const r = await cycle();
    if (watchMode) {
        setInterval(() => void cycle(), INTERVAL_MS);
        return;
    }
    // Single-run is a GATE: a STALE shipped bundle must fail the command (exit 1)
    // so `npm run guard` blocks packaging/dogfood of a bundle that lags source.
    // Daemon-offline and other transient issues stay warnings (exit 0) — only the
    // deterministic, ship-relevant bundle staleness blocks.
    if (r.bundle.built && !r.bundle.ok) {
        console.error('[guard] FAIL: dist-bundle is STALE — run `npm run bundle` before shipping.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`[guard] fatal: ${(err as Error).message}`);
    process.exit(1);
});
