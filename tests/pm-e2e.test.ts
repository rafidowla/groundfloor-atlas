/**
 * tests/pm-e2e.test.ts — W3-T4: the Wave 3 GATE. Two-participant end-to-end
 * no-loss test over REAL git.
 *
 * Assembles the whole system against a real local bare remote + two clones:
 *   - DEV side: models a developer's embedded-Lore pre-commit — a fresh full-DB
 *     export (only the dev's own nodes) OVERWRITES the working-tree file, then
 *     the W1 fold-back (unionMemoryFileInPlace) restores any file-only (PM)
 *     entries the DB never imported. (A real embedded Lore can't run here — the
 *     native DB modules are ABI-broken — so we drive its exact pre-commit file
 *     path, which is what the merge-safety guarantee actually rests on.)
 *   - PM side: the real stateless write path — recordPmDecision (W3-T3) → the
 *     union append (W2-T3), no DB.
 *   - Both clones carry the union merge driver installed via the driver-only
 *     path (W3-T2, installMergeDriverOnly), the same one a non-Atlas participant
 *     gets, exercised through real `git pull --rebase` / `git push`.
 *
 * The gate: ≥20 seeded randomized runs of interleaved disjoint writes with
 * simultaneous unpushed commits on both sides (every round forces a
 * push-with-rebase, so the merge driver runs for real), plus a deep ≥10-round
 * run, plus the named adversarial scenarios (colliding ids, broken dev export,
 * same-requestId idempotency, supersede round-trip). Count-invariant after the
 * run: the set of ids in the remote file == the union of every id ever written;
 * failure output names the exact lost/duplicated ids.
 *
 * Runs with NO network (bare remote is a local dir) and zero native deps. Git
 * config is fully isolated (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null) so the machine's
 * global core.hooksPath never fires on these commits.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installMergeDriverOnly } from '../src/cli/gitHooks.js';
import { unionMemoryFileInPlace } from '../src/cli/memorySync.js';
import { readMemoryFile, KNOWLEDGE_TYPES, type NodeLine } from '../src/memoryFile.js';
import { recordPmDecision, supersedePmDecision, buildPmDecision } from '../src/pmDecision.js';
import { appendMemoryEntries } from '../src/memoryFile.js';
import { filterNodes } from '../src/memoryQuery.js';

const REL = path.join('.atlas', 'memory.jsonl');
const TS = '2026-07-16T00:00:00.000Z';

const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
    GIT_TERMINAL_PROMPT: '0',
};

function git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitTry(repo: string, args: string[]): { ok: boolean; stderr: string } {
    try { git(repo, args); return { ok: true, stderr: '' }; }
    catch (err) { return { ok: false, stderr: String((err as { stderr?: string }).stderr ?? (err as Error).message) }; }
}

/** Deterministic PRNG (mulberry32) so a failing run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const HEADER = JSON.stringify({ version: 2, exportedAt: TS, exportedTypes: KNOWLEDGE_TYPES });

function nodeIdsOf(text: string): string[] {
    return text.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as { kind?: string; id?: string }; } catch { return {}; } })
        .filter((o) => o.kind === 'node')
        .map((o) => o.id as string);
}
function remoteText(remote: string): string {
    return git(remote, ['show', `main:${REL}`]);
}

interface Clones { base: string; remote: string; dev: string; pm: string; }

/** Fresh bare remote + a dev clone and a pm clone, both with the union driver
 *  installed (driver-only path) and a committed header-only ledger. */
function setup(): Clones {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pm-e2e-'));
    const remote = path.join(base, 'remote.git');
    const dev = path.join(base, 'dev');
    const pm = path.join(base, 'pm');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: gitEnv, stdio: 'ignore' });
    execFileSync('git', ['clone', '-q', remote, dev], { env: gitEnv, stdio: 'ignore' });
    // W3-T2 driver-only install (sets local merge config + writes .gitattributes).
    const di = installMergeDriverOnly(dev);
    assert.ok(di.ok && di.mergeDriver, 'driver-only install succeeds in the dev clone');
    fs.mkdirSync(path.join(dev, '.atlas'), { recursive: true });
    fs.writeFileSync(path.join(dev, REL), HEADER + '\n');
    git(dev, ['add', '-A']);
    git(dev, ['commit', '-qm', 'seed']);
    git(dev, ['push', '-q', '-u', 'origin', 'main']);
    execFileSync('git', ['clone', '-q', remote, pm], { env: gitEnv, stdio: 'ignore' });
    const pi = installMergeDriverOnly(pm); // idempotent on .gitattributes; sets pm's local config
    assert.ok(pi.ok && pi.mergeDriver, 'driver-only install succeeds in the pm clone');
    return { base, remote, dev, pm };
}

/** Model the dev pre-commit: fresh full-DB export (dev's own nodes only)
 *  overwrites the file, then the W1 fold-back restores file-only PM entries. */
function devCommit(dev: string, devDbNodes: NodeLine[], msg: string): void {
    const fileAbs = path.join(dev, REL);
    const prior = fs.readFileSync(fileAbs, 'utf8'); // working tree after the last pull (may hold PM entries)
    const fresh = [HEADER, ...devDbNodes.map((n) => JSON.stringify(n))].join('\n') + '\n';
    fs.writeFileSync(fileAbs, fresh);               // fresh DB export overwrites — as if the DB never saw PM entries
    unionMemoryFileInPlace(fileAbs, prior);         // W1-T1 fold-back: restore file-only entries
    git(dev, ['add', '-A']);
    git(dev, ['commit', '-qm', msg]);
}

function devNode(id: string): NodeLine {
    return { kind: 'node', id, type: 'decision', label: id, content: `dev work ${id}`, tags: 'dev', metadata: { source: 'dev' }, supersededAt: null };
}

/** Push, and on rejection pull --rebase (driver unions) and retry, ≤3×. */
function pushWithRebase(repo: string, who: string): void {
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (gitTry(repo, ['push', '-q', 'origin', 'main']).ok) return;
        const pr = gitTry(repo, ['pull', '-q', '--rebase', 'origin', 'main']);
        assert.ok(pr.ok, `${who}: pull --rebase during push retry failed:\n${pr.stderr}`);
    }
    assert.fail(`${who}: push still rejected after 3 attempts`);
}

/** One randomized run: `rounds` interleaved rounds, both sides commit on
 *  divergent bases before either pushes. Returns nothing; asserts the
 *  count-invariant at the end and names any lost/duplicated ids. */
function runSeed(seed: number, rounds: number): void {
    const rng = mulberry32(seed);
    const c = setup();
    try {
        const devDbNodes: NodeLine[] = [];
        const expected = new Set<string>();
        for (let r = 0; r < rounds; r++) {
            // Both commit locally FIRST (simultaneous unpushed commits).
            const devId = `knowledge:decision:dev-s${seed}-r${r}`;
            devDbNodes.push(devNode(devId));
            expected.add(devId);
            devCommit(c.dev, devDbNodes, `dev ${r}`);

            const reqId = `s${seed}-r${r}`;
            const rec = recordPmDecision(path.join(c.pm, REL), { requestId: reqId, label: `pm ${r}`, content: `pm approval ${r}`, approvedBy: 'p', approvedAt: TS });
            expected.add(rec.id);
            git(c.pm, ['add', '-A']);
            git(c.pm, ['commit', '-qm', `pm ${r}`]);

            // Push in a randomized order — the second pusher must rebase-union.
            if (rng() < 0.5) { pushWithRebase(c.dev, 'dev'); pushWithRebase(c.pm, 'pm'); }
            else { pushWithRebase(c.pm, 'pm'); pushWithRebase(c.dev, 'dev'); }

            // Both sync so the next round's bases include the other's work.
            assert.ok(gitTry(c.dev, ['pull', '-q', '--rebase', 'origin', 'main']).ok, 'dev pull sync');
            assert.ok(gitTry(c.pm, ['pull', '-q', '--rebase', 'origin', 'main']).ok, 'pm pull sync');
        }

        const ids = nodeIdsOf(remoteText(c.remote));
        const actual = new Set(ids);
        // No duplicates.
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        assert.equal(dupes.length, 0, `seed ${seed}: duplicated ids in remote: ${[...new Set(dupes)].join(', ')}`);
        // No loss.
        const lost = [...expected].filter((id) => !actual.has(id));
        assert.equal(lost.length, 0, `seed ${seed}: LOST ids (in no writer's output): ${lost.join(', ')}`);
        // No extras beyond what was written.
        const extra = [...actual].filter((id) => !expected.has(id));
        assert.equal(extra.length, 0, `seed ${seed}: unexpected ids in remote: ${extra.join(', ')}`);
    } finally {
        fs.rmSync(c.base, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('pm-e2e (W3-T4) two-participant no-loss GATE');

    // ── GATE — 20 seeded randomized runs + one deep ≥10-round run ────────────
    {
        const t0 = Date.now();
        const NUM_SEEDS = 20;
        for (let s = 1; s <= NUM_SEEDS; s++) runSeed(s, 4);
        runSeed(9999, 10); // the ≥10-round interleaved scenario
        console.log(`  ✓ GATE: ${NUM_SEEDS} seeded runs + 1 deep(10) run, zero loss/dup (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }

    // ── SCENARIO A — colliding ids resolve to exactly one (recorded winner) ──
    {
        const c = setup();
        try {
            const COLLIDE = 'knowledge:decision:pm-COLLIDE';
            // Both sides author the SAME id on divergent bases.
            appendMemoryEntries(path.join(c.pm, REL), [{ kind: 'node', id: COLLIDE, type: 'decision', label: 'pm version', content: 'pm content', tags: 'pm', metadata: { source: 'pm' }, supersededAt: null }], { exportedAt: TS });
            git(c.pm, ['add', '-A']); git(c.pm, ['commit', '-qm', 'pm collide']);
            appendMemoryEntries(path.join(c.dev, REL), [{ kind: 'node', id: COLLIDE, type: 'decision', label: 'dev version', content: 'dev content', tags: 'dev', metadata: { source: 'dev' }, supersededAt: null }], { exportedAt: TS });
            git(c.dev, ['add', '-A']); git(c.dev, ['commit', '-qm', 'dev collide']);
            // pm pushes first; dev's push is rejected and dev rebases. NOTE: a
            // rebase INVERTS ours/theirs — while replaying dev's commit, %A (ours)
            // is the UPSTREAM tip (pm's already-pushed version) and %B (theirs) is
            // dev's replayed commit. The union driver's ours-wins therefore keeps
            // pm's content: the FIRST PUSHER (upstream) is the recorded winner.
            pushWithRebase(c.pm, 'pm');
            pushWithRebase(c.dev, 'dev');
            const ids = nodeIdsOf(remoteText(c.remote));
            assert.equal(ids.filter((id) => id === COLLIDE).length, 1, 'colliding id appears exactly once (no duplicate)');
            const winner = (await readMemoryFile(path.join(c.dev, REL))).nodes.find((n) => n.id === COLLIDE);
            assert.equal(winner?.content, 'pm content', 'recorded winner: the first pusher (upstream = ours during rebase) wins the collision');
            console.log('  ✓ SCENARIO A: colliding ids → exactly one node, deterministic recorded winner');
        } finally { fs.rmSync(c.base, { recursive: true, force: true }); }
    }

    // ── SCENARIO B — broken dev export still preserves PM entries (fold-back) ─
    {
        const c = setup();
        try {
            // PM writes + pushes an entry.
            const rec = recordPmDecision(path.join(c.pm, REL), { requestId: 'KEEP-1', label: 'keep', content: 'must survive', approvedBy: 'p', approvedAt: TS });
            git(c.pm, ['add', '-A']); git(c.pm, ['commit', '-qm', 'pm keep']); pushWithRebase(c.pm, 'pm');
            // Dev pulls it, then commits a fresh DB export that OMITS it (broken/never-imported).
            assert.ok(gitTry(c.dev, ['pull', '-q', '--rebase', 'origin', 'main']).ok);
            const before = nodeIdsOf(fs.readFileSync(path.join(c.dev, REL), 'utf8'));
            assert.ok(before.includes(rec.id), 'dev pulled the PM entry into its working tree');
            devCommit(c.dev, [devNode('knowledge:decision:dev-only')], 'dev broken export'); // DB export lacks the PM id
            const committed = nodeIdsOf(fs.readFileSync(path.join(c.dev, REL), 'utf8'));
            assert.ok(committed.includes(rec.id), 'W1 fold-back preserved the PM entry the DB export omitted');
            pushWithRebase(c.dev, 'dev');
            assert.ok(nodeIdsOf(remoteText(c.remote)).includes(rec.id), 'PM entry survives to the remote');
            console.log('  ✓ SCENARIO B: a dev export that drops the PM entry — fold-back restores it');
        } finally { fs.rmSync(c.base, { recursive: true, force: true }); }
    }

    // ── SCENARIO C — same requestId 3× → exactly one node dev-side ───────────
    {
        const c = setup();
        try {
            for (let i = 0; i < 3; i++) {
                recordPmDecision(path.join(c.pm, REL), { requestId: 'REQ-IDEM', label: 'idem', content: 'same content', approvedBy: 'p', approvedAt: TS });
                git(c.pm, ['add', '-A']);
                if (gitTry(c.pm, ['diff', '--cached', '--quiet']).ok) continue; // byte-stable re-run: nothing to commit
                git(c.pm, ['commit', '-qm', `pm idem ${i}`]);
                pushWithRebase(c.pm, 'pm');
            }
            assert.ok(gitTry(c.dev, ['pull', '-q', '--rebase', 'origin', 'main']).ok);
            const ids = nodeIdsOf(fs.readFileSync(path.join(c.dev, REL), 'utf8'));
            assert.equal(ids.filter((id) => id === 'knowledge:decision:pm-REQ-IDEM').length, 1, 'same requestId 3× → exactly one node dev-side');
            console.log('  ✓ SCENARIO C: same requestId 3× → exactly one node dev-side');
        } finally { fs.rmSync(c.base, { recursive: true, force: true }); }
    }

    // ── SCENARIO D — supersede round-trip: hidden from default recall ────────
    {
        const c = setup();
        try {
            // PM records a decision, then supersedes it (ours-wins upsert stamps supersededAt).
            const base = buildPmDecision({ requestId: 'REQ-SUP', label: 'v1', content: 'first', approvedBy: 'p', approvedAt: TS });
            appendMemoryEntries(path.join(c.pm, REL), [base], { exportedAt: TS });
            git(c.pm, ['add', '-A']); git(c.pm, ['commit', '-qm', 'pm sup v1']); pushWithRebase(c.pm, 'pm');
            const retired = supersedePmDecision(base, TS);
            appendMemoryEntries(path.join(c.pm, REL), [retired], { exportedAt: TS });
            git(c.pm, ['add', '-A']); git(c.pm, ['commit', '-qm', 'pm sup retire']); pushWithRebase(c.pm, 'pm');

            assert.ok(gitTry(c.dev, ['pull', '-q', '--rebase', 'origin', 'main']).ok);
            const view = await readMemoryFile(path.join(c.dev, REL));
            const node = view.nodes.find((n) => n.id === base.id);
            assert.equal(node?.supersededAt, TS, 'the entry carries supersededAt after the retire append');
            const defaultVisible = filterNodes(view).some((n) => n.id === base.id);
            assert.equal(defaultVisible, false, 'default recall (filterNodes) hides the superseded entry');
            const withSuperseded = filterNodes(view, { includeSuperseded: true }).some((n) => n.id === base.id);
            assert.equal(withSuperseded, true, 'still present when superseded are included');
            console.log('  ✓ SCENARIO D: PM supersede round-trips, hidden from default dev recall');
        } finally { fs.rmSync(c.base, { recursive: true, force: true }); }
    }

    console.log('pm-e2e: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
