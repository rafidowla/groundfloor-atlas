# Lore ask — `recall` over-fetch / max cap

**TL;DR:** Groundfloor Atlas wired type-priority re-ranking (curated knowledge > code_context) using an
over-fetch + re-rank + slice pattern. `knowledge_search` (semantic + hybrid) now correctly
surfaces decisions ahead of auto-generated code context. `knowledge_recall` does NOT —
Lore's `inProcessRecall` appears to return at most ~10 hits regardless of the `max`
parameter, which means Groundfloor Atlas cannot over-fetch enough candidates to re-rank effectively.

---

## Reproduction

State: Groundfloor Atlas workspace with mixed content — 2 curated knowledge nodes (one decision, one
convention) and 180+ auto-generated `code_context` nodes (one per code file in dayjs).

```
ATLAS_HOME=$HOME/.atlas-lockin-B atlas serve &
# probe: knowledge_recall with topic that semantically matches the decision but has
# zero shared keywords with it
node -e "<MCP call to atlas_tool_invoke → knowledge_recall>" \
  --topic "how to handle flaky downstream APIs" \
  --workspace dayjs-lockin
```

Observed:
- The decision stored is "Use exponential backoff with jitter to avoid thundering-herd
  retry storms" — no shared keywords with the query.
- Result: `{ totalRecalled: 24, shown: 10 }`. Top 10 = [convention, 9× code_context].
  Decision (`lockin-dec-001`) NOT in the top 10.
- Groundfloor Atlas requested `max: 50` internally (the over-fetch). Lore returned 10.
- The same query via `knowledge_search { search_mode: 'hybrid', limit: 25 }` returns
  `lockin-dec-001` at rank 2 — so the vector IS semantically matched; recall just doesn't
  surface it within whatever cap is applied.

## What the cap appears to be

Some upper bound (~10 by default) in `inProcessRecall` is taking effect before Groundfloor Atlas's
`max` argument can request a wider pool. Either the input `max` is being clamped silently,
or there's a separate "shown" cap defaulting to 10 before client-side max is honored.

## Ask

Make `inProcessRecall`'s candidate pool size **configurable from the caller via an
explicit option** (e.g. `max` or a new `candidatePool` option), allowing Groundfloor Atlas to over-fetch
~50–100 candidates and apply its own re-ranking before truncating to the user-requested
limit. Concretely:

```ts
// today (effective behavior):
recall(topic, { max: 50 })  // → up to ~10 hits returned

// asked:
recall(topic, { max: 50 })  // → up to 50 candidates so caller can re-rank + slice
```

Equivalently if it's cleaner: split "candidate pool size" from "shown count" so callers
can request `{ candidatePool: 50, shown: 10 }`.

## Why this matters

Lore's documented [Lore Intelligence Protocol](https://...) says clients should call
`recall()` at conversation start for "auto-consult". When a workspace mixes auto-generated
code context with a small number of curated decisions, the curated decisions are
drowned. Groundfloor Atlas can solve this with type re-ranking IF given access to enough candidates;
without it, the auto-consult flow surfaces noise instead of signal.

## Acceptance

After the fix, the reproduction above (with Groundfloor Atlas's over-fetch of `max:50`) returns
≥50 candidates from `inProcessRecall`. Groundfloor Atlas's existing `reRankByType` then surfaces the
decision in the user-facing top 5 of the response.

## What Groundfloor Atlas is shipping in parallel

`knowledge_search` with `search_mode: 'semantic'` or `'hybrid'` already works correctly
with over-fetch + re-rank (committed; rank 2 in top 5 for the test query). So agents that
use search instead of recall are unblocked today.

## Adjacent context — Groundfloor Atlas-side commit ahead of this ask

`src/lore/embeddedLore.ts` now does over-fetch (`min(userLimit × 5, 100)`) + `reRankByType`
+ slice in both `recall()` and `search()`. The change is correct and useful in both
paths; it just happens to be insufficient in the `recall()` path until Lore exposes a
larger candidate pool.
