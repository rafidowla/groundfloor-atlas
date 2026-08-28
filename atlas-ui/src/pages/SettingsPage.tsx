import { useEffect, useState, FormEvent } from 'react';
import {
  Activity, Bot, FolderOpen, Terminal, ShieldOff, Cloud,
  ExternalLink, RefreshCw, Check, Loader2, ChevronRight, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { invokeAtlasTool, checkAtlasHealth, buildAtlasHeaders, ensureMcpToken, ATLAS_BASE } from '../api/atlasApi';

function Section({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-card)]">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--lb-border-s)]">
        <span className="text-[var(--lb-dim)]">{icon}</span>
        <h2 className="text-sm font-semibold text-[var(--lb-body)]">{title}</h2>
      </div>
      <div className="px-5 py-4">
        {children}
      </div>
    </div>
  );
}

interface DaemonHealth {
  status: string;
  version: string;
  uptime_ms: number;
}

interface LLMCfg {
  configured: boolean;
  provider: 'ollama' | 'openai' | 'anthropic' | 'none';
  model: string;
  hasApiKey?: boolean;
  ollamaUrl?: string;
  /** Consent to send recalled context to a CLOUD provider (always redacted). */
  allowCloudContext?: boolean;
}

interface WorkspaceItem {
  id: string;
  name: string;
  nodeCount?: number;
  lastIndexed?: string;
}

interface IdeClientStatus {
  id: string;
  label: string;
  installed: boolean;
  connected: boolean;
  configPath: string | null;
  printOnly: boolean;
}

const IDE_ICONS: Record<string, string> = {
  'claude-code': '🤖',
  'claude-desktop': '🖥',
  'cursor': '⚡',
  'opencode': '🔓',
  'zcode': '⚙️',
  'antigravity': '🪐',
};

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const PROVIDERS = [
  { value: 'none', label: 'None', hint: 'Show raw Groundfloor Atlas results only' },
  { value: 'ollama', label: 'Ollama', hint: 'Local — no key required' },
  { value: 'openai', label: 'OpenAI', hint: 'Cloud — requires API key' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Cloud — requires API key' },
] as const;

const DEFAULT_MODELS: Record<string, string> = {
  none: '',
  ollama: 'llama3.2',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

// Manual-config snippet, built from the SAME base URL + bearer the UI itself
// uses. The old static snippet had FOUR bugs: the pre-rename `atlas` server
// key (connect writes `groundfloor-atlas`), `localhost` (IPv6 skew vs the 127.0.0.1
// bind), a non-standard `transport` property (clients expect `url`+`headers`),
// and NO Authorization header — pasting it against an auth-on daemon 401'd.
function buildMcpSnippet(): string {
  const auth = buildAtlasHeaders()['Authorization'];
  return JSON.stringify(
    {
      mcpServers: {
        'groundfloor-atlas': {
          url: `${ATLAS_BASE}/mcp`,
          ...(auth ? { headers: { Authorization: auth } } : {}),
        },
      },
    },
    null, 2,
  );
}

export default function SettingsPage() {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [healthOk, setHealthOk] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);

  const [llmCfg, setLlmCfg] = useState<LLMCfg | null>(null);
  const [formProvider, setFormProvider] = useState<LLMCfg['provider']>('none');
  const [formModel, setFormModel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formOllamaUrl, setFormOllamaUrl] = useState('');
  const [formAllowCloud, setFormAllowCloud] = useState(false);
  const [savingLLM, setSavingLLM] = useState(false);
  const [savedLLM, setSavedLLM] = useState(false);
  const [llmError, setLlmError] = useState('');
  const [cloudError, setCloudError] = useState('');

  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [loadingWS, setLoadingWS] = useState(false);

  const [copied, setCopied] = useState(false);

  const [ideStatuses, setIdeStatuses] = useState<IdeClientStatus[]>([]);
  const [loadingIde, setLoadingIde] = useState(false);
  const [connectingIde, setConnectingIde] = useState<string | null>(null);

  interface CloudSyncCfg {
    configured: boolean;
    enabled: boolean;
    cloudMcpUrl: string;
    syncDirection: 'push' | 'pull' | 'bidirectional';
    hasApiKey: boolean;
  }
  const [cloudCfg, setCloudCfg] = useState<CloudSyncCfg | null>(null);
  const [csEnabled, setCsEnabled] = useState(false);
  const [csUrl, setCsUrl] = useState('');
  const [csApiKey, setCsApiKey] = useState('');
  const [csSyncDir, setCsSyncDir] = useState<'push' | 'pull' | 'bidirectional'>('push');
  const [savingCloud, setSavingCloud] = useState(false);
  const [savedCloud, setSavedCloud] = useState(false);

  useEffect(() => {
    void loadHealth();
    void loadLLMConfig();
    void loadWorkspaces();
    void loadCloudSyncConfig();
    void loadIdeStatuses();
  }, []);

  async function loadHealth() {
    setRefreshingHealth(true);
    try {
      const h = await checkAtlasHealth();
      setHealth(h);
      setHealthOk(h.status === 'ok');
    } catch {
      setHealthOk(false);
    } finally {
      setRefreshingHealth(false);
    }
  }

  async function loadLLMConfig() {
    try {
      const cfg = await invokeAtlasTool('llm_config_get') as LLMCfg;
      setLlmCfg(cfg);
      setFormProvider(cfg.provider ?? 'none');
      setFormModel(cfg.model ?? '');
      setFormOllamaUrl(cfg.ollamaUrl ?? '');
      setFormAllowCloud(cfg.allowCloudContext === true);
    } catch { /* ignore */ }
  }

  async function loadWorkspaces() {
    setLoadingWS(true);
    try {
      const result = await invokeAtlasTool('workspace_list') as { workspaces?: unknown[] };
      const raw = result.workspaces ?? [];
      const normalized: WorkspaceItem[] = raw
        .map((w) => typeof w === 'string' ? { id: w, name: w } : w as WorkspaceItem)
        .filter((w) => w.name && w.name !== 'undefined');
      setWorkspaces(normalized);
    } catch {
      setWorkspaces([]);
    } finally {
      setLoadingWS(false);
    }
  }

  async function loadCloudSyncConfig() {
    try {
      const cfg = await invokeAtlasTool('cloud_sync_config_get') as CloudSyncCfg;
      setCloudCfg(cfg);
      setCsEnabled(cfg.enabled ?? false);
      setCsUrl(cfg.cloudMcpUrl ?? '');
      setCsSyncDir(cfg.syncDirection ?? 'push');
    } catch { /* ignore */ }
  }

  async function handleSaveLLM(e: FormEvent) {
    e.preventDefault();
    setSavingLLM(true);
    setLlmError('');
    try {
      const args: Record<string, unknown> = {
        provider: formProvider,
        model: formModel,
      };
      if (formApiKey.trim()) args['apiKey'] = formApiKey.trim();
      if (formOllamaUrl.trim()) args['ollamaUrl'] = formOllamaUrl.trim();
      // Always send the explicit boolean — formAllowCloud holds the loaded
      // value even when the checkbox is hidden (ollama/none), so an unrelated
      // save never flips consent.
      args['allowCloudContext'] = formAllowCloud;
      await invokeAtlasTool('llm_config_set', args);
      await loadLLMConfig();
      setSavedLLM(true);
      setTimeout(() => setSavedLLM(false), 2000);
    } catch (err) {
      setLlmError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingLLM(false);
    }
  }

  async function loadIdeStatuses() {
    setLoadingIde(true);
    try {
      await ensureMcpToken();
      const r = await fetch(`${ATLAS_BASE}/api/ide/status`, { headers: buildAtlasHeaders() });
      const data = await r.json() as { clients: IdeClientStatus[] };
      setIdeStatuses(data.clients ?? []);
    } catch { /* daemon not running */ } finally {
      setLoadingIde(false);
    }
  }

  async function handleIdeToggle(id: string, currentlyConnected: boolean) {
    setConnectingIde(id);
    try {
      await ensureMcpToken();
      await fetch(`${ATLAS_BASE}/api/ide/${currentlyConnected ? 'disconnect' : 'connect'}`, {
        method: 'POST',
        headers: buildAtlasHeaders(),
        body: JSON.stringify({ client: id }),
      });
      await loadIdeStatuses();
    } catch { /* ignore */ } finally {
      setConnectingIde(null);
    }
  }

  async function handleSaveCloud(e: FormEvent) {
    e.preventDefault();
    setSavingCloud(true);
    setCloudError('');
    try {
      const args: Record<string, unknown> = {
        enabled: csEnabled,
        cloudMcpUrl: csUrl,
        syncDirection: csSyncDir,
      };
      if (csApiKey.trim()) args['apiKey'] = csApiKey.trim();
      await invokeAtlasTool('cloud_sync_config_set', args);
      await loadCloudSyncConfig();
      setSavedCloud(true);
      setTimeout(() => setSavedCloud(false), 2000);
    } catch (err) {
      setCloudError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingCloud(false);
    }
  }

  const inputCls = 'w-full bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md px-3 py-2 text-sm text-[var(--lb-fg)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756]';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-8 space-y-6 pb-16">

        <div>
          <h1 className="text-xl font-bold text-[var(--lb-fg)]">Settings</h1>
          <p className="text-sm text-[var(--lb-dim)] mt-1">Groundfloor Atlas configuration and system status</p>
        </div>

        {/* ── 1. Daemon Status ── */}
        <Section title="Daemon Status" icon={<Activity size={16} />}>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${healthOk ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-900' : 'bg-red-950/50 text-red-400 border border-red-900'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${healthOk ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  {healthOk ? 'Online' : 'Offline'}
                </span>
                {health && (
                  <span className="text-[var(--lb-dim)] text-xs">
                    Groundfloor Atlas v{health.version} · uptime {formatUptime(health.uptime_ms)}
                  </span>
                )}
              </div>
            </div>

            <button
              onClick={() => void loadHealth()}
              disabled={refreshingHealth}
              className="flex items-center gap-1.5 text-xs text-[var(--lb-dim)] hover:text-[var(--lb-body)] border border-[var(--lb-border-s)] px-2.5 py-1.5 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={refreshingHealth ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </Section>

        {/* ── 2. LLM Provider ── */}
        <Section title="AI / LLM Provider" icon={<Bot size={16} />}>
          <form onSubmit={(e) => void handleSaveLLM(e)} className="space-y-4">
            {llmCfg && (
              <div className="flex items-center gap-2 text-xs text-[var(--lb-dim)] mb-1">
                <span>Current:</span>
                <span className={`px-2 py-px rounded border text-xs font-medium ${llmCfg.provider !== 'none' ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400' : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-dim)]'}`}>
                  {llmCfg.provider === 'none' ? 'Off' : `${llmCfg.provider} · ${llmCfg.model}`}
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-2">Provider</label>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => {
                      setFormProvider(p.value);
                      setFormModel(DEFAULT_MODELS[p.value] ?? '');
                      setFormApiKey('');
                    }}
                    className={[
                      'text-left px-3 py-2.5 rounded-lg border text-xs transition-colors',
                      formProvider === p.value
                        ? 'bg-[#da7756]/10 border-[#da7756]/40 text-[var(--lb-fg)]'
                        : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-subtle)] hover:border-[var(--lb-dim)]',
                    ].join(' ')}
                  >
                    <div className="font-medium">{p.label}</div>
                    <div className="text-[10px] text-[var(--lb-dim)] mt-px">{p.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            {formProvider !== 'none' && (
              <div>
                <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-1.5">Model</label>
                <input
                  type="text"
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                  placeholder={DEFAULT_MODELS[formProvider] ?? ''}
                  className={inputCls}
                />
              </div>
            )}

            {(formProvider === 'openai' || formProvider === 'anthropic') && (
              <>
                <div>
                  <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-1.5">
                    API Key {llmCfg?.hasApiKey ? '(saved — leave blank to keep current key)' : ''}
                  </label>
                  <input
                    type="password"
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    placeholder={llmCfg?.hasApiKey ? '••••••••' : 'sk-...'}
                    className={inputCls}
                  />
                </div>
                <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-surface)] p-3">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formAllowCloud}
                      onChange={(e) => setFormAllowCloud(e.target.checked)}
                      className="mt-0.5 accent-[#da7756]"
                    />
                    <span className="text-xs text-[var(--lb-subtle)]">
                      <span className="font-medium text-[var(--lb-text)]">Send workspace context to this cloud provider</span>
                      <br />
                      Lets chat answers use your recalled code &amp; team knowledge. Secrets
                      (API keys, passwords, tokens) and personal info (emails, phone numbers,
                      SSNs, card numbers) are <span className="font-medium">always redacted</span> before
                      anything is sent — with this off, chat answers without your data but
                      can&apos;t cite it.
                    </span>
                  </label>
                </div>
              </>
            )}

            {formProvider === 'ollama' && (
              <div>
                <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-1.5">
                  Ollama Base URL <span className="text-[var(--lb-dim)] font-normal">(default: http://localhost:11434)</span>
                </label>
                <input
                  type="text"
                  value={formOllamaUrl}
                  onChange={(e) => setFormOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className={inputCls}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={savingLLM || (formProvider !== 'none' && !formModel.trim())}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-lg bg-[#da7756] hover:bg-[#c86a47] disabled:bg-[var(--lb-surface)] disabled:text-[var(--lb-dim)] text-white text-sm font-medium transition-colors"
            >
              {savedLLM
                ? <><Check size={14} /> Saved</>
                : savingLLM
                  ? <><Loader2 size={14} className="animate-spin" /> Saving…</>
                  : 'Save LLM Configuration'
              }
            </button>
            {/* A failed save used to vanish into a swallowed catch — the button
                returned to normal and the user believed it saved. */}
            {llmError && <p className="text-[11px] text-rose-300">{llmError}</p>}
          </form>
        </Section>

        {/* ── 3. Workspaces ── */}
        <Section title="Workspaces" icon={<FolderOpen size={16} />}>
          {loadingWS ? (
            <div className="flex items-center gap-2 text-[var(--lb-dim)] text-sm py-2">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          ) : workspaces.length === 0 ? (
            <p className="text-sm text-[var(--lb-dim)]">No workspaces found.</p>
          ) : (
            <div className="space-y-1">
              {workspaces.map((ws) => (
                <Link
                  key={ws.id ?? ws.name}
                  to={`/workspace/${ws.name}`}
                  className="flex items-center justify-between px-3 py-2.5 rounded-md bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] transition-colors group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FolderOpen size={14} className="text-[#da7756] shrink-0" />
                    <span className="text-sm text-[var(--lb-body)] truncate">{ws.name}</span>
                    {ws.nodeCount !== undefined && (
                      <span className="text-xs text-[var(--lb-dim)] shrink-0">
                        {ws.nodeCount.toLocaleString()} nodes
                      </span>
                    )}
                  </div>
                  <ChevronRight size={14} className="text-[var(--lb-border-s)] group-hover:text-[var(--lb-dim)] shrink-0 transition-colors" />
                </Link>
              ))}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-[var(--lb-border-s)] flex gap-2">
            <Link
              to="/workspaces/new"
              className="text-xs text-[#da7756] hover:text-[#c86a47] transition-colors"
            >
              + Create workspace
            </Link>
            <button
              onClick={() => void loadWorkspaces()}
              className="text-xs text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors ml-auto"
            >
              Refresh
            </button>
          </div>
        </Section>

        {/* ── 4. IDE Connections ── */}
        <Section title="IDE Connections" icon={<Terminal size={16} />}>
          <p className="text-xs text-[var(--lb-dim)] mb-4">
            Connect Groundfloor Atlas to your installed IDEs. After connecting, restart the IDE — Groundfloor Atlas MCP tools appear automatically.
          </p>

          {loadingIde ? (
            <div className="flex items-center gap-2 text-[var(--lb-dim)] text-sm py-2">
              <Loader2 size={14} className="animate-spin" /> Detecting IDEs…
            </div>
          ) : ideStatuses.length === 0 ? (
            <p className="text-sm text-[var(--lb-dim)]">Could not load IDE status — is the daemon running?</p>
          ) : (
            <div className="space-y-2">
              {ideStatuses.map((ide) => {
                const icon = IDE_ICONS[ide.id] ?? '🔧';
                const isBusy = connectingIde === ide.id;
                return (
                  <div
                    key={ide.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-surface)]"
                  >
                    <span className="text-base shrink-0">{icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--lb-body)]">{ide.label}</div>
                      <div className="text-[10px] text-[var(--lb-dim)] truncate">
                        {ide.printOnly
                          ? 'Manual config required'
                          : !ide.installed
                          ? 'Not detected on this machine'
                          : ide.connected
                          ? `Connected · ${ide.configPath ?? ''}`
                          : `Detected · ${ide.configPath ?? ''}`}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {ide.installed && !ide.printOnly && (
                        <>
                          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                            ide.connected
                              ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400'
                              : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-dim)]'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${ide.connected ? 'bg-emerald-400' : 'bg-[var(--lb-border-s)]'}`} />
                            {ide.connected ? 'Connected' : 'Not connected'}
                          </span>
                          <button
                            onClick={() => void handleIdeToggle(ide.id, ide.connected)}
                            disabled={isBusy}
                            className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors disabled:opacity-50 ${
                              ide.connected
                                ? 'border-red-900/50 text-red-400 hover:bg-red-950/30'
                                : 'border-[#da7756]/40 text-[#da7756] hover:bg-[#da7756]/10'
                            }`}
                          >
                            {isBusy
                              ? <Loader2 size={11} className="animate-spin" />
                              : ide.connected ? 'Disconnect' : 'Connect'}
                          </button>
                        </>
                      )}
                      {ide.printOnly && (
                        <span className="text-[10px] text-[var(--lb-dim)] px-2">Manual only</span>
                      )}
                      {!ide.installed && !ide.printOnly && (
                        <span className="text-[10px] text-[var(--lb-dim)]">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-[var(--lb-border-s)]">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-[var(--lb-dim)]">After connecting, restart the IDE to activate Groundfloor Atlas tools.</p>
              <button
                onClick={() => void loadIdeStatuses()}
                disabled={loadingIde}
                className="flex items-center gap-1 text-xs text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors"
              >
                <RefreshCw size={10} className={loadingIde ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
            <details className="mt-3">
              <summary className="text-[10px] text-[var(--lb-dim)] cursor-pointer hover:text-[var(--lb-body)]">
                Manual config snippet (for unsupported clients)
              </summary>
              <div className="relative mt-2">
                <pre className="bg-[var(--lb-deep)] border border-[var(--lb-border-s)] rounded p-3 text-[9px] text-emerald-500 font-mono overflow-x-auto">
                  {buildMcpSnippet()}
                </pre>
                <button
                  onClick={() => void navigator.clipboard.writeText(buildMcpSnippet()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
                  className="absolute top-1.5 right-1.5 text-[9px] px-2 py-0.5 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded text-[var(--lb-dim)] hover:text-[var(--lb-body)]"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </details>
          </div>
        </Section>

        {/* ── 5. Cloud Sync ── */}
        <Section title="Cloud Sync" icon={<Cloud size={16} />}>
          <form onSubmit={(e) => void handleSaveCloud(e)} className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--lb-body)]">Enable cloud sync</p>
                <p className="text-xs text-[var(--lb-dim)] mt-px">
                  Route Lore writes to the Groundfloor cloud for multi-device and team sync.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCsEnabled((v) => !v)}
                className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors"
                title={csEnabled ? 'Disable cloud sync' : 'Enable cloud sync'}
              >
                {csEnabled
                  ? <ToggleRight size={28} className="text-[#da7756]" />
                  : <ToggleLeft size={28} className="text-[var(--lb-border-s)]" />
                }
              </button>
            </div>

            {csEnabled && (
              <>
                <div>
                  <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-1.5">
                    Cloud Lore MCP URL
                  </label>
                  <input
                    type="text"
                    value={csUrl}
                    onChange={(e) => setCsUrl(e.target.value)}
                    placeholder="https://api.groundfloor.io/lore/mcp"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-1.5">
                    Cloud API Key {cloudCfg?.hasApiKey ? '(saved — leave blank to keep)' : ''}
                  </label>
                  <input
                    type="password"
                    value={csApiKey}
                    onChange={(e) => setCsApiKey(e.target.value)}
                    placeholder={cloudCfg?.hasApiKey ? '••••••••' : 'gf-...'}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--lb-subtle)] mb-2">
                    Sync Direction
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'push', label: 'Push only', hint: 'Local → Cloud' },
                      { value: 'pull', label: 'Pull only', hint: 'Cloud → Local' },
                      { value: 'bidirectional', label: 'Both', hint: 'Two-way sync' },
                    ] as const).map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => setCsSyncDir(d.value)}
                        className={[
                          'text-left px-2.5 py-2 rounded border text-xs transition-colors',
                          csSyncDir === d.value
                            ? 'bg-[#da7756]/10 border-[#da7756]/40 text-[var(--lb-fg)]'
                            : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-subtle)] hover:border-[var(--lb-dim)]',
                        ].join(' ')}
                      >
                        <div className="font-medium">{d.label}</div>
                        <div className="text-[9px] text-[var(--lb-dim)] mt-px">{d.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {cloudCfg?.configured && (
              <div className="flex items-center gap-2 text-xs text-[var(--lb-dim)] border-t border-[var(--lb-border-s)] pt-3">
                <span>Current:</span>
                <span className={`px-2 py-px rounded border text-xs ${cloudCfg.enabled ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400' : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-dim)]'}`}>
                  {cloudCfg.enabled ? `enabled · ${cloudCfg.syncDirection}` : 'disabled'}
                </span>
              </div>
            )}

            <button
              type="submit"
              disabled={savingCloud || (csEnabled && !csUrl.trim())}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-lg bg-[#da7756] hover:bg-[#c86a47] disabled:bg-[var(--lb-surface)] disabled:text-[var(--lb-dim)] text-white text-sm font-medium transition-colors"
            >
              {savedCloud
                ? <><Check size={14} /> Saved</>
                : savingCloud
                  ? <><Loader2 size={14} className="animate-spin" /> Saving…</>
                  : 'Save Cloud Sync Configuration'
              }
            </button>
            {cloudError && <p className="text-[11px] text-rose-300">{cloudError}</p>}

            <p className="text-[10px] text-[var(--lb-border-s)] flex items-center gap-1">
              <ExternalLink size={10} />
              Cloud Lore provisioning (data plane + auth) is in the Groundfloor roadmap.
              This config will activate automatically when the endpoint is available.
            </p>
          </form>
        </Section>

        {/* ── 6. Index Exclude Patterns ── */}
        <Section title="Index Exclude Patterns" icon={<ShieldOff size={16} />}>
          <p className="text-xs text-[var(--lb-dim)] mb-3">
            Glob patterns to skip during indexing (e.g. <code className="text-[var(--lb-subtle)]">node_modules/**</code>,{' '}
            <code className="text-[var(--lb-subtle)]">dist/**</code>). One pattern per line.
          </p>
          <textarea
            rows={5}
            placeholder={"node_modules/**\ndist/**\nbuild/**\n.git/**\n*.min.js"}
            className="w-full bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md px-3 py-2 text-xs text-[var(--lb-subtle)] font-mono placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756] resize-none"
            readOnly
          />
          <p className="mt-2 text-[10px] text-[var(--lb-border-s)] flex items-center gap-1">
            <ExternalLink size={10} />
            Persisted exclude patterns are on the roadmap (Sprint 13).
          </p>
        </Section>

      </div>
    </div>
  );
}
