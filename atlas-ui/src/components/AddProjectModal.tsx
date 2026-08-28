/**
 * AddProjectModal.tsx — Add a project folder to a Lore workspace.
 *
 * Flow:
 *   1. User picks a workspace (pre-selected if one is active)
 *   2. User selects a folder (native OS dialog via Tauri, text fallback in browser)
 *   3. Call workspace_add_project → atlas_index (fire-and-forget client-side)
 *   4. Poll index_status every 1s to show LIVE files X/Y indexing progress
 *   5. On completion (indexing:false) → call onDone(workspaceName)
 *
 * Sprint 4: the poll was repointed from `workspace_status` — whose
 * /api/workspaces/:name/status route does NOT exist in this Lore daemon, so
 * `nodeCount` was always undefined and the modal only ever completed via the
 * 5-minute safety timeout — to the new `index_status` tool, which reports the
 * genuinely-observable filesDone/filesTotal + indexing flag.
 *
 * Designed to be opened from WorkspacePage or WorkspacesPage.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen, Loader2, CheckCircle2, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { invokeAtlasTool, AtlasToolError, AtlasDaemonUnreachableError } from '../api/atlasApi';
import { useFolderPicker } from '../hooks/useFolderPicker';
import { deriveProgress, type IndexStatusRaw } from '../graph/indexProgress';
import FolderBrowser from './FolderBrowser';

interface Workspace {
  id: string;
  name: string;
}

/** Shape of a successful (or partially-successful) atlas_index tool result —
 *  see src/mcp/tools/index.ts. `ok` is false whenever `errors` is non-empty,
 *  even if some files were written; that's the "partial" case (b) below
 *  distinguishes from a total failure (nothing written). */
interface AtlasIndexResult {
  ok?: boolean;
  filesWritten?: number;
  nodesWritten?: number;
  edgesWritten?: number;
  errors?: unknown[];
}

// 'pick' | 'registering' | 'indexing' → 'done' (clean success) | 'partial'
// (indexed with some errors, amber) | 'error' (real failure, red) |
// 'daemon-down' (fetch rejected — distinct from a tool-level error).
type Phase = 'pick' | 'registering' | 'indexing' | 'done' | 'partial' | 'error' | 'daemon-down';

interface AddProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-select a workspace name (e.g., when opened from WorkspacePage) */
  defaultWorkspace?: string;
  /** Called when indexing completes successfully */
  onDone?: (workspaceName: string) => void;
  /** Called the instant atlas_index is fired, so a parent (WorkspacePage) can
   *  start its own index_status poll for the header progress bar. */
  onIndexStart?: (workspaceName: string) => void;
}

export default function AddProjectModal({
  open,
  onOpenChange,
  defaultWorkspace,
  onDone,
  onIndexStart,
}: AddProjectModalProps) {
  const { pickFolder, isTauri } = useFolderPicker();

  // Workspace selection
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState(defaultWorkspace ?? '');
  const [loadingWS, setLoadingWS] = useState(false);

  // Folder path
  const [folderPath, setFolderPath] = useState('');

  // Flow state
  const [phase, setPhase] = useState<Phase>('pick');
  const [errorMsg, setErrorMsg] = useState('');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Populated on a 'partial' result: some files were written despite errors.
  const [partialResult, setPartialResult] = useState<AtlasIndexResult | null>(null);
  // Latest index_status snapshot (Sprint 4) — drives the live files X/Y bar.
  const [indexStatus, setIndexStatus] = useState<IndexStatusRaw | null>(null);
  // Best-effort atlas_wire result, shown once indexing lands. Never blocks
  // or fails the modal's flow — the project + index already succeeded.
  const [wireMsg, setWireMsg] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Load workspaces when modal opens
  useEffect(() => {
    if (!open) return;
    setPhase('pick');
    setFolderPath('');
    setErrorMsg('');
    setErrorDetail(null);
    setPartialResult(null);
    setIndexStatus(null);
    setWireMsg(null);
    if (defaultWorkspace) setSelectedWorkspace(defaultWorkspace);

    setLoadingWS(true);
    invokeAtlasTool('workspace_list')
      .then((result) => {
        const r = result as { workspaces?: (Workspace | string)[] };
        // API may return string[] — normalize to {id, name} objects
        const normalized: Workspace[] = (r.workspaces ?? [])
          .map((w) => typeof w === 'string' ? { id: w, name: w } : w)
          .filter((w) => w.name && w.name !== 'undefined');
        setWorkspaces(normalized);
        if (!defaultWorkspace && normalized.length > 0) {
          setSelectedWorkspace(normalized[0]!.name);
        }
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoadingWS(false));
  }, [open, defaultWorkspace]);

  // Stop polling when modal closes
  useEffect(() => {
    if (!open && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [open]);

  // Best-effort: install the Claude Code auto-consultation harness (hooks +
  // CLAUDE.md + skills) into the project that was just added + indexed —
  // same wiring `atlas wire install <project>` does from the CLI, via the
  // atlas_wire MCP tool so the browser UI can trigger it too. Never blocks or
  // fails this flow; the project + index already succeeded by this point.
  const autoWireProject = useCallback(async (projectPath: string, wsName: string) => {
    try {
      await invokeAtlasTool('atlas_wire', { project: projectPath, workspace: wsName });
      setWireMsg(`Wired Groundfloor Atlas into ${projectPath} — Claude Code will now consult it automatically (added .claude/ hooks + skills).`);
    } catch (err) {
      setWireMsg(`Could not auto-wire ${projectPath}: ${err instanceof Error ? err.message : String(err)} — you can run \`atlas wire install\` manually.`);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    // Also cancel the 5-minute safety timeout — it used to dangle and call
    // stopPolling long after the modal closed (harmless but leaked).
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (wsName: string) => {
      stopPolling();
      // Track whether we've observed the run actually start, so a stale
      // pre-start `indexing:false` snapshot doesn't spin the interval forever.
      // NOTE: this loop ONLY drives the live files X/Y progress bar now — the
      // terminal phase (done / partial / error) is decided in handleIndex from
      // the atlas_index call's own settled result, since index_status's
      // phase:'done' does not distinguish a clean run from one with per-file
      // errors (see the failure-detection contract in atlasApi.ts).
      let sawIndexing = false;
      pollRef.current = setInterval(async () => {
        try {
          const status = (await invokeAtlasTool('index_status', { workspace: wsName })) as IndexStatusRaw | null;
          setIndexStatus(status);
          if (status?.indexing === true) {
            sawIndexing = true;
          } else if (sawIndexing || status?.phase === 'done' || status?.phase === 'error') {
            // Run finished (or already terminal) — nothing left to poll for.
            stopPolling();
          }
        } catch {
          // polling failure is non-fatal; the atlas_index settlement above is
          // the source of truth for the terminal phase.
        }
      }, 1_000);
    },
    [stopPolling],
  );

  const handleBrowse = async () => {
    if (!isTauri) {
      pathInputRef.current?.focus();
      return;
    }
    const path = await pickFolder();
    if (path) setFolderPath(path);
  };

  const handleIndex = async () => {
    if (!selectedWorkspace || !folderPath.trim()) return;
    setPhase('registering');
    setErrorMsg('');
    setErrorDetail(null);
    setPartialResult(null);
    setWireMsg(null);

    try {
      // Step 1: register project in workspace
      await invokeAtlasTool('workspace_add_project', {
        workspace: selectedWorkspace,
        path: folderPath.trim(),
      });

      // Step 2: trigger indexing (fire-and-forget; it runs async server-side —
      // the HTTP call stays open until the run completes, so we DON'T await it.
      // index_status polling drives the LIVE progress bar, but the terminal
      // outcome (clean success / partial / failure) is decided from THIS
      // call's resolved/rejected value — it's the only place the real result
      // body (`ok`, `errors[]`) is visible. See the failure-detection contract
      // in atlasApi.ts: a 200 response can still mean total or partial failure.
      setPhase('indexing');
      onIndexStart?.(selectedWorkspace);
      invokeAtlasTool('atlas_index', {
        workspace: selectedWorkspace,
        path: folderPath.trim(),
      })
        .then((result) => {
          // Genuine clean success: ok !== false (defensively treat a missing
          // `ok` as success too, for older daemon builds that predate the
          // field — but a top-level error/errors would already have thrown).
          stopPolling();
          setPhase('done');
          void result;
          void autoWireProject(folderPath.trim(), selectedWorkspace);
        })
        .catch((err: unknown) => {
          stopPolling();
          if (err instanceof AtlasDaemonUnreachableError) {
            setPhase('daemon-down');
            setErrorMsg(err.message);
            return;
          }
          if (err instanceof AtlasToolError) {
            const raw = err.raw as AtlasIndexResult | undefined;
            const filesWritten = raw?.filesWritten ?? 0;
            const nodesWritten = raw?.nodesWritten ?? 0;
            if ((filesWritten > 0 || nodesWritten > 0) && raw) {
              // Partial success: some files/nodes DID land despite errors —
              // this is NOT a clean success and must not show the green
              // "Project indexed!" toast, but it's also not a total failure.
              // The project is still real content in the workspace, so it's
              // still worth wiring the harness in.
              setPartialResult(raw);
              setPhase('partial');
              void autoWireProject(folderPath.trim(), selectedWorkspace);
              return;
            }
            setErrorMsg(err.message);
            setErrorDetail(
              err.detail != null
                ? typeof err.detail === 'string'
                  ? err.detail
                  : JSON.stringify(err.detail)
                : null,
            );
            setPhase('error');
            return;
          }
          setErrorMsg((err as Error).message ?? 'Indexing failed');
          setPhase('error');
        });

      // Step 3: poll index_status for LIVE files X/Y progress (1s). This ONLY
      // drives the progress bar now — the terminal phase transition (done /
      // partial / error) is decided above from the atlas_index result itself,
      // since index_status's phase:'done' does not distinguish a clean run
      // from one that completed with per-file errors.
      startPolling(selectedWorkspace);

      // Safety timeout: stop polling after 5 minutes regardless (the
      // atlas_index resolution above should normally settle us well before
      // this — this only guards against a wedged poll).
      safetyTimeoutRef.current = setTimeout(() => {
        stopPolling();
      }, 300_000);
    } catch (err) {
      if (err instanceof AtlasDaemonUnreachableError) {
        setPhase('daemon-down');
        setErrorMsg(err.message);
        return;
      }
      if (err instanceof AtlasToolError) {
        setErrorMsg(err.message);
        setErrorDetail(
          err.detail != null ? (typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)) : null,
        );
        setPhase('error');
        return;
      }
      setErrorMsg((err as Error).message ?? 'Failed to register project');
      setPhase('error');
    }
  };

  const handleDone = () => {
    stopPolling();
    onDone?.(selectedWorkspace);
    onOpenChange(false);
  };

  // ── Computed values ────────────────────────────────────────────────────────

  // Live progress derived from the same pure helper the header bar uses.
  const progress = deriveProgress(indexStatus);
  const isReady = phase === 'pick' && selectedWorkspace && folderPath.trim().length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[480px] max-w-[95vw] bg-[var(--lb-card)] border border-[var(--lb-border-s)] rounded-xl shadow-2xl p-6 flex flex-col gap-5 focus:outline-none"
          onInteractOutside={(e) => {
            if (phase === 'indexing') e.preventDefault(); // prevent close during indexing
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-[var(--lb-fg)]">
              Add Project
            </Dialog.Title>
            {phase !== 'indexing' && (
              <Dialog.Close asChild>
                <button className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors">
                  <X size={16} />
                </button>
              </Dialog.Close>
            )}
          </div>

          {/* ── Pick phase ────────────────────────────────────────────────── */}
          {phase === 'pick' && (
            <>
              {/* Workspace selector */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--lb-subtle)]">Workspace</label>
                {loadingWS ? (
                  <div className="flex items-center gap-2 text-[var(--lb-dim)] text-sm py-2">
                    <Loader2 size={14} className="animate-spin" />
                    Loading workspaces…
                  </div>
                ) : workspaces.length === 0 ? (
                  <p className="text-sm text-[var(--lb-dim)]">
                    No workspaces found. Create one first.
                  </p>
                ) : (
                  <select
                    value={selectedWorkspace}
                    onChange={(e) => setSelectedWorkspace(e.target.value)}
                    className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md px-3 py-2 text-sm text-[var(--lb-body)] focus:outline-none focus:border-[#da7756]"
                  >
                    {workspaces.map((ws) => (
                      <option key={ws.id ?? ws.name} value={ws.name}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Folder picker */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--lb-subtle)]">Project Folder</label>
                {isTauri ? (
                  <div className="flex gap-2">
                    <input
                      ref={pathInputRef}
                      type="text"
                      value={folderPath}
                      onChange={(e) => setFolderPath(e.target.value)}
                      placeholder="/Users/you/code/my-project"
                      className="flex-1 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756]"
                    />
                    <button
                      onClick={() => void handleBrowse()}
                      className="flex items-center gap-1.5 px-3 py-2 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] hover:bg-[var(--lb-border-s)] rounded-md text-[var(--lb-subtle)] hover:text-[var(--lb-body)] text-xs transition-colors"
                      title="Open folder picker"
                    >
                      <FolderOpen size={14} />
                      Browse
                    </button>
                  </div>
                ) : (
                  <FolderBrowser value={folderPath} onChange={setFolderPath} />
                )}
              </div>

              {/* Action button */}
              <button
                onClick={() => void handleIndex()}
                disabled={!isReady}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#da7756] hover:bg-[#c86a47] disabled:bg-[var(--lb-border-s)] disabled:text-[var(--lb-dim)] text-white text-sm font-medium transition-colors"
              >
                Index Project
              </button>
            </>
          )}

          {/* ── Registering phase ─────────────────────────────────────────── */}
          {phase === 'registering' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 size={32} className="animate-spin text-[#da7756]" />
              <p className="text-sm text-[var(--lb-body)]">Registering project in workspace…</p>
              <p className="text-xs text-[var(--lb-dim)] font-mono truncate max-w-full">{folderPath}</p>
            </div>
          )}

          {/* ── Indexing phase ────────────────────────────────────────────── */}
          {phase === 'indexing' && (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-3">
                <RefreshCw size={20} className="animate-spin text-[#da7756] shrink-0" />
                <div>
                  <p className="text-sm font-medium text-[var(--lb-body)]">Indexing…</p>
                  <p className="text-xs text-[var(--lb-dim)] mt-px font-mono truncate max-w-[340px]">
                    {folderPath}
                  </p>
                </div>
              </div>

              {/* Progress bar — determinate from real files X/Y when known,
                  indeterminate while parsing (no fabricated %). */}
              <div>
                <p className="text-xs text-[var(--lb-subtle)] mb-1">{progress.label}</p>
                <div className="w-full h-1 bg-[var(--lb-surface)] rounded-full overflow-hidden">
                  {progress.fraction == null ? (
                    <div className="h-full bg-[#da7756] rounded-full w-1/3 animate-pulse" />
                  ) : (
                    <div
                      className="h-full bg-[#da7756] rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                    />
                  )}
                </div>
              </div>

              {/* Live stats — the genuinely observable signal: files X/Y +
                  running node/edge totals (NOT a workspace node count, which is
                  not honestly available against this daemon). */}
              <div className="flex gap-6 text-sm">
                <div className="flex flex-col">
                  <span className="text-xs text-[var(--lb-dim)]">Workspace</span>
                  <span className="font-medium text-[var(--lb-body)]">{selectedWorkspace}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-[var(--lb-dim)]">Files</span>
                  <span className="font-medium text-emerald-400 tabular-nums">
                    {progress.filesTotal > 0
                      ? `${progress.filesDone.toLocaleString()} / ${progress.filesTotal.toLocaleString()}`
                      : progress.filesDone.toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-[var(--lb-dim)]">Nodes · Edges</span>
                  <span className="font-medium text-[var(--lb-body)] tabular-nums">
                    {progress.nodesWritten.toLocaleString()} · {progress.edgesWritten.toLocaleString()}
                  </span>
                </div>
              </div>

              <p className="text-[10px] text-[var(--lb-dim)]">
                Indexing runs in the background. You can navigate away — Groundfloor Atlas will continue.
              </p>
            </div>
          )}

          {/* ── Done phase — ONLY genuine success (atlas_index resolved
               without a thrown AtlasToolError). Never shown for ok:false or a
               non-empty errors[], even if some files landed — that's the
               'partial' phase below. This is the core of the fix: previously
               index_status's phase:'done' alone triggered this toast, even
               when the underlying result was ok:false. ──────────────────── */}
          {phase === 'done' && (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <CheckCircle2 size={40} className="text-emerald-400" />
              <div>
                <p className="text-base font-semibold text-[var(--lb-fg)]">Project indexed!</p>
                <p className="text-sm text-[var(--lb-subtle)] mt-1">
                  <span className="font-medium text-emerald-400">
                    {progress.filesDone.toLocaleString()} file{progress.filesDone !== 1 ? 's' : ''}
                  </span>
                  {progress.nodesWritten > 0 && (
                    <>
                      {' · '}
                      <span className="font-medium text-emerald-400">
                        {progress.nodesWritten.toLocaleString()} node{progress.nodesWritten !== 1 ? 's' : ''}
                      </span>
                    </>
                  )}
                  {' '}added to <span className="font-medium text-[var(--lb-body)]">{selectedWorkspace}</span>
                </p>
              </div>
              {/* Best-effort atlas_wire result — informational only, never
                  blocks this flow. Amber for a wire failure (rare; the
                  project + index already succeeded), subtle green for success. */}
              {wireMsg && (
                <div
                  className={`w-full rounded-lg border p-2.5 text-xs ${
                    wireMsg.startsWith('Could not auto-wire')
                      ? 'border-amber-900 bg-amber-950/30 text-amber-400'
                      : 'border-emerald-900 bg-emerald-950/20 text-emerald-400'
                  }`}
                >
                  {wireMsg}
                </div>
              )}
              <button
                onClick={handleDone}
                className="px-6 py-2.5 rounded-lg bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium transition-colors"
              >
                Open Workspace
              </button>
            </div>
          )}

          {/* ── Partial phase — ok:false but SOME files/nodes were written.
               Distinct amber warning, not a clean green success and not a red
               hard failure: the operator needs to know the index is
               incomplete without being told nothing happened. */}
          {phase === 'partial' && (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex flex-col items-center gap-3 text-center">
                <AlertTriangle size={36} className="text-amber-400" />
                <div>
                  <p className="text-base font-semibold text-amber-300">
                    Indexed with {partialResult?.errors?.length ?? 0} error
                    {(partialResult?.errors?.length ?? 0) === 1 ? '' : 's'}
                  </p>
                  <p className="text-sm text-gray-400 mt-1">
                    <span className="font-medium text-amber-300">
                      {(partialResult?.filesWritten ?? 0).toLocaleString()} file
                      {(partialResult?.filesWritten ?? 0) === 1 ? '' : 's'}
                    </span>
                    {(partialResult?.nodesWritten ?? 0) > 0 && (
                      <>
                        {' · '}
                        <span className="font-medium text-amber-300">
                          {(partialResult?.nodesWritten ?? 0).toLocaleString()} node
                          {(partialResult?.nodesWritten ?? 0) === 1 ? '' : 's'}
                        </span>
                      </>
                    )}
                    {' '}written to <span className="font-medium text-gray-200">{selectedWorkspace}</span> —
                    the run did not fully complete.
                  </p>
                </div>
              </div>
              {partialResult?.errors && partialResult.errors.length > 0 && (
                <div className="rounded-lg bg-amber-950/30 border border-amber-900/60 p-2.5 text-xs text-amber-300/90 max-h-24 overflow-y-auto font-mono">
                  {partialResult.errors.slice(0, 5).map((e, i) => (
                    <div key={i} className="truncate">{typeof e === 'string' ? e : JSON.stringify(e)}</div>
                  ))}
                  {partialResult.errors.length > 5 && (
                    <div className="text-amber-400/70 mt-1">
                      +{partialResult.errors.length - 5} more
                    </div>
                  )}
                </div>
              )}
              {wireMsg && (
                <div
                  className={`w-full rounded-lg border p-2.5 text-xs ${
                    wireMsg.startsWith('Could not auto-wire')
                      ? 'border-amber-900 bg-amber-950/30 text-amber-400'
                      : 'border-emerald-900 bg-emerald-950/20 text-emerald-400'
                  }`}
                >
                  {wireMsg}
                </div>
              )}
              <button
                onClick={handleDone}
                className="w-full py-2.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium transition-colors"
              >
                Open Workspace
              </button>
            </div>
          )}

          {/* ── Error phase — genuine failure (nothing written, or a
               transport-level tool error). Shows the REAL message + detail
               instead of a misleading success state. */}
          {phase === 'error' && (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg bg-red-950/40 border border-red-900 p-3 text-sm text-red-400">
                <p>{errorMsg || 'An error occurred during indexing.'}</p>
                {errorDetail && (
                  <p className="mt-1.5 text-xs text-red-400/70 font-mono break-words">{errorDetail}</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPhase('pick')}
                  className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => void handleIndex()}
                  className="flex-1 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* ── Daemon-down phase — the fetch itself rejected (connection
               refused / daemon not running), distinct from a tool-level
               error: we never got a response at all, so blaming "the index"
               would be misleading. Mirrors WorkspacePage's daemon-unreachable
               state for a consistent vocabulary across the app. */}
          {phase === 'daemon-down' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <div className="w-14 h-14 rounded-full bg-rose-950/40 border border-rose-800/60 flex items-center justify-center">
                  <AlertTriangle size={24} className="text-rose-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-rose-300">Groundfloor Atlas daemon not reachable</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {errorMsg || 'The local daemon is not responding. Make sure Groundfloor Atlas is running.'}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPhase('pick')}
                  className="flex-1 py-2 rounded-lg bg-[var(--lb-surface)] hover:bg-[var(--lb-border-s)] text-[var(--lb-body)] text-sm transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => void handleIndex()}
                  className="flex-1 py-2 rounded-lg bg-[#da7756] hover:bg-[#da7756] text-white text-sm transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
