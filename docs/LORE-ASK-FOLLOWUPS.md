# Lore follow-up asks (after bulkIngest landed)

**Status of the four items Groundfloor Atlas flagged this session:**

| # | Item | Status |
|---|---|---|
| 1 | `knowledge_search` returns `[]` for embedded nodes | ✅ Lore identified — `search_mode` param declared but never destructured/used in `searchTool.ts`; handler always falls through to Kùzu CONTAINS keyword. Fix in progress. |
| 2 | Daemon mid-life embed-flush guarantee | ✅ Lore identified — `EmbedQueue.drained()` exists but isn't surfaced on `LoreInstance`. Expose-it-on-the-facade fix in progress. |
| 3 | Transient first-run bulkIngest race | ⬜ **This document** |
| 4 | LanceDB on-disk size sanity check | ⬜ **This document** |

Items 1 & 2 already on Lore's plate — thank you. This doc spec's the two new ones the
`bulkIngest` wire-up surfaced, plus one future product ask flagged at the end (not a bug,
not blocking — included so it's not lost).

---

## Item 3 — Transient "Failed to get node" errors on first bulkIngest

### Observed

On the very first `lore.bulkIngest(nodes, { autolink: false, embed: 'sync' })` call against
a freshly-opened embedded Lore (180 dayjs nodes, `embed: 'sync'`), the per-node `results[]`
came back with **20 errors of the form**:

```
Failed to get node 'code-file:src/...' / 'code-symbol:...'
```

Key properties:

- **Non-fatal** — overall `ok: false` but the batch completes; no SIGABRT, no abort.
- **Self-healing** — the errored nodes succeed cleanly when re-indexed in the next pass.
  Groundfloor Atlas's incremental indexing surfaces them as the 20 files that "needed re-index" the
  second time even though their content didn't change.
- **Reproducible on cold start.** First `bulkIngest` against a brand-new dataDir: ~10–11%
  of the batch fails. Subsequent batches: 0 errors.
- **No correlation** with file size, language, or path — different 20 nodes each cold run.

### Hypothesis

Looks like a race inside the bulkIngest implementation between:

- The Kùzu graph upsert that registers the node, and
- A subsequent read (most likely from the autolink path or from version-store
  `previousState` lookup, both of which call `targetGraph.getNode(args.id)`)

…where the read happens before the write commits. Cold start probably has a tighter window
because the WAL is empty / there's no prior contention masking the timing.

Notably, Groundfloor Atlas passes `autolink: false` and `embed: 'sync'`, so this should NOT be the
autolink path. More likely the `previousState` read for the version-store update — that
runs for every upsert regardless of options.

### Reproduce (cold-path, ~30 seconds)

```bash
cd <atlas-repo>
rm -rf $HOME/.atlas-demo/lore-data/repro /tmp/dayjs/src/.atlas
pkill -f "cli.js serve" 2>/dev/null
git clone --depth 1 https://github.com/iamkun/dayjs.git /tmp/dayjs 2>/dev/null
ATLAS_CONTEXT_LAYER=1 ATLAS_HOME=$HOME/.atlas-demo \
  ./bin/atlas index /tmp/dayjs/src -r -w repro 2>&1 | tail -50
# Look for: "ok":false in the per-batch results + ~20 "Failed to get node" errors.
```

### Ask

Investigate the read-before-write race in `bulkIngest`. Two acceptable fixes:

1. **Retry the get inside `bulkIngest`** (mirror the `withRetry` pattern Groundfloor Atlas wraps around
   every Lore call). Idempotent reads, bounded backoff. Cheap.
2. **Reorder writes-before-reads** within the bulk path — write all rows first, then run
   any post-write side-effects (version snapshot, etc.).

Either resolves it from Groundfloor Atlas's perspective; #2 is more principled if it's tractable.

### Acceptance

After the fix, the reproduction above shows `ok: true` for every node in the batch on the
**first** run, no "Failed to get node" errors, no need for a second-pass re-index to clear
them.

---

## Item 4 — LanceDB on-disk size dropped 20× for the same workload (sanity check, possibly benign)

### Observed

Same workload (dayjs, `ATLAS_CONTEXT_LAYER=1`, 180 file-level context cards embedded),
indexed via Groundfloor Atlas:

| Path | LanceDB on disk |
|---|---|
| Pre-bulkIngest (serial `withRetry` loop, single `nodeUpsert` per node) | **8.9 MB** |
| Post-bulkIngest (`lore.bulkIngest`, `autolink:false`, `embed:'sync'`) | **0.45 MB** |

Groundfloor Atlas verified by direct LanceDB query that the post-bulkIngest table contains 180 rows
with populated 384-dim `fixed_size_list:float` vectors — so **vectors are real**; this is
a footprint delta, not data loss.

### Hypothesis

Most likely **benign WAL/uncompacted overhead** in the old path that the new bulkIngest
path avoids — i.e. the serial path was accumulating fragments + version tombstones
between writes (each `nodeUpsert` → outbox → async embed → eventual compaction missed),
while bulkIngest writes one cleanly compacted batch. The 384-dim float math supports a
small footprint:

- 180 rows × 384 dims × 4 bytes ≈ 270 KB raw vectors
- Plus row metadata + index → ~450 KB is plausible

But it's a 20× delta on the SAME content, so a sanity-check by the team that knows the
storage internals is warranted before Groundfloor Atlas calls this resolved.

### Ask

Confirm one of:

- **Benign:** the old path left write-ahead/uncompacted state on disk that's not present
  in the new path; both end-states represent the same logical data. (Most likely; in
  which case: close as expected behavior, optionally document.)
- **Old path was over-storing:** confirm and link the relevant compaction/cleanup change.
- **New path is under-storing:** something the new bulkIngest path elides that the old
  one persisted (less likely given direct query confirms vectors + dims, but worth ruling
  out — e.g. is there per-row metadata or an aux index that's missing?).

### Acceptance

A one-line "expected: WAL/compaction artifact" answer from someone who owns the
LanceDB write path closes this. No code change needed unless the third bullet turns out
to be real.

---

## Future product ask (flagged only — NOT this PR)

### Allow pre-computed vectors in `bulkIngest`

For Groundfloor Atlas's git-sync moat (`.atlas/memory.jsonl` — text knowledge synced across machines;
vectors regenerate locally on import), this works fine today because memory is small
(under-a-second re-embed for typical team memory). It would NOT work for syncing
code-context vectors — those are large enough that re-embedding-on-clone is the slow
step we're trying to eliminate.

If a future moat extension ships *vectors* alongside text (so a fresh clone is instant,
not minutes), the path is:

```ts
lore.bulkIngest(
  nodes.map((n) => ({ ...n, embedding: precomputedVector })),  // ← caller supplies vector
  { autolink: false, embed: 'precomputed' },                   // ← new mode: skip the embed call
);
```

The constraint: vector dimensionality must match the configured model, and Lore should
validate or reject mismatches at the API boundary (not silently corrupt the table).

**Not asking for this now** — flag it so when Groundfloor Atlas comes back asking, the design isn't
a surprise.

---

## Summary

- **Bug 3** (transient cold-start race in bulkIngest) — please fix; reproduction provided.
- **Bug 4** (20× LanceDB footprint delta) — please sanity-check; likely benign.
- **Future product ask** (precomputed vectors in bulkIngest) — for context, not this PR.

Groundfloor Atlas's current state, for reference: `bulkIngest` is wired, ships, and gives a measured
36% first-index speedup with no crash and confirmed sync drain — strictly better than
the pre-bulkIngest serial path. The two bugs above are quality refinements, not blockers.
