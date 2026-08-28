/**
 * codeIndexer.ts — Repo-registry reads + Groundfloor Atlas-backed indexing entry points.
 *
 * This module:
 *   - reads/writes the Groundfloor Atlas repo registry at `<LORE_HOME>/atlas-registry.json`
 *   - delegates indexing to api.indexRepoWithAtlas (closes over the live
 *     PluginGraphContext)
 *
 * The Groundfloor Atlas registry is the single source of truth for indexed repos.
 * `addRepo` / `removeRepo` / `indexAllRepos` keep it current.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Public surface:
 *   listRepos     — registry read
 *   getRepo       — registry lookup by name
 *   indexRepo     — index one repo via Groundfloor Atlas (delegates to api)
 *   indexAllRepos — index every registered repo
 *   writeAtlasRegistry — overwrite the registry file
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * DeveloperApi — minimal structural type for the Groundfloor Atlas indexing entry point.
 *
 * The original X3 reference implementation imported this from the Lore plugin's
 * `./api.ts`, which is not part of Groundfloor Atlas's standalone build (that module pulls
 * in PluginGraphContext + Lore internals). `indexRepo` / `indexAllRepos` only
 * ever call `indexRepoWithAtlas`, so we capture exactly that surface here. This
 * keeps the file compilable when it is pulled into the build graph (e.g. by
 * `mcp/tools/source.ts`, which imports `listRepos` / `getRepo` from here).
 */
export interface DeveloperApi {
    indexRepoWithAtlas(
        repoPath: string,
        opts: { repoName: string; clearFirst: boolean },
    ): Promise<{
        repo: string;
        symbolsUpserted: number;
        relationsInserted: number;
        durationMs: number;
    }>;
}

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * IndexedRepo — A repo entry from the Groundfloor Atlas registry file.
 */
export interface IndexedRepo {
    name: string;
    path: string;
    storagePath: string;
    indexedAt: string;
    lastCommit: string;
    stats: {
        files: number;
        nodes: number;
        edges: number;
        communities: number;
        processes: number;
        embeddings: number;
    };
}

/**
 * IndexResult — Summary of a code-indexing operation.
 *
 *   symbolsImported / relationsImported come from the indexing entry
 *   point's result (parseRepo + resolveRepo + upsert).
 */
export interface IndexResult {
    repo: string;
    symbolsImported: number;
    relationsImported: number;
    symbolsCleared: number;
    durationMs: number;
    errors: string[];
}

/* ─── Registry ────────────────────────────────────────────────── */

/**
 * Groundfloor Atlas registry path. Lives at `<LORE_HOME>/atlas-registry.json`.
 */
function atlasRegistryPath(): string {
    const loreHome = process.env['LORE_HOME'] || path.join(os.homedir(), '.groundfloor');
    return path.join(loreHome, 'atlas-registry.json');
}

/**
 * Read the registry of indexed repos from `<LORE_HOME>/atlas-registry.json`.
 * Returns empty array if the file doesn't exist or isn't readable.
 */
export function listRepos(): IndexedRepo[] {
    try {
        const content = fs.readFileSync(atlasRegistryPath(), 'utf-8');
        return JSON.parse(content) as IndexedRepo[];
    } catch {
        return [];
    }
}

export function getRepo(repoName: string): IndexedRepo | null {
    const repos = listRepos();
    return repos.find((repo) => repo.name === repoName) ?? null;
}

/**
 * Write the Groundfloor Atlas registry. Called by `addRepo` (and any future
 * `removeRepo` / `indexAllRepos` updates) to keep the registry current.
 */
export function writeAtlasRegistry(repos: IndexedRepo[]): void {
    const p = atlasRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Temp-write + rename: a crash mid-write used to leave a truncated
    // registry that listRepos() then silently read as EMPTY (repos
    // "disappearing" until the next successful write).
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(repos, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
}

/* ─── Indexing — Groundfloor Atlas-backed ─────────────────────────────────── */

/**
 * Pull symbols + relations into Lore's Kùzu graph for one repo.
 * Delegates to api.indexRepoWithAtlas (parseRepo + resolveRepo + upsert).
 */
export async function indexRepo(
    repo: IndexedRepo,
    api: DeveloperApi,
): Promise<IndexResult> {
    const startedAt = Date.now();
    try {
        const result = await api.indexRepoWithAtlas(repo.path, { repoName: repo.name, clearFirst: true });
        return {
            repo: result.repo,
            symbolsImported: result.symbolsUpserted,
            relationsImported: result.relationsInserted,
            symbolsCleared: 0,   // Atlas's clearFirst is internal; no per-call count surfaced
            durationMs: result.durationMs,
            errors: [],
        };
    } catch (err) {
        return {
            repo: repo.name,
            symbolsImported: 0,
            relationsImported: 0,
            symbolsCleared: 0,
            durationMs: Date.now() - startedAt,
            errors: [(err as Error).message],
        };
    }
}

/**
 * Index every repo in the registry via Groundfloor Atlas. Sequential — keeps
 * memory pressure bounded and avoids tripping over a shared Kùzu
 * write lock.
 */
export async function indexAllRepos(api: DeveloperApi): Promise<IndexResult[]> {
    const repos = listRepos();
    const out: IndexResult[] = [];
    for (const repo of repos) {
        const result = await indexRepo(repo, api);
        out.push(result);
    }
    return out;
}
