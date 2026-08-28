# Groundfloor Atlas execution waves (ultracode-ready)

Each **wave = one ultracode workflow run**. Within a wave, tasks marked ∥ run as
parallel agents; → means sequential. After every wave there is a **GATE** (a verify
agent + my review) before the next wave launches — that's the "stay in the loop" model,
not a single autonomous marathon.

**Pause:** a `.swarm/PAUSE` sentinel file is checked between waves; if present, the
orchestrator stops cleanly (token-cheap, no watcher). Delete it to resume.

**Legend:** ⚙️ Groundfloor Atlas-only · 🔗 needs Lore · 🧑 needs a human step

---

## Wave 0 — Prereqs (fast, sequential)
*Goal: unblock the speed levers Lore just shipped.*

- 0.1 🧑🔗 **Bump Groundfloor Atlas's Lore dependency** to the build with `nodeUpsertBatch` + `embedding.device` (Groundfloor Atlas's installed copy doesn't have them yet). Rebuild `@groundfloor/lore`, reinstall in Groundfloor Atlas.
- 0.2 ⚙️ Update `PERFORMANCE.md` / `STRATEGY.md`: batch + GPU now Lore-provided.
- 0.3 🧑 Reply to Lore team: yes to dep cleanups (hono/keytar→optional, @types→dev); ask them to confirm the **daemon-path embed-flush** story.

**GATE 0:** `nodeUpsertBatch` resolves in `node_modules`; build green.

---

## Wave 1 — Speed (parallel, the foundation)
*Goal: indexing fast enough to make regenerate-on-clone viable. Depends on Wave 0.*

- 1.1 ∥ ⚙️🔗 **GPU + batch** (one agent — both touch `embeddedLore.ts`):
  - add `embedding: { device: 'auto' }` to `createLore()`
  - rewire `bulkStoreNodes` → `nodeUpsertBatch`, **drain via `dispose()`** at index end so async embeds finish before "done".
- 1.2 ∥ ⚙️ **A1 incremental-by-default** — make `--resume`/skip-unchanged the default; full rebuild only on `--force` (`cli.ts`, `checkpoint.ts`).
- 1.3 ∥ ⚙️ **A2 skip test/fixtures** — default-exclude `*.test.*`, `*.spec.*`, fixtures, snapshots from the scan (`parser/index.ts`, `cli/walker.ts`).
- *(A3 pre-warm already shipped — `99084a8`.)*

Files are disjoint across 1.1/1.2/1.3 → safe parallel (worktree isolation if needed).

**GATE 1:** build green; index dayjs → **measure wall-clock** (expect large drop) AND confirm LanceDB populated (drain correct); re-index unchanged repo → near-instant.

---

## Wave 2 — Validate (fan-out, depends on Wave 1)
*Goal: the honest breadth number we couldn't get when indexing was slow.*

- 2.1 ∥ ⚙️ **Per-repo agents** (one per slice repo): clone @ commit → index (now fast) → run `contextbench-run.mjs` whole-file AND span mode → return recall/tokens.
- 2.2 → ⚙️ **Synthesizer**: aggregate recall/token table, whole-file vs span vs keyword.

**GATE 2:** aggregate table + a **go/no-go on further retrieval investment**. If retrieval doesn't pay off at breadth, we pivot effort to memory depth instead of tuning.

---

## Wave 3 — Git-sync memory MVP (the moat, depends on Wave 1)
*Goal: memory travels with the repo. Mostly ⚙️ via `listNodes`/`nodeUpsert`.*

- 3.1 → ⚙️ Define the portable text format (`.atlas/memory.jsonl`: knowledge nodes + edges, content + metadata, no binary vectors).
- 3.2 ∥ ⚙️ **Exporter** (`atlas memory export`) — `listNodes` → jsonl.
- 3.3 ∥ ⚙️ **Importer** (`atlas memory import` / auto-on-connect) — jsonl → `nodeUpsertBatch` + re-embed locally.
- 3.4 ∥ ⚙️ **Regenerate-on-connect** — if a repo has `.atlas/memory.jsonl` but no local graph, import memory + index the code locally.
- 3.5 → ⚙️ Round-trip + conflict tests (append-merge, supersede).

**GATE 3:** machine-A export → machine-B import → `recall` returns A's decisions; graph rebuilt locally.

---

## Wave 4 — Communities (parity, depends on Wave 1; ∥-able with Wave 3)
*Goal: the codebase "neighborhoods."*

- 4.1 → ⚙️ Clustering over the graph (label-prop/Leiden) → community membership.
- 4.2 ∥ ⚙️ Emit community nodes + membership edges during index.
- 4.3 ∥ ⚙️ MCP tool (`atlas_communities` / overview) + 4.4 tests.

**GATE 4:** communities surfaced for dayjs/a mid repo; tool returns labeled modules.

---

## Wave 5 — Processes (parity, depends on Wave 1; after Wave 4)
*Goal: end-to-end execution flows.*

- 5.1 → ⚙️ Entry-point detection (routes/CLI/handlers) → traverse call edges to terminals.
- 5.2 ∥ ⚙️ Emit process nodes + ordered step edges.
- 5.3 ∥ ⚙️ MCP tool (`atlas_processes`) + 5.4 tests.

**GATE 5:** a known flow traced end-to-end on a sample repo.

---

## Woven throughout — Memory depth (the wedge)
Link code nodes ↔ decisions/conventions/bug-patterns so `recall` returns the *why* with
the *what*. Lands naturally inside Wave 3 (synced content) and is extended after Wave 5.

## Loose ends (any wave, small ⚙️)
`knowledge_search` `[]` bug · verify IDE `connect`/`disconnect` + desktop button · bundle
trim once Lore dep cleanups land.

---

## Ultracode mapping
| Wave | Workflow shape |
|---|---|
| 1 | `parallel([gpu+batch, A1, A2])` → verify agent |
| 2 | `parallel(repos.map(index+run))` → synthesizer |
| 3 | define-format → `parallel([export, import, regen])` → round-trip verify |
| 4 | cluster → `parallel([emit, tool, tests])` → verify |
| 5 | entrypoints → `parallel([emit, tool, tests])` → verify |

Each wave is one `Workflow` invocation; I review the gate result before launching the next.
