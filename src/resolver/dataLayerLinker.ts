/**
 * resolver/dataLayerLinker.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Phase 9b — cross-file code → data-entity linker.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 9b (data-layer code→table linker).
 *
 * Problem:
 *   The Phase 9 walkers emit `table`-kind ParsedSymbols from .sql /
 *   .graphql / .prisma / .aql files. But until this module runs, there
 *   are zero `queries` or `writes` edges in the graph — so
 *   `code_query_impact`, `code_table_context`, and `code_data_lineage`
 *   all return empty results.
 *
 * Solution:
 *   For every function/method in a code file, read its body from disk
 *   and test for word-boundary occurrences of known table names. Emit
 *   one `queries` or `writes` ParsedRelation per (function, table) pair.
 *
 * Write detection:
 *   A body that contains SQL DML keywords (INSERT / UPDATE / DELETE /
 *   DROP / UPSERT / REPLACE / TRUNCATE) or GraphQL `mutation` or common
 *   ORM write methods (.create / .update / .delete / .upsert / …) gets
 *   classified as `writes`. Everything else is `queries`. Classification
 *   is per function body, not per individual table mention — if a
 *   function does both reads and writes, it gets `writes` (conservative).
 *
 * Confidence:
 *   0.7 — body-text word-boundary heuristic; no type inference.
 *
 * Limitations (v1):
 *   - String-literal false positives: a comment "// see users table"
 *     inside a function that otherwise only touches `posts` will create
 *     a spurious `users` edge. Acceptable for v1 indexing.
 *   - Dynamic table names (computed strings) cannot be detected.
 *   - Table names shorter than MIN_TABLE_NAME_LEN are skipped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedFile, ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';

// ─── constants ────────────────────────────────────────────────────────────────

/** Languages whose files carry `table`-kind symbols. */
const DATA_LANGUAGES = new Set<string>(['sql', 'graphql', 'prisma', 'aql']);

/** Symbol kinds in code files that we link FROM. */
const CODE_KINDS = new Set<string>(['function', 'method']);

/**
 * Minimum table name length to suppress noise from 1-2 char names
 * (id, to, at, …) that appear everywhere in code.
 */
const MIN_TABLE_NAME_LEN = 3;

/**
 * Write-operation pattern. Tested against the full function body text
 * (case-insensitive, with lastIndex reset each call).
 *
 * Covers:
 *   - SQL DML: INSERT, UPDATE, DELETE, DROP, UPSERT, REPLACE, TRUNCATE
 *   - GraphQL: `mutation` keyword
 *   - ORM method calls: .create( .update( .delete( .upsert( .insert(
 *     .remove( .replaceOne( .updateOne( .deleteOne( .insertOne(
 *     .createMany( .updateMany( .deleteMany(
 */
const WRITE_RE =
    /\b(insert|update|delete|drop|upsert|replace|truncate|mutation)\b|\.(?:create|update|delete|upsert|insert|remove|replaceOne|updateOne|deleteOne|insertOne|createMany|updateMany|deleteMany)\s*[(<]/gi;

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Escape metacharacters so a string is safe inside `new RegExp(...)`. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return true if `bodyText` contains any write-operation indicator.
 * Resets `WRITE_RE.lastIndex` before each call.
 */
function isWriteBody(bodyText: string): boolean {
    WRITE_RE.lastIndex = 0;
    return WRITE_RE.test(bodyText);
}

/** Decode the byte slice `[start, end)` from a Buffer as UTF-8. */
function sliceUtf8(buf: Buffer, start: number, end: number): string {
    return buf.subarray(start, Math.min(end, buf.length)).toString('utf-8');
}

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Build cross-file code→data-entity edges.
 *
 * @param repoRoot  Absolute path to the repository root. Used to resolve
 *                  repo-relative symbol file paths to absolute disk paths.
 * @param parsedFiles  Full list of parsed files (provides language map).
 * @param symTable  Pre-built symbol table (provides `.all` iteration).
 * @returns An object with the edge array and the total count linked.
 */
export function buildDataLayerEdges(
    repoRoot: string,
    parsedFiles: readonly ParsedFile[],
    symTable: SymbolTable,
): { edges: ParsedRelation[]; linked: number } {

    // Step 1 — build file-path → language map and collect table symbols.
    const fileLanguage = new Map<string, string>();
    for (const f of parsedFiles) {
        fileLanguage.set(f.path, f.language);
    }

    // tablesByLower: lowercase name → [ParsedSymbol, …]
    // (multiple schemas can define a table with the same name)
    const tablesByLower = new Map<string, ParsedSymbol[]>();
    for (const sym of symTable.all) {
        const lang = fileLanguage.get(sym.file);
        if (!lang || !DATA_LANGUAGES.has(lang)) continue;
        if (sym.kind !== 'table') continue;
        if (sym.name.length < MIN_TABLE_NAME_LEN) continue;
        const lower = sym.name.toLowerCase();
        const list = tablesByLower.get(lower);
        if (list) list.push(sym);
        else tablesByLower.set(lower, [sym]);
    }

    if (tablesByLower.size === 0) {
        return { edges: [], linked: 0 };
    }

    // Pre-build word-boundary regexes (keyed by lowercase name).
    const tableRegexes = new Map<string, RegExp>();
    for (const lower of tablesByLower.keys()) {
        tableRegexes.set(lower, new RegExp(`\\b${escapeRegex(lower)}\\b`, 'i'));
    }

    // Step 2 — collect code functions/methods grouped by their source file.
    const funcsByFile = new Map<string, ParsedSymbol[]>();
    for (const sym of symTable.all) {
        if (!CODE_KINDS.has(sym.kind)) continue;
        const lang = fileLanguage.get(sym.file);
        if (!lang || DATA_LANGUAGES.has(lang)) continue;  // skip data-file symbols
        const list = funcsByFile.get(sym.file);
        if (list) list.push(sym);
        else funcsByFile.set(sym.file, [sym]);
    }

    if (funcsByFile.size === 0) {
        return { edges: [], linked: 0 };
    }

    // Step 3 — scan each code file and emit edges.
    const edges: ParsedRelation[] = [];
    // edgeByKey: `${sourceId}::${targetId}` → the emitted edge reference.
    // Used for O(1) dedup and write-upgrade in one pass.
    const edgeByKey = new Map<string, ParsedRelation>();

    for (const [filePath, funcs] of funcsByFile) {
        const absPath = path.join(repoRoot, filePath);
        let fileBuf: Buffer;
        try {
            fileBuf = fs.readFileSync(absPath);
        } catch {
            // Unreadable file — skip silently. This is non-fatal; the
            // symbol was parsed from an earlier snapshot that may have
            // since been deleted or moved.
            continue;
        }

        for (const func of funcs) {
            const bodyText = sliceUtf8(fileBuf, func.byteRange.start, func.byteRange.end);
            if (!bodyText) continue;

            const bodyIsWrite = isWriteBody(bodyText);

            for (const [lower, tableSyms] of tablesByLower) {
                const re = tableRegexes.get(lower)!;
                if (!re.test(bodyText)) continue;

                const kind: 'queries' | 'writes' = bodyIsWrite ? 'writes' : 'queries';

                for (const tSym of tableSyms) {
                    const key = `${func.id}::${tSym.id}`;
                    const existing = edgeByKey.get(key);

                    if (!existing) {
                        const edge: ParsedRelation = {
                            sourceId: func.id,
                            targetId: tSym.id,
                            kind,
                            confidence: 0.7,
                            reason: `body text contains table name '${tSym.name}' (word-boundary match)`,
                        };
                        edgeByKey.set(key, edge);
                        edges.push(edge);
                    } else if (existing.kind === 'queries' && kind === 'writes') {
                        // Upgrade: function has a write keyword → promote the edge.
                        existing.kind = 'writes';
                        existing.reason += '; upgraded to writes (DML/mutation keyword detected)';
                    }
                    // existing.kind === 'writes' → no change needed.
                }
            }
        }
    }

    return { edges, linked: edges.length };
}
