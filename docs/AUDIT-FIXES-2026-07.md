# Atlas — audit & fix summary (July 2026)

**What happened:** a multi-round deep audit of the whole codebase (core, CLI,
MCP daemon, parser/walkers, UI), followed by fixes — each verified with real
end-to-end runs and new regression tests. Final state: **repo suite 60/61
pass (1 pre-existing skip), UI suite 210/210, typecheck clean both sides.**

Everything below is fixed and tested unless noted. Deferred items live in
`ROADMAP.md`.

## The big ones (most user-visible)

- **`index --force <subfolder>` could wipe the rest of the repo's graph.**
  The stale-node cleanup ran even when the walk covered only part of the
  repo. It now only runs on whole-repo, unfiltered indexes.
- **Every modern C# file failed to parse.** File-scoped namespaces
  (`namespace Foo;`) sent the parser into infinite recursion. Fixed; C#
  codebases index correctly now.
- **Shell injection via `atlas hook install --workspace`.** The workspace
  name went unvalidated into executable git hooks. Validation now lives in
  the shared sink so no caller can bypass it.
- **Deleting/renaming a workspace left a live "ghost" database.** New writes
  went nowhere. The store handle is now properly closed first.
- **Call graphs double-counted closures in all 11 language walkers.** Calls
  inside nested functions were counted twice and blamed on the outer
  function — silently inflating blast radius, hotspots, dead code, and PR
  risk. Fixed and verified on real code.
- **Graph type filter silently did nothing** (stale hardcoded count after
  the schema grew). Unchecking a type now actually hides it.
- **Alerts UI was unreachable and dismiss was broken** — panel hidden under
  the status bar; dismiss sent the wrong payload and wiped all alerts
  locally. Panel opens, dismiss persists server-side, only the dismissed
  alert is removed.
- **Workspace switcher showed blank rows** in the default (embedded) mode.
- **One stray symlink could poison or hang indexing** (1 file → 33 phantom
  files reproduced; potentially 50k or OOM). The walker now visits each real
  directory once.
- **Semantic search in the graph UI did nothing** — pressing Enter could
  never highlight results. Precedence fixed.
- **"Leave blank to keep your API key" actually deleted it** (LLM + Cloud
  Sync settings). Blank now keeps the stored key.
- **Deleted knowledge nodes left their embeddings behind forever** (wrong
  delete semantics + missing id prefix — now a real purge), and both
  inverted keep/drop filters were corrected.

## Correctness & reliability

- Sidecar (Lore process manager): crashes now auto-restart (was a broken
  promise), deliberate restarts no longer log as crashes, respawns wait for
  the port, failed spawns can't crash the daemon, and shutdown can't orphan
  the process (signals register before startup; close is awaited).
- Daemon shutdown no longer closes databases under in-flight queries
  (borrow-drain before close) or mid-maintenance.
- Auto-link (similarity) edges no longer stay invisible to the cached edge
  list — the cache is invalidated at the right settle point.
- Writer-lock race that could let two processes write the same store is
  closed (fresh empty lock = live writer, not stealable).
- Group imports: no longer re-embed thousands of code nodes (per-type
  decision + per-node fast path), and a trust-guard hole that let one member
  forge another's context cards is closed.
- 17 MCP tool handlers now hold the shared store correctly — LRU eviction
  can't close a database mid-query anymore.
- CLI no longer hangs after finishing an index on the daemon-fallback path.
- Desktop app auth wired up (the token command existed but was never called).
- Checkpoint fingerprint captured at parse time (a file edited mid-index is
  correctly re-indexed next run).
- Two race-condition gaps in the embedded store closed (env-var mutation
  serialized; supersede takes the maintenance lock).
- Server shutdown can't hang on open connections (grace period, then
  force-close).

## Setup, docs & daily UX

- **README quick start fixed** — it told new users to `npm install -g` a
  private package (404) and promised Linux support that doesn't exist. Now
  points at real install paths.
- `wire status` no longer reports "not wired" right after a successful
  `--memory-only` install (mode-aware: full / memory-only / partial / none).
- `atlas_call_graph`'s "pass a repo qualifier" error now matches its schema
  (agents no longer get stuck in a retry loop).
- `alerts_get` no longer hard-fails without a workspace (read tools default
  it; write tools keep the deliberate requirement).
- `init --connect` works (was a dead flag); `init` prints a
  token-authenticated URL; daemon-down errors suggest the start command;
  `bin/atlas` on a bare clone says what to run.
- Settings' manual MCP snippet actually works when pasted (real server key,
  correct host property, auth header included).
- Header counts in the graph UI now reflect active filters; community
  `depends_on` edges have a filter entry; the "Indexed N files" bar and
  error overlay expire after 60s instead of persisting forever.
- Docked chat keeps its history when closed; streams abort on unmount;
  LLM/Cloud save failures and project-remove failures show inline errors.
- Small stuff: atomic config writes, accurate index progress counts,
  YAML quoting, edge-dedup collision on spaced paths, folder-browser race,
  polling stops when the daemon dies, 404 route, timer leaks, junk files
  removed from the tree.

## Tests added

6 new regression suites (`test:audit-high`, `test:audit-medium`,
`test:audit-untested`, `test:audit-round4`, `test:audit-urgent4`, plus UI
round-4/5 vitest files) — including end-to-end tests with a real daemon, a
real MCP mock server, symlink-cycle fixtures, and browser-driven UI checks.

## Still open (see ROADMAP.md)

Design decisions (token-in-argv, id minting, repo slug migration), bigger
projects (systemd support, npm publishing, desktop-app QA, canvas
accessibility, bundle splitting), and a few unverified/low-value items
documented with their evidence.
