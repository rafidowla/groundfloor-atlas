/**
 * parser/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Public API: parseFile, parseRepo, getLanguageFor.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Three callable surfaces:
 *
 *   - getLanguageFor(filePath): Language | null
 *       Pure synchronous lookup by extension.
 *
 *   - parseFile(absPath, repoRoot?): Promise<ParsedFile>
 *       Read + parse one file; dispatch to the correct walker.
 *
 *   - parseRepo(repoRoot): Promise<ParseRepoResult>
 *       Enumerate via `git ls-files`, parse each, aggregate.
 *
 * Walker registry is intentionally permissive in v1: languages with a
 * registered walker get full extraction; languages without one (the 7
 * other v1 languages until their walkers land) are skipped with a
 * diagnostic. This keeps `parseRepo` useful as walkers are added
 * incrementally.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
    Language,
    ParsedFile,
    ParseDiagnostic,
    ParseRepoResult,
} from './types.js';
import { getLanguageFor as detectLanguage, getParser } from './grammars.js';
import { countLoc, type WalkerFn } from './walkers/_base.js';
import { walk as walkTypeScript } from './walkers/typescript.js';
import { walk as walkPython } from './walkers/python.js';
import { walk as walkGo } from './walkers/go.js';
import { walk as walkRust } from './walkers/rust.js';
import { walk as walkJava } from './walkers/java.js';
import { walk as walkCSharp } from './walkers/csharp.js';
import { walk as walkCpp } from './walkers/cpp.js';
import { walk as walkRuby } from './walkers/ruby.js';
import { walk as walkPhp } from './walkers/php.js';
import { walk as walkKotlin } from './walkers/kotlin.js';
import { walk as walkSwift } from './walkers/swift.js';
// Phase 9 — data-layer walkers
import { walk as walkSql } from './walkers/sql.js';
import { walk as walkGraphQl } from './walkers/graphql.js';
import { walk as walkPrisma } from './walkers/prisma.js';
import { walk as walkAql } from './walkers/aql.js';
import { walkRepo, isInSkipDir } from '../cli/walker.js';

/** Re-export so callers don't need to know the grammar module. */
export { detectLanguage as getLanguageFor };
export * from './types.js';

/**
 * Test/fixture/snapshot default-exclusion.
 *
 * To cut embedding work, the indexer skips files that are clearly tests,
 * mocks, fixtures, e2e suites, or snapshots. Opt out by setting
 * ATLAS_INCLUDE_TESTS=1.
 *
 * The env flag is snapshotted at module load: Lore scrubs process.env
 * later in the process lifecycle, so reading it lazily would be
 * unreliable. Reading once here pins the operator's intent.
 */
const INCLUDE_TESTS = process.env.ATLAS_INCLUDE_TESTS === '1';

/**
 * Repo-relative path patterns that mark a file as test/fixture/snapshot.
 * Matched against a forward-slash-normalized repo-relative path. Kept
 * deliberately tight so 'test' as a substring of an unrelated word or
 * path segment does NOT trigger exclusion.
 */
const TEST_FIXTURE_PATTERNS: RegExp[] = [
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /(^|\/)(__tests__|__mocks__|__fixtures__|__snapshots__)(\/|$)/,
    /(^|\/)e2e(\/|$)/,
    /\.snap$/,
];

/**
 * True if `repoRelPath` (forward-slash normalized) is a default-excluded
 * test/fixture/snapshot file AND the opt-out flag is not set.
 */
export function isDefaultExcludedTestFile(repoRelPath: string): boolean {
    if (INCLUDE_TESTS) return false;
    return TEST_FIXTURE_PATTERNS.some((re) => re.test(repoRelPath));
}

/**
 * Walker registry. All 8 v1 languages mapped (TS+TSX+JS share one
 * walker; C+CPP share one walker).
 */
// Audit 2026-05-13: track languages we've warned about once each so the user
// can tell what's being silently skipped during a large repo index without
// log spam (one line per language, not per file).
const _warnedUnsupportedLanguages = new Set<string>();
function warnOnceUnsupportedLanguage(language: string): void {
    if (_warnedUnsupportedLanguages.has(language)) return;
    _warnedUnsupportedLanguages.add(language);
    console.error(`[atlas/parser] no walker for language "${language}" yet — files of this kind will be indexed by path only, no symbols extracted`);
}

const WALKERS: Partial<Record<Language, WalkerFn>> = {
    typescript: walkTypeScript,
    tsx: walkTypeScript,
    javascript: walkTypeScript,
    python: walkPython,
    go: walkGo,
    rust: walkRust,
    java: walkJava,
    csharp: walkCSharp,
    c: walkCpp,
    cpp: walkCpp,
    ruby: walkRuby,
    php: walkPhp,
    kotlin: walkKotlin,
    swift: walkSwift,
    // Phase 9 — data-layer walkers
    sql: walkSql,
    graphql: walkGraphQl,
    prisma: walkPrisma,
    aql: walkAql,
};

/** Cap on per-file size we'll attempt to parse (bytes). Prevents OOM on weird repos. */
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Parse one file. The path may be absolute or repo-relative; if
 * `repoRoot` is provided, we record paths as repo-relative on the
 * ParsedFile so analytics in later phases can use them as stable
 * keys.
 */
export async function parseFile(
    filePath: string,
    repoRoot?: string,
): Promise<ParsedFile | null> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot ?? process.cwd(), filePath);
    const repoRel = repoRoot
        ? path.relative(repoRoot, absPath).split(path.sep).join('/')
        : absPath;

    const language = detectLanguage(absPath);
    if (!language) return null;

    // RD-M6 — size-gate via stat BEFORE reading, so a huge file is never
    // slurped into memory just to reject it. Caller records the throw as a
    // skip via parseRepo's catch path.
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`file too large (${stat.size} bytes > ${MAX_FILE_BYTES})`);
    }
    const buf = await fs.readFile(absPath);

    const sourceUtf8 = new Uint8Array(buf);
    const sourceText = new TextDecoder('utf-8').decode(sourceUtf8);

    const walker = WALKERS[language];
    if (!walker) {
        // Walker not implemented for this language yet. Return a
        // ParsedFile with the file metadata but no symbols, so
        // analytics can still see the file and so the diagnostic
        // surface in parseRepo can flag it.
        //
        // Audit 2026-05-13: warn once per language so users can tell when
        // their files are being silently skipped. The Set is module-scoped
        // so we don't spam the log per-file across a large repo.
        warnOnceUnsupportedLanguage(language);
        return {
            path: repoRel,
            language,
            symbols: [],
            imports: [],
            calls: [],
            sizeBytes: buf.byteLength,
            loc: countLoc(sourceText),
            parsedAt: new Date().toISOString(),
        };
    }

    const parser = await getParser(language);
    if (!parser) {
        // Regex-only walker — no tree-sitter parser needed.
        // Pass a sentinel rootNode (null cast); the walker ignores it.
        const { symbols, imports, calls } = walker(null as never, sourceUtf8, repoRel);
        return {
            path: repoRel,
            language,
            symbols,
            imports,
            calls,
            sizeBytes: buf.byteLength,
            loc: countLoc(sourceText),
            parsedAt: new Date().toISOString(),
        };
    }
    try {
        const tree = parser.parse(sourceText);
        if (!tree) {
            throw new Error('tree-sitter returned no tree');
        }
        const { symbols, imports, calls } = walker(tree.rootNode, sourceUtf8, repoRel);
        tree.delete();
        return {
            path: repoRel,
            language,
            symbols,
            imports,
            calls,
            sizeBytes: buf.byteLength,
            loc: countLoc(sourceText),
            parsedAt: new Date().toISOString(),
        };
    } finally {
        parser.delete();
    }
}

/**
 * Enumerate files in `repoRoot` via `git ls-files`. Matches the standard
 * filtering posture (Phase 0 carry-in #4): tracked + new-but-not-ignored
 * files, respecting `.gitignore`. Falls back to a directory walk (the
 * same `walkRepo` the `atlas index <dir>` CLI uses) when git is
 * unavailable or `repoRoot` is not a git working tree, so a plain code
 * folder still indexes cleanly. Documented in PHASE_1_OUTPUT.md.
 */
function enumerateFiles(repoRoot: string): string[] {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) {
        // Non-git directory (or git unavailable): `git ls-files` exits non-zero.
        // Degrade gracefully to the filesystem walk used by the CLI rather than
        // throwing, keeping the MCP `atlas_index` path on par with `atlas index`.
        const rels: string[] = [];
        for (const abs of walkRepo(repoRoot)) {
            rels.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
        }
        return rels;
    }
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // `git ls-files --others` lists UNTRACKED files too, so a virtualenv /
        // dep-install dir that the repo never .gitignored (e.g. `.test_venv/…`,
        // `site-packages/…`) would otherwise be enumerated and indexed — the
        // source of the pip/rich/httpcore/site-packages noise in the graph.
        // git's own --exclude-standard can't catch it (it's not gitignored), so
        // apply the SAME skip-dir posture the walk fallback already enforces.
        .filter((rel) => !isInSkipDir(rel));
}

/**
 * Parse every supported file under `walkDir`. Returns aggregate
 * ParseRepoResult. Sequential by default — keeps memory pressure
 * predictable on large repos.
 *
 * `pathRoot` (default `walkDir`) is the root that `ParsedFile.path` is made
 * RELATIVE TO — separated from the enumeration dir so a SUBDIRECTORY index can
 * root paths at the git top-level. Indexing `<repo>/src` with
 * `pathRoot=<repo>` yields `src/foo.ts` (matching a full-repo index) instead of
 * `foo.ts`. Rooting happens at PARSE TIME (parseFile gets pathRoot) — never
 * rewrite ParsedFile.path afterward, which desyncs parser-derived symbol state
 * from the node ids built from it. When pathRoot === walkDir (the default), this
 * is exactly the legacy behavior.
 */
export async function parseRepo(walkDir: string, pathRoot: string = walkDir): Promise<ParseRepoResult> {
    const startedAt = Date.now();
    const repoFiles = enumerateFiles(walkDir);
    const files: ParsedFile[] = [];
    const diagnostics: ParseDiagnostic[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const relPath of repoFiles) {
        const absPath = path.join(walkDir, relPath);
        if (isDefaultExcludedTestFile(relPath)) {
            skipped.push({ path: relPath, reason: 'test/fixture (default-excluded)' });
            continue;
        }
        const language = detectLanguage(absPath);
        if (!language) {
            skipped.push({ path: relPath, reason: 'unsupported extension' });
            continue;
        }
        if (!WALKERS[language]) {
            skipped.push({ path: relPath, reason: `walker for ${language} not yet implemented` });
            continue;
        }
        try {
            const parsed = await parseFile(absPath, pathRoot);
            if (parsed) files.push(parsed);
        } catch (err) {
            diagnostics.push({
                file: relPath,
                severity: 'warn',
                message: `parse failed: ${(err as Error).message}`,
            });
        }
    }

    return {
        files,
        diagnostics,
        durationMs: Date.now() - startedAt,
        skipped,
    };
}

/**
 * Convenience helper: parse a single file by absolute path and return
 * just the symbol list. Used by tests + the Phase 5 detect-changes
 * subsystem when only the symbols matter.
 */
export async function parseSymbolsOnly(absPath: string, repoRoot?: string): Promise<ParsedFile['symbols']> {
    const parsed = await parseFile(absPath, repoRoot);
    return parsed?.symbols ?? [];
}
