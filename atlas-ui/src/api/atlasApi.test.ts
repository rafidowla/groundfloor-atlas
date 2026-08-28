/**
 * atlasApi.test.ts — failure-detection contract for the Groundfloor Atlas MCP client.
 *
 * THE BUG (audit finding): the daemon's tool endpoint returns HTTP 200 even on
 * failure — toolRegistry.ts's catch-all returns `{error, detail}` with a 200
 * status, and atlas_index reports partial/total failure via `{ok: false,
 * errors: [...]}` while still 200. Checking `res.ok` alone can never catch
 * this; the failure only shows up in the PARSED RESULT BODY. These tests pin
 * the fix: `invokeAtlasTool` must inspect the body and THROW a structured
 * error (`AtlasToolError`) instead of silently returning a success-shaped
 * object, and a fetch REJECTION (daemon not running) must throw the distinct
 * `AtlasDaemonUnreachableError` rather than a generic network exception.
 *
 * Mocks `global.fetch` directly (no MSW/jsdom needed — mirrors the existing
 * pure-logic test style in this suite, e.g. chatStream.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as AtlasApiModule from './atlasApi';

function mcpResponse(resultOrEnvelope: unknown, opts?: { isError?: boolean; sessionId?: string }) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(resultOrEnvelope) }],
      ...(opts?.isError ? { isError: true } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(opts?.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
    },
  });
}

function initializeResponse() {
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' },
  });
}

type ToolErrorInstance = InstanceType<typeof AtlasApiModule.AtlasToolError>;
type DaemonErrorInstance = InstanceType<typeof AtlasApiModule.AtlasDaemonUnreachableError>;

describe('invokeAtlasTool — failure detection contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let invokeAtlasTool: typeof AtlasApiModule.invokeAtlasTool;
  let ToolErrorClass: typeof AtlasApiModule.AtlasToolError;
  let DaemonErrorClass: typeof AtlasApiModule.AtlasDaemonUnreachableError;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // atlasApi memoizes `_sessionId`/`_initPromise` at module scope (the MCP
    // session handshake is cached for the app's lifetime). Reset the module
    // registry per test so each test gets a FRESH client — otherwise the
    // second+ test's mocked fetch sequence gets out of sync with the
    // already-established (from a prior test) session state.
    vi.resetModules();
    const mod = await import('./atlasApi');
    invokeAtlasTool = mod.invokeAtlasTool;
    ToolErrorClass = mod.AtlasToolError;
    DaemonErrorClass = mod.AtlasDaemonUnreachableError;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(i) returns the parsed value on a genuine 200 success', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse()) // initialize handshake
      .mockResolvedValueOnce(new Response('', { status: 200 })) // notifications/initialized
      .mockResolvedValueOnce(mcpResponse({ ok: true, filesWritten: 12, nodesWritten: 300, errors: [] }));

    const result = await invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' });
    expect(result).toEqual({ ok: true, filesWritten: 12, nodesWritten: 300, errors: [] });
  });

  it('(i) a 200 with { ok:false, error:"..." } body throws AtlasToolError, not a success', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(mcpResponse({ ok: false, error: 'index failed: no parser for .xyz' }));

    await expect(invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' })).rejects.toThrow(ToolErrorClass);
  });

  it('a 200 with the toolRegistry {error, detail} shape throws AtlasToolError carrying the detail', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(
        mcpResponse({ error: 'invalid_arguments', tool: 'atlas_index', detail: 'path is required' }),
      );

    try {
      await invokeAtlasTool('atlas_index', {});
      expect.unreachable('expected invokeAtlasTool to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolErrorClass);
      expect((err as ToolErrorInstance).message).toBe('invalid_arguments');
      expect((err as ToolErrorInstance).detail).toBe('path is required');
    }
  });

  it('a 200 with atlas_index shape { ok:false, errors:[...] } (some files written) surfaces errors[] on the thrown error', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(
        mcpResponse({
          ok: false,
          workspace: 'w',
          filesWritten: 8,
          nodesWritten: 140,
          errors: ['file a.ts: parse error', 'file b.ts: resolve error'],
        }),
      );

    try {
      await invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' });
      expect.unreachable('expected invokeAtlasTool to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolErrorClass);
      const toolErr = err as ToolErrorInstance;
      expect(toolErr.errors).toHaveLength(2);
      // Partial-success signal: raw.filesWritten > 0 despite the failure —
      // this is what AddProjectModal uses to choose the amber 'partial' phase
      // over a hard red 'error'.
      expect((toolErr.raw as { filesWritten?: number }).filesWritten).toBe(8);
    }
  });

  it('an MCP envelope with isError:true throws AtlasToolError even without a body-level error field', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(mcpResponse({ ok: true }, { isError: true }));

    await expect(invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' })).rejects.toThrow(ToolErrorClass);
  });

  it('a genuinely successful result with ok:true and no errors does NOT throw', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(mcpResponse({ ok: true, filesWritten: 5, errors: [] }));

    await expect(invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' })).resolves.toEqual({
      ok: true,
      filesWritten: 5,
      errors: [],
    });
  });

  it('(ii) a fetch rejection (connection refused) throws AtlasDaemonUnreachableError, not a generic error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    try {
      await invokeAtlasTool('workspace_list');
      expect.unreachable('expected invokeAtlasTool to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonErrorClass);
      expect((err as DaemonErrorInstance).message).toMatch(/not reachable/i);
      expect((err as DaemonErrorInstance).url).toBe('http://127.0.0.1:3848');
    }
  });

  it('a plain HTTP error status (non-200) still throws a plain Error (unaffected by the body-inspection fix)', async () => {
    fetchMock
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }));

    await expect(invokeAtlasTool('atlas_index', { workspace: 'w', path: '/p' })).rejects.toThrow(/HTTP 500/);
  });
});
