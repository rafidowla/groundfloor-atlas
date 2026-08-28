/**
 * projectRegistry.ts — the per-workspace project registry (`projects.json`),
 * plus the pure data-dir path helpers it needs.
 *
 * WHY THIS IS ITS OWN MODULE, and native-free:
 *
 * 1. `embeddedBaseDir` / `embeddedDataDir` are pure path math, but they used to
 *    live in mcp/embeddedRegistry.ts — which statically imports EmbeddedLore →
 *    @groundfloor/lore → kuzu + lancedb + better-sqlite3 at MODULE LOAD. Any
 *    module wanting a data-dir path therefore dragged the whole native stack in
 *    with it. That is exactly how `atlas memory show` lost its no-native
 *    guarantee (see tests/memory-no-native.test.ts). Living here, the path
 *    helpers cost nothing to import. embeddedRegistry re-exports them, so every
 *    existing caller is unchanged.
 *
 * 2. The registry WRITE was copy-pasted inline in four places (three in
 *    allTools.ts, one in tools/onboard.ts) and — critically — was missing from
 *    the indexing path entirely. See registerProject below for why that matters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasConfig } from './config.js';

/** Root under which every workspace's data dir lives. */
export function embeddedBaseDir(cfg: AtlasConfig): string {
    return cfg.lore.dataDir ?? path.join(cfg.home, 'lore-data');
}

/**
 * `<base>/<workspace>`. The workspace name is validated as a single path
 * segment — it comes from user input and is joined into a filesystem path, so a
 * traversal attempt must not escape the base.
 */
export function embeddedDataDir(cfg: AtlasConfig, workspace: string): string {
    if (!workspace || workspace !== path.basename(workspace) || workspace === '.' || workspace === '..' || !/^[A-Za-z0-9._-]+$/.test(workspace)) {
        throw new Error(`Invalid workspace name: ${JSON.stringify(workspace)}`);
    }
    return path.join(embeddedBaseDir(cfg), workspace);
}

/** One registry row. Shape is unchanged from the original inline writers. */
export interface RegisteredProjectEntry {
    path: string;
    addedAt: string;
}

/** Read a workspace's registry. Returns [] for missing OR corrupt files —
 *  a damaged registry must never take down an index run. */
export function readProjectRegistry(cfg: AtlasConfig, workspace: string): RegisteredProjectEntry[] {
    try {
        const regFile = path.join(embeddedDataDir(cfg, workspace), 'projects.json');
        if (!fs.existsSync(regFile)) return [];
        const parsed = JSON.parse(fs.readFileSync(regFile, 'utf8')) as RegisteredProjectEntry[];
        return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.path === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Idempotently record `projectPath` as belonging to `workspace`.
 *
 * WHY THE INDEX PATH MUST CALL THIS. `projects.json` is the ONLY thing
 * `atlas wire install --all-projects` enumerates. Indexing a repo with
 * `atlas index <path>` used to write the whole code graph WITHOUT ever
 * registering it, so a machine could have twenty indexed repos and four
 * registry entries — and `--all-projects` would wire those four, report
 * success, and say nothing about the sixteen it never saw. Silent partial
 * coverage that reads as complete is the same failure shape as the secret
 * scrub and the empty-workspace harness: the operation "succeeds" while
 * doing a fraction of the work.
 *
 * Returns true when a NEW entry was written (false = already present, or the
 * write failed). Never throws: registration is bookkeeping, and must not fail
 * an otherwise-good index.
 */
export function registerProject(cfg: AtlasConfig, workspace: string, projectPath: string): boolean {
    try {
        const abs = path.resolve(projectPath);
        const dir = embeddedDataDir(cfg, workspace);
        fs.mkdirSync(dir, { recursive: true });
        const regFile = path.join(dir, 'projects.json');
        const projects = readProjectRegistry(cfg, workspace);
        if (projects.some((p) => path.resolve(p.path) === abs)) return false;
        projects.push({ path: abs, addedAt: new Date().toISOString() });
        fs.writeFileSync(regFile, JSON.stringify(projects, null, 2));
        return true;
    } catch {
        return false;
    }
}
