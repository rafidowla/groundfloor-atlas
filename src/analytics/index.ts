/**
 * analytics/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Analytics surface — typed re-exports of every analytic.
 *
 * Original work authored for groundfloor-lore (Apache-2.0 / Unlicense
 * / MIT dependencies only). License-compliance scan enforced via
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Eight analytics modules; each operates on the ResolveResult shape
 * (symbol table + ParsedRelation[]) produced by Phase 2 / 2.1.
 */

export { blastRadius } from './blastRadius.js';
export type { BlastRadius } from './blastRadius.js';

export { symbolPageRank } from './pagerank.js';
export type { PageRankResult } from './pagerank.js';

export { moduleCoupling } from './coupling.js';
export type { ModuleCoupling } from './coupling.js';

export { dependencyCycles } from './cycles.js';
export type { DependencyCycle } from './cycles.js';

export { deadCode } from './deadCode.js';
export type { DeadCodeReport } from './deadCode.js';

export { hotspots } from './hotspots.js';
export type { HotspotEntry, HotspotReport } from './hotspots.js';

export { layerViolations, defaultLoreLayerSpec } from './layerViolations.js';
export type { LayerSpec, LayerViolation } from './layerViolations.js';

export { tectonicMap } from './tectonicMap.js';
export type { TectonicMap, TectonicNode, TectonicEdge } from './tectonicMap.js';
