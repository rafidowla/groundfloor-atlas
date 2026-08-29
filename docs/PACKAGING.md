# Groundfloor Atlas Packaging

## Shipping model (current)

**Groundfloor Atlas/Atlas runs as a CLI-installed daemon that serves its own browser
UI.** There is no bundled Node runtime and no desktop app in the current
shipping target — the daemon (`atlas serve`) resolves and serves the built
`atlas-ui/dist` at its own origin (same port as `/mcp`), and the operator opens
that origin in whatever browser they already have. See
`atlas-daemon-serves-ui-token-via-url` (src/mcp/server.ts `resolveUiDist()`,
src/cli.ts `cmdServe`/`cmdServiceInstall`) for the implementation.

There are **two ways to deliver that daemon+UI**, and they are NOT
interchangeable today:

| Ship vehicle | Command | Self-contained? | Status |
| --- | --- | --- | --- |
| **Self-contained bundle** (`dist-bundle/`) | `npm run bundle` | **YES** — Lore engine + native modules + model + UI all inside | **CURRENT primary** — the offline / no-registry ship vehicle |
| **npm tarball** (`atlas-*.tgz`) | `npm pack` / `npm publish` | **NO** — does NOT bundle the Lore engine | **FUTURE** — becomes viable only once `@groundfloor/lore` is published to a registry |

### Building a release (one command)

The Lore engine is vendored into this repo as a committed tarball
(`vendor/groundfloor-lore-<version>.tgz`, referenced from `package.json` as
`@groundfloor/lore: file:vendor/…`), so `npm install` resolves it with no
sibling checkout. `scripts/release-build.sh` packages the release into one
reproducible step: it verifies the vendored tarball — exists, its own
`package.json` version matches its filename, and its license is the
Elastic-2.0 NOTICE discloses (via `scripts/check-license-headers.mjs`, the
same assertion CI runs) — then `npm install` + `npm run bundle`, and zips
the result into a versioned, checksummed artifact under `release/`:

```bash
scripts/release-build.sh
# → release/groundfloor-atlas-v<version>-<platform>-<arch>-node<major>.zip
```

The bundle's native modules ABI-lock to the build machine's Node **major**
version, so build on the Node your users will run (v0.2.0 targets Node 20;
engines pin `>=20 <23`). Ship the zip — the recipient needs neither repo,
only a matching Node runtime.

> **Why the bundle is the current ship vehicle, not `npm pack`.** The npm
> tarball's `files` whitelist is `["dist/", "atlas-ui/dist/", "bin/",
> "LICENSE", "NOTICE", "CHANGELOG.md", "docs/tool-schemas.json"]` — it
> deliberately ships **no `node_modules`** and **no `vendor/`**. So the
> tarball does NOT contain `node_modules/@groundfloor/lore` (the actual
> embedded engine: surrealdb + lancedb + better-sqlite3 + onnxruntime + the e5
> model). The `dist/lore/*.js` files inside the tarball are Atlas's OWN thin
> adapter code (compiled from `src/lore/*.ts`), **not** the engine.
> Installing that tarball therefore still has to *resolve* `@groundfloor/lore`
> from somewhere — and that dependency is pinned to the committed
> `file:vendor/groundfloor-lore-3.16.0.tgz`, which the npm tarball does not
> carry. Empirically (re-verified 2026-08-28, npm 10.9.8 and 11.19.1,
> isolated-consumer installs of the packed tarball AND of a publish to a local
> registry): a `file:` spec in a shipped manifest is resolved against the
> *installer's* filesystem — the destination
> `node_modules/@groundfloor/atlas/vendor/…` path — never from inside the
> shipped artifact, so the install fails with `ENOENT` before extracting
> anything. **Adding `vendor/` to the `files` whitelist does not fix this**
> (tested: the vendored tarball ships, the install still fails identically).
> Two mechanisms actually work: (a) publish `@groundfloor/lore` to a registry
> and depend on it by version, or (b) declare `"bundleDependencies":
> ["@groundfloor/lore"]` so npm embeds the engine (and its dependency tree)
> inside the tarball. Note (b) has a second prerequisite measured the hard
> way: `"scripts/"` must also be in `files`, because the shipped CLI
> (`dist/cli/memorySync.js`, `dist/memoryFile.js`, `dist/cli/gitHooks.js`)
> imports `scripts/memory-merge-driver.mjs` at runtime — without it the CLI
> crashes with `ERR_MODULE_NOT_FOUND` even though the install succeeds. With
> both, an isolated `npm install` of the tarball was verified end-to-end:
> install exits 0, `atlas --help` exits 0, and the engine imports with its
> real exports. The cost: ~470 MB packed / 1.4 GB installed, with the build
> machine's platform/ABI-locked native modules embedded. Retesting warning:
> installing the packed tarball *from inside this repo* produces a false
> success — npm falls back to `<repo>/vendor/…` on your own disk; always copy
> the tarball to a neutral directory first. `npm pack` only becomes a viable
> ship vehicle once Lore itself is
> published to a registry (see the git-dependency writeup below). **Until
> then, the self-contained bundle is how Atlas ships to anyone who does not
> have the Lore source tree** — it is the artifact that sidesteps publishing
> Lore.

## Self-contained bundle — the CURRENT ship vehicle

`npm run bundle` (`scripts/bundle.mjs`) produces `dist-bundle/`: a **fully
self-contained** directory that runs the daemon+UI with **no `npm install`, no
registry access, and no sibling `../groundfloor-lore`**. Everything the embedded
engine needs travels inside it. This is the distribution artifact for offline
and air-gapped installs, and the answer to "how do we ship without publishing
Lore".

### Build & run recipe (offline bundle)

```bash
npm run build                 # backend → dist/ (also run inside bundle.mjs)
cd atlas-ui && npm run build  # browser UI → atlas-ui/dist  (also run inside bundle.mjs)
cd .. && npm run bundle       # → dist-bundle/ (deref Lore, vendor natives+model, copy UI)

# ship dist-bundle/ to a same-platform machine, then:
ATLAS_HOME=~/.atlas ATLAS_PORT=3848 bash dist-bundle/run-daemon.sh   # daemon + UI at http://127.0.0.1:3848/
#   or the full CLI:  bash dist-bundle/run-atlas.sh serve --open
#   or:               dist-bundle/bin/atlas serve
```

`bundle.mjs` runs both builds itself, so a bare `npm run bundle` is sufficient;
the explicit builds above are only needed if you want to inspect the artifacts
first. Set `BUNDLE_SKIP_UI_BUILD=1` to reuse an already-fresh `atlas-ui/dist`.

### What the bundle contains

```
dist-bundle/
  dist/                 # compiled Atlas backend (daemon.js, cli.js, mcp/server.js …)
  atlas-ui/dist/        # built browser UI — served at / by the daemon (resolveUiDist finds it here)
  bin/atlas             # CLI launcher (realpath-hardened, see below)
  run-atlas.sh          # CLI launcher (offline env); `run-atlas.sh serve` = daemon + UI
  run-daemon.sh         # bare daemon launcher (offline env) — serves UI + embedded Lore
  grammars/             # vendored tree-sitter .wasm (required for parsing)
  node_modules/         # @groundfloor/lore DEREFERENCED (real files, no symlink) + native
                        #   modules (surrealdb/lancedb/better-sqlite3/onnxruntime) + quantized model
  bundle-manifest.json  # platform, size, node version + ABI, ui:true
  package.json, README.md, LICENSE
```

Self-containment invariants the build guarantees (all verified — see the
post-bundle smokes in `bundle.mjs`, which FAIL the build on any regression):

- **`atlas-ui/dist` is bundled** at `<bundle>/atlas-ui/dist` — the exact path the
  daemon's `resolveUiDist()` find-up resolves to (it walks up from
  `<bundle>/dist/mcp/server.js` to `<pkgRoot>/atlas-ui/dist`). The daemon serves
  the app shell (`index.html`, `<div id="root">`) and its assets at `/`.
- **`@groundfloor/lore` is copied in as real files** — installed from the
  vendored `file:vendor/…tgz` (npm unpacks tarball deps as real directories,
  not links) and copied wholesale. `find dist-bundle -type l` returns
  **nothing**; there is no symlink to escape the bundle. The engine resolves
  *inside* the bundle.
- **Native modules are vendored** for this host's platform: the embedded
  SurrealDB engine (`@surrealdb/node`), lancedb (`lancedb.<platform>.node`),
  better-sqlite3 (`better_sqlite3.node`), onnxruntime
  (`onnxruntime_binding.node`).
- **The quantized e5 model** (`model_quantized.onnx`, ~113MB) ships so offline
  memory/recall works out of the box; only the fp32 `model.onnx` is pruned.
- **`@hono` / `hono` are included** — `@hono/node-server` is a runtime import of
  the MCP SDK's `streamableHttp.js`, which Atlas's OWN daemon loads for the
  `/mcp` transport. (They were previously mis-pruned as "Lore daemon-only"; that
  made the daemon boot only because Node fell back to the repo's `node_modules`
  when the bundle sat inside the repo — a bundle copied OUT of the tree crashed
  with `ERR_MODULE_NOT_FOUND '@hono/node-server'`. Now kept.)

### Launchers and the main-module symlink gotcha

Start the daemon from the bundle via **`run-daemon.sh`**, **`run-atlas.sh serve`**,
or **`bin/atlas serve`** — NOT via a bare `node dist-bundle/dist/daemon.js` if the
bundle path traverses a symlink.

Why: `src/{cli,daemon}.ts` detect "am I the process entry point?" with
`import.meta.url === \`file://${process.argv[1]}\``. Node reports `import.meta.url`
as the **realpath**, but `process.argv[1]` is the path **as passed**. When the two
differ — e.g. `/tmp` → `/private/tmp` on macOS, a symlinked install dir, or a
Homebrew/npm-global `bin` shim — the guard is FALSE and the entry **silently
no-ops** (exit 0, no server, no output). The bundle's launchers resolve the
**physical** path (`pwd -P`, `readlink` chain) before invoking node, so
`argv[1]` matches `import.meta.url` and the entry actually runs. This was found
by running the bundle out-of-tree through `/tmp`; the launcher realpath makes the
bundle robust today. The proper fix is a realpath-aware main-module guard in
`src/{cli,daemon}.ts` (not done here — the launchers work around it without
touching `src/`).

### Cross-platform caveat (host-only)

A bundle built here is **for this host's platform only** (the vendored native
binaries are platform + Node-ABI specific — `bundle-manifest.json` records
`platform` and `nodeAbi`; `scripts/check-node-abi.mjs` guards a Node upgrade
between bundling and shipping). Linux-x64/arm64, win32, and intel-mac bundles
need a CI matrix building on each OS. intel-mac (darwin-x64) is specifically
blocked upstream: `@lancedb/lancedb` ships no darwin-x64 prebuilt.

## The npm tarball path — FUTURE (needs Lore published)

The npm-pack path below is the **eventual registry ship vehicle**, but it is
**NOT self-contained today** (see the table and callout at the top: it does not
bundle the Lore engine, so a real user's install fails while
`@groundfloor/lore` is an unpublished `file:../` dependency). Keep this section
because the mechanics (the `files` whitelist + `prepack` + the `.npmignore`
gotcha) are already wired and correct — they become the ship vehicle the moment
Lore is published.

### Install & run recipe

```bash
npm install -g @groundfloor/atlas        # or: npm install (local), or clone + npm ci
atlas service install                    # installs a launchd (macOS) / systemd (Linux) unit, auth ON
```

`atlas service install` starts the daemon as a background service and prints a
token-bearing launch URL (the "Jupyter model" — the bearer token travels as a
URL query param, never logged in full, stripped from the address bar on first
load):

```
[atlas] open the UI (token-authenticated, do not share this URL):
[atlas]   http://127.0.0.1:3848/?token=<mcp.token>
```

Open that URL in a browser. The frontend reads the token from the URL,
stores it, and uses it to authenticate every `/mcp` and `/api/*` call — the
static UI shell itself is public loopback content served without the bearer,
but nothing behind it is reachable without the token.

For a foreground run (no background service) instead:

```bash
atlas serve --open       # starts the daemon in this terminal, best-effort opens the browser
```

`atlas service uninstall` / `atlas service status` manage the installed
service. See `README.md` and `atlas help` for the full CLI surface.

### What makes this work after a plain install

`atlas serve` needs the **built** `atlas-ui/dist` to have a UI at all —
`atlas-ui/dist` is a build artifact and is gitignored, so it does not exist in
a bare git checkout. The published npm package instead **ships it built**:

- `package.json`'s `files` whitelist includes `atlas-ui/dist/` (alongside
  `dist/` for the compiled backend, `bin/`, and `LICENSE`).
- A `prepack` script (`npm run build && npm run build:ui`) builds **both** the
  backend and the UI automatically whenever the package is packed
  (`npm pack`) or published (`npm publish`) — never on a routine `npm
  install`, so monorepo dev installs stay fast. `npm run package` is a plain
  convenience wrapper around the same two builds plus `npm pack`, for anyone
  who wants to produce (and inspect) the tarball without publishing.
- `atlas-ui/.npmignore` (empty, deliberately) exists solely so that
  `atlas-ui/.gitignore`'s `dist` line — correct for git, since the build
  artifact must never be committed — doesn't ALSO suppress `atlas-ui/dist`
  from the npm tarball. npm's packlist walk consults nested `.gitignore`
  files even under a path the root `files` array explicitly whitelists; an
  `.npmignore` present in a directory fully overrides `.gitignore`
  consultation for that directory during packing only, leaving git tracking
  untouched. Verified via `npm pack --dry-run --json`: without this file the
  tarball shipped zero `atlas-ui/*` files; with it, all of `atlas-ui/dist/`
  (index.html + built assets) is present.
- If `atlas-ui/dist` is somehow still absent at runtime (a from-source clone
  that skipped the build step), the daemon does not crash — it serves a
  small "UI not built — run `npm run build:ui`" page at `/` instead, and
  `/mcp` keeps working normally.

Run `npm run package` (or `npm pack --dry-run`) to verify the tarball contents
before a release.

### The `@groundfloor/lore` dependency — vendored tarball

`package.json` pins `"@groundfloor/lore": "file:vendor/groundfloor-lore-3.16.0.tgz"`
— a tarball **committed into this repo**, so a bare clone + `npm ci` resolves
it with no sibling checkout, no registry, and no cross-repo auth. This
replaced the old `file:../groundfloor-lore` sibling-path pin (which made the
repo unbuildable outside one specific two-repo directory layout) and the
even-older release-script flow of cloning groundfloor-lore at a pinned git
ref; nothing in the build reads a sibling checkout anymore.

Switching to a `git+ssh://` dependency remains blocked on a Lore-side build
gap (Lore has no `prepare` script and does not commit `dist/`, so a git
dependency would install successfully and then fail at require-time). See
"Why `@groundfloor/lore` is NOT a `git+ssh://` dependency (yet)" below for
the full writeup — do not touch this dependency line without reading that
section first.

**Bumping the vendored engine:** build a groundfloor-lore checkout
(`npm run build`), `npm pack` it, drop the tarball in `vendor/` as
`groundfloor-lore-<version>.tgz`, point package.json's dependency at it, and
`npm install` to refresh `package-lock.json`. `npm run check:license`
(locally and in CI) reads the tarball's own package.json and asserts its
version matches its filename and its license is the Elastic-2.0 NOTICE
discloses — so a mis-packed tarball fails the gate instead of shipping.

---

## PARKED — Tauri desktop app (not the current shipping target)

> **Scope of "parked": the Tauri desktop *shell* only — NOT the self-contained
> bundle.** `npm run bundle` → `dist-bundle/` is UN-parked and is the current
> primary ship vehicle (see "Self-contained bundle" above); it now targets the
> CLI+web model (the daemon serves the browser UI). What remains parked is the
> **native desktop *wrapper*** (`atlas-ui/src-tauri`) that used to wrap the
> bundle in a Tauri shell with a vendored Node binary. **The wrapper is parked,
> not deleted.** The Tauri code, `scripts/vendor-node.mjs`, and the committed
> Tauri icon set stay in-tree for a possible future desktop relaunch, but the
> desktop *app* is no longer built, documented as the product, or gated in CI.
>
> If reviving the desktop shell, note the daemon now serves its own UI directly
> (`resolveUiDist()` in `src/mcp/server.ts`) — a revived shell would most likely
> point its embedded webview at the daemon's own origin rather than re-bundling
> `atlas-ui/dist` separately. The sections below describe the OLD desktop-wrapper
> mechanics (staging the bundle as a Tauri resource, vendoring a Node runtime);
> they are historical and apply only to the parked wrapper, not to shipping the
> bundle itself, which is covered in "Self-contained bundle" above.

### What `npm run bundle` produced (historical desktop-wrapper framing)

> The description below predates the CLI+web pivot and frames the bundle as
> input to the Tauri wrapper. The bundle contents are current (see
> "Self-contained bundle" above for the authoritative, CLI+web version); only the
> "wrap it in Tauri" framing is parked.

`scripts/bundle.mjs` emits `dist-bundle/` — a directory you could copy to a
machine of the **same platform** and run with no install step:

```
dist-bundle/
  dist/                 # compiled Groundfloor Atlas
  bin/atlas             # CLI launcher
  grammars/             # vendored tree-sitter .wasm (required for parsing)
  run-atlas.sh          # offline launcher (sets TRANSFORMERS_OFFLINE=1)
  node_modules/         # Lore (dereferenced) + native binaries, pruned
  bundle-manifest.json  # platform, size, node version + ABI (nodeAbi)
```

Run it:

```bash
ATLAS_HOME=~/.atlas bash dist-bundle/run-atlas.sh index <path> -r -w myproject
```

with `~/.atlas/config.json`:

```json
{ "port": 3848, "lore": { "workspace": "myproject", "mode": "embedded", "dataDir": "~/.atlas/lore-data" } }
```

**Verified self-contained (historical):** from a clean temp dir, with no
separately-running Lore and `TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1`, the
bundle indexed (`ok:true`, 0 parse errors) and read back nodes **and** edges
(79/79) through the embedded kuzu+lancedb+sqlite — no daemon, no port, no
token, no network.

### What's bundled vs pruned

**Bundled (the self-contained core):**
- `@groundfloor/lore` (symlink **dereferenced** — its `dist/` travels with it)
- native binaries: `@surrealdb/node` (embedded SurrealDB engine), `@lancedb/lancedb-darwin-arm64`,
  `better-sqlite3`, `onnxruntime-node` (this platform only)
- `@lumis-sh/wasm-sql` — **on the edge write/read path** (queryEdges returns 0
  without it; do not prune)
- `@img/sharp-*` and `@napi-rs/canvas-*` — **eagerly `require`d at Lore init**
  (pruning crashes with "Could not load the sharp module"; do not prune)
- the **quantized e5 embedding model** `model_quantized.onnx` (~113 MB, q8 — what
  Lore loads by default) — kept so `embed:true` knowledge/recall works **offline
  out of the box**; no manual model placement needed

**Pruned (not loaded by the embedded graph store):**
- the **fp32 e5 embedding model** `model.onnx` (~470 MB) — code intelligence uses
  `skipEmbed`, so it's never loaded for indexing/reading code, and the quantized
  variant (above) covers `embed:true` knowledge/recall
- Lore's web UI (`lore/ui`, ~314 MB), tests, docs
- `onnxruntime-web` (~130 MB) — Node uses `onnxruntime-node`, never the web build
- Lore's document-ingestion parsers `tree-sitter-wasms` + `@tree-sitter-grammars`
  (Groundfloor Atlas parses with its own `grammars/` wasms)
- dev tooling (`tsx`, `typescript`, `@types/node`)

Result: **~672 MB** on darwin-arm64 (vs ~1.6 GB unpruned; kuzu-era build —
the surrealdb engine shifts these figures). The dominant remaining cost is
the native DB/ML runtimes plus `sharp`/`canvas`.

### Native-binary supply chain — no install-time fetches (surreal era)

The current stack fetches nothing at install time: `@surrealdb/node@3.0.3`
embeds a prebuilt `.node` addon for every supported platform inside its own
npm tarball (~180 MB), declares no platform `optionalDependencies`, and has no
install script. Lore's `postinstall` (`scripts/ensure-surreal-native.mjs`) is a
**verify** step — it checks the addon is present and loadable for this
platform, prints an actionable warning on mismatch, and exits 0.

*(The retired `@kineviz/kuzu-lite` DID download `kuzujs.node` at install time
from GitHub raw + an Alibaba OSS CDN; the bundle-era copy deleted that
`scripts.install`. It left the tree together with the kuzu engine itself.)*

### Platform scope — honest limits (historical)

A bundle built on this machine was **darwin-arm64 only**. The native binaries
(surrealdb, lancedb, onnxruntime, sqlite, sharp, canvas) are platform-specific.

| Target | Status |
|---|---|
| **darwin-arm64** (Apple Silicon) | built + verified |
| linux-x64 / linux-arm64 | never built — would need CI on Linux |
| win32-x64 | never built — would need CI on Windows |
| **darwin-x64** (Intel Mac) | blocked upstream — `@lancedb/lancedb@0.27.2` publishes no darwin-x64 prebuilt |

### Desktop build recipe (parked)

The Rust shell **compiled clean** (`cargo check` green) as of the last time it
was exercised. Icons are wired: `tauri.conf.json`'s `bundle.icon` lists the
committed set under `atlas-ui/src-tauri/icons/` (`32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.icns`, `icon.ico`). These are still placeholder
(solid-color) artwork — swap the source PNG and re-run
`npx tauri icon <source.png>` before ever reviving this path for a real
release.

To produce the (parked) installable app:

```bash
npm run bundle                                   # 1. build the self-contained core → dist-bundle/
cp -R dist-bundle atlas-ui/src-tauri/atlas-core  # 2. stage it as the Tauri `atlas-core` resource
npm run vendor:node                              # 2.5. copy an ABI-matched node binary alongside it (see below)
npm run check:node-abi                           # 2.6. verify node ABI vs. staged native modules
npx tauri icon path/to/logo.png                  # 3. real multi-size icons (.icns/.ico) — only when replacing placeholder art
cd atlas-ui && npm run build                      # 4. frontend dist
node node_modules/@tauri-apps/cli/main.js build   # 5. tauri build (use the project-local CLI)
```

`tauri.conf.json` ships `atlas-core/**/*` as a bundle resource; `lib.rs`
resolves it at runtime via the resource dir (and falls back to the repo `dist/`
for `tauri dev`).

#### Bundling a Node runtime for the desktop app (pkg-node-binary-never-bundled) — parked

`lib.rs::resolve_node()` deliberately looks ONLY for a `node` (or `node.exe`)
binary sitting next to the staged `atlas-core/` resource — by design
(RD-MF22): it will **not** fall back to a bare `node` on PATH, because that
would let an attacker-controlled binary earlier on PATH run with the app's
privileges. `scripts/vendor-node.mjs` closes that gap for the common case —
packaging on the same platform/arch you're shipping for:

```bash
npm run vendor:node          # copies process.execPath → atlas-ui/src-tauri/atlas-core/node[.exe]
npm run check:node-abi       # confirms its ABI matches the native modules staged alongside it
```

It sets the executable bit, then actually **execs the copy** (`node -p
process.versions.modules`) to confirm it runs and reports the expected ABI
before declaring success.

This vendors **the host's** node binary only — cross-compiling needs the
target platform's node binary obtained separately (`node
scripts/vendor-node.mjs --node /path/to/other-platform/node`). It does not
produce a stripped/minimal Node. A full end-to-end validation (`tauri build`
→ install → launch → confirm the vendored node is what's actually used) was
never completed for a non-dev release.

**Honest status (parked):** the app was wired and compiled, icons were wired,
and the missing-node gap had both a fix (`vendor:node`) and a verifier
(`check:node-abi`). A signed/notarized `.app`/`.dmg`, and non-host-platform
node vendoring, were never produced — and are not planned while this path
stays parked.

---

## Version single-sourcing (pkg-version-mismatch)

The root `package.json` (`@groundfloor/atlas`) version is the **single source
of truth** for the product version. `atlas-ui/package.json`,
`atlas-ui/src-tauri/tauri.conf.json`, and `atlas-ui/src-tauri/Cargo.toml` (plus
the derived `Cargo.lock` entry for the `atlas-app` crate — still present
because src-tauri stays in-tree) must always match it — these previously
drifted to `0.1.0` while the root moved to `0.2.0`.

`scripts/check-versions.mjs` (`npm run check:versions`) reads all of them and
fails if any disagree with root. Run `node scripts/check-versions.mjs --fix`
to rewrite the followers to match root, then re-run `cargo check` in
`atlas-ui/src-tauri` so `Cargo.lock` picks up the new crate version (Cargo.lock
isn't rewritten by the `--fix` text patch — it's regenerated by cargo itself).
Wired into `bitbucket-pipelines.yml`'s backend gate. This check still runs in
CI even though the Tauri app is parked, because it's cheap and keeps the
in-tree (parked) manifests from drifting further if anyone touches them.

## Native-module ABI guard (pkg-node-abi-unpinned)

`scripts/check-node-abi.mjs` (`npm run check:node-abi`) guards against the
recurring "NODE_MODULE_VERSION mismatch" class of failure: the @surrealdb/node addon,
lancedb, better-sqlite3 and onnxruntime are prebuilt native addons tied to a specific Node
ABI (`process.versions.modules`), and a mismatch between the Node that's
*running* and the Node those addons were *built for* fails at require-time
with a cryptic native stack trace instead of an actionable message.

It checks three things, each skipped (with a clear log line, not a failure)
if not yet applicable:
1. The currently running Node is within `engines.node` (`>=20 <23`).
2. If `dist-bundle/bundle-manifest.json` exists (from the parked `npm run
   bundle` step), its recorded `nodeAbi` matches the current Node's ABI.
3. If a node binary has been vendored under `atlas-ui/src-tauri/atlas-core/`
   (parked `vendor:node` step above), that binary is actually executed and
   its reported ABI is compared against the current build host's ABI.

Both checks 2 and 3 are effectively no-ops on a fresh checkout / in CI, since
neither `dist-bundle/` nor a vendored node binary exists there — they only
fire when someone has locally run the parked bundle/vendor steps and left
stale artifacts around. Wired into `bitbucket-pipelines.yml`'s backend gate
(`npm run check:node-abi` runs right after `npm run build`).

## CI (bitbucket-pipelines.yml)

`bitbucket-pipelines.yml` runs, on every push:

1. **Backend gate** (`node:20` image, matching `engines.node`):
   `npm ci && npm run build && npm run check:versions && npm run
   check:node-abi && npm run check:license && npm run guard && npm run
   test:all`, then `npm pack --dry-run` as packaging sanity. The `npm ci`
   needs no sibling checkout: `@groundfloor/lore` resolves from the
   committed `vendor/` tarball (see below).
2. **atlas-ui gate**: `cd atlas-ui && npm ci && npm run build && npx vitest
   run`. This builds `atlas-ui/dist` (the same artifact the daemon serves and
   the package ships) and runs the vitest suite. This needs no Lore sibling —
   atlas-ui only talks to the daemon over HTTP at runtime, it never imports
   `@groundfloor/lore`. **It does not invoke Tauri** (no `tauri build`, no
   `npm run bundle`, no `vendor:node`) — the parked desktop-app packaging
   steps are not part of the CI gate.

`npm run guard` is safe to run in a fresh CI checkout: its bundle-staleness
check (the only thing that can fail the gate) is a no-op pass when
`dist-bundle/` doesn't exist yet (gitignored, never present on a fresh
clone) — it only fires when a *stale* bundle is present, which never happens
in CI since this pipeline doesn't run `npm run bundle`.

### The `@groundfloor/lore` dependency in CI — no sibling clone needed

Historically this was the hard part of the pipeline: the dependency was
`file:../groundfloor-lore`, a local sibling checkout, and a Pipelines runner
checks out only the triggering repo — so the pipeline had to clone
`groundfloor-lore` onto the runner, build it (`npm ci --legacy-peer-deps &&
npm run build`), and carry a one-time SSH access-key setup between the two
Bitbucket repos before Atlas's own `npm ci` could resolve the link.

That is all gone. The dependency is now the **committed vendored tarball**
(`file:vendor/groundfloor-lore-3.16.0.tgz`), so a bare `npm ci` on a fresh
checkout of this repo resolves it — the pipeline needs no sibling clone, no
cross-repo SSH keys, and no known_hosts setup. What the backend gate DOES
assert about the engine is `npm run check:license`: it reads the vendored
tarball's own package.json and fails the build if its license is not the
Elastic-2.0 NOTICE discloses or its version does not match its filename.

## Why `@groundfloor/lore` is NOT a `git+ssh://` dependency (yet) (pkg-lore-file-dep-unshippable)

The decided target shape for `package.json` is a Bitbucket **git** dependency
pinned to a tag/SHA:

```json
"@groundfloor/lore": "git+ssh://git@bitbucket.org/<org>/groundfloor-lore.git#<sha-or-tag>"
```

**Investigated and currently BLOCKED — the pin is the committed vendored
tarball (`file:vendor/…tgz`), not a git dependency.** Inspecting the lore
engine's repo (`package.json`, at the then-current HEAD):
- `main`: `dist/lore/src/index.js` — the package's entry point is compiled
  output, not source.
- `files`: `["dist/", "scripts/ensure-surreal-native.mjs"]` — this only matters
  for the **npm registry tarball** path; a git dependency ignores `files` and
  clones the full repo, so this isn't itself the blocker.
- `dist/` **is gitignored** (`.gitignore: dist/`) and is **not committed** —
  confirmed via `git ls-files dist/` returning zero tracked files.
- `scripts`: has `postinstall` (`node scripts/ensure-surreal-native.mjs` — a
  verify step for the @surrealdb/node addon, no build) and a manual `build` (`tsc &&
  tsc-alias`), but **no `prepare` script and no `prepublish`/`prepublishOnly`
  script**.

npm's documented, reliable auto-build hook for git dependencies is
`prepare` — it is the one lifecycle script npm guarantees to run after
installing a package from a git URL. Lore has none. `postinstall` alone
verifies the surreal native addon but never invokes `tsc`. Consequently:

**A git dependency on Lore as it stands today would `npm install` "successfully"
(no error) and then fail at first `require`/`import`**, because
`dist/lore/src/index.js` (the `main` entry) would not exist — the TypeScript
was never compiled in the cloned checkout. This is worse than a failed
install: it's a silent success that breaks at runtime.

**What Lore needs, in order of preference, before the git-dep switch is safe:**
1. **Add a `prepare` script** to groundfloor-lore's `package.json`:
   `"prepare": "npm run build"` (or equivalent). This is the standard,
   lowest-effort fix — npm runs it automatically for git dependencies (and
   harmlessly again on local `npm install` in Lore's own repo). Requires
   `typescript` + `tsc-alias` to be resolvable at that point, which they are
   (present in Lore's own `devDependencies`, installed before `prepare` runs).
2. **OR commit `dist/`** (un-gitignore it, commit compiled output) so no
   build step is needed at install time at all — simpler but couples commits
   to a build artifact and risks drift if someone edits `dist/` directly or
   forgets to rebuild before committing.
3. **OR ship prebuilt tarballs** (e.g. attach a built tarball to a Bitbucket
   Downloads/Release for each tagged version) and point the dependency at
   that URL instead of the git tree — avoids the build-on-install question
   entirely but adds a release-artifact publishing step.

None of these are Atlas-repo changes — they belong in `groundfloor-lore`.
Until one lands there, **the vendored tarball IS the current packaging
path** (this is what option 3 looks like in practice, executed): run `npm
pack` inside a groundfloor-lore checkout that has ALREADY been built
(`npm run build` ran successfully, `dist/` present on disk even though
gitignored), producing a `.tgz`, and depend on it via
`"@groundfloor/lore": "file:vendor/groundfloor-lore-<version>.tgz"`
committed into this repo — replacing the old live sibling-directory link.
This keeps `npm ci` working on a clean CI runner (and a bare clone
anywhere) with no sibling clone, while Lore's `prepare`-script fix is
pursued separately as the durable solution.
