# Lore ask — bulk-ingest mode

**One-line summary:** Today Lore is tuned for *trickle ingest* (a human storing one
node at a time). When the caller is loading a batch — Groundfloor Atlas indexing a repo, a teammate
importing a `memory.jsonl`, a migration tool moving data — the trickle-optimized path
is actively wrong. Add a sibling **bulk-ingest** mode that fixes the two specific
behaviors that make trickle bad-at-bulk.

---

## The problem (with evidence)

Groundfloor Atlas wired the existing `lore.nodeUpsertBatch()` for code/context indexing behind a
measuring gate. **It made indexing 4× slower** (dayjs 180 files: 35s serial → 137s batch)
and crashed (SIGABRT). Root cause traced to two trickle-correct defaults that bulk
callers cannot opt out of:

1. **Hardcoded `asyncEmbed: true`** — the call returns before embeddings are persisted.
   The caller has to manually drain (via `dispose()` or hope), which races with
   `process.exit()` and detached background work. We observed the process aborting
   before drain completed → LanceDB stayed empty (0B).
2. **Detached per-node autolink** — every upsert fires `reconnectOneNode`, an extra
   ONNX similarity search per node. On 180 nodes that's 180 detached searches
   contending on the single ONNX session and thrashing.

Both behaviors are *correct* for trickle ingest (snappy UX for the human; graph stays
connected as knowledge accumulates). Both are *actively wrong* when the caller is
loading a known batch.

Groundfloor Atlas also reverted GPU (`device: 'auto'`) — measured 3× slower than CPU on the 384-dim
e5-small model. That's a separate, smaller item; not part of this ask.

---

## The ask — `lore.bulkIngest()`

Add a new method on `LoreInstance`. Keep `nodeUpsertBatch` and `nodeUpsert` unchanged.

```ts
interface BulkIngestOpts {
  /**
   * Run ingest-time autolink (similarity search → semantic_neighbor edges) per node.
   * Default: false (the right default for bulk: caller already knows the structure).
   * Trickle's nodeUpsert/nodeUpsertBatch keep their existing behavior unchanged.
   */
  autolink?: boolean;

  /**
   * Embed mode. Default: 'sync' — when the promise resolves, embeddings ARE persisted
   * to LanceDB. No drain race. Use 'async' if the caller genuinely wants fire-and-forget.
   */
  embed?: 'sync' | 'async';

  /**
   * Embed batch size. Default: 64 (or whatever embedDocumentBatch tunes to).
   * Caller may bump for larger memory budgets.
   */
  embedBatchSize?: number;
}

interface BulkIngestResult {
  ok: boolean;             // true iff every node succeeded
  count: number;           // input length
  succeeded: number;
  results: Array<{ ok: true; id: string } | { ok: false; id: string; error: string }>;
}

lore.bulkIngest(
  nodes: Array<NodeUpsertArgs>,   // same shape nodeUpsertBatch takes today
  opts?: BulkIngestOpts,
): Promise<BulkIngestResult>;
```

### Contract — what the caller can rely on

1. **When the returned promise resolves, embeddings are persisted** (in `sync` mode).
   No `dispose()` race. No "did it actually land?" check.
2. **Autolink is OFF by default.** Caller opts in if they want it.
3. **One batched embed call internally** (via the existing `embedDocumentBatch`) — not
   N serial single-embeds. This is the 3-5× win your own provider docstring advertises.
4. **Graph writes retry transient single-writer Kùzu conflicts** (the same intermittent
   failure that `withRetry` wraps in single-node paths). One uncaught Kùzu conflict
   must not abort the whole batch.
5. **Per-node error isolation** — a failed node returns `{ ok: false, id, error }`; it
   does not throw the whole call. The caller decides how to handle partial failures.
6. **`skipEmbed: true` per-node is still honored** (graph-only nodes — e.g. Groundfloor Atlas's
   `code_file` / `code_symbol` — write as graph rows with no LanceDB row, just like today).

### What's already in Lore that should be reused

The pieces are mostly built; this ask is about *exposing and composing* them correctly:

- `providers/localEmbeddingProvider.ts → embedDocumentBatch(texts[])` — the 3-5×
  batched embed your own comment advertises.
- `bulkLoader/lanceAdapter.ts` — batched LanceDB writes (5,000 rows/batch).
- `bulkLoader/kuzuAdapter.ts` — batched Kùzu writes with fall-back-to-MERGE.
- `core/nodeService.ts → nodeUpsert` — the inner write logic; the `autolink` hook is
  already gated; just need to expose the gate to the caller.

So this is plumbing work (a new facade method that wires these internals together
without going through the outbox/autolink path), not new substrate code.

---

## Out of scope (deliberately)

- Don't change `nodeUpsert` or `nodeUpsertBatch` — they're trickle-correct.
- Don't add cross-node deduplication semantics; treat nodes as independent.
- Don't add transaction-across-nodes; per-node success/failure is fine.
- GPU/Metal device selection — separate, smaller item.

## Acceptance criteria

These are testable against the Groundfloor Atlas reproduction:

1. **No regression on trickle paths.** Existing `nodeUpsert` / `nodeUpsertBatch` /
   `knowledge_store` behavior unchanged.
2. **Groundfloor Atlas dayjs indexing.** Groundfloor Atlas swaps its serial `withRetry` loop for `bulkIngest`
   with `{ autolink: false, embed: 'sync' }`. On the same 180-file repo, total
   wall-clock should drop from the current 35s to **≤ 15s** (target — the 3-5× embed
   batching, plus removing the autolink overhead).
3. **No SIGABRT.** Returned promise's resolution implies embeddings persisted; no
   detached work outliving `dispose()` / `process.exit()`.
4. **LanceDB populated.** After the call resolves on a 180-node batch, LanceDB on
   disk reflects all 180 vectors (no 0B empty-state).
5. **Partial failure surfaced.** Injecting a deliberate per-node error returns
   `ok: false` for that node in `results[]` and `ok: false` overall, but does not
   throw or abort the batch.
6. **Same call type-checks from the embedded facade.** `import { createLore } from '@groundfloor/lore'` → `(await createLore(...)).bulkIngest(...)` must type-check.

---

## Why this is general, not Groundfloor Atlas-specific

Bulk-ingest hits any caller doing structured import — not just Groundfloor Atlas's code indexing.
Three known callers today:

| Caller | Why bulk hurts vs trickle |
|---|---|
| **Groundfloor Atlas indexing code** | 180+ nodes per repo; autolink + async drain regress 4× |
| **Groundfloor Atlas `memory import`** (just shipped) | Teammate importing N decisions: autolink reruns links the source already computed |
| **Future migration/restore tools** | Moving data between Lore instances |
| Any third-party app doing structured import (ADR archives, glossaries, wiki dumps) | Same |

A human typing one decision via `knowledge_store` is *unaffected* — trickle stays the
default.

---

## Two smaller, related Lore items (not this PR — flagging only)

1. **`knowledge_search` returns `[]`** for embedded `code_context` nodes that
   `knowledge_recall` finds (35 hits on the same data). Recall works; search doesn't.
   Substrate-routing bug.
2. **Daemon mid-life embed-flush guarantee** — `dispose()` drains for short-lived CLI
   processes; the long-running daemon path's mid-life flush story isn't documented
   or tested. Groundfloor Atlas needs a way to know "all queued embeds are settled" between
   ingest bursts (e.g., before serving a query that depends on freshly-indexed data).
