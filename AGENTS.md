<!-- atlas-wire-begin -->
## Groundfloor Atlas — code intelligence + knowledge layer

This repo is wired to Groundfloor Atlas (workspace `groundfloor-atlas`). Groundfloor Atlas holds the code graph,
blast-radius, layer/coupling analysis, and the team knowledge graph. **Consult it —
don't fly blind:**

- **Before a broad code search**, use `atlas_subgraph` / `knowledge_recall` for a
  structural answer instead of grepping the whole tree.
- **Before changing a function or file**, run `atlas_blast_radius` on the symbol to see
  what will break (d1 = WILL BREAK). The pre-edit hook surfaces this automatically.
- **Before/after a schema change** (`*.sql`, `*.prisma`, `migrations/**`), run
  `atlas_schema_drift` and record the WHY with `schema_confirm` so DB churn stays minimal.
- **When you make a non-obvious decision**, persist it with `knowledge_store` so the next
  engineer (human or agent) recalls it.
- **After a commit**, the index goes stale — run `atlas index .` to refresh.

Atlas tools are reached through the `atlas` MCP server (`atlas_tool_invoke`).
<!-- atlas-wire-end -->
