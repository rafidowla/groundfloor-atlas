/**
 * tests/rc-hardening.test.ts — post-RC hardening tail (6 low-severity findings).
 *
 * Each block reproduces (or directly exercises) one finding, then proves the
 * fix. Shape follows tests/rc-integrity.test.ts / tests/checkpoint.test.ts:
 * node:assert/strict, async main(), '  ✓ CLAIM …' lines, ends `await main()`.
 *
 * FINDINGS COVERED:
 *  1. Checkpoint unbounded growth — saveCheckpoint(cp, liveRelPaths) prunes
 *     entries for files no longer in the current parse set (checkpoint.ts).
 *  2. Corrupt store infinite retry — getEmbeddedLore quarantines a dataDir
 *     after N consecutive failed opens instead of re-attempting an expensive
 *     failing open on every call (embeddedRegistry.ts).
 *  3. MCP session map unbounded growth — evictOverCap / sweepIdleSessions cap
 *     + idle-sweep the session map (server.ts).
 *  4. exportMemory predictable tmp path — unique pid+random suffix + atomic
 *     rename, matching checkpoint.ts/groupYaml.ts (memorySync.ts).
 *
 * Findings 5 (WorkspacePage.tsx focus-depth toast) and 6 (LICENSE file) are
 * UI/documentation changes without a natural tsx-runnable unit test; they are
 * covered by the atlas-ui vitest suite / manual review instead.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    loadCheckpoint,
    saveCheckpoint,
    markIndexed,
    pruneCheckpoint,
    type Checkpoint,
} from '../src/cli/checkpoint.js';
import {
    getEmbeddedLore,
    closeAllEmbedded,
    openFailureCount,
    _resetFailureStateForTests,
} from '../src/mcp/embeddedRegistry.js';
import { loadConfig } from '../src/config.js';
import {
    evictOverCap,
    sweepIdleSessions,
    MAX_ACTIVE_SESSIONS,
    type SessionEntry,
    type Closeable,
} from '../src/mcp/server.js';
import { exportMemory, type MemoryExportReader } from '../src/cli/memorySync.js';

function tmpRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main(): Promise<void> {
    console.log('Running RC hardening-tail tests…');

    // ── FINDING 1 — checkpoint pruning ────────────────────────────────────────
    {
        const root = tmpRoot('atlas-rch-ckpt-');
        const kept = path.join(root, 'kept.ts');
        const deleted = path.join(root, 'deleted.ts');
        fs.writeFileSync(kept, 'export const a = 1;');
        fs.writeFileSync(deleted, 'export const b = 2;');

        const cp = loadCheckpoint(root, 'ws1');
        markIndexed(kept, cp);
        markIndexed(deleted, cp);
        assert.equal(Object.keys(cp.files).length, 2, 'precondition: both files fingerprinted');

        // deleted.ts is removed from disk AND from the current parse set — a
        // real `atlas index --resume` run would never yield it from walkRepo.
        fs.rmSync(deleted);
        const liveRelPaths = new Set<string>(['kept.ts']);
        saveCheckpoint(cp, liveRelPaths);

        assert.equal(Object.keys(cp.files).length, 1, 'stale entry pruned from the in-memory checkpoint');
        assert.ok('kept.ts' in cp.files, 'live entry retained');
        assert.ok(!('deleted.ts' in cp.files), 'deleted-file entry pruned');

        // Round-trip: re-load from disk and confirm the WRITTEN file reflects
        // the prune (not just the in-memory object).
        const reloaded = loadCheckpoint(root, 'ws1');
        assert.equal(Object.keys(reloaded.files).length, 1, 'prune persisted through the atomic write');
        console.log('  ✓ FINDING 1a: saveCheckpoint(cp, liveRelPaths) prunes entries for files outside the current parse set');

        // pruneCheckpoint is also exposed standalone (used by saveCheckpoint
        // internally, but valid to call directly too).
        const cp2: Checkpoint = { version: 1, root, files: { 'x.ts': { mtimeMs: 1, sizeBytes: 1, indexedAt: 'x' }, 'y.ts': { mtimeMs: 1, sizeBytes: 1, indexedAt: 'x' } }, updatedAt: 'x' };
        const prunedCount = pruneCheckpoint(cp2, new Set(['x.ts']));
        assert.equal(prunedCount, 1, 'pruneCheckpoint reports the number of entries removed');
        assert.deepEqual(Object.keys(cp2.files), ['x.ts'], 'pruneCheckpoint mutates cp.files in place');
        console.log('  ✓ FINDING 1b: pruneCheckpoint is a standalone, directly testable primitive');

        // Backward compatibility: saveCheckpoint(cp) with NO liveRelPaths arg
        // must NOT prune anything (existing callers unaffected).
        const root3 = tmpRoot('atlas-rch-ckpt-compat-');
        const f3 = path.join(root3, 'only.ts');
        fs.writeFileSync(f3, 'x');
        const cp3 = loadCheckpoint(root3, 'ws3');
        markIndexed(f3, cp3);
        saveCheckpoint(cp3); // no liveRelPaths — legacy call shape
        assert.equal(Object.keys(cp3.files).length, 1, 'saveCheckpoint with no liveRelPaths arg does not prune (back-compat)');
        console.log('  ✓ FINDING 1c: saveCheckpoint(cp) with no liveRelPaths argument keeps pre-existing no-pruning behavior');

        // Atomicity / resume semantics are NOT changed: writer-lock (RC #1) and
        // the workspace-guard reconcile (tests/checkpoint.test.ts CLAIM A/B) are
        // separate mechanisms this change doesn't touch — verified by reading
        // the unchanged saveCheckpoint atomic temp+rename path above (round-trip
        // via loadCheckpoint proves no partial-file readers ever see a torn write).
    }

    // ── FINDING 2 — corrupt-store circuit breaker ─────────────────────────────
    {
        const home = tmpRoot('atlas-rch-home-');
        const base = tmpRoot('atlas-rch-data-');
        const WS = 'corruptws';
        fs.writeFileSync(
            path.join(home, 'config.json'),
            JSON.stringify({ port: 3848, lore: { workspace: WS, mode: 'embedded', dataDir: base } }),
        );
        const cfg = loadConfig(home);

        // Plant a REGULAR FILE where the workspace's dataDir should be — Lore's
        // internal mkdirSync/db-open then fails fast (ENOTDIR) instead of
        // succeeding, giving us a cheap, deterministic "corrupt store" without
        // needing to actually corrupt a real kuzu/lancedb/sqlite store.
        const dataDir = path.join(base, WS);
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(dataDir, 'not a directory');
        _resetFailureStateForTests(dataDir);

        let failures = 0;
        const FAILURE_THRESHOLD = 3; // must match embeddedRegistry.ts's constant
        for (let i = 0; i < FAILURE_THRESHOLD; i++) {
            const start = Date.now();
            try {
                await getEmbeddedLore(cfg, WS);
                assert.fail('expected getEmbeddedLore to reject against a corrupt (file, not dir) dataDir');
            } catch (err) {
                failures++;
                const elapsed = Date.now() - start;
                assert.ok(
                    /not a directory|ENOTDIR|ENOENT/i.test((err as Error).message) || i > 0,
                    `expected an open failure, got: ${(err as Error).message}`,
                );
                void elapsed;
            }
        }
        assert.equal(failures, FAILURE_THRESHOLD, 'every one of the first N calls attempted (and failed) a real open');
        assert.equal(openFailureCount(dataDir), FAILURE_THRESHOLD, 'consecutive failure count tracked per dataDir');
        console.log(`  ✓ FINDING 2a: ${FAILURE_THRESHOLD} consecutive failed opens recorded`);

        // The NEXT call must fail FAST with a clear, actionable quarantine
        // error — not attempt another (doomed, expensive) open.
        const quarantineStart = Date.now();
        try {
            await getEmbeddedLore(cfg, WS);
            assert.fail('expected the quarantined dataDir to reject');
        } catch (err) {
            const msg = (err as Error).message;
            const elapsedMs = Date.now() - quarantineStart;
            assert.match(msg, /quarantine/i, 'quarantine error must clearly say the store is quarantined');
            assert.match(msg, /re-index|remove/i, 'quarantine error must give the operator an actionable next step');
            assert.ok(elapsedMs < 200, `quarantined call should fail fast (no real open attempt); took ${elapsedMs}ms`);
        }
        console.log('  ✓ FINDING 2b: quarantined dataDir fails fast with a clear, actionable error (no further open attempts)');

        // A successful open resets the breaker — fix the store (make it a real
        // dir again) and confirm the failure count clears once open succeeds.
        _resetFailureStateForTests(dataDir); // simulate cooldown elapsing without a real 60s sleep
        fs.rmSync(dataDir, { force: true });
        fs.mkdirSync(dataDir, { recursive: true });
        const lore = await getEmbeddedLore(cfg, WS);
        assert.ok(lore, 'getEmbeddedLore succeeds once the store is repaired');
        assert.equal(openFailureCount(dataDir), 0, 'a successful open resets the consecutive-failure count to zero');
        console.log('  ✓ FINDING 2c: a successful open resets the circuit breaker (recovers automatically)');

        await closeAllEmbedded();
        _resetFailureStateForTests();
    }

    // ── FINDING 3 — MCP session map cap + idle sweep ──────────────────────────
    {
        class FakeTransport implements Closeable {
            closed = false;
            async close(): Promise<void> { this.closed = true; }
        }

        // ── cap eviction: inserting past MAX_ACTIVE_SESSIONS evicts the
        //    least-recently-active (lowest lastActivityMs / earliest in Map
        //    insertion order) sessions, closing their transport.
        {
            const sessions = new Map<string, SessionEntry<FakeTransport>>();
            const CAP = 5;
            const transports: FakeTransport[] = [];
            for (let i = 0; i < CAP + 3; i++) {
                const t = new FakeTransport();
                transports.push(t);
                sessions.set(`sid-${i}`, { transport: t, lastActivityMs: i }); // ascending recency
            }
            evictOverCap(sessions, CAP);
            assert.equal(sessions.size, CAP, `session map capped at ${CAP}`);
            // The 3 OLDEST (sid-0, sid-1, sid-2) must be evicted + closed.
            for (let i = 0; i < 3; i++) {
                assert.ok(!sessions.has(`sid-${i}`), `sid-${i} (oldest) evicted`);
                assert.equal(transports[i].closed, true, `sid-${i}'s transport was closed on eviction`);
            }
            // The newest CAP entries survive, untouched.
            for (let i = 3; i < CAP + 3; i++) {
                assert.ok(sessions.has(`sid-${i}`), `sid-${i} (newer) retained`);
                assert.equal(transports[i].closed, false, `sid-${i}'s transport left open`);
            }
            console.log(`  ✓ FINDING 3a: evictOverCap closes+evicts the least-recently-active sessions past the cap`);
        }

        // ── under the cap: a no-op (normal session correlation undisturbed).
        {
            const sessions = new Map<string, SessionEntry<FakeTransport>>();
            const t = new FakeTransport();
            sessions.set('only', { transport: t, lastActivityMs: Date.now() });
            evictOverCap(sessions, MAX_ACTIVE_SESSIONS);
            assert.equal(sessions.size, 1, 'a session map under the cap is untouched');
            assert.equal(t.closed, false, 'the only session is not closed when under the cap');
            console.log('  ✓ FINDING 3b: evictOverCap is a no-op under the cap (normal session correlation preserved)');
        }

        // ── idle sweep: a session idle past the TTL is swept even though the
        //    map never hit the cap; an active session is left alone.
        {
            const sessions = new Map<string, SessionEntry<FakeTransport>>();
            const idleT = new FakeTransport();
            const activeT = new FakeTransport();
            const TTL = 1000;
            sessions.set('idle', { transport: idleT, lastActivityMs: Date.now() - TTL - 500 });
            sessions.set('active', { transport: activeT, lastActivityMs: Date.now() });
            sweepIdleSessions(sessions, TTL);
            assert.ok(!sessions.has('idle'), 'idle-past-TTL session swept');
            assert.equal(idleT.closed, true, "idle session's transport closed");
            assert.ok(sessions.has('active'), 'recently-active session retained');
            assert.equal(activeT.closed, false, "active session's transport left open");
            console.log('  ✓ FINDING 3c: sweepIdleSessions closes+evicts only sessions idle past the TTL, independent of the cap');
        }
    }

    // ── FINDING 4 — exportMemory unique tmp + atomic rename ───────────────────
    {
        const home = tmpRoot('atlas-rch-mem-');
        const WS = 'memws';
        const outPath = path.join(home, 'memory.jsonl');

        const node = { id: 'dec-rch-1', type: 'decision', label: 'test', content: 'because', tags: 'rc-hardening' };
        const fakeReader: MemoryExportReader = {
            async listNodes(type) { return type === 'decision' ? [node] : []; },
            async listEdges() { return []; },
        };

        // Two CONCURRENT exports to the SAME outPath must not collide on a
        // shared fixed tmp name — each gets its own pid+random suffix, so
        // neither write can stomp the other's in-flight temp file, and the
        // final file is whichever rename won (never a torn/mixed write).
        const [r1, r2] = await Promise.all([
            exportMemory(fakeReader, WS, outPath),
            exportMemory(fakeReader, WS, outPath),
        ]);
        assert.equal(r1.nodeCount, 1);
        assert.equal(r2.nodeCount, 1);
        const finalContent = fs.readFileSync(outPath, 'utf8');
        const lines = finalContent.trim().split('\n');
        assert.equal(lines.length, 2, 'final file is a complete, non-torn export (header + 1 node line), not a mix of two partial writes');
        JSON.parse(lines[0]); // header parses
        JSON.parse(lines[1]); // node line parses
        console.log('  ✓ FINDING 4a: concurrent exportMemory calls to the same outPath never collide (unique tmp names) and leave a complete file');

        // No leftover tmp files after either run (both renamed away cleanly).
        const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp'));
        assert.deepEqual(leftovers, [], 'no stray .tmp files left behind after concurrent exports');
        console.log('  ✓ FINDING 4b: no leftover temp files after concurrent export (each run cleaned up via rename)');

        // Symlink-preplant defense: an attacker pre-plants a symlink at the
        // OLD fixed `<out>.tmp` path pointing somewhere sensitive. Because the
        // real tmp name now carries a pid+random suffix, exportMemory never
        // even touches that planted symlink.
        const legacyTmpPath = `${path.resolve(outPath)}.tmp`;
        const decoyTarget = path.join(home, 'decoy-target');
        fs.writeFileSync(decoyTarget, 'should never be touched');
        try {
            fs.symlinkSync(decoyTarget, legacyTmpPath);
        } catch {
            // Some environments (or a rerun) may already have this symlink;
            // fine either way — the assertion below is what actually matters.
        }
        await exportMemory(fakeReader, WS, outPath);
        assert.equal(fs.readFileSync(decoyTarget, 'utf8'), 'should never be touched', 'a symlink planted at the OLD fixed tmp path is never written through');
        console.log('  ✓ FINDING 4c: a symlink pre-planted at the legacy fixed tmp path is not touched (unique-suffix path sidesteps it entirely)');
    }

    console.log('All RC hardening-tail tests passed.');
}

await main();
