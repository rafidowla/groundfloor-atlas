/**
 * tests/scale-integrity.test.ts — SCALE + GRAPH-INTEGRITY reproduction harness.
 *
 * ⚠️ THIS IS A DEFECT-REPRODUCTION HARNESS. On CURRENT (unfixed) code these
 * assertions are EXPECTED TO FAIL — that failure IS the reproduction. A later
 * fix flips them green; a PASS on today's code means the harness stopped
 * exercising the bug (debug the fixture, don't lower the bar).
 *
 * THE DEFECT (permanent edge loss on any repo bigger than one 50-file batch)
 * ─────────────────────────────────────────────────────────────────────────
 *  • buildFolderBatch (src/store/codeNodes.ts) synthesizes folder→file
 *    `contains` edges for EVERY file up front. runRecursiveIndex flushes them
 *    via writer.addAux in the FIRST batch — alongside only files 0–49
 *    (batchSize=50, src/cli/batchWriter.ts). Files 50+ aren't written yet, so
 *    their folder→file edges have a MISSING target endpoint at flush time.
 *  • EmbeddedLore.bulkStoreEdges breaks on the FIRST failed edge and ROLLS
 *    BACK the whole ~1000-edge chunk — including the valid edges in it.
 *  • BatchWriter.flush still marks those files as landed and cli.ts saves the
 *    checkpoint, so a default `--resume` re-run SKIPS them forever.
 *  Net: the graph ships edge-incomplete and `--resume` never repairs it.
 *
 * CLAIMS (all EXPECTED TO FAIL today)
 *  A — edge completeness: the index run reports result.bulkErrors === 0.
 *  B — folder→file edges present: the embedded store holds exactly one
 *      `contains` edge (code-folder: → code-file:) per generated file.
 *  C — resume == force: after a --force index, a DEFAULT (--resume) re-run
 *      that touches one file leaves the folder→file edge set just as complete.
 *
 * Shape follows tests/checkpoint.test.ts / tests/gf3.test.ts: node:assert/strict,
 * an async main(), '  ✓ CLAIM …' progress lines, ends `await main()`.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const WORKSPACE = 'scaletest';

/** Files per fixture. Default 120 → crosses the 50-file batch boundary >2×. */
const DEFAULT_FILE_COUNT = 120;
/** Directory fan-out: src/mod0 … src/mod{DIRS-1}. */
const DIRS = 6;

// ── fixture generator ────────────────────────────────────────────────────────

interface Fixture {
    root: string;
    /** Absolute paths of every generated .ts file, in generation order. */
    files: string[];
    /** How many .ts files were generated (== files.length). */
    fileCount: number;
}

/**
 * Generate a synthetic repo of `n` tiny valid .ts files across DIRS nested
 * directories (src/mod0 … src/mod5). Each file exports one function. A handful
 * of files ALSO import a symbol from a DIFFERENT module and call it, so the
 * graph carries cross-file import/call edges — some FORWARD-referencing a file
 * generated later (i.e. spanning the 50-file batch boundary), which is exactly
 * the shape that produces missing-endpoint edges at first-flush time.
 *
 * Filenames + dir names are deliberately plain (fileN.ts under src/modK) so the
 * walker's test/fixture default-exclusion (.test/.spec/__tests__/e2e/.snap)
 * never drops any of them — the file count must map 1:1 to indexed files for
 * CLAIM B to be meaningful.
 */
function genRepo(n: number = DEFAULT_FILE_COUNT): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scale-'));
    const files: string[] = [];

    // Pre-compute a stable (dir, index-within-dir) layout so cross-file imports
    // can name a real target by its relative path.
    const layout: Array<{ dir: string; base: string; rel: string; abs: string }> = [];
    for (let i = 0; i < n; i++) {
        const k = i % DIRS;
        const dir = `src/mod${k}`;
        const base = `file${i}`;
        const rel = `${dir}/${base}.ts`;
        const abs = path.join(root, dir, `${base}.ts`);
        layout.push({ dir, base, rel, abs });
    }

    for (let i = 0; i < n; i++) {
        const me = layout[i]!;
        fs.mkdirSync(path.dirname(me.abs), { recursive: true });

        const fnName = `fn${i}`;
        let src = `export function ${fnName}(x: number): number {\n  return x + ${i};\n}\n`;

        // Every 4th file cross-imports another module's function and calls it.
        // Bias the target FORWARD (i + 37) so many of these references point at
        // files that don't exist yet when the first 50-file batch is flushed —
        // the batch-boundary-spanning edges the defect loses. Wrap to stay in
        // range; skip self-references.
        if (i % 4 === 0) {
            const t = (i + 37) % n;
            if (t !== i) {
                const target = layout[t]!;
                // Relative import path from me.dir to target (both under src/modK).
                const fromDir = path.posix.dirname(me.rel);
                const toNoExt = target.rel.replace(/\.ts$/, '');
                let relImport = path.posix.relative(fromDir, toNoExt);
                if (!relImport.startsWith('.')) relImport = './' + relImport;
                src =
                    `import { fn${t} } from '${relImport}.js';\n` +
                    `export function ${fnName}(x: number): number {\n` +
                    `  return fn${t}(x) + ${i};\n` +
                    `}\n`;
            }
        }

        fs.writeFileSync(me.abs, src);
        files.push(me.abs);
    }

    return { root, files, fileCount: files.length };
}

// ── index invocation ─────────────────────────────────────────────────────────

interface IndexResult {
    ok: boolean;
    filesParsed?: number;
    filesIndexed?: number;
    filesSkippedByResume?: number;
    nodesWritten?: number;
    edgesWritten?: number;
    bulkErrors?: number;
    firstErrors?: Array<{ filePath: string; item: string; error: string }>;
    [k: string]: unknown;
}

/**
 * Run `atlas index <root>` in EMBEDDED mode via the tsx CLI, matching the
 * production write path (batchSize=50). ATLAS_CONTEXT_LAYER=0 keeps it graph-
 * only (fast — no embeds). Returns the parsed JSON envelope printed to stdout.
 *
 * `atlasHome` is the per-test ATLAS_HOME; the embedded store lands at
 * <atlasHome>/lore-data/<WORKSPACE>. `mode` selects --force vs the default
 * (--resume). First-time init loads native kuzu/lancedb (~10s) → 180s timeout.
 */
function runIndex(fixtureRoot: string, atlasHome: string, mode: 'force' | 'resume'): IndexResult {
    const args = ['tsx', CLI, 'index', fixtureRoot, '--workspace', WORKSPACE];
    if (mode === 'force') args.push('--force');
    // resume is the DEFAULT — pass nothing (exercise the real default path).

    const proc = spawnSync('npx', args, {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            ATLAS_HOME: atlasHome,
            ATLAS_CONTEXT_LAYER: '0',
        },
        encoding: 'utf8',
        timeout: Number(process.env.ATLAS_SCALE_TIMEOUT) || 180_000,
        maxBuffer: 64 * 1024 * 1024,
    });

    if (proc.error) {
        throw new Error(`index spawn failed (${mode}): ${proc.error.message}`);
    }

    // The JSON envelope is the LAST JSON object printed to stdout. Progress +
    // '[atlas] embedded Lore ready…' lines go to stderr, so stdout is clean,
    // but parse defensively (find the last {...} block) either way.
    const out = proc.stdout ?? '';
    const parsed = parseLastJson(out);
    if (!parsed) {
        throw new Error(
            `index (${mode}) printed no JSON result (exit=${proc.status}).\n` +
            `── stdout ──\n${out}\n── stderr ──\n${(proc.stderr ?? '').slice(-4000)}`,
        );
    }
    return parsed as IndexResult;
}

/** Parse the last top-level JSON object in a text blob (tolerates leading logs). */
function parseLastJson(text: string): unknown | null {
    const start = text.lastIndexOf('\n{');
    const firstBrace = start >= 0 ? start + 1 : text.indexOf('{');
    if (firstBrace < 0) return null;
    // The CLI prints the envelope with `JSON.stringify(obj, null, 2)` as the
    // final stdout write, so from the last opening brace to the end parses.
    const candidate = text.slice(text.lastIndexOf('{'));
    try { return JSON.parse(candidate); } catch { /* fall through */ }
    try { return JSON.parse(text.slice(firstBrace)); } catch { return null; }
}

// ── embedded-store read-back ──────────────────────────────────────────────────

/**
 * Open the embedded store the CLI just wrote and count folder→file `contains`
 * edges (sourceId code-folder:… , targetId code-file:…). This is the graph as
 * it actually PERSISTED — the ground truth CLAIM B / C assert against.
 */
async function countFolderFileEdges(atlasHome: string): Promise<{ folderFile: number; total: number }> {
    const dataDir = path.join(atlasHome, 'lore-data', WORKSPACE);
    const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
    const lore = await EmbeddedLore.open(dataDir);
    try {
        const edges = await lore.listEdges();
        const folderFile = edges.filter(
            (e) =>
                e.relation === 'contains' &&
                typeof e.sourceId === 'string' &&
                typeof e.targetId === 'string' &&
                e.sourceId.startsWith('code-folder:') &&
                e.targetId.startsWith('code-file:'),
        ).length;
        return { folderFile, total: edges.length };
    } finally {
        await lore.close();
    }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // ATLAS_SCALE_FILES overrides the fixture size for the plan's larger
    // final-validation runs (M1 target: small/medium <~5k files). All claims
    // below are relative to fx.fileCount, so scaling up is purely the fixture.
    const fileCount = Number(process.env.ATLAS_SCALE_FILES) || DEFAULT_FILE_COUNT;
    console.log('Running Atlas scale/integrity reproduction harness…');
    console.log(`  (fixture: ${fileCount} files across ${DIRS} dirs; batchSize=50 → boundary crossed)`);

    const cleanup: string[] = [];
    try {
        // ── Fixture + first (--force) index ───────────────────────────────────
        const fx = genRepo(fileCount);
        cleanup.push(fx.root);
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-home-'));
        cleanup.push(home);

        console.log(`  → indexing ${fx.fileCount} files (--force) …`);
        const forced = runIndex(fx.root, home, 'force');
        console.log(
            `    result: ok=${forced.ok} filesParsed=${forced.filesParsed} ` +
            `filesIndexed=${forced.filesIndexed} edgesWritten=${forced.edgesWritten} ` +
            `bulkErrors=${forced.bulkErrors}`,
        );

        // Guard: the run must have actually parsed our whole tree. If parsing
        // fell short the batch boundary might not be crossed → fix the harness,
        // not the bar. (This is NOT the defect assertion.)
        assert.equal(
            forced.filesParsed,
            fx.fileCount,
            `harness precondition: expected all ${fx.fileCount} files parsed, got ${forced.filesParsed} ` +
            `(if short, the fixture/walker dropped files — batch boundary may not be crossed)`,
        );
        assert.ok(
            fx.fileCount > 50,
            `harness precondition: fixture must exceed the 50-file batch (got ${fx.fileCount})`,
        );

        // ── CLAIM A — edge completeness (bulkErrors === 0) ────────────────────
        // EXPECTED TO FAIL today: forward folder→file edges for files 50+ have a
        // missing endpoint in the first flush → bulk edge errors.
        if (forced.firstErrors && forced.firstErrors.length > 0) {
            console.log(`    firstErrors[0]: ${JSON.stringify(forced.firstErrors[0])}`);
        }
        assert.equal(
            forced.bulkErrors,
            0,
            `CLAIM A: expected bulkErrors 0, got ${forced.bulkErrors} ` +
            `(missing-endpoint edges lost + rolled back at first flush)`,
        );
        console.log('  ✓ CLAIM A: index run reports zero bulk edge errors');

        // ── CLAIM B — folder→file edges present (== file count) ───────────────
        // EXPECTED TO FAIL today: the rolled-back chunk drops folder→file edges,
        // so the persisted count is SHORT of fx.fileCount.
        const afterForce = await countFolderFileEdges(home);
        console.log(
            `    persisted folder→file edges: ${afterForce.folderFile} ` +
            `(total edges: ${afterForce.total})`,
        );
        assert.equal(
            afterForce.folderFile,
            fx.fileCount,
            `CLAIM B: expected ${fx.fileCount} folder→file 'contains' edges, got ${afterForce.folderFile} ` +
            `(short by ${fx.fileCount - afterForce.folderFile} — dropped in the rolled-back first-flush chunk)`,
        );
        console.log(`  ✓ CLAIM B: one folder→file edge per file (${fx.fileCount})`);

        // ── CLAIM C — resume == force (default re-run stays complete) ─────────
        // Touch/modify ONE file, then run a DEFAULT (--resume) index into the
        // SAME workspace. A correct resume repairs any short graph; the defect
        // marks files landed + checkpoints them, so --resume skips them forever
        // and the folder→file edge set stays short.
        // EXPECTED TO FAIL today.
        const touched = fx.files[Math.floor(fx.files.length / 2)]!;
        const prev = fs.readFileSync(touched, 'utf8');
        fs.writeFileSync(touched, prev + `\nexport const touchedAt = ${Date.now()};\n`);
        // Nudge mtime forward so the checkpoint's mtime/size fingerprint sees it.
        const future = new Date(Date.now() + 5_000);
        fs.utimesSync(touched, future, future);

        console.log('  → re-indexing (default --resume) after touching one file …');
        const resumed = runIndex(fx.root, home, 'resume');
        console.log(
            `    result: ok=${resumed.ok} filesParsed=${resumed.filesParsed} ` +
            `filesSkippedByResume=${resumed.filesSkippedByResume} bulkErrors=${resumed.bulkErrors}`,
        );

        const afterResume = await countFolderFileEdges(home);
        console.log(
            `    persisted folder→file edges after resume: ${afterResume.folderFile} ` +
            `(total edges: ${afterResume.total})`,
        );
        assert.equal(
            afterResume.folderFile,
            fx.fileCount,
            `CLAIM C: expected the resume graph as complete as force — ${fx.fileCount} ` +
            `folder→file edges, got ${afterResume.folderFile} ` +
            `(--resume skipped the never-written files; the graph never self-heals)`,
        );
        console.log(`  ✓ CLAIM C: --resume graph is edge-complete (${fx.fileCount})`);

        console.log('All scale/integrity claims passed — defect NOT reproduced (graph is edge-complete).');
    } finally {
        for (const dir of cleanup) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

await main();
