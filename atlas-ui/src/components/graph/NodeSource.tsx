/**
 * NodeSource.tsx — Sprint 3 inspector code view.
 *
 * Lazily fetches a file/symbol node's source slice via
 * invokeAtlasTool('atlas_source', …) and renders it with a 1-based line-number
 * gutter. Mounted inside NodeDetail behind a "View source" expander so we issue
 * AT MOST one fetch per node, and only when the user actually wants it (never
 * eagerly on every selection).
 *
 * No syntax-highlighter dependency — the UI has none. We reuse the same flat
 * `<pre className="… font-mono">` idiom the Content block uses, adding a muted
 * line-number column. The fetch/parse/clamp logic lives in ../../graph/
 * nodeSource (pure, unit-tested); this component is the thin shell + the
 * loading/error/empty UI states (machine mirrors WorkspacePage.handleSemanticSearch).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Code2 } from 'lucide-react';
import { invokeAtlasTool } from '../../api/atlasApi';
import { loadSource, type SourceFetchState } from '../../graph/nodeSource';

interface NodeSourceProps {
  /** Repo-relative path (node.file). */
  path: string;
  /** Optional 1-based slice bounds (symbol nodes carry these). */
  startLine?: number;
  endLine?: number;
  workspace: string;
  /** Stable key so a node change re-fetches (passed by NodeDetail = node.id). */
  nodeKey: string;
}

export default function NodeSource({ path, startLine, endLine, workspace, nodeKey }: NodeSourceProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SourceFetchState>({ status: 'idle' });
  // Guard against a stale fetch resolving after the node changed.
  const genRef = useRef(0);

  // Collapse + reset whenever the selected node changes (nodeKey is node.id).
  useEffect(() => {
    setOpen(false);
    setState({ status: 'idle' });
  }, [nodeKey]);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    setState({ status: 'loading' });
    const next = await loadSource(invokeAtlasTool, { path, startLine, endLine, workspace });
    if (gen !== genRef.current) return; // superseded by a newer node/fetch
    setState(next);
  }, [path, startLine, endLine, workspace]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      // Lazy: fetch on first open only (idle), not on every toggle.
      if (next && state.status === 'idle') void load();
      return next;
    });
  }, [state.status, load]);

  return (
    <div className="px-4 py-3 border-b border-[var(--lb-border-s)]">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase hover:text-[var(--lb-body)] transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Code2 size={12} />
          Source
        </span>
        <span className="text-[var(--lb-dim)]">{open ? 'Hide' : 'View'}</span>
      </button>

      {open && (
        <div className="mt-2">
          {state.status === 'loading' && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--lb-dim)] py-2">
              <Loader2 size={12} className="animate-spin" />
              Loading source…
            </div>
          )}

          {state.status === 'error' && (
            <p className="text-[11px] text-red-400 py-2 break-words">{state.message}</p>
          )}

          {state.status === 'loaded' && (() => {
            const { data } = state;
            const lines = data.content.split('\n');
            if (lines.length === 1 && lines[0] === '') {
              return <p className="text-[11px] text-[var(--lb-dim)] py-2">No source lines in range.</p>;
            }
            return (
              <div className="rounded border border-[var(--lb-border-s)] bg-[var(--lb-deep)] overflow-x-auto">
                <pre className="text-xs text-[var(--lb-body)] font-mono leading-relaxed py-2">
                  {lines.map((line, i) => {
                    const lineNo = data.startLine + i;
                    return (
                      <div key={lineNo} className="flex">
                        <span className="select-none shrink-0 w-10 pr-2 text-right text-[var(--lb-dim)] tabular-nums">
                          {lineNo}
                        </span>
                        <span className="whitespace-pre">{line === '' ? ' ' : line}</span>
                      </div>
                    );
                  })}
                </pre>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
