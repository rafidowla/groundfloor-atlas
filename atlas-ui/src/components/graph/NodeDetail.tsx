import { useState } from 'react';
import { X, Loader2, Maximize2, MessageSquare } from 'lucide-react';
import { GraphNode, NODE_COLORS } from '../../types/graph';
import NodeSource from './NodeSource';

interface NodeDetailProps {
  node: GraphNode;
  onClose: () => void;
  /** B4 PART 3: invoked when the user clicks "refine" on a truncated node.
   *  Resolves once the larger slice has merged into the graph. */
  onRefine?: (nodeId: string) => Promise<void> | void;
  /** Sprint 3: invoked when the user clicks a neighbor — re-selects that node
   *  (re-runs the same selection path that built this panel). */
  onSelectNeighbor?: (nodeId: string) => void;
  /** Opens the chat panel seeded with a question about this node. */
  onAskInChat?: (node: GraphNode) => void;
}

/** Drill `kind` → swatch color, routed through the SAME NODE_COLORS palette
 *  the graph/legend use (so a neighbor's dot matches its node color). Mirrors
 *  the kind→NodeType bridge in liveNodeToGraphNode / GraphController. */
const KIND_DOT_COLOR: Record<string, string> = {
  community: NODE_COLORS['architecture'],
  file: NODE_COLORS['code_file'],
  symbol: NODE_COLORS['code_symbol'],
  context: NODE_COLORS['code_context'],
  // GF-3 — folder/import neighbor dots match their schema node colors.
  folder: NODE_COLORS['code_folder'],
  import: NODE_COLORS['code_import'],
  knowledge: NODE_COLORS['decision'],
  other: NODE_COLORS['code_symbol'],
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function NodeDetail({ node, onClose, onRefine, onSelectNeighbor, onAskInChat }: NodeDetailProps) {
  const color = NODE_COLORS[node.type];
  const typeDisplay = node.type.replace(/_/g, ' ');
  // node.tags may be a comma-string (current nodeView) OR a Lore Tags Pass 3
  // string[] — tolerate both so a future wiring of real tags can't crash here.
  const rawTags = node.tags ?? '';
  const tags = (Array.isArray(rawTags) ? rawTags : rawTags.split(','))
    .map((t) => t.trim())
    .filter(Boolean);

  const neighbors = node.neighbors ?? [];
  // Show the inline code view for file/symbol nodes that carry a repo path.
  const showSource =
    Boolean(node.file) && (node.type === 'code_file' || node.type === 'code_symbol');

  // B4 PART 3: refine state for a truncated node.
  const [refining, setRefining] = useState(false);
  const handleRefine = async () => {
    if (!onRefine || refining) return;
    setRefining(true);
    try {
      await onRefine(node.id);
    } finally {
      setRefining(false);
    }
  };

  return (
    <div className="w-72 shrink-0 border-l border-[var(--lb-border-s)] bg-[var(--lb-card)] flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-start gap-2 p-4 border-b border-[var(--lb-border-s)]">
        <span
          className="w-3 h-3 rounded-full shrink-0 mt-0.5"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 text-sm font-semibold text-[var(--lb-fg)] leading-snug break-words min-w-0">
          {node.label}
        </span>
        <button
          onClick={onClose}
          className="shrink-0 text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors ml-1"
          aria-label="Close panel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Type badge + Ask-in-chat */}
      <div className="px-4 py-2 border-b border-[var(--lb-border-s)] flex items-center justify-between gap-2">
        <span
          className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full border capitalize"
          style={{
            color,
            borderColor: color + '55',
            backgroundColor: color + '18',
          }}
        >
          {typeDisplay}
        </span>
        {onAskInChat && (
          <button
            onClick={() => onAskInChat(node)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[#da7756] hover:bg-[#c86a47] text-white transition-colors shrink-0"
            title="Ask Groundfloor Atlas about this node"
          >
            <MessageSquare size={11} />
            Ask in chat
          </button>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3 border-b border-[var(--lb-border-s)] flex-1 overflow-y-auto">
        <p className="text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase mb-1.5">
          Content
        </p>
        <pre className="text-xs text-[var(--lb-body)] whitespace-pre-wrap font-mono leading-relaxed">
          {node.content}
        </pre>

        {/* B4 PART 3: truncation refine affordance — re-expand this node with a
            larger budget (controller.refine doubles the child cap) so the
            children dropped by the first truncated slice appear. Functional, not
            a TODO. */}
        {node.truncatedChildren && onRefine && (
          <button
            onClick={handleRefine}
            disabled={refining}
            className="mt-3 w-full flex items-center justify-center gap-1.5 text-[11px] px-3 py-1.5 bg-amber-950/60 hover:bg-amber-900/60 border border-amber-800/70 hover:border-amber-600 rounded text-amber-300 transition-colors disabled:opacity-60"
          >
            {refining ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Loading more…
              </>
            ) : (
              <>
                <Maximize2 size={12} />
                More children — refine
              </>
            )}
          </button>
        )}
      </div>

      {/* Source — Sprint 3 inline code view (lazy; file/symbol nodes only) */}
      {showSource && node.file && (
        <NodeSource
          path={node.file}
          startLine={node.startLine}
          endLine={node.endLine}
          workspace={node.workspace}
          nodeKey={node.id}
        />
      )}

      {/* Neighbors — Sprint 3 clickable adjacency from the live graph */}
      {neighbors.length > 0 && (
        <div className="px-4 py-3 border-b border-[var(--lb-border-s)]">
          <p className="text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase mb-1.5">
            Neighbors ({neighbors.length})
          </p>
          <div className="flex flex-col gap-1">
            {neighbors.map((n) => {
              const neighborColor = KIND_DOT_COLOR[n.kind] ?? KIND_DOT_COLOR.other;
              return (
                <button
                  key={n.id}
                  onClick={() => onSelectNeighbor?.(n.id)}
                  disabled={!onSelectNeighbor}
                  title={n.id}
                  className="flex items-center gap-2 text-left text-[11px] text-[var(--lb-body)] hover:text-[var(--lb-fg)] bg-[var(--lb-surface)]/40 hover:bg-[var(--lb-surface)] border border-[var(--lb-border-s)] hover:border-[var(--lb-border-s)] rounded px-2 py-1 transition-colors disabled:cursor-default disabled:hover:bg-[var(--lb-surface)]/40"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: neighborColor }}
                  />
                  <span className="truncate">{n.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="px-4 py-3 border-b border-[var(--lb-border-s)]">
          <p className="text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase mb-1.5">
            Tags
          </p>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] bg-[var(--lb-surface)] border border-[var(--lb-border-s)] text-[var(--lb-subtle)] rounded-full px-2 py-0.5"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="px-4 py-3">
        <p className="text-[10px] font-semibold tracking-widest text-[var(--lb-dim)] uppercase mb-1.5">
          Metadata
        </p>
        <dl className="flex flex-col gap-1">
          {typeof node.degree === 'number' && (
            <div className="flex items-center justify-between">
              <dt className="text-[10px] text-[var(--lb-dim)]">Degree</dt>
              <dd className="text-[10px] text-[var(--lb-subtle)] tabular-nums">{node.degree}</dd>
            </div>
          )}
          {typeof node.communityId === 'string' && node.communityId.length > 0 && (
            <div className="flex items-center justify-between">
              <dt className="text-[10px] text-[var(--lb-dim)]">Community</dt>
              <dd className="text-[10px] text-[var(--lb-subtle)]">{node.communityId}</dd>
            </div>
          )}
          {node.createdAt && (
            <div className="flex items-center justify-between">
              <dt className="text-[10px] text-[var(--lb-dim)]">Created</dt>
              <dd className="text-[10px] text-[var(--lb-subtle)]">{formatDate(node.createdAt)}</dd>
            </div>
          )}
          {node.supersededAt && (
            <div className="flex items-center justify-between">
              <dt className="text-[10px] text-[var(--lb-dim)]">Superseded</dt>
              <dd className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--lb-subtle)]">{formatDate(node.supersededAt)}</span>
                <span className="text-[10px] bg-red-900 border border-red-800 text-red-300 rounded px-1.5 py-px font-medium">
                  Superseded
                </span>
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between">
            <dt className="text-[10px] text-[var(--lb-dim)]">Workspace</dt>
            <dd className="text-[10px] text-[var(--lb-subtle)] truncate max-w-[8rem]">{node.workspace}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
