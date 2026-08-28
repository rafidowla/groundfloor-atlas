/**
 * tests/gf3.test.ts — GF-3 (Folder + Import nodes) in-process unit tests.
 * No daemon, no Lore server: parser + resolver + store builders + communities
 * are all pure functions over a hand-rolled fixture / duck-typed reader.
 *
 *   T1 (FOLDER model): buildFolderBatch over a nested-dir file set emits one
 *       code_folder node per unique directory (incl. the root sentinel + every
 *       ancestor prefix), folder→subfolder `contains` edges (each dir → its
 *       parent), and folder→file `contains` edges (each file → its IMMEDIATE
 *       dir only). All structural edges are extracted/1.0.
 *
 *   T2 (IMPORT model, external-only): a fixture importing an INTERNAL relative
 *       module AND an EXTERNAL npm package. The resolver returns the external
 *       module in `externalModules`; buildImportNodes emits ONE repo-UNqualified
 *       `code-import:<module>` node; buildIndexBatch (fed the resolved relations)
 *       produces a file→import `imports` edge to that node — and does NOT emit an
 *       import node/edge for the internal module (that stays a resolved internal
 *       edge).
 *
 *   T3 (COMMUNITIES unchanged): community membership over a file/symbol graph is
 *       IDENTICAL whether or not folder + import pseudo-nodes/edges are present —
 *       i.e. they're excluded from the file-coupling projection so existing
 *       graphs cluster the same.
 *
 * ATLAS_CONTEXT_LAYER is snapshotted at codeNodes module load (gf1 precedent);
 * set it BEFORE the first dynamic import so the context-layer state is
 * deterministic (off — we don't assert on context cards here, and off keeps the
 * edge set lean for the import-edge assertion).
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// MUST precede the codeNodes import (CONTEXT_LAYER_ENABLED snapshot).
process.env['ATLAS_CONTEXT_LAYER'] = '0';

const REPO = 'gf3-fixture-repo';
const WORKSPACE = 'gf3-test-ws';

/* ─── T1: FOLDER model ──────────────────────────────────────────── */

async function testFolderModel(): Promise<void> {
    const { buildFolderBatch, codeFolderId, codeFileId, _CODE_FOLDER_PREFIX } =
        await import('../src/store/codeNodes.js');

    // A synthetic file set spanning nested dirs + a root-level file. We only
    // need ParsedFile.path for the folder synthesis, so build minimal stubs.
    const mkFile = (p: string) => ({ path: p, language: 'typescript', symbols: [], imports: [], calls: [], sizeBytes: 0, loc: 0, parsedAt: '' } as never);
    const files = [
        mkFile('src/a/b/deep.ts'),
        mkFile('src/a/other.ts'),
        mkFile('index.ts'), // root-level → posix.dirname '.' → ROOT_DIR sentinel
    ];

    const { nodes, edges } = buildFolderBatch(files, { workspace: WORKSPACE, repo: REPO });

    // Every node is type code_folder with the folder prefix.
    assert.ok(nodes.every((n) => n.type === 'code_folder'), 'all folder nodes typed code_folder');
    assert.ok(nodes.every((n) => (n.id as string).startsWith(_CODE_FOLDER_PREFIX)), 'all folder ids carry the folder prefix');
    assert.ok(nodes.every((n) => n.embed === false), 'folder nodes are embed:false (structural)');

    // Expected unique dirs: '.', 'src', 'src/a', 'src/a/b'.
    const folderIds = new Set(nodes.map((n) => n.id as string));
    for (const dir of ['.', 'src', 'src/a', 'src/a/b']) {
        assert.ok(folderIds.has(codeFolderId(dir, REPO)), `folder node for '${dir}' exists`);
    }
    assert.equal(nodes.length, 4, `exactly 4 folder nodes (got ${nodes.length})`);

    // folder→subfolder contains edges: src→src/a, src/a→src/a/b, '.'→src.
    const hasEdge = (src: string, tgt: string) =>
        edges.some((e) => e.sourceId === src && e.targetId === tgt && e.relation === 'contains');
    assert.ok(hasEdge(codeFolderId('.', REPO), codeFolderId('src', REPO)), "root → 'src' subfolder edge");
    assert.ok(hasEdge(codeFolderId('src', REPO), codeFolderId('src/a', REPO)), "'src' → 'src/a' subfolder edge");
    assert.ok(hasEdge(codeFolderId('src/a', REPO), codeFolderId('src/a/b', REPO)), "'src/a' → 'src/a/b' subfolder edge");

    // folder→file contains edges: each file attached to its IMMEDIATE dir only.
    assert.ok(hasEdge(codeFolderId('src/a/b', REPO), codeFileId(files[0]!, REPO)), 'src/a/b → deep.ts file edge');
    assert.ok(hasEdge(codeFolderId('src/a', REPO), codeFileId(files[1]!, REPO)), 'src/a → other.ts file edge');
    assert.ok(hasEdge(codeFolderId('.', REPO), codeFileId(files[2]!, REPO)), 'root → index.ts file edge');

    // Strictly hierarchical: deep.ts is NOT attached to every ancestor (only
    // src/a/b). e.g. there must be NO 'src' → deep.ts edge.
    assert.ok(!hasEdge(codeFolderId('src', REPO), codeFileId(files[0]!, REPO)), 'no ancestor-skip file edge (src → deep.ts)');

    // All structural folder edges are extracted/1.0 (same tier as file→symbol).
    assert.ok(edges.every((e) => e.confidence === 'extracted' && e.confidenceScore === 1.0), 'folder edges extracted/1.0');

    console.log('  ✓ T1: folder model — node per dir (+root sentinel), hierarchical folder→subfolder + folder→file contains/1.0');
}

/* ─── T2: IMPORT model (external-only) ──────────────────────────── */

async function testImportModel(): Promise<void> {
    const { parseFile } = await import('../src/parser/index.js');
    const { buildSymbolTable } = await import('../src/resolver/symbolTable.js');
    const { buildResolutionContext, buildImportEdges } = await import('../src/resolver/importGraph.js');
    const { buildAllCodeEdges, groupRelationsBySourceFile, collectExternalModules } = await import('../src/resolver/index.js');
    const { buildIndexBatch, buildImportNodes, codeImportId, codeFileId, _CODE_IMPORT_PREFIX } =
        await import('../src/store/codeNodes.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf3-imp-'));
    try {
        // Internal target the relative import resolves to.
        fs.writeFileSync(path.join(dir, 'util.ts'), `export function helper(): number { return 1; }\n`);
        // Importer: one INTERNAL relative import + one EXTERNAL npm package.
        const mainPath = path.join(dir, 'main.ts');
        fs.writeFileSync(
            mainPath,
            `import { helper } from './util.js';\n` +
            `import { readFileSync } from 'fs-extra';\n` +
            `export function run(): number { return helper(); }\n`,
        );

        const main = (await parseFile(mainPath, dir))!;
        const util = (await parseFile(path.join(dir, 'util.ts'), dir))!;
        assert.ok(main && util, 'both fixtures parsed');
        const files = [main, util];

        const table = buildSymbolTable(files);
        const ctx = await buildResolutionContext(dir, files);

        // (a) The resolver flags ONLY the external module.
        const ie = buildImportEdges(files, table, ctx);
        assert.ok(ie.externalModules.has('fs-extra'), "external module 'fs-extra' captured");
        assert.ok(!ie.externalModules.has('./util.js'), 'internal relative module NOT captured as external');

        // (b) collectExternalModules mirrors that; buildImportNodes emits ONE
        //     repo-UNqualified node (id has NO repo prefix in the module part).
        const externals = collectExternalModules(files, table, ctx);
        const importNodes = buildImportNodes(externals, { workspace: WORKSPACE });
        const fsExtraId = codeImportId('fs-extra');
        assert.equal(fsExtraId, `${_CODE_IMPORT_PREFIX}fs-extra`, 'import id is repo-UNqualified (code-import:<module>)');
        const node = importNodes.find((n) => n.id === fsExtraId);
        assert.ok(node, 'code_import node for fs-extra emitted');
        assert.equal(node!.type, 'code_import', 'node typed code_import');
        assert.equal(node!.embed, false, 'import node embed:false');
        // Exactly one node (deduped) and none for the internal module.
        assert.equal(importNodes.length, 1, `exactly one import node (got ${importNodes.length})`);

        // (c) file→import `imports` edge lands on that node via buildIndexBatch.
        const relsByFile = groupRelationsBySourceFile(buildAllCodeEdges(files, table, ctx), table);
        const batch = await buildIndexBatch(
            main,
            { workspace: WORKSPACE, repo: REPO, absolutePath: mainPath },
            relsByFile.get(main.path) ?? [],
        );
        const mainFileId = codeFileId(main, REPO);
        const importEdge = batch.edges.find(
            (e) => e.relation === 'imports' && e.sourceId === mainFileId && e.targetId === fsExtraId,
        );
        assert.ok(importEdge, `file→import edge main.ts → code-import:fs-extra present; got ${JSON.stringify(batch.edges.map((e) => [e.relation, e.sourceId, e.targetId]))}`);

        // (d) The INTERNAL import did NOT produce a code-import edge — it resolved
        //     to an internal file/symbol edge instead (no edge targets a
        //     code-import: node for util).
        const internalImportEdges = batch.edges.filter(
            (e) => (e.targetId as string).startsWith(_CODE_IMPORT_PREFIX) && (e.targetId as string).includes('util'),
        );
        assert.equal(internalImportEdges.length, 0, 'internal import NOT duplicated as a code_import edge');

        console.log('  ✓ T2: import model — external-only code_import node (repo-unqualified, deduped) + file→import edge; internal import untouched');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ─── T3: COMMUNITIES unchanged (folder/import excluded) ────────── */

/** A CommunityReader fake over in-memory node/edge arrays. */
function makeCommunityReader(
    nodes: Array<{ id: string; type: string; label?: string; metadata?: string }>,
    edges: Array<{ sourceId: string; targetId: string; relation: string }>,
) {
    return {
        async listNodes(type?: string): Promise<unknown[]> {
            return type ? nodes.filter((n) => n.type === type) : nodes;
        },
        async listEdges(): Promise<Array<{ sourceId: string; targetId: string; relation: string }>> {
            return edges;
        },
    };
}

async function testCommunitiesUnchanged(): Promise<void> {
    const { listCommunityMembership } = await import('../src/communities/index.js');

    // Two code_file nodes coupled by an `imports` edge (one community).
    const fileNode = (id: string, p: string) => ({ id, type: 'code_file', label: p, metadata: JSON.stringify({ path: p }) });
    const baseNodes = [
        fileNode('code-file:a.ts', 'a.ts'),
        fileNode('code-file:b.ts', 'b.ts'),
    ];
    const baseEdges = [
        { sourceId: 'code-file:a.ts', targetId: 'code-file:b.ts', relation: 'imports' },
    ];

    const baseMembership = await listCommunityMembership(makeCommunityReader(baseNodes, baseEdges), WORKSPACE);

    // Now add folder + external-import pseudo-nodes/edges to the SAME graph.
    const augNodes = [
        ...baseNodes,
        { id: 'code-folder:gf3-fixture-repo/.', type: 'code_folder', label: '/' },
        { id: 'code-import:react', type: 'code_import', label: 'react' },
    ];
    const augEdges = [
        ...baseEdges,
        // folder→file contains (relation contains → already dropped, but present)
        { sourceId: 'code-folder:gf3-fixture-repo/.', targetId: 'code-file:a.ts', relation: 'contains' },
        { sourceId: 'code-folder:gf3-fixture-repo/.', targetId: 'code-file:b.ts', relation: 'contains' },
        // file→import `imports` — the load-bearing case: relation `imports` is
        // otherwise KEPT, so without the GF-3 guard this would pull `react` into
        // the file-coupling projection.
        { sourceId: 'code-file:a.ts', targetId: 'code-import:react', relation: 'imports' },
        { sourceId: 'code-file:b.ts', targetId: 'code-import:react', relation: 'imports' },
    ];

    const augMembership = await listCommunityMembership(makeCommunityReader(augNodes, augEdges), WORKSPACE);

    // The community→fileIds mapping must be IDENTICAL: only code_file ids appear,
    // and the membership partition is unchanged. GF-4: keys are now content-stable
    // string ids, but the comparison normalizes them away — we only assert the
    // PARTITION (sorted member lists) is identical, which is exactly the property
    // GF-3's folder/import exclusion is supposed to preserve.
    const norm = (m: Map<string, string[]>) =>
        JSON.stringify([...m.values()].map((ids) => [...ids].sort()).sort());
    assert.equal(norm(augMembership), norm(baseMembership), 'community membership unchanged by folder/import nodes+edges');

    // Sanity: no folder/import id leaked into any community member list.
    for (const ids of augMembership.values()) {
        assert.ok(ids.every((id) => id.startsWith('code-file:')), 'only code_file ids in community membership');
    }

    console.log('  ✓ T3: communities unchanged — folder/import nodes + their edges excluded from the file-coupling projection');
}

/* ─── runner ────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('Running GF-3 (Folder + Import nodes) tests…');
    await testFolderModel();
    await testImportModel();
    await testCommunitiesUnchanged();
    console.log('All GF-3 tests passed.');
}

await main();
