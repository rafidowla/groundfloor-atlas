# Lore asks from Groundfloor Atlas — session bundle (2026-06-22)

> **For:** the `groundfloor-lore` team
> **From:** Groundfloor Atlas (embedded-Lore consumer)
> **Format:** one self-contained GitHub issue covering (a) status of every Lore ask
> Groundfloor Atlas filed this session, and (b) full specs for the items still open. Paste this
> whole document into a single issue on `groundfloor-lore`.

Groundfloor Atlas bundles Lore in-process (`createLore({ deploymentMode: 'embedded' })`) and ships
as a local-first, offline desktop/CLI app. Over this session Groundfloor Atlas filed and iterated on
a cluster of Lore asks driven by indexing-performance work and a separate type-priority
re-ranking effort for the Lore Intelligence Protocol auto-consult flow. Most have
already landed in Lore and are wired in Groundfloor Atlas. **One bug remains open and is the primary
item to action here**; a second future product ask is flagged for design context only.

---

## Status table — every Lore ask Groundfloor Atlas filed this session

| # | Item | Status | Lore commit / Groundfloor Atlas wire-up |
|---|------|--------|------------------------------|
| 1 | **`bulkIngest` API** (corrected A6 — sync-embed bulk path, autolink-off by default) | ✅ shipped | Lore: bulkIngest landed; Groundfloor Atlas wired in commit `515f1a4` |
| 2 | **`search_mode` wired in `searchTool`** (param was declared but never destructured; handler always fell through to Kùzu CONTAINS keyword) | ✅ shipped | Lore commit `84d65e1`; Groundfloor Atlas wired in commit `1cef120` |
| 3 | **`awaitEmbeds()` on `LoreInstance`** (mid-life embed-flush guarantee for the long-running daemon path — `EmbedQueue.drained()` existed but wasn't surfaced on the facade) | ✅ shipped | Lore commit `84d65e1` |
| 4 | **`bulkIngest` cold-start race** ("Failed to get node" — read-before-write in the version-store `previousState` lookup; ~20/180 transient errors on a brand-new dataDir) | ✅ shipped | Lore commit `e18785d` |
| 5 | **LanceDB on-disk size 20× delta sanity check** (8.9 MB → 0.45 MB for same workload after bulkIngest) | ✅ closed benign | No code change — WAL/compaction artifact, expected behavior |
| 6 | **`recall` over-fetch / candidate-pool cap** (`inProcessRecall` returns ~10 hits regardless of caller's `max`; Groundfloor Atlas can't over-fetch enough to re-rank effectively) | ⏳ **OPEN** | **Primary item to action — full spec below** |
| 7 | **Precomputed vectors in `bulkIngest`** (for a future moat extension that ships vectors alongside text via git-sync) | ⏸ future | Flagged for design context — NOT this PR |

Plus, from the older `LORE-REQUIREMENTS.md` doc handed off earlier this month, two items
that are partly done and worth re-noting (not part of this PR, just so the arc is honest):

| # | Item | Status |
|---|------|--------|
| P1 | Lazy-load ingestion stack + local/cloud build profiles | ✅ extractors done (fd08af7); ⏸ `sharp` still eager-loaded via `@huggingface/transformers` — partly upstream, deferred |
| Fix 2 | Ship quantized local model (`multilingual-e5-small` q8 / `model_quantized.onnx` ~113 MB) | ✅ shipped, Groundfloor Atlas verified offline store+recall |

---

## Thanks — the four shipped items, with Groundfloor Atlas-side impact

The four items that landed this session moved Groundfloor Atlas materially. Brief impact for context:

- **`bulkIngest` API (item 1)** — Groundfloor Atlas swapped its serial `withRetry` loop on the
  indexing path for `lore.bulkIngest(nodes, { autolink: false, embed: 'sync' })`.
  Measured **36% first-index speedup** on the dayjs reference corpus (180 files,
  `ATLAS_CONTEXT_LAYER=1`) versus the pre-bulkIngest serial path. No SIGABRT.
  LanceDB confirmed populated with all 180 384-dim vectors. Crucially this also gave
  Groundfloor Atlas a clean `embed: 'sync'` contract — when the promise resolves, embeddings are
  persisted; no `dispose()` drain race, no detached work outliving `process.exit()`.

- **`search_mode` wired in `searchTool` (item 2)** — this unblocked Groundfloor Atlas's semantic
  moat. Before the fix, `knowledge_search` always fell through to Kùzu `CONTAINS`
  keyword matching regardless of the `search_mode` param, so any query without literal
  keyword overlap returned `[]` even when the vector clearly matched. Groundfloor Atlas's
  ContextBench measurements depend on this path: the `atlas-semantic` and
  `atlas-semantic (multi-query hybrid)` runs that hit 1/2 → 2/2 recall at ~42% fewer
  tokens than keyword baseline are only possible with `search_mode: 'semantic'` /
  `'hybrid'` actually doing what the param says.

- **`awaitEmbeds()` on `LoreInstance` (item 3)** — the long-running Groundfloor Atlas daemon needs
  a "all queued embeds are settled" handshake between ingest bursts and serving queries
  that depend on freshly-indexed data. `EmbedQueue.drained()` existed internally but
  wasn't on the facade. Now it is, and Groundfloor Atlas calls it after each indexing burst before
  the next query phase.

- **`bulkIngest` cold-start race (item 4)** — the read-before-write race in the
  version-store `previousState` lookup caused ~20 transient "Failed to get node"
  errors per cold-start `bulkIngest` against a brand-new `dataDir` (~11% of the
  batch). Non-fatal but it forced Groundfloor Atlas's incremental pass to re-index those 20 files
  the next time even though their content hadn't changed. Eliminated by the fix; cold
  start is now clean.

And on the older `LORE-REQUIREMENTS.md` track:

- **Quantized local model (~113 MB, replacing ~470 MB fp32)** — single biggest size
  lever; verified offline store+recall in the Groundfloor Atlas bundle. This is what makes the
  "ship Lore inside Groundfloor Atlas as a local library" story real.

- **Lazy extractors (fd08af7)** — let Groundfloor Atlas prune `@napi-rs/canvas` (~25 MB) from the
  bundle. `sharp` is still eager via `@huggingface/transformers` (~16 MB), partly
  upstream; deferred and not in this bundle.

Thank you. The cumulative effect is that Groundfloor Atlas now has a working in-process semantic
memory stack — including the search/recall fast paths — with measurable
performance numbers we can publish.

---

# PRIMARY ITEM TO ACTION

## Item 6 (OPEN) — `recall` over-fetch / max cap

**TL;DR:** Groundfloor Atlas wired type-priority re-ranking (curated knowledge > auto-generated
`code_context`) using an over-fetch + re-rank + slice pattern. `knowledge_search`
(semantic + hybrid) now correctly surfaces decisions ahead of auto-generated code
context. `knowledge_recall` does NOT — Lore's `inProcessRecall` appears to return at
most ~10 hits regardless of the `max` parameter, which means Groundfloor Atlas cannot over-fetch
enough candidates to re-rank effectively.

This matters specifically because the **Lore Intelligence Protocol's documented
auto-consult flow** calls `recall()` at conversation start. When a workspace mixes a
small number of curated decisions with hundreds of auto-generated code-context cards,
the curated decisions get drowned in the top-10 cap.

### Reproduction

State: Groundfloor Atlas workspace with mixed content — 2 curated knowledge nodes (one decision,
one convention) and 180+ auto-generated `code_context` nodes (one per code file in
dayjs).

```
ATLAS_HOME=$HOME/.atlas-lockin-B atlas serve &
# probe: knowledge_recall with topic that semantically matches the decision but has
# zero shared keywords with it
node -e "<MCP call to atlas_tool_invoke -> knowledge_recall>" \
  --topic "how to handle flaky downstream APIs" \
  --workspace dayjs-lockin
```

Observed:

- The decision stored is *"Use exponential backoff with jitter to avoid
  thundering-herd retry storms"* — zero shared keywords with the query.
- Result: `{ totalRecalled: 24, shown: 10 }`. Top 10 = `[convention, 9× code_context]`.
  The decision (`lockin-dec-001`) is NOT in the top 10.
- Groundfloor Atlas requested `max: 50` internally (the over-fetch). Lore returned 10.
- The same query via `knowledge_search { search_mode: 'hybrid', limit: 25 }` returns
  `lockin-dec-001` at rank 2 — so the vector IS semantically matched; recall just
  doesn't surface it within whatever cap is applied.

### What the cap appears to be

Some upper bound (~10 by default) in `inProcessRecall` is taking effect before Groundfloor Atlas's
`max` argument can request a wider pool. Either the input `max` is being clamped
silently, or there's a separate "shown" cap defaulting to 10 before the client-side
`max` is honored.

### Ask

Make `inProcessRecall`'s candidate pool size **configurable from the caller via an
explicit option** (e.g. `max` or a new `candidatePool` option), allowing Groundfloor Atlas to
over-fetch ~50–100 candidates and apply its own re-ranking before truncating to the
user-requested limit. Concretely:

```ts
// today (effective behavior):
recall(topic, { max: 50 })  // → up to ~10 hits returned

// asked:
recall(topic, { max: 50 })  // → up to 50 candidates so caller can re-rank + slice
```

Equivalently if it's cleaner: split "candidate pool size" from "shown count" so
callers can request `{ candidatePool: 50, shown: 10 }`.

### Why this matters (in one paragraph)

Lore's own Lore Intelligence Protocol says clients should call `recall()` at
conversation start for auto-consult. When a workspace mixes auto-generated code
context with a small number of curated decisions, the curated decisions are drowned in
the top-10 cap. Groundfloor Atlas can solve this with type re-ranking *if* given access to enough
candidates; without it, the auto-consult flow surfaces noise instead of signal — which
is the opposite of what the protocol is supposed to do.

### Acceptance

After the fix, the reproduction above (with Groundfloor Atlas's over-fetch of `max: 50`) returns
≥50 candidates from `inProcessRecall`. Groundfloor Atlas's existing `reRankByType` then surfaces
the decision in the user-facing top 5 of the response.

### Adjacent context — Groundfloor Atlas-side commit ahead of this ask

`src/lore/embeddedLore.ts` (Groundfloor Atlas) now does over-fetch (`min(userLimit × 5, 100)`) +
`reRankByType` + slice in both `recall()` and `search()`. The change is correct and
useful in both paths; it just happens to be insufficient in the `recall()` path until
Lore exposes a larger candidate pool. The `search()` path works correctly today
(committed in Groundfloor Atlas `3525d2f`) because `knowledge_search` honors the larger `limit`
once `search_mode` is set.

---

# Item 7 (FUTURE PRODUCT ASK — flagged, NOT this PR)

## Allow pre-computed vectors in `bulkIngest`

For Groundfloor Atlas's git-sync moat (`.atlas/memory.jsonl` — text knowledge synced across
machines; vectors regenerate locally on import), the current
*sync-text-and-re-embed-the-delta* contract works fine today because memory is small
(sub-second re-embed for typical team memory). It would NOT work for syncing
**code-context vectors** — those are large enough that re-embedding-on-clone becomes
the slow step we're trying to eliminate.

If a future moat extension ships *vectors* alongside text (so a fresh clone is
instant, not minutes), the shape Groundfloor Atlas would want is:

```ts
lore.bulkIngest(
  nodes.map((n) => ({ ...n, embedding: precomputedVector })),  // caller supplies vector
  { autolink: false, embed: 'precomputed' },                   // new mode: skip embed call
);
```

The constraint: vector dimensionality must match the configured model, and Lore should
validate or reject mismatches at the API boundary (not silently corrupt the table).
Surfacing the model fingerprint at write time would make this safe.

**Explicitly not asking for this now.** Flagging so when Groundfloor Atlas comes back asking, the
design isn't a surprise. No action required for this PR.

---

# What Groundfloor Atlas is shipping in parallel

For full visibility:

- **`knowledge_search` semantic / hybrid + over-fetch + re-rank already works
  correctly today** (Groundfloor Atlas commit `3525d2f`). Agents that use `search` instead of
  `recall` are unblocked. Measured: on the `lockin-dec-001` repro above, the decision
  appears at rank 2 in the top 5 of a `search_mode: 'hybrid', limit: 25` call.

- **The `recall`-cap fix above completes the picture for the Lore Intelligence
  Protocol auto-consult flow.** Both entry points then surface curated decisions
  ahead of auto-generated context cards in mixed workspaces, which is the whole point
  of the protocol.

- Groundfloor Atlas-side commit ahead of this ask: `src/lore/embeddedLore.ts` does over-fetch +
  `reRankByType` + slice in both `recall()` and `search()`. Correct and useful in
  both paths; only `recall()` needs the Lore-side cap raised to take effect.

---

# Summary for the Lore engineer picking this up

- **One bug to fix in this PR:** raise / expose the `inProcessRecall` candidate-pool
  cap so callers passing `max: 50` actually get up to 50 candidates back. Acceptance
  criterion above is testable via the reproduction.
- **One future ask flagged for design context only:** precomputed vectors in
  `bulkIngest`. No work for now.
- **Everything else from this session has shipped on the Lore side and is wired in
  Groundfloor Atlas.** The status table at the top is exhaustive for this session's asks.

Thanks again for the four landings this session. The momentum from bulkIngest +
`search_mode` + `awaitEmbeds` + the cold-start race fix is what made the
type-priority re-ranking work feasible in the first place; the recall cap is the
last piece.
