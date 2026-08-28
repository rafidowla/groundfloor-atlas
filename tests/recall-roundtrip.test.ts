/**
 * tests/recall-roundtrip.test.ts — store → recall SAME-TURN guard.
 *
 * Regression for the HIGH found in the 2026-06-29 round-5 audit: awaitEmbeds()
 * used to resolve BEFORE the freshly-stored node's vector was queryable in
 * LanceDB, so the documented `knowledge_store` → `knowledge_recall` round-trip
 * within one turn intermittently returned 0 hits. The fix makes awaitEmbeds()
 * itself settle LanceDB visibility (_settleLanceVisibility).
 *
 * This guard does store(embed:true) → awaitEmbeds() → recall() with NO setTimeout
 * and asserts the node is found — unlike tests/memory-edges.test.ts (which hides
 * the lag behind a 1500ms sleep) and e2e C2 (which only asserts recall doesn't
 * crash). Runs a few iterations so the fix can't pass by luck.
 *
 * Runs against a real in-process Lore (kuzu+lancedb+e5-small).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-recall-rt-${tag}-`));
}

async function main(): Promise<void> {
    console.log('Atlas store→recall same-turn round-trip test');

    const ITERATIONS = 4;
    const dirs: string[] = [];
    try {
        for (let i = 0; i < ITERATIONS; i++) {
            const dir = tmpDir(String(i));
            dirs.push(dir);
            const lore = await EmbeddedLore.open(dir);
            try {
                const id = `dec-${i}`;
                await lore.storeNode({
                    id,
                    type: 'decision',
                    content: 'We chose kuzu as the embedded graph database engine for Atlas',
                    workspace: 'developer',
                    embed: true,
                });
                // The ONLY synchronization the documented round-trip relies on.
                // No setTimeout — that is the whole point of this guard.
                await lore.awaitEmbeds();

                const r = (await lore.recall('which graph database engine did we choose', { max: 5 })) as {
                    hits?: Array<{ id?: string }>;
                };
                const found = (r.hits ?? []).some((h) => h.id === id);
                assert.ok(found, `iteration ${i}: store→recall same-turn did NOT find ${id} (visibility race regressed)`);
            } finally {
                await lore.close();
            }
        }
        console.log(`  ✓ store→recall same-turn found the node ${ITERATIONS}/${ITERATIONS} times (no sleep)`);
        console.log('All store→recall round-trip tests passed.');
    } finally {
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
