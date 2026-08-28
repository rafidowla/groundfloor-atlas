# B4 — Citation Bridge + Auth Fix + Polish: Manual Test Checklist

B4 ships three things that are **frontend-heavy** and so only partly gate-verifiable:

1. **PART 1 — auth fix.** The embedded app now spawns its own daemon with
   `ATLAS_MCP_AUTH=off` (`atlas-ui/src-tauri/src/lib.rs:109`), so the frontend's
   bearer-less requests to `/api/chat/stream` reach a 200 streaming response and
   **live tokens engage** instead of always falling back to the non-stream path.
2. **PART 2 — citation bridge.** A framework-agnostic `CitationStore`
   (`atlas-ui/src/graph/citationStore.ts`) keyed by workspace, surfaced through a
   per-workspace `CitationProvider`, lets a chat answer highlight its cited nodes
   on the graph tab — **reusing** the existing `GraphSearchHighlighter`
   `nodeReducer` dim mechanism, not replacing it.
3. **PART 3 — polish.** Sigma/graphology split into a lazy vendor chunk
   (`vite.config.ts`), and a **truncation → refine** affordance on truncated
   community expansions (`GraphController.refine`, `NodeDetail` "More children —
   refine" button).

## Headless-verified (logic gates — already green, no manual step needed)

| Gate | Command | Result |
| --- | --- | --- |
| UI build (tsc + vite) | `cd atlas-ui && npm run build` | exit 0 (after vite-config `manualChunks` fix) |
| Daemon build | `npm run build` (repo root) | exit 0 |
| Citation store unit tests | `cd atlas-ui && npx vitest run src/graph/citationStore.test.ts` | 18/18 pass |
| B2 + B3b regression | `cd atlas-ui && npx vitest run src/graph/GraphController.test.ts src/api/chatStream.test.ts` | 21/21 pass |
| Auth reachability (AUTH-OFF) | `node /tmp/b4-auth-check.mjs` (or replicate) | bearer-less POST `/api/chat/stream` → **200 + SSE**, 4 token frames over 4 reads |
| Auth gate control (AUTH-ON) | same | bearer-less → 401; with bearer → 200 streaming |

The auth check starts a real daemon with `ATLAS_MCP_AUTH=off` +
`ATLAS_LLM_FAKE_STREAM=1` and POSTs from localhost with **no** `Authorization`
header (exactly what `buildAtlasHeaders()` sends) — it returns 200 and streams.
The control daemon (auth ON, the pre-fix default) 401s the same request, proving
the flag is what flips the gate.

**Tauri-runtime-only (cannot run headlessly):** the `.env("ATLAS_MCP_AUTH","off")`
injection happens inside the Rust `spawn_atlas_daemon` command in
`src-tauri/src/lib.rs`. The env-injection source is statically verified and its
downstream effect (200 streaming) is proven above, but the actual Tauri spawn
must be exercised by launching the packaged/dev app (manual item (a) below).

## Manual checklist (visual / Tauri-runtime — run in the real app)

Prereq: `cd atlas-ui && npm run tauri:dev` (or launch the packaged app). The app
spawns its own daemon with auth off; confirm the daemon log prints
`/mcp auth: OFF (ATLAS_MCP_AUTH=off)`.

### (a) Chat live-token streaming (B3b + PART-1 auth)
1. Open a workspace → Chat tab. Ask any question that hits Groundfloor Atlas retrieval
   (e.g. "what does the auth module do?").
2. **PASS:** tokens render **incrementally** (word-by-word), not in one blob.
   This confirms `/api/chat/stream` returned 200 and the live `streamChat` path
   engaged — i.e. the PART-1 auth fix worked in the real Tauri runtime.
3. **Regression signature (auth fix broken):** the answer appears all at once
   after a pause → the stream 401'd and the code fell back to the non-stream
   `invokeAtlasTool('llm_chat')` path. Check the daemon log for a 401 on
   `/api/chat/stream` and that the spawn injected `ATLAS_MCP_AUTH=off`.

### (b) Citation highlight on the graph tab
1. After an answer renders, switch to the **Graph** tab for the same workspace.
2. **PASS:** the cited nodes keep full color + a size bump; all other nodes are
   dimmed to `#1f2937` with labels cleared and edges hidden. A banner reads
   "Highlighting N cited node(s) from chat".
3. **Regression signature:** nothing dims, OR the whole graph dims to nothing
   (means none of the cited ids/files matched a loaded node — expected only when
   the answer cited nodes outside the current slice).

### (c) Click a citation chip → focus one node
1. Back on the Chat tab, an answer shows clickable citation chips under it.
2. Click one chip.
3. **PASS:** the app navigates to the Graph tab and **only that one node** is
   highlighted (others dimmed).
4. **Regression signature:** click does nothing, or highlights the full prior
   cited set instead of the single clicked id.

### (d) Workspace isolation — citations must not bleed
1. In workspace **A**, ask a question so its graph shows a citation highlight.
2. Switch to a **different** workspace **B** (WorkspaceSwitcher) → Graph tab.
3. **PASS:** workspace B's graph shows **no** citation highlight from A. Return
   to A → A's highlight is still there.
4. **Regression signature:** B's graph is dimmed by A's citations → the
   `CitationProvider key={workspaceId}` remount boundary (WorkspaceLayout) or the
   per-workspace keying in `CitationStore` regressed.

### (e) Truncated community → refine → more children
1. Expand a large community whose child slice was truncated. The node shows
   "⚠ children truncated — refine to see all" and the detail panel shows a
   **"More children — refine"** button (`node.truncatedChildren === true`).
2. Click **refine**.
3. **PASS:** additional child nodes appear (the controller re-queries with a
   larger `maxNodes` budget via `controller.refine` → `force` re-expand), placed
   radially, no full-graph relayout/freeze.
4. **Regression signature:** the button is missing on a truncated node, or
   clicking it adds 0 children (budget did not grow), or the graph freezes
   (a whole-graph ForceAtlas2 relayout was wrongly triggered).

## Regression signatures summary (what "broken" looks like)

- **Auth:** chat answers appear all-at-once after a pause; daemon logs 401 on
  `/api/chat/stream`; spawn missing `ATLAS_MCP_AUTH=off`.
- **Citation reuse:** search box stops dimming non-matches (the shared
  `GraphSearchHighlighter` nodeReducer was replaced rather than extended), or
  search + citation clobber each other (search must take precedence).
- **Isolation:** a citation set highlights the wrong workspace's graph.
- **Refine:** truncated nodes have no refine affordance, or refine yields no new
  children, or triggers a relayout freeze.
- **Polish/build:** `npm run build` fails on `manualChunks` (must be the
  function form under vite 8 / rolldown), or the `sigma` vendor chunk is no
  longer split out (main bundle balloons past the 500 kB advisory).
