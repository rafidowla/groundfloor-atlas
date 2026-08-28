/**
 * tests/index-parity.test.ts — subdir index vs full-repo index node-id parity.
 *
 * Regression for the path-rooting divergence found in the r5 audit (MCP atlas_index
 * subdir, and earlier the CLI): indexing a SUBDIRECTORY rooted ParsedFile.path at
 * the passed dir ("foo.ts") while a full-repo index rooted it at the git top-level
 * ("src/foo.ts"), producing orphan-duplicate `code-file:`/`code-symbol:` nodes if a
 * user indexed both a subdir and the full repo into one workspace.
 *
 * Fixed by rooting at the git top-level at PARSE TIME:
 *   - MCP:   `6920d24` — runIndexTool passes resolveRepoRoot(abs) as parseRepo's
 *            pathRoot (enumerate the subdir, root paths at git top-level).
 *   - CLI:   `7f2ff41` / `f0a90a8` — shared resolveRepoRoot, single-file + recursive.
 *
 * This test was missing — tests/index-roots.test.ts covers a DIFFERENT fix (scan-path
 * containment / traversal), not node-id parity. It pins the invariant: the set of
 * node ids produced by indexing a subdir must be a SUBSET of (and, for that subdir's
 * files, IDENTICAL to) the ids produced by indexing the full repo.
 *
 * Runs against a real throwaway GIT repo (resolveRepoRoot shells out to `git`) and a
 * real in-process Lore, driving the actual runIndexTool + EmbeddedLoreReader path.
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

/** Create a throwaway GIT repo so resolveRepoRoot() resolves a real top-level. */
function makeGitRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-parity-repo-'));
    // Minimal git identity so `git commit` works without inheriting the host's.
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@atlas.local']);
    git(['config', 'user.name', 'Atlas Test']);
    // Configure an ORIGIN remote so repoSlug() derives the SAME stable slug for
    // both the subdir and the full repo (it falls back to path.basename when no
    // origin exists, which would make "src" vs the repo dir diverge in the slug
    // — unrelated to the path-rooting fix under test). A fake URL is fine; only
    // its slugified form is read.
    git(['remote', 'add', 'origin', 'https://example.com/team/parity-fixture.git']);
    // src/shapes.ts and src/shapes.test.ts under src/ — a subdir to index in isolation.
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(repo, 'src', 'shapes.ts'),
        'export function area(r: number): number { return circleArea(r); }\n' +
        'function circleArea(r: number): number { return Math.PI * r * r; }\n',
    );
    fs.writeFileSync(
        path.join(repo, 'src', 'shapes.test.ts'),
        'import { area } from "./shapes";\n' +
        'export function testArea(): boolean { return area(2) > 0; }\n',
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    return fs.realpathSync.native(repo);
}

/** Collect every code node id present in a workspace via the embedded reader. */
async function codeNodeIds(cfg: ReturnType<typeof loadConfig>, ws: string): Promise<{ files: Set<string>; symbols: Set<string> }> {
    const reader = new EmbeddedLoreReader(cfg);
    // listNodes(code_file) + listNodes(code_symbol) — the two node types the index
    // writes. We assert on the id space, which is exactly what the path-rooting fix
    // governs (code-file:<slug>/<repo-relative-path>, code-symbol:<slug>/...).
    const files = (await getEmbeddedLore(cfg, ws).then((lore) => lore.listNodes('code_file', undefined, ws))) as Array<{ id: string }>;
    const symbols = (await getEmbeddedLore(cfg, ws).then((lore) => lore.listNodes('code_symbol', undefined, ws))) as Array<{ id: string }>;
    return {
        files: new Set(files.map((n) => n.id)),
        symbols: new Set(symbols.map((n) => n.id)),
    };
}

async function main(): Promise<void> {
    console.log('Atlas subdir-vs-full-repo node-id parity test');

    const repo = makeGitRepo();
    const subdir = path.join(repo, 'src');
    const WS_SUB = 'parity-subdir';
    const WS_FULL = 'parity-full';
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-parity-data-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-parity-home-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 3848, lore: { mode: 'embedded', dataDir: base } }),
    );
    const cfg = loadConfig(home);

    try {
        // ── Index the SUBDIR into one workspace ──────────────────────────────
        const subIdx = (await runIndexTool(await getEmbeddedLore(cfg, WS_SUB), { path: subdir }, WS_SUB, cfg)) as {
            nodesWritten?: number; errors?: string[];
        };
        assert.ok((subIdx.nodesWritten ?? 0) > 0 && !subIdx.errors?.length, `subdir index succeeded; got ${JSON.stringify(subIdx)}`);
        const subIds = await codeNodeIds(cfg, WS_SUB);
        assert.ok(subIds.files.size > 0 && subIds.symbols.size > 0, `subdir index wrote files+symbols; got ${JSON.stringify({ ...subIds, files: [...subIds.files] })}`);
        console.log(`  ✓ indexed subdir src/: ${subIds.files.size} file(s), ${subIds.symbols.size} symbol(s)`);

        // ── Index the FULL repo into a second workspace ─────────────────────
        const fullIdx = (await runIndexTool(await getEmbeddedLore(cfg, WS_FULL), { path: repo }, WS_FULL, cfg)) as {
            nodesWritten?: number; errors?: string[];
        };
        assert.ok((fullIdx.nodesWritten ?? 0) > 0 && !fullIdx.errors?.length, `full index succeeded; got ${JSON.stringify(fullIdx)}`);
        const fullIds = await codeNodeIds(cfg, WS_FULL);
        assert.ok(fullIds.files.size >= subIds.files.size, `full index has >= files than subdir`);
        console.log(`  ✓ indexed full repo: ${fullIds.files.size} file(s), ${fullIds.symbols.size} symbol(s)`);

        // ── THE PARITY INVARIANT ─────────────────────────────────────────────
        // Every id the subdir index produced must ALSO appear in the full-repo
        // index (same <slug>, same repo-relative path). Before the fix, subdir ids
        // were rooted at the passed dir ("shapes.ts" instead of "src/shapes.ts"),
        // so they diverged and the subdir id set was disjoint from the full set.
        const subFileNotInFull = [...subIds.files].filter((id) => !fullIds.files.has(id));
        assert.deepEqual(
            subFileNotInFull,
            [],
            `subdir code_file ids must all exist in the full-repo index; divergent: ${JSON.stringify(subFileNotInFull)}`,
        );
        const subSymNotInFull = [...subIds.symbols].filter((id) => !fullIds.symbols.has(id));
        assert.deepEqual(
            subSymNotInFull,
            [],
            `subdir code_symbol ids must all exist in the full-repo index; divergent: ${JSON.stringify(subSymNotInFull)}`,
        );
        console.log('  ✓ PARITY: every subdir node id also appears in the full-repo index (no orphan-duplicate divergence)');

        // ── Strengthen: the subdir ids are exactly the src/ slice of the full set ─
        // The subdir walked ONLY src/, so its file ids should equal the full index's
        // src/ file ids (not a strict subset of an arbitrary slice). The path prefix
        // after the repo slug must be "src/".
        const subFileRelPaths = new Set([...subIds.files].map((id) => id.replace(/^code-file:[^/]+\//, '')));
        for (const rel of subFileRelPaths) {
            assert.ok(
                rel.startsWith('src/'),
                `subdir index rooted file path at git top-level ("${rel}"); before the fix this was bare "shapes.ts"`,
            );
            // And that exact relative path must exist verbatim in the full index.
            const fullRelPaths = new Set([...fullIds.files].map((id) => id.replace(/^code-file:[^/]+\//, '')));
            assert.ok(fullRelPaths.has(rel), `full index also contains top-level-rooted "${rel}"`);
        }
        console.log(`  ✓ STRENGTHEN: subdir file paths are git-top-level-rooted ("src/…") and match the full index verbatim`);
    } finally {
        await closeAllEmbedded();
        fs.rmSync(repo, { recursive: true, force: true });
    }
    console.log('All subdir-vs-full-repo node-id parity tests passed.');
}

await main();
