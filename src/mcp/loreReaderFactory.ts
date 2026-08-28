/**
 * mcp/loreReaderFactory.ts — picks the read transport for the code tools.
 *
 * The mirror of cli.ts's write-path switch: when lore.mode==='embedded' the
 * tools read from a dedicated in-process Lore (no daemon, no port, no token);
 * otherwise they use the HTTP LoreReader. Both satisfy LoreContextReader, so
 * the 6 code-intelligence tools are transport-agnostic.
 */
import { loadConfig } from '../config.js';
import { resolveLoreContext, tokenMissingError } from './context.js';
import { LoreReader } from './loreReader.js';
import { EmbeddedLoreReader } from './embeddedReader.js';
import type { LoreContextReader } from './codeContext.js';

export type ReaderResult =
    | { reader: LoreContextReader; workspace: string }
    | { error: ReturnType<typeof tokenMissingError> };

/**
 * Resolve a code-context reader + the workspace to query. In embedded mode no
 * token is required. In http mode a missing token yields the existing
 * token-missing error (returned, so the handler can pass it straight back).
 */
export function resolveCodeReader(): ReaderResult {
    const cfg = loadConfig();
    if (cfg.lore.mode === 'embedded') {
        return { reader: new EmbeddedLoreReader(cfg), workspace: cfg.lore.workspace };
    }
    const lc = resolveLoreContext();
    if (!lc.token) return { error: tokenMissingError() };
    return { reader: new LoreReader({ mcpUrl: lc.mcpUrl, token: lc.token }), workspace: lc.workspace };
}
