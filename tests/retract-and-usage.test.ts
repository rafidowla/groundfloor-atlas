/**
 * tests/retract-and-usage.test.ts — integrator asks #2 and #4.
 *
 * #2 knowledge_retract — withdraw a note with NO replacement. Retracted nodes
 *    must behave exactly like superseded ones: kept with history, hidden from
 *    default recall, visible under includeSuperseded.
 * #4 llm_chat usage — token counts for metering, normalized across providers.
 *
 * CLAIM A — Lore REJECTS self-supersession. This is the whole reason retract
 *           needs a tombstone target rather than pointing a node at itself; if
 *           this ever starts succeeding, the tombstone can be simplified away,
 *           so the assertion is deliberately explicit about what it pins.
 * CLAIM B — superseding to a tombstone hides the node from default recall and
 *           restores it under includeSuperseded (the retract mechanism).
 * CLAIM C — the tombstone itself (embed:false) never surfaces in recall. It is
 *           a graph anchor, not knowledge; if it ranked, every retraction would
 *           pollute the results it was meant to clean up.
 * CLAIM D — usage normalization: absent ≠ zero, and totals are derived only
 *           when the provider didn't supply one.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { normalizeUsage } from '../src/mcp/tools/llmChat.js';

interface Hit { id?: string }
interface RecallResult { hits?: Hit[] }
const ids = (r: unknown): string[] => ((r as RecallResult).hits ?? []).map((h) => h.id ?? '');

async function main(): Promise<void> {
    console.log('Running retract + llm-usage tests…');

    // ── CLAIM D — pure, no I/O, so run it first ─────────────────────────────
    {
        assert.equal(normalizeUsage(undefined, undefined, undefined).source, 'absent',
            'no numbers at all must report absent, never a zeroed total');
        const openai = normalizeUsage(10, 5, 15);
        assert.deepEqual(openai, { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'provider' });
        // Anthropic sends no total — derive it rather than dropping it.
        const anthropic = normalizeUsage(10, 5);
        assert.equal(anthropic.totalTokens, 15, 'total must be derived when the provider omits it');
        // A partial report must NOT invent the missing half.
        const partial = normalizeUsage(10, undefined);
        assert.equal(partial.outputTokens, undefined);
        assert.equal(partial.totalTokens, undefined, 'never fabricate a total from one number');
        assert.equal(partial.source, 'provider');
        // Zero is a real, billable report — distinct from absent.
        assert.equal(normalizeUsage(0, 0, 0).source, 'provider');
        console.log('  ✓ CLAIM D: usage normalization — absent ≠ zero, totals derived not invented');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-retract-'));
    const lore = await EmbeddedLore.open(dir);
    await lore.connect();
    try {
        const victimId = 'conv-retract-victim';
        const TOPIC = 'indentation tabs spaces formatting convention';
        await lore.storeNode({
            id: victimId, type: 'convention', label: 'Use tabs for indentation',
            content: 'This project indents with tabs, never spaces. Applies to every source file, ' +
                'including config and generated output, so diffs stay stable across editors.',
            workspace: 'default', embed: true,
        } as never);
        await lore.awaitEmbeds();

        // Present before any retraction.
        assert.ok(ids(await lore.recall(TOPIC, { max: 10 })).includes(victimId),
            'precondition: the node must be recallable before it is retracted');

        // ── CLAIM A — self-supersession is refused ──────────────────────────
        {
            const self = await lore.supersedeNode(victimId, victimId, 'retract with no replacement') as { ok?: boolean; reason?: string } | null;
            assert.equal(self?.ok, false, 'self-supersede must be refused');
            assert.equal(self?.reason, 'self', 'refusal reason should identify the self-reference');
            assert.ok(ids(await lore.recall(TOPIC, { max: 10 })).includes(victimId),
                'a REFUSED supersede must not have hidden the node as a side effect');
            console.log('  ✓ CLAIM A: self-supersede refused — tombstone target is required');
        }

        // ── CLAIM B — supersede to a tombstone == retract ────────────────────
        const tombstoneId = 'knowledge:tombstone:default';
        {
            await lore.storeNode({
                id: tombstoneId, type: 'architecture', workspace: 'default', embed: false,
                label: 'Retracted knowledge (tombstone)',
                content: 'Sink node for retracted knowledge in this workspace. Not knowledge itself.',
                tags: 'atlas,tombstone,retracted,internal',
            } as never);
            const res = await lore.supersedeNode(victimId, tombstoneId, 'wrong — we use spaces') as { ok?: boolean } | null;
            assert.notEqual(res?.ok, false, 'supersede to tombstone must succeed');

            assert.ok(!ids(await lore.recall(TOPIC, { max: 10 })).includes(victimId),
                'retracted node must be hidden from default recall');
            assert.ok(ids(await lore.recall(TOPIC, { max: 10, includeSuperseded: true })).includes(victimId),
                'retracted node must return under includeSuperseded — retraction is soft, not deletion');
            console.log('  ✓ CLAIM B: retracted — hidden by default, recoverable via includeSuperseded');
        }

        // ── CLAIM C — the tombstone stays out of results ────────────────────
        {
            for (const topic of ['retracted knowledge tombstone sink node', TOPIC]) {
                const hits = ids(await lore.recall(topic, { max: 20, includeSuperseded: true }));
                assert.ok(!hits.includes(tombstoneId),
                    `tombstone must never surface in recall (topic: ${topic})`);
            }
            console.log('  ✓ CLAIM C: tombstone never surfaces in recall');
        }
    } finally {
        await lore.close().catch(() => { /* teardown best-effort */ });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('retract + llm-usage: all checks passed');
}

await main();
