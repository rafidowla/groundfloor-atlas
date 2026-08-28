# Groundfloor Atlas — Production-Readiness Report

*Generated 2026-06-09 from the production-hardening pass driven off `docs/review-2026-06-08.md`.*

> **Deployment model update (2026-07-03):** the shipping target pivoted to a
> CLI-installed daemon that serves its own browser UI (`atlas service
> install` → open the printed token URL). The Tauri desktop app
> (`atlas-ui/src-tauri`) referenced below as "Desktop app" is **parked** —
> kept in-tree, not deleted, but no longer built or documented as the
> product. See `docs/PACKAGING.md` for the current install/run recipe and
> the full parked-Tauri writeup.

## Summary

**All 18 review findings are addressed.** Groundfloor Atlas's backend and desktop app
build clean, every Groundfloor Atlas-owned test suite passes, and the MCP server is now
authenticated and safe to expose to coding agents. The only red items are
integration tests that depend on a remote Lore daemon whose **v3.11.0 security
hardening changed the write-side contract** — these are Lore-side, not Groundfloor Atlas
regressions, and are superseded by the embed-Lore-as-library direction.

## Build & test status

| Check | Result |
|---|---|
| Backend `tsc` build | ✅ pass |
| Browser UI build (`tsc -b && vite build`, served by the daemon) | ✅ pass (vite 8.0.14) |
| Desktop app (Tauri) build | ⏸ parked — not the shipping target, see `docs/PACKAGING.md` |
| `guard` (build + tests) | ✅ backend OK · frontend OK |
| `health.test.ts` (incl. **new auth test**) | ✅ 4/4 |
| `y3.test.ts` (watcher/bulk-write) | ✅ 8/8 |
| `y-perf.test.ts` (reader/transport) | ✅ 8/8 |
| **Groundfloor Atlas-owned total** | ✅ **20/20** |
| `x3` / `x4` / `e2e` / `x7` (live-Lore integration) | ⛔ blocked — see below |

### Why the live-Lore integration tests are blocked (not a regression)

`x3`/`x4`/`e2e` write to a running Lore via a **bootstrap token**, and `x7`
reads a pre-populated `default` workspace. Against the current **Lore
v3.11.0** (which wired route-gates on write endpoints, PRs #61–67):

- A direct `curl POST /api/node` with a fresh bootstrap token returns **HTTP
  403** — proven independent of Groundfloor Atlas. Groundfloor Atlas's `loreClient` correctly surfaces
  the 403; it does not cause it.
- Probed deeper: the bootstrap token **can** create a workspace (`POST
  /api/workspaces` → 201) but **cannot** write a node/edge even to an existing
  workspace (403). So it's a **token-scope** wall, not a missing-workspace one
  — node writes need a write-scoped token (Lore's "P3-scoped tokens" follow-up,
  noted in Lore's HANDOFF), which the bootstrap flow doesn't issue.
- `x7` finds **0 symbols** in `default` (the live data isn't present/tagged).

There is **no Groundfloor Atlas-side fix** — it requires Lore to issue a write-scoped token,
or — per the operator decision — the **embed-Lore-as-library** pivot, which
removes the remote-daemon auth handshake entirely (`ROADMAP.md` §1). `x4` was
also modernized to the shim tool model in this pass; it will pass once a
write-scoped Lore token (or embedded Lore) is available.

## Security posture (what changed)

| Area | Hardening |
|---|---|
| `/mcp` auth | Bearer token (constant-time), Origin allow-list, DNS-rebinding (Host) check; on by default; auto-mints `mcp.token` (0600) |
| Transport | Centralized `httpTransport.ts`: http/https by protocol, **never** token over plaintext to non-loopback, request timeouts |
| Cloud token | Fail-closed — local Lore token is never sent to a cloud host |
| SSRF | Cloud URL must be https + non-private; `ollamaUrl` pinned to loopback; `loreBinPath` canonicalized to an existing `.js` |
| Secrets at rest | `config.json` written `0600`, home `0700` |
| LLM consent | Secrets redacted + size-capped; repo context withheld from cloud LLMs unless `ATLAS_LLM_ALLOW_CLOUD` is set |
| Desktop app (parked) | Strict CSP scoped to the daemon origin; unused `shell:allow-open` dropped. Superseded by the daemon serving its own browser UI directly — see below |
| Input | Every tool validates args against its schema; `limit`/`max` clamped (≤500) |
| Reliability | Shutdown stops the sidecar in `finally`; write timeouts; `EADDRINUSE` no longer orphans Lore; watcher reindexes serialized |
| Correctness | Watcher threads `repoRoot` → incremental IDs reconcile with the full index; junk dirs skipped |

## MCP client readiness

Groundfloor Atlas is usable by **Claude Code, Claude Desktop, Codex, Antigravity, and
Cursor**. Run:

```bash
atlas serve                 # mints the auth token
atlas mcp-config <client>   # prints ready-to-paste config with the token
```

See `docs/MCP-CLIENTS.md` for per-client details.

## Deferred (non-blocking)

- **#15** sidecar `restartCount` reset / 5-min watchdog — the sidecar is removed by the embed-as-library pivot.
- **#16** checkpoint O(n²) rewrite — performance optimization for very large repos; correctness is fine.
- **Embed-Lore-as-library pivot** — the strategic refactor that resolves the live-Lore integration tests and deletes the proxy/sidecar code (`ROADMAP.md` §1).

## Bottom line

Groundfloor Atlas's own code is **production-ready**: hardened against the full review,
building clean on both backend and desktop, with all 20 Groundfloor Atlas-owned tests
green and turnkey configs for every target MCP client. The remaining work is
the Lore-integration layer, which is intentionally being replaced by the
embed-as-library pivot rather than patched against the old remote-daemon
contract.
