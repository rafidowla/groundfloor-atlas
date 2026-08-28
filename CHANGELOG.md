# Changelog

Notable changes to Groundfloor Atlas. The MCP tool surface for each release is
published as [`docs/tool-schemas.json`](docs/tool-schemas.json) — `git diff` that
one file between two versions to get an exact schema diff.

## 0.2.8

Patch release. Four correctness fixes that had already landed on machines
reporting "0.2.7" — the version string now moves with them, per the rule
0.2.7 established. No new MCP tools; the `docs/tool-schemas.json` diff vs
0.2.7 is the rewritten `atlas_index` description (its semantics are two of
the fixes below) plus the version stamp.

### Fixed

- **Call graph attributes object-literal MCP tool handlers individually.**
  The TypeScript walker now extracts object-literal function properties
  (`registry.register({ name: 't', handler: async (args) => { … } })`) as
  first-class symbols, so a call made inside each handler attributes to the
  handler itself instead of collapsing onto the enclosing registrar function.
  `atlas_call_graph` and `atlas_blast_radius` on a handler-called symbol now
  show the correct specific handler names (verified live: one symbol's
  upstream callers went from a single collapsed `buildRegistry` wrapper to 8
  distinct tool handlers). Companion: function-scoped nested callables
  (closures, handler properties) are data-reachable through their parent, so
  they are exempted from `atlas_find_dead_code`; class members stay flagged.
- **Callee resolution is receiver-qualified, not bare-name.** A member call
  whose receiver is a plain identifier now tries the receiver-qualified
  identity (`EmbeddedLore.open`) before any bare-name matching, and bare-name
  fallbacks only accept callable, module-level symbols. This fixes both
  failure directions of the old bare-name matching: false-positive cross-file
  edges (a free `open()` call in another file resolving to an unrelated
  class's scoped `open` method) and false-negative missed edges
  (`EmbeddedLore.open(x)` resolving to an unrelated same-file local variable
  named `open`, silently swallowing the real edge and emitting a bogus one).
- **`atlas_index` on a subdirectory no longer deletes graph nodes outside that
  subdirectory.** The MCP index tool reconciled on every `resume:false` run,
  and reconcile deletes every file-scoped node of the repo absent from the
  run's batches — a subdirectory run's batches cover only that subdirectory,
  so `atlas_index` against a repo subdirectory silently deleted every
  file-scoped node outside it, repo-wide. The CLI's whole-repo guard now
  applies to the MCP tool: reconcile only when the indexed path covers the
  whole repo. This matters to anyone scripting `atlas_index` calls: partial
  re-indexes no longer destroy graph data they were never asked to touch.
- **Single-file `atlas_index` runs resolve cross-file call/import edges.** A
  single-file re-index built its symbol table and resolution context from
  only the file being indexed, so every cross-file reference failed to
  resolve: the file was silently rewritten with no cross-file edges while
  reporting success, and the graph rotted one edit at a time until a full
  re-index repaired it. The single-file path now loads peer-symbol context
  from the persisted workspace graph (keyed by raw parser uids so edges
  upsert onto existing node ids), producing the same edges a full run would.

### Added

- `bench/` — developer benchmark harnesses (`claims-task2`, `coverage-lift`)
  with their result snapshots, substantiating the resolver/index fix claims
  above. Not part of the shipped package (`files` whitelist excludes it).

### Changed

- Vendored `@groundfloor/lore` 3.12.4 → 3.16.0 (LanceDB 0.37.1, verbatim
  maintenance retry fix).
- Release builds verify the engine that actually ships: `@groundfloor/lore`
  resolves from the committed `vendor/groundfloor-lore-3.16.0.tgz`, so
  `scripts/release-build.sh` and `npm run check:license` now assert that
  tarball's version and Elastic-2.0 license directly. The old flow — cloning
  a sibling `../groundfloor-lore` at a pinned git ref that fed nothing into
  the build — is gone from the script, the pipeline, and the packaging docs.

## 0.2.7

**If you integrate against Atlas, read this entry.** Everything below already
shipped on machines running "0.2.6"; the version string did not move with it.

### Fixed — the version string no longer lies about the tool surface

`knowledge_retract` and `llm_chat` token usage were merged after 0.2.6 was cut
without a version bump, so `atlas_health` reported `0.2.6` for two different tool
surfaces. An integrator pinned to 0.2.6 and diffing schemas mechanically would
have compared against the wrong surface and seen no change.

- `docs/tool-schemas.json` now publishes every tool's name, description and input
  JSON Schema, sorted by name and stamped with the package version. It is a pure
  function of the registry: no timestamps, so an unchanged surface produces an
  empty diff.
- `npm run schemas:dump` regenerates it; `npm run schemas:check` verifies it.
- `tests/tool-schema-dump.test.ts` fails the suite whenever a tool is added,
  removed, re-typed or re-described without regenerating the dump — so the
  published contract and the code can no longer drift apart silently.

### Added

- **`knowledge_list {workspace, type?, tag?, limit?, offset?, includeSuperseded?}`** —
  the complete, deterministic enumeration of a workspace's knowledge. Neither
  existing read tool could answer "show me every standing rule for this project":
  `knowledge_search` requires a non-empty query with no wildcard, and
  `knowledge_recall` is semantic and ranked, so it returns what is relevant, never
  what is complete. The only complete route was exporting the whole workspace to
  JSONL and filtering the file. Ordered by id so offset/limit paging stays stable
  while other writes land; `total` counts all matches before paging; superseded
  and retracted nodes are hidden unless asked for (and then carry `supersededBy`,
  so a retraction is distinguishable from a replacement); the retraction tombstone
  is never listed; and hitting the raw pull cap returns `truncated: true` rather
  than presenting a partial list as complete. Embedded mode.
- **`knowledge_retract {id, reason, workspace}`** — withdraw a knowledge node
  with no replacement ("this is wrong, forget it"). The node keeps its history
  and edges, drops out of default recall, and stays visible under
  `includeSuperseded` — identical to a superseded node. Implemented by
  superseding to one per-workspace tombstone (`knowledge:tombstone:<workspace>`,
  `embed:false`, never surfaces in recall), so callers no longer have to invent a
  placeholder node to point `knowledge_supersede`'s `newId` at. Embedded mode.
- **`llm_chat` returns `usage`** — `{inputTokens, outputTokens, totalTokens,
  source}`, normalized across Ollama, OpenAI and Anthropic so a host can meter
  spend without knowing which backend answered. `source` is `'provider'` (bill
  these), `'none'` (no model ran — passthrough), or `'absent'` (a model ran but
  reported no usage block). **Absent is not zero.** No cost figure: Atlas holds
  no price table, so callers price the tokens themselves.

### Changed

- **Secrets are scrubbed on the WRITE path, not just on LLM egress.** Knowledge
  written through `knowledge_store`, `schema_confirm` and `alerts_dismiss` is
  redacted before it is persisted, because knowledge nodes are exported to
  `.atlas/memory.jsonl`, which the wire harness commits and pushes. When
  redaction fires, `knowledge_store` returns `redacted: true` — the stored text
  can differ from what was submitted, which matters to any caller keeping its own
  audit mirror of writes.
- Vendored `@groundfloor/lore` 3.12.3 → 3.12.4.

### Fixed

- `atlas index` registers the repo in `projects.json`, and `--all-projects` no
  longer reports work it did not do.
- `atlas wire` resolves the workspace from the index checkpoint rather than the
  git slug, so wiring binds to the workspace the repo was actually indexed into.
- `atlas memory *` stays native-module-free (lazy-imports `wireAllProjects`).
- Version manifests are back in lockstep: `atlas-ui/package.json` and the Tauri
  manifests had drifted to 0.2.5 behind the root package.
