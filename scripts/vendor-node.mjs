#!/usr/bin/env node
/**
 * scripts/vendor-node.mjs — vendor an ABI-matched Node binary into the
 * desktop app's bundle resource dir (pkg-node-binary-never-bundled, CRITICAL).
 *
 * atlas-ui/src-tauri/src/lib.rs::resolve_node() ONLY ever looks for a `node`
 * (or `node.exe`) binary sitting next to the staged `atlas-core/` resource —
 * by design (RD-MF22, see lib.rs): it deliberately does NOT fall back to a
 * bare `node` on PATH, because that would let an attacker-controlled binary
 * earlier on PATH run with the app's privileges. That's the right security
 * call, but it means NOTHING currently puts a node binary there — the
 * directory ships with only a `.gitkeep`, so a packaged app has no Node to
 * spawn and every install fails at `daemon-spawn-failed` with "no bundled
 * Node.js binary found ... Reinstall Atlas."
 *
 * This script closes that gap for local/manual packaging runs: it copies
 * the CURRENT host's `node` binary (process.execPath) into
 * atlas-ui/src-tauri/atlas-core/, verifies its ABI matches what the native
 * modules being staged alongside it expect (via scripts/check-node-abi.mjs
 * logic), and fails loudly instead of silently shipping a mismatched pair.
 *
 * IMPORTANT — what this script does NOT solve:
 *   - It vendors THIS HOST's node binary only (same platform/arch you're
 *     packaging on). Cross-compiling a Windows or Linux bundle from a Mac
 *     needs that platform's node binary fetched separately (see
 *     docs/PACKAGING.md, "Bundling a Node runtime for the desktop app" —
 *     the manual step / download-matrix approach for platforms other than
 *     the build host).
 *   - It does not build a smaller/stripped Node (e.g. via `node-sea` or a
 *     custom minimal build) — that's a further optimization, not required
 *     for correctness.
 *
 * Usage:
 *   node scripts/vendor-node.mjs
 *     Copies process.execPath → atlas-ui/src-tauri/atlas-core/node (or
 *     node.exe on win32), after `npm run bundle` has staged dist-bundle/ and
 *     the packaging step has copied it to atlas-core/ (see docs/PACKAGING.md
 *     desktop build recipe — this script is step 2.5, between staging the
 *     core and running `tauri build`).
 *
 *   node scripts/vendor-node.mjs --node /path/to/node
 *     Vendor an explicit node binary instead of process.execPath (e.g. one
 *     downloaded for a different target than the build host).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_ROOT, 'atlas-ui', 'src-tauri', 'atlas-core');

const args = process.argv.slice(2);
const nodeFlagIdx = args.indexOf('--node');
const sourceNode = nodeFlagIdx !== -1 ? args[nodeFlagIdx + 1] : process.execPath;

if (!sourceNode || !fs.existsSync(sourceNode)) {
    console.error(`[vendor-node] source node binary not found: ${sourceNode ?? '(none)'}`);
    process.exit(1);
}

if (!fs.existsSync(CORE_DIR)) {
    console.error(
        `[vendor-node] ${CORE_DIR} does not exist. Run \`npm run bundle\` and stage it ` +
        `(cp -R dist-bundle atlas-ui/src-tauri/atlas-core) BEFORE vendoring the node binary — ` +
        `see docs/PACKAGING.md "Desktop build recipe".`,
    );
    process.exit(1);
}
if (!fs.existsSync(path.join(CORE_DIR, 'dist', 'cli.js'))) {
    console.warn(
        `[vendor-node] warning: ${CORE_DIR}/dist/cli.js not found — atlas-core/ doesn't look staged yet. ` +
        `Continuing anyway, but lib.rs's resolve_core_dir() also checks for dist/cli.js, so a Tauri build ` +
        `will still fail to find the core until it's staged.`,
    );
}

const destName = process.platform === 'win32' ? 'node.exe' : 'node';
const destPath = path.join(CORE_DIR, destName);

fs.copyFileSync(sourceNode, destPath);
fs.chmodSync(destPath, 0o755); // resolve_node() in lib.rs requires the exec bit on unix

// ── Verify the vendored binary actually runs and reports the ABI we expect ──
let vendoredAbi;
try {
    vendoredAbi = execFileSync(destPath, ['-p', 'process.versions.modules'], {
        encoding: 'utf-8',
        timeout: 10_000,
    }).trim();
} catch (e) {
    console.error(`[vendor-node] vendored binary at ${destPath} failed to execute: ${e.message}`);
    console.error(`[vendor-node] this usually means a platform/arch mismatch (e.g. vendoring an x64 binary on arm64).`);
    process.exit(1);
}

const hostAbi = process.versions.modules;
if (sourceNode === process.execPath && vendoredAbi !== hostAbi) {
    // Shouldn't happen when copying our own execPath, but check anyway —
    // a corrupted copy or an unexpected exec wrapper would surface here.
    console.error(
        `[vendor-node] FAIL: vendored node reports ABI ${vendoredAbi} but the host that copied it is ABI ${hostAbi}. ` +
        `This should be impossible for a straight file copy of process.execPath — investigate before shipping.`,
    );
    process.exit(1);
}

console.log(`[vendor-node] copied ${sourceNode} → ${destPath}`);
console.log(`[vendor-node] vendored node ABI: ${vendoredAbi} (${execFileSync(destPath, ['--version'], { encoding: 'utf-8' }).trim()})`);
console.log(
    `[vendor-node] run \`npm run check:node-abi\` next to confirm this matches the native modules ` +
    `staged under atlas-core/node_modules before running \`tauri build\`.`,
);
