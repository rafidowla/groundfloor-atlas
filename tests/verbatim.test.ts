/**
 * tests/verbatim.test.ts — WO-2 verbatim memory tool claims.
 *
 * Drives the real tool implementations against a real in-process Lore
 * (kuzu+lancedb+e5-small, scratch dataDir) exactly as the MCP handlers do:
 *
 *   CLAIM A — store → flush (direct call, not the 30s tick) → recall returns
 *             the entry with status 'current' and intact headers.
 *   CLAIM B — three same-topic entries T1<T2<T3, no supersedes edges: T3 is
 *             'current', T1/T2 are `outdated-by:<T3 id> (by time)`, T3 leads.
 *   CLAIM C — a `supersedes` edge new→old flips the old entry to
 *             `superseded-by:<new id>` (edge rule outranks the time rule).
 *   CLAIM D — re-storing byte-identical text yields the SAME node id and leaves
 *             the workspace node count unchanged (idempotent upsert by hash).
 *   CLAIM E — after later stores, entry N's content after the two header lines
 *             is byte-identical to the original raw text (append-only, no
 *             accidental mutation).
 *   CLAIM F — (regression) a flush step that never settles — the live-daemon
 *             wedge: LanceDB search-worker hang / maintenance-lock stall on a
 *             long-running shared instance — must not wedge the queue: the
 *             flush returns bounded, requeues, and a later healthy flush
 *             lands the entry.
 *   CLAIM G — (durability) the write-ahead journal: an enqueued entry is on
 *             disk before any flush, survives a simulated hard kill (no
 *             flush, no shutdown — module reset + the daemon's own startup
 *             replay), landed entries are compacted away so the journal
 *             stays bounded, and malformed journal lines never block replay.
 *   CLAIM H — (search visibility) a landed batch fires the bounded,
 *             rate-limited index fold (runMaintenance — the same surface
 *             as the daemon's 20-min ticker) at the right cadence: first
 *             landed batch, then every 5th batch OR 2 minutes whichever
 *             fires first, at most one in flight, suppressed batches are
 *             not lost, and a parked fold never delays a flush pass.
 *   CLAIM I — (regression, content-sized batching) large notes are batched by
 *             estimated embed-chunk cost, not raw node count: no
 *             bulkStoreNodes call may carry more than the chunk budget
 *             (except a single oversized note, which travels SOLO — never
 *             skipped), cheap notes still group, and everything lands in one
 *             bounded pass instead of timing out and requeueing every tick
 *             (the 2026-08 llm-api-gateway head-of-line incident shape).
 *   CLAIM J — (regression, rotate-not-break) one workspace's failing batch
 *             must not block a DIFFERENT workspace's queued entries: the
 *             pass rotates past the failure (requeue to the back) and drains
 *             the healthy workspace sitting BEHIND it in FIFO order. Also
 *             exercises the retry-path existence pre-check and the
 *             workspace_status health surface (streak, pending, breaker).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { runVerbatimStore, runVerbatimRecall, parseVerbatimContent, buildVerbatimNode } from '../src/mcp/tools/verbatim.js';
import { flushVerbatimQueue, replayVerbatimJournal, enqueueVerbatim, _resetVerbatimQueueForTest, _setVerbatimJournalPathForTests,
    _setVerbatimFoldClockForTests, _verbatimFoldForTests, VERBATIM_FOLD_EVERY_BATCHES, VERBATIM_FOLD_MIN_INTERVAL_MS,
    estimateEmbedChunks, VERBATIM_BATCH_CHUNK_BUDGET, verbatimQueueHealth } from '../src/mcp/verbatimQueue.js';
import type { StoreNodeInput } from '../src/loreClient.js';

/** Open a scratch dedicated instance (the way the registry isolates a
 *  workspace) and pair it with a queue `borrow` that hands it to the flush. */
async function openScratch(tag: string): Promise<{ lore: EmbeddedLore; dir: string; borrow: () => Promise<{ lore: EmbeddedLore; release: () => void }> }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-verbatim-${tag}-`));
    const lore = await EmbeddedLore.open(dir);
    await lore.connect();
    return { lore, dir, borrow: async () => ({ lore, release: () => undefined }) };
}

async function main(): Promise<void> {
    console.log('Atlas verbatim memory tool tests');
    const cleanup: Array<() => void> = [];

    // File-wide journal hermeticity: every claim below enqueues through the
    // REAL queue, which now journals write-ahead — point the journal at a
    // scratch file so the tests never touch the real ATLAS_HOME (embedded
    // Lore's env-scrubber also deletes ATLAS_HOME from process.env mid-test,
    // so an env-var redirect would silently fall back to the real home).
    const journalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verbatim-journal-'));
    cleanup.push(() => fs.rmSync(journalHome, { recursive: true, force: true }));
    _setVerbatimJournalPathForTests(path.join(journalHome, 'verbatim-queue.jsonl'));

    try {
        // ── CLAIM A — store → direct flush → recall 'current' ───────────────
        {
            const { lore, dir, borrow } = await openScratch('a');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            try {
                const text = 'The graph engine choice for atlas is kuzu with lancedb vectors, embedded per project.';
                const res = runVerbatimStore({
                    workspace: 'ws-a',
                    text,
                    source: 'session:test-a',
                    topic: 'engine-choice',
                    timestamp: '2026-08-26T10:00:00.000Z',
                });
                assert.equal(res.ok, true);
                assert.equal(res.queued, true);
                assert.match(res.id, /^verbatim:[0-9a-f]{12}$/, 'id is verbatim:<12 hex>');

                const fl = await flushVerbatimQueue({ borrow });
                assert.equal(fl.flushed, 1, `flush landed 1 node; got ${JSON.stringify(fl)}`);
                assert.equal(fl.remaining, 0);

                const r = await runVerbatimRecall(lore, { workspace: 'ws-a', topic: 'graph engine choice', limit: 10 });
                const hit = r.hits.find((h) => h.id === res.id);
                assert.ok(hit, `recall returned the stored entry; got ${JSON.stringify(r.hits.map((h) => h.id))}`);
                assert.equal(hit.status, 'current');
                assert.equal(hit.at, '2026-08-26T10:00:00.000Z');
                assert.equal(hit.source, 'session:test-a');
                assert.equal(parseVerbatimContent(hit.content).text, text, 'raw text round-trips byte-exact');
                console.log('  ✓ CLAIM A: store → flush → recall returns the entry, status current');
            } finally {
                await lore.close();
            }
        }

        // ── CLAIM B — same-topic T1<T2<T3: newest current, older outdated-by time ──
        {
            const { lore, dir, borrow } = await openScratch('b');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            try {
                const s1 = runVerbatimStore({ workspace: 'ws-b', source: 'doc:/tmp/deploys-1.md', topic: 'deploys',
                    timestamp: '2026-08-01T09:00:00.000Z', text: 'Deploys decision revision one: deploy the edge service with blue-green deploys on weekdays.' });
                const s2 = runVerbatimStore({ workspace: 'ws-b', source: 'doc:/tmp/deploys-2.md', topic: 'deploys',
                    timestamp: '2026-08-02T09:00:00.000Z', text: 'Deploys decision revision two: blue-green deploys plus automatic rollback on error-rate spikes.' });
                const s3 = runVerbatimStore({ workspace: 'ws-b', source: 'doc:/tmp/deploys-3.md', topic: 'deploys',
                    timestamp: '2026-08-03T09:00:00.000Z', text: 'Deploys decision revision three: blue-green deploys, auto rollback, and a manual gate for fridays.' });
                const fl = await flushVerbatimQueue({ borrow });
                assert.equal(fl.flushed, 3, `all three landed; got ${JSON.stringify(fl)}`);

                const r = await runVerbatimRecall(lore, { workspace: 'ws-b', topic: 'deploys', limit: 10 });
                assert.equal(r.hits.length, 3, `all three same-topic entries recalled; got ${JSON.stringify(r.hits.map((h) => [h.id, h.status]))}`);
                const byId = new Map(r.hits.map((h) => [h.id, h]));
                assert.equal(byId.get(s3.id)!.status, 'current', 'newest (T3) is current');
                assert.equal(byId.get(s1.id)!.status, `outdated-by:${s3.id} (by time)`, 'T1 outdated-by T3');
                assert.equal(byId.get(s2.id)!.status, `outdated-by:${s3.id} (by time)`, 'T2 outdated-by T3');
                assert.equal(r.hits[0]!.id, s3.id, 'newest current hit leads the result');
                assert.equal(r.hits[1]!.id, s2.id, 'non-current hits follow by AT descending (T2)');
                assert.equal(r.hits[2]!.id, s1.id, 'then T1');
                console.log('  ✓ CLAIM B: T3 current and leading; T1/T2 outdated-by:<T3> (by time)');
            } finally {
                await lore.close();
            }
        }

        // ── CLAIMS C/D/E — shared scratch instance, isolated topics ─────────
        {
            const { lore, dir, borrow } = await openScratch('cde');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            try {
                // CLAIM C — supersedes edge new→old beats the time rule.
                const oldE = runVerbatimStore({ workspace: 'ws-cde', source: 'session:c-old', topic: 'session-store',
                    timestamp: '2026-08-01T09:00:00.000Z', text: 'Session store note original: we kept sessions in redis with ttl thirty minutes.' });
                const newE = runVerbatimStore({ workspace: 'ws-cde', source: 'session:c-new', topic: 'session-store',
                    timestamp: '2026-08-05T09:00:00.000Z', text: 'Session store note replacement: sessions now live in sqlite with wal mode enabled.' });
                await flushVerbatimQueue({ borrow });
                await lore.storeEdge({ sourceId: newE.id, targetId: oldE.id, relation: 'supersedes', workspace: 'ws-cde' });
                const rC = await runVerbatimRecall(lore, { workspace: 'ws-cde', topic: 'session store', limit: 10 });
                const byIdC = new Map(rC.hits.map((h) => [h.id, h]));
                assert.ok(byIdC.has(oldE.id) && byIdC.has(newE.id), `both entries recalled; got ${JSON.stringify(rC.hits.map((h) => h.id))}`);
                assert.equal(byIdC.get(oldE.id)!.status, `superseded-by:${newE.id}`, 'old entry is superseded-by the new one (edge rule)');
                assert.equal(byIdC.get(newE.id)!.status, 'current');
                console.log('  ✓ CLAIM C: supersedes edge marks the old entry superseded-by:<new id>');

                // CLAIM D — byte-identical text → same id, node count unchanged.
                const textD = 'Rate limit policy: the api gateway enforces one hundred requests per minute per token, bursting to two hundred.';
                const d1 = runVerbatimStore({ workspace: 'ws-cde', source: 'session:d', topic: 'rate-limit',
                    timestamp: '2026-08-10T09:00:00.000Z', text: textD });
                await flushVerbatimQueue({ borrow });
                const before = (await lore.getStats()).nodeCount;
                const d2 = runVerbatimStore({ workspace: 'ws-cde', source: 'session:d', topic: 'rate-limit',
                    timestamp: '2026-08-20T09:00:00.000Z', text: textD }); // byte-identical TEXT (hash input), later timestamp
                await flushVerbatimQueue({ borrow });
                const after = (await lore.getStats()).nodeCount;
                assert.equal(d2.id, d1.id, 'identical text → identical deterministic id');
                assert.equal(after, before, `node count unchanged after re-store (${before} → ${after})`);
                console.log('  ✓ CLAIM D: byte-identical re-store is an idempotent upsert (same id, count unchanged)');

                // CLAIM E — later stores never mutate entry N's raw text.
                const rawN = 'Entry N raw text: keep   exact\n\ttabs and "quotes" and /slashes/\nline three unchanged.';
                const n = runVerbatimStore({ workspace: 'ws-cde', source: 'session:e-n', topic: 'entry-n',
                    timestamp: '2026-08-12T09:00:00.000Z', text: rawN });
                await flushVerbatimQueue({ borrow });
                runVerbatimStore({ workspace: 'ws-cde', source: 'session:e-later1', topic: 'entry-later',
                    timestamp: '2026-08-13T09:00:00.000Z', text: 'Later entry one: unrelated content about the widget pipeline.' });
                runVerbatimStore({ workspace: 'ws-cde', source: 'session:e-later2', topic: 'entry-later',
                    timestamp: '2026-08-14T09:00:00.000Z', text: 'Later entry two: more unrelated content about reporting jobs.' });
                await flushVerbatimQueue({ borrow });
                const rE = await runVerbatimRecall(lore, { workspace: 'ws-cde', topic: 'entry N raw text', limit: 10 });
                const hitN = rE.hits.find((h) => h.id === n.id);
                assert.ok(hitN, `entry N still recallable after later stores; got ${JSON.stringify(rE.hits.map((h) => h.id))}`);
                assert.ok(hitN.content.startsWith(`SOURCE: session:e-n\nAT: 2026-08-12T09:00:00.000Z\n\n`), 'header lines intact');
                assert.equal(parseVerbatimContent(hitN.content).text, rawN, 'content after the two header lines is byte-identical to the original');
                console.log('  ✓ CLAIM E: entry N byte-identical after later stores (append-only)');
            } finally {
                await lore.close();
            }
        }

        // ── CLAIM F (regression, live-daemon shape) — a flush step that never
        //    settles must not wedge the queue. On the live long-running daemon
        //    the never-settling step was bulkStoreNodes/awaitEmbeds against a
        //    shared EmbeddedLore (LanceDB search-worker hang, maintenance-lock
        //    stall); the old flush held its in-flight flag across the eternal
        //    await, so every later flush — including the daemon's shutdown
        //    flush — returned instantly with "0 landed, N unflushed" and no
        //    error logged. The fresh-instance claims above could not see this.
        {
            const { lore, dir, borrow } = await openScratch('f');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            try {
                // A lore whose bulkStoreNodes NEVER settles, and a borrow that
                // hands it out like the registry would.
                const wedgeLore = {
                    bulkStoreNodes: () => new Promise<never>(() => undefined),
                    awaitEmbeds: () => Promise.resolve(),
                } as unknown as EmbeddedLore;
                const wedgeBorrow = async () => ({ lore: wedgeLore, release: () => undefined });

                const res = runVerbatimStore({ workspace: 'ws-f', source: 'session:f', topic: 'wedge-regression',
                    timestamp: '2026-08-26T12:00:00.000Z', text: 'Wedge regression: this entry must survive a store call that never settles.' });
                assert.equal(res.ok, true);

                // Kick the wedged pass off WITHOUT awaiting it, then make a
                // concurrent shutdown-shaped call (its own short deadline):
                // it must wait bounded and report the entry still queued —
                // the old code returned INSTANTLY here (silent no-op), which
                // is exactly how the daemon's shutdown flush logged
                // "0 landed, N unflushed" without ever trying.
                const wedgedPass = flushVerbatimQueue({ borrow: wedgeBorrow, deadlineMs: 2_000 });
                const tC0 = Date.now();
                const concurrent = await flushVerbatimQueue({ borrow: wedgeBorrow, deadlineMs: 1_000 });
                assert.ok(Date.now() - tC0 < 10_000, 'concurrent flush behind a wedged pass returned bounded, not instantly');
                assert.equal(concurrent.flushed, 0);
                assert.equal(concurrent.remaining, 1, `concurrent flush honestly reports the queued entry; got ${JSON.stringify(concurrent)}`);
                const tW = Date.now();
                const fl = await wedgedPass;
                assert.ok(Date.now() - tW < 15_000, 'wedged pass itself returned bounded');

                // The queue must NOT stay wedged: a healthy flush afterwards
                // lands the same entry (idempotent re-upsert by deterministic
                // id, so even a late-settling first write is safe).
                const fl2 = await flushVerbatimQueue({ borrow, deadlineMs: 30_000 });
                assert.equal(fl2.flushed, 1, `healthy flush after a wedged pass lands the entry; got ${JSON.stringify(fl2)}`);
                assert.equal(fl2.remaining, 0);

                const rF = await runVerbatimRecall(lore, { workspace: 'ws-f', topic: 'wedge regression entry must survive', limit: 10 });
                assert.ok(rF.hits.some((h) => h.id === res.id), `recovered entry recallable; got ${JSON.stringify(rF.hits.map((h) => h.id))}`);
                console.log('  ✓ CLAIM F: a never-settling store step no longer wedges the queue (bounded requeue, then recovery)');
            } finally {
                await lore.close();
            }
        }

        // ── CLAIM G (durability) — the write-ahead journal closes the
        //    shutdown-loss gap WITHOUT touching the bounded-flush liveness
        //    fix from CLAIM F: the journal's I/O is synchronous local disk,
        //    never inside the flush's bounded-step machinery.
        //
        //    Fresh-process simulation: a true child process isn't feasible
        //    here (the in-process scratch EmbeddedLore IS the store the
        //    recovered entries must land in), so the "crash" is the module
        //    reset — the in-memory queue is exactly what dies with a
        //    process — followed by replayVerbatimJournal(), the SAME
        //    function daemon.ts runs at startup before binding the MCP
        //    server. The live SIGKILL drill against the real daemon (see the
        //    commit message) covers the true fresh-process end of the proof.
        {
            // Claim-private journal + fresh-process state: reset clears the
            // in-memory queue and the cached journal path, so resolution
            // re-runs against this claim's scratch home.
            const gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verbatim-g-journal-'));
            cleanup.push(() => fs.rmSync(gHome, { recursive: true, force: true }));
            const gJournal = path.join(gHome, 'verbatim-queue.jsonl');
            _setVerbatimJournalPathForTests(gJournal);
            _resetVerbatimQueueForTest();
            const { lore, dir, borrow } = await openScratch('g');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            try {
                // (a) write-ahead: the entry is on disk the moment enqueue
                // returns — BEFORE any flush has run.
                const textG = 'Crash durability drill: this quoted line must sit in the on-disk journal before any flush runs.';
                const res = runVerbatimStore({ workspace: 'ws-g', text: textG, source: 'session:g', topic: 'crash-durability', timestamp: '2026-08-26T13:00:00.000Z' });
                const linesA = fs.readFileSync(gJournal, 'utf8').split('\n').filter((l) => l !== '');
                assert.equal(linesA.length, 1, `journal holds exactly the enqueued entry pre-flush; got ${linesA.length} lines`);
                const entryA = JSON.parse(linesA[0]!) as { workspace: string; node: { id: string } };
                assert.equal(entryA.workspace, 'ws-g');
                assert.equal(entryA.node.id, res.id, 'journaled node id matches the returned id');
                assert.ok(!fs.existsSync(`${gJournal}.tmp-${process.pid}`), 'no compaction temp file left behind');

                // (b) hard crash: NO flush, NO shutdown — memory simply
                // dies. Fresh-process state + the daemon's own startup
                // replay must recover the entry, and a later flush must
                // land it and make it recallable.
                _resetVerbatimQueueForTest();
                const rep = replayVerbatimJournal();
                assert.equal(rep.replayed, 1, `replay recovers the crashed entry; got ${JSON.stringify(rep)}`);
                assert.equal(rep.malformed, 0);
                const fl = await flushVerbatimQueue({ borrow });
                assert.equal(fl.flushed, 1, `post-crash flush lands the recovered entry; got ${JSON.stringify(fl)}`);
                assert.equal(fl.remaining, 0);
                const rG = await runVerbatimRecall(lore, { workspace: 'ws-g', topic: 'crash durability quoted line journal', limit: 10 });
                assert.ok(rG.hits.some((h) => h.id === res.id), `recovered entry recallable after crash+replay+flush; got ${JSON.stringify(rG.hits.map((h) => h.id))}`);
                assert.equal(fs.readFileSync(gJournal, 'utf8').trim(), '', 'landed entry compacted out of the journal');

                // (c) bounded: the journal must not grow across many
                // store+flush cycles (every landed pass compacts).
                for (let i = 0; i < 12; i++) {
                    runVerbatimStore({ workspace: 'ws-g', source: `session:g-cycle-${i}`, topic: 'journal-growth',
                        timestamp: `2026-08-26T14:${String(i).padStart(2, '0')}:00.000Z`,
                        text: `Journal growth probe ${i}: unique cycle text about verbatim queue durability, iteration ${i}.` });
                    const flc = await flushVerbatimQueue({ borrow });
                    assert.equal(flc.remaining, 0, `cycle ${i} flushed clean; got ${JSON.stringify(flc)}`);
                }
                assert.equal(fs.readFileSync(gJournal, 'utf8').trim(), '', 'journal stays empty across 12 store+flush cycles');

                // (d) a damaged journal must not block startup: malformed
                // lines are skipped (and logged), valid lines still load,
                // land, and become recallable.
                const textD = 'Malformed journal sibling: the one valid line among junk must still load at replay.';
                const nodeD = buildVerbatimNode({ workspace: 'ws-g', text: textD, source: 'session:g-d', timestamp: '2026-08-26T15:00:00.000Z' });
                fs.writeFileSync(gJournal, [
                    '{ this line is not json',
                    JSON.stringify({ workspace: 'ws-g', node: nodeD }),
                    JSON.stringify({ workspace: 'ws-g', node: { id: 'verbatim:partial' } }), // node missing type/label — shape-gated
                    '',
                ].join('\n') + '\n');
                _resetVerbatimQueueForTest();
                const rep2 = replayVerbatimJournal();
                assert.equal(rep2.replayed, 1, `only the valid line loads; got ${JSON.stringify(rep2)}`);
                assert.equal(rep2.malformed, 2, 'both junk lines are skipped');
                const fl3 = await flushVerbatimQueue({ borrow });
                assert.equal(fl3.flushed, 1, `the valid sibling lands; got ${JSON.stringify(fl3)}`);
                const rD = await runVerbatimRecall(lore, { workspace: 'ws-g', topic: 'malformed journal valid line load', limit: 10 });
                assert.ok(rD.hits.some((h) => h.id === nodeD.id), `valid sibling recallable; got ${JSON.stringify(rD.hits.map((h) => h.id))}`);
                assert.equal(fs.readFileSync(gJournal, 'utf8').trim(), '', 'the flush compacted the junk lines away');
                console.log('  ✓ CLAIM G: write-ahead journal survives a simulated hard kill, compacts landed entries, and skips malformed lines');
            } finally {
                // Back to the file-wide scratch journal, fresh-process state.
                _setVerbatimJournalPathForTests(path.join(journalHome, 'verbatim-queue.jsonl'));
                _resetVerbatimQueueForTest();
                await lore.close();
            }
        }


        // ── CLAIM H (search visibility) — a landed batch fires the bounded,
        //    rate-limited index fold at the RIGHT cadence: not every pass,
        //    never zero. Lore only folds newly-written rows into the
        //    FTS/vector indices during a maintenance/optimize pass (the
        //    daemon's 20-min ticker, or a fresh process); the queue now arms
        //    the SAME runMaintenance surface after each landed batch, gated
        //    by two boundaries — every VERBATIM_FOLD_EVERY_BATCHES landed
        //    batches or every VERBATIM_FOLD_MIN_INTERVAL_MS, whichever fires
        //    first — with at most ONE fold in flight. The fold is fully
        //    detached: a parked (or stalled) fold must never delay a flush.
        {
            const hHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verbatim-h-journal-'));
            cleanup.push(() => fs.rmSync(hHome, { recursive: true, force: true }));
            _setVerbatimJournalPathForTests(path.join(hHome, 'verbatim-queue.jsonl'));
            _resetVerbatimQueueForTest();

            // Deterministic clock: pinned inside one "instant", then
            // advanced by exactly the min interval to prove the time
            // boundary. Real Date.now() could drift past the interval
            // mid-test and fire the time branch spuriously.
            let fakeNow = 1_800_000_000_000;
            _setVerbatimFoldClockForTests(() => fakeNow);

            // Spy lore: counts runMaintenance calls and holds each open
            // until released — the trigger must never await the fold, so
            // flushes must keep landing while one is parked.
            let folds = 0;
            let releaseFold: (() => void) | null = null;
            const spyLore = {
                bulkStoreNodes: async (nodes: Array<{ id: string }>) => ({
                    ok: true, count: nodes.length, succeeded: nodes.length,
                    results: nodes.map((n) => ({ ok: true as const, id: n.id })),
                }),
                awaitEmbeds: async () => undefined,
                runMaintenance: () => {
                    folds += 1;
                    // Executor form on purpose: the runtime is Node 20,
                    // which lacks Promise.withResolvers (same note as
                    // stepBounded in verbatimQueue.ts).
                    return new Promise<void>((resolve) => { releaseFold = resolve; });
                },
            } as unknown as EmbeddedLore;
            const spyBorrow = async () => ({ lore: spyLore, release: () => undefined });

            const until = async (cond: () => boolean, what: string, ms = 5_000): Promise<void> => {
                const t0 = Date.now();
                while (!cond()) {
                    if (Date.now() - t0 > ms) throw new Error(`CLAIM H: timed out waiting for ${what}`);
                    await new Promise((r) => setImmediate(r));
                }
            };
            // One store + one flush = exactly one landed batch.
            const landOne = async (i: number): Promise<void> => {
                const res = runVerbatimStore({ workspace: 'ws-h', source: `session:h-${i}`, topic: 'fold-rate',
                    timestamp: `2026-08-27T09:${String(i).padStart(2, '0')}:00.000Z`,
                    text: `Fold cadence probe ${i}: unique text so every store lands as its own verbatim batch.` });
                assert.equal(res.ok, true);
                const fl = await flushVerbatimQueue({ borrow: spyBorrow, deadlineMs: 10_000 });
                assert.equal(fl.flushed, 1, `CLAIM H probe ${i} landed; got ${JSON.stringify(fl)}`);
                assert.equal(fl.remaining, 0);
            };

            try {
                // (a) the FIRST landed batch of a process is time-due
                // (lastFoldAt starts at 0) — one quote between long idle
                // gaps must not sit out a timer to become searchable.
                await landOne(0);
                await until(() => folds === 1, 'first-batch fold to fire');
                releaseFold!();
                await until(() => !_verbatimFoldForTests().inFlight, 'first fold to settle');

                // (b) count boundary, clock pinned (time can never be due):
                // the next 4 landed batches must NOT fold, the 5th MUST.
                for (let i = 1; i <= 4; i++) {
                    await landOne(i);
                    assert.equal(folds, 1, `CLAIM H: probe ${i} must not fold yet (${i} < ${VERBATIM_FOLD_EVERY_BATCHES} batches)`);
                }
                await landOne(5);
                await until(() => folds === 2, `${VERBATIM_FOLD_EVERY_BATCHES}th-batch fold to fire`);
                releaseFold!();
                await until(() => !_verbatimFoldForTests().inFlight, 'count-boundary fold to settle');

                // (c) time boundary: clock advanced by exactly the min
                // interval with only ONE batch since the last fold — the
                // next landed batch folds on time, not on count.
                fakeNow += VERBATIM_FOLD_MIN_INTERVAL_MS;
                await landOne(6);
                await until(() => folds === 3, 'time-boundary fold to fire');

                // (d) in-flight suppression + pass liveness: fold 3 stays
                // PARKED. Six more landed batches (past the count boundary)
                // and another full interval on the clock must not start a
                // second fold — and every flush must still land promptly,
                // proving the fold is never in the pass's await chain.
                fakeNow += VERBATIM_FOLD_MIN_INTERVAL_MS;
                const tSup = Date.now();
                for (let i = 7; i <= 12; i++) {
                    await landOne(i);
                    assert.equal(folds, 3, `CLAIM H: parked fold suppresses a new fold at probe ${i}`);
                }
                assert.ok(Date.now() - tSup < 5_000, 'six flushes land promptly while a fold is parked');
                releaseFold!();
                await until(() => !_verbatimFoldForTests().inFlight, 'parked fold to settle');

                // (e) suppressed batches are not lost: their counter kept
                // climbing through (d), so the very next landed batch folds.
                await landOne(13);
                await until(() => folds === 4, 'post-suppression fold to fire');
                releaseFold!();
                await until(() => !_verbatimFoldForTests().inFlight, 'final fold to settle');

                assert.equal(_verbatimFoldForTests().batchesSinceFold, 0, 'probe 13’s counter was consumed by the post-suppression fold');
                // 14 landed batches → 4 folds: never on every pass, never zero.
                console.log(`  ✓ CLAIM H: index fold fires on schedule — 4 folds across 14 landed batches (first-batch, every ${VERBATIM_FOLD_EVERY_BATCHES}th, ${VERBATIM_FOLD_MIN_INTERVAL_MS / 1000}s time bound), suppressed while in flight, never blocking a flush`);
            } finally {
                _setVerbatimFoldClockForTests(null);
                // Back to the file-wide scratch journal, fresh-process state.
                _setVerbatimJournalPathForTests(path.join(journalHome, 'verbatim-queue.jsonl'));
                _resetVerbatimQueueForTest();
            }
        }

        // ── CLAIM I (regression, content-sized batching) — batches are
        //    bounded by estimated embed-chunk WORK, not raw node count.
        //    Live incident shape (2026-08 llm-api-gateway): five ~25k-char
        //    notes = ~120 e5 chunks in ONE bulkStoreNodes call, which blew
        //    the 10s step budget every 30s tick, requeued at the front, and
        //    broke the whole pass — starving every other workspace. Here a
        //    counting borrow records every store call; the assertions are on
        //    the ACTUAL nodes handed to the store, re-estimated through the
        //    same exported estimator the batching uses.
        {
            const iHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verbatim-i-journal-'));
            cleanup.push(() => fs.rmSync(iHome, { recursive: true, force: true }));
            _setVerbatimJournalPathForTests(path.join(iHome, 'verbatim-queue.jsonl'));
            _resetVerbatimQueueForTest();
            const { lore, dir, borrow } = await openScratch('i');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            // Counting lore: real store, but records each bulkStoreNodes
            // call's node count and summed chunk estimate (prototype
            // delegation keeps getNode/awaitEmbeds real). runMaintenance is
            // stubbed OUT: this claim fires real folds (~200 vectors land)
            // and a live LanceDB compaction racing lore.close() in the
            // finally wedged the process natively once — the fold cadence is
            // CLAIM H's job, not this claim's; keeping it real here buys
            // nothing and costs the flake.
            const calls: Array<{ nodes: number; chunks: number }> = [];
            const realStore = lore.bulkStoreNodes.bind(lore);
            const countingLore = Object.create(lore);
            countingLore.runMaintenance = async () => ({ folded: 0 });
            countingLore.bulkStoreNodes = (nodes: Parameters<typeof lore.bulkStoreNodes>[0]) => {
                calls.push({
                    nodes: nodes.length,
                    chunks: nodes.reduce((s, n) => s + estimateEmbedChunks(n), 0),
                });
                return realStore(nodes);
            };
            const countingBorrow = async () => ({ lore: countingLore, release: () => undefined });
            try {
                // Medium note: ~33k chars ≈ 32 chunks — at the budget, so
                // any two of them (64) blow it and each must travel alone.
                // (Under the OLD count-only batching these four would have
                // shared one batch of 5 with a small — ~130 chunks in one
                // store call, the incident shape.)
                const medium = (i: number) => `Medium note ${i}: ` + 'kuzu embedded graph durability probe. '.repeat(900);
                // Small note: well under one chunk — these must still GROUP.
                const small = (i: number) => `Small note ${i}: cheap interactive-sized verbatim text.`;

                for (let i = 0; i < 4; i++) {
                    assert.equal(runVerbatimStore({ workspace: 'ws-i', source: `session:i-m${i}`, topic: 'batch-sizing',
                        timestamp: `2026-08-29T09:${String(i).padStart(2, '0')}:00.000Z`, text: medium(i) }).ok, true);
                }
                for (let i = 0; i < 3; i++) {
                    assert.equal(runVerbatimStore({ workspace: 'ws-i', source: `session:i-s${i}`, topic: 'batch-sizing',
                        timestamp: `2026-08-29T09:${String(10 + i).padStart(2, '0')}:00.000Z`, text: small(i) }).ok, true);
                }
                // Oversized note, enqueued DIRECTLY (the tool path caps text
                // at VERBATIM_TEXT_CAP = 32KB ≈ exactly the chunk budget, so
                // a >budget note can only arrive here): ~34.5k chars ≈ 33
                // chunks — over the budget ALONE (solo batch by the first-
                // entry-unconditional rule), yet still inside the 10s embed
                // step (~7.5s measured on the reference machine; a 40-chunk
                // note genuinely exceeds it — that path is the breaker's job).
                // as a SOLO batch, never skipped and never split.
                const bigNode: StoreNodeInput = {
                    id: 'verbatim:0123456789ab',
                    type: 'note',
                    label: 'Oversized synthetic note: exceeds the batch chunk budget on its own',
                    content: 'Oversized solo note body. ' + 'lancedb vector search recall probe. '.repeat(960),
                    tags: 'verbatim,topic:batch-sizing',
                    workspace: 'ws-i',
                    embed: true,
                };
                enqueueVerbatim('ws-i', bigNode);

                const tI = Date.now();
                const fl = await flushVerbatimQueue({ borrow: countingBorrow, deadlineMs: 120_000 });
                assert.ok(Date.now() - tI < 120_000, 'oversized-content flush returns bounded');
                assert.equal(fl.flushed, 8, `all 8 entries (4 medium, 3 small, 1 oversized) landed in ONE pass; got ${JSON.stringify(fl)}`);
                assert.equal(fl.remaining, 0);
                assert.equal(fl.batches, calls.length, `result.batches matches observed store calls (${calls.length}); got ${JSON.stringify(calls)}`);
                assert.ok(calls.length >= 6, `content-sized batching split the work across ${calls.length} calls, not one giant batch`);

                // THE invariant: every store call fits the chunk budget,
                // unless it is a single oversized note travelling solo.
                for (const c of calls) {
                    assert.ok(
                        c.chunks <= VERBATIM_BATCH_CHUNK_BUDGET || c.nodes === 1,
                        `store call of ${c.chunks} chunks / ${c.nodes} nodes fits the ${VERBATIM_BATCH_CHUNK_BUDGET}-chunk budget or is solo; got ${JSON.stringify(calls)}`,
                    );
                }
                // Cheap notes still group (guards a degenerate all-solo
                // implementation) and the oversized note got its solo batch.
                assert.ok(calls.some((c) => c.nodes > 1 && c.chunks <= VERBATIM_BATCH_CHUNK_BUDGET),
                    `the three small notes shared a batch; got ${JSON.stringify(calls)}`);
                assert.ok(calls.some((c) => c.nodes === 1 && c.chunks > VERBATIM_BATCH_CHUNK_BUDGET),
                    `the oversized note travelled as its own solo batch; got ${JSON.stringify(calls)}`);
                // Never skipped: the oversized note is really in the store.
                assert.ok(await lore.getNode(bigNode.id) != null, 'oversized solo note landed and is retrievable');
                console.log(`  ✓ CLAIM I: content-sized batching — ${calls.length} store calls (budget ${VERBATIM_BATCH_CHUNK_BUDGET} chunks), small notes grouped, oversized note solo, all 8 landed in one bounded pass`);
            } finally {
                // Back to the file-wide scratch journal, fresh-process state.
                _setVerbatimJournalPathForTests(path.join(journalHome, 'verbatim-queue.jsonl'));
                _resetVerbatimQueueForTest();
                await lore.close();
            }
        }

        // ── CLAIM J (regression, rotate-not-break) — one workspace's
        //    failing batch must not block a DIFFERENT workspace. The old
        //    pass requeued the failure at the FRONT and broke out — with the
        //    failing workspace at the head, everything behind it starved
        //    forever (the incident's cross-workspace blast radius). Here
        //    ws-fail's store never settles (the CLAIM F wedge shape) and it
        //    is enqueued FIRST; ws-ok's entries sit BEHIND it in FIFO order
        //    and must still drain in the same pass. A second pass then
        //    proves the retry-path existence pre-check runs (getNode on the
        //    requeued entry) and the failure streak surfaces through the
        //    workspace_status health shape.
        {
            const jHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verbatim-j-journal-'));
            cleanup.push(() => fs.rmSync(jHome, { recursive: true, force: true }));
            _setVerbatimJournalPathForTests(path.join(jHome, 'verbatim-queue.jsonl'));
            _resetVerbatimQueueForTest();
            const { lore, dir, borrow } = await openScratch('j');
            cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            let failGetNodeCalls = 0;
            const failLore = {
                bulkStoreNodes: () => new Promise<never>(() => undefined),
                awaitEmbeds: () => Promise.resolve(),
                getNode: async () => {
                    failGetNodeCalls += 1;
                    return null;
                },
            } as unknown as EmbeddedLore;
            // ws-ok's lore: real store, but runMaintenance stubbed out — the
            // post-landing detached fold must not put a live LanceDB
            // compaction between this claim and its lore.close() (see the
            // CLAIM I note; fold cadence is CLAIM H's job).
            const okLore = Object.create(lore);
            okLore.runMaintenance = async () => ({ folded: 0 });
            const routingBorrow = async (workspace: string) =>
                workspace === 'ws-fail'
                    ? { lore: failLore, release: () => undefined }
                    : { lore: okLore, release: () => undefined };
            try {
                const sFail = runVerbatimStore({ workspace: 'ws-fail', source: 'session:j-fail', topic: 'rotate-regression',
                    timestamp: '2026-08-29T10:00:00.000Z', text: 'Rotate regression: this workspace store never settles; a different workspace must still drain.' });
                const ok1 = runVerbatimStore({ workspace: 'ws-ok', source: 'session:j-ok1', topic: 'rotate-regression',
                    timestamp: '2026-08-29T10:01:00.000Z', text: 'Healthy sibling one: must land in the SAME pass as the failing workspace ahead of it.' });
                const ok2 = runVerbatimStore({ workspace: 'ws-ok', source: 'session:j-ok2', topic: 'rotate-regression',
                    timestamp: '2026-08-29T10:02:00.000Z', text: 'Healthy sibling two: same pass, FIFO order behind the poison head.' });

                // Budget: one 10s wedged step for ws-fail, then the healthy
                // drain. The wedge is what the old code broke the pass on.
                const tJ = Date.now();
                const fl = await flushVerbatimQueue({ borrow: routingBorrow, deadlineMs: 30_000 });
                assert.ok(Date.now() - tJ < 30_000, 'rotate pass returned bounded');
                assert.equal(fl.flushed, 2, `ws-ok drained BEHIND the failing ws-fail head in the same pass; got ${JSON.stringify(fl)}`);
                assert.equal(fl.remaining, 1, `only the failing workspace's entry stays queued; got ${JSON.stringify(fl)}`);
                assert.ok(await lore.getNode(ok1.id) != null, 'ws-ok entry one really landed');
                assert.ok(await lore.getNode(ok2.id) != null, 'ws-ok entry two really landed');

                // Health surface (workspace_status shape): the failure is
                // visible WITHOUT raw logs — streak 1, breaker not yet open.
                const hFail = verbatimQueueHealth('ws-fail');
                assert.equal(hFail.pendingEntries, 1);
                assert.equal(hFail.consecutiveFlushFailures, 1);
                assert.equal(hFail.quarantined, false, 'one strike must not open the breaker');
                assert.ok(typeof hFail.oldestQueuedAgeMs === 'number', 'oldest queued entry age is surfaced');
                const hOk = verbatimQueueHealth('ws-ok');
                assert.equal(hOk.pendingEntries, 0);
                assert.equal(hOk.consecutiveFlushFailures, 0);

                // Second pass: the requeued ws-fail entry goes through the
                // retry-path existence pre-check (streak > 0 → getNode per
                // id) before wedging again — strike two, still bounded,
                // still not blocking anything else (queue holds nothing
                // else now).
                const fl2 = await flushVerbatimQueue({ borrow: routingBorrow, deadlineMs: 15_000 });
                assert.equal(fl2.flushed, 0);
                assert.equal(fl2.remaining, 1, `ws-fail entry honestly requeued; got ${JSON.stringify(fl2)}`);
                assert.equal(failGetNodeCalls, 1, `retry-path pre-check looked the requeued entry up exactly once; got ${failGetNodeCalls}`);
                assert.equal(verbatimQueueHealth('ws-fail').consecutiveFlushFailures, 2, 'second strike recorded');
                console.log('  ✓ CLAIM J: a failing workspace no longer blocks a different workspace — ws-ok drained behind the poison head, streak/pre-check surfaced via health');
            } finally {
                // Back to the file-wide scratch journal, fresh-process state.
                _setVerbatimJournalPathForTests(path.join(journalHome, 'verbatim-queue.jsonl'));
                _resetVerbatimQueueForTest();
                await lore.close();
            }
        }

        console.log('All verbatim memory tool tests passed.');
    } finally {
        _setVerbatimJournalPathForTests(null);
        _resetVerbatimQueueForTest();
        for (const fn of cleanup) fn();
    }
}

await main();
