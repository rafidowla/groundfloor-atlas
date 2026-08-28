/**
 * mcp/tools/index.ts — atlas_index.
 *
 * Re-index a file or directory via MCP. Uses POST /api/nodes/bulk +
 * POST /api/edges/bulk (rate-limit-exempt W9 endpoints) via BatchWriter
 * — never single-node writes. Falls back to per-item writes automatically
 * via BatchWriter's LoreClient fallback on pre-W9 daemons.
 *
 * For directories: parse all files → build full cross-file call graph →
 * flush in 50-file batches via BatchWriter.
 * For single files: parse → resolve against the persisted workspace graph
 * (same-repo symbols pulled in as resolution candidates, so cross-file edges
 * land without a full re-index) → single-batch flush + per-file reconcile.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFile, parseRepo } from '../../parser/index.js';
import type { ParsedFile, ParsedRelation, ParsedSymbol } from '../../parser/types.js';
import { buildSymbolTable, type SymbolTable } from '../../resolver/symbolTable.js';
import { buildResolutionContext, type ResolutionContext } from '../../resolver/importGraph.js';
import { buildAllCodeEdges, collectExternalModules } from '../../resolver/index.js';
import { buildIndexBatch, buildImportNodes } from '../../store/codeNodes.js';
import { BatchWriter } from '../../cli/batchWriter.js';
import { scanPathError } from '../../indexRoots.js';
import type { LoreWriter } from '../../loreClient.js';
import { indexRepoFiles, canReconcile } from '../../indexCore.js';
import { rawSymbolFromNode, fileShellsFromSymbols, type CodeSymbolNode } from '../codeContext.js';
import { DEFAULT_MAX_CONTEXT_NODES, positiveIntEnv } from '../embeddedReader.js';
import { setProgress } from '../indexProgress.js';
import { repoSlug, resolveRepoRoot } from '../../cli/repoId.js';
import { invalidateLoreContext } from '../loreReader.js';
import { loadCheckpoint, saveCheckpoint, needsReindex, markIndexed } from '../../cli/checkpoint.js';
import { registerProject } from '../../projectRegistry.js';
import { invalidateWorkspaceResolverCache } from '../../pathWorkspaceResolver.js';
import type { AtlasConfig } from '../../config.js';

interface IndexArgs {
    path: string;
    workspace?: string;
    /** Directories only. true (DEFAULT) = incremental: files unchanged per the
     *  walk root's .atlas/index-state.json still feed cross-file resolution but
     *  are not re-written. false = full re-write + stale-node reconcile. */
    resume?: boolean;
    /** atlas_onboard fire-and-forget runs pass a correlation id; it is stamped
     *  into index_status so the caller can match the poll to its job. */
    jobId?: string;
}

/** Aggregate parseRepo's per-file skip list into the compact index_status
 *  shape: exact count + per-reason totals + a capped sample of paths. */
function summarizeSkipped(skipped: Array<{ path: string; reason: string }>): { count: number; byReason: Record<string, number>; sample: string[] } {
    const byReason: Record<string, number> = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    return { count: skipped.length, byReason, sample: skipped.slice(0, 25).map((s) => `${s.path} (${s.reason})`) };
}

function repoFromPath(abs: string): string {
    // GIT-AWARE REPO ID: derive the <repo> namespace via repoSlug (git origin
    // remote → stable slug) exactly like the CLI (cli.ts repoForRoot/repoFromPath),
    // so `atlas index` and the `atlas_index` MCP tool write into ONE shared code
    // graph instead of two disjoint prefixes. repoSlug degrades to path.basename
    // for non-git dirs, preserving the legacy/scratch-dir behavior. For a single
    // file we slug the resolved git TOP-LEVEL (not the file's parent dir) so the
    // <repo> prefix matches the directory index — same shared resolveRepoRoot the
    // CLI single-file path uses.
    const isDir = fs.statSync(abs).isDirectory();
    return repoSlug(isDir ? abs : resolveRepoRoot(abs));
}

/** Peer resolution context loaded from the PERSISTED workspace graph for a
 *  single-file incremental index: symbol shells from every OTHER file of the
 *  same repo + the repo's file-path set for import-specifier resolution. */
interface PeerResolutionContext {
    shells: ParsedFile[];
    extraPaths: Set<string>;
}

/** Minimal read surface the single-file path needs from the writer's store.
 *  The daemon hands runIndexTool the shared EmbeddedLore (allTools.ts), which
 *  satisfies this; a plain HTTP LoreWriter does not, and single-file
 *  resolution then degrades to file-local — the documented limitation, same
 *  precedent as indexCore's reconcile being embedded-only. */
interface PersistedGraphReader {
    listNodes(type?: string, tag?: string, project?: string, limit?: number): Promise<unknown[]>;
}

function canListPersisted(w: unknown): w is PersistedGraphReader {
    return typeof (w as PersistedGraphReader | undefined)?.listNodes === 'function';
}

async function parseAndResolveOne(
    absFile: string,
    peers?: PeerResolutionContext | null,
): Promise<{ file: ParsedFile; relations: ParsedRelation[]; table: SymbolTable; ctx: ResolutionContext }> {
    // Root at the git TOP-LEVEL (shared resolveRepoRoot, degrades to the file's
    // dir for non-git paths) so ParsedFile.path is repo-relative ("src/foo.ts")
    // — IDENTICAL to the directory index. Rooting at the file's parent dir would
    // yield "foo.ts" → a divergent orphan node that never updates the existing
    // one. Same root threaded to parseFile + buildResolutionContext + the <repo>
    // slug (repoFromPath), keeping the single-file path consistent with the CLI.
    const repoRoot = resolveRepoRoot(absFile);
    const parsed = await parseFile(absFile, repoRoot);
    if (!parsed) throw new Error(`no parser registered for ${absFile}`);
    // SINGLE-FILE RESOLUTION FIX — the symbol table + resolution context must
    // span the WORKSPACE, not just this file. buildSymbolTable([parsed]) alone
    // left every cross-file reference unresolved: a receiver-qualified callee
    // like `EmbeddedLore.open` (class defined in another file), a bare/aliased
    // import, even the module specifier `'./lore/embeddedLore.js'` (repoFileSet
    // held ONE path) all missed, so a single-file incremental index silently
    // dropped the edited file's cross-file call/import edges — the graph rotted
    // one edit at a time while the tool reported success. The persisted graph
    // supplies the peer symbols (as resolution candidates ONLY — the fresh
    // parse of THIS file supersedes its own persisted, one-edit-stale symbols,
    // which loadPeerResolutionContext excludes) and the repo's file paths.
    const shells = peers?.shells ?? [];
    const table = buildSymbolTable([parsed, ...shells]);
    const ctx = await buildResolutionContext(repoRoot, [parsed, ...shells], peers?.extraPaths);
    // Sprint 1: full typed edge set (calls + imports + inheritance + contains)
    // rather than only call edges, so imports/extends/implements reach the store.
    // Edges are derived from [parsed] ONLY — peer shells carry no calls/imports.
    const relations = buildAllCodeEdges([parsed], table, ctx);
    if (shells.length > 0) {
        // buildAllCodeEdges derives `contains` edges from table.all, so the
        // peer-enriched table would re-emit every PEER file's parent→child
        // chains (already persisted) alongside this file's. Keep only THIS
        // file's contains edges — the rest of the graph is not this run's to
        // rewrite.
        const localIds = new Set<string>(parsed.symbols.map((s) => s.id));
        return {
            file: parsed,
            relations: relations.filter((r) => r.kind !== 'contains' || localIds.has(r.sourceId)),
            table,
            ctx,
        };
    }
    return { file: parsed, relations, table, ctx };
}

/** Load the persisted graph's SAME-REPO symbol/file context for a single-file
 *  incremental index. Returns null when the writer can't read the graph
 *  (HTTP transport — resolution degrades to file-local) or the read fails;
 *  callers treat null as "no peers available", never as an error.
 *
 *  Repo scoping matters: a workspace can host several repos, and the
 *  resolver's workspace-wide bare-name fallback must not see sibling repos'
 *  symbols — the full-repo index never resolves across repos, so the
 *  incremental path must not either (it would FABRICATE cross-repo edges). */
async function loadPeerResolutionContext(
    client: unknown,
    workspace: string,
    repo: string,
    excludeFilePath: string,
): Promise<PeerResolutionContext | null> {
    if (!canListPersisted(client)) return null;
    const cap = positiveIntEnv('ATLAS_MAX_CONTEXT_NODES', DEFAULT_MAX_CONTEXT_NODES);
    const symPrefix = `code-symbol:${repo}/`;
    const filePrefix = `code-file:${repo}/`;
    try {
        const symbolNodes = (await client.listNodes('code_symbol', undefined, workspace, cap)) as CodeSymbolNode[];
        const peers: ParsedSymbol[] = [];
        for (const n of symbolNodes) {
            if (typeof n?.id !== 'string' || !n.id.startsWith(symPrefix)) continue;
            const sym = rawSymbolFromNode(n);
            // This file's OWN persisted symbols are excluded: the fresh parse
            // supersedes them (they're one edit stale by definition, and
            // letting both into the table would double-count every candidate).
            if (!sym || sym.file === excludeFilePath) continue;
            peers.push(sym);
        }
        const fileNodes = (await client.listNodes('code_file', undefined, workspace, cap)) as Array<{ id?: string; metadata?: string | null }>;
        const extraPaths = new Set<string>();
        for (const n of fileNodes) {
            if (typeof n?.id !== 'string' || !n.id.startsWith(filePrefix)) continue;
            try {
                const meta = n.metadata ? (JSON.parse(n.metadata) as Record<string, unknown>) : undefined;
                const p = typeof meta?.['path'] === 'string' ? meta['path'] : undefined;
                if (p) extraPaths.add(p);
            } catch { /* malformed metadata row — skip it */ }
        }
        return { shells: fileShellsFromSymbols(peers), extraPaths };
    } catch (err) {
        process.stderr.write(`[atlas] single-file index: persisted-graph peer load failed, resolving file-locally: ${(err as Error).message}\n`);
        return null;
    }
}

/** Build the live-node set for a SINGLE-FILE reconcile: every currently-live
 *  file-scoped code node of this repo EXCEPT the re-indexed file's, plus the
 *  fresh batch's ids. reconcileRepoFiles then deletes exactly this file's
 *  stale nodes (renamed/removed symbols, orphaned context cards) — the
 *  single-file analog of the full-index reconcile, safe because a single-file
 *  run rewrites the COMPLETE node set of exactly one file. Returns null when
 *  the enumeration fails (reconcile skipped, never fatal). */
async function singleFileLiveNodeIds(
    reader: PersistedGraphReader,
    workspace: string,
    repo: string,
    relPath: string,
    freshIds: readonly string[],
): Promise<Set<string> | null> {
    const FILE_SCOPED_PREFIXES = ['code-file:', 'code-symbol:', 'code-context:', 'code-context-sym:'];
    const rows = (await reader.listNodes(undefined, undefined, workspace)) as Array<{ id?: string }>;
    if (!Array.isArray(rows)) return null;
    const live = new Set<string>(freshIds);
    for (const n of rows) {
        const id = n?.id;
        if (typeof id !== 'string') continue;
        const prefix = FILE_SCOPED_PREFIXES.find((p) => id.startsWith(p));
        if (!prefix) continue; // folder/import/knowledge nodes — never touched
        if (!id.startsWith(`${prefix}${repo}/`)) continue; // sibling repo — untouched
        // Repo-relative remainder: `<path>` (code-file / file-mode context
        // card) or `<path>:<uid…>` (code-symbol / span context card). Match
        // with a delimiter so `src/cli.ts` never claims `src/cli.tsx` nodes.
        const rest = id.slice(prefix.length + repo.length + 1);
        if (rest !== relPath && !rest.startsWith(`${relPath}:`)) live.add(id);
    }
    return live;
}


export async function runIndexTool(
    client: LoreWriter,
    args: IndexArgs,
    defaultWorkspace: string,
    cfg: AtlasConfig,
): Promise<unknown> {
    const workspace = args.workspace ?? defaultWorkspace;
    const abs = path.resolve(args.path);
    // Audit ATL-004 — opt-in scan-path allowlist (no-op unless configured).
    const rootErr = scanPathError(abs);
    if (rootErr) return { error: rootErr };
    if (!fs.existsSync(abs)) return { error: `path does not exist: ${abs}` };

    const isDir = fs.statSync(abs).isDirectory();
    // Mirror the CLI: indexing a directory registers it in the workspace's
    // projects.json. This is the path the DAEMON takes (so `atlas index`, the
    // git-hook nudge, and any IDE-triggered index all land here), and without it
    // `wire install --all-projects` silently covers only whatever happened to be
    // registered by hand. Idempotent, never throws — see projectRegistry.ts.
    if (isDir && registerProject(cfg, workspace, abs)) invalidateWorkspaceResolverCache();
    const repo = repoFromPath(abs);
    let filesSkipped = 0;
    let skippedFiles: { count: number; byReason: Record<string, number>; sample: string[] } | undefined;

    // Sprint 4: publish LIVE progress so the `index_status` poll tool (and the
    // header progress bar) can observe this in-process run. Every number below
    // traces to a value the indexer already computes — no fabrication. The
    // BatchWriter's onProgress callback already carries running filesDoneTotal /
    // nodesFlushed / edgesFlushed totals; we forward them verbatim.
    setProgress(workspace, {
        indexing: true,
        phase: 'parsing',
        filesDone: 0,
        filesTotal: 0,
        nodesWritten: 0,
        edgesWritten: 0,
        startedAt: Date.now(),
        finishedAt: undefined,
        error: undefined,
        jobId: args.jobId,
        skippedFiles: undefined,
    });
    const writer = new BatchWriter(client, {
        onProgress: (_line, s) => {
            setProgress(workspace, {
                phase: 'writing',
                filesDone: s.filesDoneTotal,
                nodesWritten: s.nodesFlushed,
                edgesWritten: s.edgesFlushed,
            });
        },
    });

    try {
        if (isDir) {
            // PATH-DIVERGENCE FIX (subdir) — enumerate the user-passed dir but root
            // ParsedFile.path at the git TOP-LEVEL (parse time), so `atlas_index
            // src/` yields `src/foo.ts` identical to a full-repo index instead of
            // `foo.ts` (orphan-duplicate nodes). resolveRepoRoot degrades to `abs`
            // for non-git dirs → pathRoot === walkDir → legacy behavior unchanged.
            const repoRoot = resolveRepoRoot(abs);
            const result = await parseRepo(abs, repoRoot);
            // Surface the walker/parser skips (unsupported extension, excluded
            // test fixtures, unimplemented walkers) — previously dropped here,
            // so "N files skipped" was invisible to callers.
            skippedFiles = summarizeSkipped(result.skipped);
            if (skippedFiles.count > 0) setProgress(workspace, { skippedFiles });

            // RD-idx-resume — same checkpoint/resume semantics as the CLI's
            // runRecursiveIndex (cli.ts), sharing cli/checkpoint.ts: parse EVERY
            // file (cross-file resolution must see the whole repo or an edited
            // file's edges into unchanged files rot), but WRITE only the changed
            // subset. Default ON so the post-commit `atlas index .` — which now
            // routes here via the CLI's daemon-first path, since the daemon holds
            // the single-writer store — costs a delta, not a full re-write.
            // resume:false restores the old always-full behavior.
            const resume = args.resume !== false;
            const checkpoint = resume ? loadCheckpoint(abs, workspace) : null;
            if (checkpoint) checkpoint.workspace = workspace; // stamp for the workspace guard

            // pf.path is git-top-level-relative (e.g. `src/foo.ts`).
            // indexCore/buildIndexBatch reads source + mtime from `abs`
            // (absolutePath), so reconstruct the true absolute path from
            // repoRoot — otherwise fs.readFile resolves a relative path against
            // the daemon cwd, silently yielding empty context cards.
            const items = result.files.map((pf) => {
                const absFile = path.join(repoRoot, pf.path);
                return { pf, abs: absFile, write: !checkpoint || needsReindex(absFile, checkpoint) };
            });
            filesSkipped = items.filter((i) => !i.write).length;
            // MTIME-AT-PARSE — fingerprint each file as parsed (result.files is
            // the parsed set), so the checkpoint records THAT content's mtime,
            // not whatever the file looks like when its batch lands minutes
            // later (see markIndexed's knownStat param).
            const statAtParse = new Map<string, { mtimeMs: number; sizeBytes: number }>();
            for (const i of items) {
                try {
                    const st = fs.statSync(i.abs);
                    statAtParse.set(i.abs, { mtimeMs: st.mtimeMs, sizeBytes: st.size });
                } catch { /* vanished mid-run — markIndexed falls back */ }
            }
            // Checkpoint keys are relative to the WALK root (abs), the same
            // formula needsReindex/markIndexed use — see RD-Mckptprune.
            const liveRelPaths = new Set(items.map((i) => path.relative(abs, i.abs).split(path.sep).join('/')));

            // filesTotal is the count this run will WRITE (BatchWriter's
            // filesDoneTotal counts written files), so index_status shows an
            // honest bar on incremental runs instead of stalling at N-of-total.
            setProgress(workspace, { phase: 'writing', filesTotal: items.length - filesSkipped });

            // Hand the parsed files to the SHARED index core (src/indexCore.ts) —
            // the SAME orchestration the CLI `atlas index` runs. Resolution,
            // folder/import synthesis, and the node-pass-then-edge-pass write all
            // live there; this tool keeps only the MCP-specific live-progress
            // publishing, checkpointing, and the object-shaped result.
            // RC-subdir — the MCP twin of the CLI's coversWholeRepo guard
            // (cli.ts runRecursiveIndex): a FULL re-index (resume:false) of a
            // SUBDIRECTORY must NOT reconcile. Reconcile deletes every
            // file-scoped node of this repo that is absent from this run's
            // batches, and a subdir run's batches cover only the subdir — so
            // `atlas_index {path:'<repo>/src', resume:false}` would delete
            // every file OUTSIDE src/ for the whole repo, silently. Skipping
            // reconcile for narrowed runs matches the CLI exactly; the MCP
            // tool takes no exclude globs, so coverage is purely the
            // path-vs-repoRoot check. Non-git dirs degrade resolveRepoRoot →
            // abs → always coversWholeRepo (legacy behavior unchanged). The
            // single-file path keeps its own per-file reconcile.
            const coversWholeRepo = path.resolve(abs) === path.resolve(repoRoot);
            if (!resume && !coversWholeRepo) {
                process.stderr.write(
                    '[atlas] full index of a subdirectory — skipping stale-node reconcile ' +
                    '(it is only safe when the run covers the whole repo).\n',
                );
            }
            await indexRepoFiles({
                writer,
                rootAbs: repoRoot,
                workspace,
                repo,
                items,
                // RC #2 — reconcile stale nodes ONLY on a FULL re-index
                // (resume:false) that ALSO covers the WHOLE repo (see
                // coversWholeRepo above): an incremental run's batches are a
                // subset, and a narrowed (subdir) run's batches don't span the
                // repo — either way a reconcile would delete still-valid
                // nodes. Mirrors the CLI's `!args.resume && coversWholeRepo`.
                reconcile: !resume && coversWholeRepo,
                client,
                log: (msg) => process.stderr.write(`[atlas] ${msg}\n`),
                onLanded: checkpoint
                    ? (landed) => {
                        for (const l of landed) markIndexed(l, checkpoint, statAtParse.get(l));
                        saveCheckpoint(checkpoint, liveRelPaths);
                    }
                    : undefined,
            });
        } else {
            setProgress(workspace, { phase: 'writing', filesTotal: 1 });
            const repoRoot = resolveRepoRoot(abs);
            const relPath = path.relative(repoRoot, abs).split(path.sep).join('/');
            // SINGLE-FILE RESOLUTION FIX — pull the persisted workspace graph's
            // same-repo symbols + file paths in as resolution candidates so
            // cross-file call/import edges resolve exactly as they would in a
            // full-repo pass. null (HTTP writer / read failure) degrades to the
            // legacy file-local resolution.
            const peers = await loadPeerResolutionContext(client, workspace, repo, relPath);
            const { file, relations, table, ctx } = await parseAndResolveOne(abs, peers);
            // GF-3 parity — the directory path synthesizes external-import NODES
            // once per repo (indexCore → buildImportNodes); without them every
            // file→`import:<module>` edge fails with `edge endpoint missing` on
            // a workspace where that module was never imported before.
            const importNodes = buildImportNodes(collectExternalModules([file], table, ctx), { workspace });
            if (importNodes.length > 0) writer.addAux('<single-file-import-nodes>', importNodes, []);
            const batch = await buildIndexBatch(file, { workspace, repo, absolutePath: abs }, relations);
            await writer.add(abs, batch.nodes, batch.edges);
            await writer.flush();

            // RC-single — per-file stale-node reconcile. The directory path can
            // only reconcile on a FULL run (resume batches are a subset); a
            // single-file run rewrites the COMPLETE node set of exactly one
            // file, so it can always reconcile that file: persisted code nodes
            // of this repo scoped to this file's path but absent from the fresh
            // batch belong to a symbol renamed/deleted by this edit — purge them
            // (their edges cascade) so they stop answering queries as phantom
            // callers/callees. No-op on the HTTP writer (canReconcile), and a
            // failed reconcile never fails the index — mirroring indexCore.
            if (canReconcile(client)) {
                try {
                    const live = canListPersisted(client)
                        ? await singleFileLiveNodeIds(client, workspace, repo, relPath, batch.nodes.map((n) => n.id))
                        : null;
                    if (live) {
                        const r = await client.reconcileRepoFiles(workspace, repo, live);
                        if (r.deleted.length > 0) {
                            process.stderr.write(`[atlas] single-file reconcile: removed ${r.deleted.length} stale node(s) from ${relPath}\n`);
                        }
                    }
                } catch (err) {
                    process.stderr.write(`[atlas] single-file reconcile skipped (error): ${(err as Error).message}\n`);
                }
            }
        }

        // Flush any remaining items in the buffer.
        await writer.flush();

        // RC-F2 — the workspace graph just changed. Invalidate the HTTP
        // LoreReader's module-scope loadContext cache for this workspace so
        // read tools (find_dead_code / blast_radius / hotspots / …) stop
        // serving PRE-reindex data. In HTTP/standalone mode server.ts holds the
        // process open across the index, so without this bump the cache never
        // refreshes. No-op for the embedded reader (it re-reads kuzu every call
        // and is never stale) — safe to call on both transports.
        invalidateLoreContext(workspace);

        const totals = writer.totals;
        // Terminal snapshot: filesDone === filesTotal, indexing false. Done even
        // with per-item errors (they're reported in `errors`, the index still ran).
        setProgress(workspace, {
            indexing: false,
            phase: 'done',
            filesDone: totals.files,
            nodesWritten: totals.nodes,
            edgesWritten: totals.edges,
            errorCount: totals.errors.length,
            finishedAt: Date.now(),
        });
        return {
            ok: totals.errors.length === 0,
            workspace,
            repo,
            path: abs,
            filesWritten: totals.files,
            filesSkipped,
            skippedFiles,
            nodesWritten: totals.nodes,
            edgesWritten: totals.edges,
            errors: totals.errors.length > 0 ? totals.errors : undefined,
        };
    } catch (err) {
        setProgress(workspace, {
            indexing: false,
            phase: 'error',
            finishedAt: Date.now(),
            error: (err as Error).message,
        });
        throw err;
    }
}
