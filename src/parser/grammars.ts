/**
 * parser/grammars.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Per-language WASM grammar registration + singleton loader.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Wraps web-tree-sitter's Parser.init() and Parser.Language.load() with
 * caching so each grammar's WASM file is read from disk and parsed once
 * per process lifetime. Grammars live as vendored .wasm blobs under
 * `packages/lore-plugin-developer/grammars/` (see grammars/README.md
 * for provenance + Unlicense compatibility note).
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Parser, Language as TSLanguage } from 'web-tree-sitter';
import type { Language } from './types.js';

/**
 * Map a logical Language to its vendored WASM filename.
 * `null` = no WASM grammar (regex-only walker; grammars.ts never tries to load these).
 */
const GRAMMAR_FILES: Partial<Record<Language, string>> = {
    typescript: 'tree-sitter-typescript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    python: 'tree-sitter-python.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
    java: 'tree-sitter-java.wasm',
    csharp: 'tree-sitter-c_sharp.wasm',
    c: 'tree-sitter-c.wasm',
    cpp: 'tree-sitter-cpp.wasm',
    ruby: 'tree-sitter-ruby.wasm',
    php: 'tree-sitter-php.wasm',
    kotlin: 'tree-sitter-kotlin.wasm',
    swift: 'tree-sitter-swift.wasm',
    // Phase 9 — tree-sitter-based data languages
    sql: 'tree-sitter-sql.wasm',
    // graphql, prisma, aql use regex walkers — no WASM needed.
};

/** Map of file extensions (no dot, lowercase) to their Language. */
const EXTENSION_MAP: Record<string, Language> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    py: 'python',
    pyi: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    hh: 'cpp',
    rb: 'ruby',
    php: 'php',
    phtml: 'php',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    // Phase 9 — data-layer extensions
    sql: 'sql',
    ddl: 'sql',
    dml: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    prisma: 'prisma',
    aql: 'aql',
};

/**
 * Detect the language of a file by extension. Returns null for files we
 * don't have a walker for — caller treats those as skipped.
 */
export function getLanguageFor(filePath: string): Language | null {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
}

/**
 * Resolve the absolute filesystem path to a vendored grammar WASM blob.
 * Uses import.meta.url so it works from both source (tsx) and dist
 * (post-tsc-alias) without per-environment configuration.
 */
function grammarPath(language: Language): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Layouts:
    //   src layout (tsx):  <root>/packages/lore-plugin-developer/src/parser/grammars.ts
    //                      grammars at <root>/packages/lore-plugin-developer/grammars/
    //   dist layout:       <root>/dist/lore-plugin-developer/src/parser/grammars.js
    //                      grammars STILL at <root>/packages/lore-plugin-developer/grammars/
    //                      (build does NOT copy WASM into dist — they're vendored
    //                       in source; we resolve absolute every time).
    //
    const wasmFile = GRAMMAR_FILES[language]!; // caller checked wasmFile is non-null

    // Authoritative: grammars vendored relative to the compiled/source file.
    //   src layout (tsx):  <root>/src/parser/grammars.ts   -> <root>/grammars/
    //   dist/bundle layout: <root>/dist/parser/grammars.js -> <root>/grammars/
    // This is the only layout that exists in the shipped self-contained
    // bundle, so it must be tried FIRST and trusted when present. Guarding
    // with existsSync keeps the monorepo-name escape hatch (below) out of
    // the shipped artifact: a bundle unpacked under any path containing a
    // `groundfloor-lore` segment used to mis-resolve to a non-existent
    // packages/lore-plugin-developer/grammars/ dir and crash all parsing.
    const rel = path.join(here, '..', '..', 'grammars', wasmFile);
    if (fs.existsSync(rel)) return rel;

    // Fallback for the monorepo/source checkout, where grammars live at
    // <root>/packages/lore-plugin-developer/grammars/. Walk up to a dir
    // named `groundfloor-lore`, but only trust it if the wasm is really
    // there — never blindly when the relative layout already failed.
    let dir = here;
    while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === 'groundfloor-lore') {
            const monorepo = path.join(dir, 'packages', 'lore-plugin-developer', 'grammars', wasmFile);
            if (fs.existsSync(monorepo)) return monorepo;
        }
        dir = path.dirname(dir);
    }

    // Last resort: return the relative candidate so the loader's
    // TSLanguage.load() surfaces a clear ENOENT for the expected path.
    return rel;
}

/** Init runtime once per process. */
let parserInitPromise: Promise<void> | null = null;

/** Loaded Language objects, keyed by Language. */
const loadedLanguages = new Map<Language, TSLanguage>();

/**
 * Lazily initialize web-tree-sitter and load + cache the requested
 * grammar. Subsequent calls return the cached Language object.
 * Returns null for regex-only languages (graphql, prisma, aql) that
 * have no WASM grammar.
 */
export async function loadGrammar(language: Language): Promise<TSLanguage | null> {
    const wasmFile = GRAMMAR_FILES[language];
    if (!wasmFile) return null; // regex-only language

    if (!parserInitPromise) {
        parserInitPromise = Parser.init();
    }
    await parserInitPromise;

    const cached = loadedLanguages.get(language);
    if (cached) return cached;

    const wasmPath = grammarPath(language);
    const lang = await TSLanguage.load(wasmPath);
    loadedLanguages.set(language, lang);
    return lang;
}

/**
 * Acquire a Parser configured for the given language. Each call returns
 * a fresh Parser (web-tree-sitter parsers aren't thread-safe; treating
 * them as per-call resources is the simplest model).
 */
export async function getParser(language: Language): Promise<Parser | null> {
    const lang = await loadGrammar(language);
    if (!lang) return null; // regex-only language
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
}
