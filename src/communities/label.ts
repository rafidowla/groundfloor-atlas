/**
 * communities/label.ts — Wave 4 community labeling heuristic.
 *
 * Given a community's member files (and a few of their symbols), pick
 * a human-readable label like "locale" or "parser" instead of
 * "community-7". The label is the difference between an agent
 * getting "the module at src/locale/" vs "a flat list of 14
 * function names" — same info content, vastly different ergonomics.
 *
 * Heuristic priority:
 *   1. LONGEST common directory prefix shared by ≥60% of files —
 *      almost always the right answer for codebases that organize
 *      by feature/module. Last path segment becomes the label.
 *   2. If no meaningful prefix: the most-frequent meaningful
 *      symbol-name root (camelCase first token, dropping common
 *      verbs that don't carry topic signal).
 *   3. Last resort: "community-<id>".
 *
 * The `rationale` string is for debugging / user-facing tooltips
 * — it explains WHY this label was chosen so the heuristic is
 * audit-able instead of a black box.
 */

export interface LabelInput {
    communityId: number;
    memberFiles: string[];
    memberSymbols: Array<{ name: string; kind: string }>;
}

export interface LabelResult {
    label: string;
    rationale: string;
}

/** Threshold for "common" prefix — 60% of members must share it. */
const PREFIX_THRESHOLD = 0.6;

/** Path segments that are uninformative as a label on their own — we
 *  refuse to label a community "src" or "lib" because it tells the
 *  reader nothing about WHAT's in the module. */
const UNINFORMATIVE_SEGMENTS = new Set([
    '', 'src', 'lib', 'app', 'apps', 'pkg', 'pkgs', 'packages',
    'source', 'sources', 'code', 'main', 'index',
]);

/** Verbs that carry no topic signal — "getThing" is about "thing",
 *  not "get". Used to skip the first camelCase token when computing
 *  the symbol-root fallback. */
const STOPWORD_VERBS = new Set([
    'get', 'set', 'is', 'has', 'handle', 'do', 'make', 'build',
    'create', 'new', 'run', 'init', 'fn', 'on', 'add', 'remove',
    'update', 'delete', 'find', 'to', 'from', 'with', 'use',
]);

export function labelCommunity(input: LabelInput): LabelResult {
    const { communityId, memberFiles, memberSymbols } = input;

    // ── Strategy 1: common directory prefix ────────────────────────
    const prefix = commonDirPrefix(memberFiles, PREFIX_THRESHOLD);
    if (prefix !== null) {
        const segments = prefix.split('/').filter((s) => s.length > 0);
        // Walk from the end picking the last informative segment so we
        // never label a community "src" just because every file lives
        // under src/.
        for (let i = segments.length - 1; i >= 0; i--) {
            const seg = segments[i]!;
            if (!UNINFORMATIVE_SEGMENTS.has(seg.toLowerCase())) {
                const pct = Math.round(PREFIX_THRESHOLD * 100);
                return {
                    label: seg,
                    rationale: `${pct}%+ share prefix ${prefix}`,
                };
            }
        }
    }

    // ── Strategy 2: most-frequent meaningful symbol-name root ──────
    const rootCounts = new Map<string, number>();
    for (const sym of memberSymbols) {
        const root = meaningfulRoot(sym.name);
        if (!root) continue;
        rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    }
    if (rootCounts.size > 0) {
        let bestRoot = '';
        let bestCount = 0;
        // Sort keys for determinism on ties (alphabetical wins).
        const keys = Array.from(rootCounts.keys()).sort();
        for (const k of keys) {
            const c = rootCounts.get(k)!;
            if (c > bestCount) {
                bestCount = c;
                bestRoot = k;
            }
        }
        if (bestRoot) {
            return {
                label: bestRoot,
                rationale: `top symbol root: ${bestRoot}`,
            };
        }
    }

    // ── Strategy 3: irreducible fallback ───────────────────────────
    return {
        label: `community-${communityId}`,
        rationale: 'no common prefix or symbol root',
    };
}

/**
 * Longest directory prefix shared by at least `threshold` fraction of
 * `files`. Returns null when nothing qualifies (e.g. files scattered
 * across unrelated trees). Comparison is on whole path segments —
 * we never return a partial-segment prefix like "src/loc".
 */
function commonDirPrefix(files: string[], threshold: number): string | null {
    if (files.length === 0) return null;
    const required = Math.ceil(files.length * threshold);

    // Build segment lists once.
    const segLists = files.map((f) => f.split('/').slice(0, -1)); // drop filename

    // Try progressively shorter prefixes until ≥required files match.
    // Start with the longest plausible — the segment list of the file
    // with the deepest path. This is a small constant; we don't need
    // a fancier algorithm.
    let maxDepth = 0;
    for (const segs of segLists) if (segs.length > maxDepth) maxDepth = segs.length;

    for (let depth = maxDepth; depth >= 1; depth--) {
        const counts = new Map<string, number>();
        for (const segs of segLists) {
            if (segs.length < depth) continue;
            const prefix = segs.slice(0, depth).join('/');
            counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        }
        // Find the best-matching prefix at this depth.
        let bestPrefix = '';
        let bestCount = 0;
        for (const [p, c] of counts) {
            if (c > bestCount) {
                bestCount = c;
                bestPrefix = p;
            }
        }
        if (bestCount >= required && bestPrefix) return bestPrefix;
    }
    return null;
}

/**
 * Extract a meaningful "root" token from a symbol name. Splits
 * camelCase / snake_case / kebab-case, drops a leading stopword
 * verb, lowercases the result. Returns null if nothing useful is left.
 */
function meaningfulRoot(name: string): string | null {
    if (!name) return null;
    // Strip non-alnum from the edges (e.g. "_foo" → "foo").
    const cleaned = name.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!cleaned) return null;

    // Split on snake/kebab + camelCase boundaries.
    const tokens = cleaned
        .replace(/[_\-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);

    if (tokens.length === 0) return null;

    // Drop a leading stopword verb if there's something after it.
    const first = tokens[0]!;
    if (tokens.length > 1 && STOPWORD_VERBS.has(first)) return tokens[1]!;
    return first;
}
