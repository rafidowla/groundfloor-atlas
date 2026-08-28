# B2 — Drill-Down Viewer: Manual Test Checklist

This checklist covers the parts of B2 that **cannot be verified headlessly** —
the live, in-browser "no freeze / no relayout jump" visual behavior. The logic
core (`GraphController`) is fully unit-tested and the production build is clean
(see "What was verified headlessly" at the bottom). Everything below requires a
human watching the actual rendered Sigma canvas.

---

## How to launch

From `groundfloor-atlas/atlas-ui`:

```bash
# Web (fastest for visual checks) — Vite dev server on http://localhost:1421
npm run dev

# OR the full desktop shell (Tauri) if you need the native window / IPC:
npm run tauri:dev
```

The graph viewer lives on the **Workspace page** (route per workspace). Open a
workspace that has been indexed — these checks assume the `vuejs` workspace is
indexed and has communities. If it is not indexed, run `atlas index` first or
pick an indexed workspace.

> Prerequisite: the Groundfloor Atlas MCP backend (`atlas_communities` / `atlas_subgraph`)
> must be reachable. The UI calls these via `invokeAtlasTool`. If the backend is
> down you will see the **error state** (red message + Retry), not the graph.

---

## Test sequence

### 1. Level 0 — community ring loads
1. Open the **vuejs** workspace.
2. **Expected:** brief "Loading communities…" spinner, then a ring of large
   **violet** nodes (~6 community nodes, exact count depends on the index)
   spread around the canvas center. Labels read `<community name> (<fileCount>)`.

- ✅ **Good:** a handful of big violet nodes, evenly spread (the one-time
  ForceAtlas2 pass spreads the seed ring), each labeled with a file count.
- ❌ **Bad:** all nodes stacked on top of each other at the origin (one-time
  layout didn't run), or a dense hairball of hundreds of small nodes (means the
  old flat point-cloud view came back, not the level-0 community view).

### 2. Expand a community → its files appear, **graph does NOT jump**
1. Click one community node.
2. **Expected:** that community's **file** nodes (cyan, smaller) appear placed on
   a ring **immediately around the clicked community**. The detail panel on the
   right shows the clicked node.

- ✅ **Good (the core anti-freeze gate):** the new file nodes fan out around the
  clicked community. **Every other node — the other communities and any
  already-expanded children — stays exactly where it was. The camera and all
  pre-existing nodes do NOT jump, slide, or re-settle.** Only the new children
  animate/appear.
- ❌ **Bad (freeze / regression):** the WHOLE graph visibly shifts, jitters, or
  re-settles into a new layout after the click; a multi-hundred-millisecond
  freeze / dropped frames; the camera resets. Any of these means a global
  relayout is running on expand — the exact failure B2 was built to prevent.

### 3. Drill deeper — file → symbols
1. Click one of the new **file** nodes.
2. **Expected:** that file's **symbol** nodes (slate, smallest) ring around the
   file. Again, nothing else moves.

- ✅ **Good:** symbols appear tight around their file; communities and sibling
  files are perfectly still.
- ❌ **Bad:** any global reflow, or the file's siblings/parents move.

### 4. Collapse — click again
1. Click an **already-expanded** node (community or file) a second time.
2. **Expected:** its descendant subtree disappears; the parent node remains. A
   child shared by another still-expanded parent (refcount) should **stay**.

- ✅ **Good:** only that branch collapses; the rest of the graph is unchanged and
  does not relayout.
- ❌ **Bad:** unrelated nodes vanish, or the graph relayouts on collapse.

### 5. Search highlight (regression check — must still work)
1. Type a substring into the search box in the left **GraphControls** panel.
2. **Expected:** matching nodes stay bright (and slightly enlarged); non-matching
   nodes dim to near-background and lose labels; edges hide.
3. Clear the box → everything returns to normal.

- ✅ **Good:** highlight/dim toggles cleanly with the query.
- ❌ **Bad:** search box does nothing, or clearing it leaves nodes stuck dim.

### 6. Switch workspace → fresh graph (isolation)
1. Use the workspace switcher to move to a **different** indexed workspace.
2. **Expected:** a brand-new community ring for that workspace. None of the
   previous workspace's expanded nodes/files/symbols carry over.

- ✅ **Good:** clean fresh graph; no leftover nodes from the prior workspace.
- ❌ **Bad:** stale nodes from the previous workspace persist (would mean the
  per-workspace `useMemo` graph isolation broke).

### 7. Empty workspace → empty state
1. Open a workspace that has **no indexed code** (or no communities).
2. **Expected:** no canvas; instead the **empty state** card ("No indexed code in
   this workspace yet" / "No communities above threshold") with guidance text.

- ✅ **Good:** clear empty-state card, no spinner hang, no broken canvas.
- ❌ **Bad:** infinite spinner, a blank black canvas, or a JS error.

---

## What "freeze / regression" looks like (summary)

| Symptom | Likely cause |
|---|---|
| Whole graph re-settles after every expand | global ForceAtlas2 running on expand (B2's prevented failure) |
| Multi-hundred-ms hang on click | synchronous whole-graph layout on the main thread |
| Camera resets / jumps on expand | graph instance being replaced instead of mutated |
| Stale nodes after workspace switch | per-workspace graph isolation broken |
| Search box does nothing | `GraphSearchHighlighter` / nodeReducer wiring lost |
| Node detail panel never opens | `onNodeSelect` / `NodeDetail` wiring lost |

The single most important visual gate is **Test 2 / Test 3**: *expanding a node
must place only the new children and must NOT move or relayout any pre-existing
node.* If that holds, the anti-freeze design is working in the live app.

---

## What was verified headlessly (no browser needed)

These are already confirmed and do **not** need manual re-checking:

- **Production build** (`npm run build` = `tsc -b && vite build`) exits **0**.
- **Unit tests** (`npx vitest run src/graph/GraphController.test.ts`):
  **16/16 pass** — covering level-0 load, idempotent expand, three-level drill,
  seed-self exclusion, refcounted collapse (shared node survives until both
  parents collapse), truncation surfacing, multi-workspace isolation, and the
  empty/no-op edge cases.
- **No-whole-graph-relayout structural guarantee:** `GraphController.ts` imports
  no layout library and calls no `forceatlas2`/`assign`/`circular` — only
  deterministic radial x/y math. The unit test
  `expand never imports/calls forceatlas2 and leaves pre-existing node positions
  UNCHANGED` snapshots every node's x/y before a deeper expand and asserts they
  are byte-identical after. `assign()` (ForceAtlas2) is invoked in exactly one
  place — `AtlasGraph.tsx` `GraphLayout`, guarded by a `didRun` ref so it runs
  once at level-0 mount and never on expand/collapse.
- **No regression of existing sub-components:** `WorkspacePage.tsx` still imports
  and wires `GraphControls`, `NodeDetail`, and threads `searchQuery` through to
  `AtlasGraph` → `GraphSearchHighlighter` (search highlight preserved).

The manual checklist above exists **only** because the *visual* "no jump / no
freeze" behavior requires a rendered canvas and a human eye — the logic that
drives it is already proven headlessly.
