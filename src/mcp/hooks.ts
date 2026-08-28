/**
 * mcp/hooks.ts — the "context layer" dispatcher behind POST /hooks/context.
 *
 * This is what turns Atlas from a set of tools the agent MAY call into a layer
 * it is automatically GUIDED through. The Claude Code PreToolUse/PostToolUse
 * hooks (installed by `atlas wire`) POST the intercepted tool call here; we
 * return a short `additionalContext` string the agent sees BEFORE it searches,
 * edits, or commits — nudging it to the right Atlas tool at the right moment.
 *
 * ── v2: LIVE ENRICHMENT (gated) ──────────────────────────────────────────────
 * v1 was pure/zero-I/O because calling the embedded-Lore tools (knowledge_
 * search / atlas_blast_radius) per keystroke put concurrent query pressure on
 * the native LanceDB/Kùzu layer and crashed the daemon outright (verified).
 * That constraint is now lifted for pre-edit/pre-search by mcp/hookEnrich.ts:
 * a single-flight, 700ms-budgeted, 60s-cached, fail-open live lookup that can
 * never error, hang, or stack concurrent native reads. This dispatcher takes
 * an optional HookEnricher delegate; when it yields non-empty text for the
 * event, that text REPLACES the static nudge, and the static nudge remains
 * the fallback for '' / throw / no-delegate — so buildHookContext(null, p)
 * behaves exactly as v1 did.
 *
 * HARD CONTRACT: never throw, never block, instant. The hook client also bounds
 * this with its own timeout and fails open.
 */

export interface HookParams {
    event: 'pre-search' | 'pre-edit' | 'post-bash';
    /** Resolved before this dispatcher runs — either the explicit workspace a
     *  per-repo hook baked in at install time, or what the caller (POST
     *  /hooks/context, server.ts) resolved from the request's `cwd` via
     *  src/pathWorkspaceResolver.ts (auto-wire Part 2). buildHookContext stays
     *  pure/zero-I/O either way: it only ever consumes the already-resolved
     *  name, never a raw path. */
    workspace?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
}

/** v2 live-enrichment delegate. Each function gets the already-resolved
 *  workspace (HookParams.workspace) plus what the static nudge already
 *  extracted, and must return '' when it has no live answer — the static
 *  nudge is the fallback for '' / throw / absent delegate, so passing null
 *  keeps exact v1 behavior. Implemented by mcp/hookEnrich.ts (single-flight,
 *  700ms budget, 60s cache, fail-open). */
export interface HookEnricher {
    /** Live blast-radius advice for an edit touching `symbol` in `filePath`. */
    preEdit?: (workspace: string, filePath: string, symbol: string | null) => Promise<string>;
    /** Live definition + caller-count advice for an identifier-shaped query. */
    preSearch?: (workspace: string, query: string) => Promise<string>;
}

/** Build the additionalContext string for an intercepted tool call. Returns ''
 *  when there's nothing worth saying (the common case). Static nudges are
 *  synchronous; the live delegate (when provided and the event warrants it)
 *  is awaited inside the same never-throw envelope. */
export async function buildHookContext(enrich: HookEnricher | null, p: HookParams): Promise<string> {
    try {
        if (p.event === 'pre-search') return await preSearch(p, enrich ?? undefined);
        if (p.event === 'pre-edit') return await preEdit(p, enrich ?? undefined);
        if (p.event === 'post-bash') return postBash(p);
    } catch {
        /* the agent must never be blocked by an Atlas hiccup */
    }
    return '';
}

// ── pre-search: nudge structural queries toward the graph ────────────────────

async function preSearch(p: HookParams, enrich?: HookEnricher): Promise<string> {
    const q = strOf(p.toolInput['pattern']) || strOf(p.toolInput['query']);
    // Only nudge when the query looks like a CODE IDENTIFIER (a symbol/type/fn) —
    // that's where the graph beats grep. Skip literal-string / regex searches.
    if (!/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(q)) return '';
    // v2: when a delegate + resolved workspace are available, prefer the LIVE
    // answer (definition site + real caller count) over the static reminder.
    const live = p.workspace && enrich?.preSearch
        ? await safeEnrich(() => enrich!.preSearch!(p.workspace!, q))
        : '';
    if (live) return live;
    return `🔎 \`${q}\` looks like a symbol — Atlas can answer structurally: try \`atlas_call_graph\` / \`atlas_subgraph\` (or \`knowledge_recall\`) before scanning the whole tree with grep.`;
}

async function preEdit(p: HookParams, enrich?: HookEnricher): Promise<string> {
    const file = strOf(p.toolInput['file_path']) || strOf(p.toolInput['path']);
    if (!file) return '';
    const parts: string[] = [];

    // 1. Blast-radius reminder, naming the symbol being changed when we can spot it.
    //    v2: with a delegate + resolved workspace, the LIVE answer (real d1
    //    caller files from the index) replaces the static reminder; any '' /
    //    throw falls back to the static line unchanged.
    const symbol = extractSymbol(p.toolInput);
    if (symbol) {
        const live = p.workspace && enrich?.preEdit
            ? await safeEnrich(() => enrich!.preEdit!(p.workspace!, file, symbol))
            : '';
        parts.push(live || `⚠️ You're changing \`${symbol}\` — run \`atlas_blast_radius({symbol:"${symbol}"})\` FIRST to see what breaks (d1 = WILL BREAK), and cover those callers before committing.`);
    }

    // 2. Schema-change guard.
    if (isSchemaFile(file)) {
        parts.push(`🗄️ Schema file — before/after this edit run \`atlas_schema_drift\` against the live DB dump, recall prior schema decisions, and log the WHY with \`schema_confirm\` so migrations stay minimal & back-compatible.`);
    }

    // 3. General consult reminder for any substantive source edit (keeps the
    //    "check knowledge first" habit without a per-keystroke DB query).
    if (parts.length === 0 && isSourceFile(file)) {
        const base = file.split('/').pop() ?? file;
        parts.push(`📌 Editing \`${base}\` — recall any Atlas decisions/conventions/bug-patterns for it (\`knowledge_recall\`) so you don't contradict a prior call.`);
    }

    return parts.join('\n');
}

/** Run one delegate call that must never break the hook: any throw → '' so the
 *  static nudge stands. (hookEnrich itself never throws; this guards the
 *  contract against ANY delegate, present or future.) */
async function safeEnrich(fn: () => Promise<string>): Promise<string> {
    try {
        return await fn();
    } catch {
        return '';
    }
}

// ── post-bash: nudge a reindex after a commit ────────────────────────────────

function postBash(p: HookParams): string {
    const cmd = strOf(p.toolInput['command']);
    if (cmd && /\bgit\s+commit\b/.test(cmd)) {
        // p.workspace is slug-validated at wire time (WORKSPACE_SLUG_RE) — safe
        // to interpolate. Naming it keeps the reindex out of the misfiling trap
        // (a bare run would otherwise fall back to the machine-global default).
        const ws = p.workspace ? ` --workspace ${p.workspace}` : '';
        // Fire-and-forget by design (RD-idx-async): on a large repo, parsing +
        // resolution alone can run for minutes, so this returns almost
        // immediately (queued) rather than blocking the caller — no need to sit
        // and wait on it before moving on. `atlas index status${ws}` checks later.
        return `🔄 Commit detected — the Atlas code index is now behind HEAD. Run \`atlas index .${ws}\` so blast-radius / search stay accurate — it queues in the background and returns right away (check with \`atlas index status${ws}\` if you need to confirm it's done first; the pre-commit hook exports memory, but the code graph still needs this separately).`;
    }
    return '';
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Best-effort symbol extraction from an edit's replaced text — a definition
 *  keyword + name. Returns null when nothing clear is found. */
function extractSymbol(toolInput: Record<string, unknown>): string | null {
    const text = strOf(toolInput['old_string']) || strOf(toolInput['new_string']);
    if (!text) return null;
    const m = /\b(?:function|def|fn|class|struct|interface|type|impl|func)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    return m ? m[1]! : null;
}

function isSchemaFile(file: string): boolean {
    return /\.(sql|prisma|graphql|gql)$/i.test(file) || /(^|\/)migrations?\//i.test(file);
}

function isSourceFile(file: string): boolean {
    return /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|kt|swift|c|cc|cpp|h|hpp|scala)$/i.test(file);
}

function strOf(v: unknown): string {
    return typeof v === 'string' ? v : '';
}
