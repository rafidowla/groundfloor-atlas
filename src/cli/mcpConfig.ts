/**
 * cli/mcpConfig.ts — `atlas mcp-config [client]` prints ready-to-paste
 * MCP client configuration (with the auth token filled in) for every
 * supported client. Clients that speak HTTP MCP natively (Claude Code,
 * Cursor, Antigravity) get a url+headers block; stdio-only clients
 * (Claude Desktop, Codex) get an `mcp-remote` bridge command.
 */

import { ensureMcpAuthToken, loadConfig, mcpAuthEnabled } from '../config.js';

const CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'antigravity'] as const;
type Client = (typeof CLIENTS)[number];

// RD-groundfloor-atlas-key-rename — must match ideConnect.ts's SERVER_KEY. This module
// only PRINTS a copy-paste block (never writes a file itself), so there's no
// duplicate-entry risk here — but the key must still match what `atlas
// connect` actually writes, or a user pasting this block would end up with a
// different-looking entry than the auto-connected one.
const SERVER_KEY = 'groundfloor-atlas';

function block(client: Client, url: string, token: string): string {
    const auth = `Authorization: Bearer ${token}`;
    const httpJson = (key: string) => JSON.stringify(
        { mcpServers: { [SERVER_KEY]: { [key]: url, headers: { Authorization: `Bearer ${token}` } } } },
        null, 2,
    );
    const remoteArgs = ['-y', 'mcp-remote', url, '--header', auth];
    switch (client) {
        case 'claude-code':
            return [
                '# Claude Code — one-liner:',
                `claude mcp add --transport http ${SERVER_KEY} "${url}" --header "${auth}"`,
                '',
                '# …or add to a project .mcp.json:',
                JSON.stringify({ mcpServers: { [SERVER_KEY]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
            ].join('\n');
        case 'cursor':
            return ['# Cursor — ~/.cursor/mcp.json:', httpJson('url')].join('\n');
        case 'antigravity':
            return ['# Antigravity — MCP settings (HTTP server):', httpJson('serverUrl')].join('\n');
        case 'claude-desktop':
            return [
                '# Claude Desktop — claude_desktop_config.json (stdio via mcp-remote bridge):',
                JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: 'npx', args: remoteArgs } } }, null, 2),
            ].join('\n');
        case 'codex':
            return [
                '# Codex — ~/.codex/config.toml:',
                `[mcp_servers.${SERVER_KEY}]`,
                'command = "npx"',
                `args = ${JSON.stringify(remoteArgs)}`,
            ].join('\n');
    }
}

export function printMcpConfig(clientArg?: string, showToken = false): number {
    const cfg = loadConfig();
    const url = `http://127.0.0.1:${cfg.port}/mcp`;
    const authOn = mcpAuthEnabled();
    const realToken = authOn ? ensureMcpAuthToken(cfg.home) : '';

    if (!authOn) {
        console.error('# WARNING: ATLAS_MCP_AUTH=off — the /mcp endpoint is UNAUTHENTICATED. Re-enable auth for production.\n');
    }

    const want = (clientArg ?? 'all').toLowerCase();
    if (want !== 'all' && !CLIENTS.includes(want as Client)) {
        console.error(`atlas mcp-config: unknown client '${clientArg}'. Supported: ${CLIENTS.join(', ')}, all`);
        return 64;
    }

    // RD-F27token — redact the live bearer in printed output unless the caller
    // explicitly opts in with --show-token. The placeholder still produces a
    // copy-paste-ready block; the user substitutes the real token (or re-runs
    // with --show-token). The actual token always lives at <home>/mcp.token.
    const tokenForBlock = !authOn
        ? '<TOKEN>'
        : showToken
            ? realToken
            : `${realToken.slice(0, 8)}…<redacted: re-run with --show-token>`;

    const targets: Client[] = want === 'all' ? [...CLIENTS] : [want as Client];
    console.log(`# Groundfloor Atlas MCP endpoint: ${url}`);
    console.log(`# Auth token: ${authOn ? `${cfg.home}/mcp.token` : '(auth disabled)'}\n`);
    if (authOn && !showToken) {
        console.log('# (token redacted — pass --show-token to print the live bearer)\n');
    }
    for (const c of targets) {
        console.log(block(c, url, tokenForBlock));
        console.log('');
    }
    return 0;
}
