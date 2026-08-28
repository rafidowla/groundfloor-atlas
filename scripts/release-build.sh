#!/usr/bin/env bash
#
# release-build.sh — produce the shippable, self-contained Groundfloor Atlas bundle in ONE command.
#
# The Lore ENGINE is vendored into THIS repo as a committed tarball
# (`vendor/groundfloor-lore-<version>.tgz`, referenced from package.json as
# `@groundfloor/lore: file:vendor/…`), so a plain `npm install` resolves it —
# no sibling checkout, no registry, no git ref to pin. This script verifies
# that the vendored tarball is the one package.json points at (version +
# Elastic-2.0 license, via scripts/check-license-headers.mjs — the tarball is
# what actually ships, so it is what gets asserted), installs, builds the
# self-contained bundle, and zips it into a versioned, checksummed artifact.
# The RESULTING zip is fully self-contained — a user needs neither repo.
#
# To ship a NEW Lore engine version: build a groundfloor-lore checkout
# (`npm run build`), `npm pack` it, drop the tarball in vendor/ as
# groundfloor-lore-<version>.tgz, and point package.json's dependency at it
# (then `npm install` to refresh package-lock.json). See docs/PACKAGING.md.
#
# Requirements on the build machine: node (the bundle's native ABI locks to
# this node's major version — build on the node your users will run), zip, tar.
set -euo pipefail

# Lore engine source of truth: the VENDORED TARBALL referenced by package.json
# (see header). Verified — not cloned — below; there is no LORE_REF to pin
# because nothing in this build reads a sibling git checkout.

ATLAS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ATLAS_ROOT"
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
PLATFORM="$(node -e "process.stdout.write(process.platform)")"
ARCH="$(node -e "process.stdout.write(process.arch)")"
NODE_MAJOR="$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")"

echo "── Groundfloor Atlas release build ─────────────────────────────────────────────"
echo "  Atlas:    $ATLAS_ROOT (v$VERSION)"
echo "  Node:     $(node --version) (bundle native ABI locks to node $NODE_MAJOR)"
echo "  Target:   $PLATFORM-$ARCH"

# ── 1. Verify the vendored Lore engine tarball (what actually ships) ────────
# package.json resolves @groundfloor/lore from vendor/*.tgz; assert that the
# tarball exists, that its own package.json version matches the version in
# its filename (catches packing the wrong build under a stale name), and that
# its license is the Elastic-2.0 one NOTICE discloses. check-license-headers.mjs
# owns the assertions; here we also surface the version for the build log.
LORE_TGZ_SPEC="$(node -e "process.stdout.write(require('./package.json').dependencies['@groundfloor/lore'] ?? '')")"
LORE_TGZ="${LORE_TGZ_SPEC#file:}"
if [ ! -f "$LORE_TGZ" ]; then
  echo "! vendored Lore tarball not found at $LORE_TGZ (package.json: $LORE_TGZ_SPEC)"
  exit 1
fi
LORE_VERSION="$(tar -xzOf "$LORE_TGZ" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).version))")"
echo "  Lore:     vendored $LORE_TGZ (v$LORE_VERSION)"
node scripts/check-license-headers.mjs

# ── 2. Install (resolves the vendored Lore tarball, builds native modules) ──
echo "── Installing dependencies (builds native engine for node $NODE_MAJOR) …"
npm install

# ── 3. Build the self-contained bundle (backend + UI + deref'd Lore + model) ─
echo "── Building self-contained bundle (npm run bundle) …"
npm run bundle

# ── 4. Package into a versioned, checksummed zip ────────────────────────────
BUNDLE_DIR="$ATLAS_ROOT/dist-bundle"
[ -d "$BUNDLE_DIR" ] || { echo "! dist-bundle/ not produced — bundle step failed"; exit 1; }
ARTIFACT="groundfloor-atlas-v${VERSION}-${PLATFORM}-${ARCH}-node${NODE_MAJOR}.zip"
OUT_DIR="$ATLAS_ROOT/release"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ARTIFACT"
( cd "$ATLAS_ROOT" && zip -q -r -y "$OUT_DIR/$ARTIFACT" "dist-bundle" )
SHA="$(shasum -a 256 "$OUT_DIR/$ARTIFACT" | awk '{print $1}')"
SIZE="$(du -h "$OUT_DIR/$ARTIFACT" | awk '{print $1}')"

echo "── Done ────────────────────────────────────────────────────────────────"
echo "  Artifact: release/$ARTIFACT ($SIZE)"
echo "  sha256:   $SHA"
echo "  Lore:     vendored v$LORE_VERSION   |   Node: $(node --version)   |   $PLATFORM-$ARCH"
echo ""
echo "  Ship this zip. A user unzips it and runs:"
echo "    ./dist-bundle/run-atlas.sh serve --open      # foreground, opens browser"
echo "    ./dist-bundle/bin/atlas service install       # background daemon (launchd/systemd)"
echo "  then opens the printed http://127.0.0.1:3848/?token=… URL. No node source,"
echo "  no Lore repo, no registry needed on their end — only a node $NODE_MAJOR runtime."
