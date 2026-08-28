/**
 * tests/repo-id.test.ts — git-aware repo-slug guard (PART 1 hardening).
 *
 * The <repo> namespace baked into code-node ids used to be a bare directory
 * basename, so two repos cloned to same-basename dirs (or both "src") collided
 * in a shared group store. `repoSlug(dirAbs)` now derives a STABLE slug from
 * the git origin remote. This test locks in the contract:
 *
 *   CLAIM A — SAME basename, DIFFERENT remote ⇒ DIFFERENT slug (no collision).
 *   CLAIM B — SAME remote ⇒ SAME slug (stable across checkouts/machines).
 *   CLAIM C — NON-git dir ⇒ falls back to path.basename (legacy behavior).
 *   CLAIM D — slugifyRemote normalization is deterministic + fs-safe for the
 *             documented URL shapes (scp-style, https, trailing .git).
 *
 * Pure unit test — only needs git on PATH (already required by groups.ts).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoSlug, slugifyRemote } from '../src/cli/repoId.js';

function tmpRoot(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-repoid-${tag}-`));
}

/** Create a git repo at <parent>/<basename> with the given origin remote. */
function gitRepoWithRemote(parent: string, basename: string, remote: string): string {
    const dir = path.join(parent, basename);
    fs.mkdirSync(dir, { recursive: true });
    const run = (args: string[]) => {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 5000 });
        if (r.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? r.stdout ?? ''}`);
        }
    };
    run(['init', '-q']);
    run(['remote', 'add', 'origin', remote]);
    return dir;
}

async function main(): Promise<void> {
    console.log('Atlas git-aware repo-slug tests');

    // ── CLAIM D — pure normalization (no git needed) ──────────────────────────
    {
        assert.equal(
            slugifyRemote('git@github.com:groundfloor/atlas.git'),
            'github.com-groundfloor-atlas',
            'scp-style git@host:org/repo.git normalizes',
        );
        assert.equal(
            slugifyRemote('https://github.com/groundfloor/lore.git'),
            'github.com-groundfloor-lore',
            'https://host/org/repo.git normalizes',
        );
        assert.equal(
            slugifyRemote('https://github.com/groundfloor/lore'),
            'github.com-groundfloor-lore',
            'trailing .git is optional — same slug either way',
        );
        assert.equal(
            slugifyRemote('ssh://git@host.example:22/team/repo.git'),
            'host.example-22-team-repo',
            'ssh:// with port + user normalizes deterministically',
        );
        // fs-safe: only [a-z0-9._-], lowercase, no separators.
        const slug = slugifyRemote('git@GitHub.com:Group_Floor/At las.git')!;
        assert.match(slug, /^[a-z0-9._-]+$/, 'slug is filesystem-safe + lowercased');
        console.log('  ✓ CLAIM D: slugifyRemote normalization is deterministic + fs-safe');
    }

    // ── CLAIM A — same basename, different remote ⇒ different slug ─────────────
    {
        const parentA = tmpRoot('a');
        const parentB = tmpRoot('b');
        // Both directories are literally named "src" — the classic collision.
        const repoA = gitRepoWithRemote(parentA, 'src', 'git@github.com:teamA/widgets.git');
        const repoB = gitRepoWithRemote(parentB, 'src', 'git@github.com:teamB/widgets.git');

        assert.equal(path.basename(repoA), path.basename(repoB), 'precondition: identical basenames');
        const slugA = repoSlug(repoA);
        const slugB = repoSlug(repoB);
        assert.notEqual(slugA, slugB, `same-basename repos with different remotes must NOT collide (got ${slugA} vs ${slugB})`);
        assert.equal(slugA, 'github.com-teama-widgets', 'slug derives from the remote, not the basename');
        assert.equal(slugB, 'github.com-teamb-widgets', 'slug derives from the remote, not the basename');
        console.log('  ✓ CLAIM A: same basename + different remotes ⇒ distinct slugs (no collision)');
    }

    // ── CLAIM B — same remote ⇒ same slug (stable across checkouts) ────────────
    {
        const parent1 = tmpRoot('c1');
        const parent2 = tmpRoot('c2');
        // Two checkouts of the SAME repo, under DIFFERENT local dir names.
        const checkout1 = gitRepoWithRemote(parent1, 'atlas-mine', 'git@github.com:groundfloor/atlas.git');
        const checkout2 = gitRepoWithRemote(parent2, 'atlas-theirs', 'git@github.com:groundfloor/atlas.git');

        assert.notEqual(path.basename(checkout1), path.basename(checkout2), 'precondition: different basenames');
        assert.equal(
            repoSlug(checkout1),
            repoSlug(checkout2),
            'two checkouts of the same remote slug identically (stable across machines)',
        );
        assert.equal(repoSlug(checkout1), 'github.com-groundfloor-atlas', 'stable slug value');
        console.log('  ✓ CLAIM B: same remote ⇒ same slug regardless of local dir name');
    }

    // ── CLAIM C — non-git dir ⇒ basename fallback (legacy behavior) ────────────
    {
        const parent = tmpRoot('plain');
        const plain = path.join(parent, 'scratch-dir');
        fs.mkdirSync(plain, { recursive: true });
        assert.equal(repoSlug(plain), 'scratch-dir', 'non-git dir falls back to path.basename');

        // A git repo with NO origin remote also falls back to basename.
        const noRemote = path.join(parent, 'no-origin');
        fs.mkdirSync(noRemote, { recursive: true });
        spawnSync('git', ['-C', noRemote, 'init', '-q'], { encoding: 'utf-8', timeout: 5000 });
        assert.equal(repoSlug(noRemote), 'no-origin', 'git repo without origin falls back to path.basename');
        console.log('  ✓ CLAIM C: non-git dir + git-without-origin both fall back to basename (legacy)');
    }

    console.log('All git-aware repo-slug tests passed.');
}

await main();
