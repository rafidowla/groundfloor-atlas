import { useEffect, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { AtlasAlert } from '../types/graph';
import { invokeAtlasTool } from '../api/atlasApi';
import { keyOfAlert, buildDismissArgs } from '../graph/alertKeys';

interface AlertsPanelProps {
  workspace: string;
}

const SEVERITY_STYLES: Record<AtlasAlert['severity'], string> = {
  high:   'bg-red-900 text-red-300 border border-red-800',
  medium: 'bg-amber-900 text-amber-300 border border-amber-800',
  low:    'bg-[#da7756]/10 text-[#da7756]/80 border border-[#da7756]/20',
};

export default function AlertsPanel({ workspace }: AlertsPanelProps) {
  const [alerts, setAlerts] = useState<AtlasAlert[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dismissError, setDismissError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invokeAtlasTool('alerts_get', { workspace });
        if (cancelled) return;
        const parsed = result as { alerts?: AtlasAlert[] };
        if (Array.isArray(parsed?.alerts)) {
          setAlerts(parsed.alerts);
        }
      } catch {
        // Alerts are non-blocking — silently ignore fetch errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const handleDismiss = async (alert: AtlasAlert) => {
    setDismissError('');
    try {
      // The daemon's contract is {alertType, summary, reason} — NOT {id}
      // (sending {id: undefined} failed validation silently, so nothing was
      // ever dismissed server-side and the alert came back on reload).
      await invokeAtlasTool('alerts_dismiss', buildDismissArgs(workspace, alert));
    } catch (err) {
      // Keep the alert and say why — the old empty catch removed it locally
      // even when the server rejected the dismiss.
      setDismissError(`Dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const k = keyOfAlert(alert);
    setAlerts((prev) => prev.filter((a) => keyOfAlert(a) !== k));
  };

  if (alerts.length === 0) return null;

  return (
    // bottom-7: sits ABOVE the fixed status bar (h-7, z-50) instead of under
    // it — the collapsed toggle used to render at bottom-0/z-10, physically
    // covered and unclickable.
    <div className="fixed bottom-7 left-56 right-0 z-40">
      {/* Collapsed bar */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full flex items-center gap-2 px-4 py-2 bg-[var(--lb-card)] border-t border-[var(--lb-border-s)] text-amber-400 hover:bg-[var(--lb-surface)] transition-colors text-sm font-medium"
        >
          <AlertTriangle size={14} />
          <span>
            {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
          </span>
        </button>
      )}

      {/* Expanded panel */}
      {expanded && (
        <div className="bg-[var(--lb-card)] border-t border-[var(--lb-border-s)] flex flex-col max-h-64">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--lb-border-s)] shrink-0">
            <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
              <AlertTriangle size={14} />
              <span>
                {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
              </span>
              {dismissError && (
                <span className="text-[10px] text-rose-300 font-normal">{dismissError}</span>
              )}
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors"
              aria-label="Collapse alerts"
            >
              <X size={15} />
            </button>
          </div>

          {/* Alert list */}
          <div className="overflow-y-auto flex flex-col divide-y divide-gray-800">
            {alerts.map((alert) => (
              <div key={keyOfAlert(alert)} className="flex items-start gap-3 px-4 py-3">
                {/* Severity badge */}
                <span
                  className={`shrink-0 mt-0.5 text-[10px] font-semibold uppercase px-1.5 py-px rounded ${SEVERITY_STYLES[alert.severity]}`}
                >
                  {alert.severity}
                </span>

                {/* Summary */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--lb-body)] leading-snug">{alert.summary}</p>
                  <p className="text-[10px] text-[var(--lb-dim)] mt-0.5">{alert.type}</p>
                </div>

                {/* Dismiss button */}
                <button
                  onClick={() => handleDismiss(alert)}
                  className="shrink-0 text-[var(--lb-dim)] hover:text-[var(--lb-body)] transition-colors mt-0.5"
                  aria-label="Dismiss alert"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
