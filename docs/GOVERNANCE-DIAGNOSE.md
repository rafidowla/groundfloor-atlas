# Governance Diagnose — schema_drift / layer_violations / hotspots

**Date:** 2026-06-22
**Scope:** Diagnose-only audit of Groundfloor Atlas's three "governance" analytics tools against real codebases (vuejs `w2-ix__18eac778-wf`, dayjs-comm). No implementation changes.

Tool surface lives at `src/server/tools/allTools.ts:117-174`; each tool dispatches into `src/analytics/*.ts`.

---

## 1. `atlas_schema_drift` — SHIPS

**State:** Real implementation in `src/analytics/schemaDrift.ts` (443 lines). Parses SQL `CREATE TABLE`, Prisma `model`, and GraphQL `type` definitions. Produces column-level diffs and a human-readable summary string.

**What works:**
- Three-format parser (SQL / Prisma / GraphQL) is genuine, not a stub.
- Column-level adds/removes detected and reported.
- Summary string is sane and ready for UI rendering.

**What's missing / broken:**
1. **No CLI subcommand.** README treats schema-drift as a headline feature, but `src/cli.ts` has no `atlas schema-drift` entrypoint. MCP/UI only.
2. **UI mis-routes the query.** `atlas-ui/src/hooks/useQueryRouter.ts:41-47` sends "schema drift"-shaped queries to `knowledge_search` instead of `atlas_schema_drift`. **One-line fix.**
3. **No `ALTER TABLE` / migration parsing.** Real Prisma and Rails shops accumulate drift through migrations, not by rewriting `CREATE TABLE`. Current parser sees a static snapshot and misses the actual drift signal.
4. **`workspace` param is dead-code.** Documented as cross-referencing indexed `CodeSymbol` entries; the cross-reference path is empty.
5. **No column-type diff.** Adds and removes are detected; `VARCHAR(255) → TEXT` or `Int → BigInt` changes pass through silently.

**Recommended follow-ups (priority order):**
1. Fix `useQueryRouter.ts:41-47` mis-route (one-liner, unblocks the UI demo).
2. Add `atlas schema-drift <a> <b>` CLI subcommand.
3. Parse `ALTER TABLE` and Prisma migration files; fold into the diff.
4. Add column-type diff alongside add/remove.
5. Either wire up the `workspace` cross-reference to `CodeSymbol` or remove the param.

---

## 2. `atlas_layer_violations` — HOLLOW

**State:** Algorithm is real (`src/analytics/layerViolations.ts`, 132 lines): glob-based layer assignment, edge-kind filtering, clean output shape. But `defaultLoreLayerSpec` (`layerViolations.ts:75-90`) is **hardcoded for Lore's own directory layout**. On vuejs with the default spec: returns `[]`. With a hand-rolled Vue-shaped spec: 106 violations.

**What works:**
- Core algorithm (assign-file-to-layer, walk-edges, filter-by-direction) is correct.
- Output shape is clean and groupable.
- Custom-spec path proves the engine is sound — 106 violations on vuejs is a real signal.

**What's missing / broken:**
1. **Silent no-op on every non-Lore repo.** Default spec only matches Lore's directories, so any other workspace returns `[]` and the tool looks broken.
2. **No per-workspace persistent `LayerSpec`.** No `.atlas/layers.yml`, no Lore-stored spec node, no way to register a spec without editing source.
3. **No `LayerSpec` inference.** Most teams have no written architectural boundaries. An "Groundfloor Atlas guesses your layers from imports and directory structure" pass would 10x the tool's value.
4. **No output grouping.** 106 raw rows is unreadable. Want `"56 compiler→reactivity edges (sample: ...)"`.
5. **No CLI subcommand.**
6. **UI passes no spec.** Calls the tool with defaults, gets `[]`, shows nothing.

**Recommended follow-ups (priority order):**
1. Per-workspace `.atlas/layers.yml` (or Lore-stored `LayerSpec` node) — unblocks every non-Lore repo.
2. `LayerSpec` inference pass (cluster directories, propose layers, show user for confirmation).
3. Output grouping by `(source_layer → target_layer)` with sample edges.
4. CLI subcommand `atlas layer-violations`.
5. UI: read the spec from `.atlas/layers.yml` or Lore and pass it in.

---

## 3. `atlas_hotspots` — SHIPS (best of three)

**State:** Top-10 on vuejs immediately surfaces `baseCreateRenderer` (complexity 282), `Tokenizer` (216), `compileScript` (153), `createHydrationFunctions` (99) — Vue's actually-hairy code. Real signal even without churn data.

**What works:**
- Complexity scoring is calibrated; the top results are correct.
- No false positives in the head of the distribution on vuejs.
- Output is directly usable as-is.

**What's missing / broken:**
1. **Churn is conditional on local git checkout.** Groundfloor Atlas's main use case is indexing arbitrary code into Lore — no git tree → score collapses to complexity-only. Tool name ("hotspots") implies churn × complexity and oversells.
2. **No per-FILE aggregation.** A single hairy file with 12 hairy methods occupies 12 of the top-50 slots, crowding out other files.
3. **No diff-against-history.** "Complexity went up 40% on this file in the last 30 days" would be the real "prevent wrong code from being merged" hook. Currently a static snapshot.
4. **No CLI subcommand.**

**Recommended follow-ups (priority order):**
1. Per-file aggregation (roll method scores up to a file score; offer drill-down).
2. Persist historical complexity snapshots; surface trend deltas.
3. CLI subcommand `atlas hotspots`.
4. When no git tree is present, either pull churn from Lore's indexed history or rename the tool / clarify the output to set expectations.

---

## Cross-cutting

- **No CLI surface for any of the three.** Groundfloor Atlas's README treats all three as headline features, but `src/cli.ts` exposes none of them. Anyone following the README from the terminal hits a wall.
- **UI routing bug (`useQueryRouter.ts:41-47`).** Schema-drift queries land in `knowledge_search`. One-line fix; should ship standalone.
- **`layer_violations` default config is repo-specific.** Hardcoded for Lore's directory layout means the tool is a silent no-op on every other workspace — the worst failure mode (no error, no result, no signal that anything is wrong).
- **Pattern:** all three tools have correct cores and weak edges (config, CLI, UI integration, history). The algorithms work; the delivery layer doesn't.

---

## Appendix — Next Waves

- **Wave G1: `LayerSpec` config + inference (~1 session).** Add `.atlas/layers.yml` loader, Lore-stored `LayerSpec` node, and a directory/import-clustering inference pass. Removes the silent-no-op failure mode and makes `layer_violations` useful on any repo.
- **Wave G2: CLI surface for all three tools (~half session).** Add `atlas schema-drift`, `atlas layer-violations`, `atlas hotspots` subcommands in `src/cli.ts`. Mechanical; unblocks every README path that currently dead-ends. Bundle the `useQueryRouter.ts:41-47` one-line UI fix into the same wave.
- **Wave G3: `ALTER TABLE` / migration parsing for `schema_drift` (~half session).** Extend `src/analytics/schemaDrift.ts` to consume Prisma migration directories and SQL `ALTER` statements. Closes the largest real-world gap in the parser.
- **Wave G4 (stretch): Hotspot history & per-file aggregation (~1 session).** Persist complexity snapshots, expose trend deltas, roll methods up to file scores. Turns `hotspots` from "static lint" into "prevent-the-merge" signal.
