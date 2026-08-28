/**
 * analytics/layerViolations.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * User-declared LayerSpec rule check — pre-configured ui/core/plugins layers.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Detects edges that violate user-declared layer rules. A LayerSpec
 * declares which paths belong to which layer + which directions are
 * allowed:
 *
 *   layers:
 *     ui:      ['ui/**']
 *     core:    ['packages/lore/**']
 *     plugins: ['packages/lore-plugin-*\/**']
 *   allowed:
 *     ui      → core
 *     plugins → core
 *   denied:
 *     ui      ⇏ plugins
 *     core    ⇏ plugins        # core stays plugin-agnostic
 *
 * Edges that match a denied rule (or any rule not in the allowed set)
 * become Violations. The default LayerSpec for Lore ships in
 * defaultLoreLayerSpec().
 */

import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface LayerSpec {
    /** layerName → glob-like path patterns. Patterns use `**` for any
     *  number of dirs and `*` for one path component. */
    layers: Record<string, string[]>;
    /** Edges from→to that ARE permitted. */
    allowed: Array<{ from: string; to: string }>;
}

export interface LayerViolation {
    sourceId: string;
    targetId: string;
    sourceLayer: string;
    targetLayer: string;
    kind: string;  // edge kind that violated
    reason: string;
}

/** PF-1 — a regex that never matches, used to neutralize a pathological
 *  (caller-supplied) pattern without a throw. A dropped rule simply matches
 *  nothing, exactly like walker.compileGlob's ReDoS-safe fallback. */
const NEVER_MATCH = /(?!)/;

/** PF-1 — compiled-pattern cache. layerSpec is a caller-supplied MCP tool arg,
 *  so layerOf() can be invoked per-pattern × per-relation; memoize so each
 *  distinct pattern compiles once, not once per edge. Keyed by raw pattern. */
const _regexCache = new Map<string, RegExp>();

/**
 * Pattern → regex. `**` matches any number of path segments; `*`
 * matches a single segment.
 *
 * PF-1 (ATL-026 class) — `layerSpec` is UNTRUSTED (an MCP-tool override). A
 * wildcard-dense pattern translates to adjacent `[^/]*`/`.*` quantifiers that
 * backtrack catastrophically against the per-relation match run (ReDoS →
 * analysis hangs). Bound it the same way walker.compileGlob does: collapse `*`
 * runs and drop absurdly long / wildcard-dense patterns to a never-match.
 */
function patternToRegex(pattern: string): RegExp {
    const cached = _regexCache.get(pattern);
    if (cached) return cached;

    // Collapse runs of `*` (`***` ≡ `**`) so a pathological pattern can't
    // smuggle past the density cap, then reject absurdly long / dense patterns.
    const collapsed = pattern.replace(/\*{2,}/g, '**');
    if (collapsed.length > 512 || (collapsed.match(/\*/g)?.length ?? 0) > 24) {
        _regexCache.set(pattern, NEVER_MATCH);
        return NEVER_MATCH;
    }

    const escaped = collapsed
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLE__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE__/g, '.*');
    // A malformed translated pattern must never crash the analysis — a bad rule
    // simply matches nothing (mirrors walker.ts RD-P1).
    let re: RegExp;
    try {
        re = new RegExp('^' + escaped + '$');
    } catch {
        re = NEVER_MATCH;
    }
    _regexCache.set(pattern, re);
    return re;
}

function layerOf(filePath: string, spec: LayerSpec): string | null {
    for (const [layer, patterns] of Object.entries(spec.layers)) {
        for (const pattern of patterns) {
            if (patternToRegex(pattern).test(filePath)) return layer;
        }
    }
    return null;
}

export function defaultLoreLayerSpec(): LayerSpec {
    return {
        layers: {
            ui:      ['ui/**'],
            core:    ['packages/lore/**'],
            plugins: ['packages/lore-plugin-*/**'],
        },
        allowed: [
            { from: 'ui',      to: 'core'    },
            { from: 'plugins', to: 'core'    },
            { from: 'ui',      to: 'ui'      },
            { from: 'core',    to: 'core'    },
            { from: 'plugins', to: 'plugins' },
        ],
    };
}

export function layerViolations(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    spec: LayerSpec = defaultLoreLayerSpec(),
    options: { edgeKinds?: ReadonlySet<string> } = {},
): LayerViolation[] {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);

    const allowedSet = new Set(spec.allowed.map((a) => `${a.from}→${a.to}`));
    const violations: LayerViolation[] = [];

    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        const sourceSym = rel.sourceId.startsWith('file:')
            ? null
            : table.byId.get(rel.sourceId);
        const targetSym = table.byId.get(rel.targetId);
        if (!targetSym) continue;

        const sourcePath = sourceSym?.file ?? rel.sourceId.replace(/^file:/, '');
        const targetPath = targetSym.file;

        const sourceLayer = layerOf(sourcePath, spec);
        const targetLayer = layerOf(targetPath, spec);
        if (!sourceLayer || !targetLayer) continue;
        if (sourceLayer === targetLayer) continue; // intra-layer edges are fine

        if (!allowedSet.has(`${sourceLayer}→${targetLayer}`)) {
            violations.push({
                sourceId: rel.sourceId,
                targetId: rel.targetId,
                sourceLayer,
                targetLayer,
                kind: rel.kind,
                reason: `${sourceLayer} → ${targetLayer} not in LayerSpec.allowed`,
            });
        }
    }

    return violations;
}
