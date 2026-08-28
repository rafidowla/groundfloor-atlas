/**
 * mcp/tools/layerViolations.ts — atlas_layer_violations.
 *
 * Ported from lore-plugin-developer handlers.ts (handleLayerViolations),
 * adapted to read from Lore via LoreReader. Reports edges that cross
 * user-declared LayerSpec boundaries. Default LayerSpec mirrors Lore's
 * own (ui→core OK, ui⇏plugins, core⇏plugins) — override per-call when
 * Atlas is pointed at a different codebase.
 */

import { layerViolations, defaultLoreLayerSpec, type LayerSpec } from '../../analytics/index.js';
import { type LoreContextReader, notIndexedError } from '../codeContext.js';

interface LayerViolationsArgs {
    layerSpec?: LayerSpec;
    workspace?: string;
}

export async function runLayerViolations(
    reader: LoreContextReader,
    args: LayerViolationsArgs,
    defaultWorkspace: string,
): Promise<unknown> {
    const workspace = args.workspace ?? defaultWorkspace;
    // RC-F4 — distinguish a never-indexed workspace from an empty result.
    const notIndexed = await notIndexedError(reader, workspace);
    if (notIndexed) return notIndexed;
    const { table, relations } = await reader.loadContext(workspace);
    const spec = args.layerSpec ?? defaultLoreLayerSpec();
    const violations = layerViolations(table, relations, spec);
    return {
        workspace,
        layerSpec: spec,
        violations,
        scanned: { symbols: table.all.length, edges: relations.length },
    };
}
