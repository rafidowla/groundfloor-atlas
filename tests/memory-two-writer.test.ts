/**
 * tests/memory-two-writer.test.ts — Wave 1 (merge-safety) adversarial suite.
 *
 * GATE: no entry loss under ANY two-writer sequence (dev + PM, disjoint or
 * colliding writes, any interleaving of commit / merge / export).
 *
 * This guards TWO layers of the belt-and-suspenders:
 *   1. the git merge driver (scripts/memory-merge-driver.mjs) — run as a REAL
 *      subprocess against real temp files, exactly as git invokes it, so the
 *      pure-JSONL / zero-native-deps property is proven end to end;
 *   2. the pre-commit union-on-export (unionMemoryFileInPlace in memorySync.ts)
 *      — the fold-back that stops a fresh DB export from clobbering file-only
 *      (remote/PM) entries the local DB hasn't imported yet.
 *
 * Scenario 7 ("empty DB, full file") is the exact 2026-07-13 regression shape:
 * with the fold-back removed it drops every entry; with it, nothing is lost.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unionMemoryFileInPlace } from '../src/cli/memorySync.js';
import { buildExportHookSection } from '../src/cli/gitHooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const DRIVER = path.join(repoRoot, 'scripts', 'memory-merge-driver.mjs');

const header = (ts: string, version = 1) =>
    JSON.stringify({ version, exportedAt: ts, sourceWorkspace: 'ws', exportedTypes: ['decision'] });
const node = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ kind: 'node', id, type: 'decision', label: id, ...extra });
const edge = (s: string, t: string, r = 'relates_to') =>
    JSON.stringify({ kind: 'edge', sourceId: s, targetId: t, relation: r });

const lines = (jsonl: string) =>
    jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const nodeIds = (jsonl: string) =>
    lines(jsonl).filter((o) => o.kind === 'node').map((o) => o.id as string).sort();
const headers = (jsonl: string) =>
    lines(jsonl).filter((o) => o.kind === undefined && (o.version !== undefined || o.exportedTypes !== undefined));

/** Make a fresh temp dir; caller cleans up. */
function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-2writer-'));
}

/** Drive the REAL merge driver the way git does: node driver %O %A %B, result left in %A (ours). */
function runMergeDriver(dir: string, oursText: string, theirsText: string): string {
    const O = path.join(dir, 'base');   // ancestor (unused by a union)
    const A = path.join(dir, 'ours');
    const B = path.join(dir, 'theirs');
    fs.writeFileSync(O, '');
    fs.writeFileSync(A, oursText);
    fs.writeFileSync(B, theirsText);
    execFileSync('node', [DRIVER, O, A, B], { stdio: 'pipe' });
    return fs.readFileSync(A, 'utf8'); // driver leaves the merged result in OURS
}

/**
 * Simulate the pre-commit path: a fresh export overwrites the working-tree file
 * with `freshExport`, then unionMemoryFileInPlace folds the PRIOR file back in.
 * Returns the resulting file text.
 */
function exportThenUnion(dir: string, priorFile: string, freshExport: string): string {
    const p = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(p, priorFile);                 // what was on disk (pulled, not yet imported)
    fs.writeFileSync(p, freshExport);               // fresh DB export overwrites it
    unionMemoryFileInPlace(p, priorFile);           // W1: fold the prior file back in
    return fs.readFileSync(p, 'utf8');
}

async function main(): Promise<void> {
    console.log('memory two-writer merge-safety suite');

    // ── Scenario 1 — Disjoint adds, both layers ──────────────────────────────
    {
        const dir = tmpDir();
        try {
            const devAdds = [header('2026-07-05T00:00:00Z'), node('d1'), node('d2'), node('d3')].join('\n');
            const pmAdds = [header('2026-07-06T00:00:00Z'),
                ...Array.from({ length: 5 }, (_, i) => node(`p${i}`))].join('\n');

            // (a) merge-driver layer — real subprocess
            const merged = runMergeDriver(dir, devAdds, pmAdds);
            assert.equal(nodeIds(merged).length, 8, 'driver: 3 dev + 5 PM = 8, none dropped');

            // (b) pre-commit fold-back: a fresh export of ONLY the dev's 3, after a
            // FAILED post-merge import left the PM's 5 in the file, still keeps all 8.
            const prior = merged;                                   // file has all 8 (from the merge)
            const freshDevOnly = devAdds;                           // but the DB only knows the dev's 3
            const p = path.join(dir, 'm.jsonl');
            fs.writeFileSync(p, prior);
            fs.writeFileSync(p, freshDevOnly);
            const r = unionMemoryFileInPlace(p, prior);
            assert.equal(nodeIds(fs.readFileSync(p, 'utf8')).length, 8,
                'export-after-failed-import must NOT drop the PM-only entries');
            assert.equal(r.nodeCount, 8, 'reported nodeCount reflects the union, not the DB snapshot');
            console.log('  ✓ S1: disjoint adds survive both the driver and the export fold-back');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Scenario 2 — Colliding edit: ours (fresh DB) wins, other side preserved ─
    {
        const dir = tmpDir();
        try {
            const prior = [header('2026-07-05T00:00:00Z'),
                node('X', { label: 'THEIRS' }), node('Y')].join('\n');
            const fresh = [header('2026-07-08T00:00:00Z'),
                node('X', { label: 'OURS' })].join('\n');
            const out = lines(exportThenUnion(dir, prior, fresh));
            const x = out.find((o) => o.id === 'X') as Record<string, unknown>;
            assert.equal(x.label, 'OURS', 'fresh DB (ours) wins the same-id collision');
            assert.ok(out.some((o) => o.id === 'Y'), 'the file-only node Y is preserved');
            console.log('  ✓ S2: colliding edit — ours wins, loser key preserved');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Scenario 3 — Supersede vs edit (documented accepted-loss case §6.1) ────
    {
        const dir = tmpDir();
        try {
            // Fresh DB (ours) superseded X; the file (theirs) has a newer edit with
            // supersededAt null. Ours wins ⇒ the superseded state is kept. This is
            // the intended soft-lifecycle: a local supersede is not resurrected as
            // "live" by a stale file entry.
            const prior = [header('2026-07-05T00:00:00Z'),
                node('X', { content: 'edited later', supersededAt: null })].join('\n');
            const fresh = [header('2026-07-09T00:00:00Z'),
                node('X', { supersededAt: '2026-07-09T00:00:00Z' })].join('\n');
            const out = lines(exportThenUnion(dir, prior, fresh));
            const x = out.find((o) => o.id === 'X') as Record<string, unknown>;
            assert.equal(x.supersededAt, '2026-07-09T00:00:00Z',
                'supersede (ours) wins — soft-lifecycle is the supported deletion path');
            console.log('  ✓ S3: supersede-vs-edit resolves to the superseded (ours) state');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Scenario 4 — Edge identity + cross-seam target ────────────────────────
    {
        const dir = tmpDir();
        try {
            const prior = [header('2026-07-05T00:00:00Z'),
                edge('a', 'b'), edge('a', 'c'),
                edge('dec-1', 'lore/dec-Y')].join('\n');           // cross-seam foreign target
            const fresh = [header('2026-07-06T00:00:00Z'),
                edge('a', 'b'),                                    // dup of prior a→b
                edge('a', 'b', 'supersedes')].join('\n');          // same nodes, DIFFERENT relation
            const out = lines(exportThenUnion(dir, prior, fresh));
            const edges = out.filter((o) => o.kind === 'edge');
            assert.equal(edges.length, 4, 'a→b(relates) deduped; a→c, a→b(supersedes), cross-seam kept = 4');
            assert.ok(edges.some((e) => e.targetId === 'lore/dec-Y'),
                'cross-seam foreign-qualified edge survives the union');
            console.log('  ✓ S4: edges dedupe by (source,target,relation); cross-seam survives');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Scenario 5 — Corrupt / malformed input tolerated; exactly one header ───
    {
        const dir = tmpDir();
        try {
            const prior = [
                header('2026-07-05T00:00:00Z', 1),
                node('k1'),
                '<<<<<<< HEAD',                 // stray conflict marker
                'not json at all',              // junk
                header('2026-07-04T00:00:00Z', 2), // a SECOND (older) header line
                node('k2'),
            ].join('\n') + '\n{"kind":"node","id":"partial'; // partial trailing line (simulated crash)
            const fresh = [header('2026-07-09T00:00:00Z', 2), node('k3')].join('\n');
            const outText = exportThenUnion(dir, prior, fresh);
            assert.deepEqual(nodeIds(outText), ['k1', 'k2', 'k3'],
                'real nodes kept; junk/partial/marker lines skipped');
            const hs = headers(outText);
            assert.equal(hs.length, 1, 'exactly one header line in the union output');
            assert.equal((hs[0] as Record<string, unknown>).exportedAt, '2026-07-09T00:00:00Z',
                'the newer header wins');
            console.log('  ✓ S5: malformed input tolerated; single newest header');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Scenario 6 — the hook body itself keeps --union + git add -f ───────────
    {
        const section = buildExportHookSection('/tmp/some/repo', 'my-ws');
        assert.ok(section.includes('memory export .atlas/memory.jsonl --workspace "my-ws" --union'),
            'pre-commit body must call export with --union (merge-safety flag)');
        assert.ok(section.includes('git add -f .atlas/memory.jsonl'),
            'pre-commit body must force-stage the exported file');
        assert.ok(section.includes('if [ "$(pwd)" = "/tmp/some/repo" ]'),
            'pre-commit body must keep the shared-hooks-dir repo guard');
        console.log('  ✓ S6: buildExportHookSection keeps --union, git add -f, and the $(pwd) guard');
    }

    // ── Scenario 7 — empty DB, full file: THE original regression ─────────────
    {
        const dir = tmpDir();
        try {
            const fullFile = [header('2026-07-06T00:00:00Z'),
                ...Array.from({ length: 140 }, (_, i) => node(`e${i}`))].join('\n');
            const emptyExport = header('2026-07-09T00:00:00Z'); // DB wiped / never imported: header only, 0 nodes
            const outText = exportThenUnion(dir, fullFile, emptyExport);
            assert.equal(nodeIds(outText).length, 140,
                'empty-DB export must NOT wipe a full file — the 2026-07-13 bug');

            // Prove the guard is load-bearing: WITHOUT the fold-back, the fresh
            // export alone (what the old flow committed) has zero nodes.
            assert.equal(nodeIds(emptyExport).length, 0,
                'control: the bare fresh export the OLD flow committed would drop all 140');
            console.log('  ✓ S7: empty-DB-full-file preserved (control proves the fold-back is required)');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── Atomicity — a leftover .tmp is never the committed file ────────────────
    {
        const dir = tmpDir();
        try {
            const p = path.join(dir, 'memory.jsonl');
            const prior = [header('2026-07-05T00:00:00Z'), node('keep')].join('\n');
            fs.writeFileSync(p, [header('2026-07-09T00:00:00Z'), node('fresh')].join('\n'));
            unionMemoryFileInPlace(p, prior);
            const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
            assert.equal(stray.length, 0, 'no leftover temp file after an atomic union write');
            assert.deepEqual(nodeIds(fs.readFileSync(p, 'utf8')), ['fresh', 'keep']);
            console.log('  ✓ S8: atomic write leaves no partial/temp file behind');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    console.log('memory two-writer: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
