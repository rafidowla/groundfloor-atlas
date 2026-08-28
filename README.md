# Groundfloor Atlas

Groundfloor Atlas is Groundfloor's code-intelligence engine. By default it embeds a dedicated Lore in-process (its own surrealdb + lancedb + sqlite under the Atlas data dir) — no separate Lore daemon, port, or auth token to provision. It owns the tree-sitter parser, cross-file resolver, call-graph analytics, and git-signal layer that previously lived in `lore-plugin-developer`. As of X4 Groundfloor Atlas can also expose an MCP server on `127.0.0.1:3848` so IDE clients can connect — the endpoint presents a three-tool shim (`atlas_tool_list`, `atlas_tool_schema`, `atlas_tool_invoke`) through which clients discover and invoke the underlying code-intelligence operations (`atlas_health` plus the analytics tools). The legacy `http` mode (set `lore.mode: 'http'`) is a clearly opt-in path where Groundfloor Atlas instead READs from a separate Lore over REST (`/api/nodes`, `/api/node`) and WRITES via Lore's MCP `store_node` / `store_edge` (X3 wiring); the REST/MCP/token framing below applies only to that mode. `atlas index <path>` builds the index; `atlas serve` exposes the MCP endpoint for IDE clients; `atlas health` is the liveness check.

## Quick start (CLI + browser UI)

The daemon serves its own browser UI directly — there is no separate desktop
app or bundled Node runtime to install.

> **Install reality check:** `@groundfloor/atlas` is **not published to npm**
> (the package is private, and the tarball can't resolve its Lore engine
> dependency — see `docs/PACKAGING.md`). Install from source or from the
> self-contained release bundle instead:

```bash
# From source (this repo):
npm install && npm run build

# …or from the self-contained release bundle (no npm install needed at all):
#   scripts/release-build.sh   → produces the zipped bundle under release/
```

Then install it as a background service and open the URL it prints:

```bash
atlas service install            # macOS (launchd), auth ON. Linux: no service
                                    # installer yet — use `atlas serve` (or your
                                    # own systemd unit around it).
```

This prints a token-bearing launch URL — open it in a browser (the token
travels in the URL, like `jupyter notebook`, and is never logged in full):

```
[atlas] open the UI (token-authenticated, do not share this URL):
[atlas]   http://127.0.0.1:3848/?token=<mcp.token>
```

For a foreground run instead of a background service:

```bash
atlas serve --open   # starts the daemon in this terminal, best-effort opens the browser
```

See `docs/PACKAGING.md` for the full install/packaging writeup, including how
the published npm package ships the built UI. (The Tauri desktop app under
`atlas-ui/src-tauri` is parked — kept in-tree but no longer the shipping
target; see that doc's "PARKED" section.)

## Onboard a project in one command

```bash
atlas onboard .            # or the atlas_onboard MCP tool from an agent
```

This replaces the old four-step sequence (`workspace_create` →
`workspace_add_project` → `atlas_index` → `atlas_wire` — those tools still
exist for granular control). One call:

- derives the workspace from the repo folder slug, **reusing** an existing
  matching workspace instead of duplicating it;
- detects a stale `.atlas/index-state.json` (written for a different root)
  and runs a **full re-index** with a warning instead of a broken incremental;
- fires indexing as a **background job** — it returns immediately with a job
  id; poll `index_status` (`atlas index status -w <workspace>`) for phase,
  files/symbols/edges, and the **skipped-files report** (which files weren't
  parsed, and why). A big repo can legitimately take tens of minutes — that's
  expected, not a hang;
- installs the wire harness: agent hooks, the standing-instructions block in
  **CLAUDE.md and AGENTS.md**, and the git memory-sync hooks.

Pass `--wait` (CLI) / `wait: true` (tool) to block and get the terminal
counts in the summary instead.

## Team memory over git

Beyond the code graph, Groundfloor Atlas gives a team a **shared knowledge ledger that
travels in git** — decisions, conventions, bug patterns, troubleshooting notes,
and architecture facts, written once and picked up by every teammate (and every
coding agent) on the next pull. No server or account: the ledger is a plain,
diff-friendly text file, `.atlas/memory.jsonl`, committed alongside your code.

Turn it on once per repo (at the repo root):

```bash
atlas wire install --memory-only     # git memory sync only (hooks + union merge driver)
atlas wire install                   # the above PLUS the IDE consultation harness
atlas wire install --all-projects    # refresh harness in EVERY repo Groundfloor Atlas has registered
atlas connect all                    # update IDE MCP configs (Cursor, Claude Code, …) on this machine
```

That installs a pre-commit hook (export + stage `.atlas/memory.jsonl`),
post-merge/post-checkout hooks (import it back on pull/clone/checkout), and a
**union merge driver** so a conflicting merge combines both sides instead of
dropping a teammate's entries. Read or search the ledger with **no daemon and no
database** — works in a bare clone:

```bash
atlas memory show --type decision       # list knowledge, filterable by type/tag
atlas memory grep "merge driver" --json # keyword search, machine-readable
```

**Truth vs. index:** `.atlas/memory.jsonl` in git is the irreplaceable source of
truth; the local SurrealDB + LanceDB + sqlite stores are **rebuildable indexes** over
it (gitignored, disposable — `atlas memory import .atlas/memory.jsonl` rebuilds
them, re-embedding vectors locally). A clone that doesn't run Atlas (e.g. an
automation that only reads/appends the ledger) installs just the driver with
`atlas memory install-merge-driver`.

Full walkthrough — install, how the ledger works, the truth/index split,
recovery, and the hard-delete caveat — in **`docs/memory-git-sync.md`**. The
external-writer (PM) contract is in **`docs/pm-memory-contract.md`**.

## MCP tools

Clients (Claude Code, Cursor, Antigravity) point their MCP config at `http://localhost:3848/mcp`. The IDE tool list shows just **three meta-tools** — the shim surface — not the individual code-intelligence operations:

| Meta-tool | Purpose |
| --------- | ------- |
| `atlas_tool_list` | Discover the available Groundfloor Atlas tools with their names and descriptions. Call this first. |
| `atlas_tool_schema` | Get the JSON Schema for a named tool's input before invoking it. |
| `atlas_tool_invoke` | Invoke any Groundfloor Atlas tool by name with its input arguments. |

The code-intelligence operations below are not surfaced directly to the IDE — they are discovered via `atlas_tool_list` and called through `atlas_tool_invoke` (the shim keeps the IDE tool list small and stable as the registry grows; see `src/mcp/server.ts`). Tools invokable via `atlas_tool_invoke` include:

| Tool | Purpose |
| ---- | ------- |
| `atlas_health` | Liveness check — status, version, uptime_ms. |
| `atlas_call_graph` | Direct callers (upstream) or callees (downstream) of a symbol; d1/d2/d3 reachability. |
| `atlas_find_dead_code` | Symbols with zero inbound references, filtered to callable kinds + non-exempt names. |
| `atlas_blast_radius` | Depth-tiered reachability (d1=WILL BREAK, d2=LIKELY AFFECTED, d3=MAY NEED TESTING). |
| `atlas_schema_drift` | Compare a live-DB schema dump against declared schema files in a repo. File-based; no DB connection. |
| `atlas_layer_violations` | Edges that violate a user-declared LayerSpec (e.g., `ui→core OK`, `ui⇏plugins`). |
| `atlas_hotspots` | High-complexity (and optionally high-churn) symbols, ranked. |
| `atlas_index` | Re-index a file or directory: parse → resolve → write CodeFile + CodeSymbol nodes + call edges into Lore. MCP-surface equivalent of `atlas index <path>`. |

### Read-path note (X4)

Groundfloor Atlas writes to Lore as `type='file_ref'` (CodeFile) and `type='architecture'` (CodeSymbol) with a leading `atlas` tag — a workaround until Lore promotes dedicated `code_file` / `code_symbol` vocab. The read tools filter on `type ∈ {file_ref, architecture}` AND `tag='atlas'` AND `project=<workspace>` to scope reads to Groundfloor Atlas-written data only. See `src/mcp/loreReader.ts` for the recovery logic.

## Claude Code integration

Add Groundfloor Atlas to Claude Code's MCP config. **`/mcp` auth is ON by default**, so the
config must carry a bearer token — don't hand-write it. Run the canonical command,
which is the single source of truth and emits the correct `type: http`, `url`, and
`headers.Authorization: Bearer <token>` shape (plus a ready-to-paste
`claude mcp add ... --header` one-liner):

```
atlas mcp-config claude-code            # config block + claude mcp add one-liner
atlas mcp-config claude-code --show-token
```

If you keep a static snippet instead, it MUST include the Authorization header:

```json
{
  "mcpServers": {
    "atlas": {
      "type": "http",
      "url": "http://localhost:3848/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-<atlas-home>/mcp.token>"
      }
    }
  }
}
```

The token-less form (`type`/`url` only) is rejected with HTTP 401 unless you run
under `ATLAS_MCP_AUTH=off` (trusted local dev only).

Restart Claude Code. The three Groundfloor Atlas meta-tools (`atlas_tool_list`, `atlas_tool_schema`, `atlas_tool_invoke`) appear alongside Lore's; the code-intelligence operations are reached through `atlas_tool_invoke`. (Port 3848 above is Groundfloor Atlas's OWN MCP server and applies in all modes.) **Legacy `http` mode only:** Groundfloor Atlas's outbound traffic to a separate Lore uses the bearer token at `~/.groundfloor/atlas/auth.token` — the same token X3 introduced (Lore bootstrap token; P3-scoped tokens are a separate follow-up). The embedded default needs no such token.

## CLI

```
atlas serve [--open]         # foreground daemon, default port 3848; serves the browser UI too
atlas service install        # install + start as a background service (launchd/systemd); prints the launch URL
atlas service uninstall      # remove the background service
atlas service status         # check the background service
atlas health [--port N]      # liveness probe
atlas index <path>           # parse path → write to configured Lore workspace
atlas help                   # usage
```

`atlas index` embeds a **semantic context layer by default** (GF-2): one small
natural-language card per file, which is what makes the code semantically
searchable (the `code_file`/`code_symbol` graph nodes are not embedded). Set
`ATLAS_CONTEXT_LAYER=0` to force the lean graph-only index (no embeds), or
`ATLAS_CONTEXT_SPANS=1` for per-symbol (line-level) cards. A size guard
auto-disables the layer above 10k files and falls span→file above 20k symbols,
printing one line each — so a large monorepo is never a silent minutes-long
index. See `atlas help` and `docs/PERFORMANCE.md`.

## Tests

```
npm run build
npm test                  # X2 daemon + atlas_health
npm run test:x3           # X3 write path (atlas index → Lore)
npm run test:x4           # X4 MCP tools (3 advertised meta-tools + happy-path assertions through the shim)
```

The LaunchAgent template under `infra/com.groundfloor.atlas.plist` is for the operator to install manually once we're ready to dogfood (not auto-installed by this repo).
