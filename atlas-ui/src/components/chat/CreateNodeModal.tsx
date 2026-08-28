import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2 } from 'lucide-react';
import { invokeAtlasTool } from '../../api/atlasApi';

interface CreateNodeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: string;
  onCreated: (nodeId: string) => void;
}

type NodeType = 'decision' | 'convention' | 'bug_pattern' | 'troubleshooting' | 'architecture';

interface FormState {
  type: NodeType;
  label: string;
  content: string;
  tags: string;
}

const INITIAL_FORM: FormState = {
  type: 'decision',
  label: '',
  content: '',
  tags: '',
};

const NODE_TYPE_OPTIONS: { value: NodeType; label: string }[] = [
  { value: 'decision', label: 'Decision' },
  { value: 'convention', label: 'Convention' },
  { value: 'bug_pattern', label: 'Bug Pattern' },
  { value: 'troubleshooting', label: 'Troubleshooting' },
  { value: 'architecture', label: 'Architecture' },
];

export default function CreateNodeModal({
  open,
  onOpenChange,
  workspace,
  onCreated,
}: CreateNodeModalProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError(null);
  };

  const handleClose = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen) {
      setForm(INITIAL_FORM);
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.label.trim() || !form.content.trim()) {
      setError('Title and content are required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const tags = form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const result = await invokeAtlasTool('knowledge_store', {
        type: form.type,
        label: form.label.trim(),
        content: form.content.trim(),
        tags,
        workspace,
      });

      // Extract the node id from the result
      let nodeId = '';
      if (result && typeof result === 'object' && 'id' in result) {
        nodeId = String((result as { id: unknown }).id);
      }

      setForm(INITIAL_FORM);
      onCreated(nodeId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to store knowledge node.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        {/* Overlay */}
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />

        {/* Content */}
        <Dialog.Content
          className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-[var(--lb-card)] border border-[var(--lb-border-s)] rounded-lg shadow-2xl flex flex-col focus:outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--lb-border-s)]">
            <Dialog.Title className="text-sm font-semibold text-[var(--lb-fg)]">
              Add Knowledge Node
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors disabled:opacity-40"
                aria-label="Close"
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 py-4">
            {/* Type */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cn-type" className="text-xs font-medium text-[var(--lb-subtle)]">
                Type <span className="text-red-400">*</span>
              </label>
              <select
                id="cn-type"
                name="type"
                value={form.type}
                onChange={handleChange}
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              >
                {NODE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Title / Label */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cn-label" className="text-xs font-medium text-[var(--lb-subtle)]">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                id="cn-label"
                name="label"
                type="text"
                value={form.label}
                onChange={handleChange}
                placeholder="e.g. Use JWT for auth, not sessions"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              />
            </div>

            {/* Content */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cn-content" className="text-xs font-medium text-[var(--lb-subtle)]">
                Content (the WHY) <span className="text-red-400">*</span>
              </label>
              <textarea
                id="cn-content"
                name="content"
                value={form.content}
                onChange={handleChange}
                rows={5}
                placeholder="Explain the reasoning, context, and trade-offs…"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] resize-none focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              />
            </div>

            {/* Tags */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cn-tags" className="text-xs font-medium text-[var(--lb-subtle)]">
                Tags (comma-separated)
              </label>
              <input
                id="cn-tags"
                name="tags"
                type="text"
                value={form.tags}
                onChange={handleChange}
                placeholder="e.g. auth, security, backend"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              />
            </div>

            {/* Error message */}
            {error && (
              <p className="text-xs text-red-400 bg-red-900/30 border border-red-800 rounded px-3 py-2">
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className="px-4 py-2 text-sm text-[var(--lb-subtle)] hover:text-[var(--lb-body)] bg-[var(--lb-surface)] hover:bg-[var(--lb-border-s)] border border-[var(--lb-border-s)] hover:border-[var(--lb-dim)] rounded transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#da7756] hover:bg-[#c86a47] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Save Node
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
