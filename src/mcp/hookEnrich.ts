/**
 * mcp/hookEnrich.ts — LIVE advisory enrichment for the hook context layer (v2).
 *
 * mcp/hooks.ts v1 was deliberately pure/zero-I/O: calling the embedded-Lore
 * read path on every intercepted Grep/Edit stacked concurrent queries on the
 * native LanceDB/Kùzu layer and crashed the daemon outright (see the hooks.ts
 * header). This module is the v2 upgrade behind the SAME contract: when the
 * live lookup is cheap enough to be safe, the static "run atlas_blast_radius"
 * nudge is REPLACED by the actual answer ("Changing `getEmbeddedLore` breaks
 * N direct callers: src/mcp/embeddedRegistry.ts, …"). Every '' return (and
 * every error) falls back to the static nudge — hooks.ts stays the fallback,
 * this layer only ever ADDS information.
 *
 * The four gates that make per-hook I/O safe here (all load-bearing):
 *   - single-flight: one module-level in-flight flag. A second concurrent
 *     enrich returns '' immediately, so a burst of hooks can never stack
 *     concurrent native reads — the exact v1 crash mode.
 *   - 700ms budget: the whole lookup races a timer. Slow or stuck reads lose
 *     and the caller gets '' well inside the hook client's own 1500ms cap
 *     (scripts/atlas-hook.mjs), so the hook can never hang the agent's tool
 *     call either way.
 *   - 60s TTL cache (max 200 entries, oldest evicted): repeat edits of the
 *     same symbol — the common agent loop — never touch lore twice. Completed
 *     negative results ('') are cached too, so an unindexed/typo'd workspace
 *     costs one lookup per minute, not one per keystroke — but a TIMEOUT is
 *     never cached (it describes a cold store, not the symbol).
 *   - fail-open: every error path returns ''. This module NEVER throws.
 */
import { blastRadius } from '../analytics/index.js';
import type { AtlasConfig } from '../config.js';
import { withEmbeddedLore } from './embeddedRegistry.js';
import { EmbeddedLoreReader } from './embeddedReader.js';
import { findSymbol } from './tools/findSymbol.js';

/** Per-call budget for the ENTIRE live lookup (open + read + resolve). */
const BUDGET_MS = 700;
/** Cache entry lifetime. */
const CACHE_TTL_MS = 60_000;
/** Cache capacity; the oldest entry is evicted on overflow. */
const CACHE_MAX_ENTRIES = 200;

/** Single-flight guard — true while one enrich lookup is in flight. */
let inFlight = false;

/** `${workspace}|${event}|${symbol}` → { value, at }. */
const cache = new Map<string, { value: string; at: number }>();

function cacheGet(key: string): string | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

function cachePut(key: string, value: string): void {
    // Delete-then-set refreshes insertion order so overflow eviction drops the
    // least-recently-written key, not just the oldest first-inserted one.
    cache.delete(key);
    cache.set(key, { value, at: Date.now() });
    if (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
}

/** What a successful live lookup yields: the resolved symbol plus its direct
 * (d1) upstream callers — the same data atlas_blast_radius reports. */
export interface D1Answer {
    /** Display name, same rule as blastRadius.ts thinSymbol. */
    name: string;
    /** File the symbol is defined in (repo-relative). */
    file: string;
    /** d1 upstream callers, one entry per caller symbol. */
    callers: Array<{ file: string }>;
}

/** The lore lookup both enrich entry points share. */
type D1Lookup = (cfg: AtlasConfig, workspace: string, name: string) => Promise<D1Answer | null>;

/** The production lookup: the exact call path runBlastRadius uses —
 * withEmbeddedLore (shared instance, refcounted against LRU eviction) →
 * EmbeddedLoreReader.loadContext (the single code-graph read path) →
 * findSymbol → analytics blastRadius upstream with the default {calls,
 * imports} filter. No BFS logic is duplicated here. */
const defaultLookup: D1Lookup = async (cfg, workspace, name) =>
    await withEmbeddedLore(cfg, workspace, async () => {
        const reader = new EmbeddedLoreReader(cfg);
        const { table, relations } = await reader.loadContext(workspace);
        const resolved = findSymbol(table, name);
        // not_found → nothing to say; ambiguous (same bare name across repos)
        // → refuse to guess, exactly like the atlas_blast_radius tool does.
        if (resolved.kind !== 'found') return null;
        const sym = resolved.symbol;
        const br = blastRadius(sym.id, table, relations, 'upstream', { edgeKinds: new Set(['calls', 'imports']) });
        return {
            name: sym.qualifiedName || sym.name,
            file: sym.file,
            callers: br.d1.map((c) => ({ file: c.file })),
        };
    });

let lookup: D1Lookup = defaultLookup;

/** Test-only: replace the lore lookup so tests can stub hangs / delays /
 *  call counters without opening native stores (same precedent as
 *  embeddedRegistry._resetFailureStateForTests). Pass null to restore. */
export function _setLookupForTests(fn: D1Lookup | null): void {
    lookup = fn ?? defaultLookup;
}

/** Race an ALREADY-STARTED `task` against the budget. Returns null when the
 * budget wins — the losing task keeps running in the background, so its
 * eventual rejection must already be handled by the CALLER (runEnrich's
 * release handler does exactly that); an unhandled rejection would be fatal
 * to the daemon, and a fail-open layer must not crash it. */
async function withinBudget(task: Promise<string>): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), BUDGET_MS);
    });
    try {
        return await Promise.race([task, budget]);
    } finally {
        clearTimeout(timer);
    }
}

/** Shared skeleton: cache → single-flight → budget. Never throws. Only a
 *  COMPLETED result (including a definitive '' — symbol genuinely absent, or
 *  no callers) is cached; a timeout or thrown error is NOT, because those are
 *  transient states of a cold store, not properties of the symbol. Caching
 *  them would let one cold lookup (embedded open alone runs ~2s) suppress the
 *  live answer for a full TTL — the exact opposite of fail-open. */
async function runEnrich(key: string, work: () => Promise<string>): Promise<string> {
    try {
        const hit = cacheGet(key);
        if (hit !== undefined) return hit;
        if (inFlight) return ''; // never queue hook I/O behind another hook
        inFlight = true;
        let task: Promise<string>;
        try {
            task = work(); // start the actual lookup NOW, synchronously, under the guard
        } catch {
            inFlight = false; // work() threw before producing a promise — the .then below never attaches
            return '';
        }
        const release = (): void => {
            inFlight = false;
        };
        task.then(release, release); // guard releases ONLY when the real work settles — losing the 700ms race must not reopen it while the abandoned lookup still reads natively in the background
        const raced = await withinBudget(task);
        if (raced === null) return ''; // budget lost — transient, retry next hook
        cachePut(key, raced);
        return raced;
    } catch {
        return ''; // fail-open, never throw, never block (not cached either)
    }
}

/** Live pre-edit advice. `symbol` is the best-effort name hooks.ts extracted
 *  from the edit; null when nothing clear was found (→ '', the static nudge
 *  stands). Note the cache key is the SYMBOL, not the file: the advice is a
 *  pure function of (workspace, symbol), so keying on the file would only
 *  fragment the cache across edits that touch the same function. */
export async function enrichPreEdit(
    cfg: AtlasConfig,
    workspace: string,
    filePath: string,
    symbol: string | null,
): Promise<string> {
    if (!symbol) return '';
    void filePath; // interface symmetry with the delegate; not needed for the answer
    const key = `${workspace}|pre-edit|${symbol}`;
    return runEnrich(key, async () => {
        const answer = await lookup(cfg, workspace, symbol);
        if (!answer) return '';
        const n = answer.callers.length;
        if (n === 0) return '';
        // Unique caller files, first-seen order, up to 3 named. `k` counts the
        // callers NOT covered by a named file, so "+k more" stays truthful even
        // when several callers share a file (it names CALLERS, not files).
        const files: string[] = [];
        const listed = new Set<string>();
        for (const c of answer.callers) {
            if (files.length < 3 && c.file && !listed.has(c.file)) {
                files.push(c.file);
                listed.add(c.file);
            }
        }
        const covered = answer.callers.filter((c) => listed.has(c.file)).length;
        const k = n - covered;
        const plural = n === 1 ? '' : 's';
        return `⚠️ Changing \`${answer.name}\` breaks ${n} direct caller${plural}: ${files.join(', ')}${k > 0 ? `, +${k} more` : ''}. Update those too or this change won't hold.`;
    });
}

/** Identifier-shaped queries only — the SAME gate the static nudge uses, so
 *  the live layer never widens when the static one stays silent. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;

/** Live pre-search advice: where the identifier is defined + how many direct
 *  callers it has. '' when the query isn't identifier-shaped or the symbol
 *  doesn't resolve. */
export async function enrichPreSearch(
    cfg: AtlasConfig,
    workspace: string,
    query: string,
): Promise<string> {
    if (!IDENTIFIER_RE.test(query)) return '';
    const key = `${workspace}|pre-search|${query}`;
    return runEnrich(key, async () => {
        const answer = await lookup(cfg, workspace, query);
        if (!answer) return '';
        const n = answer.callers.length;
        const plural = n === 1 ? '' : 's';
        return `🔎 \`${query}\` is defined in ${answer.file} and has ${n} direct caller${plural} — atlas_call_graph gives the full picture; grep will only find text matches.`;
    });
}
