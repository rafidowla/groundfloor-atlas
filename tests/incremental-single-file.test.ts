/**
 * tests/incremental-single-file.test.ts — single-file `atlas_index` must
 * resolve CROSS-FILE edges and reconcile its own stale nodes.
 *
 * Regression for the single-file incremental-index bug: parseAndResolveOne
 * built its symbol table + resolution context from ONLY the file being
 * indexed (buildSymbolTable([parsed]) / buildResolutionContext(root,[parsed])).
 * Every cross-file reference therefore failed to resolve — a receiver-
 * qualified callee like `Gateway.open` (class defined in a sibling file), a
 * named-import call, even the import specifier itself (repoFileSet held ONE
 * path) — so a single-file re-index silently wrote the file with NO
 * cross-file call/import edges while reporting success, and external-import
 * edges failed with `edge endpoint missing` (their code-import nodes are
 * only synthesized by the DIRECTORY path). The graph rotted one edit at a
 * time; only a full re-index repaired it.
 *
 * Fix under test (src/mcp/tools/index.ts): the single-file path loads the
 * persisted workspace graph's SAME-REPO symbols + file paths as resolution
 * candidates (loadPeerResolutionContext), emits the external-import nodes the
 * file's edges need, and reconciles the file's stale nodes (renamed/removed
 * symbols) after the write.
 *
 * Runs against a real throwaway GIT repo and a real in-process Lore, driving
 * the actual runIndexTool + EmbeddedLoreReader path (same harness as
 * tests/index-parity.test.ts).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { EmbeddedLoreReader } from '../src/mcp/embeddedReader.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import { repoSlug } from '../src/cli/repoId.js';

const LIB = `export class Gateway {
    static async open(dir: string): Promise<Gateway> { return new Gateway(); }
    async close(): Promise<void> {}
}
export function helper(): number { return 42; }
`;

const MAIN = `import { Gateway, helper } from './lib.js';
export async function boot(): Promise<Gateway> { return Gateway.open('/tmp/x'); }
export function useHelper(): number { return helper(); }
`;

/** Create a throwaway GIT repo so resolveRepoRoot() resolves a real top-level. */
function makeGitRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-incr-repo-'));
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@atlas.local']);
    git(['config', 'user.name', 'Atlas Test']);
    // Origin remote so repoSlug() derives one stable slug for every run.
    git(['remote', 'add', 'origin', 'https://example.com/team/incr-fixture.git']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'lib.ts'), LIB);
    fs.writeFileSync(path.join(repo, 'src', 'main.ts'), MAIN);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    return fs.realpathSync.native(repo);
}

interface IndexResult {
    ok?: boolean;
    nodesWritten?: number;
    edgesWritten?: number;
    errors?: Array<{ error?: string }>;
}

async function main(): Promise<void> {
    console.log('Atlas single-file incremental index: cross-file resolution + per-file reconcile');

    const repo = makeGitRepo();
    const mainAbs = path.join(repo, 'src', 'main.ts');
    const libAbs = path.join(repo, 'src', 'lib.ts');
    const WS = 'incr-single-file';
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-incr-data-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-incr-home-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 3848, lore: { mode: 'embedded', dataDir: base } }),
    );
    const cfg = loadConfig(home);
    const R = repoSlug(repo);
    const reader = new EmbeddedLoreReader(cfg);

    /** call edges (source→target uids) as the READ path reconstructs them. */
    const callEdges = async (): Promise<Array<[string, string]>> => {
        const { relations } = await reader.loadContext(WS);
        return relations.filter((r) => r.kind === 'calls').map((r) => [r.sourceId, r.targetId] as [string, string]);
    };

    try {
        // ── 1. Full index → the ground-truth baseline ──────────────────────────
        const full = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: repo, resume: false }, WS, cfg)) as IndexResult;
        assert.ok(full.ok && (full.nodesWritten ?? 0) > 0, `full index succeeded; got ${JSON.stringify(full)}`);
        let edges = await callEdges();
        assert.ok(
            edges.some(([s, t]) => s === `${R}/src/main.ts:boot:function` && t === `${R}/src/lib.ts:Gateway.open:method`),
            `baseline has cross-file receiver-qualified edge boot→Gateway.open; got ${JSON.stringify(edges)}`,
        );
        assert.ok(
            edges.some(([s, t]) => s === `${R}/src/main.ts:useHelper:function` && t === `${R}/src/lib.ts:helper:function`),
            `baseline has cross-file named-import edge useHelper→helper; got ${JSON.stringify(edges)}`,
        );
        console.log(`  ✓ full index baseline: ${edges.length} call edges incl. both cross-file edges`);

        // ── 2. Edit main.ts (add a NEW cross-file caller) → single-file index ──
        // Before the fix: the tool reported success but lateCaller→Gateway.open
        // never landed (single-file symbol table had no lib.ts symbols).
        fs.writeFileSync(mainAbs, MAIN + 'export async function lateCaller(): Promise<Gateway> { return Gateway.open(\'/tmp/y\'); }\n');
        const single = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: mainAbs }, WS, cfg)) as IndexResult;
        assert.ok(single.ok, `single-file index succeeded with NO edge errors; got ${JSON.stringify(single)}`);
        edges = await callEdges();
        assert.ok(
            edges.some(([s, t]) => s === `${R}/src/main.ts:lateCaller:function` && t === `${R}/src/lib.ts:Gateway.open:method`),
            `single-file index resolved the NEW cross-file edge lateCaller→Gateway.open; got ${JSON.stringify(edges)}`,
        );
        assert.ok(
            edges.some(([s, t]) => s === `${R}/src/main.ts:boot:function` && t === `${R}/src/lib.ts:Gateway.open:method`),
            `pre-existing cross-file edge boot→Gateway.open still present after single-file re-index`,
        );
        console.log('  ✓ single-file index resolves NEW cross-file edges (lateCaller→Gateway.open) and keeps existing ones');

        // ── 3. Rename helper→helperV2 in lib.ts → single-file index of lib.ts ──
        // The per-file reconcile must purge src/lib.ts:helper (its edges cascade)
        // while leaving every OTHER file's nodes untouched.
        fs.writeFileSync(libAbs, LIB.replace('export function helper(): number', 'export function helperV2(): number'));
        const singleLib = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: libAbs }, WS, cfg)) as IndexResult;
        assert.ok(singleLib.ok, `single-file index of renamed lib.ts succeeded; got ${JSON.stringify(singleLib)}`);
        const lore = await getEmbeddedLore(cfg, WS);
        const symbolIds = new Set(
            ((await lore.listNodes('code_symbol', undefined, WS)) as Array<{ id: string }>).map((n) => n.id),
        );
        assert.ok(!symbolIds.has(`code-symbol:${R}/src/lib.ts:helper:function`), 'renamed-away symbol node purged by per-file reconcile');
        assert.ok(symbolIds.has(`code-symbol:${R}/src/lib.ts:helperV2:function`), 'renamed-in symbol node present');
        assert.ok(symbolIds.has(`code-symbol:${R}/src/main.ts:boot:function`), 'sibling file nodes untouched by the reconcile');
        edges = await callEdges();
        assert.ok(
            !edges.some(([, t]) => t === `${R}/src/lib.ts:helper:function`),
            `stale edges into the removed symbol cascaded away; got ${JSON.stringify(edges)}`,
        );
        console.log('  ✓ per-file reconcile purges renamed-away symbols (edges cascade) without touching siblings');

        // ── 4. Cold workspace degrade: single-file index with NO persisted peers ──
        // No graph to enrich from → file-local resolution. Must still succeed
        // (pre-fix it errored: external-import edges had no code-import nodes).
        const WS_COLD = 'incr-single-file-cold';
        const cold = (await runIndexTool(await getEmbeddedLore(cfg, WS_COLD), { path: mainAbs }, WS_COLD, cfg)) as IndexResult;
        assert.ok(cold.ok, `cold single-file index succeeds (import nodes synthesized); got ${JSON.stringify(cold)}`);
        console.log('  ✓ cold-workspace single-file index succeeds (no edge-endpoint-missing errors)');
    } finally {
        await closeAllEmbedded();
        fs.rmSync(repo, { recursive: true, force: true });
    }
    console.log('All single-file incremental index tests passed.');
}

await main();
