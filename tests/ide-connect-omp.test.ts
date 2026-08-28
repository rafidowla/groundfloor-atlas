/**
 * tests/ide-connect-omp.test.ts — `atlas connect omp` / `atlas disconnect
 * omp`: the advisory-hook installer in src/cli/ideConnect.ts (applyOmp +
 * scanOmpExtensions) and its canonical hook source in src/cli/ompHook.ts.
 *
 * Same real-CLI e2e mold as tests/ide-connect-codex.test.ts: ideConnect.ts
 * resolves ~/.omp via os.homedir() with no injection seam, so every step
 * spawns `npx tsx src/cli.ts …` with HOME/ATLAS_HOME pointed at throwaway
 * tmpdirs — this machine's real ~/.omp is never read or written (it is itself
 * wired, byte-identically to what connect installs).
 *
 * connect omp has TWO independent halves: the hook script at
 * ~/.omp/agent/hooks/pre/atlas-consult.ts (verbatim from cli/ompHook.ts) and
 * one `extensions:` list line in ~/.omp/agent/config.yml registering it.
 *
 *   CLAIM A — fresh install: no ~/.omp at all → config.yml created with the
 *             extensions: block + hook written (exact content); a config.yml
 *             with other keys but NO extensions: key gets the key appended
 *             (with/without a trailing newline), every other byte preserved.
 *   CLAIM B — merge, never clobber: a seeded realistic config.yml (unrelated
 *             extensions entries, comments, trailing-space key style) gets
 *             exactly ONE new line after the last item; full-file byte
 *             equality against the expected insert.
 *   CLAIM C — idempotent re-run: byte-stable, no duplicate line, no spurious
 *             backup, and the "no changes" report.
 *   CLAIM D — disconnect removes ONLY our line (file returns to the seed
 *             byte-for-byte); the hook FILE stays (config-only precedent);
 *             second disconnect is a clean no-op.
 *   CLAIM E — the installed hook file is byte-identical to OMP_HOOK_SOURCE.
 *   CLAIM F — a customized pre-existing hook file is backed up before the
 *             overwrite, never silently destroyed.
 *   CLAIM G — fail closed: a flow-style `extensions: [a, b]` config fails
 *             (exit 1, "left untouched"), the file is byte-identical, NO
 *             backup, and the hook file is NOT written either (config is
 *             checked before anything touches disk).
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMP_HOOK_FILENAME, OMP_HOOK_SOURCE } from '../src/cli/ompHook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const OURS = '~/.omp/agent/hooks/pre/atlas-consult.ts';
const UNRELATED_A = '~/.omp/agent/hooks/pre/delegation-check.ts';
const UNRELATED_B = '~/.omp/agent/hooks/pre/routing-status.ts';

/** A realistic ~/.omp/agent/config.yml — modeled on a real machine's file
 * (note the trailing-space key style and interleaved comments). */
const SEED = ''
    + '# machine-wide OMP agent config — every byte but our line must survive\n'
    + 'providers: \n'
    + '  webSearchOrder: \n'
    + '    - anthropic\n'
    + '    - zai\n'
    + 'modelRoles: \n'
    + '  default: zai/glm-5.3:high\n'
    + '  task: zai/glm-5.3:high\n'
    + 'setupVersion: 2\n'
    + 'extensions: \n'
    + `  - ${UNRELATED_A}\n`
    + `  - ${UNRELATED_B}\n`
    + 'composer: \n'
    + '  shape: box\n';

/** SEED after a connect: exactly one new line, appended after the last item. */
const SEED_CONNECTED = SEED.replace(
    `  - ${UNRELATED_B}\n`,
    `  - ${UNRELATED_B}\n  - ${OURS}\n`,
);

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Spawn the REAL CLI, exactly as a user would, with HOME/ATLAS_HOME isolated
 * to tmpdirs (os.homedir() follows $HOME on POSIX — same seam the codex test
 * relies on). Auth is irrelevant to omp (the hook resolves its own token at
 * runtime) but kept 'off' to match the sibling test's deterministic setup. */
function runCli(args: string[], home: string, atlasHome: string): RunResult {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ATLAS_HOME: atlasHome, ATLAS_MCP_AUTH: 'off' };
    delete env['ATLAS_MCP_TOKEN'];
    try {
        const stdout = execFileSync('npx', ['tsx', path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
            cwd: REPO_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: stdout.toString('utf8'), stderr: '' };
    } catch (err) {
        const e = err as { status: number | null; stdout?: Buffer; stderr?: Buffer };
        return { code: e.status, stdout: e.stdout?.toString('utf8') ?? '', stderr: e.stderr?.toString('utf8') ?? '' };
    }
}

function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

function configYml(home: string): string {
    return path.join(home, '.omp', 'agent', 'config.yml');
}

function hookFile(home: string): string {
    return path.join(home, '.omp', 'agent', 'hooks', 'pre', OMP_HOOK_FILENAME);
}

/** .bak-groundfloor-atlas-* files anywhere under ~/.omp/agent (config backups
 * land beside config.yml, hook backups beside the hook). */
function backupsIn(home: string): string[] {
    const root = path.join(home, '.omp', 'agent');
    const out: string[] = [];
    for (const dir of [root, path.join(root, 'hooks', 'pre')]) {
        if (fs.existsSync(dir)) out.push(...fs.readdirSync(dir).filter((f) => f.includes('.bak-groundfloor-atlas-')));
    }
    return out;
}

async function main(): Promise<void> {
    console.log('Running ide-connect-omp tests…');
    const atlasHome = tmp('atlas-ico-atlashome-');

    // ── CLAIM A — fresh installs, with and without an existing config.yml ──
    {
        // A1: no ~/.omp at all — connect creates both halves from nothing.
        const home = tmp('atlas-ico-a1-home-');
        const r = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r.code, 0, `A1: connect omp exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('hook written'), `A1: reports the hook write, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(configYml(home), 'utf8'), `extensions:\n  - ${OURS}\n`, 'A1: config.yml created with exactly the extensions: block');
        assert.ok(fs.existsSync(hookFile(home)), 'A1: hook file created (with hooks/pre/ dirs)');
        fs.rmSync(home, { recursive: true, force: true });

        // A2: config.yml with other keys but NO extensions: key — the key is
        // appended at EOF, every pre-existing byte preserved.
        const home2 = tmp('atlas-ico-a2-home-');
        fs.mkdirSync(path.dirname(configYml(home2)), { recursive: true });
        const seedNoExt = ''
            + '# top comment survives\n'
            + 'modelRoles: \n'
            + '  default: zai/glm-5.3:high\n'
            + 'composer: \n'
            + '  shape: box\n';
        fs.writeFileSync(configYml(home2), seedNoExt);
        const r2 = runCli(['connect', 'omp'], home2, atlasHome);
        assert.equal(r2.code, 0, `A2: connect exits 0 (stderr: ${r2.stderr})`);
        assert.equal(fs.readFileSync(configYml(home2), 'utf8'), `${seedNoExt}extensions:\n  - ${OURS}\n`, 'A2: extensions: block APPENDED; unrelated bytes survive (full-file equality)');
        assert.ok(fs.existsSync(hookFile(home2)), 'A2: hook file written too');
        fs.rmSync(home2, { recursive: true, force: true });

        // A3: same, but the file lacks a trailing newline — one is added
        // before the block (no glued-together last line).
        const home3 = tmp('atlas-ico-a3-home-');
        fs.mkdirSync(path.dirname(configYml(home3)), { recursive: true });
        fs.writeFileSync(configYml(home3), 'setupVersion: 2'); // no trailing \n
        const r3 = runCli(['connect', 'omp'], home3, atlasHome);
        assert.equal(r3.code, 0, `A3: connect exits 0 (stderr: ${r3.stderr})`);
        assert.equal(fs.readFileSync(configYml(home3), 'utf8'), `setupVersion: 2\nextensions:\n  - ${OURS}\n`, 'A3: newline inserted before the appended block');

        // A4: an EMPTY `extensions:` key (no items yet) gets the item right
        // after the key line.
        const home4 = tmp('atlas-ico-a4-home-');
        fs.mkdirSync(path.dirname(configYml(home4)), { recursive: true });
        fs.writeFileSync(configYml(home4), 'setupVersion: 2\nextensions:\n');
        const r4 = runCli(['connect', 'omp'], home4, atlasHome);
        assert.equal(r4.code, 0, `A4: connect exits 0 (stderr: ${r4.stderr})`);
        assert.equal(fs.readFileSync(configYml(home4), 'utf8'), `setupVersion: 2\nextensions:\n  - ${OURS}\n`, 'A4: item inserted directly under the empty key');
        for (const h of [home3, home4]) fs.rmSync(h, { recursive: true, force: true });
        console.log('  ✓ CLAIM A — fresh install creates the extensions: block + hook, byte-preserving anything else');
    }

    // ── CLAIM B — merge into an existing list: one line, byte-exact rest ──
    {
        const home = tmp('atlas-ico-b-home-');
        fs.mkdirSync(path.dirname(configYml(home)), { recursive: true });
        fs.writeFileSync(configYml(home), SEED);
        const r = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r.code, 0, `B: connect exits 0 (stderr: ${r.stderr})`);
        const after = fs.readFileSync(configYml(home), 'utf8');
        assert.equal(after, SEED_CONNECTED, 'B: exactly one new line after the last item; full-file byte equality');
        assert.equal(count(after, OURS), 1, 'B: our entry appears exactly once');
        assert.ok(after.includes('# machine-wide OMP agent config'), 'B: comments preserved');
        assert.ok(backupsIn(home).length >= 1, 'B: config.yml backed up before the edit');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM B — appends one line to a seeded list; unrelated entries/comments byte-identical');
    }

    // ── CLAIM C — idempotent re-run: no duplicate line, no new backup ──────
    {
        const home = tmp('atlas-ico-c-home-');
        fs.mkdirSync(path.dirname(configYml(home)), { recursive: true });
        fs.writeFileSync(configYml(home), SEED);
        assert.equal(runCli(['connect', 'omp'], home, atlasHome).code, 0, 'C: first connect exits 0');
        const after1 = fs.readFileSync(configYml(home), 'utf8');
        const baks1 = backupsIn(home).length;

        const r2 = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r2.code, 0, 'C: second connect exits 0');
        assert.equal(fs.readFileSync(configYml(home), 'utf8'), after1, 'C: config byte-stable across re-runs');
        assert.equal(count(fs.readFileSync(configYml(home), 'utf8'), OURS), 1, 'C: still exactly one registration line');
        assert.equal(backupsIn(home).length, baks1, 'C: no spurious backup on the no-op re-run');
        assert.ok(r2.stdout.includes('no changes'), `C: reports the idempotent no-op, got: ${r2.stdout}`);
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM C — re-run is a byte-stable no-op with no new backup');
    }

    // ── CLAIM D — disconnect removes only our line; hook file stays ────────
    {
        const home = tmp('atlas-ico-d-home-');
        fs.mkdirSync(path.dirname(configYml(home)), { recursive: true });
        fs.writeFileSync(configYml(home), SEED);
        assert.equal(runCli(['connect', 'omp'], home, atlasHome).code, 0, 'D: connect exits 0');

        const r = runCli(['disconnect', 'omp'], home, atlasHome);
        assert.equal(r.code, 0, `D: disconnect exits 0 (stderr: ${r.stderr})`);
        assert.ok(r.stdout.includes('removed atlas-consult.ts'), `D: reports the removal, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(configYml(home), 'utf8'), SEED, 'D: file restored to the seed byte-for-byte');
        assert.ok(fs.existsSync(hookFile(home)), 'D: hook file NOT deleted (config-only precedent)');
        assert.equal(fs.readFileSync(hookFile(home), 'utf8'), OMP_HOOK_SOURCE, 'D: hook content untouched by disconnect');

        const r2 = runCli(['disconnect', 'omp'], home, atlasHome);
        assert.equal(r2.code, 0, 'D: second disconnect is a clean no-op');
        assert.ok(r2.stdout.includes('no atlas-consult.ts entry present'), `D: second disconnect reports nothing to remove, got: ${r2.stdout}`);
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM D — disconnect excises exactly our line; hook file stays; second run is a no-op');
    }

    // ── CLAIM E — the installed hook file is the canonical source ──────────
    {
        const home = tmp('atlas-ico-e-home-');
        const r = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r.code, 0, `E: connect exits 0 (stderr: ${r.stderr})`);
        const installed = fs.readFileSync(hookFile(home), 'utf8');
        assert.equal(installed, OMP_HOOK_SOURCE, 'E: installed hook is byte-identical to cli/ompHook.ts OMP_HOOK_SOURCE');
        assert.ok(installed.includes('POST http://127.0.0.1:'), 'E: installed hook is the advisory hook, not a stub');
        assert.ok(!installed.includes('<TOKEN>'), 'E: no placeholder/token templating — the hook resolves auth at runtime');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM E — installed atlas-consult.ts === OMP_HOOK_SOURCE, byte-for-byte');
    }

    // ── CLAIM F — a customized pre-existing hook is backed up, not lost ────
    {
        const home = tmp('atlas-ico-f-home-');
        fs.mkdirSync(path.dirname(hookFile(home)), { recursive: true });
        const custom = '// my heavily customized local hook — do not lose me\nexport default function () { return; }\n';
        fs.writeFileSync(hookFile(home), custom);
        fs.mkdirSync(path.dirname(configYml(home)), { recursive: true });
        fs.writeFileSync(configYml(home), SEED); // does NOT register ours
        const r = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r.code, 0, `F: connect over a customized hook exits 0 (stderr: ${r.stderr})`);
        assert.equal(fs.readFileSync(hookFile(home), 'utf8'), OMP_HOOK_SOURCE, 'F: hook file replaced with the canonical source');
        const baks = backupsIn(home).filter((b) => b.startsWith(OMP_HOOK_FILENAME));
        assert.equal(baks.length, 1, 'F: exactly one hook backup written before the overwrite');
        assert.equal(fs.readFileSync(path.join(path.dirname(hookFile(home)), baks[0]!), 'utf8'), custom, 'F: the backup holds the user\'s customized content verbatim');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM F — customized hook backed up before overwrite, content recoverable');
    }

    // ── CLAIM G — flow-style extensions fails closed, file untouched ───────
    {
        const home = tmp('atlas-ico-g-home-');
        fs.mkdirSync(path.dirname(configYml(home)), { recursive: true });
        const flow = `extensions: [${UNRELATED_A}, ${OURS}]\ncomposer: \n  shape: box\n`;
        fs.writeFileSync(configYml(home), flow);
        const r = runCli(['connect', 'omp'], home, atlasHome);
        assert.equal(r.code, 1, 'G: connect over a flow-style extensions list exits 1 (failed)');
        assert.ok(r.stdout.includes('left untouched'), `G: reports the fail-closed outcome, got: ${r.stdout}`);
        assert.equal(fs.readFileSync(configYml(home), 'utf8'), flow, 'G: config.yml is byte-identical — never overwritten');
        assert.equal(backupsIn(home).length, 0, 'G: no backup written (nothing was edited)');
        assert.ok(!fs.existsSync(hookFile(home)), 'G: hook file NOT written either — the config is checked before anything touches disk');
        const r2 = runCli(['disconnect', 'omp'], home, atlasHome);
        assert.equal(r2.code, 1, 'G: disconnect over the same shape also fails closed');
        assert.equal(fs.readFileSync(configYml(home), 'utf8'), flow, 'G: still untouched after the disconnect attempt');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('  ✓ CLAIM G — flow-style `extensions: [a, b]` → status failed, exit 1, file untouched, no backup, no hook');
    }

    fs.rmSync(atlasHome, { recursive: true, force: true });
    console.log('All ide-connect-omp tests passed.');
}

await main();
