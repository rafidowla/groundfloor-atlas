# B3b — Frontend Streaming Reader: Manual Test Checklist

The B3b reader logic (`atlas-ui/src/api/chatStream.ts`) is **gate-verified
headlessly**: `npm run build` exits 0, the `parseSseBuffer` unit tests pass,
and an end-to-end node harness drives the real parser against the LIVE B3a
route (`POST /api/chat/stream`) and observes 4 incremental tokens
(`Hello`, ` `, `world`, `!`) arriving at distinct timestamps with
`fullText === "Hello world!"`.

What **cannot** be asserted headlessly is the one visual behavior: that those
tokens actually paint into the answer bubble **progressively** (and that the
view auto-scrolls). This checklist covers that last mile.

---

## A. Progressive token rendering (the core thing to see)

1. Build/run the daemon normally (real provider, e.g. ollama up) **or** with
   the deterministic fake stream to remove model variance:
   ```bash
   pkill -f "cli.js serve"; sleep 1
   ATLAS_LLM_FAKE_STREAM=1 ATLAS_HOME=$HOME/.atlas-demo \
     ./bin/atlas serve
   ```
   Confirm health: `curl -s http://127.0.0.1:3848/health` → `{"status":"ok",...}`.

   > Note (auth): the daemon defaults to **auth ON** when `<ATLAS_HOME>/mcp.token`
   > exists — the stream route returns **401 without `Authorization: Bearer`**.
   > See the "Streaming silently disabled" caveat at the bottom: if the bundled
   > client does not send the bearer, streaming will not engage and you will see
   > the fallback (whole-answer) behavior instead of progressive tokens. To force
   > the no-token path for this visual test, start the daemon with
   > `ATLAS_MCP_AUTH=off`.

2. Launch the UI:
   ```bash
   cd atlas-ui && npm run dev
   ```
   Open the printed localhost URL, navigate to a workspace, open **Chat**.

3. Ask any question (e.g. "summarize this workspace"). Watch the assistant
   bubble's **LLM insight** region.

   **EXPECT (pass):** text grows **token-by-token** — you see characters/words
   appear in sequence, building up over a fraction of a second to a second+,
   *not* a single blank pause followed by the whole answer snapping in at once.
   With the fake stream you should literally see `Hello` → `Hello ` →
   `Hello world` → `Hello world!`.

4. **Auto-scroll:** ask a question whose answer is long enough to exceed the
   visible chat height. As tokens stream in, the view should keep the latest
   text in view (scroll pinned to bottom) without you scrolling manually.

   **EXPECT (pass):** newest tokens stay visible; the scroll position tracks
   the growing bubble.

---

## B. What a REGRESSION looks like (fail signatures)

- **All-at-once:** the bubble shows a thinking/empty state, then the *entire*
  answer appears in one frame after a noticeable pause. This means the reader
  is buffering the whole body (or the route lost its per-token `flush`/
  `X-Accel-Buffering: no`) — `onToken` is effectively firing once at the end.
- **Frozen / never settles:** tokens stop mid-answer and the bubble never
  reaches a final state, or a spinner spins forever. Suggests the `done` frame
  was missed or the read loop hung (check the daemon log and the browser
  Network tab — the `/api/chat/stream` request should be `200`,
  `content-type: text/event-stream`, and show a streaming/EventStream body).
- **No auto-scroll:** tokens append but the viewport stays put, so a long
  answer streams off-screen and you must scroll by hand.
- **Garbled/duplicated text:** indicates a frame-boundary bug in the buffer
  carry-forward (the unit test `holds a frame split across two buffers`
  guards exactly this — a regression here would also fail that test).

---

## C. Verify the graceful FALLBACK (streaming → non-stream `llm_chat`)

The reader is wired so that if `streamChat` throws (route missing, non-200,
network error, or `provider: 'none'`), `ChatPage` falls back to the existing
whole-response path (`fetchLLMInsight` → `invokeAtlasTool('llm_chat', …)`).
This is in `atlas-ui/src/pages/ChatPage.tsx` (the `try { streamChat(...) }
catch { fetchLLMInsight(...) }` block).

To exercise it manually:

1. With the UI open and the daemon running, **break only the stream route** so
   `/api/chat/stream` fails while `/mcp` (and thus `llm_chat`) still works. The
   simplest reliable way: run the daemon with **auth ON** but have the client
   send no bearer (the default today) — the stream route returns 401 and the
   reader throws. (Or stop a stream-only proxy / block the route at the OS
   firewall if you have one.)
2. Ask a question.

   **EXPECT (pass):** you still get an answer in the bubble, but it appears
   **all at once** (no progressive tokens) — that is the `llm_chat` fallback
   doing its job. The chat must NOT show an error state.

3. Re-enable streaming (restart daemon with `ATLAS_MCP_AUTH=off`, or fix the
   client to send the bearer) and confirm progressive tokens return.

---

## D. Caveat surfaced during headless verification — "streaming silently disabled"

`atlasApi.buildAtlasHeaders()` (reused verbatim by `streamChat`) sends
`Content-Type` + `Accept` + `mcp-session-id` but **no `Authorization: Bearer`**.
The live daemon, when `mcp.token` is present (auth ON), **requires** the bearer
on `/api/chat/stream` and returns **401** without it — verified headlessly:

| Request | Result |
| --- | --- |
| `POST /api/chat/stream` **without** bearer | `HTTP 401` |
| `POST /api/chat/stream` **with** `Authorization: Bearer <mcp.token>` | `HTTP 200`, streams tokens |

Consequence: against a token-enabled daemon, the real frontend `streamChat`
would 401 → throw → fall back to `llm_chat` (whole-answer), so **progressive
tokens never appear** even though the reader itself is correct. This is fine if
the Tauri embedded daemon runs with `ATLAS_MCP_AUTH=off` (token null, bearer not
required). If progressive streaming is expected against an auth-ON daemon,
`buildAtlasHeaders()` needs to add the bearer from `<ATLAS_HOME>/mcp.token`.
When manually testing for *progressive tokens*, start the daemon with
`ATLAS_MCP_AUTH=off` so the reader is reached.

---

## Headless-verified vs manual-remaining — summary

| Aspect | Status |
| --- | --- |
| `npm run build` (tsc + vite) exits 0 | ✅ headless |
| `parseSseBuffer` unit tests (incl. split-frame) pass | ✅ headless (5/5) |
| Real parser consumes LIVE B3a stream, multiple **incremental** tokens | ✅ headless |
| `fullText === "Hello world!"`, `done` frame seen | ✅ headless |
| Fallback try/catch → `llm_chat` wiring present & correct | ✅ static |
| Tokens visibly paint into the bubble progressively | ⚠️ manual (this doc, §A) |
| Auto-scroll tracks the growing bubble | ⚠️ manual (this doc, §A.4) |
| Fallback produces an answer (no error) in the UI | ⚠️ manual (this doc, §C) |
