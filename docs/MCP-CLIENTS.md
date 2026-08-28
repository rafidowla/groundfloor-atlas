# Connecting MCP clients to Groundfloor Atlas

Groundfloor Atlas runs an MCP server on `http://127.0.0.1:3848/mcp`. As of the
production-hardening pass it **requires a bearer token** (review #1), so
every client must send `Authorization: Bearer <token>`.

## 1. Start Groundfloor Atlas

```bash
atlas serve        # foreground; mints ~/.groundfloor/atlas/mcp.token on first boot
```

The token is printed-on-demand and lives at `~/.groundfloor/atlas/mcp.token`
(owner-readable only). To rotate it, delete the file and restart.

## 2. Get a ready-to-paste config

```bash
atlas mcp-config <client>     # claude-code | claude-desktop | codex | cursor | antigravity | all
```

This prints the exact config **with your token already filled in**. Copy it
into the client below.

## 3. Per-client setup

| Client | Transport | Where it goes |
|--------|-----------|---------------|
| **Claude Code** | HTTP (native) | `claude mcp add --transport http …` or project `.mcp.json` |
| **Cursor** | HTTP (native) | `~/.cursor/mcp.json` |
| **Antigravity** | HTTP (native) | MCP settings → add HTTP server |
| **Claude Desktop** | stdio → HTTP bridge | `claude_desktop_config.json` (via `mcp-remote`) |
| **VS Code** | HTTP (native) | workspace `.vscode/mcp.json` — auto-written by `atlas connect vscode` |
| **OMP (Oh My Pi)** | advisory hook (not MCP) | `~/.omp/agent` — auto-written by `atlas connect omp` |

**Claude Code (one-liner):**
```bash
claude mcp add --transport http atlas "http://127.0.0.1:3848/mcp" \
  --header "Authorization: Bearer $(cat ~/.groundfloor/atlas/mcp.token)"
```

**Cursor** (`~/.cursor/mcp.json`) and **Antigravity** use a `url` + `headers`
block (Antigravity uses the key `serverUrl`). **Claude Desktop** and **Codex**
are stdio-only, so they bridge to HTTP with `npx -y mcp-remote <url> --header
"Authorization: Bearer <token>"`. Run `atlas mcp-config <client>` for the exact
text.

**Or skip the paste entirely:** `atlas connect <client>` (or `atlas connect`
for every installed client at once) writes and merges the entry for you —
including **Codex**'s `~/.codex/config.toml`, where the bridge's bearer is
kept out of argv via an `[mcp_servers.groundfloor-atlas.env]` subtable
referenced as `${ATLAS_MCP_TOKEN}` in the `--header` arg. Every connect backs
the file up first, preserves unrelated entries, and tightens the file to
owner-only (0600 — the one exception is VS Code's token-free, committable
`.vscode/mcp.json`, which stays 0644); `atlas disconnect <client>` removes
just the Groundfloor Atlas entry.

**VS Code** is the one *workspace-scoped* client. Its only officially
documented concrete config path is `.vscode/mcp.json` in the project (the
user-profile `mcp.json` is opened via the *MCP: Open User Configuration*
command — every VS Code profile keeps its own, so there is no stable global
path to write). Run `atlas connect vscode` **from the project root**; it
writes a `servers.groundfloor-atlas` entry (note: `servers`, not
`mcpServers`) plus a password-masked `inputs` `promptString`. VS Code's
documented secret pattern keeps the bearer token OUT of the file: the
Authorization header references `${input:groundfloor-atlas-token}`, and VS
Code prompts for the token once on first server start (print it with
`atlas mcp-config --show-token`), caching it in its secret storage — so the
token still reaches the daemon at connection time while the file stays safe
to commit, which is VS Code's own recommendation for workspace configs. For
the same reason the file is written 0644, not 0600. One caveat from VS
Code's docs: the Agent Host skips `${input:}`-style servers, so the entry
serves Copilot Chat on the extension host. `atlas disconnect vscode` removes
exactly our server entry and our inputs entry; unrelated servers and inputs
survive untouched, and `atlas wire status` reports vscode `wired` /
`not-installed` / `unknown` from the same file.

**OMP (Oh My Pi)** is wired differently — it is not an MCP client.
`atlas connect omp` installs the advisory hook `atlas-consult.ts` (the OMP
analogue of the Claude Code PreToolUse hook) into `~/.omp/agent/hooks/pre/`
and appends its path to the `extensions:` list in `~/.omp/agent/config.yml`;
OMP never loads a hook file that isn't registered there, so both halves are
required — `atlas wire status` reports omp `wired` / `partial` / `not-installed`
by exactly that two-part check. After a grep/glob/edit/write/bash tool result
the hook asks the daemon (`POST /hooks/context`) for advisory context and
appends it to the tool's output, fail-silent on any error. The hook embeds no
secrets — it resolves the token at runtime from `ATLAS_MCP_TOKEN` or
:`~groundfloor/atlas/mcp.token` — and re-running connect is idempotent
(byte-identical files are left untouched, no spurious backups). A config.yml
shape the targeted editor can't safely parse (e.g. flow-style
`extensions: [a, b]`) fails closed with the file untouched.
`atlas disconnect omp` removes just the `extensions:` line; the hook file
stays on disk, inert until re-registered.

## 4. Verify

After adding Groundfloor Atlas, the client should list the three meta-tools
`atlas_tool_list`, `atlas_tool_schema`, `atlas_tool_invoke`. Call
`atlas_tool_list` to discover the ~23 code-intelligence + knowledge tools
behind the shim.

## Notes

- **Auth is on by default.** For trusted single-user local dev only, you can
  set `ATLAS_MCP_AUTH=off` (the config command warns when this is set).
- **Origin / Host are also enforced** — a browser page on another origin is
  rejected even with a token, and only loopback Host headers are accepted
  (DNS-rebinding protection).
- **Custom origins:** to allow an extra browser origin (e.g. a packaged UI),
  set `ATLAS_ALLOWED_ORIGINS=https://my.app` (comma-separated).
