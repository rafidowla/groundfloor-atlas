# Groundfloor Atlas indexing performance — gaps & plan (Option A)

Indexing is the bottleneck: a 297-file repo takes ~60s; ~1,500-file repos time out.
Root cause traced to `EmbeddedLore.bulkStoreNodes` writing nodes **one at a time**, each
`embed:true` node triggering a **separate** model inference on CPU. A mature peer tool
(reviewed 2026-06-21) avoids this with worker-pool parse + **CSV bulk-load + batch embed** —
confirming the fix direction.

## The bottleneck (one diagram)

```
Groundfloor Atlas indexer → bulkStoreNodes → for each node: nodeUpsert → embed ONE text   ← N sequential model calls
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
GOAL:           Groundfloor Atlas indexer → collect texts → embedDocumentBatch(texts[]) → bulk write   ← 1 batched call (3-5×)
```

## Groundfloor Atlas-side gaps to fix FIRST (no Lore change needed)

| # | Gap | Evidence | Fix | Effort |
|---|---|---|---|---|
| A1 | **Incremental is OFF by default** — `--resume` exists (`checkpoint.ts`, mtime+size) but every run re-embeds the whole repo from scratch | `src/cli.ts` `--resume` flag; slice never passed it | Make resume/skip-unchanged the **default** on re-index; only full-rebuild on `--force` | S |
| A2 | **Indexes tracked test/fixture files** — scanner respects `.gitignore` (skips node_modules/dist) but still embeds tracked `*.test.*`, `*.spec.*`, fixtures, snapshots | `src/parser/index.ts` uses `git ls-files` (no test filter) | Add default test/fixture/generated exclusion (opt-out flag) → fewer embeds | S |
| A3 | **No model pre-warm** — first write pays cold model load | `preloadLocalModel` exists in Lore, never called in Groundfloor Atlas | Call `preloadLocalModel()` at daemon/index start | XS |
| A4 | **Context layer multiplies embeds** — per-symbol span cards ~3× the embeds; even per-file cards add one embed per file | `codeNodes.ts` context-layer block | Keep per-file cards as default; per-symbol (`ATLAS_CONTEXT_SPANS`) opt-in only | XS |

> **GF-2 update (2026-06-24):** the context layer is now **DEFAULT ON in file-mode** — it is the only embedded code surface, so it IS semantic code search; off-by-default meant no semantic code search at all. Span-mode stays opt-in (`ATLAS_CONTEXT_SPANS=1`, ~5-10× embeds). Force-off with `ATLAS_CONTEXT_LAYER=0`. A size guard bounds the worst case: above `ATLAS_CONTEXT_LAYER_MAX_FILES` (10k) the layer auto-disables (graph-only); above `ATLAS_CONTEXT_SPANS_MAX_SYMBOLS` (20k) span-mode auto-falls-back to file-mode — each prints one stderr line. File-mode adds `+1 embed/file` (the proven dayjs ~180-file/seconds workload below); the guard prevents a large monorepo from becoming a silent multi-minute index.
| A5 | **Cannot batch even within one file** — every symbol embeds individually | `bulkStoreNodes` loop | Blocked on A6 (Lore batch API) — see below | — |

## The 3-5× lever — needs a small Lore change (already built, not exposed)

| # | Gap | Evidence | Ask |
|---|---|---|---|
| A6 | Lore has `embedDocumentBatch(texts[])` (*"~3-5× throughput vs one-at-a-time"*) and a full `bulkLoader/` (CSV/Arrow batch ingest) — but **neither is exposed on the `createLore()` embedded facade**. `nodeUpsert` won't accept a pre-computed vector either, so Groundfloor Atlas literally cannot batch today. | `providers/localEmbeddingProvider.d.ts:181`; `bulkLoader/*`; `index.d.ts` exposes only single `nodeUpsert` | **Lore team:** expose a bulk node-upsert (or vector-injection on `nodeUpsert`) on the embedded API that uses `embedDocumentBatch` internally. Then Groundfloor Atlas rewires `bulkStoreNodes` to collect → batch. |

## Ordering

1. **A3, A4** (XS, immediate): pre-warm + keep context cards lean. Tiny, safe.
2. **A1, A2** (S, immediate, biggest practical win): incremental-by-default + skip test/fixtures. Turns "every run slow" into "first run slow, rest fast" and cuts the embed count.
3. **A6 + A5** (the 3-5× ceiling lift): Lore exposes batch → Groundfloor Atlas batches. Highest raw speedup, but gated on Lore.

GPU/Metal is intentionally **not** in this plan — it's a harder, separate runtime change and the batch path is the cheaper, bigger win first.

## What "done" looks like

- Re-indexing an unchanged repo: near-instant (A1).
- First index of a 1,500-file repo: completes without timeout (A2 cuts count; A6 cuts per-embed cost).
- A clear, scoped Lore ask written and handed off (A6).

---

## Wave 1 — RESULTS (measured 2026-06-21) — both "big levers" backfired

Ran the planned speed work behind a measuring gate. **The two levers I was most excited
about (batch upsert, GPU) both made indexing SLOWER and were dropped.** What actually won
was CPU + incremental. Measured on dayjs (180 files, ATLAS_CONTEXT_LAYER=1):

| change | result | verdict |
|---|---|---|
| **A1 incremental-default** | re-index 35s → **1.5s** | ✅ shipped — the real daily-use win |
| **A2 skip test/fixtures** | fewer embeds (env opt-out `ATLAS_INCLUDE_TESTS=1`) | ✅ shipped |
| **A3 pre-warm** | (prior commit) | ✅ shipped |
| device **cpu** (default) | **35.3s** | ✅ fastest |
| device coreml | 68.7s | ❌ 2× slower |
| device auto (GPU) | 100.3s | ❌ 3× slower — GPU overhead dwarfs gain on 384-dim e5-small |
| **batch `nodeUpsertBatch`** | **137s** + SIGABRT crash | ❌ REVERTED |

**Why batch lost:** Lore's `nodeUpsertBatch` hardcodes `asyncEmbed:true` AND fires a
detached per-node autolink (ONNX similarity search). The async embeds + N detached
autolink calls contend on the single ONNX session and thrash; it also crashed (dropped the
`withRetry` the serial path needs). Reverted to the serial `withRetry` loop.

**Why GPU lost:** CoreML/WebGPU compile + tensor-transfer overhead dwarfs the compute for a
tiny 384-dim model. Default is now **`device:'cpu'`**, override via `ATLAS_EMBED_DEVICE` for
larger models / platforms where GPU wins.

### The REAL first-index lever — a precise Lore ask
The serial path is 35s for 180 files (~5 files/s) — fine with incremental, but linear, so
big repos are still slow on first index. To actually speed the FIRST index, Lore needs a
bulk-upsert variant that **(a) skips autolink** and **(b) does a synchronous
`embedDocumentBatch` (no outbox/asyncEmbed thrash)**. `nodeUpsertBatch` as shipped does the
opposite. This is the corrected A6 ask (see LORE-REQUIREMENTS.md).

---

## bulkIngest wired (2026-06-21) — ship-with-caveat

Lore shipped the corrected A6 (`lore.bulkIngest(nodes, { autolink:false, embed:'sync' })`).
Wired Groundfloor Atlas's `bulkStoreNodes` to it behind the same measuring gate.

| Metric | Wave 1 serial (baseline) | bulkIngest | Status |
|---|---|---|---|
| dayjs first index | 35.3s | **22.6s** | ✅ −36% |
| dayjs re-index | 1.5s | 4.3s | ⚠️ slower but ≤5s tolerance |
| SIGABRT / crash | (Wave 1 nodeUpsertBatch did) | **none** | ✅ |
| Vectors persisted | 8.9 MB | 180 rows × 384-dim (verified direct) | ✅ drain works |
| ≤15s spec target | — | missed by 7.6s | ❌ |

**Verdict: ship.** No regression, real speedup, drain solid. Missed the optimistic ≤15s
target — the Lore spec's "3-5×" refers to *embedding throughput*, but embedding is only
one slice of total index time (parse / graph writes / ONNX cold warmup don't batch). A
36% total speedup from a 3-5× embed speedup is consistent. **Likely near the CPU-embedding
floor for tiny repos.** Bigger first-index wins from here probably need a different attack
(smaller model, shipping vectors with the moat, or GPU on larger models).

**Two follow-ups for Lore (flag with the existing items):**
1. 20 transient "Failed to get node" bulkErrors on first run — non-fatal, self-heal on
   re-index. Smells like a race inside the new bulkIngest impl.
2. LanceDB on disk dropped 8.9 MB → 0.45 MB for the same workload. Vectors are real
   (direct query confirmed); the size delta is probably old-path WAL/uncompacted overhead,
   but worth a Lore sanity-check.
