/**
 * atlasApi.tauri.test.ts — M9 regression: the packaged desktop app's token
 * fallback. The bundled webview loads tauri://localhost with NO ?token= in
 * the URL, so URL capture + storage recovery find nothing; ensureMcpToken
 * must then read the daemon's token via the Tauri `read_mcp_token` command
 * (which existed, registered in lib.rs, but was never called — every daemon
 * request 401'd).
 *
 * Style mirrors atlasApi.test.ts: no jsdom — globals stubbed directly, module
 * registry reset per test so the memoized `_mcpToken`/`_tokenRead` start fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Tauri IPC layer BEFORE any import of atlasApi (vi.mock is hoisted).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function stubTauriWindow() {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
  (globalThis as Record<string, unknown>)['window'] = {
    __TAURI_INTERNALS__: {},
    location: { search: '', hash: '', href: 'tauri://localhost/' },
    history: { replaceState: () => undefined },
  };
  (globalThis as Record<string, unknown>)['sessionStorage'] = storage;
  (globalThis as Record<string, unknown>)['localStorage'] = storage;
  return backing;
}

function unstubWindow() {
  delete (globalThis as Record<string, unknown>)['window'];
  delete (globalThis as Record<string, unknown>)['sessionStorage'];
  delete (globalThis as Record<string, unknown>)['localStorage'];
}

describe('ensureMcpToken — Tauri desktop fallback (M9)', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
  });

  afterEach(() => {
    unstubWindow();
  });

  it('reads the token via read_mcp_token when URL and storage carry none', async () => {
    stubTauriWindow();
    invokeMock.mockResolvedValue('tok-123');
    const api = await import('./atlasApi');

    await api.ensureMcpToken();

    expect(invokeMock).toHaveBeenCalledWith('read_mcp_token');
    expect(api.buildAtlasHeaders()['Authorization']).toBe('Bearer tok-123');
  });

  it('persists the Tauri token so a later reload skips IPC', async () => {
    const backing = stubTauriWindow();
    invokeMock.mockResolvedValue('tok-abc');
    const api = await import('./atlasApi');

    await api.ensureMcpToken();

    expect(backing.get('lb-mcp-token')).toBe('tok-abc');
  });

  it('retries while the daemon is still minting (empty string, then a token)', async () => {
    stubTauriWindow();
    invokeMock
      .mockResolvedValueOnce('')   // daemon still booting
      .mockResolvedValueOnce('')
      .mockResolvedValue('tok-456');
    const api = await import('./atlasApi');

    await api.ensureMcpToken();

    expect(invokeMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(api.buildAtlasHeaders()['Authorization']).toBe('Bearer tok-456');
  }, 10_000);

  it('stays a graceful no-op outside Tauri (browser dev, auth-off)', async () => {
    // No window at all — the plain-browser path must not touch IPC.
    const api = await import('./atlasApi');

    await api.ensureMcpToken();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(api.buildAtlasHeaders()['Authorization']).toBeUndefined();
  });
});
