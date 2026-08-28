import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FolderOpen,
  Plus,
  Clock,
  Pencil,
  Trash2,
  MoreHorizontal,
  Check,
  X,
  BookOpen,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { invokeAtlasTool } from '../api/atlasApi';

type StatsSource = 'snapshot' | 'none';

interface Workspace {
  id: string;
  name: string;
  nodeCount?: number;
  edgeCount?: number;
  typeBreakdown?: Record<string, number>;
  projects?: string[];
  projectCount?: number;
  lastIndexed?: string | null;
  statsSource?: StatsSource;
  /** true while a lazy workspace_status backfill is in flight for this card */
  statsLoading?: boolean;
  /** count of decisions with no approved PM change request behind them
   *  (flag, never block; project-level, never per-person). Undefined until the
   *  flag_unbacked_work backfill resolves for this card. */
  flagCount?: number;
  /** the flagged items themselves (for the expandable panel). */
  flags?: FlagItem[];
}

interface FlagItem {
  id: string;
  type: string;
  label: string;
  reason: string;
}

import { KNOWLEDGE_TYPES } from '@atlas-schema';

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatCount(n: number): string {
  if (n < 100_000) return n.toLocaleString();
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function knowledgeCount(typeBreakdown: Record<string, number> | undefined): number {
  if (!typeBreakdown) return 0;
  return KNOWLEDGE_TYPES.reduce((sum, t) => sum + (typeBreakdown[t] ?? 0), 0);
}

function useOutsideClick(ref: React.RefObject<HTMLElement | null>, cb: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) cb();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, cb]);
}

function KpiCell({ value, label, loading }: { value: number; label: string; loading: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {loading ? (
        <div className="h-4 w-8 rounded bg-[var(--lb-border)] animate-pulse" />
      ) : (
        <span className="text-sm font-semibold text-[var(--lb-fg)] tabular-nums">{formatCount(value)}</span>
      )}
      <span className="text-[10px] uppercase tracking-wider text-[var(--lb-dim)]">{label}</span>
    </div>
  );
}

interface WorkspaceCardProps {
  ws: Workspace;
  onDeleted: (id: string) => void;
  onRenamed: (id: string, newName: string) => void;
  onRefreshStats: (id: string) => void;
}

function WorkspaceCard({ ws, onDeleted, onRenamed, onRefreshStats }: WorkspaceCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showFlags, setShowFlags] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newName, setNewName] = useState(ws.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useOutsideClick(menuRef, () => { setMenuOpen(false); setConfirmDelete(false); });

  function startRename() {
    setMenuOpen(false);
    setNewName(ws.name);
    setErr('');
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 30);
  }

  async function commitRename() {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === ws.name) { setRenaming(false); return; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      setErr('Use lowercase letters, numbers, and hyphens only');
      return;
    }
    setBusy(true);
    try {
      await invokeAtlasTool('workspace_rename', { workspace: ws.name, newName: trimmed });
      onRenamed(ws.id, trimmed);
      setRenaming(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commitDelete() {
    setBusy(true);
    try {
      await invokeAtlasTool('workspace_delete', { workspace: ws.name });
      onDeleted(ws.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const isIndexed = ws.statsSource === 'snapshot' && (ws.nodeCount ?? 0) > 0;
  const isLoadingStats = ws.statsLoading === true;
  const kCount = knowledgeCount(ws.typeBreakdown);
  const secondaryLine =
    ws.projectCount !== undefined
      ? `${ws.projectCount} project${ws.projectCount === 1 ? '' : 's'}`
      : 'workspace';

  return (
    <div className="group relative flex flex-col gap-3 p-4 rounded-lg border border-[var(--lb-border)] bg-[var(--lb-item-bg)] hover:bg-[var(--lb-item-hover)] hover:border-[var(--lb-border-s)] transition-colors h-full">
      {/* Row 1: identity */}
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-md bg-[#da7756]/10 border border-[#da7756]/20 flex items-center justify-center shrink-0">
          <FolderOpen className="w-3.5 h-3.5 text-[#da7756]" />
        </div>

        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setErr(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenaming(false); }}
                  className="flex-1 bg-[var(--lb-surface)] border border-[#da7756] rounded px-2 py-0.5 text-sm text-[var(--lb-body)] focus:outline-none"
                  disabled={busy}
                />
                <button onClick={() => void commitRename()} disabled={busy} className="text-[#da7756] hover:text-[#c86a47] disabled:opacity-40 relative z-10">
                  <Check size={14} />
                </button>
                <button onClick={() => setRenaming(false)} disabled={busy} className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] relative z-10">
                  <X size={14} />
                </button>
              </div>
              {err && <p className="text-[10px] text-red-400">{err}</p>}
            </div>
          ) : (
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--lb-body)] truncate">
                <Link to={`/workspace/${ws.id}`} className="after:absolute after:inset-0">
                  {ws.name}
                </Link>
              </div>
              <div className="text-xs text-[var(--lb-dim)] mt-0.5 truncate">{secondaryLine}</div>
            </div>
          )}
        </div>

        {/* ··· menu button */}
        {!renaming && (
          <div ref={menuRef} className="relative shrink-0 z-10">
            <button
              onClick={(e) => { e.preventDefault(); setMenuOpen((o) => !o); setConfirmDelete(false); }}
              className="p-1 rounded text-[var(--lb-dim)] hover:text-[var(--lb-body)] hover:bg-[var(--lb-border-s)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            >
              <MoreHorizontal size={14} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-7 z-50 w-48 bg-[var(--lb-surface)] border border-[var(--lb-border)] rounded-lg shadow-lg overflow-hidden">
                <button
                  onClick={startRename}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--lb-body)] hover:bg-[var(--lb-item-hover)] transition-colors"
                >
                  <Pencil size={13} className="text-[var(--lb-dim)]" /> Rename
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onRefreshStats(ws.id); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--lb-body)] hover:bg-[var(--lb-item-hover)] transition-colors"
                >
                  <RefreshCw size={13} className="text-[var(--lb-dim)]" /> Refresh stats
                </button>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-950/30 transition-colors"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                ) : (
                  <div className="px-3 py-2 border-t border-[var(--lb-border)]">
                    <p className="text-xs text-[var(--lb-dim)] mb-2">Delete "{ws.name}"? This is irreversible.</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void commitDelete()}
                        disabled={busy}
                        className="flex-1 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-medium disabled:opacity-40 transition-colors"
                      >
                        {busy ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="flex-1 py-1 rounded bg-[var(--lb-border-s)] text-[var(--lb-body)] text-xs transition-colors hover:bg-[var(--lb-border)]"
                      >
                        Cancel
                      </button>
                    </div>
                    {err && <p className="text-[10px] text-red-400 mt-1">{err}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!isIndexed && !isLoadingStats ? (
        <div className="flex flex-col gap-0.5 pt-3 border-t border-[var(--lb-border)] mt-auto">
          <span className="text-xs text-[var(--lb-dim)]">Not indexed yet</span>
          <code className="text-[10px] text-[var(--lb-subtle)] font-mono">atlas index &lt;path&gt;</code>
        </div>
      ) : (
        <>
          {/* Row 2: KPI strip */}
          <div className="grid grid-cols-4 gap-2 pt-3 border-t border-[var(--lb-border)]">
            <KpiCell value={ws.nodeCount ?? 0} label="Nodes" loading={isLoadingStats} />
            <KpiCell value={ws.edgeCount ?? 0} label="Edges" loading={isLoadingStats} />
            <KpiCell value={ws.typeBreakdown?.code_file ?? 0} label="Files" loading={isLoadingStats} />
            <KpiCell value={ws.typeBreakdown?.code_symbol ?? 0} label="Symbols" loading={isLoadingStats} />
          </div>

          {/* Row 3: footer */}
          <div className="flex items-center justify-between mt-auto">
            <span className="flex items-center gap-1 text-xs text-[var(--lb-dim)]">
              <Clock className="w-3 h-3" />
              {ws.lastIndexed ? `indexed ${formatRelativeTime(ws.lastIndexed)}` : 'never indexed'}
            </span>
            <span className="flex items-center gap-1.5">
              {typeof ws.flagCount === 'number' && ws.flagCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowFlags((v) => !v)}
                  title={`${ws.flagCount} change${ws.flagCount === 1 ? '' : 's'} with no approved change request — click to view. A PremiseHQ AI project manager drafts and tracks these.`}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                >
                  <AlertTriangle size={11} />
                  {ws.flagCount} unbacked
                </button>
              )}
              {kCount > 0 && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-[#da7756]/10 text-[#da7756] border border-[#da7756]/20">
                  <BookOpen size={11} />
                  {kCount}
                </span>
              )}
            </span>
          </div>

          {/* Row 4 (expandable): the unbacked-work panel — flag, never block */}
          {showFlags && (ws.flags?.length ?? 0) > 0 && (
            <div className="mt-2 pt-2 border-t border-[var(--lb-border)] flex flex-col gap-1">
              <div className="text-[11px] text-[var(--lb-dim)]">
                Work with no approved change request:
              </div>
              {ws.flags!.slice(0, 8).map((f) => (
                <div key={f.id} className="text-[11px] text-[var(--lb-fg)] leading-snug truncate" title={f.label || f.id}>
                  • {f.label || f.id}
                </div>
              ))}
              {ws.flags!.length > 8 && (
                <div className="text-[11px] text-[var(--lb-dim)]">…and {ws.flags!.length - 8} more</div>
              )}
              <div className="text-[10px] text-[var(--lb-dim)] mt-1 leading-snug">
                Not blocked. A PremiseHQ AI project manager drafts and tracks these — automate it in PremiseHQ.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-[var(--lb-border)] bg-[var(--lb-item-bg)] h-full">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-md bg-[var(--lb-border)] animate-pulse shrink-0" />
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="h-3.5 w-2/3 rounded bg-[var(--lb-border)] animate-pulse" />
          <div className="h-3 w-1/3 rounded bg-[var(--lb-border)] animate-pulse" />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 pt-3 border-t border-[var(--lb-border)]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="h-4 w-8 rounded bg-[var(--lb-border)] animate-pulse" />
            <div className="h-2 w-10 rounded bg-[var(--lb-border)] animate-pulse" />
          </div>
        ))}
      </div>
      <div className="h-3 w-24 rounded bg-[var(--lb-border)] animate-pulse mt-auto" />
    </div>
  );
}

function toEpoch(lastIndexed: string | null | undefined): number {
  if (!lastIndexed) return -Infinity;
  const t = new Date(lastIndexed).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const backfillStats = useCallback(async (name: string) => {
    setWorkspaces((ws) => ws.map((w) => w.id === name ? { ...w, statsLoading: true } : w));
    try {
      const result = await invokeAtlasTool('workspace_status', { workspace: name });
      const r = result as {
        ok?: boolean;
        nodeCount?: number;
        edgeCount?: number;
        typeBreakdown?: Record<string, number>;
      };
      if (r && r.ok) {
        setWorkspaces((ws) => ws.map((w) => w.id === name ? {
          ...w,
          nodeCount: r.nodeCount ?? 0,
          edgeCount: r.edgeCount ?? 0,
          typeBreakdown: r.typeBreakdown ?? {},
          statsSource: (r.nodeCount ?? 0) > 0 ? 'snapshot' : w.statsSource,
          statsLoading: false,
        } : w));
      } else {
        setWorkspaces((ws) => ws.map((w) => w.id === name ? { ...w, statsLoading: false } : w));
      }
    } catch {
      setWorkspaces((ws) => ws.map((w) => w.id === name ? { ...w, statsLoading: false } : w));
    }
  }, []);

  // Fire-and-forget: fetch the "unbacked work" flag count/list for a workspace
  // (the free-tool "names the pain" surface). Runs for EVERY workspace on load,
  // independent of the stats-backfill path. Never blocks a render; a failure or
  // an empty result just leaves the badge absent — flag, never block.
  const backfillFlags = useCallback(async (name: string) => {
    try {
      const res = await invokeAtlasTool('flag_unbacked_work', { workspace: name });
      const c = res as { ok?: boolean; count?: number; flags?: FlagItem[] } | null;
      if (c && c.ok && typeof c.count === 'number') {
        setWorkspaces((ws) => ws.map((w) => w.id === name ? { ...w, flagCount: c.count, flags: c.flags ?? [] } : w));
      }
    } catch { /* leave the badge absent on error */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invokeAtlasTool('workspace_list', { includeStats: true });
      if (
        result &&
        typeof result === 'object' &&
        'workspaces' in result &&
        Array.isArray((result as { workspaces: unknown }).workspaces)
      ) {
        const raw = (result as { workspaces: unknown[] }).workspaces;
        const normalized: Workspace[] = raw
          .map((w) => {
            if (typeof w === 'string') return { id: w, name: w };
            const entry = w as {
              name: string;
              nodeCount?: number;
              edgeCount?: number;
              typeBreakdown?: Record<string, number>;
              projects?: string[];
              projectCount?: number;
              lastIndexed?: string | null;
              statsSource?: StatsSource;
            };
            return {
              id: entry.name,
              name: entry.name,
              nodeCount: entry.nodeCount,
              edgeCount: entry.edgeCount,
              typeBreakdown: entry.typeBreakdown,
              projects: entry.projects,
              projectCount: entry.projectCount,
              lastIndexed: entry.lastIndexed ?? null,
              statsSource: entry.statsSource,
            };
          })
          .filter((w) => w.name && w.name !== 'undefined');
        normalized.sort((a, b) => toEpoch(b.lastIndexed) - toEpoch(a.lastIndexed));
        setWorkspaces(normalized);

        // Lazy backfill: fire workspace_status for any card with no snapshot yet,
        // and fetch unbacked-work flags for EVERY workspace (independent of stats).
        for (const w of normalized) {
          if (w.statsSource === 'none') void backfillStats(w.name);
          // Only workspaces with content can have decisions to flag — skip the
          // empty/unindexed ones so we don't needlessly warm their stores.
          if ((w.projectCount ?? 0) > 0 || (w.nodeCount ?? 0) > 0) void backfillFlags(w.name);
        }
      } else {
        setWorkspaces([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, [backfillStats, backfillFlags]);

  useEffect(() => { void load(); }, [load]);

  function handleDeleted(id: string) {
    setWorkspaces((ws) => ws.filter((w) => w.id !== id));
  }

  function handleRenamed(id: string, newName: string) {
    setWorkspaces((ws) => ws.map((w) => w.id === id ? { ...w, id: newName, name: newName } : w));
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-xl font-semibold text-[var(--lb-fg)]">Workspaces</h1>
            <p className="text-sm text-[var(--lb-dim)] mt-0.5">Index and explore your codebases</p>
          </div>
          <Link
            to="/workspaces/new"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium rounded-md transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New workspace
          </Link>
        </div>

        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-900/50 bg-red-950/20 px-4 py-3 text-sm text-red-400">
            <span>{error}</span>
            <button
              onClick={() => void load()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-red-900/50 text-red-300 hover:bg-red-950/40 transition-colors shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        )}

        {!loading && !error && workspaces.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-12 h-12 rounded-xl bg-[var(--lb-item-hover)] border border-[var(--lb-border)] flex items-center justify-center mb-5">
              <FolderOpen className="w-5 h-5 text-[var(--lb-dim)]" />
            </div>
            <h2 className="text-sm font-medium text-[var(--lb-body)] mb-1.5">No workspaces yet</h2>
            <p className="text-sm text-[var(--lb-dim)] mb-6 max-w-xs leading-relaxed">
              Create a workspace to index your codebase and start exploring code intelligence.
            </p>
            <Link
              to="/workspaces/new"
              className="flex items-center gap-1.5 px-4 py-2 bg-[#da7756] hover:bg-[#c86a47] text-white text-sm font-medium rounded-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Create workspace
            </Link>
          </div>
        )}

        {!loading && !error && workspaces.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                onDeleted={handleDeleted}
                onRenamed={handleRenamed}
                onRefreshStats={(id) => void backfillStats(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
