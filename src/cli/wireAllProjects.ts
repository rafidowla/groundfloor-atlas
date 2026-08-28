/**
 * cli/wireAllProjects.ts — bulk atlas wire install --all-projects.
 *
 * Reads every registered project path from ATLAS_HOME/lore-data (each
 * workspace's projects.json) and runs installWire() for each (idempotent
 * refresh of CLAUDE.md, hooks, skills).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasConfig } from '../config.js';
// From projectRegistry (native-free) rather than mcp/embeddedRegistry, which
// pulls EmbeddedLore → @groundfloor/lore → kuzu/lancedb at module load. That
// import is how the whole native stack ended up on every `atlas memory *` run.
import { embeddedBaseDir } from '../projectRegistry.js';
import { installWire, uninstallWire, type InstallWireOpts } from './wire.js';

export interface RegisteredProject {
    workspace: string;
    path: string;
    addedAt?: string;
}

export interface WireAllProjectsResult {
    ok: boolean;
    command: 'wire.install-all-projects';
    dataDir: string;
    total: number;
    wired: number;
    failed: number;
    skipped: number;
    /**
     * Workspaces that hold indexed DATA but have no projects.json, so this run
     * could not see their repos. Before registration-on-index existed, that was
     * most of them — and a bulk wire would report success having touched a
     * fraction. Surfacing them is what stops "wired 4" from reading as "wired
     * everything"; NEVER drop this from the output to tidy it up.
     */
    unregisteredWorkspaces: string[];
    results: Array<{
        workspace: string;
        path: string;
        status: 'wired' | 'failed' | 'skipped';
        detail?: string;
        error?: string;
    }>;
    hint: string;
}

/**
 * Workspaces with a data dir but no projects.json — i.e. indexed at some point
 * but invisible to a registry-driven bulk operation. `atlas index` registers
 * from now on, so this shrinks to nothing for anything indexed after that fix;
 * it stays non-empty for repos indexed by an older build until their next index.
 */
export function findUnregisteredWorkspaces(cfg: AtlasConfig): string[] {
    const base = embeddedBaseDir(cfg);
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(base, ent.name);
        if (fs.existsSync(path.join(dir, 'projects.json'))) continue;
        // "Holds data" = anything beyond an empty dir. stats.json is written on
        // index; a graph/vector dir means a real store. Either way, if the dir
        // has content and no registry, a bulk run is blind to it.
        try {
            if (fs.readdirSync(dir).length > 0) out.push(ent.name);
        } catch { /* unreadable — nothing useful to report */ }
    }
    return out.sort();
}

/** Collect workspace + path from every workspace projects.json registry under lore-data. */
export function listRegisteredProjects(cfg: AtlasConfig): RegisteredProject[] {
    const base = embeddedBaseDir(cfg);
    if (!fs.existsSync(base)) return [];

    const byPath = new Map<string, RegisteredProject>();

    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const workspace = ent.name;
        const regFile = path.join(base, workspace, 'projects.json');
        if (!fs.existsSync(regFile)) continue;

        let rows: unknown;
        try {
            rows = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        } catch {
            continue;
        }
        if (!Array.isArray(rows)) continue;

        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const p = (row as { path?: unknown }).path;
            if (typeof p !== 'string' || !p.trim()) continue;
            const abs = path.resolve(p.trim());
            const addedAt = typeof (row as { addedAt?: unknown }).addedAt === 'string'
                ? (row as { addedAt: string }).addedAt
                : undefined;
            // Same repo registered under multiple workspaces → first registry wins.
            if (!byPath.has(abs)) {
                byPath.set(abs, { workspace, path: abs, addedAt });
            }
        }
    }

    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Wire every registered project; missing paths are skipped, failures are counted. */
export async function installWireAllProjects(
    cfg: AtlasConfig,
    opts: InstallWireOpts = {},
): Promise<WireAllProjectsResult> {
    const dataDir = embeddedBaseDir(cfg);
    const registered = listRegisteredProjects(cfg);
    const unregisteredWorkspaces = findUnregisteredWorkspaces(cfg);
    const results: WireAllProjectsResult['results'] = [];
    let wired = 0;
    let failed = 0;
    let skipped = 0;

    if (registered.length === 0) {
        return {
            ok: true,
            command: 'wire.install-all-projects',
            dataDir,
            total: 0,
            wired: 0,
            failed: 0,
            skipped: 0,
            unregisteredWorkspaces,
            results: [],
            hint: unregisteredWorkspaces.length > 0
                ? `No registered projects found, but ${unregisteredWorkspaces.length} workspace(s) hold indexed data with no projects.json (${unregisteredWorkspaces.join(', ')}). ` +
                  'Re-run `atlas index <path>` on those repos to register them (indexing now registers automatically), or wire them individually with `atlas wire install <path>`.'
                : 'No registered projects found — onboard repos first (atlas onboard <path>), then re-run.',
        };
    }

    for (const { workspace, path: projectPath } of registered) {
        if (!fs.existsSync(projectPath)) {
            skipped += 1;
            results.push({
                workspace,
                path: projectPath,
                status: 'skipped',
                detail: 'path does not exist on this machine',
            });
            continue;
        }
        try {
            const r = await installWire(projectPath, workspace, opts);
            if (r.ok) {
                wired += 1;
                results.push({ workspace, path: projectPath, status: 'wired', detail: String(r.hint ?? 'ok') });
            } else {
                failed += 1;
                results.push({
                    workspace,
                    path: projectPath,
                    status: 'failed',
                    error: String(r.error ?? 'unknown error'),
                });
            }
        } catch (err) {
            failed += 1;
            results.push({
                workspace,
                path: projectPath,
                status: 'failed',
                error: (err as Error).message,
            });
        }
    }

    const skipNote = skipped ? `; skipped ${skipped} missing path(s)` : '';
    // Never let a partial run read as complete: if some workspaces are invisible
    // to the registry, say so IN THE SUCCESS HINT, not just in a field a caller
    // might not print.
    const blindNote = unregisteredWorkspaces.length > 0
        ? ` NOT COVERED: ${unregisteredWorkspaces.length} workspace(s) have indexed data but no projects.json (${unregisteredWorkspaces.join(', ')}) — re-run 'atlas index <path>' on those repos to register them, or wire them individually.`
        : '';
    return {
        ok: failed === 0,
        command: 'wire.install-all-projects',
        dataDir,
        total: registered.length,
        wired,
        failed,
        skipped,
        unregisteredWorkspaces,
        results,
        hint: failed === 0
            ? `Wired ${wired} project(s)${skipNote}. Restart IDEs to pick up hook changes. Run 'atlas connect all' if IDE MCP configs also need refresh.${blindNote}`
            : `Completed with ${failed} failure(s). Fix errors above and re-run.${blindNote}`,
    };
}

export interface UninstallWireAllProjectsResult {
    ok: boolean;
    command: 'wire.uninstall-all-projects';
    dataDir: string;
    total: number;
    removed: number;
    failed: number;
    skipped: number;
    /** Same caveat as installWireAllProjects — workspaces with indexed data but
     *  no projects.json are invisible to this enumeration too, so their
     *  per-repo wiring (if any) is NOT touched by this run. */
    unregisteredWorkspaces: string[];
    results: Array<{
        workspace: string;
        path: string;
        status: 'removed' | 'failed' | 'skipped';
        detail?: string;
        error?: string;
    }>;
    hint: string;
}

/**
 * Part 6 (docs/plans/ATLAS-AUTOWIRE-PLAN.md) — the removal counterpart of
 * installWireAllProjects: run uninstallWire() (cli/wire.ts, already-existing
 * per-repo remover) against every project the registry knows about, mirroring
 * this file's own enumeration (listRegisteredProjects) so "every repo the
 * install side can reach" and "every repo the uninstall side can reach" never
 * drift apart.
 */
export function uninstallWireAllProjects(cfg: AtlasConfig): UninstallWireAllProjectsResult {
    const dataDir = embeddedBaseDir(cfg);
    const registered = listRegisteredProjects(cfg);
    const unregisteredWorkspaces = findUnregisteredWorkspaces(cfg);
    const results: UninstallWireAllProjectsResult['results'] = [];
    let removed = 0;
    let failed = 0;
    let skipped = 0;

    for (const { workspace, path: projectPath } of registered) {
        if (!fs.existsSync(projectPath)) {
            skipped += 1;
            results.push({
                workspace,
                path: projectPath,
                status: 'skipped',
                detail: 'path does not exist on this machine',
            });
            continue;
        }
        try {
            const r = uninstallWire(projectPath);
            if (r.ok) {
                removed += 1;
                results.push({ workspace, path: projectPath, status: 'removed' });
            } else {
                failed += 1;
                results.push({
                    workspace,
                    path: projectPath,
                    status: 'failed',
                    error: String(r['error'] ?? 'unknown error'),
                });
            }
        } catch (err) {
            failed += 1;
            results.push({
                workspace,
                path: projectPath,
                status: 'failed',
                error: (err as Error).message,
            });
        }
    }

    const skipNote = skipped ? `; skipped ${skipped} missing path(s)` : '';
    const blindNote = unregisteredWorkspaces.length > 0
        ? ` NOT COVERED: ${unregisteredWorkspaces.length} workspace(s) have indexed data but no projects.json (${unregisteredWorkspaces.join(', ')}) — their repos (if wired) were not touched by this run.`
        : '';
    return {
        ok: failed === 0,
        command: 'wire.uninstall-all-projects',
        dataDir,
        total: registered.length,
        removed,
        failed,
        skipped,
        unregisteredWorkspaces,
        results,
        hint: failed === 0
            ? `Removed Atlas wiring from ${removed} project(s)${skipNote}.${blindNote}`
            : `Completed with ${failed} failure(s). Fix errors above and re-run.${blindNote}`,
    };
}
