import { useEffect, useState } from 'react';
import { checkAtlasHealth } from '../api/atlasApi';

interface StatusBarProps {
  workspaceName?: string;
}

export default function StatusBar({ workspaceName }: StatusBarProps) {
  const [atlasOk, setAtlasOk] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  async function poll() {
    try {
      const health = await checkAtlasHealth();
      setAtlasOk(health.status === 'ok');
      setVersion(health.version ?? null);
    } catch {
      setAtlasOk(false);
    }
  }

  useEffect(() => {
    void poll();
    const interval = setInterval(() => void poll(), 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed bottom-0 left-0 right-0 h-7 border-t border-[var(--lb-border)] bg-[var(--lb-deep)] flex items-center px-3 gap-3 text-[11px] z-50 select-none">
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${atlasOk ? 'bg-emerald-600' : 'bg-[var(--lb-border-s)]'}`} />
        <span className={atlasOk ? 'text-[var(--lb-muted)]' : 'text-[var(--lb-border-s)]'}>
          {atlasOk ? 'Connected' : 'Connecting…'}
        </span>
      </span>
      {workspaceName && (
        <>
          <span className="text-[var(--lb-surface)]">·</span>
          <span className="text-[var(--lb-dim)] truncate max-w-[200px]">{workspaceName}</span>
        </>
      )}
      {version && (
        <span className="ml-auto text-[var(--lb-surface)]">v{version}</span>
      )}
    </div>
  );
}
