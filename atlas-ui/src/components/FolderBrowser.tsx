/**
 * FolderBrowser.tsx — Inline filesystem folder picker for browser mode.
 *
 * Calls /api/fs/browse on the local Atlas daemon to list directories, so the
 * user can click through their filesystem instead of typing absolute paths.
 * Only rendered when not running inside Tauri (Tauri uses the native dialog).
 */

import { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, ChevronRight, ArrowLeft, Home, Check } from 'lucide-react';
import { ATLAS_BASE, buildAtlasHeaders, ensureMcpToken } from '../api/atlasApi';

interface DirEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  path: string;
  parent: string;
  dirs: DirEntry[];
}

interface FolderBrowserProps {
  value: string;
  onChange: (path: string) => void;
}

async function listDir(path: string): Promise<BrowseResult> {
  await ensureMcpToken();
  const url = `${ATLAS_BASE}/api/fs/browse?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: buildAtlasHeaders() });
  if (!res.ok) throw new Error(`Cannot read directory`);
  return res.json() as Promise<BrowseResult>;
}

export default function FolderBrowser({ value, onChange }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [parentPath, setParentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const navSeq = useRef(0);
  function navigate(path: string) {
    // Staleness guard: two quick navigations can resolve out of order — the
    // older response used to overwrite the newer path/entries/breadcrumb.
    const seq = ++navSeq.current;
    setLoading(true);
    setError('');
    listDir(path)
      .then((result) => {
        if (seq !== navSeq.current) return; // superseded by a newer navigation
        setCurrentPath(result.path);
        setParentPath(result.parent);
        setEntries(result.dirs);
      })
      .catch((err: unknown) => {
        if (seq !== navSeq.current) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (seq === navSeq.current) setLoading(false);
      });
  }

  useEffect(() => {
    navigate('~');
  }, []);

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-[var(--lb-bg)] rounded-md border border-[var(--lb-border-s)] text-xs text-[var(--lb-subtle)] overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => navigate('/')}
          className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors shrink-0"
          title="Root"
        >
          /
        </button>
        {pathParts.map((part, i) => {
          const partPath = '/' + pathParts.slice(0, i + 1).join('/');
          return (
            <span key={partPath} className="flex items-center gap-1 shrink-0">
              <ChevronRight size={10} className="text-[var(--lb-border-s)]" />
              <button
                onClick={() => navigate(partPath)}
                className="hover:text-[var(--lb-body)] transition-colors"
              >
                {part}
              </button>
            </span>
          );
        })}
      </div>

      {/* Directory list */}
      <div className="border border-[var(--lb-border-s)] rounded-md overflow-hidden bg-[var(--lb-surface)]">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--lb-border-s)] bg-[var(--lb-bg)]">
          <button
            onClick={() => parentPath && navigate(parentPath)}
            disabled={!parentPath || parentPath === currentPath}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--lb-subtle)] hover:text-[var(--lb-body)] hover:bg-[var(--lb-border-s)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={12} /> Up
          </button>
          <button
            onClick={() => navigate('~')}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--lb-subtle)] hover:text-[var(--lb-body)] hover:bg-[var(--lb-border-s)] transition-colors"
          >
            <Home size={12} /> Home
          </button>
        </div>

        {/* Entries */}
        <div className="max-h-48 overflow-y-auto">
          {loading && (
            <div className="px-3 py-4 text-xs text-[var(--lb-dim)] text-center">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-3 text-xs text-red-400">{error}</div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--lb-dim)] text-center">No subdirectories</div>
          )}
          {!loading && entries.map((entry) => {
            const isSelected = value === entry.path;
            return (
              <div
                key={entry.path}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors group ${
                  isSelected
                    ? 'bg-[#da7756]/15 border-l-2 border-[#da7756]'
                    : 'hover:bg-[var(--lb-border-s)] border-l-2 border-transparent'
                }`}
              >
                <button
                  className="flex items-center gap-2 flex-1 text-left text-sm text-[var(--lb-body)] min-w-0"
                  onClick={() => navigate(entry.path)}
                >
                  {isSelected
                    ? <FolderOpen size={14} className="text-[#da7756] shrink-0" />
                    : <Folder size={14} className="text-[var(--lb-subtle)] shrink-0" />
                  }
                  <span className="truncate">{entry.name}</span>
                </button>
                <button
                  onClick={() => onChange(entry.path)}
                  className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
                    isSelected
                      ? 'bg-[#da7756] text-white'
                      : 'opacity-0 group-hover:opacity-100 bg-[var(--lb-border-s)] text-[var(--lb-subtle)] hover:bg-[#da7756] hover:text-white'
                  }`}
                  title="Select this folder"
                >
                  {isSelected ? <><Check size={10} /> Selected</> : 'Select'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected path display */}
      {value && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[#da7756]/10 border border-[#da7756]/30 rounded-md">
          <FolderOpen size={12} className="text-[#da7756] shrink-0" />
          <span className="text-xs font-mono text-[var(--lb-body)] truncate">{value}</span>
        </div>
      )}
    </div>
  );
}
