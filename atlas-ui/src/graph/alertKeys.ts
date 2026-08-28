/**
 * alertKeys.ts — the alerts dismiss contract, as pure functions.
 *
 * The daemon's alerts_get returns alerts with NO id field ({type, severity,
 * summary, detail}), and alerts_dismiss requires {alertType, summary, reason}
 * — not {id}. AlertsPanel used to key rows by `alert.id` (undefined for every
 * row → identical React keys, and a local removal comparing
 * undefined !== undefined that wiped the ENTIRE list on one dismiss) and to
 * send {id: undefined} to the daemon (validation rejected it silently, so
 * nothing was ever dismissed server-side).
 */

import type { AtlasAlert } from '../types/graph';

/** Stable key for one fetch's worth of alerts: the real id when a source
 *  provides one, otherwise type+summary (unique within a single alerts_get
 *  response — two rows never share both). */
export function keyOfAlert(a: AtlasAlert): string {
  return a.id ?? `${a.type} ${a.summary}`;
}

/** The daemon's actual dismiss contract. `reason` is required by
 *  alerts_dismiss; the UI supplies an explicit stand-in so the audit trail
 *  records that no reason was given rather than a fake one. */
export function buildDismissArgs(
  workspace: string,
  alert: AtlasAlert,
  reason = 'Dismissed via the Groundfloor Atlas UI (no reason supplied)',
): { workspace: string; alertType: string; summary: string; reason: string } {
  return { workspace, alertType: alert.type, summary: alert.summary, reason };
}
