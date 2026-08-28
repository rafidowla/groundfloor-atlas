/**
 * tests/g3.test.ts — G-3 cross-repo code traversal (MVP) end-to-end.
 *
 * Two fixture repos, A and B, where A depends on B BY PACKAGE NAME (A imports
 * the bare module `pkg-b`, which is B's package.json `name`). Each is indexed
 * into its OWN EmbeddedLore (real kuzu+lancedb+e5-small), then exported TWICE:
 *
 *   - moat:       `.atlas/memory.jsonl`   via exportMemory      (knowledge-only)
 *   - code-graph: `.atlas/code-graph.jsonl` via exportCodeGraph (code-only)
 *
 * CLAIMS:
 *   MOAT  — the moat export is STILL knowledge-only: NO code_* node, and a code
 *           node hand-injected into a moat file is REFUSED on import (the
 *           allowedTypes=KNOWLEDGE_TYPE_SET guard holds).
 *   ARTIFACT — the opt-in code-graph artifact carries code nodes AND real
 *           vectors (v2 header; the code_context card ships a numeric embedding).
 *   COLOAD — group-load A+B (with their code graphs) makes BOTH code graphs
 *           co-resident in one store (repo-A files AND repo-B files present).
 *   BRIDGE — the import node `code-import:pkg-b` is linked to member-B's
 *           repo-root folder via a `resolves_to` edge (the cross-repo hop).
 *   TRAVERSE — a subgraph BFS centered on a repo-A file reaches a repo-B node
 *           across the bridge.
 *   KNOWLEDGE-ONLY GROUP — a group whose members shipped NO code-graph artifact
 *           still co-loads knowledge + resolves the cross-seam edge, with
 *           codeNodeCount 0 and no bridge (graceful absence).
 *
 * Mirrors groups.test.ts (real in-process Lore) + gf3.test.ts (the index
 * builders). ATLAS_CONTEXT_LAYER is left DEFAULT-ON so the code_context card
 * (and its vector) exists — that's the ARTIFACT vector assertion.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';
import { exportMemory, loadGroup, importMemory, KNOWLEDGE_TYPE_SET } from '../src/cli/memorySync.js';
import { exportCodeGraph, CODE_TYPES, MEMBER_CODEGRAPH_RELPATH } from '../src/cli/codeGraphSync.js';
import { MEMBER_MEMORY_RELPATH } from '../src/cli/groups.js';
import { buildSubgraph } from '../src/graph/subgraph.js';
import { codeFolderId, codeImportId, codeFileId } from '../src/store/codeNodes.js';
import { repoSlug } from '../src/cli/repoId.js';
import type { StoreNodeInput, StoreEdgeInput } from '../src/loreClient.js';

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-g3-${tag}-`));
}

const CODE_TYPE_SET = new Set<string>(CODE_TYPES);

/** Index a repo's parsed files into `lore`, writing the same node/edge set
 *  `atlas index` would (file + symbol + folder + import nodes; contains +
 *  resolved + file→import edges; context cards). Uses the real builders. */
async function indexRepo(lore: EmbeddedLore, root: string, workspace: string, repo: string): Promise<void> {
    const { parseFile } = await import('../src/parser/index.js');
    const { buildSymbolTable } = await import('../src/resolver/symbolTable.js');
    const { buildResolutionContext } = await import('../src/resolver/importGraph.js');
    const { buildAllCodeEdges, groupRelationsBySourceFile, collectExternalModules } = await import('../src/resolver/index.js');
    const { buildIndexBatch, buildFolderBatch, buildImportNodes } = await import('../src/store/codeNodes.js');

    const tsFiles = fs.readdirSync(root).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, f));
    const parsedFiles = [];
    for (const abs of tsFiles) {
        const pf = await parseFile(abs, root);
        if (pf) parsedFiles.push({ pf, abs });
    }
    const files = parsedFiles.map((p) => p.pf);
    const table = buildSymbolTable(files);
    const ctx = await buildResolutionContext(root, files);
    const relsByFile = groupRelationsBySourceFile(buildAllCodeEdges(files, table, ctx), table);

    // Folder tree + external-import nodes (once per repo).
    const folderBatch = buildFolderBatch(files, { workspace, repo });
    const importNodes = buildImportNodes(collectExternalModules(files, table, ctx), { workspace });
    for (const n of [...folderBatch.nodes, ...importNodes]) await lore.storeNode(n);
    for (const e of folderBatch.edges) { try { await lore.storeEdge(e); } catch { /* dangling ok */ } }

    // Per-file batch (file + symbol + context nodes; contains + resolved +
    // file→import edges).
    for (const { pf, abs } of parsedFiles) {
        const batch = await buildIndexBatch(pf, { workspace, repo, absolutePath: abs }, relsByFile.get(pf.path) ?? []);
        for (const n of batch.nodes) await lore.storeNode(n);
        for (const e of batch.edges) { try { await lore.storeEdge(e); } catch { /* dangling ok */ } }
    }
}

/** Build fixture repo B: a package named `pkg-b` exporting a function. */
function writeRepoB(): string {
    const root = tmpDir('repoB-co');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pkg-b', version: '1.0.0' }, null, 2));
    fs.writeFileSync(
        path.join(root, 'index.ts'),
        `export function greetFromB(name: string): string {\n` +
        `    return 'hello ' + name + ' from B';\n` +
        `}\n`,
    );
    return root;
}

/** Build fixture repo A: depends on B by the bare module name `pkg-b`. */
function writeRepoA(): string {
    const root = tmpDir('repoA-co');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }, null, 2));
    fs.writeFileSync(
        path.join(root, 'main.ts'),
        `import { greetFromB } from 'pkg-b';\n` +
        `export function runA(): string {\n` +
        `    return greetFromB('world');\n` +
        `}\n`,
    );
    return root;
}

/** Export both moat + code-graph for a repo into <root>/.atlas/. */
async function exportRepo(root: string, workspace: string, repo: string, opts: { seedKnowledge?: (lore: EmbeddedLore) => Promise<void> } = {}): Promise<void> {
    const dataDir = tmpDir('data');
    const lore = await EmbeddedLore.open(dataDir);
    await lore.connect();
    try {
        await indexRepo(lore, root, workspace, repo);
        if (opts.seedKnowledge) await opts.seedKnowledge(lore);
        // Settle embeds so the v2 precomputed path fires for the context cards.
        await new Promise((res) => setTimeout(res, 1500));
        const moatOut = path.join(root, MEMBER_MEMORY_RELPATH);
        const cgOut = path.join(root, MEMBER_CODEGRAPH_RELPATH);
        fs.mkdirSync(path.dirname(moatOut), { recursive: true });
        await exportMemory(lore, workspace, moatOut);
        await exportCodeGraph(lore, workspace, cgOut);
    } finally {
        await lore.close();
    }
}

/** Read a JSONL artifact into its header + node/edge lines. */
function readArtifact(file: string): { header: Record<string, unknown>; nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const header = lines[0]!;
    const nodes = lines.slice(1).filter((l) => l['kind'] === 'node');
    const edges = lines.slice(1).filter((l) => l['kind'] === 'edge');
    return { header, nodes, edges };
}

async function main(): Promise<void> {
    console.log('Running G-3 (cross-repo code traversal) tests…');

    const repoA = writeRepoA();
    const repoB = writeRepoB();
    const slugA = repoSlug(repoA);
    const slugB = repoSlug(repoB);

    // Export both repos (A seeds a decision that cross-seam-references B's).
    await exportRepo(repoA, 'pkg-a-ws', slugA, {
        seedKnowledge: async (lore) => {
            await lore.storeNode({ id: 'a/dec-001', type: 'decision', label: 'A uses B', workspace: 'pkg-a-ws', embed: true, content: 'A depends on B' } as StoreNodeInput);
            // Cross-seam edge: A's decision → B's decision. Same pattern as
            // memory-edges.test.ts CLAIM 2 — the foreign target is stored in a
            // DIFFERENT workspace in the SAME store so the author-time storeEdge
            // succeeds (both endpoints physically exist), but it's out-of-scope
            // for A's export so ONLY the edge (not the foreign node) is carried
            // into A's memory.jsonl. It then resolves at group-load when B is
            // co-loaded with its real b/dec-001.
            await lore.storeNode({ id: 'b/dec-001', type: 'decision', label: 'B (foreign ref)', workspace: 'foreign-ws', embed: true, content: 'foreign target placeholder' } as StoreNodeInput);
            await lore.storeEdge({ sourceId: 'a/dec-001', targetId: 'b/dec-001', relation: 'depends_on', workspace: 'pkg-a-ws' } as StoreEdgeInput);
        },
    });
    await exportRepo(repoB, 'pkg-b-ws', slugB, {
        seedKnowledge: async (lore) => {
            await lore.storeNode({ id: 'b/dec-001', type: 'decision', label: 'B greeting API', workspace: 'pkg-b-ws', embed: true, content: 'B exposes greetFromB' } as StoreNodeInput);
        },
    });

    const moatA = readArtifact(path.join(repoA, MEMBER_MEMORY_RELPATH));
    const cgA = readArtifact(path.join(repoA, MEMBER_CODEGRAPH_RELPATH));
    const cgB = readArtifact(path.join(repoB, MEMBER_CODEGRAPH_RELPATH));

    /* ── CLAIM MOAT: memory.jsonl is STILL knowledge-only ─────────────── */
    {
        const moatTypes = new Set(moatA.nodes.map((n) => n['type'] as string));
        for (const t of moatTypes) {
            assert.ok(KNOWLEDGE_TYPE_SET.has(t), `moat node type '${t}' is a knowledge type`);
            assert.ok(!CODE_TYPE_SET.has(t), `moat carries NO code type (saw '${t}')`);
        }
        assert.ok(moatA.nodes.some((n) => n['id'] === 'a/dec-001'), 'moat carries the knowledge decision');
        assert.ok(!moatA.nodes.some((n) => CODE_TYPE_SET.has(n['type'] as string)), 'moat has zero code nodes');
        assert.equal((moatA.header['exportedTypes'] as string[]).join(','),
            'decision,convention,bug_pattern,troubleshooting,architecture', 'moat header lists only knowledge types');

        // The import guard: a code node hand-injected into a moat file is REFUSED.
        const tainted = tmpDir('tainted');
        const taintedFile = path.join(tainted, 'memory.jsonl');
        fs.writeFileSync(taintedFile,
            JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sourceWorkspace: 'x', exportedTypes: ['decision'] }) + '\n' +
            JSON.stringify({ kind: 'node', id: 'd1', type: 'decision', label: 'ok' }) + '\n' +
            JSON.stringify({ kind: 'node', id: 'code-file:x/evil.ts', type: 'code_file', label: 'evil' }) + '\n',
        );
        const guardData = tmpDir('guard-data');
        const guardLore = await EmbeddedLore.open(guardData);
        await guardLore.connect();
        try {
            const r = await importMemory(guardLore, 'guard-ws', taintedFile);
            assert.equal(r.nodeCount, 1, 'only the knowledge node imported from a tainted moat file');
            assert.equal(r.skipped, 1, 'the code node was REFUSED (skipped) by the moat guard');
        } finally {
            await guardLore.close();
        }
        console.log('  ✓ MOAT: memory.jsonl knowledge-only; code nodes refused on moat import');
    }

    /* ── CLAIM ARTIFACT: code-graph carries code nodes + real vectors ─── */
    {
        assert.equal(cgA.header['version'], 2, 'code-graph header is v2 (precomputed vectors)');
        const cgTypes = new Set(cgA.nodes.map((n) => n['type'] as string));
        assert.ok([...cgTypes].every((t) => CODE_TYPE_SET.has(t)), `code-graph carries ONLY code types (saw ${[...cgTypes].join(',')})`);
        assert.ok(cgA.nodes.some((n) => n['type'] === 'code_file'), 'code-graph has code_file nodes');
        assert.ok(cgA.nodes.some((n) => n['type'] === 'code_import' && (n['id'] as string) === codeImportId('pkg-b')),
            'code-graph A has the code-import:pkg-b node (the bridge join key)');
        assert.ok(cgA.nodes.some((n) => CODE_TYPE_SET.has(n['type'] as string)), 'code-graph has code nodes (the opposite of the moat)');

        // The context card ships a REAL numeric vector (A0 precomputed path).
        const ctxWithVec = cgA.nodes.find((n) => n['type'] === 'code_context' && Array.isArray(n['embedding']) && (n['embedding'] as number[]).length > 0);
        assert.ok(ctxWithVec, 'a code_context node carries a precomputed embedding vector');
        assert.ok((ctxWithVec!['embedding'] as number[]).every((v) => Number.isFinite(v)), 'the shipped vector is all-finite (real, not poisoned)');
        // Graph-only types never carry a vector.
        assert.ok(!cgA.nodes.some((n) => n['type'] === 'code_file' && n['embedding'] !== undefined), 'code_file nodes ship vector-less');
        console.log('  ✓ ARTIFACT: code-graph.jsonl carries code nodes + real precomputed context vectors; graph-only types vector-less');
    }

    /* ── CLAIMS COLOAD + BRIDGE + TRAVERSE: group-load A+B with code ──── */
    {
        const groupData = tmpDir('group-data');
        const grp = await EmbeddedLore.open(groupData);
        await grp.connect();
        try {
            const r = await loadGroup(grp, 'ab-group', [
                { file: path.join(repoA, MEMBER_MEMORY_RELPATH), project: 'pkg-a', codeGraphFile: path.join(repoA, MEMBER_CODEGRAPH_RELPATH), repoSlug: slugA, packageName: 'pkg-a' },
                { file: path.join(repoB, MEMBER_MEMORY_RELPATH), project: 'pkg-b', codeGraphFile: path.join(repoB, MEMBER_CODEGRAPH_RELPATH), repoSlug: slugB, packageName: 'pkg-b' },
            ]);

            // COLOAD — both code graphs co-resident.
            assert.ok(r.codeNodeCount > 0, `code nodes co-loaded (got ${r.codeNodeCount})`);
            const filesA = await grp.listNodes('code_file', undefined, 'pkg-a');
            const filesB = await grp.listNodes('code_file', undefined, 'pkg-b');
            assert.ok(filesA.length > 0, 'repo-A code_file nodes present in the group store');
            assert.ok(filesB.length > 0, 'repo-B code_file nodes present in the group store');

            // Cross-seam KNOWLEDGE edge resolved too (A's dec → B's dec).
            assert.ok(await grp.edgeExists('a/dec-001', 'b/dec-001', 'depends_on'), 'cross-seam knowledge edge resolved at co-load');

            // BRIDGE — code-import:pkg-b → code-folder:<slugB>/. resolves_to.
            assert.ok(r.bridgeEdges.length >= 1, `at least one cross-repo bridge authored (got ${r.bridgeEdges.length})`);
            const bridge = r.bridgeEdges.find((b) => b.module === 'pkg-b' && b.member === 'pkg-b');
            assert.ok(bridge, `bridge for module pkg-b → member pkg-b present; got ${JSON.stringify(r.bridgeEdges)}`);
            const rootFolderB = codeFolderId('.', slugB);
            assert.equal(bridge!.targetId, rootFolderB, 'bridge targets B\'s repo-root folder');
            assert.ok(await grp.edgeExists(codeImportId('pkg-b'), rootFolderB, 'resolves_to'), 'bridge resolves_to edge persisted in the graph');

            // TRAVERSE — a subgraph centered on a repo-A file reaches a repo-B
            // node across the bridge. No nodeTypes filter (so code_import +
            // code_folder are traversable — the documented cross-repo rule);
            // depth high enough to cross center→import→folder-B→file-B.
            const centerA = codeFileId({ path: 'main.ts' } as never, slugA);
            const sub = await buildSubgraph(grp, 'pkg-a', { center: centerA, depth: 5, maxNodes: 1000 });
            const reachedB = sub.nodes.some((n) => n.id.includes(`${slugB}/`) || n.id === rootFolderB);
            assert.ok(reachedB, `subgraph centered in A reached a B node via the bridge; got ${JSON.stringify(sub.nodes.map((n) => n.id))}`);
            // The import node itself is on the path.
            assert.ok(sub.nodes.some((n) => n.id === codeImportId('pkg-b')), 'the code-import:pkg-b bridge node is on the traversal path');

            console.log('  ✓ COLOAD+BRIDGE+TRAVERSE: both code graphs co-resident; code-import:pkg-b → B root-folder bridge; A-centered subgraph crosses into B');
        } finally {
            await grp.close();
        }
    }

    /* ── CLAIM KNOWLEDGE-ONLY GROUP: graceful absence ─────────────────── */
    {
        // Same two members, but DO NOT pass codeGraphFile → no code co-load.
        const koData = tmpDir('ko-data');
        const ko = await EmbeddedLore.open(koData);
        await ko.connect();
        try {
            const r = await loadGroup(ko, 'ko-group', [
                { file: path.join(repoA, MEMBER_MEMORY_RELPATH), project: 'pkg-a' },
                { file: path.join(repoB, MEMBER_MEMORY_RELPATH), project: 'pkg-b' },
            ]);
            assert.equal(r.codeNodeCount, 0, 'knowledge-only group co-loads ZERO code nodes');
            assert.equal(r.bridgeEdges.length, 0, 'knowledge-only group authors NO bridge');
            assert.ok(r.nodeCount >= 2, 'knowledge nodes still co-loaded');
            // Cross-seam knowledge edge STILL resolves — knowledge path untouched.
            assert.ok(await ko.edgeExists('a/dec-001', 'b/dec-001', 'depends_on'), 'cross-seam knowledge edge resolves without any code graph');
            // No code nodes leaked into the store.
            const koFiles = await ko.listNodes('code_file', undefined, 'pkg-a');
            assert.equal(koFiles.length, 0, 'no code_file nodes in a knowledge-only group');
            console.log('  ✓ KNOWLEDGE-ONLY GROUP: recall + cross-seam edge intact; codeNodeCount 0, no bridge (graceful absence)');
        } finally {
            await ko.close();
        }
    }

    // Cleanup fixture checkouts.
    for (const d of [repoA, repoB]) fs.rmSync(d, { recursive: true, force: true });

    console.log('All G-3 cross-repo code traversal tests passed.');
}

await main();
