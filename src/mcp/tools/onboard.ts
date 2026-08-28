/**
 * mcp/tools/onboard.ts — atlas_onboard: one-call project onboarding.
 *
 * Replaces the 4-step sequence callers previously had to know about
 * (workspace_create → workspace_add_project → atlas_index → atlas_wire):
 *
 *   1. Derive the workspace name from the repo folder slug (git origin
 *      remote → slug, else dir basename) — REUSING an existing workspace of
 *      the same name instead of duplicating.
 *   2. Detect a stale/wrong-path index: if .atlas/index-state.json's `root`
 *      doesn't match the folder being onboarded, warn and force a FULL
 *      re-index (resume:false) — an incremental run against another root's
 *      fingerprints would skip files that were never written here.
 *   3. Fire indexing as a fire-and-forget background job: return immediately
 *      with a jobId and make index_status the polling surface, so the
 *      calling agent never blocks on a 30-minute index. (atlas_index blocks
 *      for the whole run and generic HTTP callers time out at 30s.)
 *   4. Run the wire step (hooks, CLAUDE.md + AGENTS.md standing instructions,
 *      git memory-sync).
 *
 * Returns ONE summary object: workspace, what was installed, the job id, and
 * (with wait:true) the terminal files/symbols/edges + skipped-files counts —
 * also visible via index_status either way.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasConfig } from '../../config.js';
import { embeddedDataDir, borrowEmbeddedLore } from '../embeddedRegistry.js';
import { acquireWorkspaceWriteLock, WorkspaceLockedError } from '../../lore/writerLock.js';
import { beginIndexWork, endIndexWork, isShuttingDown } from '../../lore/indexDrain.js';
import { writeStatsSnapshot } from '../statsSnapshot.js';
import { getProgress } from '../indexProgress.js';
import { indexInFlight } from '../indexInFlight.js';
import { runIndexTool } from './index.js';
import { installWire, slugify, WORKSPACE_SLUG_RE } from '../../cli/wire.js';
import { registerProject } from '../../projectRegistry.js';
import { invalidateWorkspaceResolverCache } from '../../pathWorkspaceResolver.js';
import { repoSlug } from '../../cli/repoId.js';
import { scanPathError } from '../../indexRoots.js';
import { LoreClient } from '../../loreClient.js';
import { resolveLoreContext, tokenMissingError } from '../context.js';
import { createWorkspace, listWorkspaces, addWorkspaceProject } from '../workspaceProxy.js';

export interface OnboardArgs {
    path: string;
    workspace?: string;
    /** true = block until the index finishes and return terminal counts.
     *  false (DEFAULT) = fire-and-forget; poll index_status. */
    wait?: boolean;
    /** false = skip step 4 (installWire) — used by auto-wire Part 5's
     *  background onboarding, where the whole point is memory without
     *  writing anything into the project's own repo (that's what the
     *  machine-wide hook already covers). DEFAULT true — every existing
     *  caller (the atlas_onboard tool, `atlas onboard` CLI) keeps installing
     *  the wire harness exactly as before. */
    wire?: boolean;
}

interface StaleIndexInfo {
    detected: true;
    previousRoot: string;
    reason: string;
}

/** Read <abs>/.atlas/index-state.json and flag a checkpoint whose recorded
 *  root is NOT the folder being onboarded (copied/moved repo, or a stale
 *  state file from another checkout). */
function detectStaleIndex(abs: string): StaleIndexInfo | null {
    try {
        const raw = fs.readFileSync(path.join(abs, '.atlas', 'index-state.json'), 'utf8');
        const parsed = JSON.parse(raw) as { root?: unknown; files?: unknown };
        if (typeof parsed.root === 'string' && parsed.root.length > 0 && path.resolve(parsed.root) !== abs) {
            const fileCount = parsed.files && typeof parsed.files === 'object' ? Object.keys(parsed.files).length : 0;
            return {
                detected: true,
                previousRoot: parsed.root,
                reason: `index-state.json was written for a different root (${fileCount} file fingerprints) — an incremental index would skip files never written from this folder, so a FULL re-index is running instead`,
            };
        }
    } catch { /* absent/unreadable → no stale state to worry about */ }
    return null;
}

/** Poll briefly until the background run has published its first progress
 *  snapshot (or the budget runs out) — same liftoff-confirmation idiom as
 *  cmdIndex's detach path (cli.ts), so we never report `queued` for a run
 *  that died before its first setProgress. */
async function confirmLiftoff(workspace: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        const p = getProgress(workspace);
        if (p.indexing || p.phase === 'done' || p.phase === 'error') return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return getProgress(workspace).indexing;
}

export async function runOnboard(cfg: AtlasConfig, args: OnboardArgs): Promise<unknown> {
    const abs = path.resolve(args.path);
    const rootErr = scanPathError(abs);
    if (rootErr) return { error: rootErr };
    if (!fs.existsSync(abs)) return { error: `path does not exist: ${abs}` };
    if (!fs.statSync(abs).isDirectory()) return { error: `onboard expects a project directory, got a file: ${abs}` };

    // ── 1. Workspace: derive from the repo slug; reuse an existing one. ──────
    const override = args.workspace?.trim();
    if (override && !WORKSPACE_SLUG_RE.test(override)) {
        return { error: `invalid workspace name: ${override} — use lowercase letters, numbers, and hyphens only` };
    }
    const workspace = override || slugify(repoSlug(abs) || path.basename(abs));
    if (!WORKSPACE_SLUG_RE.test(workspace)) {
        return { error: `invalid workspace name: ${workspace} — could not derive a valid slug from ${abs}` };
    }

    const embedded = cfg.lore.mode === 'embedded';
    let workspaceReused = false;
    if (embedded) {
        const dataDir = embeddedDataDir(cfg, workspace);
        workspaceReused = fs.existsSync(dataDir);
        fs.mkdirSync(dataDir, { recursive: true });
        // Register the project folder (deduped) — same record
        // workspace_add_project writes, via the shared helper so the path
        // resolver's cache invalidation below actually fires.
        if (registerProject(cfg, workspace, abs)) invalidateWorkspaceResolverCache();
    } else {
        const lc = resolveLoreContext();
        if (!lc.token) return tokenMissingError();
        try {
            const listed = (await listWorkspaces(lc.mcpUrl, lc.token)) as { workspaces?: unknown } | null;
            const names = Array.isArray(listed?.workspaces) ? listed!.workspaces : [];
            workspaceReused = names.some((w) => (typeof w === 'string' ? w : (w as { name?: string })?.name) === workspace);
            if (!workspaceReused) await createWorkspace(lc.mcpUrl, lc.token, workspace);
            await addWorkspaceProject(lc.mcpUrl, lc.token, workspace, abs);
        } catch (err) {
            return { error: 'workspace setup failed', detail: (err as Error).message };
        }
    }

    // ── 2. Stale/wrong-path index detection. ─────────────────────────────────
    const staleIndex = detectStaleIndex(abs);
    const resume = staleIndex === null;

    // ── 3. Fire the index. ───────────────────────────────────────────────────
    if (isShuttingDown()) {
        return { error: 'shutting_down', tool: 'atlas_onboard', detail: 'the daemon is shutting down — onboard rejected' };
    }
    if (indexInFlight.has(workspace)) {
        return { error: 'index_in_progress', tool: 'atlas_onboard', detail: `an index of workspace '${workspace}' is already running — poll index_status and retry when it's idle` };
    }
    const jobId = `onboard-${workspace}-${Date.now()}`;
    const wait = args.wait === true;

    let runPromise: Promise<unknown>;
    if (embedded) {
        // Same guard chain as the atlas_index handler (allTools.ts), with one
        // difference: unless wait:true we DON'T await the run — the guards are
        // held by the detached promise's finally instead of this call's.
        indexInFlight.add(workspace);
        const dataDir = embeddedDataDir(cfg, workspace);
        let releaseLock: (() => void) | null = null;
        try {
            releaseLock = acquireWorkspaceWriteLock(dataDir).release;
        } catch (err) {
            indexInFlight.delete(workspace);
            if (err instanceof WorkspaceLockedError) {
                return { error: 'index_in_progress', tool: 'atlas_onboard', detail: `workspace '${workspace}' is being indexed by pid ${err.holderPid} (a concurrent 'atlas index' CLI run) — retry when it's done` };
            }
            throw err;
        }
        beginIndexWork(workspace);
        const borrowed = await borrowEmbeddedLore(cfg, workspace);
        runPromise = (async () => {
            try {
                const res = await runIndexTool(borrowed.lore, { path: abs, workspace, resume, jobId }, workspace, cfg);
                // Best-effort stats snapshot while the store is open and warm —
                // a successful index must not fail over a snapshot hiccup.
                try { await writeStatsSnapshot(borrowed.lore, dataDir); }
                catch (err) { process.stderr.write(`[atlas] stats snapshot skipped: ${(err as Error).message}\n`); }
                return res;
            } finally {
                borrowed.release();
                endIndexWork(workspace);
                releaseLock!();
                indexInFlight.delete(workspace);
            }
        })();
        // A detached rejection with no catcher is an unhandledRejection —
        // attach a logging no-op now; wait-mode re-awaits the same promise.
        runPromise.catch((err) => process.stderr.write(`[atlas] onboard index failed: ${(err as Error)?.message ?? err}\n`));
    } else {
        const lc = resolveLoreContext();
        if (!lc.token) return tokenMissingError();
        const token = lc.token; // captured — property narrowing doesn't survive the closure below
        indexInFlight.add(workspace);
        runPromise = (async () => {
            const client = new LoreClient({ mcpUrl: lc.mcpUrl, token });
            try {
                await client.connect();
                return await runIndexTool(client, { path: abs, workspace, resume, jobId }, lc.workspace, cfg);
            } finally {
                await client.close().catch(() => undefined);
                indexInFlight.delete(workspace);
            }
        })();
        runPromise.catch((err) => process.stderr.write(`[atlas] onboard index failed: ${(err as Error)?.message ?? err}\n`));
    }

    // ── 4. Wire (independent of the index — safe to install while it runs). ──
    const wire = args.wire === false ? { skipped: true as const } : await installWire(abs, workspace);

    if (wait) {
        const indexResult = await runPromise;
        return {
            ok: true,
            workspace,
            workspaceReused,
            project: abs,
            jobId,
            index: { queued: false, resume, ...(staleIndex ? { staleIndex } : {}), result: indexResult },
            wire,
        };
    }

    const liftoff = await confirmLiftoff(workspace, 2_000);
    return {
        ok: true,
        workspace,
        workspaceReused,
        project: abs,
        jobId,
        index: {
            queued: true,
            confirmed: liftoff,
            resume,
            ...(staleIndex ? { staleIndex } : {}),
            poll: `index_status { workspace: "${workspace}" }`,
        },
        wire,
        hint: 'Indexing runs in the background — poll index_status for phase, files/symbols/edges counts, and the skipped-files report. It can legitimately take tens of minutes on a large repo; that is expected, not a hang.',
    };
}
