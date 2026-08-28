import { FormEvent, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, FolderOpen } from 'lucide-react';
import { invokeAtlasTool } from '../api/atlasApi';

export default function NewWorkspacePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      await invokeAtlasTool('workspace_create', { name: trimmed });
      navigate(`/onboarding?workspace=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-8 max-w-lg mx-auto">
      <Link
        to="/workspaces"
        className="flex items-center gap-1.5 text-sm text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Workspaces
      </Link>

      <div className="rounded-lg border border-[var(--lb-border-s)] bg-[var(--lb-card)] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#da7756]/10 border border-[#da7756]/20 flex items-center justify-center">
            <FolderOpen className="w-5 h-5 text-[#da7756]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--lb-fg)]">New Workspace</h1>
            <p className="text-sm text-[var(--lb-dim)]">Create a new code intelligence workspace</p>
          </div>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
          <div>
            <label
              htmlFor="workspace-name"
              className="block text-sm font-medium text-[var(--lb-body)] mb-1.5"
            >
              Workspace Name
            </label>
            <input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-project, backend-api"
              disabled={loading}
              required
              autoFocus
              className="w-full px-3 py-2.5 bg-[var(--lb-surface)] border border-[var(--lb-border-s)] rounded-md text-[var(--lb-fg)] placeholder-[var(--lb-border-s)] text-sm focus:outline-none focus:ring-1 focus:ring-[#da7756] focus:border-[#da7756] disabled:opacity-50 transition-colors"
            />
            <p className="mt-1.5 text-xs text-[var(--lb-dim)]">
              Use lowercase letters, numbers, and hyphens.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-900 bg-red-950/30 p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#da7756] hover:bg-[#c86a47] disabled:bg-[var(--lb-surface)] disabled:text-[var(--lb-dim)] text-white text-sm font-medium rounded-md transition-colors"
          >
            {loading ? 'Creating…' : 'Create Workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
