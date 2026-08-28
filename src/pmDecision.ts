/**
 * pmDecision.ts — W3 (Groundfloor Atlas) the PM read/write integration contract.
 *
 * The external PM digital employee (a separate paid product) is just another
 * git participant on `.atlas/memory.jsonl`: it never runs the DB, never loads
 * kuzu/LanceDB/sqlite, and writes ONE well-shaped `decision` node when a change
 * request is approved. This module is that contract, expressed as pure
 * builders/validators/readers over the W2 stateless surface (src/memoryFile.ts
 * / src/memoryQuery.ts). SAME ZERO-NATIVE-DEPS CONTRACT: node builtins only.
 *
 * Pieces:
 *   - W3-T1 — buildPmDecision / validatePmDecision / buildPmDecisionEdge:
 *     the approved-change-request `decision` NodeLine, with a DETERMINISTIC id
 *     (makeKnowledgeId — the W2 id scheme) that IS the idempotency key, plus
 *     provenance metadata and a contentHash for revision detection.
 *   - W3-T3 — recordPmDecision: the append step of the stateless PM loop, going
 *     through the SAME union/atomic write path a developer hook uses
 *     (appendMemoryEntries) — the git pull/commit/push around it is the caller's
 *     job (scripts/pm-memory-cycle.mjs is the reference orchestration).
 *   - W3-T5 — flagUnbackedWork: the developer-side READ-ONLY flag reader. Given
 *     a memory view, it reports developer work (non-PM decisions) that has no
 *     approved PM change request behind it. Flag, NEVER block.
 *
 * Why type `decision` and not a new `change_request` type: KNOWLEDGE_TYPES
 * (src/memoryFile.ts) is a compatibility surface shared by every already-shipped
 * parser/importer/MCP tool; extending it is a separate, header-version-gated
 * decision (see the plan doc §6.5). The PM entry fits inside `decision` today.
 */

import * as crypto from 'node:crypto';
import {
    makeKnowledgeId,
    type NodeLine,
    type EdgeLine,
    type MemoryFileView,
    appendMemoryEntries,
    type AppendResult,
} from './memoryFile.js';

/** Provenance marker stamped on `metadata.source` for every PM-authored entry.
 *  The dev-side flag reader and W3-T5 import notice both key off this. */
export const PM_SOURCE = 'pm';

/** The two tags every PM change-request decision always carries (an `area`
 *  tag, when given, is appended after these). */
export const PM_TAGS = ['pm', 'change-request'] as const;

/** Approval lifecycle states a PM decision's `metadata.status` may hold.
 *  `approved` is the normal write; `superseded` marks a prior revision the PM
 *  has replaced (soft-lifecycle — the entry stays in the ledger, hidden from
 *  default recall via `supersededAt`); `withdrawn` retracts an approval. */
export const PM_DECISION_STATUSES = ['approved', 'superseded', 'withdrawn'] as const;
export type PmDecisionStatus = typeof PM_DECISION_STATUSES[number];
const PM_STATUS_SET: ReadonlySet<string> = new Set(PM_DECISION_STATUSES);

/** Relations a PM decision edge may assert toward an existing entry. */
export const PM_EDGE_RELATIONS = ['supersedes', 'relates_to'] as const;
export type PmEdgeRelation = typeof PM_EDGE_RELATIONS[number];
const PM_EDGE_RELATION_SET: ReadonlySet<string> = new Set(PM_EDGE_RELATIONS);

/** The structured provenance block the PM writes under `metadata`. Round-trips
 *  through export/import verbatim (memorySync merges authored metadata objects)
 *  so a dev-side `knowledge_recall` sees it intact. */
export interface PmDecisionMetadata {
    /** Always `pm` — the moat provenance marker (PM_SOURCE). */
    source: typeof PM_SOURCE;
    /** The change-request id — the idempotency key the deterministic node id
     *  is derived from. */
    requestId: string;
    /** Who approved it (a human name/handle or system actor). */
    approvedBy: string;
    /** When it was approved (ISO 8601). */
    approvedAt: string;
    /** Lifecycle state (default `approved`). */
    status: PmDecisionStatus;
    /** sha256 over {requestId,label,content,approvedBy} — lets the dev side
     *  detect a revised approval that reused the same id. */
    contentHash: string;
    /** Present (and > 0) ONLY for a revised approval that minted a new id via
     *  the `-r<n>` suffix; absent for the base (revision 0) entry. */
    revision?: number;
}

export interface PmDecisionInput {
    /** The change-request id. `pm-<requestId>` is the node-id slug (W2
     *  makeKnowledgeId) — non-empty, and stable across re-runs for idempotency. */
    requestId: string;
    /** Short imperative summary (the node `label`). */
    label: string;
    /** What was approved, why, scope, constraints (the node `content` — the
     *  text that gets embedded on the dev side for semantic recall). */
    content: string;
    /** Who approved it. */
    approvedBy: string;
    /** ISO approval timestamp; defaults to now if omitted (injectable so a
     *  build is byte-reproducible in tests). */
    approvedAt?: string;
    /** Optional area/domain tag (e.g. `auth`, `billing`) appended after the
     *  fixed `pm,change-request` tags. */
    area?: string;
    /** Extra freeform tags to merge in (deduped, after the fixed + area tags). */
    tags?: string[];
    /** Lifecycle state; defaults to `approved`. */
    status?: PmDecisionStatus;
    /** Revision number. 0 (default) = the base id `pm-<requestId>`; n>0 mints a
     *  NEW id `pm-<requestId>-r<n>` so a revised approval can supersede the
     *  prior one instead of silently overwriting it. */
    revision?: number;
}

/** The node-id slug for a PM change-request decision at a given revision.
 *  Revision 0 → `pm-<requestId>`; revision n>0 → `pm-<requestId>-r<n>`. */
export function pmDecisionSlug(requestId: string, revision = 0): string {
    const id = requestId.trim();
    if (!id) throw new Error('pmDecisionSlug: requestId must be non-empty');
    if (!Number.isInteger(revision) || revision < 0) {
        throw new Error(`pmDecisionSlug: revision must be a non-negative integer (got ${revision})`);
    }
    return revision > 0 ? `pm-${id}-r${revision}` : `pm-${id}`;
}

/** The DETERMINISTIC, idempotency-key node id for a PM change-request decision:
 *  `knowledge:decision:pm-<requestId>` (the W2 makeKnowledgeId scheme). Re-running
 *  the PM task for the same request yields the SAME id, so appendMemoryEntries'
 *  ours-wins union upserts rather than duplicating. */
export function pmDecisionId(requestId: string, revision = 0): string {
    return makeKnowledgeId('decision', pmDecisionSlug(requestId, revision));
}

/** sha256 (hex) over the approval's semantic content — a stable fingerprint the
 *  dev side can compare to notice a revised approval that reused the same id.
 *  Canonical field order; independent of tag/metadata ordering. */
export function pmDecisionContentHash(input: {
    requestId: string;
    label: string;
    content: string;
    approvedBy: string;
}): string {
    const canonical = JSON.stringify([
        input.requestId,
        input.label,
        input.content,
        input.approvedBy,
    ]);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Merge the fixed PM tags + optional area + extra tags into a deduped
 *  comma-string (the export tag format), preserving first-seen order. */
function buildTags(area: string | undefined, extra: string[] | undefined): string {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (t: string) => {
        const v = t.trim();
        if (!v) return;
        const key = v.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(v);
    };
    for (const t of PM_TAGS) push(t);
    if (area) push(area);
    for (const t of extra ?? []) push(t);
    return out.join(',');
}

/**
 * Build the exact `decision` NodeLine the PM writes when a change request is
 * approved. Deterministic given the same input (fix `approvedAt` for a
 * byte-reproducible build). Throws on missing required fields — the ledger
 * must never gain a half-formed PM entry the union would then preserve forever.
 */
export function buildPmDecision(input: PmDecisionInput): NodeLine {
    const requestId = input.requestId?.trim();
    if (!requestId) throw new Error('buildPmDecision: requestId is required');
    const label = input.label?.trim();
    if (!label) throw new Error('buildPmDecision: label is required');
    if (typeof input.content !== 'string' || !input.content.trim()) {
        throw new Error('buildPmDecision: content is required');
    }
    const approvedBy = input.approvedBy?.trim();
    if (!approvedBy) throw new Error('buildPmDecision: approvedBy is required');
    const revision = input.revision ?? 0;
    const status = input.status ?? 'approved';
    if (!PM_STATUS_SET.has(status)) {
        throw new Error(`buildPmDecision: unknown status '${status}' (expected one of: ${PM_DECISION_STATUSES.join(', ')})`);
    }
    const approvedAt = input.approvedAt ?? new Date().toISOString();
    const contentHash = pmDecisionContentHash({ requestId, label, content: input.content, approvedBy });

    const metadata: PmDecisionMetadata = {
        source: PM_SOURCE,
        requestId,
        approvedBy,
        approvedAt,
        status,
        contentHash,
        ...(revision > 0 ? { revision } : {}),
    };

    return {
        kind: 'node',
        id: pmDecisionId(requestId, revision),
        type: 'decision',
        label,
        content: input.content,
        tags: buildTags(input.area, input.tags),
        metadata,
        supersededAt: null,
    };
}

/**
 * Return a soft-superseded COPY of a prior PM decision node: `supersededAt`
 * stamped and `metadata.status` flipped to `superseded`. Appending this
 * (ours-wins upsert on the same id) is how a revised approval retires the prior
 * revision — the entry stays in the ledger for history but drops out of the
 * dev's default `knowledge_recall`. The original object is not mutated.
 */
export function supersedePmDecision(prior: NodeLine, supersededAt?: string): NodeLine {
    if (prior.kind !== 'node') throw new Error('supersedePmDecision: not a node');
    const priorMeta = (typeof prior.metadata === 'object' && prior.metadata !== null)
        ? (prior.metadata as Record<string, unknown>)
        : {};
    return {
        ...prior,
        metadata: { ...priorMeta, status: 'superseded' as PmDecisionStatus },
        supersededAt: supersededAt ?? new Date().toISOString(),
    };
}

/**
 * Build an optional edge from a PM decision to an existing entry (a decision /
 * architecture id discovered via `atlas memory grep` before writing). A dangling
 * target is legal — the importer defers an edge whose endpoints aren't present
 * yet — but callers should lint-warn on one.
 */
export function buildPmDecisionEdge(
    requestId: string,
    targetId: string,
    relation: PmEdgeRelation,
    revision = 0,
): EdgeLine {
    const target = targetId?.trim();
    if (!target) throw new Error('buildPmDecisionEdge: targetId must be non-empty');
    if (!PM_EDGE_RELATION_SET.has(relation)) {
        throw new Error(`buildPmDecisionEdge: unknown relation '${relation}' (expected one of: ${PM_EDGE_RELATIONS.join(', ')})`);
    }
    return { kind: 'edge', sourceId: pmDecisionId(requestId, revision), targetId: target, relation };
}

export interface PmDecisionValidation {
    ok: boolean;
    errors: string[];
}

/** True when a node was authored by the PM (`metadata.source === 'pm'`). */
export function isPmNode(node: NodeLine): boolean {
    const meta = node.metadata;
    return typeof meta === 'object' && meta !== null
        && (meta as Record<string, unknown>)['source'] === PM_SOURCE;
}

/**
 * Validate that a NodeLine is a well-formed PM change-request decision per the
 * W3-T1 contract: type `decision`; provenance metadata (source=pm, requestId,
 * approvedBy, approvedAt, status); the id DERIVED from requestId (the
 * idempotency invariant — a mismatched id/requestId would break upsert); and a
 * contentHash that matches a recompute (integrity — catches a tampered/partial
 * entry). Returns every problem; never throws (a validator that throws can't
 * report more than the first fault).
 */
export function validatePmDecision(entry: NodeLine | EdgeLine): PmDecisionValidation {
    const errors: string[] = [];
    if (entry.kind !== 'node') {
        return { ok: false, errors: ['not a node (a PM decision is a node, not an edge)'] };
    }
    const node = entry;
    if (node.type !== 'decision') errors.push(`type must be 'decision' (got '${String(node.type)}')`);
    if (typeof node.content !== 'string' || !node.content.trim()) errors.push('content must be non-empty');
    if (!node.label || !node.label.trim()) errors.push('label must be non-empty');

    const meta = (typeof node.metadata === 'object' && node.metadata !== null)
        ? (node.metadata as Record<string, unknown>)
        : undefined;
    if (!meta) {
        errors.push('metadata must be an object with PM provenance (source, requestId, approvedBy, approvedAt, status)');
        return { ok: false, errors };
    }
    if (meta['source'] !== PM_SOURCE) errors.push(`metadata.source must be '${PM_SOURCE}' (got ${JSON.stringify(meta['source'])})`);
    const requestId = typeof meta['requestId'] === 'string' ? meta['requestId'].trim() : '';
    if (!requestId) errors.push('metadata.requestId must be a non-empty string');
    if (typeof meta['approvedBy'] !== 'string' || !meta['approvedBy'].trim()) errors.push('metadata.approvedBy must be a non-empty string');
    if (typeof meta['approvedAt'] !== 'string' || !meta['approvedAt'].trim()) errors.push('metadata.approvedAt must be a non-empty string');
    const status = meta['status'];
    if (typeof status !== 'string' || !PM_STATUS_SET.has(status)) {
        errors.push(`metadata.status must be one of: ${PM_DECISION_STATUSES.join(', ')} (got ${JSON.stringify(status)})`);
    }

    // Revision consistency + the id-derives-from-requestId idempotency invariant.
    const rev = meta['revision'];
    let revision = 0;
    if (rev !== undefined) {
        if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
            errors.push(`metadata.revision, when present, must be an integer >= 1 (got ${JSON.stringify(rev)})`);
        } else {
            revision = rev;
        }
    }
    if (requestId) {
        const expectedId = pmDecisionId(requestId, revision);
        if (node.id !== expectedId) {
            errors.push(`id '${node.id}' does not match the deterministic id for requestId '${requestId}'${revision > 0 ? ` revision ${revision}` : ''} (expected '${expectedId}')`);
        }
    }

    // contentHash integrity — recompute from the entry's own fields.
    const contentHash = meta['contentHash'];
    if (typeof contentHash !== 'string' || !contentHash) {
        errors.push('metadata.contentHash must be a non-empty string');
    } else if (requestId && typeof node.content === 'string' && node.label) {
        const expected = pmDecisionContentHash({
            requestId,
            label: node.label,
            content: node.content,
            approvedBy: typeof meta['approvedBy'] === 'string' ? meta['approvedBy'] : '',
        });
        if (contentHash !== expected) {
            errors.push('metadata.contentHash does not match the entry content (tampered or stale hash)');
        }
    }

    return { ok: errors.length === 0, errors };
}

// ── W3-T3 — the append step of the stateless PM loop ─────────────────────────

export interface RecordPmDecisionResult extends AppendResult {
    /** The deterministic id written (the idempotency key). */
    id: string;
    /** The full node line as written (for the caller to log / commit-message). */
    node: NodeLine;
}

/**
 * Build + validate + append an approved PM change-request decision to
 * `absPath`, through the SAME union/atomic-write path a developer hook uses
 * (appendMemoryEntries). This is step 4 of the normative PM loop (see
 * scripts/pm-memory-cycle.mjs) — the `git pull --rebase` before and the
 * `git commit`/`push` after are the CALLER'S responsibility; append IS the
 * PM's export (it has no DB). Zero native deps.
 *
 * Optional `edges` (targets discovered via `atlas memory grep`) are appended
 * alongside the decision in the same union write.
 */
export function recordPmDecision(
    absPath: string,
    input: PmDecisionInput,
    opts: { edges?: EdgeLine[] } = {},
): RecordPmDecisionResult {
    const node = buildPmDecision(input);
    // Defense in depth: the builder already enforces required fields, but run
    // the full contract validator so a future builder change can't quietly ship
    // a non-conforming entry into the ledger.
    const v = validatePmDecision(node);
    if (!v.ok) {
        throw new Error(`recordPmDecision: built an invalid PM decision: ${v.errors.join('; ')}`);
    }
    const entries: Array<NodeLine | EdgeLine> = [node, ...(opts.edges ?? [])];
    const result = appendMemoryEntries(absPath, entries, { exportedAt: input.approvedAt });
    return { ...result, id: node.id, node };
}

// ── W3-T5 — developer-side flag reader (read-only; flag, never block) ─────────

export interface UnbackedWorkFlag {
    /** The developer work node lacking an approved PM change request. */
    node: NodeLine;
    /** Human-readable reason (for a one-line notice). */
    reason: string;
}

export interface FlagUnbackedWorkOptions {
    /** Node types to treat as "work" needing a CR (default: ['decision']). */
    types?: NodeLine['type'][];
    /** Include soft-superseded work nodes (default false — a retired decision
     *  no longer needs backing). */
    includeSuperseded?: boolean;
}

/** True when a node is soft-superseded (a non-null `supersededAt` stamp). */
function nodeSuperseded(node: NodeLine): boolean {
    return typeof node.supersededAt === 'string' && node.supersededAt.length > 0;
}

/**
 * READ-ONLY: given a memory view, report developer work (non-PM nodes of the
 * given types) that has NO approved PM change request behind it — neither the
 * node itself being PM-authored nor an edge (either direction) linking it to an
 * approved, non-superseded PM decision. This is the developer-side surfacing of
 * process gaps: FLAG, NEVER BLOCK. It returns a list (empty = all backed);
 * it never throws and has no side effects.
 *
 * Deterministic: results are file order, then sorted by id ascending.
 */
export function flagUnbackedWork(
    view: MemoryFileView,
    opts: FlagUnbackedWorkOptions = {},
): UnbackedWorkFlag[] {
    const types = opts.types && opts.types.length > 0 ? new Set<string>(opts.types) : new Set<string>(['decision']);
    const includeSuperseded = opts.includeSuperseded ?? false;

    // Ids of approved, non-superseded PM decisions — the set that can "back" work.
    const backingIds = new Set<string>();
    for (const n of view.nodes) {
        if (!isPmNode(n)) continue;
        if (nodeSuperseded(n)) continue;
        const meta = n.metadata as Record<string, unknown> | undefined;
        if (meta && meta['status'] !== undefined && meta['status'] !== 'approved') continue;
        backingIds.add(n.id);
    }

    // Adjacency: for each node id, the set of ids it is edge-connected to.
    const linked = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
        let s = linked.get(a);
        if (!s) { s = new Set<string>(); linked.set(a, s); }
        s.add(b);
    };
    for (const e of view.edges) {
        link(e.sourceId, e.targetId);
        link(e.targetId, e.sourceId);
    }

    const flags: UnbackedWorkFlag[] = [];
    for (const node of view.nodes) {
        if (!types.has(node.type)) continue;
        if (isPmNode(node)) continue;            // PM-authored work is its own CR
        if (!includeSuperseded && nodeSuperseded(node)) continue;
        const neighborsOf = linked.get(node.id);
        let backed = false;
        if (neighborsOf) {
            for (const other of neighborsOf) {
                if (backingIds.has(other)) { backed = true; break; }
            }
        }
        if (!backed) {
            flags.push({ node, reason: 'no approved PM change request backs this work (no edge to an approved pm decision)' });
        }
    }
    flags.sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
    return flags;
}

export interface FlagNudgeOptions {
    /** Max work items to list before summarizing the rest (default 3). */
    maxItems?: number;
    /** Where to point developers to enable the PM (default: the contract doc). */
    learnMore?: string;
}

/**
 * Format the developer-facing "unbacked work" nudge — the free-tier experience
 * that NAMES the pain and points to the paid PM as the fix, at the moment a
 * developer commits (FLAG, NEVER BLOCK). Returns the lines to print, or `[]`
 * when nothing is flagged (stay silent on a clean project — no nag).
 *
 * Deliberately a soft pointer, not a fake "buy" button: the PM lives in the
 * PremiseHQ console (paid), so the free tool honestly points at how to enable
 * it and how to silence the nudge. Pure/deterministic; the caller owns the
 * output stream and the ATLAS_NO_NUDGE suppression check.
 */
export function formatFlagNudge(flags: UnbackedWorkFlag[], opts: FlagNudgeOptions = {}): string[] {
    if (flags.length === 0) return [];
    const maxItems = opts.maxItems ?? 3;
    const learnMore = opts.learnMore ?? 'docs/pm-memory-contract.md';
    const n = flags.length;
    const lines: string[] = [];
    lines.push(`⚠  Groundfloor Atlas — ${n} change${n === 1 ? '' : 's'} on this project ${n === 1 ? 'has' : 'have'} no approved change request:`);
    for (const f of flags.slice(0, maxItems)) lines.push(`     • ${f.node.label ?? f.node.id}`);
    if (n > maxItems) lines.push(`     • …and ${n - maxItems} more`);
    lines.push(`   Not blocked — but undocumented scope is where unbilled hours and missed change orders come from.`);
    lines.push(`   A PremiseHQ AI project manager catches these as they happen: reads the email, drafts the`);
    lines.push(`   change request, routes it for approval, and records the decision back here.`);
    lines.push(`   → Automate it: ${learnMore}   ·   silence this: ATLAS_NO_NUDGE=1`);
    return lines;
}
