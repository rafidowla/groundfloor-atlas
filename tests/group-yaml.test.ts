/**
 * tests/group-yaml.test.ts — IN-REPO group.yaml travels-via-git guard (PART 2).
 *
 * G-1 groups live only in a per-machine registry, so a teammate cloning an
 * anchor repo inherits nothing. PART 2 adds `<anchorRepo>/.atlas/group.yaml`:
 * a committed declaration that references members by STABLE repoSlug + a
 * relative path hint, resolved on the loading machine. This test locks in:
 *
 *   CLAIM A — WRITE/READ: writeGroupYaml emits a parseable group.yaml; the
 *             minimal parser round-trips name + members (remote slug + path).
 *   CLAIM B — RESOLVE via PATH HINT: with no registry, members resolve through
 *             their relative `path` hint against the anchor dir.
 *   CLAIM C — RESOLVE via REGISTRY: a member's `remote` slug matched in
 *             atlas-registry.json wins (remote→path), preferred over the hint.
 *   CLAIM D — CO-LOAD: loadGroup over the yaml-resolved members co-loads BOTH;
 *             store-wide recall finds both; each carries source-repo provenance.
 *   CLAIM E — DEGRADE: a member that resolves to nothing (bad remote + bad path)
 *             is skipped+warned, not fatal — the rest still load.
 *
 * Runs against a real in-process Lore (kuzu+lancedb+e5-small), like
 * groups.test.ts / memory-edges.test.ts.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { exportMemory, loadGroup } from '../src/cli/memorySync.js';
import { MEMBER_MEMORY_RELPATH } from '../src/cli/groups.js';
import {
    writeGroupYaml,
    readGroupYaml,
    parseGroupYaml,
    hasGroupYaml,
    resolveYamlGroup,
    buildRemoteToPath,
    GROUP_YAML_RELPATH,
} from '../src/cli/groupYaml.js';
import { repoSlug } from '../src/cli/repoId.js';
import type { StoreNodeInput } from '../src/loreClient.js';

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-gyaml-${tag}-`));
}

function decisionNode(id: string, label: string, ws: string, content?: string): StoreNodeInput {
    return { id, type: 'decision', label, workspace: ws, embed: true, content: content ?? label } as StoreNodeInput;
}

/** git init + set an origin remote so repoSlug resolves to a stable slug. */
function gitInitWithRemote(dir: string, remote: string): void {
    const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 5000 });
    run(['init', '-q']);
    run(['remote', 'add', 'origin', remote]);
}

/** Build a member checkout dir (git repo w/ remote) + a seeded .atlas/memory.jsonl. */
async function seedMember(
    parent: string,
    basename: string,
    remote: string,
    ws: string,
    seed: (lore: EmbeddedLore) => Promise<void>,
): Promise<string> {
    const checkout = path.join(parent, basename);
    fs.mkdirSync(checkout, { recursive: true });
    gitInitWithRemote(checkout, remote);
    const dataDir = tmpDir(`${basename}-data`);
    const lore = await EmbeddedLore.open(dataDir);
    await lore.connect();
    try {
        await seed(lore);
        await new Promise((res) => setTimeout(res, 1500)); // let vectors settle → v2 export
        const out = path.join(checkout, MEMBER_MEMORY_RELPATH);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await exportMemory(lore, ws, out);
    } finally {
        await lore.close();
    }
    return checkout;
}

async function main(): Promise<void> {
    console.log('Atlas in-repo group.yaml (travels-via-git) tests');

    const SRC_WS = 'developer';
    // A shared parent so the relative path hints (../<member>) resolve from the
    // anchor dir, mirroring a real sibling-repo layout.
    const workspaceRoot = tmpDir('root');

    const atlasRemote = 'git@github.com:groundfloor/atlas.git';
    const loreRemote = 'git@github.com:groundfloor/lore.git';

    const atlasCheckout = await seedMember(workspaceRoot, 'groundfloor-atlas', atlasRemote, SRC_WS, async (lore) => {
        await lore.storeNode(decisionNode(
            'atlas/dec-parse', 'atlas parsing strategy', SRC_WS,
            'Atlas indexes source with tree-sitter incremental parse on save, repo-qualified symbol ids.',
        ));
    });
    const loreCheckout = await seedMember(workspaceRoot, 'groundfloor-lore', loreRemote, SRC_WS, async (lore) => {
        await lore.storeNode(decisionNode(
            'lore/dec-embed', 'lore embedding model', SRC_WS,
            'Lore embeds knowledge with the e5-small multilingual model at 384 dimensions in LanceDB.',
        ));
    });

    // The anchor repo is the atlas checkout itself (its .atlas/ holds group.yaml).
    const anchorDir = atlasCheckout;

    // ── CLAIM A — write + read/parse round-trip ───────────────────────────────
    {
        const decl = writeGroupYaml(anchorDir, 'atlas-lore', [atlasCheckout, loreCheckout]);
        assert.equal(decl.name, 'atlas-lore', 'declaration carries its name');
        assert.equal(decl.members.length, 2, 'both members written');

        assert.ok(hasGroupYaml(anchorDir), 'hasGroupYaml detects the written file');
        assert.ok(fs.existsSync(path.join(anchorDir, GROUP_YAML_RELPATH)), '.atlas/group.yaml exists on disk');

        const readBack = readGroupYaml(anchorDir)!;
        assert.equal(readBack.name, 'atlas-lore', 'name round-trips through the parser');
        const byName = new Map(readBack.members.map((m) => [m.name, m]));
        const atlasM = byName.get('groundfloor-atlas')!;
        const loreM = byName.get('groundfloor-lore')!;
        assert.equal(atlasM.remote, repoSlug(atlasCheckout), 'atlas member remote = its repoSlug');
        assert.equal(loreM.remote, repoSlug(loreCheckout), 'lore member remote = its repoSlug');
        assert.equal(atlasM.remote, 'github.com-groundfloor-atlas', 'atlas slug value stable');
        assert.equal(loreM.remote, 'github.com-groundfloor-lore', 'lore slug value stable');
        // The lore member's path hint is relative to the anchor dir.
        assert.ok(loreM.path && !path.isAbsolute(loreM.path), 'path hint is RELATIVE (travels across machines)');
        assert.equal(path.resolve(anchorDir, loreM.path!), path.resolve(loreCheckout), 'path hint resolves back to the lore checkout');
        console.log('  ✓ CLAIM A: writeGroupYaml → .atlas/group.yaml; parser round-trips name + remote slug + relative path hint');
    }

    // Sanity: the minimal parser tolerates comments + quotes + blank lines.
    {
        const decl = parseGroupYaml([
            '# a hand-written group',
            'name: "hand-authored"',
            '',
            'members:',
            "  - name: 'atlas'",
            '    remote: github.com-groundfloor-atlas  # the slug',
            '    path: ../groundfloor-atlas',
            '  - name: lore',
            '    remote: github.com-groundfloor-lore',
            '    path: ../groundfloor-lore',
        ].join('\n'))!;
        assert.equal(decl.name, 'hand-authored', 'quoted top-level scalar unquoted');
        assert.equal(decl.members.length, 2, 'both hand-authored members parsed');
        assert.equal(decl.members[0]!.name, 'atlas', 'quoted member name unquoted');
        assert.equal(decl.members[0]!.remote, 'github.com-groundfloor-atlas', 'inline comment stripped from value');
        console.log('  ✓ CLAIM A: hand-authored YAML (comments/quotes/blanks) parses');
    }

    // ── CLAIM B — resolve via PATH HINT (no registry) ─────────────────────────
    {
        const decl = readGroupYaml(anchorDir)!;
        // Empty registry → no remote match; resolution falls through to path hint.
        const resolved = resolveYamlGroup(decl, anchorDir, { remoteToPath: new Map() });
        assert.ok(resolved.every((m) => !m.skipped), 'both members resolve via path hint');
        assert.ok(resolved.every((m) => m.resolvedVia === 'path-hint'), 'resolved via the relative path hint');
        assert.ok(resolved.every((m) => m.memoryPath && fs.existsSync(m.memoryPath)), 'each resolved member has a present memory.jsonl');
        console.log('  ✓ CLAIM B: members resolve via the relative path hint when no registry entry exists');
    }

    // ── CLAIM C — resolve via REGISTRY (remote→path) preferred over the hint ──
    {
        const decl = readGroupYaml(anchorDir)!;
        // Write a fixture atlas-registry.json mapping each repo's path; the
        // registry is keyed by repoSlug(path) inside buildRemoteToPath.
        const registryPath = path.join(tmpDir('reg'), 'atlas-registry.json');
        fs.writeFileSync(registryPath, JSON.stringify([
            { name: 'atlas', path: atlasCheckout },
            { name: 'lore', path: loreCheckout },
        ], null, 2));
        const remoteToPath = buildRemoteToPath(registryPath);
        assert.equal(remoteToPath.get('github.com-groundfloor-atlas'), path.resolve(atlasCheckout), 'registry maps atlas slug→path');
        assert.equal(remoteToPath.get('github.com-groundfloor-lore'), path.resolve(loreCheckout), 'registry maps lore slug→path');

        const resolved = resolveYamlGroup(decl, anchorDir, { remoteToPath });
        assert.ok(resolved.every((m) => !m.skipped), 'both members resolve via registry');
        assert.ok(resolved.every((m) => m.resolvedVia === 'registry'), 'registry remote→path is PREFERRED over the path hint');
        console.log('  ✓ CLAIM C: a member whose remote slug is in atlas-registry.json resolves via registry (preferred)');
    }

    // ── CLAIM D — co-load the yaml-resolved members; recall finds both ────────
    {
        const decl = readGroupYaml(anchorDir)!;
        const resolved = resolveYamlGroup(decl, anchorDir, { remoteToPath: new Map() });
        const present = resolved.filter((m) => !m.skipped);
        const inputs = present.map((m) => ({ file: m.memoryPath!, project: m.name }));

        const grp = await EmbeddedLore.open(tmpDir('grp'));
        await grp.connect();
        try {
            const r = await loadGroup(grp, decl.name, inputs);
            assert.equal(r.nodeCount, 2, `yaml group co-loads BOTH members; got ${r.nodeCount}`);

            // provenance stamped per node = source repo.
            const atlasNode = await grp.getNode('atlas/dec-parse') as { project?: string } | null;
            const loreNode = await grp.getNode('lore/dec-embed') as { project?: string } | null;
            assert.equal(atlasNode?.project, 'groundfloor-atlas', 'atlas node carries its source-repo provenance');
            assert.equal(loreNode?.project, 'groundfloor-lore', 'lore node carries its source-repo provenance');

            await new Promise((res) => setTimeout(res, 1500)); // let vectors settle
            const res1 = await grp.recall('how does the system parse and index source code', { max: 10 }) as { hits?: Array<{ id?: string }> };
            const res2 = await grp.recall('what embedding model represents stored knowledge', { max: 10 }) as { hits?: Array<{ id?: string }> };
            const foundAtlas = (res1.hits ?? []).some((h) => h.id === 'atlas/dec-parse');
            const foundLore = (res2.hits ?? []).some((h) => h.id === 'lore/dec-embed');
            assert.ok(foundAtlas, 'cross-project recall finds the atlas decision');
            assert.ok(foundLore, 'cross-project recall finds the lore decision');
            console.log('  ✓ CLAIM D: yaml-resolved members co-load; store-wide recall finds BOTH with provenance');
        } finally {
            await grp.close();
        }
    }

    // ── CLAIM E — degrade: an unresolvable member is skipped+warned, not fatal ─
    {
        // Hand-author a group.yaml whose 2nd member has a bogus remote AND a
        // bogus path hint, so it resolves to nothing.
        const anchor2 = path.join(tmpDir('anchor2'), 'anchor');
        fs.mkdirSync(path.join(anchor2, '.atlas'), { recursive: true });
        const yaml = [
            'name: partial-group',
            'members:',
            '  - name: groundfloor-lore',
            `    remote: github.com-groundfloor-lore`,
            `    path: ${path.relative(anchor2, loreCheckout)}`,
            '  - name: ghost',
            '    remote: github.com-nobody-ghost',
            '    path: ../does-not-exist',
        ].join('\n') + '\n';
        fs.writeFileSync(path.join(anchor2, GROUP_YAML_RELPATH), yaml);

        const decl = readGroupYaml(anchor2)!;
        const resolved = resolveYamlGroup(decl, anchor2, { remoteToPath: new Map() });
        const good = resolved.find((m) => m.name === 'groundfloor-lore')!;
        const ghost = resolved.find((m) => m.name === 'ghost')!;
        assert.equal(good.skipped, false, 'the resolvable member is NOT skipped (path hint works)');
        assert.equal(ghost.skipped, true, 'the member with bad remote + bad path is SKIPPED');
        assert.match(ghost.skipReason ?? '', /no local checkout|did not resolve/i, 'skip reason explains the failure');

        const present = resolved.filter((m) => !m.skipped).map((m) => ({ file: m.memoryPath!, project: m.name }));
        assert.equal(present.length, 1, 'one present member remains loadable');
        const grp = await EmbeddedLore.open(tmpDir('partial-grp'));
        await grp.connect();
        try {
            const r = await loadGroup(grp, decl.name, present);
            assert.equal(r.nodeCount, 1, 'group degrades to the single resolvable member — no throw');
            console.log('  ✓ CLAIM E: an unresolvable member is skipped+warned; the rest still load (degrade-don\'t-fail)');
        } finally {
            await grp.close();
        }
    }

    console.log('All in-repo group.yaml tests passed.');
}

await main();
