/**
 * mcp/tools/findSymbol.ts — shared, repo-aware symbol resolution for the
 * call-graph / blast-radius tools.
 *
 * RC-F3 — the old inline `findSymbol` (duplicated in callGraph.ts + blastRadius.ts)
 * resolved a bare NAME by returning the FIRST match:
 *
 *     for (const sym of table.all) if (sym.name === nameOrId) return sym;
 *
 * In a workspace holding multiple repos (co-loaded via `atlas group load`) two
 * different codebases can each declare a symbol with the same bare name
 * (`handler`, `main`, `Service`, …). A bare-name lookup then silently answered
 * for whichever repo happened to be indexed first — call_graph / blast_radius
 * quietly reported the wrong codebase with no signal to the caller.
 *
 * This resolver instead DISTINGUISHES:
 *   - a unique match (by id, qualified name, or bare name)   → { found }
 *   - >1 candidate spanning MORE THAN ONE repo               → { ambiguous }
 *   - >1 candidate all in the SAME repo (real overloads /    → { found } (first;
 *     same-file duplicates) — not a cross-repo hazard          the historical,
 *                                                               correct behavior)
 *   - nothing                                                → { not_found }
 *
 * The graph identity is the (prefix-stripped) node id `"<repo>/<uid>"`
 * (store/codeNodes.ts `qualify`), so the repo is the id up to the first '/'.
 * A caller can disambiguate by passing a fully-qualified id (`<repo>/<uid>`) or,
 * via the tools, a `repo:` qualifier that scopes the candidate set.
 */

import type { ParsedSymbol } from '../../parser/types.js';
import type { SymbolTable } from '../../resolver/symbolTable.js';

export type FindSymbolResult =
    | { kind: 'found'; symbol: ParsedSymbol }
    | { kind: 'ambiguous'; candidates: ParsedSymbol[] }
    | { kind: 'not_found' };

/** Repo namespace of a reconstructed symbol id: the segment before the first
 *  '/'. F1 qualifies node ids as `<repo>/<uid>`; a legacy unqualified id (no
 *  '/') has no repo namespace and is treated as its own single bucket. */
export function repoOf(symbolId: string): string {
    const slash = symbolId.indexOf('/');
    return slash === -1 ? '' : symbolId.slice(0, slash);
}

/** Count the distinct repos a candidate set spans. */
function distinctRepos(candidates: readonly ParsedSymbol[]): Set<string> {
    const repos = new Set<string>();
    for (const c of candidates) repos.add(repoOf(c.id));
    return repos;
}

/**
 * Resolve `nameOrId` to a single symbol, or report ambiguity.
 *
 * `opts.repo` (optional) scopes a bare-name / qualified-name lookup to one repo
 * namespace, so a caller who KNOWS the repo can disambiguate a cross-repo bare
 * name without spelling out the full id.
 */
export function findSymbol(
    table: SymbolTable,
    nameOrId: string,
    opts: { repo?: string } = {},
): FindSymbolResult {
    // 1. Exact id — always unambiguous (ids are unique by construction).
    const byId = table.byId.get(nameOrId);
    if (byId) return { kind: 'found', symbol: byId };

    const scope = (list: readonly ParsedSymbol[]): ParsedSymbol[] =>
        opts.repo ? list.filter((s) => repoOf(s.id) === opts.repo) : [...list];

    // 2. Qualified-name match.
    const byQual = scope(table.byQualifiedName.get(nameOrId) ?? []);
    const qualResult = disambiguate(byQual);
    if (qualResult) return qualResult;

    // 3. Bare-name match (workspace-wide byName index; O(1)).
    const byName = scope(table.byName.get(nameOrId) ?? []);
    const nameResult = disambiguate(byName);
    if (nameResult) return nameResult;

    return { kind: 'not_found' };
}

/** Turn a candidate list into a found/ambiguous result, or null if empty.
 *  Multiple candidates in ONE repo (overloads / same-file dups) resolve to the
 *  first — the historical behavior. Multiple candidates across DIFFERENT repos
 *  are a real cross-codebase hazard → ambiguous. */
function disambiguate(candidates: ParsedSymbol[]): FindSymbolResult | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { kind: 'found', symbol: candidates[0]! };
    if (distinctRepos(candidates).size <= 1) return { kind: 'found', symbol: candidates[0]! };
    return { kind: 'ambiguous', candidates };
}
