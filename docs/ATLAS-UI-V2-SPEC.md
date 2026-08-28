# Groundfloor Atlas UI v2 — viz + chat architecture spec

> Status: design-locked. The library, scale strategy, vector-storage model, and
> provider set below are **decisions already made** — this doc records and
> sequences them, it does not re-open them. The frontend and data-layer
> deep-reads that informed every section are summarized inline.

---

## TL;DR (what we add, on top of what exists)

`atlas-ui` is ~80% built and works today: a Sigma.js/Graphology graph
(`AtlasGraph.tsx`), a non-streaming chat (`ChatPage.tsx`), an `LLMConfigBar`,
the Tauri lifecycle shell, and the single MCP transport `invokeAtlasTool`. v2
**extends** this; it does not rebuild it.

Three user-facing features, each gated by one backend contract:

1. **Hierarchical drill-down** — render communities first, expand to files,
   expand to symbols. Never render the whole graph. Gated by a new
   `atlas_subgraph` MCP tool (B1).
2. **Streaming chat** — token-by-token synthesis from `llm_chat`, ollama wired
   and tested first. Gated by the server emitting incremental SSE frames (B3).
3. **Citation → highlight bridge** — a chat answer that cites `file:line` or a
   symbol lights up the corresponding node in the live graph. Gated by chat and
   graph co-rendering in one view + one shared-state Context (B4).

Four missing foundations underlie all three (none exist today): **(a)** an
edge/hierarchy data model + the tool that serves it, **(b)** a true incremental
SSE reader, **(c)** one shared-state Context, **(d)** a combined graph+chat
view. The build sessions below add exactly these, smallest-first, each with a
hard ship gate so big-bang UI work cannot balloon.

---

## Preserve vs Add

From the frontend deep-read. ~1500 LOC is kept as-is and built on top of. The
net-new column is the entire v2 surface area.

| Area | PRESERVE (keep as-is, build on top) | ADD (net-new in v2) |
|---|---|---|
| **MCP transport** | `src/api/atlasApi.ts` → `invokeAtlasTool`, `mcpPost`, `parseResultContent`, `checkAtlasHealth`, `listAtlasTools`. Session-id capture + JSON/SSE content-type branching already correct. | `invokeAtlasToolStream(tool, args, onToken)` + `mcpPostStream` — a genuine `res.body.getReader()` + `TextDecoder` incremental SSE reader. Shares headers/session logic with `mcpPost`; does **not** modify it. |
| **Graph shell** | `src/components/graph/AtlasGraph.tsx` (whole file): `SigmaContainer`, `GraphLoader`, `GraphLayout` (ForceAtlas2), `GraphEventHandler`, `GraphSearchHighlighter`. | In-place graph mutation (`addNode`/`addEdge`/`dropNode` on the existing instance), incremental relayout on expand, camera/zoom-to-node (`useCamera` — none today). |
| **Data hook** | `src/hooks/useGraphData.ts` → `useGraphData`, `buildGraph`, `parseNodes`. Fetch+dedupe+build pipeline, refresh key, type-filter-without-refetch. | Per-level lazy fetch keyed by expanded node id (replace the single "fetch all 7 types up front" `useEffect`); `parentId` + `level` fields on parsed nodes; edges from `atlas_subgraph`. |
| **Node taxonomy** | `src/types/graph.ts` → `GraphNode`, `NodeType`, `NODE_COLORS`, `NODE_SIZES`. Already types `code_file` + `code_symbol` (the drill-down levels). | Add `parentId`, `level`, optional `communityId` to `GraphNode`; edge type + edge-class enum (`containment`/`call`/`context`). |
| **Graph chrome** | `src/components/graph/GraphControls.tsx` (search + type toggles + count + refresh), `src/components/graph/NodeDetail.tsx` (prop-driven detail panel). | Expand/collapse +/− affordances; breadcrumb of the current drill path; symbol-level fields in `NodeDetail`. |
| **Chat orchestration** | `src/pages/ChatPage.tsx` → `formatResult`, `fetchLLMInsight`, `routeQuery` wiring (request → tool → format → synthesize). Keep steps 1–3 (retrieval + summary stay request/response). | Stream only step 4 (synthesis): repeatedly `setMessages` updating one message's `llmInsight` with accumulated tokens. |
| **Chat rendering** | `src/components/chat/ChatMessage.tsx` → `Message` interface + bubble. `text`/`llmInsight` already `whitespace-pre-wrap`; `rawResult`/`toolLabel` slots exist. | Citation tokens in the rendered answer become clickable; each carries a node id (or `file:symbol` key). |
| **Provider config** | `src/components/chat/LLMConfigBar.tsx` (`llm_config_get`/`llm_config_set`). Untouched by viz/streaming. | Provider hardening: ollama default + tested first, then openai + anthropic. |
| **Routing/shell** | `src/components/Layout.tsx`, `src/App.tsx` (workspace-scoped nav). | A combined graph+chat split-pane view (prerequisite for the citation bridge — today the two are separate routes that never co-render). |
| **Query router** | `src/hooks/useQueryRouter.ts` → `routeQuery` (keyword → retrieval tool). | No change — still picks the retrieval tool before streaming synthesis. |
| **Orthogonal** | `useFolderPicker`, `AlertsPanel`, `CreateNodeModal`, `AddProjectModal`, `SchemaConfirmModal`, `OnboardingPage`. | Leave alone. |

Notable current-state facts the table assumes:
- **No edges exist anywhere.** `buildGraph` calls `g.addNode` only; zero
  `addEdge` in the codebase. The graph today is a disconnected point-cloud, not
  a hierarchy. This is the single biggest structural gap.
- **No state-management library and no React Context.** All cross-component
  state is local `useState` + prop-drilling. The first shared-state primitive
  is itself a foundational task.
- **No streaming primitives.** Zero `getReader`/`ReadableStream`/`TextDecoder`/
  `EventSource`. `mcpPost` detects `text/event-stream` but buffers the whole
  body and keeps only the **last** `data:` line — it is the *opposite* of
  streaming and must not be retrofitted.

---

## Library + rationale

**Sigma.js + Graphology — already in `atlas-ui`, confirmed the right call.**

- `@react-sigma/core` v5 + `sigma` v3 + `graphology` v0.26 are installed and
  drive the working graph today.
- **WebGL rendering** is the reason: at community/file/symbol scale (a 1500-file
  repo ≈ 6000 nodes + 10000 edges) an SVG/Canvas graph library (d3-force,
  vis-network, cytoscape default renderers) stalls; Sigma's WebGL pipeline holds
  60fps into the thousands-of-nodes range. This is the load-bearing reason we do
  not switch.
- Graphology gives us the mutation API drill-down needs (`addNode`, `addEdge`,
  `dropNode`, `hasNode`) — only `addNode` is exercised today, so the rest are
  *available but unproven here* and get proven in B2.
- The `nodeReducer`/`edgeReducer` + `refresh()` mechanism (already used for
  search highlight) is the same mechanism the citation bridge and
  collapsed-subtree dimming reuse. One renderer, one reducer slot — see Open
  Risks #9.

No new graph dependency is introduced in v2.

---

## Scale strategy

The rule: **never render the whole graph.** Three techniques, layered.

### 1. Hierarchical drill-down (community → file → symbol)
- **Level 0 renders communities only.** Today `useGraphData` always fetches all
  7 node types up front; v2's initial render fetches only top-level community
  nodes. A 1500-file repo collapses to a few dozen community nodes at level 0 —
  trivially renderable.
- **Files load lazily on expanding a community; symbols load lazily on expanding
  a file.** The single "fetch everything" `useEffect` becomes a per-level fetch
  keyed by the expanded node id, served by `atlas_subgraph`.
- **In-place mutation, not rebuild.** Expand = `graph.addNode` children +
  `graph.addEdge` containment edges on the existing instance; collapse =
  `graph.dropNode` the subtree. Today every change rebuilds the whole `Graph`
  object (losing positions); B2 switches to incremental mutation + incremental
  relayout.

### 2. Filter / search-first
- The user narrows *before* the graph materializes anything heavy.
  `GraphControls` search + type toggles already exist; v2 keeps them as the
  primary entry path. Type filtering already runs without a refetch.
- Search highlight already dims non-matches via `nodeReducer` — the same path
  the citation bridge reuses.

### 3. Server-side subgraph slicing
- The viz **requests a bounded slice, never the full graph.** `atlas_subgraph`
  is hard-capped at `maxNodes` (default 200, server-clamped to ≤1000) regardless
  of repo size. The induced-edge set for 200 nodes at depth 2 is a few hundred
  edges. The client never receives 6000 nodes.
- Load profile is **O(total graph) to compute, O(maxNodes) to return** —
  identical to the existing `atlas_communities`/`atlas_processes` tools, which
  are known to work at this scale (sub-second once the kuzu handle is warm).

These three compose: drill-down decides *which* slice, filter-first decides
*how narrow*, and `atlas_subgraph` enforces the *hard cap* so neither the UX nor
a misbehaving client can ever ask for the whole graph.

---

## Data layer: `atlas_subgraph` design

From the data-layer deep-read. All graph reads go through `EmbeddedLore`
(`src/lore/embeddedLore.ts`); daemon tools reach it via the warm per-workspace
registry `getEmbeddedLore(cfg, workspace)` (`src/mcp/embeddedRegistry.ts`).

### Reusable read primitives (no new graph reads needed)
| Primitive | Where | Role in `atlas_subgraph` |
|---|---|---|
| `listNodes(type?, tag?, project?, limit?)` | `embeddedLore.ts:236` | Hydrate `code_file` + `code_symbol` nodes; `project` = Groundfloor Atlas `workspace`. Unbounded path (10k cap). |
| `listEdges(pageSize=5000)` | `embeddedLore.ts:342` | Load ALL directed edges once; build in-memory adjacency. ~10000 edges = 2 pages. |
| `getNode(id)` | `embeddedLore.ts:227` | Validate/hydrate a known `center` id. |
| `listCommunities(client, workspace, opts)` | `src/communities/index.ts:79` | Resolve a `community` seed. |
| BFS + `maxDepth`/`maxSteps` + `truncatedAtDepth` | `src/processes/index.ts:199–247` | Direct structural template for the traversal loop (substitute `maxNodes` for `maxSteps`). |
| Endpoint-prefix edge classification | `codeContext.ts:128`, `communities/index.ts` | Derive `edge.class`: `code-file:→code-symbol:` = containment, `code-symbol:→code-symbol:` = call, `code-context*:→…` = context. All edges are stored `related_to`, so structural prefix-sniffing is the only discriminator today. |

### Input schema
```ts
{
  workspace?: string,      // defaults to cfg.lore.workspace
  center?: string,         // nodeId (code-file:… | code-symbol:…) to BFS from
  community?: number,      // communityId to expand
  depth?: number,          // default 2
  nodeTypes?: string[],    // default ['code_file','code_symbol']
  maxNodes?: number,       // default 200; server-clamped to <= 1000
}
```
Require **at least one** of `center` / `community` (refuse to materialize the
whole graph). On ambiguity (both supplied) → **error** (explicit contract).

### Output
```ts
{
  workspace: string,
  seed: { kind: 'center'|'community', center?: string, community?: number },
  nodes: Array<{ id, type, label, file?, line?, kind?, communityId?, metadata? }>,
  edges: Array<{ sourceId, targetId, relation, class: 'containment'|'call'|'context' }>,
  nodeCount: number,
  edgeCount: number,
  truncated: boolean,
  truncatedReason?: 'maxNodes'|'depth',
}
```

### Behavior (robust impl — no dependency on unverified `traverse()`)
1. `listNodes('code_file') + listNodes('code_symbol')` → `id→view` map + per-type sets.
2. `listEdges()` once → **undirected** adjacency, each edge tagged with `class` by endpoint prefix.
3. **Seed:** `center` → `[center]` (validate exists; if `code-file:`, optionally pre-expand to its contained symbols as depth-0). `community` → run membership detection, take **all** member fileIds (not the 5-cap `sampleFiles`) as the frontier.
4. **BFS** the in-memory adjacency, bounded by `depth` and `maxNodes`; set `truncated`/`truncatedReason` when either cuts the frontier.
5. Emit the **induced** edge set (both endpoints kept); hydrate node views.

This reuses the proven `listEdges`-then-filter-in-memory strategy of
communities/processes, keeping `atlas_subgraph` independent of `traverse()`'s
unverified element shape. The `traverse()` fast-path is deferred until B1
characterizes its return.

### File path + registration
- **New file:** `src/graph/subgraph.ts` — pure `buildSubgraph(reader, workspace, opts)` + `SubgraphReader` interface + `SubgraphResult` type. Parallels `src/communities/index.ts` and `src/processes/index.ts` exactly.
- **Registration:** one block in `buildRegistry` (`src/mcp/allTools.ts`), modeled on the `atlas_processes` block (`:208–240`): embedded-only guard, `workspace = args.workspace ?? cfg.lore.workspace`, `const lore = await getEmbeddedLore(cfg, workspace); return await buildSubgraph(lore, workspace, {...})`, hand-written JSON Schema `inputSchema`.
- No change to `server.ts`, `toolRegistry.ts`, or the reader factory — registration is single-file by design.

### Vector-storage model (HYBRID — already decided, recorded here)
- **`memory.jsonl` vectors live in git** — they are the moat (A0 shipped this side).
- **code-context vectors are a gitignored cache** — regenerable, never committed.
- `atlas_subgraph` reads structural nodes/edges only; embeddings (`getEmbeddings`) are not on its path. No change to the hybrid model in v2.

---

## The build sessions

Each session ships an independently-demoable increment behind a hard gate. The
ordering is dependency-driven: **B1 (data) unblocks B2 (viz); B3 (streaming) is
independent of both; B4 (bridge) requires B2 + B3.** The B1→B2 ordering matters
because the viz has no hierarchy data source without the tool.

---

### B1 — `atlas_subgraph` MCP tool

**Goal:** the one backend contract that unblocks drill-down. Bounded,
center- or community-seeded induced subgraph.

**File-level tasks:**
1. **`src/graph/subgraph.ts` (new)** — `SubgraphReader` interface (`listNodes`, `listEdges`, optional `traverse?`), `SubgraphResult` type, pure `buildSubgraph`. Implement the 5-step `listEdges`-based behavior above.
2. **`src/communities/index.ts`** — expose full membership. The `membership` map already exists internally (`:159`) and is discarded after labeling; export a small `listCommunityMembership(reader, workspace): Map<communityId, fileId[]>` (fixes GAP #1 — community seeding is impossible without it).
3. **`src/mcp/allTools.ts`** — register `atlas_subgraph` in `buildRegistry` (embedded-only guard, workspace default, `inputSchema`), modeled on `atlas_processes` (`:208–240`).
4. **`maxNodes` clamp** inside `buildSubgraph` (hard ceiling 1000) so the viz lever cannot be bypassed (GAP #6).
5. **Characterize `traverse()`** (`embeddedLore.ts:250`) against the live kuzu graph and write down its element shape — do NOT wire it into `buildSubgraph` yet (GAP #3). Defer the fast-path.

**Ship gate:** `atlas_subgraph` callable via MCP returns a valid, induced,
`maxNodes`-capped subgraph for **both** a `center` seed and a `community` seed
on a real indexed workspace; `truncated`/`truncatedReason` correct when the cap
bites; edge `class` correctly derived for all three structural classes. Verified
by direct tool invocation (no UI needed).

---

### B2 — hierarchical drill-down viewer

**Goal:** community → file → symbol expand/collapse on the existing Sigma shell.
**Preserve the entire `AtlasGraph.tsx` Sigma setup** — `SigmaContainer` config,
`GraphLoader`, `GraphLayout`, event handlers, the `nodeReducer` highlight path.
This session only adds mutation + lazy fetch + edges on top.

**File-level tasks:**
1. **`src/types/graph.ts`** — add `parentId`, `level`, optional `communityId` to `GraphNode`; add an edge type + `EdgeClass` enum.
2. **`src/hooks/useGraphData.ts`** — replace the single "fetch all 7 types" `useEffect` with a per-level fetch keyed by expanded node id, backed by `atlas_subgraph`; `parseNodes` gains `parentId`/`level`; `buildGraph` adds containment **edges** (first `addEdge` calls in the codebase).
3. **`AtlasGraph.tsx`** — incremental mutation on the existing graph instance: expand → `graph.addNode` children + `graph.addEdge`; collapse → `graph.dropNode` subtree. Re-trigger `GraphLayout.assign()` (or incremental relayout) after each expand — today it runs once on mount only. Add `useCamera` zoom-to-node on expand.
4. **Click handler** — `useRegisterEvents().clickNode` currently only calls `onNodeSelect`; make a click on an expandable node a toggle (expand/collapse), and a click on a leaf select it.
5. **`GraphControls.tsx` / `NodeDetail.tsx`** — +/− affordances, a drill-path breadcrumb, symbol-level fields.
6. **Expansion state** lives in the new Context (introduced here, reused by B4) so both the fetch hook and the renderer can read it.

**Ship gate:** renders a **6000-node `vuejs`-scale graph** (communities at level
0, lazy file/symbol expansion) **without freezing** — expand/collapse stays
interactive (no full rebuild, no dropped frames on expand), camera flies to the
expanded node, and collapse cleanly drops the subtree. Measured on a real
~1500-file indexed repo.

---

### B3 — streaming chat + provider hardening

**Goal:** token-by-token synthesis. **Keep `ChatPage` steps 1–3** (push msg +
placeholder, `routeQuery` → retrieval, `formatResult` summary). Only step 4
(synthesis via `llm_chat`) changes from await-whole to consume-stream.

**File-level tasks:**
1. **`src/api/atlasApi.ts`** — add `mcpPostStream` (a genuine `res.body.getReader()` + `TextDecoder` + incremental SSE-frame parser, calling `onToken` per `data:` frame) sharing headers/session logic with `mcpPost`. Add `invokeAtlasToolStream(tool, args, onToken)`. Do **not** modify `mcpPost` (its single-result contract has other callers; its current SSE handler discards intermediate frames — Open Risk #3).
2. **`src/pages/ChatPage.tsx`** — step 4 calls `invokeAtlasToolStream('llm_chat', …, onToken)`; each token does `setMessages` updating the one message's `llmInsight` with accumulated text. `ChatMessage` already renders `llmInsight` `whitespace-pre-wrap` — no rendering change needed.
3. **Provider hardening (decided order):** **ollama first** — wired, tested, default; local, no key, fast iteration. Then `openai`, then `anthropic`, configured through the existing `LLMConfigBar` (`llm_config_set`). No UI rebuild.
4. **Server dependency (confirm before building the reader):** the Groundfloor Atlas `llm_chat` tool must emit **incremental** SSE `data:` token frames, not one terminal result frame. The frontend cannot stream what the server sends whole.

**Ship gate:** a chat question against an **ollama** backend renders the answer
**token-by-token** (visible incremental fill in the bubble, not one final swap);
retrieval + summary (steps 1–3) still work unchanged; switching the provider via
`LLMConfigBar` to openai/anthropic still streams. Failure of the server to emit
incremental frames is caught here, not after.

---

### B4 — citation → highlight bridge + token auth + polish

**Goal:** a chat citation lights up the graph; enable non-localhost sharing.

**File-level tasks:**
1. **Combined view (prerequisite):** add a split-pane route that co-renders the graph and chat. Today `/workspace/:id` and `/workspace/:id/chat` are sibling routes that never co-render (`App.tsx:18–19`); a citation has no live Sigma instance to drive until they share a screen.
2. **`HighlightContext` (the one shared-state primitive):** provide `highlightIds: Set<string>` + `setHighlightIds` above both panes. Reuse the expansion-state Context introduced in B2 — one Context carries both (avoids two ad-hoc mechanisms).
3. **Generalize `GraphSearchHighlighter`** (`AtlasGraph.tsx:52–96`) to take `highlightIds` from EITHER the search box OR a citation. The `nodeReducer` body (enlarge matches, dim the rest, `refresh()`) stays identical — only the *source* of the id-set changes. A single **composed** reducer reads unified Context state so search/citation/collapse-dim don't clobber each other (Open Risk #9).
4. **Citation → node-id resolution (the unsolved piece):** the LLM citation must carry a stable node id (or a `file:symbol` key mapping to one). Define the citation format and the resolver; `ChatMessage` makes the citation token clickable → `setHighlightIds(...)`. Optional `useCamera` fly-to-cited-node.
5. **Token auth (implement here — spec below):** add the header/middleware path so the daemon can be shared beyond localhost.
6. **Polish:** breadcrumbs, empty/error states, loading affordances on lazy expand.

**Ship gate:** clicking a citation in a streamed chat answer highlights the
correct `code_file`/`code_symbol` node in the live graph (same dim/enlarge
mechanism as search), camera optionally flies to it; the daemon accepts an
authenticated non-localhost request with a valid token and rejects an invalid
one. Demoed end-to-end on a real repo.

---

## Citation bridge design

**The reused mechanism:** `GraphSearchHighlighter` (`AtlasGraph.tsx:52–96`)
already builds a `Set<string>` of node ids and installs a `nodeReducer` that
enlarges matches (`size*1.3`, `zIndex:1`) and dims everything else
(`color:'#1f2937'`, `label:''`), hides edges, then `sigma.refresh()`. Clearing
nulls the reducer. **A citation drives this exact path** — only the *source* of
the id-set differs (a citation instead of the search box).

**The shared-state mechanism (what exists vs. what's needed):**
- Today there is **no store and no Context** — graph state lives in
  `WorkspacePage` (local `useState`), chat lives in a **separate route**
  (`ChatPage`). They share nothing but the URL `:id` and never co-render.
  Highlight today is pure prop-drilling: `WorkspacePage` → `searchQuery` prop →
  `AtlasGraph` → `GraphSearchHighlighter`.
- v2 introduces **one React Context** (`HighlightContext`: `highlightIds` +
  `setHighlightIds`) provided above a **combined split-pane view**. Chat's
  citation click calls `setHighlightIds`; the generalized
  `GraphSearchHighlighter` reads it. Lowest-ceremony option — no new dependency,
  fits React 19, mirrors the existing `searchQuery` prop flow. Zustand would
  work but is unwarranted for one shared set. **This same Context also carries
  the drill-down expansion state** from B2 (one mechanism, not two).

**The unsolved piece — citation → node-id resolution:** chat messages today
carry no node ids. The LLM citation must emit a stable node id (or a
`file:symbol` key that maps to a `GraphNode.id`), and a resolver must map it to
the live graph node. This is net-new: define the citation token format
(carrying the id) and the resolver in B4. Without a stable id in the citation,
the bridge has nothing to highlight.

**Single-reducer constraint:** Sigma has one `nodeReducer` slot
(`setSetting('nodeReducer', fn)`). Search highlight, citation highlight, and
collapsed-subtree dimming all want it — so v2 uses **one composed reducer**
reading the unified Context, never independent components each calling
`setSetting` (which would clobber each other).

---

## Token auth (spec now; implement in B4)

Viz + chat work fine on **localhost without any token** — that path stays the
default for local dev and is never gated. Token auth exists only to make the
daemon shareable beyond localhost.

**Model:**
- **Bearer token in the request.** The MCP HTTP daemon accepts an
  `Authorization: Bearer <token>` header. The token is a long random secret
  generated once per daemon (e.g. `atlas serve --token <secret>` or an
  auto-generated, persisted secret printed on first non-localhost bind).
- **Localhost bypass.** Requests from loopback (`127.0.0.1`/`::1`) skip the
  check entirely — local dev is zero-config. The check engages only when the
  daemon binds a non-loopback interface.
- **Frontend transport.** `atlasApi.ts` attaches the header in the shared
  header-builder used by `mcpPost`, `mcpPostStream`, and the `/health` bypass —
  one place, so JSON, streaming, and health all carry it. The token is supplied
  via the existing config surface (env/`LLMConfigBar`-adjacent setting), never
  hard-coded.
- **Failure mode.** Missing/invalid token on a non-localhost request → `401`;
  the UI surfaces a clear "daemon requires a token" state rather than a silent
  hang.

**Why spec-now/implement-B4:** the header path touches the same shared
header-builder that B3's `mcpPostStream` introduces, so implementing auth after
streaming exists avoids touching the transport twice. Nothing in B1–B3 depends
on auth (all localhost).

---

## Open risks

Honest, from both deep-reads — plus this session's own pattern that big-bang UI
work balloons, which is why every session above has a tight, demoable MVP gate.

1. **No edges anywhere → no hierarchy substrate.** `buildGraph` does `addNode`
   only; zero `addEdge` in the codebase. Drill-down's containment edges, FA2
   clustering, and any "calls" view all need an edge model that exists neither
   server-side nor client-side. Largest structural gap; B1 + B2 close it.
2. **Backend contracts gate everything.** (a) Hierarchy data only via the
   new `atlas_subgraph` (B1). (b) Streaming only if `llm_chat` emits incremental
   SSE frames (confirm before B3). (c) Citation bridge only if the citation
   carries a node id (define in B4). The frontend cannot satisfy these alone.
3. **`mcpPost`'s SSE handler is a trap** — it reads the full body and keeps only
   the last `data:` line, discarding every token. It *looks* stream-aware but is
   the opposite. Token streaming needs a genuinely new incremental reader
   (`mcpPostStream`); do not retrofit `mcpPost`.
4. **Layout runs once, on mount only.** `GraphLayout.assign()` depends on
   `[assign]`, and `useGraphData` rebuilds the whole `Graph` on any change.
   Incremental expand/collapse breaks this — either rebuild-everything (loses
   positions, jarring) or add incremental relayout. B2 must decide deliberately.
5. **Graph and chat are separate routes that never co-render.** The citation
   bridge is impossible until they share one view — a layout/routing change
   (B4 prerequisite), not a small feature.
6. **No shared-state primitive at all.** Everything is local `useState` + props.
   Both new features need cross-component state; introducing the first Context
   is itself a foundational task (B2).
7. **No camera/zoom-to-node API in use.** "Drill into this node" and "fly to the
   cited symbol" both imply camera control net-new on top of react-sigma.
8. **Full re-fetch on refresh (7 parallel calls, `limit:40` each).** Won't hold
   at community/file/symbol scale — drill-down's lazy per-level fetch is a
   performance requirement, not just UX.
9. **`nodeReducer` is a single global slot.** Search/citation/collapse-dim all
   want it; only one reducer installs at a time. A single composed reducer over
   unified Context state is required — independent `setSetting` callers clobber.
10. **Data-layer must-fix:** `listCommunities` returns only 5-capped
    `sampleFiles` and does not persist membership; community-seeded subgraphs
    need full membership. The `membership` map already exists internally
    (`communities/index.ts:159`) and is discarded — B1 exposes it.
11. **`traverse()` element shape unverified** (`embeddedLore.ts:250`, no
    consumers). Build `atlas_subgraph` on proven `listEdges`; defer the
    `traverse()` fast-path until B1 characterizes it.
12. **Scale ceiling is the `community` seed.** It re-runs label-propagation
    (global, O(nodes+edges)) per call with no cache. Fine at 6000/10000;
    memoize per workspace (invalidate on `atlas_index`) before 10× scale.
13. **Big-bang UI balloon risk (process).** v2 spans four foundations; the
    mitigation is the per-session ship gates above — each session is
    independently demoable and refuses to start the next foundation until its
    own gate is green.

---

# ⚠️ BUILDABILITY REVIEW — corrections that OVERRIDE the session sections above

An adversarial critique pass (B0 gate) verified every claim against the real code.
Verdict: **buildable WITH FIXES.** Do NOT start B1 until these corrections are absorbed.
The session breakdown above is kept for context, but where it conflicts with this
section, THIS SECTION WINS.

## B1 — `atlas_subgraph` data layer — ✅ SHIPS AS WRITTEN
Every primitive verified real: `embeddedLore.ts` `listNodes`(227)/`listEdges`(236)/
`getNode`(250)/`traverse`(342); edges DO exist server-side (`codeNodes.ts` writes
related_to file→symbol/symbol→symbol/context edges); community detection deterministic
(seed:1, randomWalk:false); membership map at `communities/index.ts:159` is real.
Two minor adds to the B1 gate:
- Edge-class sniff must use `startsWith` and treat BOTH `code-context:` AND
  `code-context-sym:` (`codeNodes.ts:162`) as the 'context' class. Add a gate assertion.
- Expose `listCommunityMembership(communityId)` (small refactor of the existing map) —
  the viewer needs community-id → fileIds for level-0→expand.

## B2 — drill-down viewer — RE-SCOPE (the real blocker is hidden)
**Primary task (was treated as a footnote):** today `useGraphData` does
`setGraph(buildGraph(...))` — a NEW Graph object every change — and `GraphLoader` reloads
on `[graph]` identity. There is NO live instance to mutate. **B2's bulk of work is
inverting ownership:** create the Graphology instance ONCE (useRef/useMemo, never
replaced), have `AtlasGraph` mutate it directly via `useSigma().getGraph()` (`addNode`/
`addEdge`/`dropNode`), drop the `setGraph`-on-change pattern. Type-filter + refresh also
move to mutation.
- **Layout:** the current `useLayoutForceAtlas2` is synchronous main-thread (iterations
  200) — it will drop frames re-laying-out thousands of nodes on expand. COMMIT to either
  the worker/supervisor layout (off-main-thread) OR deterministic radial placement of new
  children around the parent (skip global FA2 on expand). Pin the gate to a measured frame
  budget on the chosen path.
- **Level-0 fetch is net-new:** `useGraphData` has NO community path today (it fires
  `knowledge_search` per-type, limit 40). Replace that useEffect with an
  `atlas_communities` level-0 call → `atlas_subgraph(community/center)` for lazy expand.
- **Pull these edge cases INTO B2 (they were mis-filed as B4 polish):** empty workspace
  (show empty state, don't spin); workspace with no communities above minSize (dayjs — no
  seeds); single huge community whose members exceed maxNodes (define the
  "N more — refine to see" truncation affordance; `truncated:true` will be COMMON on big
  modules); multi-workspace (scope the highlight/expansion Context by workspace :id, else
  two open graphs clobber each other).
- **Ephemeral community ids:** Louvain dense ids (0..N-1) are recomputed every call and
  reshuffle on re-index (persistence is an explicit non-goal). Expansion state is valid
  only within one index generation — invalidate it on `atlas_index`, or seed expansion by
  the community's dominant directory rather than the raw id.

## B3 — streaming chat — SPLIT INTO B3a (server) + B3b (frontend). The server CANNOT stream today.
The spec framed B3 as frontend-only. WRONG. Three server layers all buffer-then-return:
`llmChat.ts` (`stream:false`, line 141; `postJSON` buffers in `res.on('end')`, 106); the
MCP shim `atlas_tool_invoke` does `return asText(result)` on one awaited result
(`server.ts:153-156) — NO per-token frame path; `mcpPost` discards all but the last
`data:` line.
- **B3a (server-streaming, its own session):** rewrite `llmChat` to stream (Ollama
  `stream:true` + per-chunk callback, chunked reader instead of `postJSON`); design how
  tokens leave the daemon — either a dedicated streaming endpoint for `llm_chat` that
  bypasses the `atlas_tool_invoke` shim, or an MCP progress-notification channel. The
  server frame shape MUST be proven before the frontend reader can be written.
- **B3b (frontend reader):** only after B3a — `mcpPostStream` + `ChatPage` step-4 token
  append into the existing `whitespace-pre-wrap` `ChatMessage` (that part is trivial).

## B4 — token auth is ALREADY DONE server-side; only frontend header attach remains
`server.ts:39-105` already has bearer token + host/origin allow-lists + constant-time
compare + 401/WWW-Authenticate; `config.ts` has `ensureMcpAuthToken`/`mcpAuthEnabled`.
DELETE the "implement middleware" framing. Remaining work: `atlasApi.ts` shared
header-builder attaches `Authorization: Bearer` (read `mcp.token`/config). Reconcile the
spec's "localhost bypass" wording with the existing `ATLAS_MCP_AUTH` opt-out + loopback
allow-list model so the contract isn't self-contradictory.

## Corrected session count
Original plan: B1, B2, B3, B4 (4 sessions). **Corrected: B1, B2 (heavier), B3a, B3b, B4
(lighter) ≈ 5 sessions.** B1 is ready to start AS LONG AS the B1 minor adds are included;
B2/B3 must not start until their re-scope above is reflected.
