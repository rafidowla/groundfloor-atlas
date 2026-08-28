# Lore — requirements from Groundfloor Atlas (embed-as-library, local-first)

**For:** the `groundfloor-lore` team · **From:** Groundfloor Atlas · **Date:** 2026-06-20
**Context:** Groundfloor Atlas bundles Lore in-process (`createLore({ deploymentMode: 'embedded' })`)
and ships as one self-contained, **local-only**, offline desktop/CLI app. Lore stays
the neutral memory engine; Groundfloor Atlas is the code-aware layer. A separate **cloud** Lore
(ArangoDB / Postgres / Qdrant·Zilliz) is the other deployment of the *same codebase*.

This document is the prioritized list of Lore-side changes Groundfloor Atlas needs. It is grounded
in a code audit of the current embedded bundle (940 MB, Lore v3.11.0).

---

## P1 — Per-mode dependency decoupling (the keystone)

Today Lore eagerly loads its **document-ingestion stack** (sharp, canvas, exceljs,
pdfjs, tesseract) and the embedding runtime at init, even on a code-only path. Groundfloor Atlas
never ingests documents. Make the heavy subsystems **lazy / optional** so a host can
pull only what its mode needs.

**Deliverables**
1. **Lazy-load** the ingestion stack (image/PDF/Excel/OCR) — load on first actual use,
   not at boot. (Today pruning them crashes Lore: *"Could not load the sharp module"* —
   they're `require`d eagerly. That eager require is the bug.)
2. **Two build/package profiles from one codebase** (not two codebases):
   - **`local`** — kuzu + lancedb + sqlite + local embedder + onnxruntime + wasm-sql.
     **Excludes** cloud DB drivers. This is what Groundfloor Atlas embeds.
   - **`cloud`** — Arango/Postgres/Qdrant drivers + hosted embedding provider.
     **Excludes** local native engines + the bundled model.
   Selected by the existing `deploymentMode` switch; express as optional/peer deps +
   conditional loading.

**Why it matters:** this one change unlocks (a) the local/cloud split, (b) the bundle
**size cut** (~100+ MB of unused ingestion libs off the local profile), and (c) a clean
offline Groundfloor Atlas. Everything else about size depends on it.

**Impact:** local Groundfloor Atlas bundle ~940 MB → target ~500–700 MB (keeping lancedb + model,
which Groundfloor Atlas needs — see P3).

**P1 status (verified 2026-06-20): PARTIALLY DONE.** The first P1 pass moved the
*extractors* (exceljs/mammoth/mailparser/pdfjs/tesseract) to dynamic import — Groundfloor Atlas
now prunes those from the bundle safely. **But `sharp` (+ its `@img` native) and
`@napi-rs/canvas` are STILL eagerly `require()`d at embedded `createLore()` init** —
pruning `@img` crashes the bundle at `sharp.js` ("Could not load the sharp module").
**Remaining P1 ask:** make sharp/canvas lazy on the embedded init path too (load only
when an image is actually processed). Until then ~40 MB of image libs are stuck in the
local bundle, and the realized size cut is only ~25 MB (extractors), not the full ~100+.

---

## P2 — In-process semantic recall + embeddings in embedded mode

**Audit finding:** `createLore({ deploymentMode:'embedded' })` currently gives Groundfloor Atlas
graph ops only. Semantic memory does **not** work in-process:
- no in-process **recall / vector-search** entry point (Groundfloor Atlas's `EmbeddedLore` has
  storeNode/getNode/listNodes/traverse but no `recall`/`search`);
- the local embedder is not exercised on the embedded write path.

Groundfloor Atlas's memory-bank + contradiction-gate features depend on this. We need, **in-process,
parity with the REST `/api/recall` + `/api/search`**:

**Deliverables**
1. **In-process `recall(topic, opts)` and `search(query, opts)`** on the embedded Lore
   handle — same semantics as the HTTP endpoints (vector similarity over LanceDB).
2. **Embedded write-with-embedding path** — when Groundfloor Atlas writes a knowledge node with
   `embed: true`, the local embedder runs and the vector lands in LanceDB in-process
   (today the embedded adapter only does graph-only `skipEmbed` writes).
3. **Incremental re-embed** in-process (`embed.batch` equivalent) so a device re-embeds
   only **new/changed** nodes after a git pull (see Sync contract below).

---

## P3 — Local model delivery (offline)

The embedding model is **pruned** from Groundfloor Atlas's bundle, so offline recall can't embed a
query. For a local-first app the model must be present without a network call.

**Deliverables**
1. Ship the **small default local model** (384-d Xenova — `all-MiniLM-L6-v2` /
   `multilingual-e5-small`; confirm + pin exactly which) inside the `local` profile,
   **or** a deterministic first-run fetch with an offline fallback.
2. **Pin `modelId` + `dimension` as a cross-device contract.** (Lore already exposes a
   model fingerprint — good; surface it so Groundfloor Atlas can validate before trusting any
   synced data and trigger `migrateEmbeddingModel`/`reEmbedJob` on mismatch.)

---

## Sync contract (confirm + keep)

Groundfloor Atlas syncs memory across devices/users via **git/Bitbucket**, all on the **same local
model**. Audit confirms Lore already does the right thing — please keep it as a contract:

- **Text/ids are the synced source of truth; vectors are derived, machine-local.** The
  outbox/replication payloads carry ids + text and **re-derive** vectors locally
  (`embed.batch`); `sync.vector.mirror` references nodes by id, never ships raw floats.
- Therefore Groundfloor Atlas will **sync text and re-embed the delta** on each pull — no vector
  blobs in git. Please don't change this to push raw vectors into the portable
  change-log.
- Optional future: an LFS-backed vector cache as an accelerator, fingerprint-gated.
  Not required now.

---

## P4 — Reliability + packaging hygiene

1. **Concurrent-writer hardening (Kùzu).** Embedded writes intermittently hit
   `[LoreGraph:upsertNode] Failed to upsert node` (~1/3 of large runs; a different node
   each time — background outbox/audit writers contending). Groundfloor Atlas masks it with bounded
   retry (4 attempts → 10/10 clean), but it should be fixed at the source.
2. **Vendor the kuzu-lite native binary.** `@kineviz/kuzu-lite`'s `scripts.install`
   fetches `kuzujs.node` from GitHub raw + an Alibaba OSS CDN at install time. The Groundfloor Atlas
   bundle already deletes that script and ships the `.node`; a durable fix is to vendor
   `kuzujs-<platform>-<arch>.node` upstream and no-op the install script (kills the
   supply-chain dependency for everyone).
3. **Stray self-symlink artifact.** Lore's `node_modules/node_modules -> .` self-link
   (and the `groundfloor-ts-sdk` file-link) created an infinite-loop that crashed Groundfloor Atlas's
   bundle deref-copy. Confirm Lore's install doesn't produce the self-symlink.

---

## Already resolved — thank you (verify only)

- **Workspace isolation** ("App2 can't read App1's data") — recent Lore commits route
  every workspace-taking op to the requested workspace + wired cross-workspace isolation
  tests. This closes the open question Groundfloor Atlas had. No further ask; Groundfloor Atlas will verify.

---

## Priority summary

| # | Item | Unblocks | Effort |
|---|------|----------|--------|
| P1 | Lazy-load ingestion + local/cloud build profiles | size cut + local/cloud split + offline | L |
| P2 | In-process recall/search + embedded embedding writes | Groundfloor Atlas memory bank + contradiction gate | M–L |
| P3 | Ship/pin the local model | offline semantic recall | S–M |
| P4 | Concurrent-writer fix + vendor kuzu-lite + symlink | reliability + clean installs | M |

**The keystone is P1+P2:** together they make a *small, offline, memory-capable* local
Lore — which is exactly what Groundfloor Atlas needs to ship as a standalone product.

---

# Engineer-ready prompt — two bundle-size fixes (2026-06-20)

> Hand this section to the Lore engineer (or a Claude session on the Lore repo). It
> is self-contained. Both fixes target the EMBEDDED/local path only and remove no
> feature Groundfloor Atlas uses. Combined expected impact: embedded Groundfloor Atlas bundle ~927 MB → ~500 MB.

## Context (plain English)

Groundfloor Atlas bundles Lore *inside itself* as a local library so a user installs one app with
no separate database — Lore runs in-process (kuzu + lancedb + sqlite) and is invisible.
Today that bundle is ~927 MB, and two things bloat it unnecessarily. Groundfloor Atlas only uses
Lore's graph + vector memory; it never processes documents/images. These two changes
cut the bundle ~half WITHOUT removing any feature Groundfloor Atlas uses. Don't break cloud mode or
document ingestion — just stop loading heavy things that aren't needed on the embedded
code/memory path.

## Fix 1 — Don't load the image libraries until an image is actually processed

**Plain English:** On embedded startup Lore immediately loads two heavy image libraries
— `sharp` and `@napi-rs/canvas` — even though nothing has asked it to process an image.
Because they load at startup, Groundfloor Atlas can't drop them: deleting them crashes Lore on boot
("Could not load the sharp module"). If Lore loaded them only the first time an image is
genuinely processed (the load-on-demand pattern the document extractors already use),
Groundfloor Atlas could remove them and save ~40 MB.

**Technical:**
- A prior pass moved the document EXTRACTORS (exceljs/mammoth/mailparser/pdfjs/tesseract)
  to dynamic import — good. But `sharp` + `@napi-rs/canvas` are still `require`d eagerly
  on the `createLore({ deploymentMode:'embedded' })` init path (verified: pruning `@img`
  from the embedded bundle crashes at `sharp/lib/sharp.js`).
- Find the static import of sharp + canvas reachable from embedded init; convert to a
  lazy `await import(...)` inside the image code path only.
- Move them to optionalDependencies (like the extractors) so Groundfloor Atlas can `--no-optional`.

**Verify:** with `sharp` + `@napi-rs/canvas` removed from node_modules, embedded
`createLore()` boots, indexes code, and does store + recall — no crash.

**Status (verified 2026-06-21): extractor side DONE ✅; sharp still blocked, but not by
the extractor.** fd08af7 made `buildDefaultRegistry()` synchronous with lazy STUB
extractors — the image/pdf modules (and `@napi-rs/canvas`) now load only when
`extract()` is actually called. Groundfloor Atlas verified this lets it prune **`@napi-rs/canvas`
(~25 MB)**: the bundle boots offline and does store+recall with canvas removed.

BUT `sharp` (`@img`) still can NOT be pruned — and the cause is **not** the extractor.
`sharp` is a dependency of **`@huggingface/transformers`** (the embedding library),
which loads at embedded boot when the local embedder initializes. So sharp loads
whenever Groundfloor Atlas embeds, regardless of the now-lazy image extractor; pruning `@img`
crashes serve at `sharp.js`. **New ask (lower priority, partly upstream):** to drop
sharp the embedding path must stop pulling it — e.g. transformers lazy-loading sharp
(upstream HF), or Lore offering a sharp-free embedding/onnx path. ~16 MB at stake; not
worth a risky change now.

Fix 2 (quantized model) is fully landed and verified — Groundfloor Atlas ships
model_quantized.onnx (~113 MB) and does store + recall fully offline.

## Fix 2 — Ship the SMALL (quantized) local embedding model (biggest lever)

**Plain English:** Offline memory needs a small AI model to turn text into "meaning
fingerprints" for search. The local model is `multilingual-e5-small`. Problem: Lore
downloads the FULL full-precision version — a single 470 MB file. There's a compressed
("quantized") version of the *same* model that is ~30–120 MB with essentially the same
search quality. Switching keeps memory fully working + offline but shrinks the model
~4–10×. Single biggest size win.

**Technical:**
- `packages/lore/src/providers/localEmbeddingProvider.ts` uses
  `DEFAULT_LOCAL_MODEL_ID = 'Xenova/multilingual-e5-small'` and currently loads the fp32
  `onnx/model.onnx` (~470 MB).
- Configure the feature-extraction pipeline to load a quantized ONNX variant (in
  @huggingface/transformers v4 this is the `dtype` option — e.g. `dtype:'q8'` or `'fp16'`;
  the Xenova repo publishes `model_quantized.onnx` / `model_fp16.onnx`). Pick the
  smallest variant that keeps recall quality acceptable.
- Dimension MUST stay 384 (`DEFAULT_LOCAL_MODEL_DIM` unaffected).
- Add precision/variant to the exposed model fingerprint (`modelId` + `dimension`) so a
  device never mixes vectors made at different precisions.

**Verify:** fresh embedded store with the quantized model → store + recall returns the
right hits; downloaded model ≤ ~120 MB (not 470 MB); 384-dim.

## Constraints
- Cloud mode (BGE-M3 via Dataplane / Zilliz·Qdrant) and document ingestion must keep
  working — these changes only affect the embedded/local path and *when* things load.
- No change to the public recall/search API Groundfloor Atlas calls.

## Deliverable
A PR with both fixes + verification notes. **Fix 2 first** (~350–440 MB) if time-boxed;
Fix 1 is the smaller ~40 MB. Note: quantizing changes fingerprints slightly (fp32 vs q8
are near-identical, not bit-identical) — fine for new local stores; existing fp32 stores
want a one-time re-embed, which the fingerprint change makes safe/automatic.

---

## A6 (CORRECTED 2026-06-21) — bulk upsert for fast first-index

**Context:** Lore shipped `nodeUpsertBatch()` + GPU `embedding.device`. We wired both into
Groundfloor Atlas behind a measuring gate. **Both regressed bulk indexing** on dayjs (180 files):

- `nodeUpsertBatch`: **137s + SIGABRT** vs serial 35s. It hardcodes `asyncEmbed:true` and
  fires a **detached per-node autolink** (`reconnectOneNode` → ONNX similarity search). The
  async embeds + N detached autolink calls contend on the single ONNX session and thrash;
  it also crashes when a transient Kùzu write conflict escapes (the serial path's `withRetry`
  is gone). Reverted to serial.
- GPU `device:'auto'`/`'coreml'`: 100s / 69s vs **cpu 35s**. CoreML/WebGPU overhead dwarfs
  compute on the 384-dim e5-small model. We default to CPU now.

**The actual ask** — a bulk-ingest path tuned for code indexing that:
1. **Skips autolink** (or makes it opt-in). Autolink is a knowledge-graph nicety; for bulk
   code/context ingestion it's pure overhead (a similarity search per node).
2. **Embeds synchronously in batches** via `embedDocumentBatch()` (the real 3-5× win)
   **without** the outbox/`asyncEmbed` round-trip — so the caller can rely on embeddings
   being persisted when the call returns (no drain-race, no SIGABRT).
3. Keeps `withRetry`-style tolerance for transient single-writer graph conflicts.

Effectively: expose the existing internal `bulkLoader`/`embedDocumentBatch` path (CSV/Arrow
batch + one batched embed) on the embedded facade, instead of `nodeUpsertBatch`'s
per-node-async-autolink shape.
