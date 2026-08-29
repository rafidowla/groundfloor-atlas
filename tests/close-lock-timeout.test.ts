/**
 * tests/close-lock-timeout.test.ts — shutdown-wedge regression for
 * EmbeddedLore.close() vs the maintenance lock.
 *
 * The lock is a promise-chain mutex released only when the holder's own
 * promise settles. A holder's native call (LanceDB optimize() in a detached
 * post-flush fold, or any write path's kuzu/lancedb op) can wedge
 * indefinitely — tests/verbatim.test.ts's CLAIM I comments record a live
 * LanceDB compaction racing lore.close() wedging the process natively ONCE
 * during test development. close() used to await the lock with NO bound, so
 * one wedged holder hung all of daemon shutdown (closeAllEmbedded has no
 * deadline around close()).
 *
 * Reproduces the wedge deterministically against a REAL EmbeddedLore
 * instance: the underlying lore.nodeUpsert is patched to a controllable
 * deferred, so storeNode genuinely holds the real maintenance lock and we
 * decide when (whether) it frees — no real compaction needed, no stubbing of
 * runMaintenance (which would bypass the very lock under test).
 *
 * Asserts:
 *   CLAIM 1 — close(lockTimeoutMs) RETURNS promptly while the lock is wedged
 *             (the fix: bounded acquire, skip clean dispose on timeout).
 *   CLAIM 2 — the timeout path NEVER calls dispose (no native teardown
 *             mid-write — that is the RD-F13 corruption interleave).
 *   CLAIM 3 — the timeout path logs a greppable CRITICAL line naming the
 *             abandoned workspace.
 *   CLAIM 4 — mutex invariant survives the timeout: a write enqueued AFTER
 *             the abandoned close still cannot start until the wedged holder
 *             releases (the timed-out slot chains its release through the
 *             holder it abandoned — no eager release, no back-door
 *             RD-F13 interleave).
 *   CLAIM 5 — control: with the lock free, close() disposes cleanly and
 *             logs nothing CRITICAL (normal path unchanged).
 *
 * REAL-TIMER EXCEPTION: the acquire bound under test is enforced by a real
 * setTimeout inside the production lock, and CLAIM 4's negative half ("the
 * queued write does NOT start while wedged") is inherently a wall-clock
 * observation — fake timers would freeze the mechanism being tested. The
 * harness is plain tsx (no bun:test), so deterministic time control is not
 * available here; every other wait awaits a real promise/signal, not a
 * guessed duration. Deferreds use the executor form, NOT
 * Promise.withResolvers — the daemon's pinned Node 20 runtime lacks it
 * (same note as src/mcp/verbatimQueue.ts:430).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import type { StoreNodeInput } from '../src/loreClient.js';

/** Real-timer sleep — allowed exception, see header. Matches the convention
 *  in tests/maintenance-overlap-guard.test.ts for the same reason. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capture console.error lines (close()'s loud warning goes to stderr). */
function captureStderr(): { lines: string[]; restore(): void } {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = original; } };
}

async function main(): Promise<void> {
    console.log('close() maintenance-lock timeout tests');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-close-lock-test-'));
    const lore = await EmbeddedLore.open(dataDir);
    await lore.connect();
    // Underlying LoreInstance — private at the type level, reachable at
    // runtime; named const (not inline member access) so the one unchecked
    // shape claim is visible exactly here.
    const inner = (lore as unknown as {
        lore: {
            nodeUpsert: (input: unknown) => Promise<unknown>;
            dispose: (reason: string) => Promise<void>;
        };
    }).lore;

    try {
        // ── setup: nodeUpsert call #1 never settles until we say so; every
        //    later call settles immediately. dispose is spied, not skipped.
        let calls = 0;
        let releaseWedged: (() => void) | null = null;
        let wedgedEntered: (() => void) | null = null;
        inner.nodeUpsert = (_input: unknown) => {
            calls++;
            if (calls === 1) {
                return new Promise((res) => {
                    releaseWedged = () => res({ ok: true });
                    wedgedEntered!();
                });
            }
            return Promise.resolve({ ok: true });
        };
        let disposeCalls = 0;
        const origDispose = inner.dispose.bind(inner);
        inner.dispose = (reason: string) => { disposeCalls++; return origDispose(reason); };
        const entered = new Promise<void>((res) => { wedgedEntered = res; });

        // Hold the REAL maintenance lock with a native write that wedges.
        const wedgedWrite = lore.storeNode({
            id: 'wedge:1', type: 'decision', workspace: 'closelocktest',
            embed: false, label: 'wedge:1',
        } as StoreNodeInput);
        await entered; // real signal: the patched nodeUpsert is INSIDE the lock
        assert.equal(calls, 1, 'the patched write must be the one and only lock holder so far');

        // ── CLAIM 1 — close() returns despite the wedged holder ──
        const cap = captureStderr();
        const t0 = Date.now();
        await lore.close(60); // 60ms acquire bound — must not wait for the wedge
        const elapsed = Date.now() - t0;
        cap.restore();
        assert.ok(elapsed < 2000, `close() must resolve promptly past its bound, not hang on the wedged lock (took ${elapsed}ms)`);
        console.log(`  ✓ CLAIM 1: close() returned in ${elapsed}ms with the lock wedged (bound was 60ms)`);

        // ── CLAIM 2 — timeout path never disposes ──
        assert.equal(disposeCalls, 0, 'timeout path must NOT call dispose — native teardown mid-write is the RD-F13 corruption interleave');
        console.log('  ✓ CLAIM 2: dispose not called on the timeout path');

        // ── CLAIM 3 — loud, greppable CRITICAL log naming the workspace ──
        const loud = cap.lines.filter((l) => l.includes('CRITICAL'));
        assert.ok(loud[0].includes(path.basename(dataDir)), 'the CRITICAL line names the abandoned workspace (dataDir basename — one EmbeddedLore = one workspace)');
        console.log('  ✓ CLAIM 3: CRITICAL log emitted naming the workspace');

        // ── CLAIM 4 — mutex invariant survives the abandoned close ──
        const queued = lore.storeNode({
            id: 'wedge:2', type: 'decision', workspace: 'closelocktest',
            embed: false, label: 'wedge:2',
        } as StoreNodeInput);
        // Negative half needs a real observation window (header exception):
        // if the abandoned close had released its slot EAGERLY, the queued
        // write would enter the lock within a macrotask or two.
        await sleep(300);
        assert.equal(calls, 1, 'a write enqueued after the timed-out close must NOT run while the wedged holder still holds the lock');
        assert.ok(typeof releaseWedged === 'function', 'wedge gate armed');
        releaseWedged!();
        await queued; // real signal: queued only settles after it entered + left the lock
        assert.equal(calls, 2, 'once the wedged holder settles, the queued write proceeds (chained slot released in order)');
        await Promise.allSettled([wedgedWrite]);
        console.log('  ✓ CLAIM 4: post-timeout writes still serialize behind the wedged holder');

        // ── CLAIM 5 — control: lock free → close() disposes cleanly ──
        const cap2 = captureStderr();
        await lore.close(5_000);
        cap2.restore();
        assert.equal(disposeCalls, 1, 'clean path must call dispose exactly once');
        assert.ok(!cap2.lines.some((l) => l.includes('CRITICAL')), `clean close must not log CRITICAL; got ${JSON.stringify(cap2.lines)}`);
        console.log('  ✓ CLAIM 5: lock-free close() disposed cleanly, no CRITICAL log');
    } finally {
        // Best-effort: if an assertion threw mid-scenario the lock may still
        // be wedged — the tiny bound means this close can never hang the run.
        await lore.close(50).catch(() => undefined);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    console.log('All close() maintenance-lock timeout tests passed.');
}

await main();
