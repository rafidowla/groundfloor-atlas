#!/bin/bash
# Atlas daemon launcher — finds Node v22+ and starts the daemon.
# Used by the launchd service (atlas service install) and as a standalone
# entry point. Exits non-zero if Node v22+ cannot be found.
set -euo pipefail

ATLAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Find Node v22+ ────────────────────────────────────────────────────────────
find_node22() {
    local NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    # 1. Walk all nvm-managed v22.x installs (newest first via glob sort)
    for p in $(ls -d "$NVM_DIR/versions/node/v22"*/bin/node 2>/dev/null | sort -Vr); do
        [[ -x "$p" ]] && echo "$p" && return 0
    done

    # 2. Homebrew on Apple Silicon / Intel
    for p in /opt/homebrew/bin/node /usr/local/bin/node; do
        if [[ -x "$p" ]]; then
            local major
            major=$("$p" --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
            if [[ "$major" -ge 22 ]] 2>/dev/null; then echo "$p" && return 0; fi
        fi
    done

    # 3. PATH fallback
    local n; n=$(command -v node 2>/dev/null) || true
    if [[ -n "$n" ]]; then
        local major
        major=$("$n" --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
        if [[ "$major" -ge 22 ]] 2>/dev/null; then echo "$n" && return 0; fi
    fi

    return 1
}

NODE=$(find_node22 2>/dev/null) || {
    echo "[atlas] ERROR: Node.js v22+ not found." >&2
    echo "[atlas] Install it via: nvm install 22 && nvm alias default 22" >&2
    exit 1
}

echo "[atlas] using Node $(\"$NODE\" --version) at $NODE" >&2

export ATLAS_MCP_AUTH=off
exec "$NODE" "$ATLAS_DIR/node_modules/.bin/tsx" "$ATLAS_DIR/src/daemon.ts"
