import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronsUpDown, FolderOpen, Plus, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { invokeAtlasTool } from '../api/atlasApi';
import { classifyWorkspaceListError, normalizeWorkspaceList, type WorkspaceListLoadState } from '../graph/workspaceListState';

interface Workspace {
  id: string;
  name: string;
  nodeCount?: number;
}

interface WorkspaceSwitcherProps {
  currentWorkspace?: string;
}

export default function WorkspaceSwitcher({ currentWorkspace }: WorkspaceSwitcherProps) {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadState, setLoadState] = useState<WorkspaceListLoadState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [open, setOpen] = useState(false);

  const loadWorkspaces = useCallback(() => {
    let cancelled = false;
    setLoadState('loading');
    setErrorMsg('');
    invokeAtlasTool('workspace_list')
      .then((result) => {
        if (cancelled) return;
        // Embedded mode (the default) returns `workspaces: string[]` — see
        // normalizeWorkspaceList; the raw cast used to render blank rows.
        const r = result as { workspaces?: Array<string | Workspace> };
        setWorkspaces(normalizeWorkspaceList(r.workspaces));
        setLoadState('loaded');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // UX-truth site #3: previously ANY failure (daemon down, tool error,
        // network blip) fell into `.catch(() => setWorkspaces([]))`, which
        // renders identically to a workspace list that is genuinely empty —
        // "No workspaces found" — with no indication anything went wrong and
        // no way to retry. classifyWorkspaceListError distinguishes the
        // failure so the dropdown can show a real error + Retry instead of a
        // false "empty" claim.
        setWorkspaces([]);
        const classified = classifyWorkspaceListError(err);
        setLoadState(classified.loadState);
        setErrorMsg(classified.message);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cancel = loadWorkspaces();
    return cancel;
  }, [loadWorkspaces]);

  const loading = loadState === 'loading';

  const handleSelect = (name: string) => {
    setOpen(false);
    navigate(`/workspace/${name}`);
  };

  const displayName = currentWorkspace ?? 'Select workspace';

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="w-full flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-md bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] text-xs text-[var(--lb-body)] transition-colors group"
          title="Switch workspace"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <FolderOpen size={12} className="text-[#da7756] shrink-0" />
            <span className="truncate font-medium">
              {loading ? 'Loading…' : displayName}
            </span>
          </div>
          {loading
            ? <Loader2 size={12} className="animate-spin text-[var(--lb-dim)] shrink-0" />
            : <ChevronsUpDown size={12} className="text-[var(--lb-dim)] shrink-0 group-hover:text-[var(--lb-subtle)]" />
          }
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[200px] max-w-[260px] bg-[var(--lb-card)] border border-[var(--lb-border-s)] rounded-lg shadow-2xl py-1.5 overflow-hidden"
        >
          {/* UX-truth: a load failure is NOT the same as a genuinely-empty
              list — show the real cause + a Retry action instead of the false
              "No workspaces found" the old unconditional catch produced. */}
          {(loadState === 'error' || loadState === 'daemon-down') && (
            <div className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-start gap-1.5 text-xs text-rose-300">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>{errorMsg || 'Failed to load workspaces'}</span>
              </div>
              <button
                onClick={() => loadWorkspaces()}
                className="flex items-center gap-1.5 self-start text-[11px] px-2 py-1 rounded bg-[var(--lb-surface)] hover:bg-[var(--lb-surface-hover)] border border-[var(--lb-border-s)] text-[var(--lb-body)] transition-colors"
              >
                <RefreshCw size={11} />
                Retry
              </button>
            </div>
          )}
          {workspaces.length === 0 && loadState === 'loaded' && (
            <div className="px-3 py-2 text-xs text-[var(--lb-dim)]">No workspaces found</div>
          )}
          {workspaces.map((ws) => (
            <DropdownMenu.Item
              key={ws.id ?? ws.name}
              onSelect={() => handleSelect(ws.name)}
              className={[
                'flex items-center gap-2.5 px-3 py-2 text-xs cursor-pointer outline-none transition-colors',
                ws.name === currentWorkspace
                  ? 'bg-[var(--lb-surface)] text-[var(--lb-fg)]'
                  : 'text-[var(--lb-body)] hover:bg-[var(--lb-surface)] hover:text-[var(--lb-fg)]',
              ].join(' ')}
            >
              <FolderOpen size={12} className={ws.name === currentWorkspace ? 'text-[#da7756]' : 'text-[var(--lb-dim)]'} />
              <span className="flex-1 truncate">{ws.name}</span>
              {ws.nodeCount !== undefined && (
                <span className="text-[10px] text-[var(--lb-dim)] shrink-0">
                  {ws.nodeCount.toLocaleString()}
                </span>
              )}
              {ws.name === currentWorkspace && (
                <span className="text-[9px] text-[#da7756] font-medium shrink-0">active</span>
              )}
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="my-1.5 border-t border-[var(--lb-surface)]" />
          <DropdownMenu.Item
            onSelect={() => { setOpen(false); navigate('/workspaces/new'); }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[#da7756] hover:bg-[var(--lb-surface)] cursor-pointer outline-none transition-colors"
          >
            <Plus size={12} />
            New workspace…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
