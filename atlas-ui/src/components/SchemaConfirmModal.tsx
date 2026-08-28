import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2 } from 'lucide-react';
import { invokeAtlasTool } from '../api/atlasApi';

interface SchemaConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: string;
  onConfirmed: () => void;
}

interface FormState {
  label: string;
  schemaFile: string;
  content: string;
}

const INITIAL_FORM: FormState = { label: '', schemaFile: '', content: '' };

export default function SchemaConfirmModal({
  open,
  onOpenChange,
  workspace,
  onConfirmed,
}: SchemaConfirmModalProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError(null);
  };

  const handleClose = (nextOpen: boolean) => {
    if (submitting) return; // block close while submitting
    if (!nextOpen) {
      setForm(INITIAL_FORM);
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.label.trim() || !form.schemaFile.trim() || !form.content.trim()) {
      setError('All fields are required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await invokeAtlasTool('schema_confirm', {
        label: form.label.trim(),
        content: form.content.trim(),
        schemaFile: form.schemaFile.trim(),
        workspace,
      });
      setForm(INITIAL_FORM);
      onConfirmed();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm schema change.');
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
              Confirm Schema Change
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
            {/* Change Title */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="sc-label"
                className="text-xs font-medium text-[var(--lb-subtle)]"
              >
                Change Title <span className="text-red-400">*</span>
              </label>
              <input
                id="sc-label"
                name="label"
                type="text"
                value={form.label}
                onChange={handleChange}
                placeholder="e.g. Add user_preferences table"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              />
            </div>

            {/* Schema File Path */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="sc-schemaFile"
                className="text-xs font-medium text-[var(--lb-subtle)]"
              >
                Schema File Path <span className="text-red-400">*</span>
              </label>
              <input
                id="sc-schemaFile"
                name="schemaFile"
                type="text"
                value={form.schemaFile}
                onChange={handleChange}
                placeholder="e.g. db/schema.prisma"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] font-mono focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
              />
            </div>

            {/* Rationale */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="sc-content"
                className="text-xs font-medium text-[var(--lb-subtle)]"
              >
                Rationale (the WHY) <span className="text-red-400">*</span>
              </label>
              <textarea
                id="sc-content"
                name="content"
                value={form.content}
                onChange={handleChange}
                rows={5}
                placeholder="Explain why this schema change is being made…"
                disabled={submitting}
                className="bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded px-3 py-2 text-sm text-[var(--lb-body)] placeholder-[var(--lb-border-s)] resize-none focus:outline-none focus:border-[#da7756] focus:ring-1 focus:ring-[#da7756]/30 disabled:opacity-50"
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
                Confirm Schema Change
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
