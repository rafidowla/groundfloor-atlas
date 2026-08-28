/**
 * tests/mcp-index-reconcile-scope.test.ts — the MCP `atlas_index` DIRECTORY
 * path must NOT run the stale-node reconcile when the indexed path is a
 * SUBDIRECTORY, even on a full (resume:false) run.
 *
 * Regression for the one-call data-loss hazard: runIndexTool passed
 * `reconcile: !resume` unconditionally (src/mcp/tools/index.ts), while the
 * CLI's own `atlas index` had a second guard — `coversWholeRepo`
 * (cli.ts runRecursiveIndex). The reconcile deletes every file-scoped node
 * of the repo absent from this run's batches; a subdir run's batches cover
 * only the subdir, so `atlas_index {path:'<repo>/src', resume:false}`
 * silently deleted every file OUTSIDE src/ for the whole repo.
 *
 * Fix under test (src/mcp/tools/index.ts): `reconcile: !resume &&
 * coversWholeRepo` — the MCP twin of the CLI guard. Tradeoff (deliberately
 * matching the CLI, see tests/audit-high-severity.test.ts CLAIM 1): a
 * subdir full re-index does NOT purge stale nodes INSIDE the subdir either;
 * the single-file path keeps its per-file reconcile, and a whole-repo
 * resume:false run remains the authoritative reconcile. Covered here:
 * (1) sibling files outside the subdir survive a subdir resume:false run,
 * (2) a whole-repo resume:false run still reconciles deleted files.
 *
 * Runs against a real throwaway GIT repo and a real in-process Lore, driving
 * the actual runIndexTool + EmbeddedLore path (same harness as
 * tests/incremental-single-file.test.ts).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { getEmbeddedLore, closeAllEmbedded } from '../src/mcp/embeddedRegistry.js';
import { runIndexTool } from '../src/mcp/tools/index.js';
import { repoSlug } from '../src/cli/repoId.js';

const LIB = `export class Gateway {
    static async open(dir: string): Promise<Gateway> { return new Gateway(); }
    async close(): Promise<void> {}
}
export function helper(): number { return 42; }
`;

const OTHER = `export function outsider(): number { return 7; }
`;

/** Create a throwaway GIT repo with TWO subdirectories so resolveRepoRoot()
 * resolves a real top-level distinct from either subdir. */
function makeGitRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcscope-repo-'));
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@atlas.local']);
    git(['config', 'user.name', 'Atlas Test']);
    // Origin remote so repoSlug() derives one stable slug for every run.
    git(['remote', 'add', 'origin', 'https://example.com/team/rcscope-fixture.git']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'lib2'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'lib.ts'), LIB);
    fs.writeFileSync(path.join(repo, 'lib2', 'other.ts'), OTHER);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    return fs.realpathSync.native(repo);
}

interface IndexResult {
    ok?: boolean;
    nodesWritten?: number;
    errors?: Array<{ error?: string }>;
}

async function main(): Promise<void> {
    console.log('Atlas MCP index reconcile-scope: subdir resume:false must not wipe sibling files');

    const repo = makeGitRepo();
    const WS = 'rcscope-mcp';
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcscope-data-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rcscope-home-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ port: 3848, lore: { mode: 'embedded', dataDir: base } }),
    );
    const cfg = loadConfig(home);
    const R = repoSlug(repo);

    /** ids of every persisted node of `type` in WS. */
    const idsOf = async (type: string): Promise<Set<string>> => {
        const lore = await getEmbeddedLore(cfg, WS);
        const rows = (await lore.listNodes(type, undefined, WS)) as Array<{ id: string }>;
        return new Set(rows.map((n) => n.id));
    };

    try {
        // ── 1. Whole-repo FULL index → the ground-truth baseline ────────────
        const full = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: repo, resume: false }, WS, cfg)) as IndexResult;
        assert.ok(full.ok && (full.nodesWritten ?? 0) > 0, `full index succeeded; got ${JSON.stringify(full)}`);
        let files = await idsOf('code_file');
        assert.ok(files.has(`code-file:${R}/src/lib.ts`), 'baseline: src/lib.ts file node present');
        assert.ok(files.has(`code-file:${R}/lib2/other.ts`), 'baseline: lib2/other.ts file node present');
        console.log('  ✓ baseline: both subdirectories indexed');

        // ── 2. THE REGRESSION — subdir FULL index (resume:false) ────────────
        // Before the fix: reconcile ran with a src-only live-set and deleted
        // every lib2/ node for the repo. After: reconcile is skipped for
        // narrowed runs.
        const sub = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: path.join(repo, 'src'), resume: false }, WS, cfg)) as IndexResult;
        assert.ok(sub.ok, `subdir full index succeeded; got ${JSON.stringify(sub)}`);
        files = await idsOf('code_file');
        const syms = await idsOf('code_symbol');
        assert.ok(
            files.has(`code-file:${R}/lib2/other.ts`) && syms.has(`code-symbol:${R}/lib2/other.ts:outsider:function`),
            `subdir resume:false must NOT delete sibling files' nodes (lib2/other.ts survived); files=${JSON.stringify([...files])}`,
        );
        assert.ok(files.has(`code-file:${R}/src/lib.ts`), 'the indexed subdir itself is (re)written');
        console.log('  ✓ subdir resume:false leaves lib2/other.ts intact (reconcile skipped for narrowed runs)');

        // ── 3. Guard the guard — whole-repo FULL runs STILL reconcile ──────
        // Delete lib2/other.ts from disk, whole-repo resume:false → its nodes
        // must be purged (the coversWholeRepo guard must not have disabled
        // reconcile where it IS safe: a whole-repo walk).
        fs.rmSync(path.join(repo, 'lib2', 'other.ts'));
        const full2 = (await runIndexTool(await getEmbeddedLore(cfg, WS), { path: repo, resume: false }, WS, cfg)) as IndexResult;
        assert.ok(full2.ok, `post-delete full index succeeded; got ${JSON.stringify(full2)}`);
        files = await idsOf('code_file');
        const syms2 = await idsOf('code_symbol');
        assert.ok(!files.has(`code-file:${R}/lib2/other.ts`), 'deleted file\'s code_file node purged by the whole-repo reconcile');
        assert.ok(!syms2.has(`code-symbol:${R}/lib2/other.ts:outsider:function`), 'deleted file\'s code_symbol node purged (edges cascade)');
        assert.ok(files.has(`code-file:${R}/src/lib.ts`), 'surviving file untouched by the reconcile');
        console.log('  ✓ whole-repo resume:false still reconciles deleted files (guard is scope-aware, not off)');
    } finally {
        await closeAllEmbedded();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
    console.log('All MCP reconcile-scope tests passed.');
}

await main();
