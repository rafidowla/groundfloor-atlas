/**
 * LLMConfigBar.tsx — inline LLM provider indicator + config panel for ChatPage.
 *
 * Shows current provider + model as a small chip in the chat header.
 * Clicking opens a Radix dropdown with provider/model/key fields.
 * Saves via llm_config_set Groundfloor Atlas tool — changes take effect immediately
 * on the next llm_chat call (no daemon restart needed).
 */

import { useState, useEffect, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bot, ChevronDown, Loader2, Check } from 'lucide-react';
import { invokeAtlasTool } from '../../api/atlasApi';

export interface LLMConfig {
  provider: 'ollama' | 'openai' | 'anthropic' | 'none';
  model: string;
  hasApiKey?: boolean;
  ollamaUrl?: string;
  configured?: boolean;
}

const PROVIDERS = [
  { value: 'ollama', label: 'Ollama', hint: 'Local — no key required' },
  { value: 'openai', label: 'OpenAI', hint: 'Cloud — requires API key' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Cloud — requires API key' },
  { value: 'none', label: 'None', hint: 'Show raw Groundfloor Atlas results only' },
] as const;

const DEFAULT_MODELS: Record<string, string> = {
  ollama: 'llama3.2',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  none: '',
};

interface LLMConfigBarProps {
  onConfigChange?: (cfg: LLMConfig) => void;
}

export default function LLMConfigBar({ onConfigChange }: LLMConfigBarProps) {
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  // Form state inside the dropdown
  const [formProvider, setFormProvider] = useState<LLMConfig['provider']>('none');
  const [formModel, setFormModel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formOllamaUrl, setFormOllamaUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load config on mount
  useEffect(() => {
    let cancelled = false;
    invokeAtlasTool('llm_config_get', {})
      .then((result) => {
        if (cancelled) return;
        const cfg = result as LLMConfig;
        setConfig(cfg);
        setFormProvider(cfg.provider ?? 'none');
        setFormModel(cfg.model ?? '');
        setFormOllamaUrl(cfg.ollamaUrl ?? '');
        // Propagate the loaded config to the parent on initial load, not just on
        // save. Without this, ChatPanel's llmConfig stayed null on a fresh page,
        // so provider-dependent logic (LLM-classifier routing escalation) never
        // ran and streamChat fell through to the daemon default silently.
        onConfigChange?.(cfg);
      })
      .catch(() => {
        if (!cancelled) setConfig({ provider: 'none', model: '', configured: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // When provider changes in form, fill a sensible model default
  const prevProvider = useRef(formProvider);
  useEffect(() => {
    if (formProvider !== prevProvider.current) {
      prevProvider.current = formProvider;
      setFormModel(DEFAULT_MODELS[formProvider] ?? '');
      setFormApiKey('');
    }
  }, [formProvider]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const args: Record<string, unknown> = {
        provider: formProvider,
        model: formModel,
      };
      if (formApiKey.trim()) args['apiKey'] = formApiKey.trim();
      if (formOllamaUrl.trim()) args['ollamaUrl'] = formOllamaUrl.trim();

      await invokeAtlasTool('llm_config_set', args);

      const newCfg: LLMConfig = {
        provider: formProvider,
        model: formModel,
        hasApiKey: Boolean(formApiKey.trim()),
        ollamaUrl: formOllamaUrl.trim() || undefined,
        configured: true,
      };
      setConfig(newCfg);
      onConfigChange?.(newCfg);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1200);
    } catch (err) {
      console.error('llm_config_set failed:', err);
    } finally {
      setSaving(false);
    }
  };

  // ── Chip label ────────────────────────────────────────────────────────────

  function chipLabel(): string {
    if (loading) return 'AI…';
    if (!config || config.provider === 'none') return 'AI: off';
    return `AI: ${config.provider} · ${config.model || '—'}`;
  }

  const isActive = !loading && config?.provider && config.provider !== 'none';

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className={[
            'flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border transition-colors',
            isActive
              ? 'bg-emerald-950/60 border-emerald-800 text-emerald-400 hover:bg-emerald-900/50'
              : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-dim)] hover:bg-[var(--lb-border-s)] hover:text-[var(--lb-subtle)]',
          ].join(' ')}
          title="Configure LLM provider"
        >
          {loading
            ? <Loader2 size={11} className="animate-spin" />
            : <Bot size={11} />
          }
          {chipLabel()}
          <ChevronDown size={10} className="opacity-60" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 bg-[var(--lb-card)] border border-[var(--lb-border-s)] rounded-lg shadow-2xl p-4 flex flex-col gap-3"
          onInteractOutside={() => setOpen(false)}
        >
          <p className="text-xs font-semibold text-[var(--lb-body)] pb-1 border-b border-[var(--lb-border-s)]">
            LLM Configuration
          </p>

          {/* Provider */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-[var(--lb-dim)] uppercase tracking-wide">Provider</label>
            <div className="grid grid-cols-2 gap-1.5">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setFormProvider(p.value)}
                  className={[
                    'text-left px-2.5 py-1.5 rounded border text-xs transition-colors',
                    formProvider === p.value
                      ? 'bg-[#da7756]/10 border-[#da7756]/30 text-[#da7756]/80'
                      : 'bg-[var(--lb-surface)] border-[var(--lb-border-s)] text-[var(--lb-subtle)] hover:border-[var(--lb-dim)]',
                  ].join(' ')}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-[9px] text-[var(--lb-dim)] mt-px">{p.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          {formProvider !== 'none' && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-[var(--lb-dim)] uppercase tracking-wide">Model</label>
              <input
                type="text"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder={DEFAULT_MODELS[formProvider] ?? ''}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2.5 py-1.5 text-xs text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756]"
              />
            </div>
          )}

          {/* API Key (cloud providers) */}
          {(formProvider === 'openai' || formProvider === 'anthropic') && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-[var(--lb-dim)] uppercase tracking-wide">
                API Key {config?.hasApiKey ? '(saved — leave blank to keep)' : '(required)'}
              </label>
              <input
                type="password"
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                placeholder={config?.hasApiKey ? '••••••••' : 'sk-...'}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2.5 py-1.5 text-xs text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756]"
              />
            </div>
          )}

          {/* Ollama URL (optional override) */}
          {formProvider === 'ollama' && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-[var(--lb-dim)] uppercase tracking-wide">
                Ollama URL <span className="normal-case">(default: localhost:11434)</span>
              </label>
              <input
                type="text"
                value={formOllamaUrl}
                onChange={(e) => setFormOllamaUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-2.5 py-1.5 text-xs text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756]"
              />
            </div>
          )}

          {/* Save button */}
          <button
            onClick={() => void handleSave()}
            disabled={saving || (formProvider !== 'none' && !formModel.trim())}
            className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded bg-[#da7756] hover:bg-[#da7756] text-white text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
          >
            {saved
              ? <><Check size={12} /> Saved</>
              : saving
                ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
                : 'Save configuration'
            }
          </button>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
