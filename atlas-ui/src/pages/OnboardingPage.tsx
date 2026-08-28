import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FolderOpen, CheckCircle, Circle, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { invokeAtlasTool } from '../api/atlasApi';
import { useFolderPicker } from '../hooks/useFolderPicker';
import { deriveProgress, type IndexStatusRaw } from '../graph/indexProgress';
import { classifyIndexOutcome } from '../graph/indexOutcome';
import LLMConfigBar from '../components/chat/LLMConfigBar';
import FolderBrowser from '../components/FolderBrowser';

interface StepIndicatorProps {
  step: number;
  currentStep: number;
  label: string;
}

function StepIndicator({ step, currentStep, label }: StepIndicatorProps) {
  const done = currentStep > step;
  const active = currentStep === step;
  return (
    <div className="flex items-center gap-2.5">
      {done ? (
        <CheckCircle className="w-5 h-5 text-[#da7756] shrink-0" />
      ) : (
        <Circle
          className={`w-5 h-5 shrink-0 ${active ? 'text-[#da7756]' : 'text-[var(--lb-border-s)]'}`}
        />
      )}
      <span
        className={`text-sm ${
          active ? 'text-[var(--lb-fg)] font-medium' : done ? 'text-[var(--lb-subtle)]' : 'text-[var(--lb-border-s)]'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

const MCP_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      atlas: {
        transport: 'http',
        url: 'http://127.0.0.1:3848/mcp',
        headers: { Authorization: 'Bearer <YOUR_TOKEN>' },
      },
    },
  },
  null,
  2,
);

export default function OnboardingPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const workspaceName = searchParams.get('workspace') ?? 'my-workspace';

  const { pickFolder, isTauri } = useFolderPicker();

  const [step, setStep] = useState(1);

  const [folderPath, setFolderPath] = useState('');
  const [phase, setPhase] = useState<'idle' | 'registering' | 'indexing' | 'done' | 'error'>('idle');
  const [indexError, setIndexError] = useState<string | null>(null);
  // UX-truth site #4: replaces the dead `workspace_status`/`nodeCount`/`state`
  // poll (that REST shape 404s in LOCAL/HTTP mode and the daemon never returns
  // a `state` field, so this used to hang on the 5-minute safety timeout even
  // after indexing genuinely finished) with the SAME live signal
  // AddProjectModal already uses: `index_status` for the honest in-flight
  // progress readout, and the `atlas_index` call's own settled promise (not
  // any poll) as the terminal done/error source of truth.
  const [indexStatus, setIndexStatus] = useState<IndexStatusRaw | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Best-effort auto-wire result, shown once indexing has landed. Never
  // blocks the onboarding flow — a failure here is a non-blocking warning,
  // since the project + index already succeeded by this point.
  const [wireMsg, setWireMsg] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  async function connectIde(client: string) {
    setConnecting(client);
    setConnectMsg(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke<string>('atlas_connect', { client, disconnect: false });
      setConnectMsg(`✓ Connected ${client}. Restart the IDE to load Groundfloor Atlas.`);
    } catch (err) {
      setConnectMsg(`✗ ${client}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  }

  const handleBrowse = async () => {
    const path = await pickFolder();
    if (path) setFolderPath(path);
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Stop polling on unmount so a background navigation doesn't leak an interval.
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Live index_status poll — drives ONLY the progress readout below (files
  // X/Y, nodes/edges written). Mirrors AddProjectModal's startPolling: the
  // terminal phase (done/error) is decided from the atlas_index promise
  // itself in handleStartIndexing, never from this poll, since index_status's
  // phase:'done' can't distinguish a clean run from one with per-file errors.
  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = (await invokeAtlasTool('index_status', { workspace: workspaceName })) as IndexStatusRaw | null;
        setIndexStatus(status);
      } catch {
        // polling failure is non-fatal; the atlas_index settlement is the
        // source of truth for the terminal phase.
      }
    }, 1_000);
  }, [stopPolling, workspaceName]);

  // Best-effort: install the Claude Code auto-consultation harness (hooks +
  // CLAUDE.md + skills) into the project that was just added + indexed. This
  // is the same wiring `atlas wire install <project>` does from the CLI,
  // triggered here via the atlas_wire MCP tool so onboarding is one step.
  // Never blocks or fails onboarding — the project + index already succeeded.
  async function autoWireProject(projectPath: string) {
    try {
      await invokeAtlasTool('atlas_wire', { project: projectPath, workspace: workspaceName });
      setWireMsg(`Wired Groundfloor Atlas into ${projectPath} — Claude Code will now consult it automatically (added .claude/ hooks + skills).`);
    } catch (err) {
      setWireMsg(`Could not auto-wire ${projectPath}: ${err instanceof Error ? err.message : String(err)} — you can run \`atlas wire install\` manually.`);
    }
  }

  async function handleStartIndexing(e: FormEvent) {
    e.preventDefault();
    const path = folderPath.trim();
    if (!path) return;

    setPhase('registering');
    setIndexError(null);
    setIndexStatus(null);
    setWireMsg(null);

    try {
      await invokeAtlasTool('workspace_add_project', {
        workspace: workspaceName,
        path,
      });

      setPhase('indexing');
      startPolling();

      // Terminal phase (done vs error) comes ONLY from this call's own
      // resolved/rejected value — the real result body is the sole honest
      // signal (see atlasApi.ts's detectToolFailure contract: a 200 response
      // can still be `{ok:false, errors:[...]}`). This replaces the old dead
      // `workspace_status`/`state` poll, which 404s in LOCAL/HTTP mode and
      // never returns a `state` field, so completion previously relied on the
      // 5-minute safety timeout even when indexing had long since finished.
      try {
        await invokeAtlasTool('atlas_index', { workspace: workspaceName, path });
        stopPolling();
        setPhase('done');
        void autoWireProject(path);
      } catch (err) {
        stopPolling();
        const outcome = classifyIndexOutcome(err);
        if (outcome.phase === 'done') {
          if ('partialErrorMessage' in outcome) setIndexError(outcome.partialErrorMessage);
          setPhase('done');
          void autoWireProject(path);
        } else {
          setIndexError(outcome.message);
          setPhase('error');
        }
      }
    } catch (err) {
      stopPolling();
      setIndexError((err instanceof Error ? err.message : null) ?? 'Failed to register project');
      setPhase('error');
    }
  }

  // Pure-derivation progress view — same helper the header bar / AddProjectModal
  // use, so the label/fraction logic can't drift between surfaces.
  const progress = deriveProgress(indexStatus);

  const inputCls = 'w-full px-3 py-2.5 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md text-[var(--lb-fg)] placeholder-[var(--lb-border-s)] text-sm focus:outline-none focus:ring-1 focus:ring-[#da7756] focus:border-[#da7756]';

  return (
    <div className="h-full overflow-y-auto p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-[var(--lb-fg)] mb-1">
        Set up <span className="text-[#da7756]">{workspaceName}</span>
      </h1>
      <p className="text-[var(--lb-dim)] text-sm mb-8">
        Complete these steps to start using Groundfloor Atlas for code intelligence.
      </p>

      <div className="flex flex-col gap-2.5 mb-8 p-4 rounded-lg bg-[var(--lb-card)] border border-[var(--lb-border-s)]">
        <StepIndicator step={1} currentStep={step} label="Add Project Folder" />
        <StepIndicator step={2} currentStep={step} label="Configure AI Provider" />
        <StepIndicator step={3} currentStep={step} label="Connect your IDE" />
      </div>

      {/* ── Step 1: Add Project Folder ── */}
      {step === 1 && (
        <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-card)] p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-md bg-[#da7756]/10 border border-[#da7756]/20 flex items-center justify-center">
              <FolderOpen className="w-4 h-4 text-[#da7756]" />
            </div>
            <div>
              <h2 className="font-semibold text-[var(--lb-fg)]">Add Project Folder</h2>
              <p className="text-xs text-[var(--lb-dim)]">
                Point Groundfloor Atlas at your codebase to begin indexing
              </p>
            </div>
          </div>

          {(phase === 'idle' || phase === 'error') && (
            <form onSubmit={(e) => void handleStartIndexing(e)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--lb-body)] mb-1.5">
                  Project folder path
                </label>
                {isTauri ? (
                  <div className="flex gap-2">
                    <input
                      id="folder-path"
                      type="text"
                      value={folderPath}
                      onChange={(e) => setFolderPath(e.target.value)}
                      placeholder="/Users/you/code/my-project"
                      required
                      className={`flex-1 ${inputCls}`}
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowse()}
                      title="Open folder picker"
                      className="px-3 py-2.5 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] hover:bg-[var(--lb-surface-hover)] rounded-md text-[var(--lb-subtle)] hover:text-[var(--lb-body)] text-sm transition-colors"
                    >
                      Browse
                    </button>
                  </div>
                ) : (
                  <FolderBrowser value={folderPath} onChange={setFolderPath} />
                )}
              </div>

              {indexError && (
                <div className="rounded-md border border-red-900 bg-red-950/30 p-3 text-red-400 text-sm">
                  {indexError}
                </div>
              )}

              <button
                type="submit"
                disabled={!folderPath.trim()}
                className="w-full px-4 py-2.5 bg-[#da7756] hover:bg-[#c86a47] disabled:bg-[var(--lb-surface)] disabled:text-[var(--lb-dim)] text-white text-sm font-medium rounded-md transition-colors"
              >
                Start Indexing
              </button>
            </form>
          )}

          {phase === 'registering' && (
            <div className="flex items-center gap-3 py-4 text-[var(--lb-subtle)]">
              <Loader2 size={20} className="animate-spin text-[#da7756] shrink-0" />
              <span className="text-sm">Registering project in workspace…</span>
            </div>
          )}

          {phase === 'indexing' && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3 text-[var(--lb-body)]">
                <RefreshCw size={20} className="animate-spin text-[#da7756] shrink-0" />
                <div>
                  <p className="text-sm font-medium">{progress.label}</p>
                  <p className="text-xs text-[var(--lb-dim)] font-mono mt-0.5 truncate max-w-xs">{folderPath}</p>
                </div>
              </div>
              {/* UX-truth site #4: real determinate fill from files X/Y when
                  known (same `deriveProgress` helper the header bar and
                  AddProjectModal use), indeterminate only while parsing — no
                  more fabricated static "3/4 width" bar that never moved. */}
              <div className="h-1 w-full bg-[var(--lb-surface)] rounded-full overflow-hidden">
                {progress.fraction == null ? (
                  <div className="h-full bg-[#da7756] rounded-full w-1/3 animate-pulse" />
                ) : (
                  <div
                    className="h-full bg-[#da7756] rounded-full transition-[width] duration-500"
                    style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                  />
                )}
              </div>
              {progress.filesTotal > 0 && (
                <p className="text-xs text-[var(--lb-dim)] tabular-nums">
                  {progress.filesDone.toLocaleString()} / {progress.filesTotal.toLocaleString()} files
                  {progress.nodesWritten > 0 && ` · ${progress.nodesWritten.toLocaleString()} nodes`}
                </p>
              )}
              <button
                onClick={() => setStep(2)}
                className="w-full py-2 text-sm text-[var(--lb-dim)] hover:text-[var(--lb-body)] border border-[var(--lb-border-s)] rounded-md transition-colors"
              >
                Continue in background
              </button>
            </div>
          )}

          {phase === 'done' && (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
                <p className="text-sm text-[var(--lb-body)]">
                  Indexing complete —{' '}
                  <span className="text-emerald-400 font-medium">
                    {progress.filesDone.toLocaleString()} file{progress.filesDone !== 1 ? 's' : ''}
                  </span>
                  {progress.nodesWritten > 0 && (
                    <>
                      {' · '}
                      <span className="text-emerald-400 font-medium">
                        {progress.nodesWritten.toLocaleString()} node{progress.nodesWritten !== 1 ? 's' : ''}
                      </span>
                    </>
                  )}{' '}
                  added to <span className="font-medium">{workspaceName}</span>
                </p>
              </div>
              {/* A partial-success ok:false (some files written despite errors)
                  still lands here as 'done' (onboarding has no dedicated amber
                  phase) — surface the truthful detail rather than pretending
                  it was perfectly clean. */}
              {indexError && (
                <div className="rounded-md border border-amber-900 bg-amber-950/30 p-3 text-amber-400 text-xs">
                  Completed with issues: {indexError}
                </div>
              )}
              {/* Best-effort atlas_wire result — informational only, never
                  blocks onboarding. Amber for a wire failure (rare; the
                  project + index already succeeded), subtle green for success. */}
              {wireMsg && (
                <div
                  className={`rounded-md border p-3 text-xs ${
                    wireMsg.startsWith('Could not auto-wire')
                      ? 'border-amber-900 bg-amber-950/30 text-amber-400'
                      : 'border-emerald-900 bg-emerald-950/20 text-emerald-400'
                  }`}
                >
                  {wireMsg}
                </div>
              )}
              <button
                onClick={() => setStep(2)}
                className="w-full py-2.5 bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium rounded-md transition-colors"
              >
                Continue
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Configure AI Provider ── */}
      {step === 2 && (
        <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-card)] p-6 space-y-5">
          <div>
            <h2 className="font-semibold text-[var(--lb-fg)] mb-1">Configure AI Provider</h2>
            <p className="text-xs text-[var(--lb-dim)]">
              Groundfloor Atlas uses an LLM to synthesise insights from your knowledge graph. Choose a
              provider — Ollama (local, free) or a cloud provider.
            </p>
          </div>

          <div className="flex items-center gap-3 p-3 bg-[var(--lb-surface)] rounded-lg border border-[var(--lb-border-s)]">
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <p className="text-xs text-[var(--lb-subtle)]">Click to configure your LLM provider:</p>
            </div>
            <LLMConfigBar />
          </div>

          <p className="text-[10px] text-[var(--lb-border-s)]">
            You can change this at any time from the chat header. Skip if you want raw Groundfloor Atlas results only.
          </p>

          <div className="flex gap-2">
            <button
              onClick={() => setStep(1)}
              className="flex-1 py-2 text-sm text-[var(--lb-dim)] hover:text-[var(--lb-body)] border border-[var(--lb-border-s)] rounded-md transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              className="flex-1 py-2.5 bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium rounded-md transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Connect IDE ── */}
      {step === 3 && (
        <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-card)] p-6 space-y-6">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-7 h-7 text-[#da7756] shrink-0" />
            <div>
              <h2 className="font-semibold text-[var(--lb-fg)]">Connect your IDE</h2>
              <p className="text-xs text-[var(--lb-dim)]">
                Add Groundfloor Atlas to Claude Code, Cursor, or any MCP-compatible IDE.
              </p>
            </div>
          </div>

          <div className="rounded-md border border-[#da7756]/20 bg-[#da7756]/5 p-3">
            <p className="text-xs text-[#da7756]/80">
              Easiest: run{' '}
              <code className="font-mono text-[#da7756]">atlas connect {'<your-ide>'}</code>{' '}
              in a terminal — it writes the config below <span className="font-medium">with your auth token</span> automatically
              (claude-code, claude-desktop, cursor, opencode).
            </p>
          </div>

          <div>
            <p className="text-sm text-[var(--lb-subtle)] mb-3">
              …or add this manually (replace{' '}
              <code className="font-mono text-[var(--lb-body)]">{'<YOUR_TOKEN>'}</code> with the token at{' '}
              <code className="font-mono text-[var(--lb-body)]">~/.groundfloor/atlas/mcp.token</code>):
            </p>
            <div className="relative">
              <pre className="rounded-md bg-[var(--lb-deep)] border border-[var(--lb-border-s)] p-4 text-xs text-emerald-500 font-mono overflow-x-auto">
                {MCP_SNIPPET}
              </pre>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(MCP_SNIPPET).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="absolute top-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] rounded text-xs text-[var(--lb-subtle)] hover:text-[var(--lb-body)] transition-colors"
              >
                <Copy className="w-3 h-3" />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="bg-[var(--lb-surface)] rounded-lg p-3 space-y-2.5">
            <p className="text-xs font-medium text-[var(--lb-body)]">
              One-click connect{!isTauri && <span className="text-[var(--lb-dim)]"> (desktop app only)</span>}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'claude-code', label: 'Claude Code' },
                { id: 'cursor', label: 'Cursor' },
                { id: 'claude-desktop', label: 'Claude Desktop' },
                { id: 'opencode', label: 'opencode' },
              ].map((ide) => (
                <button
                  key={ide.id}
                  onClick={() => void connectIde(ide.id)}
                  disabled={!isTauri || connecting !== null}
                  className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 bg-[var(--lb-surface-hover)] hover:bg-[var(--lb-border-s)] disabled:opacity-50 disabled:cursor-not-allowed rounded text-[var(--lb-body)] transition-colors"
                >
                  {connecting === ide.id ? 'Connecting…' : `Connect ${ide.label}`}
                </button>
              ))}
            </div>
            {connectMsg && <p className="text-[11px] text-[var(--lb-subtle)] break-words">{connectMsg}</p>}
          </div>

          <button
            onClick={() => navigate(`/workspace/${workspaceName}`)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium rounded-md transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open Workspace
          </button>
        </div>
      )}
    </div>
  );
}
