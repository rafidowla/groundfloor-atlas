/**
 * nodeSource.ts — pure logic for the inspector's code view (NodeSource.tsx).
 *
 * The fetch/parse/clamp logic is split out of the React component so it is
 * unit-testable WITHOUT rendering (the UI test suite is pure-function only — no
 * jsdom / testing-library). NodeSource.tsx is a thin shell around these.
 */

/** The atlas_source payload the UI renders. */
export interface SourcePayload {
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

/** Fetch state machine for the code view. */
export type SourceFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: SourcePayload };

/** Narrow an unknown MCP result into a SourcePayload (or an error string). The
 *  backend returns either {content,startLine,…} on success or {error} on a
 *  path-safety / not-found failure — both are handled here. */
export function parseSource(raw: unknown): SourcePayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'no source returned' };
  const r = raw as Record<string, unknown>;
  if (typeof r['error'] === 'string') return { error: r['error'] };
  if (typeof r['content'] !== 'string') return { error: 'source response missing content' };
  return {
    startLine: typeof r['startLine'] === 'number' ? r['startLine'] : 1,
    endLine: typeof r['endLine'] === 'number' ? r['endLine'] : 1,
    totalLines: typeof r['totalLines'] === 'number' ? r['totalLines'] : 0,
    content: r['content'] as string,
  };
}

/** Build the atlas_source argument object (omitting absent optional bounds). */
export function buildSourceArgs(opts: {
  path: string;
  startLine?: number;
  endLine?: number;
  workspace: string;
}): Record<string, unknown> {
  return {
    path: opts.path,
    ...(typeof opts.startLine === 'number' ? { startLine: opts.startLine } : {}),
    ...(typeof opts.endLine === 'number' ? { endLine: opts.endLine } : {}),
    workspace: opts.workspace,
  };
}

/**
 * Run one fetch and resolve to the NEXT terminal state (loaded | error). The
 * caller owns the transient `loading` transition and any staleness guard; this
 * is the pure async transition the component drives. `invoke` is injected so
 * tests pass a fake (no network).
 */
export async function loadSource(
  invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  opts: { path: string; startLine?: number; endLine?: number; workspace: string },
): Promise<SourceFetchState> {
  try {
    const raw = await invoke('atlas_source', buildSourceArgs(opts));
    const parsed = parseSource(raw);
    if ('error' in parsed) return { status: 'error', message: parsed.error };
    return { status: 'loaded', data: parsed };
  } catch (e) {
    return { status: 'error', message: (e as Error).message ?? 'Failed to load source' };
  }
}
