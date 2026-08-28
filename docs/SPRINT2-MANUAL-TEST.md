# Sprint 2 — manual eyeball checklist

Logic is covered by vitest (`atlas-ui`: GraphController.focus + filterPredicates, 59/59).
These are the things only a human watching the rendered Sigma canvas can confirm.

## Run

```bash
cd groundfloor-atlas
npm run build                       # backend (schema.ts + schema.display.ts)
cd atlas-ui && npm run tauri dev    # or `npm run dev` for the Vite frontend alone
```

Open a workspace that has been indexed (`atlas index <repo>`), so the graph has
typed edges (Sprint 1). Level-0 shows the community ring.

## Checklist

### Filter rail — hard hide (not dim)
- [ ] Left rail lists **node types** grouped code vs knowledge, each with a color dot.
- [ ] Deselecting a node type **removes** those nodes from the canvas (hidden, not greyed).
- [ ] Re-selecting brings them back. All-on = full graph (no filtering).
- [ ] A new **Edge Types** section lists the typed relations (calls/imports/extends/
      implements/contains/describes). Deselecting one removes those edges.
- [ ] An edge whose endpoint is filtered out also disappears (no dangling edges).

### Legend / colors (single-sourced from schema.display.ts)
- [ ] Rail color dots **match** the rendered node colors exactly.
- [ ] `code_symbol` nodes render **teal** (`#14b8a6`), not the old slate — this was the
      divergence Sprint 2 fixed.
- [ ] Edges are tinted by relation hue (calls/imports/etc. visibly differ).

### Focus depth
- [ ] Select a node, then pick **1 / 2 / 3 / 5** in the focus-depth control → the graph
      constrains to that node's N-hop neighborhood; everything else is hidden.
- [ ] **All** resets to the full (unfocused) view.
- [ ] Focusing does not relayout the whole graph (no jarring reshuffle).

### Search precedence
- [ ] Typing in **Search nodes…** dims non-matches (soft), as before.
- [ ] Running a **semantic** search highlights embedding matches (knowledge_search).
- [ ] A node hidden by a **type filter** stays hidden even if it matches the search —
      hard filter wins over soft dim (the Sprint 2 precedence rule).
- [ ] Chat citations still highlight cited nodes, and are also overridden by hard filters.
