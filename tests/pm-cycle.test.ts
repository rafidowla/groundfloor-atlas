/**
 * tests/pm-cycle.test.ts — W3-T2 (merge-driver-only install) + W3-T3 (the PM
 * operating loop / reference script scripts/pm-memory-cycle.mjs).
 *
 * W3-T2: in a Lore-less clone, `installMergeDriverOnly` sets the union merge
 * config + writes the .gitattributes stanza and NOTHING ELSE (no export/import
 * hooks), is idempotent, resolves a real conflicted merge by union, and its
 * uninstall is clean.
 *
 * W3-T3: scripts/pm-memory-cycle.mjs runs the full normative loop (pull →
 * pm-record → commit → push-with-retry) against a local bare remote + dev
 * clone; the decision lands + pushes, and a same-requestId re-run stays exactly
 * one node (idempotent). The script is driven with `--atlas-argv` pointed at the
 * src CLI under tsx (single core — the schema/append logic is the same library
 * the CLI wraps). Zero native deps; git config fully isolated so the machine's
 * global hooks never fire.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMergeDriverOnly, uninstallMergeDriverOnly, mergeDriverStatus } from '../src/cli/gitHooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const CLI = path.join(repoRoot, 'src', 'cli.ts');
const CYCLE = path.join(repoRoot, 'scripts', 'pm-memory-cycle.mjs');
const require2 = createRequire(import.meta.url);
const TSX_CLI = require2.resolve('tsx/cli');
const REL = path.join('.atlas', 'memory.jsonl');

const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
    GIT_TERMINAL_PROMPT: '0',
};
function git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
}
function nodeIdsOf(text: string): string[] {
    return text.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as { kind?: string; id?: string }; } catch { return {}; } })
        .filter((o) => o.kind === 'node').map((o) => o.id as string);
}
/** The atlas CLI argv the reference script shells to (src CLI under tsx). */
const ATLAS_ARGV = [process.execPath, TSX_CLI, CLI];

async function main(): Promise<void> {
    console.log('pm-cycle (W3-T2 + W3-T3) driver-only install + PM loop');

    // ── W3-T2 CLAIM 1 — driver-only install: config + stanza, no hooks ───────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pmc-mdonly-'));
        try {
            execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv, stdio: 'ignore' });
            const r = installMergeDriverOnly(dir);
            assert.ok(r.ok && r.mergeDriver, 'install-merge-driver succeeds');
            // merge config present.
            const driver = git(dir, ['config', '--get', 'merge.atlas-memory-union.driver']).trim();
            assert.ok(driver.includes('memory-merge-driver.mjs'), 'union merge driver registered in git config');
            assert.ok(mergeDriverStatus(dir), 'mergeDriverStatus reports installed');
            // .gitattributes stanza present.
            const attrs = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
            assert.ok(attrs.includes('.atlas/memory.jsonl merge=atlas-memory-union'), '.gitattributes stanza written');
            // NO export/import hooks installed (the whole point — a Lore-less clone).
            const hooksDir = path.join(dir, '.git', 'hooks');
            for (const h of ['pre-commit', 'post-merge', 'post-checkout']) {
                const p = path.join(hooksDir, h);
                if (fs.existsSync(p)) {
                    assert.ok(!fs.readFileSync(p, 'utf8').includes('atlas-hook-begin'), `${h}: no Atlas hook section installed`);
                }
            }
            // Idempotent re-run: stanza not duplicated.
            installMergeDriverOnly(dir);
            const attrs2 = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
            assert.equal(attrs2.match(/atlas-memory-merge-begin/g)?.length, 1, 'idempotent: stanza written once');
            // Uninstall is clean.
            uninstallMergeDriverOnly(dir);
            assert.equal(mergeDriverStatus(dir), false, 'uninstall removes the merge config');
            assert.ok(!fs.existsSync(path.join(dir, '.gitattributes')) || !fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8').includes('atlas-memory-merge-begin'), 'uninstall removes the stanza');
            console.log('  ✓ W3-T2 CLAIM 1: driver-only install — config + stanza, no hooks, idempotent, clean uninstall');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── W3-T2 CLAIM 2 — a real conflicted merge resolves by union ────────────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pmc-merge-'));
        try {
            execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv, stdio: 'ignore' });
            installMergeDriverOnly(dir);
            fs.mkdirSync(path.join(dir, '.atlas'), { recursive: true });
            const header = '{"version":2,"exportedTypes":["decision"]}';
            fs.writeFileSync(path.join(dir, REL), header + '\n');
            git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'seed']);
            // branch A adds a1; branch B (from seed) adds b1 → conflicting append.
            git(dir, ['checkout', '-q', '-b', 'a']);
            fs.appendFileSync(path.join(dir, REL), '{"kind":"node","id":"a1","type":"decision","label":"a","content":"c"}\n');
            git(dir, ['commit', '-qam', 'a1']);
            git(dir, ['checkout', '-q', 'main']); git(dir, ['checkout', '-q', '-b', 'b']);
            fs.appendFileSync(path.join(dir, REL), '{"kind":"node","id":"b1","type":"decision","label":"b","content":"c"}\n');
            git(dir, ['commit', '-qam', 'b1']);
            git(dir, ['checkout', '-q', 'a']);
            git(dir, ['merge', '-q', '--no-edit', 'b']); // union driver resolves
            const ids = nodeIdsOf(fs.readFileSync(path.join(dir, REL), 'utf8')).sort();
            assert.deepEqual(ids, ['a1', 'b1'], 'the conflicted merge unions both sides — nothing dropped');
            console.log('  ✓ W3-T2 CLAIM 2: a real conflicted merge in a driver-only clone resolves by union');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── W3-T3 CLAIM 3 — the reference cycle script: full loop, idempotent ────
    {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pmc-cycle-'));
        const remote = path.join(base, 'remote.git');
        const clone = path.join(base, 'pm');
        try {
            execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: gitEnv, stdio: 'ignore' });
            execFileSync('git', ['clone', '-q', remote, clone], { env: gitEnv, stdio: 'ignore' });
            installMergeDriverOnly(clone);
            fs.mkdirSync(path.join(clone, '.atlas'), { recursive: true });
            fs.writeFileSync(path.join(clone, REL), '{"version":2,"exportedTypes":["decision"]}\n');
            git(clone, ['add', '-A']); git(clone, ['commit', '-qm', 'seed']); git(clone, ['push', '-q', '-u', 'origin', 'main']);

            const runCycle = (requestId: string, content: string): Record<string, unknown> => {
                const out = execFileSync(process.execPath, [
                    CYCLE, '--repo', clone, '--request-id', requestId, '--label', `approve ${requestId}`,
                    '--content', content, '--approved-by', 'rafi', '--approved-at', '2026-07-16T00:00:00.000Z',
                    ...ATLAS_ARGV.flatMap((a) => ['--atlas-argv', a]),
                ], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
                return JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!) as Record<string, unknown>;
            };

            const r1 = runCycle('REQ-100', 'first approval');
            assert.equal(r1['ok'], true);
            assert.equal(r1['id'], 'knowledge:decision:pm-REQ-100');
            assert.equal(r1['pushed'], true, 'the decision was pushed to the remote');
            // Landed in the remote.
            const remoteIds = nodeIdsOf(git(remote, ['show', 'main:' + REL]));
            assert.ok(remoteIds.includes('knowledge:decision:pm-REQ-100'), 'decision present in the remote ledger');

            // Same requestId re-run → idempotent (byte-stable file → nothing to commit).
            const r2 = runCycle('REQ-100', 'first approval');
            assert.equal(r2['ok'], true);
            assert.equal(r2['committed'], false, 'same requestId re-run makes no new commit (idempotent)');
            const remoteIds2 = nodeIdsOf(git(remote, ['show', 'main:' + REL]));
            assert.equal(remoteIds2.filter((id) => id === 'knowledge:decision:pm-REQ-100').length, 1, 'still exactly one node');

            // A second distinct request appends a second node.
            const r3 = runCycle('REQ-200', 'second approval');
            assert.equal(r3['pushed'], true);
            const remoteIds3 = nodeIdsOf(git(remote, ['show', 'main:' + REL]));
            assert.deepEqual(remoteIds3.sort(), ['knowledge:decision:pm-REQ-100', 'knowledge:decision:pm-REQ-200'], 'two distinct decisions, no loss');
            console.log('  ✓ W3-T3 CLAIM 3: pm-memory-cycle full loop lands + pushes; same requestId re-run idempotent');
        } finally { fs.rmSync(base, { recursive: true, force: true }); }
    }

    console.log('pm-cycle: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
