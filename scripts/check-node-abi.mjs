#!/usr/bin/env node
/**
 * scripts/check-node-abi.mjs — native-ABI guard (pkg-node-abi-unpinned).
 *
 * The vendored native modules that ship with Groundfloor Atlas (via @groundfloor/lore:
 * @kineviz/kuzu-lite, @lancedb/lancedb-<platform>, better-sqlite3,
 * onnxruntime-node) are prebuilt N-API/native addons compiled against a
 * SPECIFIC Node.js ABI (process.versions.modules — the NODE_MODULE_VERSION).
 * A native addon built for one Node major and then loaded under a different
 * major fails at require-time with a raw, unhelpful
 * "NODE_MODULE_VERSION X vs Y" exception.
 *
 * There are two places that mismatch can sneak in silently:
 *
 *   1. DEV/CI — someone bumps their local/CI Node version after native
 *      modules were installed for a different one, and `npm run build` /
 *      `npm run guard` still "pass" (they don't touch native modules) right
 *      up until the daemon crashes at boot when it first touches kuzu/lancedb.
 *
 *   2. THE DESKTOP APP BUNDLE — atlas-ui/src-tauri ships a bundled `node`
 *      binary alongside `atlas-core/` (see lib.rs resolve_node) specifically
 *      so the app never depends on a system Node. If that bundled binary's
 *      ABI doesn't match the ABI the native modules under atlas-core/ were
 *      compiled for, the app looks like it starts (the process spawns) and
 *      then the daemon dies the instant it opens kuzu/lancedb/sqlite — with
 *      no system Node around to `npm rebuild` against. This is the silent
 *      failure mode the task calls out as CRITICAL.
 *
 * This script checks both, depending on what's present:
 *
 *   - Always: confirms the CURRENT running Node's ABI is within the
 *     engines.node range declared in package.json (fast, cheap, catches #1
 *     before it ever reaches a native `require`).
 *   - If bundle-manifest.json exists (npm run bundle has run): confirms the
 *     ABI recorded at bundle time still matches the current Node — catches
 *     "you upgraded Node after bundling, before shipping."
 *   - If atlas-ui/src-tauri/atlas-core/{node,node.exe} exists (the vendored
 *     desktop runtime): actually EXECS that binary with
 *     `-p process.versions.modules` and compares its reported ABI against
 *     the current build host's ABI (a reasonable proxy for "the ABI the
 *     vendored native modules under atlas-core/node_modules were built
 *     for," since they are copied from THIS host's node_modules by the
 *     bundle step — see scripts/bundle.mjs). Mismatch = hard fail with a
 *     concrete fix.
 *
 * Exit 0 = all present checks agree. Exit 1 = a mismatch, with an actionable
 * message (never a bare native stack trace).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const CURRENT_ABI = process.versions.modules; // e.g. "115" for Node 20
const CURRENT_NODE = process.version;

let failed = false;
function fail(msg) {
    console.error(`[check-node-abi] FAIL: ${msg}`);
    failed = true;
}
function ok(msg) {
    console.log(`[check-node-abi] OK: ${msg}`);
}

// ── 1. engines.node range ──────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const engineRange = pkg.engines?.node;
if (engineRange) {
    // Cheap range check without pulling in `semver` as a new dependency:
    // engines.node here is always of the simple ">=X <Y" shape.
    const m = engineRange.match(/>=\s*(\d+).*?<\s*(\d+)/);
    const major = Number(process.versions.node.split('.')[0]);
    if (m) {
        const [, lo, hi] = m;
        if (major < Number(lo) || major >= Number(hi)) {
            fail(
                `running Node ${CURRENT_NODE} (major ${major}) is outside engines.node "${engineRange}". ` +
                `Native modules (kuzu/lancedb/better-sqlite3/onnxruntime) prebuilt for the supported range ` +
                `will likely refuse to load under this Node. Switch Node versions (nvm use / the CI image) ` +
                `and reinstall.`,
            );
        } else {
            ok(`running Node ${CURRENT_NODE} (ABI ${CURRENT_ABI}) is within engines.node "${engineRange}"`);
        }
    }
} else {
    console.warn('[check-node-abi] no engines.node in package.json — skipping range check');
}

// ── 2. bundle-manifest.json (if a CLI bundle exists) ───────────────────────
const manifestPath = path.join(REPO_ROOT, 'dist-bundle', 'bundle-manifest.json');
if (fs.existsSync(manifestPath)) {
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const bundledAbi = manifest.nodeAbi ?? null;
        if (bundledAbi == null) {
            console.warn(
                '[check-node-abi] dist-bundle/bundle-manifest.json has no "nodeAbi" field ' +
                '(built by an older scripts/bundle.mjs) — cannot verify; re-run `npm run bundle`.',
            );
        } else if (String(bundledAbi) !== String(CURRENT_ABI)) {
            fail(
                `dist-bundle was built under Node ABI ${bundledAbi} (node ${manifest.node ?? '?'}), ` +
                `but the current Node reports ABI ${CURRENT_ABI} (${CURRENT_NODE}). The bundle's vendored ` +
                `native modules (kuzu/lancedb/better-sqlite3/onnxruntime) will fail NODE_MODULE_VERSION ` +
                `checks if run under this Node. Re-run \`npm run bundle\` under the Node you intend to ship.`,
            );
        } else {
            ok(`dist-bundle ABI ${bundledAbi} matches current Node ABI ${CURRENT_ABI}`);
        }
    } catch (e) {
        console.warn(`[check-node-abi] could not read bundle-manifest.json: ${e.message}`);
    }
} else {
    console.log('[check-node-abi] no dist-bundle/bundle-manifest.json — skipping bundle-ABI check (nothing bundled yet)');
}

// ── 3. desktop app's vendored node binary (atlas-ui/src-tauri/atlas-core/) ─
const coreDir = path.join(REPO_ROOT, 'atlas-ui', 'src-tauri', 'atlas-core');
const candidates = ['node', 'node.exe'].map((n) => path.join(coreDir, n));
const bundledNode = candidates.find((p) => fs.existsSync(p));
if (bundledNode) {
    try {
        const out = execFileSync(bundledNode, ['-p', 'process.versions.modules'], {
            encoding: 'utf-8',
            timeout: 10_000,
        }).trim();
        if (out !== String(CURRENT_ABI)) {
            fail(
                `vendored desktop node binary at ${bundledNode} reports ABI ${out}, but the native modules ` +
                `staged under atlas-core/ were copied from THIS host's node_modules (ABI ${CURRENT_ABI}, ` +
                `see scripts/bundle.mjs). A mismatch here means the Tauri app will spawn, then the embedded ` +
                `daemon will crash the instant it opens kuzu/lancedb/sqlite — with no system Node available ` +
                `inside the app bundle to fall back on or rebuild against. Re-vendor the node binary for ` +
                `ABI ${CURRENT_ABI} (see docs/PACKAGING.md, "Bundling a Node runtime for the desktop app"), ` +
                `or rebuild atlas-core/ from a host running the matching Node version.`,
            );
        } else {
            ok(`vendored desktop node binary (${bundledNode}) ABI ${out} matches this host's ABI ${CURRENT_ABI}`);
        }
    } catch (e) {
        fail(`could not execute vendored node binary at ${bundledNode}: ${e.message}`);
    }
} else {
    console.log(
        `[check-node-abi] no vendored node binary at ${coreDir} — skipping desktop-ABI check ` +
        `(expected until the node-bundling step runs; see docs/PACKAGING.md)`,
    );
}

if (failed) {
    process.exit(1);
}
console.log('[check-node-abi] all present checks passed.');
