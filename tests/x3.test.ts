/**
 * tests/x3.test.ts — Atlas → Lore wiring tests (X3 spec T1-T4).
 *
 *   T1: build passes — checked separately via `npm run build`.
 *   T2: `atlas index <file>` writes a CodeFile node; Lore returns it.
 *   T3: parent CodeFile + child CodeSymbol nodes + at least one
 *       CodeRelation edge appear in the configured workspace.
 *   T4: invalid auth token → atlas exits non-zero with a message that
 *       names the token file (operator-actionable).
 *
 * Transport: the EMBEDDED in-process path (the only supported model — there
 * is no machine-wide local Lore daemon by project policy). `atlas index` runs
 * against an embedded-default ATLAS_HOME (lore.mode:'embedded'), writing to a
 * per-workspace dataDir under <ATLAS_HOME>/lore-data/<workspace>. After the
 * CLI exits (releasing the single-writer lock) the test re-opens that same
 * dataDir via EmbeddedLore and asserts the writes round-trip with getNode /
 * listNodes.
 *
 * T4 (invalid-token error) is HTTP-only by nature — the "auth token not
 * accepted by Lore" message is produced only when a live daemon REJECTS the
 * token. It is therefore guarded behind a 3847 reachability probe and SKIPs
 * (never fails) when no daemon is present, which is the supported default.
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const LORE_PORT = 3847;
const WORKSPACE = 'developer';
const TARGET_MCP_URL = `http://127.0.0.1:${LORE_PORT}/mcp`;

interface LoreNodeRecord {
    id: string;
    type: string;
    label: string;
    tags?: string;
}

/** Probe whether a forbidden 3847 daemon happens to be listening. Used ONLY
 *  to decide whether the HTTP-only T4 variant can run; absence → SKIP. */
async function loreDaemonReachable(): Promise<boolean> {
    try {
        const r = await fetch(`http://127.0.0.1:${LORE_PORT}/api/auth/bootstrap`);
        return r.ok;
    } catch {
        return false;
    }
}

/** Embedded-default ATLAS_HOME — mode:'embedded' writes to a dedicated
 *  in-process Lore under <home>/lore-data/<workspace>, no daemon, no token. */
function mkEmbeddedAtlasHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x3-'));
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({
            // Daemon port is irrelevant for `atlas index`; pin to a high port
            // so config validation passes without colliding with anything.
            port: 38484,
            lore: { workspace: WORKSPACE, mode: 'embedded' },
        }, null, 2),
    );
    return home;
}

/** HTTP-variant ATLAS_HOME for the T4 daemon-rejection probe only. */
function mkHttpAtlasHome(token: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-x3-http-'));
    fs.writeFileSync(path.join(home, 'auth.token'), token);
    fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({
            port: 38484,
            lore: { workspace: WORKSPACE, mcpUrl: TARGET_MCP_URL, mode: 'http' },
        }, null, 2),
    );
    return home;
}

/** The dataDir the CLI writes to in embedded mode, mirroring
 *  embeddedDataDir(cfg, workspace) = <home>/lore-data/<workspace>. */
function embeddedDataDirFor(home: string): string {
    return path.join(home, 'lore-data', WORKSPACE);
}

function makeSampleTsFile(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sample-'));
    const file = path.join(home, 'sample.ts');
    fs.writeFileSync(file, `
export function greet(name: string): string {
    return helper('Hello, ' + name);
}

export function helper(message: string): string {
    return message + '!';
}

export class Greeter {
    constructor(private name: string) {}
    say(): string {
        return greet(this.name);
    }
}
`);
    return file;
}

function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(TSX, [CLI, ...args], {
        env: { ...process.env, ATLAS_HOME: home, ATLAS_MCP_AUTH: 'off' },
        encoding: 'utf-8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/* ─── T2 + T3 (embedded write path) ─────────────────────────────── */

async function testIndexEndToEnd(): Promise<void> {
    const home = mkEmbeddedAtlasHome();
    const sample = makeSampleTsFile();

    const r = runCli(home, ['index', sample]);
    assert.equal(r.status, 0, `atlas index exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Log lines from embedded Lore can appear in stdout alongside the JSON result.
    // Extract the first line that looks like a JSON object rather than parsing all stdout.
    const jsonLine = r.stdout.split('\n').find(l => l.trimStart().startsWith('{'));
    if (!jsonLine) throw new Error(`No JSON line found in stdout:\n${r.stdout}`);
    const payload = JSON.parse(jsonLine) as {
        codeFileId: string;
        symbolsWritten: number;
        relationsWritten: number;
        workspace: string;
    };
    assert.equal(payload.workspace, WORKSPACE);
    assert.ok(payload.symbolsWritten >= 3, `at least 3 symbols (greet/helper/Greeter); got ${payload.symbolsWritten}`);

    // The CLI has exited, releasing the single-writer lock — re-open the SAME
    // dataDir it wrote to and read the writes back through the embedded adapter.
    const lore = await EmbeddedLore.open(embeddedDataDirFor(home));
    await lore.connect();
    try {
        // T2: recall the CodeFile node.
        const fileNode = await lore.getNode(payload.codeFileId) as LoreNodeRecord | null;
        assert.ok(fileNode, `Lore returns the CodeFile node ${payload.codeFileId}`);
        assert.equal(fileNode!.type, 'code_file');
        // tags may be an array or a comma-joined string depending on version;
        // coerce to string before substring-checking.
        const tagsStr = String(fileNode!.tags ?? '');
        assert.ok(tagsStr.includes('atlas'), 'tagged atlas');
        assert.ok(tagsStr.includes('code-file'), 'tagged code-file');
        console.log('  ✓ T2: atlas index → EmbeddedLore.getNode returns the CodeFile node');

        // T3: at least one CodeSymbol node + at least one structural edge.
        // relationsWritten ≥ symbolsWritten proves a CodeFile→CodeSymbol
        // containment edge was emitted per symbol.
        assert.ok(
            payload.relationsWritten >= payload.symbolsWritten,
            `at least one containment edge per symbol; got ${payload.relationsWritten} edges for ${payload.symbolsWritten} symbols`,
        );
        // Probe a concrete symbol node deterministically. Re-derive the first
        // symbol's id the same way the CLI does (qualify(repo, sym.id)).
        const { parseFile } = await import('../src/parser/index.js');
        const { codeSymbolId } = await import('../src/store/codeNodes.js');
        const { repoSlug } = await import('../src/cli/repoId.js');
        const sampleRoot = path.dirname(sample);
        const repo = repoSlug(sampleRoot);
        const reParsed = await parseFile(sample, sampleRoot);
        let probedSymbol: LoreNodeRecord | null = null;
        if (reParsed && reParsed.symbols.length > 0) {
            const firstId = codeSymbolId(reParsed.symbols[0]!, repo);
            probedSymbol = await lore.getNode(firstId) as LoreNodeRecord | null;
        }
        assert.ok(probedSymbol, 'probed CodeSymbol node landed in Lore');
        assert.equal(probedSymbol!.type, 'code_symbol');
        const symTagsStr = String(probedSymbol!.tags ?? '');
        assert.ok(symTagsStr.includes('code-symbol'), 'symbol tagged code-symbol');

        // Belt-and-suspenders: listNodes(code_symbol) in this workspace shows
        // every symbol the CLI claimed to write.
        const symbols = await lore.listNodes('code_symbol', undefined, WORKSPACE) as Array<{ id: string }>;
        assert.ok(
            symbols.length >= payload.symbolsWritten,
            `listNodes(code_symbol) ≥ symbolsWritten; got ${symbols.length} vs ${payload.symbolsWritten}`,
        );
        console.log(`  ✓ T3: CodeFile + ${payload.symbolsWritten} CodeSymbol nodes + ${payload.relationsWritten} edges in workspace=${WORKSPACE}`);
    } finally {
        await lore.close();
    }
}

/* ─── T4: invalid token → clear error (HTTP-only; SKIPs w/o daemon) ─ */

async function testInvalidTokenError(): Promise<void> {
    // The "auth token not accepted by Lore" error is produced only when a live
    // daemon REJECTS the token (HTTP 401/403). Embedded mode has no auth, so
    // this assertion is inherently HTTP-only. Per project policy there is no
    // standing 3847 daemon — guard behind a reachability probe and SKIP when
    // absent rather than fail in the supported default config.
    if (!(await loreDaemonReachable())) {
        console.log('  ↷ T4 SKIP: no Lore daemon at 3847 (embedded default) — invalid-token path is HTTP-only');
        return;
    }
    // A daemon is up; we still feed a deliberately invalid token (not the
    // bootstrap token) so we exercise the rejection path, not a real write.
    const home = mkHttpAtlasHome('lore_dev_THIS_TOKEN_IS_INTENTIONALLY_INVALID_FOR_X3_T4');
    const sample = makeSampleTsFile();
    const r = runCli(home, ['index', sample]);
    assert.notEqual(r.status, 0, `invalid token must exit non-zero; got ${r.status}`);
    const blob = `${r.stdout}\n${r.stderr}`;
    assert.ok(/auth token not accepted by Lore/i.test(blob), `error mentions "auth token not accepted by Lore": ${blob}`);
    assert.ok(/auth\.token/.test(blob), `error names auth.token file path: ${blob}`);
    console.log('  ✓ T4: invalid auth token → exit non-zero with operator-actionable error');
}

/* ─── Runner ───────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('atlas X3 tests');
    await testIndexEndToEnd();
    await testInvalidTokenError();
    console.log('All X3 tests passed.');
}

await main();
