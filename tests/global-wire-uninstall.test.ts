/**
 * tests/global-wire-uninstall.test.ts — Atlas auto-wire Part 6: `atlas wire
 * uninstall --global` (src/cli/globalWire.ts's uninstallGlobalWire,
 * src/cli/wireAllProjects.ts's uninstallWireAllProjects, and the CLI
 * dispatch in src/cli.ts's `case 'wire'`).
 *
 * Part 3 (docs/plans/ATLAS-AUTOWIRE-PLAN.md) shipped `wire install --global`
 * — a machine-wide hook, no per-repo step. Part 6 is its deliberate
 * counterweight: ONE command undoes every trace that install (and every
 * per-repo `wire install`, and every `atlas connect`) ever left behind, and
 * nothing Atlas writes brings any of it back on its own — the anti-GitNexus
 * property the owner asked for by name.
 *
 *   CLAIM A — uninstallGlobalWire on a home with NO global settings file is a
 *             no-op success (ok:true, removed:false) — nothing to remove is
 *             not an error.
 *   CLAIM B — install then uninstall: every Atlas hook entry (by HOOK_TAG) is
 *             gone from both PreToolUse and PostToolUse; every unrelated
 *             top-level key AND any pre-existing non-Atlas hook entry survive
 *             byte-for-byte; a backup is written and matches the pre-uninstall
 *             content.
 *   CLAIM C — idempotent: uninstalling twice — the second call reports
 *             removed:false and leaves the file exactly as the first call did.
 *   CLAIM D — malformed existing JSON is refused (ok:false), file untouched.
 *   CLAIM E — the file is chmod'd 0600 after an uninstall that actually edits it.
 *   CLAIM F — uninstallWireAllProjects mirrors installWireAllProjects's own
 *             enumeration: removes wiring from every registered project,
 *             skips a path that no longer exists on disk, and leaves content
 *             outside the Atlas markers untouched.
 *   CLAIM G — end-to-end CLI: `wire uninstall --global` (a) strips the global
 *             hook, (b) removes per-repo wiring from every registered
 *             project, (c) disconnects every configured IDE's MCP entry
 *             (`atlas disconnect all`) — proven against a REAL spawned CLI
 *             process with an isolated HOME/ATLAS_HOME, not by inspecting
 *             internals. Unrelated content in every touched file survives.
 *   CLAIM H — no self-reinstall clause: nothing this command (or any prior
 *             install step) wrote anywhere in the touched tree instructs an
 *             agent to install/reinstall Atlas — grepped for literally, per
 *             the plan's own invariant 1 acceptance language.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobalWire, uninstallGlobalWire, globalSettingsPath } from '../src/cli/globalWire.js';
import { installWire, HOOK_TAG } from '../src/cli/wire.js';
import { installWireAllProjects, uninstallWireAllProjects } from '../src/cli/wireAllProjects.js';
import type { AtlasConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLAUDE_BEGIN = '<!-- atlas-wire-begin -->';

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Settings {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>; PostToolUse?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> };
    [k: string]: unknown;
}

function readSettings(file: string): Settings {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Settings;
}

function atlasCommands(s: Settings): string[] {
    const all = [...(s.hooks?.PreToolUse ?? []), ...(s.hooks?.PostToolUse ?? [])];
    return all.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes(HOOK_TAG));
}

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A temp git repo whose hooks dir is isolated to itself, so per-repo wire
 *  install/uninstall never touches this machine's shared git hooks. */
function freshRepo(name: string): string {
    const dir = tmp(`atlas-gwu-repo-${name}-`);
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks);
    return dir;
}

/** Recursively collect every regular file under a directory (skip .git). */
function allFiles(dir: string): string[] {
    const out: string[] = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...allFiles(full));
        else out.push(full);
    }
    return out;
}

// ── CLAIM A–E — uninstallGlobalWire unit behavior ────────────────────────────

async function unitClaims(): Promise<void> {
    // ── CLAIM A — nothing to remove ─────────────────────────────────────────
    {
        const home = tmp('atlas-gwu-a-home-');
        const r = uninstallGlobalWire({ home });
        assert.equal(r.ok, true, 'A: uninstall on a home with no settings file must succeed');
        assert.equal(r['removed'], false, 'A: nothing was actually removed');
        assert.equal(r['backup'], null, 'A: no backup when there was nothing to touch');
        assert.equal(fs.existsSync(globalSettingsPath(home)), false, 'A: no file is created by uninstalling');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM A ok — uninstall with no global settings file is a no-op success');
    }

    // ── CLAIM B — install then uninstall: precise removal, merge preserved ──
    let bHome!: string;
    let beforeUninstall!: Settings;
    {
        bHome = tmp('atlas-gwu-b-home-');
        const file = globalSettingsPath(bHome);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const before: Settings = {
            permissions: { allow: ['Bash(ls)'], deny: [] },
            enabledPlugins: { foo: true },
            hooks: {
                PreToolUse: [{ matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'echo not-atlas' }] }],
            },
        };
        fs.writeFileSync(file, JSON.stringify(before, null, 2));

        const gr = installGlobalWire({ home: bHome });
        assert.equal(gr.ok, true, 'B setup: install must succeed');
        beforeUninstall = readSettings(file);
        assert.equal(atlasCommands(beforeUninstall).length, 3, 'B setup: 3 Atlas entries present after install');

        const r = uninstallGlobalWire({ home: bHome });
        assert.equal(r.ok, true, 'B: uninstall must succeed');
        assert.equal(r['removed'], true, 'B: something was actually removed');
        assert.ok(r['backup'], 'B: a backup is taken before an in-place edit');
        assert.deepEqual(JSON.parse(fs.readFileSync(r['backup'] as string, 'utf-8')), beforeUninstall, 'B: backup is a faithful copy of the pre-uninstall content');

        const after = readSettings(file);
        assert.equal(atlasCommands(after).length, 0, 'B: zero Atlas hook entries remain');
        const survivor = (after.hooks?.PreToolUse ?? []).find((e) => e.matcher === 'SomeOtherTool');
        assert.ok(survivor, 'B: the pre-existing non-Atlas hook entry survives uninstall');
        assert.equal(survivor!.hooks[0]?.command, 'echo not-atlas', 'B: the non-Atlas hook command is unchanged');
        const { hooks: _afterHooks, ...afterRest } = after;
        const { hooks: _beforeHooks, ...beforeRest } = before;
        assert.deepEqual(afterRest, beforeRest, 'B: every top-level key outside `hooks` is untouched, exhaustively');
        console.log('CLAIM B ok — uninstall removes only Atlas entries, merge-preserves everything else');
    }

    // ── CLAIM C — idempotent second uninstall ───────────────────────────────
    {
        const file = globalSettingsPath(bHome);
        const before = readSettings(file);
        const r2 = uninstallGlobalWire({ home: bHome });
        assert.equal(r2.ok, true, 'C: second uninstall succeeds');
        assert.equal(r2['removed'], false, 'C: second uninstall finds nothing left to remove');
        assert.equal(r2['backup'], null, 'C: no backup taken on a no-op uninstall');
        const after = readSettings(file);
        assert.deepEqual(after, before, 'C: re-running uninstall is a content no-op');
        fs.rmSync(bHome, { recursive: true, force: true });
        console.log('CLAIM C ok — re-uninstalling is idempotent');
    }

    // ── CLAIM D — malformed existing file refused, left untouched ──────────
    {
        const home = tmp('atlas-gwu-d-home-');
        const file = globalSettingsPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const garbage = '{ this is not valid json,,,';
        fs.writeFileSync(file, garbage);
        const r = uninstallGlobalWire({ home });
        assert.equal(r.ok, false, 'D: uninstall on malformed JSON must fail, not silently overwrite');
        assert.equal(fs.readFileSync(file, 'utf-8'), garbage, 'D: the malformed file is left byte-for-byte untouched');
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM D ok — malformed global settings refused, left untouched');
    }

    // ── CLAIM E — 0600 perms after an editing uninstall ─────────────────────
    {
        const home = tmp('atlas-gwu-e-home-');
        installGlobalWire({ home });
        uninstallGlobalWire({ home });
        const file = globalSettingsPath(home);
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600, `E: settings file must be chmod 0600, got ${mode.toString(8)}`);
        fs.rmSync(home, { recursive: true, force: true });
        console.log('CLAIM E ok — global settings file is chmod 0600 after uninstall');
    }
}

// ── CLAIM F — uninstallWireAllProjects mirrors the install-side enumeration ─

async function bulkClaim(): Promise<void> {
    const home = tmp('atlas-gwu-f-home-');
    const repoA = freshRepo('a');
    const repoB = freshRepo('b');
    const missing = path.join(os.tmpdir(), 'atlas-gwu-f-missing-' + Date.now());

    // repoA carries user prose outside the Atlas markers — must survive.
    fs.writeFileSync(path.join(repoA, 'CLAUDE.md'), '# Repo A notes\n\nDo not break the widget.\n');

    const loreData = path.join(home, 'lore-data');
    fs.mkdirSync(path.join(loreData, 'ws-a'), { recursive: true });
    fs.mkdirSync(path.join(loreData, 'ws-b'), { recursive: true });
    fs.writeFileSync(path.join(loreData, 'ws-a', 'projects.json'), JSON.stringify([{ path: repoA, addedAt: '2026-01-01T00:00:00Z' }]));
    fs.writeFileSync(path.join(loreData, 'ws-b', 'projects.json'), JSON.stringify([
        { path: repoB, addedAt: '2026-01-02T00:00:00Z' },
        { path: missing, addedAt: '2026-01-03T00:00:00Z' },
    ]));

    const cfg: AtlasConfig = {
        port: 3848,
        home,
        lore: { workspace: 'developer', mcpUrl: 'http://127.0.0.1:3847/mcp', mode: 'embedded', dataDir: loreData },
    };

    const installed = await installWireAllProjects(cfg);
    assert.equal(installed.wired, 2, 'F setup: both repos wire successfully');
    assert.ok(fs.readFileSync(path.join(repoA, 'CLAUDE.md'), 'utf8').includes(CLAUDE_BEGIN), 'F setup: repoA CLAUDE.md carries the Atlas block');
    assert.ok(fs.readFileSync(path.join(repoA, '.claude', 'settings.json'), 'utf8').includes(HOOK_TAG), 'F setup: repoA has the local hook');

    const r = uninstallWireAllProjects(cfg);
    assert.equal(r.ok, true, 'F: bulk uninstall reports ok');
    assert.equal(r.total, 3, 'F: sees all 3 registered entries (2 real + 1 missing)');
    assert.equal(r.removed, 2, 'F: removes wiring from both real repos');
    assert.equal(r.failed, 0, 'F: no failures');
    assert.equal(r.skipped, 1, 'F: the missing path is skipped, not failed');

    for (const repo of [repoA, repoB]) {
        const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
        assert.ok(!claude.includes(CLAUDE_BEGIN), `F: ${repo} CLAUDE.md no longer carries the Atlas block`);
        const settingsFile = path.join(repo, '.claude', 'settings.json');
        if (fs.existsSync(settingsFile)) {
            assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(HOOK_TAG), `F: ${repo} settings.json no longer carries the Atlas hook`);
        }
        assert.equal(fs.existsSync(path.join(repo, '.claude', 'skills', 'atlas-onboard')), false, `F: ${repo} Atlas skill dir removed`);
    }
    // repoA's user prose survives the round trip.
    assert.match(fs.readFileSync(path.join(repoA, 'CLAUDE.md'), 'utf8'), /Do not break the widget\./, 'F: user prose outside the Atlas markers survives uninstall');

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    console.log('CLAIM F ok — uninstallWireAllProjects removes wiring from every registered project, skips missing paths, preserves user prose');
}

// ── CLAIM G/H — end-to-end CLI `wire uninstall --global`, real subprocess ──

interface RunResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
    try {
        const stdout = execFileSync('npx', ['tsx', path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
            cwd: REPO_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: stdout.toString('utf-8'), stderr: '' };
    } catch (err) {
        const e = err as { status: number | null; stdout?: Buffer; stderr?: Buffer };
        return { code: e.status, stdout: e.stdout?.toString('utf-8') ?? '', stderr: e.stderr?.toString('utf-8') ?? '' };
    }
}

async function e2eClaim(): Promise<void> {
    const fakeHome = tmp('atlas-gwu-g-home-');
    const atlasHome = tmp('atlas-gwu-g-atlashome-');
    const repoA = freshRepo('g-a');
    const repoB = freshRepo('g-b');

    // Fake ~/.claude.json — as if `atlas connect` (or `atlas connect all`) had
    // already run: an existing Groundfloor Atlas MCP entry PLUS an unrelated
    // one that must survive disconnect untouched.
    const claudeJsonPath = path.join(fakeHome, '.claude.json');
    const claudeJsonBefore = {
        mcpServers: {
            'groundfloor-atlas': { type: 'http', url: 'http://127.0.0.1:3848/mcp', headers: { Authorization: 'Bearer faketoken' } },
            'some-other-server': { command: 'npx', args: ['-y', 'some-other-mcp'] },
        },
        someUnrelatedTopLevelKey: 'preserve-me',
    };
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJsonBefore, null, 2));
    // `.claude` dir presence is part of claude-code's `installed()` heuristic.
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

    // Register both repos + wire them locally (mirrors a real machine with
    // per-repo `atlas wire install` already run before Part 3/6 existed).
    const loreData = path.join(atlasHome, 'lore-data');
    fs.mkdirSync(path.join(loreData, 'ws-g-a'), { recursive: true });
    fs.mkdirSync(path.join(loreData, 'ws-g-b'), { recursive: true });
    fs.writeFileSync(path.join(loreData, 'ws-g-a', 'projects.json'), JSON.stringify([{ path: repoA }]));
    fs.writeFileSync(path.join(loreData, 'ws-g-b', 'projects.json'), JSON.stringify([{ path: repoB }]));
    const lr1 = await installWire(repoA, 'ws-g-a');
    const lr2 = await installWire(repoB, 'ws-g-b');
    assert.equal(lr1.ok, true, 'G setup: repoA local wire install succeeds');
    assert.equal(lr2.ok, true, 'G setup: repoB local wire install succeeds');

    // Global hook install into the fake home, via installGlobalWire directly
    // (equivalent to `wire install --global` with HOME=fakeHome).
    const gr = installGlobalWire({ home: fakeHome });
    assert.equal(gr.ok, true, 'G setup: global install succeeds');
    assert.ok(fs.readFileSync(globalSettingsPath(fakeHome), 'utf8').includes(HOOK_TAG), 'G setup: global settings carries the Atlas hook');

    // ── run the real CLI: `wire uninstall --global` ─────────────────────────
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        ATLAS_HOME: atlasHome,
        ATLAS_MCP_AUTH: 'off',
    };
    delete env['ATLAS_MCP_TOKEN'];
    const run = runCli(['wire', 'uninstall', '--global'], env);
    assert.equal(run.code, 0, `G: CLI exits 0 (stderr: ${run.stderr})`);

    // runConnect() also prints its own per-IDE '✓ ...' status lines to stdout
    // (via console.log, not console.error) ahead of the final JSON summary —
    // the JSON is always the trailing `{ ... }` block, so slice from its
    // opening brace rather than assuming stdout is JSON-only.
    const braceAt = run.stdout.indexOf('\n{\n');
    const jsonBlock = (braceAt >= 0 ? run.stdout.slice(braceAt + 1) : run.stdout).trim();
    let parsed: { ok: boolean; global: { removed: boolean }; perRepo: { removed: number; failed: number }; ideDisconnect: { ok: boolean } };
    try {
        parsed = JSON.parse(jsonBlock);
    } catch {
        throw new Error(`G: expected trailing JSON block in stdout, got:\n${run.stdout}`);
    }
    assert.equal(parsed.ok, true, 'G: overall result reports ok');
    assert.equal(parsed.global.removed, true, 'G: global hook was actually removed');
    assert.equal(parsed.perRepo.removed, 2, 'G: both registered repos had their wiring removed');
    assert.equal(parsed.perRepo.failed, 0, 'G: no per-repo failures');
    assert.equal(parsed.ideDisconnect.ok, true, 'G: IDE disconnect step reports ok');

    // (a) global hook gone, other content untouched.
    const globalAfter = JSON.parse(fs.readFileSync(globalSettingsPath(fakeHome), 'utf8')) as Settings;
    assert.equal(atlasCommands(globalAfter).length, 0, 'G: no Atlas commands remain in the global settings file');

    // (b) per-repo wiring gone, user content untouched.
    for (const repo of [repoA, repoB]) {
        assert.ok(!fs.existsSync(path.join(repo, '.claude', 'settings.json')) || !fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8').includes(HOOK_TAG), `G: ${repo} local hook removed`);
        const claudeMd = fs.existsSync(path.join(repo, 'CLAUDE.md')) ? fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8') : '';
        assert.ok(!claudeMd.includes(CLAUDE_BEGIN), `G: ${repo} CLAUDE.md Atlas block removed`);
        assert.equal(fs.existsSync(path.join(repo, '.claude', 'skills', 'atlas-onboard')), false, `G: ${repo} Atlas skills removed`);
    }

    // (c) IDE MCP entry gone; the unrelated server entry AND the unrelated
    // top-level key survive untouched.
    const claudeJsonAfter = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as typeof claudeJsonBefore;
    assert.ok(!('groundfloor-atlas' in claudeJsonAfter.mcpServers), 'G: the groundfloor-atlas MCP entry was removed from ~/.claude.json');
    assert.deepEqual(claudeJsonAfter.mcpServers['some-other-server'], claudeJsonBefore.mcpServers['some-other-server'], 'G: an unrelated MCP server entry survives disconnect untouched');
    assert.equal(claudeJsonAfter.someUnrelatedTopLevelKey, 'preserve-me', 'G: an unrelated top-level key in ~/.claude.json survives untouched');

    console.log('CLAIM G ok — `wire uninstall --global` removes the global hook, every registered repo\'s wiring, and IDE MCP entries in one real CLI run');

    // ── CLAIM H — no self-reinstall clause anywhere in the touched tree ────
    const touched = [
        ...allFiles(fakeHome).filter((f) => fs.existsSync(f)),
        ...allFiles(repoA),
        ...allFiles(repoB),
    ];
    const reinstallHits: string[] = [];
    for (const f of touched) {
        let content: string;
        try { content = fs.readFileSync(f, 'utf8'); } catch { continue; } // skip binaries/unreadable
        if (/reinstall/i.test(content)) reinstallHits.push(f);
    }
    assert.deepEqual(reinstallHits, [], `H: no file Atlas touched may instruct reinstalling Atlas, found mentions in: ${reinstallHits.join(', ')}`);
    console.log('CLAIM H ok — no self-reinstall clause exists anywhere in the touched tree');

    for (const d of [fakeHome, atlasHome, repoA, repoB]) fs.rmSync(d, { recursive: true, force: true });
}

async function main(): Promise<void> {
    console.log('Running global-wire-uninstall (auto-wire Part 6) tests…');
    await unitClaims();
    await bulkClaim();
    await e2eClaim();
    console.log('global-wire-uninstall: ALL CLAIMS PASS');
}

await main();
