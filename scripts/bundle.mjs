/**
 * scripts/bundle.mjs — produce a SELF-CONTAINED Atlas bundle (E5/E7).
 *
 * Goal: a directory a user can run with ZERO separate setup — Lore, kuzu,
 * lancedb, sqlite are all inside, invisible. They install "Atlas".
 *
 * What it does:
 *   1. tsc build (Atlas dist/) + the browser UI (atlas-ui/dist/).
 *   2. Copy dist/ + bin/ + grammars/ + atlas-ui/dist/ + package.json + docs
 *      into dist-bundle/. atlas-ui/dist lands at <bundle>/atlas-ui/dist so the
 *      daemon's resolveUiDist() find-up (walks up from <bundle>/dist/mcp/…) finds
 *      it at <pkgRoot>/atlas-ui/dist and serves the UI at / — the CLI+web model.
 *   3. Deep-copy node_modules with the @groundfloor/lore symlink DEREFERENCED
 *      (so Lore's dist + native binaries travel with the bundle), pruning:
 *        - dev-only tooling (tsx, typescript, @types) — not needed at runtime
 *        - other-platform onnxruntime binaries (keep only this host's)
 *        - the fp32 full embedding model (model.onnx, ~470MB); the QUANTIZED
 *          model_quantized.onnx (~120MB) is KEPT so offline memory/recall works
 *        - *.tmp download partials
 *   4. Neutralize @kineviz/kuzu-lite's install-time CDN fetch in the COPY (the
 *      .node is already vendored alongside it — no GitHub/Alibaba download).
 *   5. Emit a `run-atlas.sh` launcher that runs fully offline.
 *
 * HONEST SCOPE: a bundle built here is for THIS host's platform only
 * (darwin-arm64). The native binaries (kuzu, lancedb, onnxruntime, sqlite) are
 * platform-specific; linux-x64/arm64 + win32 + intel-mac bundles need a CI
 * matrix building on each OS. intel-mac specifically is blocked upstream:
 * @lancedb/lancedb 0.27.2 ships no darwin-x64 prebuilt. See docs/PACKAGING.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-bundle');
const platform = `${process.platform}-${process.arch}`;

function log(msg) { process.stderr.write(`[bundle] ${msg}\n`); }
function dirSizeMB(p) {
    try { return Math.round(Number(execFileSync('du', ['-sm', p]).toString().split('\t')[0])); }
    catch { return -1; }
}

// ── 1. build (backend dist/ + browser UI atlas-ui/dist/) ─────────────────────
log('tsc build…');
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
// The daemon serves the browser UI (CLI+web model). atlas-ui/dist is a gitignored
// vite build artifact, so build it here too — a self-contained bundle that
// couldn't serve the UI would defeat the whole ship-vehicle purpose. Skip the
// (re)build with BUNDLE_SKIP_UI_BUILD=1 only if atlas-ui/dist is already fresh.
const uiDistSrc = path.join(root, 'atlas-ui', 'dist');
if (process.env.BUNDLE_SKIP_UI_BUILD === '1') {
    if (!fs.existsSync(path.join(uiDistSrc, 'index.html'))) {
        log('ERROR: BUNDLE_SKIP_UI_BUILD=1 but atlas-ui/dist/index.html is absent — cannot ship a UI-less bundle.');
        process.exit(1);
    }
    log('atlas-ui build skipped (BUNDLE_SKIP_UI_BUILD=1); using existing atlas-ui/dist.');
} else {
    log('atlas-ui build (vite)…');
    execFileSync('npm', ['run', 'build'], { cwd: path.join(root, 'atlas-ui'), stdio: 'inherit' });
}
if (!fs.existsSync(path.join(uiDistSrc, 'index.html'))) {
    log('ERROR: atlas-ui/dist/index.html missing after build — the bundle would serve no UI.');
    process.exit(1);
}

// ── 2. clean + scaffold ───────────────────────────────────────────────────────
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// `grammars/` holds the vendored tree-sitter .wasm blobs the parser resolves
// at `<root>/grammars/` (relative to dist/parser/) — required for parsing.
//
// `scripts/` is RUNTIME-LOAD-BEARING, not just build tooling: `atlas wire`
// (src/cli/wire.ts) installs Claude Code hooks whose command is
// `node <atlasRoot>/scripts/atlas-hook.mjs <event> <workspace>`, where
// atlasRoot = resolveRepoRoot() = this bundle's own root (it walks up from
// dist/cli/service.js to the package.json named '@groundfloor/atlas', which in
// the bundle IS the bundle root). If scripts/ is absent from the bundle, every
// installed hook fails ENOENT ('Cannot find module .../scripts/atlas-hook.mjs')
// and the auto-consultation harness silently no-ops. So the whole scripts/ dir
// ships (it's tiny, ~60KB) — atlas-hook.mjs is the only file the running daemon/
// CLI resolves relative to the bundle root, but copying the dir wholesale is
// cheap and future-proofs any other runtime script wire/service adds later.
for (const f of ['dist', 'bin', 'grammars', 'scripts', 'package.json', 'README.md', 'LICENSE']) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(out, f), { recursive: true });
}
// Hard invariant: the bundled hook client MUST exist, or `atlas wire` from this
// bundle installs broken hooks. Fail the build loudly rather than ship it.
if (!fs.existsSync(path.join(out, 'scripts', 'atlas-hook.mjs'))) {
    log('ERROR: scripts/atlas-hook.mjs missing from the bundle — `atlas wire` would install broken (ENOENT) hooks.');
    process.exit(1);
}
// Browser UI: copy atlas-ui/dist → <bundle>/atlas-ui/dist, the EXACT path the
// daemon's resolveUiDist() find-up resolves to (walks up from <bundle>/dist/mcp/
// server.js to <bundle>/atlas-ui/dist and checks index.html). We copy ONLY
// atlas-ui/dist (the built artifact), not atlas-ui/ (which carries src/,
// node_modules/, src-tauri/ — none of it load-bearing for serving the shell).
fs.mkdirSync(path.join(out, 'atlas-ui'), { recursive: true });
fs.cpSync(uiDistSrc, path.join(out, 'atlas-ui', 'dist'), { recursive: true });
log('copied atlas-ui/dist → <bundle>/atlas-ui/dist (daemon serves the browser UI at /).');

// ── 3. node_modules (deref lore symlink, prune cruft) ─────────────────────────
const srcNM = path.join(root, 'node_modules');
const dstNM = path.join(out, 'node_modules');
// keep only this host's onnxruntime platform dir
const onnxKeep = new Set([process.platform]);
// Dev/junk dirs the deref'd Lore checkout drags in but the runtime never needs.
// `.audit-env` (~430MB security-audit sandbox) + `.git` (~27MB history) alone are
// ~457MB of pure waste — the dominant non-load-bearing weight in the bundle.
const EXCLUDE_DIR_NAMES = new Set([
    'tsx', 'typescript', '.bin', '.cache',
    '.git', '.audit-env', '.swarm', '.claude', '.github',
]);
const EXCLUDE_PATH_FRAGMENTS = [
    path.join('@types', 'node'),
    // Lore's non-embedded-graph-store payload: the web UI, tests, docs, and the
    // document-ingestion stack (OCR / PDF / image / Lore's own tree-sitter).
    // The embedded graph store (kuzu+lancedb+sqlite) never loads these.
    // WARNING: this prune list was hand-verified against the CURRENT Lore
    // version; there is NO automated post-bundle smoke test guarding it. A
    // future Lore that adds a runtime dep whose path matches an EXCLUDE fragment
    // (or moves an embedded-path module under ui/test/docs) would ship a
    // silently-broken offline bundle that only fails at user runtime. Re-verify
    // (and ideally add an `index + read` smoke run against dist-bundle/) on every
    // Lore bump. See the confirmed audit finding in docs/.
    //
    // NOTE: @groundfloor/lore's OWN top-level tree is now pruned by ALLOWLIST in
    // isLorePrunedTopLevel() below (keeps only its published runtime footprint —
    // dist/, node_modules/, package.json, scripts/ensure-kuzu-native.mjs). That
    // allowlist SUPERSEDES the three ui/test/docs excludes here (they're a subset
    // of what the allowlist drops) and, unlike them, also strips the internal
    // security-audit dossier + roadmap (AUDIT_FINDINGS*.md, AUDIT_SPRINTS.md,
    // SWARM_QUEUE*, SPRINT_QUEUE, HANDOFF, NEW_OWNER_GUIDE, src/, …) that the
    // deref-copied checkout would otherwise ship — a pre-written exploit map for
    // the embedded engine (confirmed audit finding).
    path.join('node_modules', 'onnxruntime-web'),
    path.join('node_modules', 'tesseract.js'),
    path.join('node_modules', 'tesseract.js-core'),
    path.join('node_modules', 'pdfjs-dist'),
    path.join('node_modules', 'tree-sitter-wasms'),
    path.join('node_modules', '@tree-sitter-grammars'),
    // Document-ingestion EXTRACTOR libs — loaded ONLY via dynamic import when a
    // document is actually ingested (P1 made these lazy). Atlas never ingests
    // documents, so the graph-store path never loads them. Verified safe to
    // prune against the current Lore version (no automated smoke test guards
    // this — see the WARNING above; re-verify on every Lore bump).
    path.join('node_modules', 'exceljs'),     // spreadsheet ingestion
    path.join('node_modules', 'mammoth'),     // .docx ingestion
    path.join('node_modules', 'mailparser'),  // email ingestion
    // @napi-rs/canvas is used only by the lazy PDF extractor (stub, Lore fd08af7),
    // never loaded on Atlas's store/recall/search path — safe to prune.
    path.join('@napi-rs', 'canvas'),           // canvas (image rendering)
    // NOTE: hono / @hono are NOT pruned. They were previously excluded as
    // "Lore daemon-only HTTP stack", but that was WRONG: @hono/node-server is a
    // runtime import of @modelcontextprotocol/sdk's streamableHttp.js, which
    // ATLAS'S OWN daemon loads (src/mcp/server.ts imports
    // StreamableHTTPServerTransport for the /mcp transport). Pruning them made
    // the bundle boot only because Node fell back to the repo's own node_modules
    // when the bundle sat INSIDE the repo tree; a bundle copied OUT of the tree
    // (the real ship scenario) crashed at daemon boot with ERR_MODULE_NOT_FOUND
    // '@hono/node-server'. Caught by the out-of-tree self-containment test.
    // keytar is also left in (native module, may be required at Lore boot).
    // NOTE: sharp (@img) MUST stay. It is NOT pulled by the (now-lazy) image
    // extractor — it's a dependency of @huggingface/transformers (the embedding
    // lib), which loads at embedded boot when the local embedder initializes. So
    // sharp loads whenever Atlas embeds; pruning @img crashes serve at sharp.js.
    // The real fix is upstream (transformers lazy-loading sharp) — out of Lore's
    // hands. Documented in docs/LORE-REQUIREMENTS.md.
    // NOTE: @lumis-sh/wasm-sql is on the edge write/read path (queryEdges
    // returns 0 without it) — MUST stay. Kept intentionally.
];
// @groundfloor/lore RUNTIME allowlist. The deref-copied Lore checkout is a full
// dev tree (src/, docs/, eval/, test/, packages/, output.log, config baselines,
// AND an internal security-audit dossier + roadmap: AUDIT_FINDINGS*.md,
// AUDIT_SPRINTS.md, SWARM_QUEUE*, SPRINT_QUEUE, HANDOFF, NEW_OWNER_GUIDE, …).
// Its published package.json `files` is ["dist/","scripts/ensure-kuzu-native.mjs"];
// the daemon additionally needs the nested node_modules/ (kuzu-lite + its vendored
// .node, etc.) and package.json itself at runtime. Everything else is dev cruft
// or an exploit map for the embedded engine — prune it to the runtime footprint.
const LORE_PKG_FRAG = path.join('@groundfloor', 'lore') + path.sep;
const LORE_RUNTIME_TOPLEVEL = new Set(['dist', 'node_modules', 'scripts', 'package.json']);
// Within scripts/, keep ONLY the postinstall helper the package declares.
const LORE_SCRIPTS_KEEP = new Set(['ensure-kuzu-native.mjs']);
/** True for any path under node_modules/@groundfloor/lore/ whose FIRST path
 *  segment (relative to the lore package root) is NOT in the runtime allowlist —
 *  i.e. it's dev cruft / the audit dossier / source, safe to drop. */
function isLorePrunedTopLevel(src) {
    const idx = src.indexOf(LORE_PKG_FRAG);
    if (idx === -1) return false;
    const rel = src.slice(idx + LORE_PKG_FRAG.length);
    if (!rel) return false; // the lore package dir itself — keep, recurse into it
    const [first, ...rest] = rel.split(path.sep);
    // A DEEPER @groundfloor/lore (nested under lore/node_modules/...) is governed
    // by that inner copy's own rules, not this top-level allowlist — the `rel`
    // here is already relative to the OUTERMOST lore, so `first` is correct: if
    // first === 'node_modules' we keep the whole subtree (deps travel with it).
    if (!LORE_RUNTIME_TOPLEVEL.has(first)) return true;
    // Keep only the one declared postinstall helper inside scripts/.
    if (first === 'scripts' && rest.length > 0 && !LORE_SCRIPTS_KEEP.has(rest[0])) return true;
    return false;
}

function shouldExclude(src) {
    const base = path.basename(src);
    if (isLorePrunedTopLevel(src)) return true;
    // KEEP the local embedding model so offline memory/recall works in the bundle.
    // It lives under a `.cache` dir (which EXCLUDE_DIR_NAMES would otherwise prune),
    // so allow it through here — but drop the fp32 full model.onnx (~470MB). The
    // quantized model_quantized.onnx (~120MB) is what Lore loads by default (q8).
    if (src.includes(path.join('@huggingface', 'transformers', '.cache'))) {
        if (base === 'model.onnx') return true;
        // drop incomplete download partials (e.g. model.onnx.tmp.1310.1uns3n4) —
        // they are ~165MB of dead weight (offline launcher loads model_quantized.onnx).
        if (base.endsWith('.tmp') || base.includes('.tmp.')) return true;
        return false;
    }
    if (base === '.tmp' || base.endsWith('.tmp') || base.includes('.tmp.')) return true;
    if (EXCLUDE_DIR_NAMES.has(base)) return true;
    for (const frag of EXCLUDE_PATH_FRAGMENTS) if (src.includes(frag)) return true;
    // onnxruntime: drop other-platform binary dirs
    const m = src.match(/onnxruntime-node[\/].*[\/]napi-v6[\/]([^\/]+)$/);
    if (m && !onnxKeep.has(m[1])) return true;
    return false;
}
log('copy node_modules (deref @groundfloor/lore, prune dev/other-platform/model)…');
fs.cpSync(srcNM, dstNM, {
    recursive: true,
    dereference: true,
    filter: (src) => !shouldExclude(src),
});

// ── 3b. PRUNE the ArcadeDB cloud control-plane from the COPIED Lore dist ───────
// Atlas runs Lore EMBEDDED (embeddedLore.ts hardcodes deploymentMode:'embedded')
// and NEVER enters arcade mode: Lore only reaches the arcade path via a dynamic
// `import('./arcadeBoot.js')` in mcp/server.ts, gated on effectiveMode==='arcade',
// which the embedded boot never resolves to. But the deref copy above brings
// Lore's WHOLE dist/ along, so ~100+ compiled arcade files (engines/arcade/*,
// mcp/arcadeBoot.*, mcp/http/routes/arcade*, plus their .d.ts/.map siblings) —
// a design/attack map for the unreleased cloud offering — otherwise ship inside
// the PUBLIC bundle as dead code. Remove those three trees from the copied
// @groundfloor/lore/dist. SAFE because arcade is dynamic-import-only from the
// embedded path (verified: the ONLY reference from non-arcade Lore code is the
// gated `await import('./arcadeBoot.js')`; every static `import … arcade …`
// originates from a file that is itself inside one of these three trees). The
// post-bundle smokes below (offline index + daemon serve) PROVE the embedded
// path still works without them, and the `find … engines/arcade` assertion after
// the smokes proves the tree is actually gone. Conservative: we prune ONLY these
// three known dynamic-import-only trees; other arcade-named files outside them
// (e.g. security/arcadeRateClassifier.*, itself only imported by arcadeBoot) are
// left untouched to stay within the audited scope.
const loreDistSrc = path.join(dstNM, '@groundfloor', 'lore', 'dist', 'lore', 'src');
/** Prune targets under the copied Lore dist's src/ root, as [predicate, label]. */
const ARCADE_PRUNE = [
    // whole engines/arcade/ subtree
    { dir: path.join(loreDistSrc, 'engines', 'arcade'), label: 'engines/arcade/' },
];
// mcp/arcadeBoot.* (all extensions) and mcp/http/routes/arcade* (all files).
const ARCADE_GLOB = [
    { dir: path.join(loreDistSrc, 'mcp'), prefix: 'arcadeBoot.', label: 'mcp/arcadeBoot.*' },
    { dir: path.join(loreDistSrc, 'mcp', 'http', 'routes'), prefix: 'arcade', label: 'mcp/http/routes/arcade*' },
];
let arcadePruned = 0;
if (fs.existsSync(loreDistSrc)) {
    for (const { dir, label } of ARCADE_PRUNE) {
        if (fs.existsSync(dir)) {
            const n = fs.readdirSync(dir).length;
            fs.rmSync(dir, { recursive: true, force: true });
            arcadePruned += n;
            log(`arcade prune: removed ${label} (${n} entries)`);
        }
    }
    for (const { dir, prefix, label } of ARCADE_GLOB) {
        if (!fs.existsSync(dir)) continue;
        let n = 0;
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith(prefix)) {
                fs.rmSync(path.join(dir, name), { recursive: true, force: true });
                n += 1;
            }
        }
        if (n > 0) { arcadePruned += n; log(`arcade prune: removed ${label} (${n} files)`); }
    }
    log(`arcade prune: ${arcadePruned} arcade cloud files dropped from the public bundle.`);
} else {
    log(`WARNING: expected Lore dist src at ${loreDistSrc} not found — arcade prune skipped (Lore layout changed?).`);
}

// ── 4. neutralize the kuzu-lite install-time CDN fetch in the COPY ────────────
const kuzuPkgPath = path.join(dstNM, '@groundfloor', 'lore', 'node_modules', '@kineviz', 'kuzu-lite', 'package.json');
if (fs.existsSync(kuzuPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(kuzuPkgPath, 'utf8'));
    const node = path.join(path.dirname(kuzuPkgPath), 'kuzujs.node');
    if (fs.existsSync(node) && pkg.scripts?.install) {
        delete pkg.scripts.install; // binary is vendored alongside; no download
        fs.writeFileSync(kuzuPkgPath, JSON.stringify(pkg, null, 2));
        log('kuzu-lite: removed install-time CDN fetch (kuzujs.node vendored in bundle)');
    }
}

// ── 5. offline launchers ──────────────────────────────────────────────────────
// CRITICAL: resolve HERE to its PHYSICAL path (`pwd -P`, follows symlinks). The
// daemon/CLI entry points detect "am I the main module?" by comparing
// import.meta.url (which Node reports as the realpath) against
// `file://${process.argv[1]}` (the path AS PASSED). If the launcher passes a
// path that traverses a symlink (e.g. /tmp → /private/tmp on macOS, or a
// symlinked install dir / Homebrew bin shim), those two differ, the guard is
// FALSE, and `node dist/cli.js` / `node dist/daemon.js` SILENTLY no-op (exit 0,
// no server, no output). Passing the realpath makes argv[1] match import.meta.url
// so the entry actually runs. This is why the launchers exist and why direct
// `node <bundle>/dist/daemon.js` through a symlinked path is NOT the supported
// entry — use these launchers (or `bin/atlas`, which we harden the same way).
// (Root cause is a naive main-module guard in src/{cli,daemon}.ts — fixing it
// there is the real remedy; the launcher realpath makes the bundle robust today
// without touching src/.)
const launcherHeader = `#!/usr/bin/env bash
set -euo pipefail
# Resolve to the PHYSICAL bundle dir (follow symlinks) — see bundle.mjs note.
HERE="$(cd -P "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
export TRANSFORMERS_OFFLINE=\${TRANSFORMERS_OFFLINE:-1}
export HF_HUB_OFFLINE=\${HF_HUB_OFFLINE:-1}
`;
// run-atlas.sh → the CLI (index/serve/service/etc). `run-atlas.sh serve` starts
// the daemon + browser UI (the CLI+web ship recipe).
fs.writeFileSync(
    path.join(out, 'run-atlas.sh'),
    `${launcherHeader}exec node "$HERE/dist/cli.js" "$@"\n`,
    { mode: 0o755 },
);
// run-daemon.sh → boot the daemon directly (serves the browser UI at / and runs
// embedded Lore). Equivalent to `run-atlas.sh serve` but a bare daemon entry for
// service managers that want to exec the daemon without the CLI dispatch.
fs.writeFileSync(
    path.join(out, 'run-daemon.sh'),
    `${launcherHeader}exec node "$HERE/dist/daemon.js" "$@"\n`,
    { mode: 0o755 },
);
// Harden the bundled bin/atlas the same way — it must pass the realpath'd script
// so the main-module guard fires through symlinked bin dirs (npm global installs,
// Homebrew, etc.). Rewrite it in the COPY only (repo bin/atlas is untouched).
const bundledBin = path.join(out, 'bin', 'atlas');
if (fs.existsSync(bundledBin)) {
    fs.writeFileSync(
        bundledBin,
        `#!/usr/bin/env bash\n` +
        `set -euo pipefail\n` +
        `# Self-contained bundle wrapper — resolve the PHYSICAL bundle root so the\n` +
        `# cli.js main-module guard fires even through symlinked bin dirs. See bundle.mjs.\n` +
        `SELF="\${BASH_SOURCE[0]}"\n` +
        `while [ -h "$SELF" ]; do DIR="$(cd -P "$(dirname "$SELF")" && pwd -P)"; SELF="$(readlink "$SELF")"; [[ "$SELF" != /* ]] && SELF="$DIR/$SELF"; done\n` +
        `HERE="$(cd -P "$(dirname "$SELF")" && pwd -P)"\n` +
        `ROOT="$(cd -P "$HERE/.." && pwd -P)"\n` +
        `exec node "$ROOT/dist/cli.js" "$@"\n`,
        { mode: 0o755 },
    );
    log('hardened bundled bin/atlas (realpath resolution for the main-module guard).');
}

// ── manifest ──────────────────────────────────────────────────────────────────
const manifest = {
    platform,
    builtAt: process.env.BUNDLE_STAMP ?? null,
    node: process.version,
    // NODE_MODULE_VERSION of the Node that built/ran this bundle step — the
    // vendored native modules (kuzu/lancedb/better-sqlite3/onnxruntime) are
    // copied verbatim from this host's node_modules, so they are only valid
    // under a Node reporting this same ABI. Checked by scripts/check-node-abi.mjs
    // (pkg-node-abi-unpinned) so a Node upgrade between bundling and shipping
    // is caught before it becomes a silent native crash.
    nodeAbi: process.versions.modules,
    sizeMB: dirSizeMB(out),
    // Presence of the browser UI shell — the daemon serves atlas-ui/dist at /.
    ui: fs.existsSync(path.join(out, 'atlas-ui', 'dist', 'index.html')),
    note: 'Single-platform self-contained bundle for the CLI+web model: the daemon (dist/daemon.js, or `bin/atlas serve`) serves the bundled browser UI (atlas-ui/dist) at / AND runs embedded Lore (kuzu+lancedb+sqlite) with NO external node_modules and NO sibling ../groundfloor-lore. Ships the quantized e5 embedding model (model_quantized.onnx) so offline memory/recall works out of the box; only the fp32 model.onnx is pruned. Multi-platform needs a CI matrix.',
};
fs.writeFileSync(path.join(out, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2));
log(`done → ${out}  (${manifest.sizeMB} MB, ${platform})`);

// ── 6. post-bundle offline smoke — the REAL prune-safety net ──────────────────
// The aggressive prune above is only safe if the bundle still parses, embeds,
// and stores OFFLINE using ONLY its own pruned node_modules. Prove it: index a
// throwaway file through the bundled cli with the offline env the launcher sets,
// and FAIL the build (exit 1) on any missing-module/native error or a non-ok
// result. This is what makes `npm run bundle` a gate rather than a hope — a
// future Lore bump that drops a runtime dep matching an EXCLUDE fragment now
// breaks the build here instead of silently shipping a broken offline bundle.
// Skip with BUNDLE_SKIP_SMOKE=1 (e.g. cross-compile where this host can't run it).
if (process.env.BUNDLE_SKIP_SMOKE !== '1') {
    log('post-bundle offline smoke (index a file through the bundle)…');
    const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bundle-smoke-'));
    const smokeFile = path.join(smokeHome, 'smoke.ts');
    fs.writeFileSync(smokeFile, 'export function smokeAlpha(n){ return smokeBeta(n); }\nexport function smokeBeta(n){ return n + 1; }\n');
    try {
        const stdout = execFileSync(
            process.execPath,
            [path.join(out, 'dist', 'cli.js'), 'index', smokeFile],
            {
                cwd: smokeHome,
                env: { ...process.env, ATLAS_HOME: path.join(smokeHome, 'home'), TRANSFORMERS_OFFLINE: '1', HF_HUB_OFFLINE: '1' },
                encoding: 'utf8',
                timeout: 180_000,
                stdio: ['ignore', 'pipe', 'inherit'],
            },
        );
        const m = stdout.match(/\{[\s\S]*\}/);
        const res = m ? JSON.parse(m[0]) : null;
        if (!res || res.ok !== true || !(res.symbolsWritten > 0)) {
            throw new Error(`smoke index returned ${m ? m[0].replace(/\s+/g, ' ').slice(0, 200) : '(no JSON)'}`);
        }
        log(`smoke OK — bundle indexed offline (${res.symbolsWritten} symbols).`);
    } catch (err) {
        process.stderr.write(`[bundle] SMOKE FAILED — the pruned bundle is broken offline:\n${err.message}\n`);
        process.exit(1);
    } finally {
        fs.rmSync(smokeHome, { recursive: true, force: true });
    }

    // ── 7. daemon/UI serve smoke — prove the CLI+web ship vehicle actually serves.
    // The index smoke proves embedded Lore works from the bundle; this proves the
    // OTHER half of the CLI+web model: booting the daemon (dist/daemon.js) from the
    // bundle serves the browser UI shell at / and answers /health. A bundle that
    // indexes but can't serve the UI is not a valid ship vehicle. FAILs the build.
    log('post-bundle daemon serve smoke (boot the daemon via run-daemon.sh, hit /health + /)…');
    const serveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bundle-serve-'));
    const servePort = 3000 + (process.pid % 5000);
    let daemon = null;
    try {
        const { spawnSync, spawn } = await import('node:child_process');
        // Boot via the run-daemon.sh launcher (realpath-resolves the script path)
        // rather than raw `node dist/daemon.js` — os.tmpdir() is /var/folders or
        // /tmp, both often symlinked, and the bare-node path would silently no-op
        // through a symlink (the main-module-guard bug the launcher works around).
        daemon = spawn(
            'bash',
            [path.join(out, 'run-daemon.sh')],
            {
                cwd: serveHome,
                env: {
                    ...process.env,
                    ATLAS_HOME: path.join(serveHome, 'home'),
                    ATLAS_PORT: String(servePort),
                    TRANSFORMERS_OFFLINE: '1',
                    HF_HUB_OFFLINE: '1',
                },
                stdio: ['ignore', 'ignore', 'inherit'],
            },
        );
        // Poll /health until the daemon answers (bounded ~30s).
        const base = `http://127.0.0.1:${servePort}`;
        let health = null;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await fetch(`${base}/health`);
                if (r.ok) { health = await r.json().catch(() => ({})); break; }
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!health) throw new Error('daemon did not answer /health within ~30s');
        // GET / must return the app shell (index.html with <div id="root").
        const rootRes = await fetch(`${base}/`);
        const rootBody = await rootRes.text();
        if (!rootRes.ok || !rootBody.includes('<div id="root"')) {
            throw new Error(`GET / did not return the app shell (status ${rootRes.status}, has-root-div=${rootBody.includes('<div id="root"')})`);
        }
        log(`daemon serve OK — /health ${JSON.stringify(health).slice(0, 80)}; / served the app shell (${rootBody.length} bytes).`);
        void spawnSync; // (reserved; kept for parity with the sync smoke above)
    } catch (err) {
        process.stderr.write(`[bundle] DAEMON SERVE SMOKE FAILED — the bundle can't serve the UI:\n${err.message}\n`);
        if (daemon) { try { daemon.kill('SIGKILL'); } catch { /* ignore */ } }
        fs.rmSync(serveHome, { recursive: true, force: true });
        process.exit(1);
    }
    if (daemon) { try { daemon.kill('SIGTERM'); } catch { /* ignore */ } }
    // give it a beat to drain, then hard-kill if still alive
    await new Promise((r) => setTimeout(r, 1500));
    if (daemon && daemon.exitCode === null) { try { daemon.kill('SIGKILL'); } catch { /* ignore */ } }
    fs.rmSync(serveHome, { recursive: true, force: true });

    // ── 8. arcade-prune assertion — the smokes above PROVED the embedded path
    // still indexes + serves; now prove the arcade cloud tree is actually GONE
    // from the shipped bundle (the point of step 3b). A single surviving
    // engines/arcade/* file means the prune silently regressed (Lore layout
    // moved, path drift, etc.) — FAIL the build rather than ship the dead
    // control-plane code map. Mirrors `find dist-bundle -ipath '*engines/arcade*'`.
    log('arcade-prune assertion (no engines/arcade/* survives in the bundle)…');
    const survivors = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (full.toLowerCase().includes(path.join('engines', 'arcade'))) { survivors.push(full); continue; }
                walk(full);
            } else if (full.toLowerCase().includes(path.join('engines', 'arcade'))) {
                survivors.push(full);
            }
        }
    };
    walk(out);
    if (survivors.length > 0) {
        process.stderr.write(`[bundle] ARCADE PRUNE ASSERTION FAILED — ${survivors.length} engines/arcade path(s) survived in the bundle:\n${survivors.slice(0, 10).join('\n')}\n`);
        process.exit(1);
    }
    log('arcade-prune assertion OK — 0 engines/arcade paths in the bundle.');
}
