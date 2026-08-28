/**
 * tests/recall-modes.test.ts — knowledge_recall output-mode regression guards.
 *
 * Two already-fixed behaviors had NO regression test. This pins both against the
 * real in-process Lore, so a future change to EmbeddedLore.recall() can't silently
 * regress them:
 *
 *   2b — `mode:'summary'` vs `'full'` (fixed `eb31292`). Summary returns a bounded
 *        content SNIPPET (RECALL_SNIPPET_CHARS=280, trailing "…"); full returns
 *        the complete content untouched. `e2e.test.ts:404` passes mode:'summary'
 *        but never asserts the truncation, so this is the only guard.
 *
 *   2c — `includeSuperseded` (fixed `c677009`). The defensive supersededAt filter
 *        must DROP a soft-superseded hit by default, and KEEP it when the caller
 *        explicitly sets includeSuperseded:true.
 *
 *   2d — `scope.workspace` (this fix). recall() used to build its underlying
 *        engine call with the hardcoded LORE_WORKSPACE constant and echo that
 *        call's response `scope` straight back, so the field always reported
 *        the internal 'default' placeholder no matter which workspace's
 *        dataDir was actually queried — misleading for anyone (rightly)
 *        treating the response as proof of what was scoped. Now sourced from
 *        the instance's own `workspace` (derived once in open() from the
 *        dataDir basename, which embeddedDataDir() always names after the
 *        workspace).
 *
 * Runs against a real in-process Lore (kuzu+lancedb+e5-small). Nodes are stored
 * with embed:true and awaitEmbeds() (the same-turn visibility settle) so vector
 * recall finds them deterministically — same pattern as recall-roundtrip.test.ts.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import type { StoreNodeInput } from '../src/loreClient.js';

/** A long, distinctive body well past the 280-char summary cap. */
const LONG_BODY =
    'We chose kuzu as the embedded graph database engine for Atlas because it ships a ' +
    'fast in-process native binary with a SQL interface, which keeps the dedicated per-workspace ' +
    'Lore instance self-contained with no separate daemon to manage. LanceDB holds the vector ' +
    'mirror and sqlite holds the verbatim text store, so the whole write and read path stays ' +
    'in-process. This rationale is intentionally long so the summary-mode snippet cap truncates it.';

interface RecallHit {
    id?: string;
    content?: string | null;
}
interface RecallResult {
    mode?: string;
    shown?: number;
    hits?: RecallHit[];
    scope?: { workspace?: string; ecosystem?: string };
}

async function main(): Promise<void> {
    console.log('Atlas knowledge_recall output-mode tests (summary/full + includeSuperseded)');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recall-modes-'));
    const lore = await EmbeddedLore.open(dir);
    await lore.connect();
    try {
        // ── Seed: one live node + one superseded twin (both embed:true) ──────
        const liveId = 'dec-recall-modes-live';
        const oldId = 'dec-recall-modes-old';
        const newId = 'dec-recall-modes-live'; // old is superseded BY live

        await lore.storeNode({
            id: liveId, type: 'decision', label: 'kuzu engine decision',
            content: LONG_BODY, workspace: 'developer', embed: true,
        } as StoreNodeInput);
        await lore.storeNode({
            id: oldId, type: 'decision', label: 'kuzu engine decision (old)',
            content: LONG_BODY, workspace: 'developer', embed: true,
        } as StoreNodeInput);
        await lore.awaitEmbeds();
        // Soft-supersede oldId → newId (audit trail preserved, old node stays queryable).
        await lore.supersedeNode(oldId, newId, 'test: supersede twin');
        // Re-settle so the superseded twin's vector is also visible to recall.
        await lore.awaitEmbeds();

        // ── 2b — summary vs full mode ───────────────────────────────────────
        const topic = 'which graph database engine did we choose';

        const full = (await lore.recall(topic, { mode: 'full', includeSuperseded: true })) as RecallResult;
        const fullHit = (full.hits ?? []).find((h) => h.id === liveId);
        assert.ok(fullHit, `full-mode recall found the live node; got ${JSON.stringify(full.hits?.map((h) => h.id))}`);
        assert.equal(
            fullHit!.content, LONG_BODY,
            `full-mode returns the COMPLETE content untouched; got ${JSON.stringify(fullHit!.content).slice(0, 120)}…`,
        );
        console.log('  ✓ 2b full-mode: returns complete node content (len=' + (fullHit!.content?.length ?? 0) + ')');

        const summary = (await lore.recall(topic, { mode: 'summary', includeSuperseded: true })) as RecallResult;
        const summaryHit = (summary.hits ?? []).find((h) => h.id === liveId);
        assert.ok(summaryHit, `summary-mode recall found the live node; got ${JSON.stringify(summary.hits?.map((h) => h.id))}`);
        // Summary must TRUNCATE: shorter than full, and carry the ellipsis marker.
        assert.ok(
            (summaryHit!.content?.length ?? 0) < (fullHit!.content?.length ?? 0),
            `summary content is shorter than full; got summary len=${summaryHit!.content?.length} full len=${fullHit!.content?.length}`,
        );
        assert.ok(
            (summaryHit!.content?.endsWith('…') === true),
            `summary content ends with the truncation ellipsis; got ${JSON.stringify(summaryHit!.content).slice(-40)}`,
        );
        // And the cap is respected (snippet length ≤ cap + the "…" marker).
        assert.ok(
            (summaryHit!.content?.length ?? 0) <= 281,
            `summary snippet respects RECALL_SNIPPET_CHARS=280 (+ ellipsis); got len=${summaryHit!.content?.length}`,
        );
        console.log('  ✓ 2b summary-mode: content truncated to a bounded snippet ending in "…" (len=' + (summaryHit!.content?.length ?? 0) + ')');

        // ── 2c — includeSuperseded ──────────────────────────────────────────
        // Default (false): the superseded twin must NOT appear among the hits.
        const excludeSup = (await lore.recall(topic, { mode: 'full', includeSuperseded: false })) as RecallResult;
        const excludedIds = (excludeSup.hits ?? []).map((h) => h.id);
        assert.ok(
            !excludedIds.includes(oldId),
            `includeSuperseded:false DROPS the superseded node ${oldId}; got ${JSON.stringify(excludedIds)}`,
        );
        // The LIVE node should still be present (sanity — the filter targets supersession, not everything).
        assert.ok(excludedIds.includes(liveId), `includeSuperseded:false still returns the live node ${liveId}`);
        console.log(`  ✓ 2c includeSuperseded=false: superseded node dropped (${excludedIds.length} live hit(s) returned)`);

        const includeSup = (await lore.recall(topic, { mode: 'full', includeSuperseded: true })) as RecallResult;
        const includedIds = (includeSup.hits ?? []).map((h) => h.id);
        assert.ok(
            includedIds.includes(oldId),
            `includeSuperseded:true KEEPS the superseded node ${oldId}; got ${JSON.stringify(includedIds)}`,
        );
        console.log(`  ✓ 2c includeSuperseded=true: superseded node kept (${includedIds.length} hit(s) returned)`);

        // ── 2d — scope.workspace reports THIS instance's real workspace ─────
        // (embeddedDataDir always names dataDir after the workspace, so the
        // basename is the ground truth — not a re-derivation of the bug).
        const scoped = (await lore.recall(topic, { mode: 'summary', includeSuperseded: true })) as RecallResult;
        const expectedWorkspace = path.basename(dir);
        assert.equal(
            scoped.scope?.workspace, expectedWorkspace,
            `scope.workspace reflects this instance's real workspace (${expectedWorkspace}), not the hardcoded 'default' placeholder; got ${JSON.stringify(scoped.scope)}`,
        );
        console.log(`  ✓ 2d scope.workspace reports the real workspace (${scoped.scope?.workspace}), not the internal placeholder`);
    } finally {
        await lore.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('All knowledge_recall output-mode tests passed.');
}

await main();
