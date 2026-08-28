/**
 * tests/hook-enrich.test.ts — live advisory enrichment (mcp/hookEnrich.ts).
 *
 * The four claims that make per-hook embedded-Lore I/O safe:
 *   A — a REAL seeded scratch graph (index → loadContext → findSymbol →
 *       blastRadius, the same machinery atlas_blast_radius uses; no read-path
 *       stubs) yields pre-edit advice that names a genuine caller file.
 *   B — a lore lookup that HANGS loses the 700ms Promise.race: both enrich
 *       entry points return '' well under the 900ms bound (the hook client's
 *       own cap is 1500ms).
 *   C — single-flight: while one enrich is in flight, a second returns ''
 *       immediately (no queued native reads — the v1 crash mode).
 *   C2 — single-flight holds PAST the budget window: the guard is released by
 *       the WORK settling, not the 700ms race settling. A second call fired
 *       ~900ms in (budget already lost, abandoned lookup still reading) must
 *       still bounce — lookup count stays 1, max concurrency stays 1.
 *   D — a repeat call with the same cache key hits the 60s cache: the stubbed
 *       lookup runs exactly once, and the exact advice shape is pinned.
 */
process.env['ATLAS_CONTEXT_LAYER'] = '0'; // lean graph-only index (rc-correctness precedent)

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import {
    enrichPreEdit,
    enrichPreSearch,
    _setLookupForTests,
    type D1Answer,
} from '../src/mcp/hookEnrich.js';

type AtlasConfig = ReturnType<typeof loadConfig>;

/** Scratch ATLAS_HOME whose config points lore at a scratch dataDir. */
function mkCfg(workspace: string, dataDir: string): AtlasConfig {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-home-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 39999, lore: { workspace, mode: 'embedded', dataDir } }),
    );
    return loadConfig(home);
}

/** A lookup that never answers inside any sane budget. The timer is unref'd so
 *  it cannot pin the test process open for the full hang once nothing else is
 *  pending. Every hang is tracked so the harness can await its REAL settlement
 * (deterministic — no guessed sleeps): the single-flight guard is now released
 * by the WORK settling, so a claim that hangs its lookup leaves the guard held
 * until that hang fires; the next claim must drain first or it bounces vacuously. */
const pendingHangs: Promise<unknown>[] = [];

function hang(ms: number): Promise<never> {
    const p = new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined as never), ms);
        t.unref();
    });
    pendingHangs.push(p);
    return p;
}

/** Wait for every started hang to settle, plus one macrotask turn for the
 * guard's release microtask to run — after this, `inFlight` is observably false. */
async function drainHangs(): Promise<void> {
    await Promise.all(pendingHangs);
    pendingHangs.length = 0;
    await new Promise((r) => setTimeout(r, 0));
}

/* ─── CLAIM A: real graph, real callers ─────────────────────────────────── */

async function claimA(): Promise<void> {
    const WS = 'hookenrich-a';
    const cfg = mkCfg(WS, fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-data-')));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-src-'));
    fs.writeFileSync(path.join(src, 'lib.ts'), 'export function enrichTarget(): number { return 7; }\n');
    fs.writeFileSync(
        path.join(src, 'caller.ts'),
        `import { enrichTarget } from './lib.js';\nexport function callerUsesIt(): number { return enrichTarget() + 1; }\n`,
    );

    // Real index of the fixture — the production write path.
    const lore = await getEmbeddedLore(cfg, WS);
    const idx = (await runIndexTool(lore, { path: src }, WS, cfg)) as { nodesWritten?: number };
    assert.ok((idx.nodesWritten ?? 0) > 0, `fixture indexed; got ${JSON.stringify(idx)}`);

    const advice = await enrichPreEdit(cfg, WS, 'lib.ts', 'enrichTarget');
    assert.ok(advice.includes('enrichTarget'), `advice names the changed symbol; got: ${advice}`);
    assert.ok(
        advice.includes('caller.ts'),
        `advice names the REAL caller file (caller.ts); got: ${advice}`,
    );
    assert.match(advice, /^⚠️ Changing `enrichTarget` breaks 1 direct caller: /, `exact advice shape; got: ${advice}`);

    // Same graph through the pre-search entry point: definition site + count.
    const search = await enrichPreSearch(cfg, WS, 'enrichTarget');
    assert.ok(
        search.startsWith('🔎 `enrichTarget` is defined in ') && search.includes('lib.ts'),
        `pre-search advice names the definition file; got: ${search}`,
    );
    assert.ok(search.includes('1 direct caller'), `pre-search advice counts callers; got: ${search}`);
    console.log('  ✓ A: live advice names a real caller file (and definition site) from a seeded scratch graph');

    // No symbol → '' without touching lore; unresolved symbol → ''.
    assert.equal(await enrichPreEdit(cfg, WS, 'lib.ts', null), '', 'null symbol → no live advice');
    assert.equal(await enrichPreEdit(cfg, WS, 'lib.ts', 'noSuchSymbolAnywhere'), '', 'unresolved symbol → no live advice');
    console.log('  ✓ A: null / unresolved symbols return \'\' (static nudge stays the fallback)');
}

/* ─── CLAIM B: a hanging lookup loses the 700ms race ────────────────────── */

async function claimB(): Promise<void> {
    const WS = 'hookenrich-b';
    const cfg = mkCfg(WS, fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-data-')));
    _setLookupForTests(async () => hang(5000));
    try {
        let t0 = Date.now();
        const edit = await enrichPreEdit(cfg, WS, 'src/whatever.ts', 'stuckSymbol');
        const editMs = Date.now() - t0;
        assert.equal(edit, '', `hanging lookup → '' (pre-edit); got: ${JSON.stringify(edit)}`);
        assert.ok(editMs < 900, `pre-edit answered in <900ms; took ${editMs}ms`);
        assert.ok(editMs >= 650, `budget genuinely raced ~700ms, not short-circuited; took ${editMs}ms`);

        // The edit call's hang still HOLDS the single-flight guard (release is
        // bound to the work settling, not the race) — drain it or the pre-search
        // sub-claim below would bounce on the guard instead of racing the budget.
        await drainHangs();

        t0 = Date.now();
        const search = await enrichPreSearch(cfg, WS, 'stuckSymbol');
        const searchMs = Date.now() - t0;
        assert.equal(search, '', `hanging lookup → '' (pre-search); got: ${JSON.stringify(search)}`);
        assert.ok(searchMs < 900, `pre-search answered in <900ms; took ${searchMs}ms`);
        console.log(`  ✓ B: hanging lore (5s) loses the 700ms race — pre-edit ${editMs}ms, pre-search ${searchMs}ms, both ''`);
    } finally {
        _setLookupForTests(null);
    }
}

/* ─── CLAIM C: single-flight — second concurrent call bounces instantly ─── */

async function claimC(): Promise<void> {
    const WS = 'hookenrich-c';
    const cfg = mkCfg(WS, fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-data-')));
    let calls = 0;
    _setLookupForTests(async () => {
        calls += 1;
        return hang(5000);
    });
    try {
        const first = enrichPreEdit(cfg, WS, 'src/a.ts', 'symX'); // not awaited yet
        await new Promise((r) => setTimeout(r, 0)); // one macrotask turn: inFlight is set synchronously; this is belt-and-braces
        const t0 = Date.now();
        const second = await enrichPreEdit(cfg, WS, 'src/b.ts', 'symY');
        const secondMs = Date.now() - t0;
        assert.equal(second, '', `second in-flight call → '' immediately; got: ${JSON.stringify(second)}`);
        assert.ok(secondMs < 100, `second call did not wait (took ${secondMs}ms — must be instant, not budget-bound)`);
        assert.equal(await first, '', 'first call also fails open when its lookup hangs');
        assert.equal(calls, 1, `exactly ONE lookup ran (single-flight); ran ${calls}`);
        console.log(`  ✓ C: single-flight — concurrent second call returned '' in ${secondMs}ms, lookup ran once`);
    } finally {
        _setLookupForTests(null);
    }
}

/* ─── CLAIM C2: single-flight holds PAST the 700ms budget window ────────── */

async function claimC2(): Promise<void> {
    const WS = 'hookenrich-c2';
    const cfg = mkCfg(WS, fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-data-')));
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    _setLookupForTests(async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await hang(5000);
        active -= 1;
        return null;
    });
    try {
        const first = enrichPreEdit(cfg, WS, 'src/a.ts', 'symPost'); // not awaited yet
        // Real wall-clock wait, deliberately: BUDGET_MS is a genuine platform timer
        // inside the module under test and the defect lives specifically in what
        // happens AFTER ~700ms of real elapsed time — no deterministic timer
        // control exists in this plain-tsx harness (same stance as claim B).
        await new Promise((r) => setTimeout(r, 900));
        const t0 = Date.now();
        const second = await enrichPreEdit(cfg, WS, 'src/b.ts', 'symPost2');
        const secondMs = Date.now() - t0;
        assert.equal(second, '', `post-budget call while lookup still in flight → ''; got: ${JSON.stringify(second)}`);
        assert.ok(secondMs < 100, `post-budget call did not wait (took ${secondMs}ms — guard must still be held)`);
        assert.equal(await first, '', 'first call also fails open when its lookup hangs');
        assert.equal(calls, 1, `post-budget window: still exactly ONE lookup (guard held past the race); ran ${calls}`);
        assert.equal(maxActive, 1, `max observed lookup concurrency 1, not ${maxActive} — the old code released the guard at race settlement and stacked native reads`);
        console.log(`  ✓ C2: single-flight PAST the budget — second call at +900ms bounced in ${secondMs}ms, lookup ran once, max concurrency 1`);
    } finally {
        _setLookupForTests(null);
    }
}

/* ─── CLAIM D: repeat call hits the 60s cache; exact shape pinned ───────── */

async function claimD(): Promise<void> {
    const WS = 'hookenrich-d';
    const cfg = mkCfg(WS, fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hook-enrich-data-')));
    let calls = 0;
    const answer: D1Answer = {
        name: 'cachedSym',
        file: 'src/def.ts',
        callers: [
            { file: 'src/use1.ts' },
            { file: 'src/use2.ts' },
            { file: 'src/use3.ts' },
            { file: 'src/use4.ts' },
            { file: 'src/use5.ts' },
        ],
    };
    _setLookupForTests(async () => {
        calls += 1;
        return answer;
    });
    try {
        const one = await enrichPreEdit(cfg, WS, 'src/def.ts', 'cachedSym');
        // Different filePath, SAME symbol — must hit the same cache entry.
        const two = await enrichPreEdit(cfg, WS, 'src/def-elsewhere.ts', 'cachedSym');
        assert.equal(calls, 1, `cache hit — lookup ran exactly once; ran ${calls}`);
        assert.equal(two, one, 'cached value returned verbatim');
        assert.equal(
            one,
            '⚠️ Changing `cachedSym` breaks 5 direct callers: src/use1.ts, src/use2.ts, src/use3.ts, +2 more. Update those too or this change won\'t hold.',
            `exact advice shape (3 files + "+k more" naming unshown CALLERS); got: ${one}`,
        );
        console.log('  ✓ D: repeat call hit the cache (lookup ran once) and the advice shape is pinned exactly');
    } finally {
        _setLookupForTests(null);
    }
}

async function main(): Promise<void> {
    console.log('Atlas hook live-enrichment tests');
    await claimA();
    await claimB();
    await drainHangs(); // B's hung lookup keeps the guard held past the claim's own end
    await claimC();
    await drainHangs();
    await claimC2();
    await drainHangs();
    await claimD();
    await closeAllEmbedded(); // claim A opened a real instance through the shared registry
    console.log('All hook-enrich tests passed.');
}

await main();
