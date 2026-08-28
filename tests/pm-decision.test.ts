/**
 * tests/pm-decision.test.ts — W3-T1 (PM change-request decision schema) +
 * W3-T5 (developer-side flag reader), the pure-library layer.
 *
 * Guards the PM's write contract: the deterministic idempotency-key id, the
 * provenance metadata + contentHash, the validator's acceptance/rejection
 * boundary, supersede-for-revisions, the optional edge, the recordPmDecision
 * append step (same union/atomic path as the developer hook), and the read-only
 * flagUnbackedWork reader (flag, never block). Zero native deps.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildPmDecision, validatePmDecision, buildPmDecisionEdge, supersedePmDecision,
    recordPmDecision, flagUnbackedWork, isPmNode,
    pmDecisionId, pmDecisionContentHash, pmDecisionSlug,
    PM_SOURCE,
} from '../src/pmDecision.js';
import { readMemoryFile, appendMemoryEntries, type NodeLine, type EdgeLine, type MemoryFileView } from '../src/memoryFile.js';

const TS = '2026-07-16T00:00:00.000Z';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pmdec-'));
}

/** A minimal in-memory MemoryFileView for the flag-reader tests. */
function viewOf(nodes: NodeLine[], edges: EdgeLine[] = []): MemoryFileView {
    return { headerVersion: 2, nodes, edges, errors: [] };
}
function devNode(id: string, extra: Partial<NodeLine> = {}): NodeLine {
    return { kind: 'node', id, type: 'decision', label: id, content: `content ${id}`, tags: 'dev', metadata: { source: 'dev' }, supersededAt: null, ...extra };
}

async function main(): Promise<void> {
    console.log('pm-decision (W3-T1 + W3-T5) contract tests');

    // ── CLAIM 1 — deterministic id + full provenance shape ───────────────────
    {
        const node = buildPmDecision({
            requestId: 'REQ-42', label: 'Adopt union merge driver',
            content: 'Approved: union merge on memory.jsonl. Scope: sync layer.',
            approvedBy: 'rafi', approvedAt: TS, area: 'sync',
        });
        assert.equal(node.id, 'knowledge:decision:pm-REQ-42', 'id = knowledge:decision:pm-<requestId>');
        assert.equal(node.id, pmDecisionId('REQ-42'));
        assert.equal(node.type, 'decision');
        assert.equal(node.supersededAt, null);
        assert.equal(node.tags, 'pm,change-request,sync', 'fixed tags + area, deduped/ordered');
        const meta = node.metadata as Record<string, unknown>;
        assert.equal(meta['source'], PM_SOURCE);
        assert.equal(meta['requestId'], 'REQ-42');
        assert.equal(meta['approvedBy'], 'rafi');
        assert.equal(meta['approvedAt'], TS);
        assert.equal(meta['status'], 'approved');
        assert.equal(meta['contentHash'], pmDecisionContentHash({ requestId: 'REQ-42', label: 'Adopt union merge driver', content: 'Approved: union merge on memory.jsonl. Scope: sync layer.', approvedBy: 'rafi' }));
        assert.equal(meta['revision'], undefined, 'no revision key on the base entry');
        // Deterministic: same input → byte-identical node.
        const again = buildPmDecision({ requestId: 'REQ-42', label: 'Adopt union merge driver', content: 'Approved: union merge on memory.jsonl. Scope: sync layer.', approvedBy: 'rafi', approvedAt: TS, area: 'sync' });
        assert.equal(JSON.stringify(node), JSON.stringify(again), 'build is deterministic given fixed approvedAt');
        assert.ok(isPmNode(node));
        console.log('  ✓ CLAIM 1: deterministic id, tags, and full PM provenance metadata');
    }

    // ── CLAIM 2 — validator accepts a built entry, rejects malformed ones ────
    {
        const good = buildPmDecision({ requestId: 'REQ-1', label: 'x', content: 'approved x', approvedBy: 'p', approvedAt: TS });
        assert.deepEqual(validatePmDecision(good), { ok: true, errors: [] }, 'built entry validates');

        // wrong type
        assert.equal(validatePmDecision({ ...good, type: 'convention' as never }).ok, false);
        // empty content
        assert.equal(validatePmDecision({ ...good, content: '' }).ok, false);
        // missing metadata
        assert.equal(validatePmDecision({ ...good, metadata: undefined }).ok, false);
        // wrong source
        assert.equal(validatePmDecision({ ...good, metadata: { ...(good.metadata as object), source: 'dev' } }).ok, false);
        // id not derived from requestId (idempotency invariant broken)
        assert.equal(validatePmDecision({ ...good, id: 'knowledge:decision:pm-OTHER' }).ok, false);
        // tampered content → contentHash mismatch
        assert.equal(validatePmDecision({ ...good, content: 'approved x (tampered)' }).ok, false);
        // an edge is not a PM decision
        assert.equal(validatePmDecision({ kind: 'edge', sourceId: 'a', targetId: 'b', relation: 'relates_to' }).ok, false);
        console.log('  ✓ CLAIM 2: validator accepts a valid entry and rejects each contract violation');
    }

    // ── CLAIM 3 — builder guards required fields; edge builder + relations ────
    {
        assert.throws(() => buildPmDecision({ requestId: '', label: 'x', content: 'c', approvedBy: 'p' }), /requestId is required/);
        assert.throws(() => buildPmDecision({ requestId: 'R', label: '', content: 'c', approvedBy: 'p' }), /label is required/);
        assert.throws(() => buildPmDecision({ requestId: 'R', label: 'x', content: '  ', approvedBy: 'p' }), /content is required/);
        assert.throws(() => buildPmDecision({ requestId: 'R', label: 'x', content: 'c', approvedBy: '' }), /approvedBy is required/);

        const e = buildPmDecisionEdge('REQ-1', 'knowledge:architecture:sync-layer', 'relates_to');
        assert.deepEqual(e, { kind: 'edge', sourceId: 'knowledge:decision:pm-REQ-1', targetId: 'knowledge:architecture:sync-layer', relation: 'relates_to' });
        assert.throws(() => buildPmDecisionEdge('REQ-1', 'x', 'bogus' as never), /unknown relation/);
        assert.throws(() => buildPmDecisionEdge('REQ-1', '', 'relates_to'), /targetId must be non-empty/);
        assert.equal(pmDecisionSlug('REQ-1'), 'pm-REQ-1');
        assert.equal(pmDecisionSlug('REQ-1', 2), 'pm-REQ-1-r2');
        console.log('  ✓ CLAIM 3: builder field guards + edge builder + relation validation');
    }

    // ── CLAIM 4 — supersede-for-revisions: new id, prior stamped ─────────────
    {
        const base = buildPmDecision({ requestId: 'REQ-9', label: 'v1', content: 'first approval', approvedBy: 'p', approvedAt: TS });
        const revised = buildPmDecision({ requestId: 'REQ-9', label: 'v2', content: 'revised approval', approvedBy: 'p', approvedAt: TS, revision: 1 });
        assert.equal(revised.id, 'knowledge:decision:pm-REQ-9-r1', 'revision mints a NEW id');
        assert.notEqual(revised.id, base.id);
        assert.equal((revised.metadata as Record<string, unknown>)['revision'], 1);
        assert.equal(validatePmDecision(revised).ok, true, 'a revised entry validates (id derives from requestId+revision)');

        const retired = supersedePmDecision(base, TS);
        assert.equal(retired.id, base.id, 'supersede keeps the id (ours-wins upsert)');
        assert.equal(retired.supersededAt, TS);
        assert.equal((retired.metadata as Record<string, unknown>)['status'], 'superseded');
        // Original untouched.
        assert.equal(base.supersededAt, null);
        console.log('  ✓ CLAIM 4: supersede-for-revisions — new id + prior soft-superseded, original unmutated');
    }

    // ── CLAIM 5 — recordPmDecision appends idempotently via the union path ───
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'memory.jsonl');
            const r1 = recordPmDecision(p, { requestId: 'REQ-7', label: 'x', content: 'approved x', approvedBy: 'p', approvedAt: TS });
            assert.equal(r1.id, 'knowledge:decision:pm-REQ-7');
            assert.equal(r1.nodeCount, 1);
            const first = fs.readFileSync(p, 'utf8');
            // Re-run same requestId → byte-stable, still exactly one node.
            const r2 = recordPmDecision(p, { requestId: 'REQ-7', label: 'x', content: 'approved x', approvedBy: 'p', approvedAt: TS });
            assert.equal(r2.nodeCount, 1, 'same requestId re-run stays one node (idempotent upsert)');
            assert.equal(fs.readFileSync(p, 'utf8'), first, 'byte-stable re-run');

            const view = await readMemoryFile(p);
            assert.equal(view.nodes.length, 1);
            assert.equal(validatePmDecision(view.nodes[0]!).ok, true, 'round-trips through readMemoryFile and still validates');
            console.log('  ✓ CLAIM 5: recordPmDecision idempotent append, round-trips + validates');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── CLAIM 6 — flagUnbackedWork: report unbacked dev work; flag not block ─
    {
        const pmApproved = buildPmDecision({ requestId: 'REQ-1', label: 'approve', content: 'approved', approvedBy: 'p', approvedAt: TS });
        const backed = devNode('dec-backed', { content: 'implements REQ-1' });
        const unbacked = devNode('dec-unbacked', { content: 'no CR' });
        const supersededDev = devNode('dec-old', { supersededAt: TS });
        const edge: EdgeLine = { kind: 'edge', sourceId: 'dec-backed', targetId: pmApproved.id, relation: 'relates_to' };

        const flags = flagUnbackedWork(viewOf([pmApproved, backed, unbacked, supersededDev], [edge]));
        assert.deepEqual(flags.map((f) => f.node.id), ['dec-unbacked'],
            'only the un-backed, non-superseded dev decision is flagged; PM node + backed + superseded are not');

        // A PM decision that is NOT approved cannot back work.
        const pmPending = buildPmDecision({ requestId: 'REQ-2', label: 'pending', content: 'pending', approvedBy: 'p', approvedAt: TS, status: 'withdrawn' });
        const backedByPending: NodeLine = devNode('dec-x');
        const e2: EdgeLine = { kind: 'edge', sourceId: 'dec-x', targetId: pmPending.id, relation: 'relates_to' };
        const flags2 = flagUnbackedWork(viewOf([pmPending, backedByPending], [e2]));
        assert.deepEqual(flags2.map((f) => f.node.id), ['dec-x'], 'a withdrawn PM decision does not back work');

        // includeSuperseded surfaces retired work too.
        const flags3 = flagUnbackedWork(viewOf([supersededDev], []), { includeSuperseded: true });
        assert.deepEqual(flags3.map((f) => f.node.id), ['dec-old']);

        // Empty when everything is backed / no work — never throws.
        assert.deepEqual(flagUnbackedWork(viewOf([pmApproved], [])), []);
        console.log('  ✓ CLAIM 6: flagUnbackedWork reports only unbacked non-PM work, deterministic');
    }

    console.log('pm-decision: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
