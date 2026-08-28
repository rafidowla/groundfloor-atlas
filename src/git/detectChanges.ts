/**
 * git/detectChanges.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * `git diff` mapped to changed symbols by byte-range overlap.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 5 (git signals — host-agnostic).
 *
 * Maps git diff hunks to ParsedSymbol affected by the change. Used by
 * the pre-commit gate / Trustworthiness Plan Phase 2 ("does my edit
 * affect a high-impact symbol?") and by `code_detect_changes` MCP tool.
 */

import { spawnSync } from 'node:child_process';
import type { ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export type DetectScope = 'staged' | 'unstaged' | 'compare';

export interface ChangedRange {
    file: string;
    /** First changed line in the post-edit file (1-based). */
    startLine: number;
    /** Last changed line in the post-edit file (1-based, inclusive). */
    endLine: number;
}

export interface AffectedSymbol {
    symbol: ParsedSymbol;
    /** Which line range(s) inside the symbol were touched. */
    overlappingRanges: ChangedRange[];
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse unified-diff hunks into per-file changed-line ranges (post-edit
 * line numbering).
 */
function parseDiff(stdout: string): ChangedRange[] {
    const ranges: ChangedRange[] = [];
    let currentFile: string | null = null;

    for (const line of stdout.split('\n')) {
        if (line.startsWith('+++ ')) {
            // +++ b/path/to/file or +++ /dev/null
            const target = line.slice(4).trim();
            if (target === '/dev/null') {
                currentFile = null;
                continue;
            }
            currentFile = target.replace(/^b\//, '');
            continue;
        }
        const m = HUNK_HEADER_RE.exec(line);
        if (m && currentFile) {
            const startLine = parseInt(m[1], 10);
            const length = m[2] ? parseInt(m[2], 10) : 1;
            if (length === 0) continue; // pure deletion — no post-edit lines
            ranges.push({
                file: currentFile,
                startLine,
                endLine: startLine + length - 1,
            });
        }
    }
    return ranges;
}

/**
 * Capture changed-line ranges via `git diff` for the requested scope.
 */
export function getChangedRanges(
    repoRoot: string,
    scope: DetectScope,
    baseRef?: string,
): ChangedRange[] {
    const args = ['diff', '--unified=0', '--no-color'];
    if (scope === 'staged') args.push('--cached');
    else if (scope === 'compare') {
        if (!baseRef) throw new Error('baseRef required for scope=compare');
        // RD-F02 — `baseRef` is caller-supplied. Reject anything outside the
        // ref charset (no leading `-`, no spaces, no shell/option metacharacters)
        // and pass `--end-of-options` so git can never interpret the ref as a
        // flag (option injection).
        if (!/^[a-zA-Z0-9._/-]+$/.test(baseRef) || baseRef.startsWith('-')) {
            throw new Error(`Invalid baseRef: ${JSON.stringify(baseRef)}`);
        }
        args.push('--end-of-options', `${baseRef}...HEAD`);
    }
    // 'unstaged' uses bare `git diff`

    const result = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30000,
    });
    if (result.status !== 0) return [];
    return parseDiff(result.stdout);
}

/**
 * Find every ParsedSymbol whose byte range overlaps a changed line.
 */
export function detectChanges(
    repoRoot: string,
    table: SymbolTable,
    scope: DetectScope,
    baseRef?: string,
): AffectedSymbol[] {
    const ranges = getChangedRanges(repoRoot, scope, baseRef);
    const affected = new Map<string, AffectedSymbol>();

    for (const range of ranges) {
        const fileMap = table.byFile.get(range.file);
        if (!fileMap) continue;
        for (const [, symbols] of fileMap) {
            for (const sym of symbols) {
                if (sym.byteRange.startLine > range.endLine) continue;
                if (sym.byteRange.endLine < range.startLine) continue;
                const existing = affected.get(sym.id);
                if (existing) existing.overlappingRanges.push(range);
                else affected.set(sym.id, { symbol: sym, overlappingRanges: [range] });
            }
        }
    }

    return Array.from(affected.values());
}
