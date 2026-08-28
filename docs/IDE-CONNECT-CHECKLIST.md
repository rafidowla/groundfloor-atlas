# Groundfloor Atlas IDE Connect — Verification Checklist

`atlas connect <client>` merges the Groundfloor Atlas MCP server entry (URL + bearer
token) into each IDE's MCP config file. `atlas disconnect <client>`
removes only the `atlas` entry, preserving siblings and other top-level
keys. This document records the A3 verification sweep and gives the
human tester a walkthrough for each of the five supported clients.

## Per-Client Status (A3 dry-run, 2026-06-22)

| Client          | Config-write | Disconnect-clean | Schema valid | Notes                                                                 |
|-----------------|:------------:|:----------------:|:------------:|-----------------------------------------------------------------------|
| claude-code     |      OK      |        OK        |     OK       | `type: http` HTTP transport, bearer header.                           |
| claude-desktop  |      OK      |        OK        |     OK       | stdio bridge via `npx -y mcp-remote` (Desktop has no native HTTP).    |
| cursor          |      OK      |        OK        |     OK       | HTTP transport, bearer header.                                        |
| opencode        |      OK      |        OK        |     OK       | `type: remote`, `enabled: true`, uses `mcp` (not `mcpServers`) key.   |
| antigravity     |   print-only |   print-only*    |     OK       | No writable config path documented — block is printed to stdout.      |

`*` Antigravity disconnect previously re-printed the connect block.
**Fixed inline** — see "Fixes applied" below.

## Production config-file paths

| Client          | Path (macOS / Linux / Windows)                                                                                                                                                |
|-----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| claude-code     | `~/.claude.json` (all platforms)                                                                                                                                               |
| cursor          | `~/.cursor/mcp.json` (all platforms)                                                                                                                                           |
| claude-desktop  | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` / Linux: `~/.config/Claude/claude_desktop_config.json` / Windows: `%APPDATA%\Claude\claude_desktop_config.json` |
| opencode        | `~/.config/opencode/opencode.json` (all platforms)                                                                                                                             |
| antigravity     | none — block is printed; user pastes it into the Antigravity MCP settings UI.                                                                                                 |

Behaviour common to all file-writing clients:

- Atomic-ish write: existing file is backed up to
  `<file>.bak-atlas-<timestamp>` before being rewritten.
- Top-level keys other than the server map are preserved verbatim.
- Sibling entries in the server map are preserved; only the `atlas` key
  is touched.
- If the existing config is not valid JSON, the writer aborts and
  leaves the file untouched (status: `failed`).

## Generated entry shapes (verified against A3 dry-run output)

```jsonc
// claude-code → ~/.claude.json  (key: mcpServers)
"atlas": {
  "type": "http",
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}

// cursor → ~/.cursor/mcp.json  (key: mcpServers)
"atlas": {
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}

// claude-desktop → claude_desktop_config.json  (key: mcpServers)
"atlas": {
  "command": "npx",
  "args": ["-y", "mcp-remote",
           "http://127.0.0.1:<port>/mcp",
           "--header", "Authorization: Bearer <token>"]
}

// opencode → ~/.config/opencode/opencode.json  (key: mcp)
"atlas": {
  "type": "remote",
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "enabled": true
}

// antigravity → printed to stdout for manual paste  (key: mcpServers)
"atlas": {
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

`<port>` defaults to `3848`, `<token>` is read from
`<ATLAS_HOME>/mcp.token` (auto-minted on first daemon boot).

## Manual test checklist

Before walking through any client, make sure the daemon is running and
that `atlas mcp-config` prints the URL and token you expect:

```bash
atlas serve &              # or launch the desktop app
atlas mcp-config           # prints the URL + auth header
```

### 1. Claude Code

1. `atlas connect claude-code`
2. Restart Claude Code (`claude`) or run `/mcp` inside it.
3. **Expect:** in the `/mcp` panel you should see `atlas` listed as a
   connected MCP server (status: ready) alongside any other servers.
4. Query: ask Claude Code "what Groundfloor Atlas tools do you have?" — it should
   list the 7 Groundfloor Atlas tools (`call_graph`, `find_dead_code`,
   `blast_radius`, `schema_drift`, `layer_violations`, `hotspots`,
   `index`).
5. `atlas disconnect claude-code` → re-open `/mcp` → `atlas` is gone,
   other servers remain.

### 2. Cursor

1. `atlas connect cursor`
2. Restart Cursor (or reload window).
3. **Expect:** Settings → MCP → `atlas` appears in the server list with
   a green dot.
4. Open the Composer's tool picker; the Groundfloor Atlas tools should be
   available.
5. `atlas disconnect cursor` → reload → `atlas` is gone.

### 3. Claude Desktop

1. `atlas connect claude-desktop`
2. Fully quit and relaunch Claude Desktop (cmd-Q, not just close
   window).
3. **Expect:** in a new chat, the tool/MCP picker shows the Groundfloor Atlas
   tools. Desktop boots the stdio bridge automatically via
   `npx -y mcp-remote`; first boot may take a few seconds while
   `mcp-remote` is fetched.
4. If Desktop reports the server is failing, check
   `~/Library/Logs/Claude/mcp*.log` — most failures are either the
   daemon being down or a stale token.
5. `atlas disconnect claude-desktop` → relaunch → Groundfloor Atlas tools are gone.

### 4. opencode

1. `atlas connect opencode`
2. Restart `opencode`.
3. **Expect:** `opencode mcp ls` (or the UI's MCP panel) lists `atlas`
   as enabled. The `enabled: true` flag is required by opencode — the
   writer sets it automatically.
4. Ask opencode to call an Groundfloor Atlas tool (e.g. `hotspots`).
5. `atlas disconnect opencode` → restart → `atlas` is gone.

### 5. Antigravity

Antigravity has no documented writable MCP config file, so
`atlas connect antigravity` prints a JSON block to stdout instead of
writing.

1. `atlas connect antigravity` → copy the printed JSON block.
2. Open Antigravity → MCP settings → paste the block into the
   `mcpServers` map (merge with any existing entries).
3. **Expect:** after saving and reloading, `atlas` appears in
   Antigravity's MCP server list and its tools are callable.
4. `atlas disconnect antigravity` now prints a reminder telling you to
   remove the `atlas` entry manually (it does not — and cannot — touch
   the Antigravity settings file).

## Fixes applied during A3

**Antigravity disconnect was printing the connect block.**
`applyOne()` in `src/cli/ideConnect.ts` short-circuited on
`spec.printOnly` without checking the `remove` flag, so
`atlas disconnect antigravity` printed exactly the same block as
`atlas connect antigravity` — confusing for the user. Fixed by
branching on `remove` first and emitting a "remove the `atlas` entry
manually" hint instead. Re-verified after `npm run build`.

No other defects found.

## Reproducer (for future regression testing)

```bash
rm -rf /tmp/atlas-connect-test
mkdir -p /tmp/atlas-connect-test/{claude-code,claude-desktop,cursor,opencode,antigravity}

for c in claude-code claude-desktop cursor opencode antigravity; do
  ATLAS_HOME=/tmp/atlas-connect-test/$c/.atlas-demo \
  HOME=/tmp/atlas-connect-test/$c \
    ./bin/atlas connect $c
done

# inspect the written files
find /tmp/atlas-connect-test -name '*.json' -not -name '*.bak-*' -print -exec cat {} \;

# clean disconnect
for c in claude-code claude-desktop cursor opencode antigravity; do
  ATLAS_HOME=/tmp/atlas-connect-test/$c/.atlas-demo \
  HOME=/tmp/atlas-connect-test/$c \
    ./bin/atlas disconnect $c
done
```

Expected: every connect prints a `wrote atlas → <path>` line (or
the antigravity print-only block); every disconnect prints
`removed atlas from <path>` (or the antigravity manual-remove hint).
Every resulting JSON file parses cleanly.
