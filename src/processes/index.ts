/**
 * processes/index.ts — Wave 5 execution-flow tracer.
 *
 * Given an entry-point SYMBOL NAME (e.g. "mount", "handleLogin"), walks
 * the call graph downstream and returns an ordered, depth-tagged "story"
 * of what executes. The output is a flat BFS-ordered list of steps the
 * agent can read top-to-bottom like a narrative ("mount calls createApp,
 * which calls initInstance, which calls writeDOM [terminal]…").
 *
 * Same architectural pattern as communities/index.ts: this is a PURE
 * async function over a duck-typed client surface (ProcessReader). The
 * CLI / MCP wrappers supply an EmbeddedLore instance; this module never
 * sees the open/close lifecycle. Trivially testable with a hand-rolled
 * fake.
 *
 * NON-GOALS (v1):
 *   - No entry-point auto-detection (framework heuristics for express /
 *     koa / etc.). The caller supplies the entry name; that punt is
 *     intentional — Processes is the FORMATTER for a known descent, not
 *     a full reverse-engineering pass.
 *   - Not the full call graph (already exists). This restricts to a
 *     downstream DAG-like view from one root, depth- and step-capped so
 *     the response stays digestible.
 *
 * EDGE MODEL (Sprint 1 — typed code edges):
 *   store/codeNodes.ts now writes the REAL relation kind (calls / imports /
 *   extends / implements / contains / …). The call trace follows any
 *   symbol→symbol CALL-FLOW edge: we accept the typed `calls` / `imports` /
 *   `extends` / `implements` kinds AND the legacy `related_to` (pre-Sprint-1
 *   / mixed graphs), while EXCLUDING the symbol-level `contains` (parent→
 *   child structural, not a call) and the `describes` context bridge. The
 *   structural discriminator — both endpoints are code_symbol nodes — still
 *   gates first, so file→symbol and context→symbol edges never enter.
 *
 *   BACK-COMPAT: a workspace last indexed before Sprint 1 still has only
 *   `related_to` symbol edges; those are accepted by the legacy arm of the
 *   filter, so legacy and mixed graphs still produce traces. Re-index with
 *   `atlas index --force` to repopulate the typed kinds.
 */

/** Public per-step record returned to CLI / MCP callers. */
export interface ProcessStep {
    /** 0 = entry, 1 = direct callee, 2 = callee-of-callee, etc. */
    depth: number;
    /** Qualified id (e.g. "code-symbol:my-repo/src/foo.ts#bar"). */
    symbolId: string;
    /** Human-readable symbol name (from metadata.name). */
    name: string;
    /** "path:startLine" — convenient for IDE jumps. */
    file: string;
    /** True iff this symbol has zero outbound call edges within the
     *  indexed scope — a leaf in the trace. */
    isTerminal: boolean;
}

/** RD-Mcommload — bound on rows loaded into the process trace.
 *  Edges are NOT capped here: listEdges() self-bounds via its own
 *  MAX_PAGES guard, and slicing a target-agnostic tail would silently
 *  drop a symbol's only call edge (see the listEdges() call in step 3).
 *  Raised 10k→50k (RD-caps): 10k truncated a real (v3-sized) workspace so a
 *  trace could hit false terminals (a call target beyond the first 10k nodes
 *  looked unreachable). Memory scales with actual nodes, not the cap. */
export const MAX_PROCESS_NODES = 50_000;

export interface ProcessTrace {
    workspace: string;
    /** What the caller asked for (the raw `entry` arg). */
    entryQuery: string;
    /** What we resolved to. May differ from entryQuery when the query
     *  was a bare name or a qualified-suffix match. */
    entrySymbolId: string;
    /** Present iff multiple symbols matched the query. Lets the caller
     *  refine by passing one of these as the next `entry`. The chosen
     *  entrySymbolId is candidates[0]. */
    candidates?: string[];
    /** BFS order: depth ascending, then symbolId ascending within a depth.
     *  Stable across runs given the same graph. */
    steps: ProcessStep[];
    stepCount: number;
    maxDepthReached: number;
    /** True iff we stopped because the depth cap fired AND there were
     *  still unexplored callees at the frontier. False if every frontier
     *  symbol was already terminal. */
    truncatedAtDepth: boolean;
}

/** Minimum read surface traceProcess needs from EmbeddedLore. Kept as a
 *  duck-type interface (not an import of EmbeddedLore) so this module
 *  stays trivially testable with a hand-rolled fake — same pattern as
 *  CommunityReader in communities/index.ts. */
export interface ProcessReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
    listEdges(pageSize?: number): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
}

export interface TraceProcessOpts {
    /** Cap on traversal depth. Default 8 — deep enough for almost any
     *  realistic call chain, shallow enough that the trace stays
     *  readable. */
    maxDepth?: number;
    /** Cap on total steps. Default 200 — backstop for highly-fanned
     *  graphs where depth alone won't bound output size. */
    maxSteps?: number;
}

interface CodeSymbolRow {
    id: string;
    label?: string;
    metadata?: string | Record<string, unknown> | null;
}

interface SymbolMeta {
    name?: string;
    qualifiedName?: string;
    kind?: string;
    filePath?: string;
    startLine?: number;
}

export async function traceProcess(
    client: ProcessReader,
    workspace: string,
    entry: string,
    opts: TraceProcessOpts = {},
): Promise<ProcessTrace> {
    const maxDepth = opts.maxDepth ?? 8;
    const maxSteps = opts.maxSteps ?? 200;

    // ── 1. Read code_symbol rows in this workspace (RD-Mcommload — bounded).
    const symbolRows = (await client.listNodes('code_symbol', undefined, workspace, MAX_PROCESS_NODES)) as CodeSymbolRow[];

    // Build helper maps: id → meta (for name/file lookups), plus a name-
    // → ids index for entry resolution.
    const idToMeta = new Map<string, SymbolMeta>();
    const nameToIds = new Map<string, string[]>();
    const symbolIdSet = new Set<string>();
    for (const s of symbolRows) {
        const meta = parseMaybeJson<SymbolMeta>(s.metadata) ?? {};
        idToMeta.set(s.id, meta);
        symbolIdSet.add(s.id);
        const nm = meta.name ?? '';
        if (nm) {
            const arr = nameToIds.get(nm);
            if (arr) arr.push(s.id);
            else nameToIds.set(nm, [s.id]);
        }
    }

    // ── 2. Resolve `entry` to one or more symbolIds.
    //
    // Match priority:
    //   1. Exact name (metadata.name) — most common case, what the
    //      caller types ("mount", "handleLogin").
    //   2. Qualified-suffix on the symbolId (e.g. "MyClass.mount" or
    //      "src/foo.ts#mount") — lets the caller disambiguate when
    //      they already know the qualified form.
    //   3. Exact symbolId match — escape hatch for callers that already
    //      have the id from a previous trace's candidates[].
    let matched: string[] = [];
    if (nameToIds.has(entry)) {
        matched = [...nameToIds.get(entry)!];
    } else if (symbolIdSet.has(entry)) {
        matched = [entry];
    } else {
        // Suffix match on symbolId (cheap fallback — handles "Foo.bar"
        // and "path/file.ts#bar" style hints).
        for (const id of symbolIdSet) {
            if (id.endsWith(entry) || id.endsWith(`#${entry}`) || id.endsWith(`.${entry}`)) {
                matched.push(id);
            }
        }
    }

    if (matched.length === 0) {
        throw new Error(`entry not found: no code_symbol matches '${entry}' in workspace '${workspace}'`);
    }

    // Deterministic pick + candidate list (only set if ambiguous).
    matched.sort();
    const entrySymbolId = matched[0]!;
    const candidates = matched.length > 1 ? matched : undefined;

    // ── 3. Build a symbol-level outbound adjacency from call-flow edges.
    //
    // Filter discriminator (per the file header note): we keep ONLY edges
    // where BOTH endpoints are code_symbol nodes. That drops:
    //   - file → symbol containment (source is a code_file id)
    //   - code_context → symbol bridges (source is a code-context id)
    // and keeps the call/import/extends fan-out we want to follow.
    //
    // Sprint 1: with typed edges we ADDITIONALLY exclude the symbol-level
    // `contains` (parent→child structural) and the `describes` context
    // bridge — neither is a call-flow step. Everything else (real `calls`/
    // `imports`/`extends`/`implements`, or legacy `related_to`) is followed.
    // Load the FULL edge set — listEdges() already bounds itself via its
    // own MAX_PAGES guard, so there is no memory regression here. We must
    // NOT slice a target-agnostic tail: listEdges() returns edges in the
    // backend's paginated offset order (not grouped by node), so dropping
    // the tail can discard a symbol's only inbound/outbound coupling edge
    // and silently turn a referenced symbol into a false terminal. This
    // mirrors the dead-code path in src/mcp/embeddedReader.ts, which
    // removed the same slice for exactly this reason.
    const allEdges = await client.listEdges();
    const outbound = new Map<string, Set<string>>();
    for (const e of allEdges) {
        if (e.relation === 'contains' || e.relation === 'describes') continue;
        if (!symbolIdSet.has(e.sourceId) || !symbolIdSet.has(e.targetId)) continue;
        if (e.sourceId === e.targetId) continue; // self-loop — no story value
        let bucket = outbound.get(e.sourceId);
        if (!bucket) { bucket = new Set<string>(); outbound.set(e.sourceId, bucket); }
        bucket.add(e.targetId);
    }

    // ── 4. BFS from entrySymbolId.
    //
    // Determinism: at every step we sort by symbolId before enqueuing so
    // two runs against the same graph emit steps in the same order. The
    // overall sort order of `steps` is (depth asc, symbolId asc), enforced
    // both during enqueue AND in a final sort pass (cheap insurance).
    const visited = new Set<string>([entrySymbolId]);
    type Frontier = { id: string; depth: number };
    let frontier: Frontier[] = [{ id: entrySymbolId, depth: 0 }];
    const steps: ProcessStep[] = [];
    let maxDepthReached = 0;
    let truncatedAtDepth = false;

    while (frontier.length > 0) {
        // Sort the frontier (same-depth tie-break) for stable enqueue order.
        frontier.sort((a, b) => a.id.localeCompare(b.id));
        const nextFrontier: Frontier[] = [];

        for (const f of frontier) {
            if (steps.length >= maxSteps) break;
            const meta = idToMeta.get(f.id) ?? {};
            const callees = outbound.get(f.id);
            const isTerminal = !callees || callees.size === 0;

            steps.push({
                depth: f.depth,
                symbolId: f.id,
                name: meta.name ?? meta.qualifiedName ?? f.id,
                file: meta.filePath
                    ? `${meta.filePath}${meta.startLine ? `:${meta.startLine}` : ''}`
                    : '',
                isTerminal,
            });
            if (f.depth > maxDepthReached) maxDepthReached = f.depth;

            if (isTerminal) continue;
            // Don't expand past the depth cap. If we have unexplored
            // callees here, mark the trace truncated.
            if (f.depth >= maxDepth) {
                truncatedAtDepth = true;
                continue;
            }
            for (const cid of callees) {
                if (visited.has(cid)) continue;
                visited.add(cid);
                nextFrontier.push({ id: cid, depth: f.depth + 1 });
            }
        }

        // maxSteps cutoff during the inner loop: surface remaining
        // frontier as "truncated" so the caller knows the picture isn't
        // complete. (truncatedAtDepth name is slightly imprecise here —
        // it covers both depth- and step-cap truncation. The
        // semantically-distinct stepCount vs maxSteps comparison is
        // implicit in stepCount === maxSteps.)
        if (steps.length >= maxSteps) {
            if (nextFrontier.length > 0) truncatedAtDepth = true;
            break;
        }

        frontier = nextFrontier;
    }

    // Final stable sort — depth asc, symbolId asc. The BFS already
    // produces this order in practice but the explicit sort is cheap
    // insurance against any future loop refactor.
    steps.sort((a, b) => (a.depth - b.depth) || a.symbolId.localeCompare(b.symbolId));

    return {
        workspace,
        entryQuery: entry,
        entrySymbolId,
        ...(candidates ? { candidates } : {}),
        steps,
        stepCount: steps.length,
        maxDepthReached,
        truncatedAtDepth,
    };
}

/** metadata can come back as a JSON string OR an already-parsed object
 *  depending on the read path. Tolerate both. (Identical helper to the
 *  one in communities/index.ts — kept local to avoid a cross-module
 *  import for a 6-line utility.) */
function parseMaybeJson<T>(raw: unknown): T | null {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw as T;
    if (typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}
