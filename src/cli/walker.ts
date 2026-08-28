/**
 * cli/walker.ts — Y3 recursive directory walker for `atlas index <dir>`.
 *
 * Yields absolute file paths whose extension maps to a registered
 * parser language (delegates to parser.getLanguageFor). Skips files
 * matched by:
 *   - .gitignore (root-level; one ignore file per scanned root)
 *   - .atlasignore (root-level; same line-based syntax as .gitignore)
 *   - --exclude <glob> (repeatable; minimatch-style globs without an
 *     external dep — we implement the subset Atlas operators actually
 *     write: `*`, `**`, `?`, character classes inside `[...]`, literal
 *     text. The Y3 spec's scope-guard explicitly allows shipping a
 *     reduced gitignore semantics; nested .gitignore files + negation
 *     rules are out of scope (Y3b).
 *
 * Why no `ignore` npm dep: keeps the CLI hermetic (no network install
 * at boot) and the gitignore subset operators actually rely on is
 * tiny — line-based prefixes and `**` globs. The fallback below
 * matches that subset precisely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLanguageFor, isDefaultExcludedTestFile } from '../parser/index.js';

export interface WalkOptions {
    /** Additional glob patterns to skip. Repeatable via the CLI flag. */
    excludeGlobs?: string[];
    /** When false, follow nested directories regardless of .gitignore. */
    respectGitignore?: boolean;
    /**
     * RD-Mwalker — hard cap on the number of files yielded. Guards against
     * OOM / runaway crawls on huge monorepos. When reached, the walk emits a
     * warning and stops. Default DEFAULT_MAX_FILES; override via `--max-files`.
     */
    maxFiles?: number;
}

/** RD-Mwalker — default crawl cap (files yielded). */
export const DEFAULT_MAX_FILES = 50_000;

export const DEFAULT_SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage',
    '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv',
    '.atlas',  // never recurse into our own checkpoint dir
    // Python tooling / dependency installs — never the user's own source.
    'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    'env', '.eggs',
    // JS/other build + tool caches.
    '.turbo', '.parcel-cache', 'bower_components', '.gradle', 'Pods',
    '.terraform', '.serverless',
]);

/**
 * True if a directory NAME should never be recursed into.
 *
 * Beyond the exact-match DEFAULT_SKIP_DIRS, this catches the open-ended cases an
 * exact set can't: any dir whose name CONTAINS "venv" (e.g. `.test_venv`,
 * `venv311`, `env-venv`) — the source of the site-packages/pip/rich/httpcore
 * noise that polluted indexed Python SDK repos. Exact-name matching alone missed
 * `.test_venv`, so its entire virtualenv got indexed.
 */
export function isSkippableDirName(name: string): boolean {
    if (DEFAULT_SKIP_DIRS.has(name)) return true;
    // Any virtualenv variant: `.venv`, `venv`, `.test_venv`, `venv-3.12`, …
    if (name.toLowerCase().includes('venv')) return true;
    return false;
}

/** True if any path segment is a skip-dir (node_modules/.git/dist/venv/…). */
export function isInSkipDir(relOrAbsPath: string): boolean {
    return relOrAbsPath
        .split(/[\\/]/)
        .some((seg) => isSkippableDirName(seg));
}

interface CompiledMatcher {
    test: (relPath: string) => boolean;
}

function compileGlob(glob: string): CompiledMatcher {
    // Translate a small glob subset to a RegExp. Anchored to the start
    // by default unless the pattern starts with `**/`. Trailing `/`
    // matches directories only (we honor the convention by stripping it
    // and treating it as a path-prefix match).
    let pattern = glob.trim();
    if (pattern === '') return { test: () => false };
    // ATL-026: globs come from an UNTRUSTED repo's .gitignore/.atlasignore. A
    // pathological pattern (e.g. many `*`/`**`) translates to a regex with
    // adjacent `.*`/`[^/]*` quantifiers that backtrack catastrophically against
    // the matcher run on every path in the walk (ReDoS → indexing hangs). Bound
    // it: collapse runs of `*`, and drop patterns that are absurdly long or
    // wildcard-dense. A dropped rule simply matches nothing — safe (slightly less
    // filtering, never a hang).
    pattern = pattern.replace(/\*{2,}/g, '**').replace(/(?:\*\*\/)+\*\*/g, '**');
    if (pattern.length > 512 || (pattern.match(/\*/g)?.length ?? 0) > 24) {
        return { test: () => false };
    }
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i]!;
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                // `**` matches any number of path segments.
                re += '.*';
                i += 2;
                if (pattern[i] === '/') i += 1;
                continue;
            }
            // Single `*` matches anything except `/`.
            re += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') { re += '[^/]'; i += 1; continue; }
        if (ch === '.' || ch === '+' || ch === '(' || ch === ')' || ch === '|' || ch === '^' || ch === '$' || ch === '{' || ch === '}' || ch === '\\') {
            re += '\\' + ch;
            i += 1;
            continue;
        }
        if (ch === '[') {
            // Pass through a character class as-is until ].
            const close = pattern.indexOf(']', i);
            if (close === -1) { re += '\\['; i += 1; continue; }
            re += pattern.slice(i, close + 1);
            i = close + 1;
            continue;
        }
        re += ch;
        i += 1;
    }
    // A malformed translated pattern must never crash the walk — a bad rule
    // simply matches nothing (RD-P1).
    let anchored: { test: (s: string) => boolean };
    try {
        anchored = new RegExp('^(?:' + re + ')$');
    } catch {
        anchored = { test: () => false };
    }
    let suffixed: { test: (s: string) => boolean } | null;
    try {
        suffixed = pattern.startsWith('**/') ? null : new RegExp('(?:^|/)(?:' + re + ')$');
    } catch {
        suffixed = null;
    }
    let dirAnchored: { test: (s: string) => boolean };
    try {
        dirAnchored = new RegExp('^(?:' + re + ')(?:/|$)');
    } catch {
        dirAnchored = { test: () => false };
    }
    return {
        test(relPath: string) {
            if (anchored.test(relPath)) return true;
            if (suffixed && suffixed.test(relPath)) return true;
            // Directory-only patterns also match any file under them.
            if (dirOnly) {
                if (dirAnchored.test(relPath)) return true;
            }
            return false;
        },
    };
}

/**
 * Read .gitignore + .atlasignore at `root` and return a single
 * CompiledMatcher that returns true when the relative path is ignored.
 * Lines starting with `#` are comments; empty lines are skipped;
 * negation (`!`) is currently ignored (matches the Y3 scope-guard).
 */
function compileIgnoreFiles(root: string): CompiledMatcher {
    const matchers: CompiledMatcher[] = [];
    for (const name of ['.gitignore', '.atlasignore']) {
        const p = path.join(root, name);
        let text: string;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            if (line.startsWith('!')) continue; // negation deferred to Y3b
            matchers.push(compileGlob(line));
        }
    }
    return {
        test(relPath: string) {
            for (const m of matchers) if (m.test(relPath)) return true;
            return false;
        },
    };
}

/**
 * Recursive walk. Yields absolute paths of files whose extension is
 * mapped to a registered parser language. Skips DEFAULT_SKIP_DIRS,
 * `.gitignore` / `.atlasignore` matches, and any `--exclude` globs.
 *
 * Implementation note: iterative DFS (not generator-recursive) so a
 * deeply nested repo can't blow the call stack.
 */
export function* walkRepo(root: string, opts: WalkOptions = {}): Generator<string> {
    const absRoot = path.resolve(root);
    const stat = fs.statSync(absRoot, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return;
    const ignore = (opts.respectGitignore ?? true) ? compileIgnoreFiles(absRoot) : { test: () => false };
    const extra = (opts.excludeGlobs ?? []).map(compileGlob);
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const stack: string[] = [absRoot];
    // CYCLE GUARD — the containment check below allows a symlink whose target
    // is the root or ANY ancestor of the link, so `a/loop -> ..` re-pushes the
    // same subtree under an ever-lengthening LINK path (a/loop/a/loop/…). The
    // walk then yields the same files repeatedly as phantom `loop/loop/…/foo.ts`
    // paths until --max-files (reproduced: 33 "files" from 1 real file — only
    // macOS's ELOOP stopped it), and a dirs-only cycle grows the stack forever
    // since no file is ever yielded to trip the cap. Track visited directory
    // realpaths and descend into each real dir at most once.
    const visitedDirs = new Set<string>();
    try { visitedDirs.add(fs.realpathSync(absRoot)); } catch { /* root was statted above */ }
    let yielded = 0;

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            const rel = path.relative(absRoot, full).split(path.sep).join('/');
            // RD-P3 — symlink containment. A symlinked dir/file is followed ONLY
            // when its realpath stays inside absRoot; a link pointing outside the
            // root (or a dangling link) is skipped so the walk can't be steered
            // out of the indexed tree. Resolve type from the link target.
            let isDir = e.isDirectory();
            let isFile = e.isFile();
            if (e.isSymbolicLink()) {
                let real: string;
                try { real = fs.realpathSync(full); }
                catch { continue; } // dangling symlink
                if (real !== absRoot && !real.startsWith(absRoot + path.sep)) continue; // escapes root
                let st: fs.Stats;
                try { st = fs.statSync(real); }
                catch { continue; }
                isDir = st.isDirectory();
                isFile = st.isFile();
            }
            if (isDir) {
                if (isSkippableDirName(e.name)) continue;
                if (ignore.test(rel) || extra.some((m) => m.test(rel))) continue;
                // One real dir, one descent — see CYCLE GUARD above.
                let dirReal: string;
                try { dirReal = fs.realpathSync(full); }
                catch { continue; }
                if (visitedDirs.has(dirReal)) continue;
                visitedDirs.add(dirReal);
                stack.push(full);
                continue;
            }
            if (!isFile) continue;
            if (ignore.test(rel) || extra.some((m) => m.test(rel))) continue;
            // Default-exclude test/fixture/snapshot files to cut embedding
            // work (opt out via ATLAS_INCLUDE_TESTS=1). Uses the same
            // patterns + env gate as parseRepo for a single source of truth.
            if (isDefaultExcludedTestFile(rel)) continue;
            if (!getLanguageFor(full)) continue;
            // RD-Mwalker — stop at the cap rather than crawl unbounded.
            if (yielded >= maxFiles) {
                console.error(`[atlas] walker hit --max-files cap (${maxFiles}); stopping crawl (some files not indexed)`);
                return;
            }
            yielded += 1;
            yield full;
        }
    }
}

// Test seam — exported so the y3 unit tests can exercise the glob
// translator without spinning up a real filesystem.
export const _internal = { compileGlob };
