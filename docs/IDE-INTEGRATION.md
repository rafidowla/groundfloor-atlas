# Groundfloor Atlas — easy IDE integration (spec)

**Goal:** go from "read the docs, hand-edit a JSON file, hope the token's right"
to **"open Groundfloor Atlas → see your installed IDEs → click Connect."** Three layers,
A→C, smallest-risk first.

Supported clients: **Claude Code, Claude Desktop, Cursor, Antigravity, opencode**
(extensible). Today `atlas mcp-config <client>` only *prints* a snippet; the
in-app onboarding snippet is even missing the token. This spec closes both.

---

## A — Fix the connection foundation (prerequisite)

Everything else is worthless if the generated config doesn't actually connect.

1. **Every generated config carries the token.** The daemon mints `mcp.token`
   (0600) under `ATLAS_HOME` and defaults auth ON. The in-app onboarding snippet
   (`atlas-ui/src/pages/OnboardingPage.tsx`) currently emits only `{transport,url}`
   — **add the `Authorization: Bearer <token>` header**, same as the CLI does.
   - *Alternative considered:* trusted-loopback (no token for `127.0.0.1`). Simpler
     UX but weaker. **Decision: keep the token**, just always include it.
2. **One canonical endpoint:** `http://127.0.0.1:3848/mcp` (not `localhost` — IPv6
   skew). Native HTTP clients connect directly; stdio-only clients bridge via
   `npx -y mcp-remote <url> --header "Authorization: Bearer <token>"`.
3. **The daemon must be running when the IDE connects.** Desktop app already owns
   it (`lib.rs` spawns/reaps). For CLI users, ship a background service
   (launchd/systemd/login-item) so `:3848` is up at login — otherwise the IDE
   shows the tools as "failed to connect."
4. **Honest port fallback.** If 3848 is taken, pick another and write the *actual*
   chosen URL into every generated config (don't emit a stale 3848).

**Acceptance:** a freshly generated config for each of the 5 clients connects and
lists tools with zero hand-editing.

---

## B — One-click "Connect" in the desktop app (the adoption lever)

In the app's "Connect your IDE" step, **detect installed clients and write/merge
their config for them.** Per detected client show a **Connect** / **Connected ✓** /
**Disconnect** control.

### Per-client config (merge into, never overwrite)

| Client | Mechanism | Target |
|---|---|---|
| **Claude Code** | shell out: `claude mcp add --transport http atlas <url> --header "Authorization: Bearer <token>"` (or write project `.mcp.json`) | Claude Code MCP registry |
| **Cursor** | merge JSON | `~/.cursor/mcp.json` → `mcpServers.atlas = {url, headers}` |
| **Claude Desktop** | merge JSON | `~/Library/Application Support/Claude/claude_desktop_config.json` → `mcpServers.atlas = {command:"npx", args:["-y","mcp-remote",url,"--header",`Authorization: Bearer <token>`]}` |
| **Antigravity** | merge JSON | Antigravity MCP settings → HTTP server `{serverUrl, headers}` |
| **opencode** | merge JSON | `opencode.json` → `mcp.atlas = {type:"remote", url, headers, enabled:true}` |

### Rules (non-negotiable for safety)

- **Detect before offering.** Look for the client's config path / binary; only show
  Connect for installed clients.
- **Merge, never clobber.** Preserve existing `mcpServers`/`mcp` entries. Add/replace
  only the `atlas` key.
- **Back up first.** Copy `config.json` → `config.json.bak-atlas-<ts>` before writing.
- **Disconnect removes only the `atlas` entry**, restoring nothing else.
- **Re-Connect is idempotent** (re-writes the current token/url; handles token
  rotation and port changes).

**Acceptance:** with N clients installed, the onboarding screen lists them, Connect
writes a valid merged config + backup, the IDE picks up `atlas` after its reload,
and Disconnect cleanly removes it.

---

## C — `atlas connect` CLI (headless / power users)

The terminal counterpart to the button — for CI, remote boxes, and people who never
open the GUI. Today `atlas mcp-config` *prints*; add `atlas connect` that *applies*.

```
atlas connect <client|all>     # detect + merge config (+ backup), print what changed
atlas disconnect <client|all>  # remove only the atlas entry
atlas connect --print <client> # old behavior: print, don't write (alias of mcp-config)
```

- Reuses the exact per-client writers from B (shared core; GUI and CLI call the same
  merge functions).
- `all` = every *detected* client; reports skipped (not-installed) ones.
- Respects `ATLAS_HOME` for the token; honors the actual running port.

**Acceptance:** `atlas connect all` on a machine with Claude Code + Cursor writes both
configs (with backups) and prints a per-client success/skip summary; `atlas
disconnect all` reverses it.

---

## Build order & ownership

| Step | Depends on | Effort | Notes |
|---|---|---|---|
| A1 token in snippet | — | S | one-line fix in OnboardingPage + SettingsPage |
| A2 canonical endpoint + port fallback | — | S | |
| A3 background service | — | M | per-OS (launchd/systemd) |
| B per-client writers (shared core) | A | M | the merge/backup/detect functions |
| B desktop Connect UI | B-core | M | buttons + state |
| C `atlas connect`/`disconnect` | B-core | S | thin CLI over the shared core |

**The 80/20:** ship **A + B-core + the 5 writers** and integration goes from a manual
JSON edit to one click. It's all client-side config plumbing — **no engine changes.**

---

## Implementation status (2026-06-20)

| Part | Status | Where |
|---|---|---|
| **A** — token + canonical `127.0.0.1` endpoint + actual port in every generated config | ✅ done | `src/cli/ideConnect.ts`, reuses `mcpConfig` helpers |
| **A1** — in-app onboarding snippet carries the token (placeholder + `atlas connect` steer) | ✅ done | `atlas-ui/src/pages/OnboardingPage.tsx` |
| **B-core** — per-client writers (detect / merge / backup / remove) for 5 clients | ✅ done | `src/cli/ideConnect.ts` (`SPECS`, `applyOne`) |
| **C** — `atlas connect` / `atlas disconnect` CLI | ✅ done + tested | `src/cli.ts`, `runConnect()` |
| **B-UI** — desktop one-click Connect button | 🟡 implemented, untested | `atlas_connect` Tauri command (`src-tauri/src/lib.rs`) runs the CLI connect core against the embedded core; OnboardingPage shows per-client Connect buttons. Not compiled here (Tauri/atlas-ui deps not installed) — needs a `cargo`/`tauri` build to verify. |
| **A3** — background auto-start service (launchd/systemd) | ⬜ pending | so `:3848` is up when the IDE connects (desktop app already owns it) |

Verified headlessly (isolated HOME): connect writes Cursor/Claude-Desktop/opencode
configs with the token; merge preserves other servers; backup created; disconnect
removes only `atlas`; Antigravity is print-only (no stable writable path).

Clients supported by `connect`: **claude-code, claude-desktop, cursor, opencode**
(file writers) + **antigravity** (print-only). `codex` remains print-only via `mcp-config`.

## Optional follow-up — tool discoverability

Today clients see the 3 shim meta-tools (`atlas_tool_list/schema/invoke`) and must
invoke specific tools indirectly. Surfacing the named tools (`atlas_call_graph`,
`atlas_blast_radius`, `knowledge_recall`, …) directly in the client's tool list
greatly improves discoverability. Separate from A–C; track independently.
