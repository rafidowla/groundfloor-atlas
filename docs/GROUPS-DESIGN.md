# Cross-Project GROUP Model — Design

> Status: **DESIGN ONLY** (no code). For the owner to decide against.
> Scope: how Groundfloor Atlas can compose *related* repos into a single queryable "group"
> without disturbing the per-repo moat.
>
> This doc is grounded in two ground-truth reads of the current code. File/line
> citations are real and verbatim where it matters.

---

## TL;DR (the additive group model in 5 lines)

1. **Nothing moves.** Each repo keeps its own `.atlas/memory.jsonl` in git, in the
   repo, unchanged format. The group is **runtime composition**, not relocation.
2. **A group is a tiny declaration** (`.atlas/group.yaml`) listing member repos by
   path/remote. It lives in **one owner repo** — it has a git home, no orphan file.
3. **Load-on-connect = import every member `memory.jsonl` into ONE shared dataDir.**
   The code already makes this the easy path; recall is already store-wide.
4. **Cross-project RECALL is essentially free** (recall ignores `project` today).
   **Cross-project EDGES are a strictly bigger, later job** (needs an edge author).
5. **Isolation stays the default.** No `group.yaml` ⇒ today's behavior, byte-identical.

---

## The two layers (storage vs composition)

The single most important framing: there are **two separate layers**, and the group
only touches the second one.

### Layer 1 — STORAGE (per-repo, in git, UNCHANGED) — this is the moat

Every repo owns a `.atlas/memory.jsonl`. It is written by `cmdMemoryExport`
(`src/cli.ts`) → `exportMemory` (`src/cli/memorySync.ts`) and travels in that repo's
git history. **The group does not relocate, reformat, or rewrite it.** Its exact shape
today (from ground-truth read #1):

**Header (line 1)** — `MemoryHeader`, `memorySync.ts:135-140`:
```json
{"version":1,"exportedAt":"<ISO>","sourceWorkspace":"<name>","exportedTypes":["decision","convention","bug_pattern","troubleshooting","architecture"]}
```
- `version` is `1` or `2`. It is `2` **iff at least one node resolved a vector**
  (`memorySync.ts:235`: `haveAnyVectors ? 2 : 1`); else `1`.
- `exportedTypes` is always the full `KNOWLEDGE_TYPES` tuple.

**Node line** — `NodeLine`, `memorySync.ts:145-158`, built `:192-205`:
```json
{"kind":"node","id":"...","type":"decision","label":"...","content":"...","tags":"a,b,c","metadata":{...},"supersededAt":null,"embedding":[/* v2 only */]}
```
- `tags` is a **comma-joined string**, not an array (`:199`).
- `supersededAt` round-trips; `null` is meaningful ("not superseded").
- `embedding?: number[]` is inlined **only in v2** and **only for nodes that have a
  vector** (`:236-241`). Knowledge nodes are written `embed:true` so they DO carry
  vectors.

**Edge line** — `EdgeLine`, `memorySync.ts:160-165`, built `:218-223`:
```json
{"kind":"edge","sourceId":"...","targetId":"...","relation":"..."}
```

**What travels, exactly:**
- **Node types:** only `decision, convention, bug_pattern, troubleshooting,
  architecture` (`memorySync.ts:56-62`). **Code nodes (`code_file`, `code_symbol`,
  `code_context`) never travel** — they are the "regenerable local cache" (file header
  `:18-21`). Import even hard-rejects non-knowledge types (`:409-414`).
- **Edges:** only edges where **both** endpoints are knowledge nodes (`:209-224`,
  `:216-217`). All `code↔*` edges are dropped (the MVP id-stability policy, header
  `:23-25`).

**This layer is the moat and it does not change.** A group reads these files; it never
owns them.

### Layer 2 — COMPOSITION (group, runtime, additive)

A group is a **runtime view** assembled by *loading* member `memory.jsonl` files into a
**shared queryable space** when Groundfloor Atlas connects. The composition layer:
- adds a tiny declaration file (which itself has a git home — see below),
- adds a load step that imports members into one dataDir,
- optionally adds **cross-seam edges** that are themselves stored as ordinary knowledge
  edges inside the owning repo's `memory.jsonl` (so even the "group glue" lives in git).

Nothing in Layer 2 mutates Layer 1's format. If you delete every `group.yaml`, every
repo behaves exactly as it does today.

---

## Group declaration format

### Where it lives (no orphan with no git home)

The declaration lives in the repo that **owns the group concern** — the same principle
as cross-seam decisions (decision #1): the thing that belongs to "the relationship"
lives in the repo that owns the relationship, never in a homeless file.

Concretely, for a group like `lore + atlas` where Groundfloor Atlas is the integrator/consumer of
Lore, the declaration lives at:

```
<atlas-repo>/.atlas/group.yaml          # committed to Groundfloor Atlas's git
```

`group.yaml` is **versioned in Groundfloor Atlas's repo**. It is not a global machine-wide file in
`~/.lore` (that would be the orphan we are forbidden to create). If a future group has
no natural owner, the tie-breaker is documented in the file itself ("owner: <repo>") and
chosen by the human, not invented by the tool.

### What it contains

```yaml
# <atlas-repo>/.atlas/group.yaml
version: 1
group: lore-atlas                 # group name → becomes the shared dataDir name
owner: atlas                      # which member owns THIS declaration (git home)
members:
  - name: atlas
    path: .                       # relative to this file's repo root
    remote: git@bitbucket:org/groundfloor-atlas.git
    memory: .atlas/memory.jsonl   # relative to member root (the default)
  - name: lore
    path: ../../Lore/groundfloor-lore     # local working-copy path
    remote: git@bitbucket:org/groundfloor-lore.git
    memory: .atlas/memory.jsonl
```

Field intent:
- `group` — the **shared workspace/dataDir name**. Groundfloor Atlas resolves dataDir as
  `<lore-data>/<workspace>` today (`cli.ts:240`, `embeddedRegistry.ts:25-27`); the group
  simply *is* a workspace whose name is `group`. So `lore-atlas` → dataDir
  `<lore-data>/lore-atlas`. This reuses the existing isolation boundary — a group is
  "just another workspace" that happens to be fed by N repos.
- `members[].path` — the **local checkout** to read `memory.jsonl` from at load time.
  Optional/advisory; if missing, the member is skipped with a warning (degrade, don't
  fail).
- `members[].remote` — stable identity, used for the **repo-namespace** (see
  Cross-project Edges) and so a teammate who checked the repo out elsewhere can re-point
  `path`.
- `members[].memory` — path to that member's export, default `.atlas/memory.jsonl`.

### Why not a config entry instead of a file?

A `cfg.lore` config entry (machine-global) would be the orphan-with-no-git-home we are
told to avoid. A committed `.atlas/group.yaml` travels with the owner repo, is reviewable
in PRs, and is reproducible for every teammate. **Isolation stays default**: a repo with
no `group.yaml` is never grouped.

---

## Load-on-connect

### The mechanism

When Groundfloor Atlas opens a workspace that has a `group.yaml`, it:

1. Resolves the **shared dataDir** = `<lore-data>/<group>` (existing path math,
   `cli.ts:240` / `embeddedRegistry.ts:25-27`).
2. For each member, resolves `path/memory` → that repo's `.atlas/memory.jsonl`.
3. Calls the **existing `importMemory`** (`memorySync.ts`) once per member, with
   `targetWorkspace = <group>`. Every node/edge is stamped with the group workspace as
   `project` and upserted into the one shared store.
4. Serves all reads (recall/search/subgraph) from that single shared instance, which the
   registry already caches per dataDir (`embeddedRegistry.ts:19,32-41`).

This is **N invocations of code that already exists**. `importMemory` already accepts an
arbitrary `targetWorkspace` and stamps it (`memorySync.ts:502`, comment: "IMPORTER's
workspace, not source's").

### (a) one shared Lore vs (b) federation — we pick (a), by unique ids

Ground-truth read #2 was explicit: **(a) one shared embedded Lore is dramatically easier;
the code already supports it with near-zero change. (b) federation is the hard path.**

Why (a) wins, from the code:
- `recall` is **already store-wide** — it passes no `project` filter and queries the
  whole `'default'` Lore workspace (`embeddedLore.ts:383-385`). Co-located nodes are
  co-queryable *for free*.
- The registry already coalesces on dataDir (`embeddedRegistry.ts:32-41`) — one group =
  one cached instance, one kuzu/lance handle, no double-open contention.
- `importMemory` already does the multi-source ingest into one target
  (`memorySync.ts:502`).

Why (b) is the hard path: **every read tool takes exactly one `EmbeddedLore` + one
`workspace`** (`recall(lore,…)`, `buildSubgraph(lore, workspace,…)`,
`traceProcess(lore, workspace,…)`, `listCommunities(lore, workspace,…)`). There is **no
union/merge layer anywhere** — nothing fans a query across instances, no cross-instance
score normalization, and **no cross-instance edge join is even possible** (edges live
inside one kuzu via `rawGraph().queryEdges`, `embeddedLore.ts:342-355`). Federation means
writing all of that from scratch.

**Decision: shared store, distinguished by globally-unique ids.** Import all members into
one dataDir under one group workspace.

#### Provenance caveat (read honestly)

When N repos import into one group workspace, **every node's `project` is flattened to
the group name** (`memorySync.ts:502` → `embeddedLore.ts:135`), and import **discards the
header's `sourceWorkspace`** (`:326-337`). So you cannot later filter "only repo A" by
`project`. To keep per-repo provenance, the load step should **stamp the source repo into
`tags` or `metadata`** on import (e.g. `metadata.sourceRepo = <member.name>`). This is a
small additive change to the load path, not a format change to the on-disk files.

There is a structural alternative — import each member under a **distinct `project`** in
the same store — but read #2 showed that **distinct projects re-scope traversals per
repo** (node reads are project-filtered: `subgraph.ts:216-217`,
`communities/index.ts:106-107`, `processes/index.ts:115`), which would *defeat*
cross-repo subgraph/processes. So for true cross-repo behavior we want **same project
(the group) + provenance in metadata.**

### A0 makes this seconds, not minutes

The import gate for the no-model fast path (`memorySync.ts:423-427`): header
`version >= 2` **AND** the writer has `bulkStoreNodesWithVectors` **AND** every node
carries a non-empty numeric `embedding`. When satisfied, import calls
`bulkStoreNodesWithVectors` → `lore.bulkIngest(…, { embed:'precomputed' })`
(`embeddedLore.ts:189-213`). Per `docs/LORE-ASK-PRECOMPUTED-VECTORS.md`: precomputed
"writes the supplied `embedding` directly to LanceDB. No model invocation. No embed-queue
round-trip," with the target "~1,500 nodes … under 5 seconds … vs the current ~5 minutes
to re-embed."

**So a group of N repos loads in seconds — provided every member `memory.jsonl` is
v2-with-vectors and the embedding dim matches the importer.** Any v1 file, any missing
vector, or any dim mismatch drops *that subset* to the per-node re-embed path
(`memorySync.ts:429-440, 459-481`) — minutes if a whole member file lacks vectors. Load
gate to enforce in build: refuse/warn if a member is v1 so the group stays in the fast
lane.

### Does the code graph land in the shared space, or only memory?

**Only memory needs to travel.** Memory sync intentionally syncs only the 5 knowledge
types and **skips `code_file`/`code_symbol`/`code_context`** as regenerable
(`memorySync.ts:18-21, 54-62`). So:

- **Cross-project RECALL** (knowledge surfacing) needs **only the co-loaded memory** —
  done by the import step above. This is the G-1 deliverable.
- **Cross-project CODE TRAVERSAL** (subgraph/processes/communities) needs the **code
  graph present in the same store**, stamped with the **same project** so node-filtered
  reads span both repos (read #2, Q3: same project = true cross-repo traversal). Since
  the code graph is **not** synced, you must `atlas index` each member **pointed at the
  shared group dataDir** with the group workspace. That is a separate, later phase (G-3),
  and the cross-repo *code-vector* fast path depends on the `--include-code-vectors`
  companion that `docs/LORE-ASK-PRECOMPUTED-VECTORS.md:159-170` lists as **future Groundfloor Atlas
  work, not shipped.**

**Net:** G-1 co-loads memory only (cross-project recall). Code-graph co-location is G-3.

---

## Cross-project EDGES

The interesting case: a real, traversable link such as
`Lore.bulkIngest → Atlas.bulkStoreNodes` (a decision/architecture in one repo pointing at
a symbol or decision in the other). Three questions: who **authors** it, where is it
**stored**, how is it **resolved**.

### Are ids already globally unique? (mostly yes, with one flag)

From read #1:
- **Code ids ARE repo-qualified:** `code-symbol:<repo>/<sym.id>`,
  `code-file:<repo>/<path>` (`codeNodes.ts:75-85`). `dayjs` and `lore` produce distinct
  ids and **do not collide**; a cross-repo edge can reference both endpoints by qualified
  id.
  **Flag:** `<repo>` is only the **directory basename** (`cli.ts:433-441`). Two checkouts
  sharing a basename collide. The group must derive `<repo>` from a stable key (the
  `members[].remote` or `members[].name` in `group.yaml`) rather than the bare basename,
  to guarantee uniqueness across members.
- **Knowledge ids are NOT repo-namespaced.** They are auto-generated
  `knowledge:${type}:${Date.now()}-${rand}` (`allTools.ts:351-352`) — effectively unique,
  but a **caller-chosen kebab-case id** (the CLAUDE.md convention, e.g.
  `auth-jwt-rotation-fix`) is a **bare global string with no repo prefix**. Two repos that
  both committed `auth-jwt-rotation-fix` would **silently clobber on upsert** in the
  shared store (`embeddedLore.ts:127`).
  **Mitigation:** the cross-seam convention should require **globally-qualified knowledge
  ids** for any node intended to be referenced across the seam — e.g. prefix with the
  owning member name: `lore/bulk-ingest-precomputed-decision`. (This is a *convention*,
  enforced at author time; the storage format already permits any string id.)

### Authored by whom, with what tool

Cross-seam edges are authored **deliberately**, not synthesized by sync. The author is
whoever owns the concern (decision #1) — e.g. an agent or human working in the Groundfloor Atlas repo
records "Groundfloor Atlas's `bulkStoreNodes` consumes Lore's `bulkIngest` precomputed contract." The
tool is the **existing** `knowledge_store_edge` path (`allTools.ts:387-398` →
`embeddedLore.ts:139-152`), called with **both globally-qualified endpoint ids** while the
group is loaded (so both endpoints resolve).

### Stored where (decision #1 — in the owning repo's git)

The edge is **stored in the owning repo's `.atlas/memory.jsonl`** — the repo that owns the
concern. It is an ordinary `EdgeLine` (`{"kind":"edge","sourceId","targetId","relation"}`)
referencing the other repo's node by its **globally-qualified id**. No orphan group-edge
file. When the owning repo's memory is re-exported, the cross-seam edge travels with it in
git, exactly like any other knowledge edge.

**Honest blocker to clear first:** today's export keeps an edge only if **both endpoints
are knowledge nodes** (`memorySync.ts:216-217`) and **drops all code↔knowledge edges**
(header `:23-25`). So:
- A **decision→decision** cross-seam edge already survives export/import **today**,
  provided both endpoint ids are present in the file's node set or are tolerated as
  dangling references. (Edges whose endpoints aren't in the same file are still emitted as
  `EdgeLine`s; resolution happens at group-load time when both repos are co-loaded.)
- A **decision→code-symbol** cross-seam edge is **currently dropped on export**. Enabling
  it is gated on the id-stability work the header itself cites. That is **G-2+**, not G-1.

### Resolved how

Once the group is loaded, **both endpoint nodes live in the one shared dataDir**, so the
edge row in kuzu has real targets and the traversal builders keep it (their endpoint-
existence guards: `processes/index.ts:179`, `subgraph.ts:288-295`,
`communities/index.ts:165`). Before the group is loaded — i.e. in either repo alone — the
edge simply references an id that isn't present locally and is inert. That is the correct
behavior: the link only "lights up" in the group view, which is exactly what a cross-seam
relationship is.

---

## Cross-project RECALL

This is the cheap, high-value win and it is **architecturally distinct from edges** (read
#2 made the distinction sharp).

**Why it's nearly free:** `recall` already ignores `project` and queries the entire
`'default'` Lore workspace (`embeddedLore.ts:367-446`, esp. `:383-385`; the comment at
`:362-366` literally assumes "one dataDir = one project, so no project filter is needed").
Therefore the **only** thing required for "a decision in repo A surfaces when querying the
group" is to **get repo A's and repo B's knowledge nodes into the same dataDir** — which
is exactly what the load-on-connect import does. **No recall code change at all.**

Contrast with edges (which need: both endpoints co-located **plus** a new explicit
edge-authoring path **plus** id-stability guarantees). Recall is the order-of-magnitude
smaller change — it is literally "co-locate the memory."

One caveat on `search` (not recall): `knowledge_search` **is** project-scoped on its
keyword fast-path (`allTools.ts:478`, `embeddedLore.ts:485`). Since the group flattens
everything to one group `project`, group `search` works **because** all members share the
group project. (If you ever kept distinct projects per member, you'd have to union them in
search — another reason the chosen model uses one shared group project.)

---

## Migration

### Is it lossless? Yes.

- Existing `.atlas/memory.jsonl` files **work as-is** in a group. The group **reads** them
  through the same `importMemory` they already round-trip through. No reformat, no
  re-export required.
- The per-repo files are untouched on disk. Removing the group leaves every repo exactly
  as before. **Isolation is recoverable at any time** by deleting `group.yaml` (or just
  not loading the group).

### One real precondition: v2-with-vectors for the fast path

If a member's `memory.jsonl` is **v1** (no vectors), group load still works but drops that
member to the **minutes-long re-embed path**. Migration recommendation: **re-export each
member once** so its file is v2-with-vectors (this happens automatically once the repo has
embedded vectors, `memorySync.ts:235`). This is a one-time `atlas memory export` per repo,
not a format change.

### What a user DOES to convert two isolated repos into a group

1. Pick the **owner repo** (the integrator — e.g. Groundfloor Atlas).
2. Add `<owner>/.atlas/group.yaml` listing both members with `path` + `remote` (template
   above). Commit it.
3. Ensure each member has an up-to-date **v2** `.atlas/memory.jsonl` (`atlas memory
   export` in each; commit).
4. Open the group workspace in Groundfloor Atlas. Load-on-connect imports both members into
   `<lore-data>/<group>` and **cross-project recall is live immediately**.
5. (Later) Author cross-seam edges with `knowledge_store_edge` and re-export the owner's
   memory to persist them (G-2).

No data is migrated or destroyed. The conversion is **purely additive**.

---

## Phased build plan (smallest-first)

### G-1 — Group declaration + co-load memory (cross-project RECALL only)

- Parse `<owner>/.atlas/group.yaml`.
- On connect to a group workspace, `importMemory` each member's `memory.jsonl` into the
  shared `<lore-data>/<group>` dataDir with `targetWorkspace = <group>`.
- Stamp `metadata.sourceRepo` per member on import (provenance; small additive change to
  the import/load path).
- **Ship gate:** querying the group recalls decisions from BOTH repos in one result set;
  each result carries `sourceRepo`; deleting `group.yaml` restores byte-identical isolated
  behavior; load of two v2 members completes in **seconds** (A0 fast path, not the
  re-embed path).

### G-2 — Cross-project EDGES (decision↔decision across the seam)

- Convention: **globally-qualified knowledge ids** for cross-seam-referenced nodes
  (`<member>/<slug>`); derive code `<repo>` from `members[].remote/name`, not basename.
- Author cross-seam edges via existing `knowledge_store_edge`; **store them in the owning
  repo's `memory.jsonl`** (decision #1).
- Confirm export/import round-trips a decision→decision edge whose endpoints resolve at
  group-load.
- **Ship gate:** a cross-seam `Lore.X → Atlas.Y` (knowledge↔knowledge) edge is authored in
  the owner repo, survives export→commit→group-load, and is traversable in the group view
  but inert in either repo alone.

### G-3 — Cross-project code graph + subgraph/communities in the viz

- `atlas index` each member into the shared group dataDir with the **same project**, so
  node-filtered traversals span both repos (read #2 Q3).
- Lift the export drop of `code↔knowledge` edges once code-symbol id stability is verified
  (the header `:23-25` caveat); enable `decision→code-symbol` cross-seam edges.
- Surface cross-repo subgraph/communities/processes in the UI.
- **Ship gate:** a subgraph rendered for the group shows symbols from BOTH repos connected
  by at least one real cross-repo edge; depends on the `--include-code-vectors` precomputed
  companion (future Groundfloor Atlas work) for the fast first-load.

---

## Open risks (honest)

1. **Knowledge-id collisions on co-import.** Auto-gen ids are safe; **caller-chosen
   kebab-case ids are not namespaced** (`allTools.ts:351-352`) and silently clobber on
   upsert (`embeddedLore.ts:127`). G-2's globally-qualified-id convention is a *convention*
   — nothing in storage enforces it. Risk of a quiet overwrite until/unless a guard is
   added.
2. **`project` flattening loses native provenance.** Co-import collapses all members to one
   group `project` and discards `sourceWorkspace` (`memorySync.ts:326-337, 502`). We
   reconstruct provenance in `metadata.sourceRepo`, but anything that *already* relied on
   `project` to mean "one repo" changes meaning inside a group.
2b. **Recall is store-wide by design — that's the feature *and* the risk.** Because recall
   ignores `project` (`embeddedLore.ts:383-385`), the moment two repos co-reside they
   co-mingle on recall. That is exactly what we want for a *group*, but it means **a group
   dataDir must only ever contain intended members** — accidentally importing an unrelated
   repo into a group store pollutes every recall. Isolation default + explicit `group.yaml`
   is the guardrail.
3. **`<repo>` basename namespace is not globally unique.** Code ids use directory basename
   (`cli.ts:433-441`); two members with the same basename collide. G-2/G-3 must derive the
   namespace from `remote`/`name`, and legacy repo-less callers produce unqualified ids.
4. **v1 members silently fall to the slow path.** A single v1 (or dim-mismatched) member
   turns "seconds" into "minutes" (`memorySync.ts:429-440, 459-481`). Needs a load-time
   check that warns/blocks on v1 members.
5. **code↔knowledge edges are dropped on export today** (header `:23-25`). G-3's
   `decision→code-symbol` links are blocked on the id-stability work the code itself flags
   as unfinished. Do not promise traversable code-to-decision links before that lands.
6. **No union layer means (b) federation stays impossible without real work.** We chose (a)
   precisely because (b) doesn't exist. If a future requirement forbids co-locating member
   data in one store (e.g. permissions/tenant isolation), the whole model needs rethinking
   — there is no cross-instance edge join in kuzu (`embeddedLore.ts:342-355`).
7. **Stale `members[].path`.** The declaration pins local checkout paths; a teammate's
   layout differs. Mitigation: resolve by `remote` and degrade gracefully (skip+warn) when
   a `path` is missing, rather than failing the whole group load.

---

# ⚠️ BUILDABILITY REVIEW — corrections that OVERRIDE the sections above

Adversarial critique verified every claim against the real storage code. Verdict:
**buildable WITH FIXES.** The cheap half (G-1) is sound; the headline half (G-2 cross-seam
edges) rests on FALSE storage-layer assumptions and cannot ship as written. Where this
section conflicts with the spec above, THIS WINS.

## G-1 — cross-project RECALL — ✅ REAL AND CHEAP (the actual near-term win)
A teammate's decision stored about Lore surfaces when you query the Groundfloor Atlas+Lore group.
Verified genuinely store-wide with ~zero new code:
- recall passes NO project filter (embeddedLore.ts:383-385; allTools.ts:429 lore.recall(topic,{}))
  → co-located memory is co-queryable for free.
- importMemory accepts an arbitrary targetWorkspace + stamps project=group (memorySync.ts:502);
  the embedded registry coalesces per dataDir (embeddedRegistry.ts:25-41) → one group = one store.
- Moat intact (import never writes back to .atlas/memory.jsonl); memory migration is lossless,
  no re-embed when files are v2-with-vectors.
**Fold into G-1 before building:** (a) a `metadata.sourceRepo` provenance stamp on import
(so a hit shows which repo it came from — the G-1 ship gate silently needs this; import
currently flattens project to the group name and discards sourceWorkspace); (b) a
knowledge-id collision DETECTOR (caller-chosen kebab ids are unprefixed → silent clobber on
upsert the moment two repos co-import); (c) a v1/dim-mismatch load-time warn (else a single
v1 member silently drops to the minutes-long re-embed path, breaking the "seconds" promise).

## G-2 — cross-seam EDGES — ❌ THREE BLOCKERS (the headline differentiator is currently broken)
1. **addEdge silently no-ops on missing endpoints.** graphEdges.js:97-110 is MATCH..CREATE
   with NO throw — a dangling edge is a silent no-op, NOT "rejected strictly" and NOT "lights
   up later when the group loads." The spec's edge-resolution narrative is factually wrong.
2. **Import applies edges BEFORE nodes exist.** Edges are applied inline (memorySync.ts:344-345)
   but nodes are buffered + ingested only after the stream ends (memorySync.ts:360). So even an
   in-repo decision→decision edge silently drops, while result.edgeCount falsely increments.
   No reconnect pass exists.
3. **Export DROPS cross-store edges before git.** exportMemory keeps an edge only if BOTH
   endpoints are local knowledge ids (memorySync.ts:216-217) → a cross-seam Atlas.X→Lore.Y
   edge never reaches .atlas/memory.jsonl at all.
**Plus the foundation:** ids are NOT globally unique — code `<repo>` is a bare directory
basename (cli.ts:433-441, in-code comment "stand-in until git-aware repo resolution lands"),
knowledge ids are unprefixed. The whole edge story needs real ids first.
**Fixes (all required before G-2 ships):** ingest nodes-before-edges + a post-load reconnect
pass; make addEdge report "skipped: endpoint missing" (count rows actually created); relax the
export edge filter to emit local-source→foreign-target edges; derive `<repo>` from a stable
key (group.yaml member remote/name) wired into the indexer's opts.repo; globally-qualified
knowledge ids; and a round-trip test (export→import→assert edge present) — NONE exists today.

## G-3 — cross-repo code TRAVERSAL — forces a full re-index (spec underplayed)
Code nodes are never synced (memorySync.ts:54-62); traversals are project-filtered
(subgraph.ts:216-217, communities/index.ts:106-107, processes/index.ts:115). Cross-repo
code traversal requires `atlas index <member> --workspace <group>` for EVERY member (full
parse+embed, minutes) — NOT migratable from existing per-repo indexes. Code-vector fast-load
is unshipped (LORE-ASK-PRECOMPUTED-VECTORS.md is memory-only). Do NOT promise "seconds" for G-3.

## Net
- **G-1 (cross-project recall): real, cheap, ship-worthy** once the 3 G-1 folds land.
- **G-2 (cross-seam edges): the differentiator, but currently broken at the storage layer** —
  needs the import-ordering + reconnect + export-filter + id-namespacing fixes + a round-trip
  test before it can ship. This is a real project, not a quick add.
- **G-3 (cross-repo code graph): a full re-index per member**, gated on unshipped code-vector
  bundling for fast load.
