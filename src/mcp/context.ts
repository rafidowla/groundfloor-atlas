/**
 * mcp/context.ts — shared helpers for MCP tool handlers.
 *
 * Extracted from server.ts so allTools.ts can import them without
 * creating a circular dependency.
 *
 * Cloud sync awareness:
 *   When cfg.cloudSync.enabled = true AND cloudSync.syncDirection includes reads
 *   ('pull' | 'bidirectional'), read tools use the cloud MCP URL.
 *   Write tools (knowledge_store, atlas_index) always prefer local to avoid
 *   accidental data loss if the cloud endpoint is unavailable.
 *   The caller can pass `forceCloud: true` to override for write-through.
 */

import { loadConfig, readAtlasToken } from '../config.js';
import { cloudUrlError } from '../httpTransport.js';

export interface LoreContext {
    mcpUrl: string;
    token: string | null;
    workspace: string;
    /** true when this context points at the cloud Lore endpoint */
    isCloud: boolean;
}

export interface ResolveLoreContextOpts {
    /**
     * Force cloud endpoint regardless of sync direction.
     * Used when an explicit cloud-targeted operation is requested.
     */
    forceCloud?: boolean;
}

export function resolveLoreContext(opts: ResolveLoreContextOpts = {}): LoreContext {
    const cfg = loadConfig();
    const token = readAtlasToken(cfg.home);

    const cs = cfg.cloudSync;
    const useCloud = opts.forceCloud
        ? Boolean(cs?.enabled && cs.cloudMcpUrl)
        : Boolean(
            cs?.enabled &&
            cs.cloudMcpUrl &&
            (cs.syncDirection === 'pull' || cs.syncDirection === 'bidirectional'),
        );

    if (useCloud && cs) {
        // RD-X2 — re-validate the cloud MCP URL at USE time, not just when the
        // config was written. A config edited out-of-band (or pointing at a
        // metadata/private/loopback host) must not become an SSRF/exfil target.
        const urlErr = cloudUrlError(cs.cloudMcpUrl);
        if (urlErr) {
            throw new Error(`Blocked cloud MCP URL (${cs.cloudMcpUrl}): ${urlErr}`);
        }
        return {
            mcpUrl: cs.cloudMcpUrl,
            // #3 fail-closed: cloud calls use ONLY the cloud apiKey. NEVER
            // fall back to the local Lore bootstrap token — sending it to a
            // remote host would exfiltrate a privileged local credential.
            // No apiKey → null token → caller surfaces tokenMissingError.
            token: cs.apiKey ?? null,
            workspace: cfg.lore.workspace,
            isCloud: true,
        };
    }

    return {
        mcpUrl: cfg.lore.mcpUrl,
        token,
        workspace: cfg.lore.workspace,
        isCloud: false,
    };
}

export function asText(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export function tokenMissingError(): unknown {
    return {
        error: 'atlas: no Lore auth token found',
        hint: 'Write a token to ~/.groundfloor/atlas/auth.token or set LORE_AUTH_TOKEN.',
    };
}
