/**
 * tests/sprint3.test.ts — Sprint 3 backend contract.
 *
 * Pure, daemon-free tests over hand-rolled fakes + a temp filesystem:
 *
 *   S1  atlas_source returns the requested slice (with context margin) and the
 *       file's total line count, resolved against a REGISTERED repo root.
 *   S2  atlas_source REFUSES a `../` traversal path (security).
 *   S3  atlas_source REFUSES a symlink that points outside the repo root
 *       (stage-2 realpath check).
 *   S4  buildSubgraph carries startLine/endLine/signature/qualifiedName from a
 *       code_symbol's metadata onto the emitted SubgraphNode (item 1).
 *   S5  Community-seed: buildSubgraph({ community }) seeds from the REAL member
 *       fileIds via listCommunityMembership — the formerly zero-caller fn —
 *       returning the community's files (item 5 / 4).
 *
 * Run: tsx tests/sprint3.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSubgraph, type SubgraphReader } from '../src/graph/subgraph.js';

const WS = 'sprint3-ws';

// ── Fake reader ──────────────────────────────────────────────────────────────
//
// Two code_file nodes (A imports B → they couple into ONE community) plus one
// code_symbol in A carrying line/signature/qualifiedName metadata.

interface FakeNode {
    id: string;
    type: string;
    label: string;
    metadata: Record<string, unknown>;
}

const fileA: FakeNode = {
    id: 'code-file:src/a.ts',
    type: 'code_file',
    label: 'src/a.ts',
    metadata: { path: 'src/a.ts', repo: 'demo' },
};
const fileB: FakeNode = {
    id: 'code-file:src/b.ts',
    type: 'code_file',
    label: 'src/b.ts',
    metadata: { path: 'src/b.ts', repo: 'demo' },
};
const symFoo: FakeNode = {
    id: 'code-symbol:src/a.ts#foo',
    type: 'code_symbol',
    label: 'function:foo',
    metadata: {
        name: 'foo',
        qualifiedName: 'A.foo',
        kind: 'function',
        filePath: 'src/a.ts',
        startLine: 12,
        endLine: 20,
        signature: 'function foo(x: number): number',
        repo: 'demo',
    },
};

const ALL_NODES: FakeNode[] = [fileA, fileB, symFoo];

// Edges: A contains foo; A imports B; foo calls into B (symbol→file coupling
// goes through the file projection in communities).
const ALL_EDGES = [
    { sourceId: fileA.id, targetId: symFoo.id, relation: 'contains' },
    { sourceId: fileA.id, targetId: fileB.id, relation: 'imports' },
];

function makeReader(): SubgraphReader {
    return {
        async listNodes(type?: string) {
            return ALL_NODES.filter((n) => !type || n.type === type).map((n) => ({
                id: n.id,
                type: n.type,
                label: n.label,
                metadata: JSON.stringify(n.metadata),
            }));
        },
        async listEdges() {
            return ALL_EDGES.map((e) => ({ ...e }));
        },
        async getNode(id: string) {
            const n = ALL_NODES.find((x) => x.id === id);
            return n ? { id: n.id, type: n.type, label: n.label, metadata: JSON.stringify(n.metadata) } : null;
        },
    };
}

async function main(): Promise<void> {
    // Dynamic import of the source tool AFTER we set LORE_HOME so the registry
    // path picks up our temp registry.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-s3-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-s3-repo-'));
    process.env['LORE_HOME'] = tmpHome;

    // Seed a small file in the repo.
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const fileLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), fileLines.join('\n'), 'utf-8');

    // Write the Atlas registry so codeIndexer.listRepos() finds the root.
    const registry = [
        {
            name: 'demo',
            path: repoRoot,
            storagePath: '',
            indexedAt: new Date().toISOString(),
            lastCommit: '',
            stats: { files: 1, nodes: 0, edges: 0, communities: 0, processes: 0, embeddings: 0 },
        },
    ];
    fs.writeFileSync(path.join(tmpHome, 'atlas-registry.json'), JSON.stringify(registry, null, 2), 'utf-8');

    const { runSourceTool } = await import('../src/mcp/tools/source.js');

    // ── S1: correct slice + total line count ────────────────────────────────
    {
        const res = (await runSourceTool({ path: 'src/a.ts', startLine: 12, endLine: 14, contextMargin: 2 })) as {
            content: string; startLine: number; endLine: number; totalLines: number; absolutePath: string;
        };
        assert.ok(!('error' in res), `S1 unexpected error: ${JSON.stringify(res)}`);
        assert.equal(res.totalLines, 30, 'S1 totalLines');
        // margin 2 → [10, 16]
        assert.equal(res.startLine, 10, 'S1 sliced startLine (12-2)');
        assert.equal(res.endLine, 16, 'S1 sliced endLine (14+2)');
        const got = res.content.split('\n');
        assert.equal(got.length, 7, 'S1 line count in slice');
        assert.equal(got[0], 'line 10', 'S1 first line');
        assert.equal(got[got.length - 1], 'line 16', 'S1 last line');
        assert.ok(res.absolutePath.startsWith(fs.realpathSync(repoRoot)), 'S1 absolutePath under repo root');
        console.error('[S3] S1 slice PASSED');
    }

    // ── S2: traversal escape rejected ───────────────────────────────────────
    {
        const res = (await runSourceTool({ path: '../../../../etc/passwd' })) as { error?: string };
        assert.ok(res.error, 'S2 expected an error for a traversal path');
        assert.match(res.error!, /escapes repo root/, 'S2 escape error message');
        console.error('[S3] S2 traversal-reject PASSED (%s)', res.error);
    }

    // ── S2b: absolute path is also rejected ─────────────────────────────────
    {
        const res = (await runSourceTool({ path: '/etc/passwd' })) as { error?: string };
        assert.ok(res.error, 'S2b expected an error for an absolute path');
        assert.match(res.error!, /escapes repo root/, 'S2b absolute escape message');
        console.error('[S3] S2b absolute-reject PASSED');
    }

    // ── S3: symlink escape rejected (stage-2 realpath check) ────────────────
    {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-s3-outside-'));
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf-8');
        const linkPath = path.join(repoRoot, 'src', 'leak.ts');
        let symlinkSupported = true;
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), linkPath);
        } catch {
            symlinkSupported = false;
        }
        if (symlinkSupported) {
            const res = (await runSourceTool({ path: 'src/leak.ts' })) as { error?: string; content?: string };
            assert.ok(res.error, 'S3 expected a symlink-escape error');
            assert.match(res.error!, /escapes repo root/, 'S3 symlink escape message');
            assert.ok(res.content === undefined, 'S3 must NOT leak symlinked-out content');
            console.error('[S3] S3 symlink-reject PASSED (%s)', res.error);
        } else {
            console.error('[S3] S3 symlink-reject SKIPPED (symlinks unsupported on this fs)');
        }
    }

    // ── S4: subgraph carries symbol line fields ─────────────────────────────
    {
        const reader = makeReader();
        const sg = await buildSubgraph(reader, WS, { center: symFoo.id, depth: 1 });
        const node = sg.nodes.find((n) => n.id === symFoo.id);
        assert.ok(node, 'S4 symbol node present in slice');
        assert.equal(node!.startLine, 12, 'S4 startLine');
        assert.equal(node!.endLine, 20, 'S4 endLine');
        assert.equal(node!.signature, 'function foo(x: number): number', 'S4 signature');
        assert.equal(node!.qualifiedName, 'A.foo', 'S4 qualifiedName');
        // File nodes must NOT carry symbol-only fields.
        const fileNode = sg.nodes.find((n) => n.id === fileA.id);
        if (fileNode) {
            assert.equal(fileNode.startLine, undefined, 'S4 file node has no startLine');
        }
        console.error('[S3] S4 subgraph-line-fields PASSED');
    }

    // ── S5: community seed pulls member files via listCommunityMembership ───
    {
        const reader = makeReader();
        const { listCommunityMembership } = await import('../src/communities/index.js');
        const membership = await listCommunityMembership(reader, WS);
        assert.ok(membership.size >= 1, 'S5 at least one community resolved');
        // Pick the community that holds fileA, then seed the subgraph from it.
        // GF-4: community ids are now content-stable strings, not dense ints.
        let targetCid = '';
        for (const [cid, files] of membership) {
            if (files.includes(fileA.id)) { targetCid = cid; break; }
        }
        assert.ok(targetCid.length > 0, 'S5 found a community containing fileA');

        const sg = await buildSubgraph(reader, WS, {
            community: targetCid,
            nodeTypes: ['code_file'],
            depth: 1,
        });
        const ids = new Set(sg.nodes.map((n) => n.id));
        assert.ok(ids.has(fileA.id), 'S5 community subgraph includes fileA (the seed member)');
        assert.equal(sg.seed, `community:${targetCid}`, 'S5 seed label reflects the community');
        console.error('[S3] S5 community-seed PASSED (cid=%s, %d files)', targetCid, sg.nodes.length);
    }

    console.error('[S3] all Sprint 3 backend tests passed.');
}

main().catch((err) => {
    console.error('[S3] FAILED:', err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
});
