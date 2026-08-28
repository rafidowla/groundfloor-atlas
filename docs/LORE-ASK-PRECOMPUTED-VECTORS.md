# Lore ask — precomputed vectors in `bulkIngest`

**One-line summary:** Groundfloor Atlas's git-syncable team memory is text-only today, so on a fresh
clone the vectors regenerate locally. For a teammate's small `.atlas/memory.jsonl`
(decisions + conventions) that's fine — sub-second. But to extend the moat to ship
**code-context vectors** alongside text — eliminating the multi-minute "first-clone wait"
that's currently Groundfloor Atlas's roughest UX edge — we need `bulkIngest` to accept a
pre-computed embedding vector per node and skip its own embed call.

This was flagged for context in `docs/LORE-ASK-FOLLOWUPS.md` and the bundle issue. This
doc is the actionable spec.

---

## Why this is needed now

### The current state, plainly

- Groundfloor Atlas indexes a repo → produces `code_context` nodes (one per file, embedded) + curated
  knowledge nodes (decisions/conventions/etc., embedded).
- Today's moat (Wave 3, shipped) ships ONLY the curated knowledge as `.atlas/memory.jsonl`
  (text). Vectors regenerate locally on import — fast for ~10 decisions.
- For the *code* side of the index — the part the dev's IDE-AI actually queries
  ("explain this function", "what calls X") — there's no cross-machine sharing. Each
  teammate's machine re-embeds 1,500+ files on first clone. ~5 minutes.

### The user experience this blocks

> Teammate clones the repo. Runs `atlas`. Waits 5 minutes for first index to finish.
> THEN can start asking questions.

vs. the unblocked version:

> Teammate clones the repo. Runs `atlas`. **Code vectors are already in the repo**
> (deterministic, computed once by CI or first-machine). Groundfloor Atlas imports them locally
> in seconds. Ready to use.

The text-only path can't deliver this because re-embedding 1,500 files is the cost — not
the file transfer. **Lore needs to accept a vector that the caller already computed.**

### Why this is structurally a Lore decision

Groundfloor Atlas knows the embeddings model, the dimensionality, and the text → vector mapping.
Groundfloor Atlas computes the vectors today (via `lore.bulkIngest({ embed: 'sync' })`). What's
missing is the API surface to *provide* a vector and have Lore store it without
re-computing. The embedding pipeline is Lore's; only Lore can decide whether and how to
trust caller-provided vectors. This is the right boundary.

---

## The ask — extend `BulkIngestOpts` and `BulkIngestNodeArgs`

Add a third value to the `embed` enum and a per-node `embedding` field:

```ts
interface BulkIngestOpts {
  autolink?: boolean;
  // EXISTING values: 'sync' | 'async'
  // NEW value: 'precomputed' — each node MUST carry an `embedding` field; Lore
  // validates dim + writes directly without invoking the embedding model.
  embed?: 'sync' | 'async' | 'precomputed';
  embedBatchSize?: number;
}

interface BulkIngestNodeArgs {
  id: string;
  workspace: string;
  ecosystem: string;
  nodeData: Record<string, unknown>;
  skipEmbed?: boolean;
  // NEW: when opts.embed === 'precomputed', this MUST be provided for any node
  // where skipEmbed is not true. When opts.embed !== 'precomputed', this field
  // is ignored (back-compat).
  embedding?: number[];
}
```

### Contract — what the caller can rely on

1. **`embed: 'precomputed'`** writes the supplied `embedding` directly to LanceDB.
   No model invocation. No embed-queue round-trip.
2. **Dimensionality validation at the API boundary.** Each `embedding.length` must
   match the configured local model's dim (e.g. 384 for `multilingual-e5-small`).
   Mismatches reject the **single node** with `{ ok: false, error: 'dim mismatch' }` —
   they do not abort the batch.
3. **`skipEmbed: true`** still works per-node — graph-only writes (no vector row), as
   today. `precomputed` is for the opposite case: vector provided, persist it.
4. **`embed: 'precomputed'` without an `embedding` on a non-skip node** rejects that
   node with `{ ok: false, error: 'missing precomputed embedding' }`. Other nodes in
   the batch still succeed.
5. **No `autolink` interaction** — like other modes, autolink is governed by
   `opts.autolink` and respects the per-node similarity search (which works on the
   stored vector, regardless of how the vector arrived).
6. **Persistence parity** — a node written with `embed: 'precomputed'` is
   indistinguishable from one written with `embed: 'sync'` at query time. Same
   `recall` / `search` results.

### What's already in Lore that should be reused

- `bulkLoader/lanceAdapter.ts` already supports batched `table.add(rows)` with
  Arrow batches. The pre-computed path skips the embed step and goes straight to
  the existing Arrow ingest.
- Dimensionality is already known to Lore (`DEFAULT_LOCAL_MODEL_DIM = 384`); validation
  is a one-line check per node.
- The `embed: 'sync'` path is already wired (Groundfloor Atlas uses it today). `'precomputed'` is
  effectively the same path minus the `embedDocumentBatch` call.

This is **plumbing**, not new substrate code.

---

## Out of scope (deliberately)

- **Vector format on disk for Groundfloor Atlas's git-sync** — Groundfloor Atlas's responsibility, not Lore's.
  Groundfloor Atlas will ship vectors as a sibling file to `.atlas/memory.jsonl` (e.g.
  `.atlas/vectors.bin` or sharded per-file) and decide whether they're checked in or
  Git-LFS-stored.
- **Cross-model compatibility** — if Groundfloor Atlas-on-machine-A used model X and Groundfloor Atlas-on-
  machine-B uses model Y, Groundfloor Atlas detects the mismatch and falls back to re-embedding.
  Not Lore's problem.
- **CI computing vectors and committing them** — purely Groundfloor Atlas / user-workflow.
- **Verifying vector authenticity / signing** — out of scope for MVP. If a user commits
  manipulated vectors, the search returns garbage; this is the same trust model as
  committing any file to the repo.

## Acceptance criteria

These are testable against an Groundfloor Atlas reproduction:

1. **API exposed.** `lore.bulkIngest(nodes, { embed: 'precomputed' })` type-checks and
   runs without throwing for well-formed input.
2. **Dim validation.** Passing an embedding of wrong length returns
   `{ ok: false, error: ... }` for that node; the rest of the batch succeeds.
3. **Persistence parity.** A node written with `embed: 'precomputed'` is recallable
   via `recall` and `search` with identical score to the same content written with
   `embed: 'sync'`. (Both go through the same vector; tolerance ~1e-6.)
4. **Groundfloor Atlas wall-clock target.** With this shipped, Groundfloor Atlas's "fresh-clone import of code
   vectors" reproduction (~1,500 nodes, dayjs-sized) should complete in **under 5
   seconds** total — vs the current ~5 minutes to re-embed. (Dominated by Arrow batch
   write + the file I/O Groundfloor Atlas already pays for the JSONL.)
5. **No regression on `'sync'` / `'async'`** paths — existing Groundfloor Atlas wire-up at
   `embeddedLore.ts:bulkStoreNodes` keeps working unchanged.
6. **Backward compat** — calls without `embed: 'precomputed'` ignore any `embedding`
   field on nodes (no surprise behavior for existing callers).

---

## Why this is general, not Groundfloor Atlas-specific

This unblocks two distinct future cases beyond Groundfloor Atlas's first-clone moat:

1. **Migration / backup restore** — a Lore instance dumped + restored elsewhere
   shouldn't have to re-embed every node.
2. **Multi-machine training/fine-tuning pipelines** — any app that wants
   deterministic vectors across machines without round-tripping through the model.

Groundfloor Atlas is the first caller to need it; the API shape is genuinely general.

## Groundfloor Atlas's plan once this lands

1. Groundfloor Atlas adds a vector-export companion to `atlas memory export` (e.g.
   `--include-code-vectors`) that writes `.atlas/vectors.bin` alongside `memory.jsonl`.
2. Groundfloor Atlas adds a vector-import companion to `atlas memory import` (auto-detects the
   sibling file) that calls `lore.bulkIngest(nodes, { embed: 'precomputed' })` with the
   loaded vectors.
3. Groundfloor Atlas detects model-dim mismatches (different machine using a different model) and
   falls back to re-embedding for those nodes.
4. The user-facing impact: **first-clone time drops from ~5 minutes to ~5 seconds** on
   medium repos, and the moat extends from "memory travels" to "memory AND code
   intelligence travels."

Net: Lore exposes one new enum value + one new optional field; Groundfloor Atlas extends the moat
to its biggest UX pain point.

---

## Summary

**Three-line ask:**
1. Add `embed: 'precomputed'` to `BulkIngestOpts`.
2. Add `embedding?: number[]` to `BulkIngestNodeArgs`.
3. Validate dimensionality at the API boundary; reject mismatches per-node, not per-batch.

Groundfloor Atlas's existing `bulkStoreNodes` wire-up needs no changes for back-compat; the new mode
is fully opt-in.
