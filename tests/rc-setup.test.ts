/**
 * tests/rc-setup.test.ts — "one-step client setup" (branch atlas-rc-reconcile).
 *
 * Covers the three pieces added so Groundfloor Atlas auto-wires a client instead of
 * requiring a separate `atlas connect` / `atlas wire install` step:
 *
 *   B1  — `atlas service install` auto-runs `connect all` (default on),
 *         `--no-connect` skips it. Parsing is exercised directly via the
 *         exported `parseArgs` (cli.ts) rather than by actually running
 *         `service install` — that mutates this machine's REAL
 *         ~/Library/LaunchAgents (installService has no CLI-level injection
 *         seam for a fake launchAgentsDir/exec; that seam is unit-tested
 *         directly against installService() in tests/service.test.ts, which
 *         this file must not touch). Asserting the parsed flag is therefore
 *         the safe, honest way to prove the wiring without side effects.
 *   B2a — the new `atlas_wire` MCP tool (src/mcp/allTools.ts): validates
 *         `project` exists/is a directory, runs the opt-in scanPathError
 *         allowlist gate, then delegates to installWire() (src/cli/wire.ts,
 *         unmodified) — exercised end-to-end through the real ToolRegistry
 *         (buildRegistry) so schema validation + the handler both run, not
 *         just the underlying installWire() unit.
 *   B2b — atlas-ui onboarding/AddProjectModal auto-wire call is a frontend
 *         concern covered by the atlas-ui vitest suite + manual build/review
 *         (no jsdom/browser harness lives in this tsx test runner).
 *
 *   CLAIM A — `service install --no-connect` parses noConnect:true; omitted
 *             defaults to false (auto-connect stays on).
 *   CLAIM B — atlas_wire on a fresh temp project dir writes .claude/settings.json
 *             (with the Atlas PreToolUse/PostToolUse hooks) + .claude/skills/* +
 *             CLAUDE.md, mirroring `atlas wire install`.
 *   CLAIM C — atlas_wire rejects a path that does not exist, and a path that
 *             exists but is not a directory (e.g. a plain file) — not an
 *             arbitrary-write primitive.
 *   CLAIM D — atlas_wire rejects a path outside the ATLAS_INDEX_ROOTS
 *             allowlist when one is configured (same opt-in gate atlas_index
 *             / workspace_add_project use), and allows it back in once the
 *             allowlist covers it.
 *   CLAIM E — SECURITY (CRITICAL, delta-audit): a malicious `workspace` override
 *             (e.g. `ws";touch <tmpfile>;"`) is REJECTED — by installWire() (the
 *             authoritative choke point) AND by the atlas_wire tool handler
 *             (defense in depth) — so it can NEVER reach the /bin/sh git-hook
 *             script (gitHooks.ts `--workspace "${workspace}"`) as an injectable
 *             payload. Proves: error returned, NO .claude/settings.json / CLAUDE.md
 *             / git hook written, and the injection tmpfile is NOT created. A VALID
 *             slug still wires successfully (no regression).
 *   CLAIM F — the ARCADE_SECRET_ env-scrub belt: with ARCADE_SECRET_FOO exported,
 *             opening an EmbeddedLore deletes it from process.env (Atlas's
 *             defense-in-depth belt for a Lore envScrub prefix gap flagged
 *             upstream — Atlas embedded never uses the arcade secret backend).
 *   CLAIM G — RD-idx-async: `index … --wait` parses to wait:true (default
 *             false), doesn't interfere with adjacent flags, and `index status`
 *             parses positional[0]==='status' (the subcommand-keyword the
 *             runCli dispatch checks before treating it as a path) with
 *             --workspace still threaded through. Parsing-only, same rationale
 *             as CLAIM A: proves the wiring without spawning the real daemon
 *             call cmdIndex's async detach path depends on.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseArgs } from '../src/cli.js';
import { buildRegistry } from '../src/mcp/allTools.js';
import { installWire } from '../src/cli/wire.js';
import { EmbeddedLore } from '../src/lore/embeddedLore.js';

function tmp(prefix: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

async function main(): Promise<void> {
    console.log('Running RC one-step-setup tests…');

    // ── CLAIM A — `--no-connect` parsing ──────────────────────────────────────
    {
        const withFlag = parseArgs(['node', 'atlas', 'service', 'install', '--no-connect']);
        assert.equal(withFlag.command, 'service');
        assert.deepEqual(withFlag.positional, ['install']);
        assert.equal(withFlag.noConnect, true, '--no-connect parses to noConnect:true');

        const withoutFlag = parseArgs(['node', 'atlas', 'service', 'install']);
        assert.equal(withoutFlag.noConnect, false, 'omitted --no-connect defaults to false (auto-connect stays on)');

        const withPortAndFlag = parseArgs(['node', 'atlas', 'service', 'install', '--port', '4001', '--no-connect']);
        assert.equal(withPortAndFlag.port, 4001, '--no-connect does not interfere with adjacent flag parsing');
        assert.equal(withPortAndFlag.noConnect, true);
        console.log('  ✓ CLAIM A: `service install --no-connect` parses; default is auto-connect ON');
    }

    // ── CLAIM B — atlas_wire installs the harness into a temp project dir ────
    {
        const registry = buildRegistry(Date.now());
        const projectDir = tmp('atlas-rc-setup-wire-');

        const result = (await registry.invoke('atlas_wire', { project: projectDir })) as {
            ok: boolean;
            settingsFile?: string;
            claudeFile?: string;
            skills?: string[];
            workspace?: string;
        };

        assert.equal(result.ok, true, `atlas_wire should succeed on a fresh temp dir; got ${JSON.stringify(result)}`);
        assert.ok(result.settingsFile && fs.existsSync(result.settingsFile), '.claude/settings.json written');
        assert.ok(result.claudeFile && fs.existsSync(result.claudeFile), 'CLAUDE.md written');
        assert.ok(Array.isArray(result.skills) && result.skills.length > 0, 'skills written');
        for (const skillFile of result.skills ?? []) {
            assert.ok(fs.existsSync(skillFile), `skill file exists: ${skillFile}`);
        }

        const settings = JSON.parse(fs.readFileSync(result.settingsFile!, 'utf-8')) as {
            hooks?: { PreToolUse?: unknown[]; PostToolUse?: unknown[] };
        };
        assert.ok(settings.hooks?.PreToolUse?.length, 'PreToolUse hooks installed');
        assert.ok(settings.hooks?.PostToolUse?.length, 'PostToolUse hooks installed');
        console.log('  ✓ CLAIM B: atlas_wire writes .claude/settings.json (hooks) + CLAUDE.md + skills');
    }

    // ── CLAIM C — rejected for a bogus / non-directory path ───────────────────
    {
        const registry = buildRegistry(Date.now());

        const bogus = path.join(os.tmpdir(), `atlas-rc-setup-does-not-exist-${Date.now()}`);
        const rBogus = (await registry.invoke('atlas_wire', { project: bogus })) as { error?: string };
        assert.ok(rBogus.error, 'atlas_wire rejects a path that does not exist');

        const fileNotDir = tmp('atlas-rc-setup-file-');
        const plainFile = path.join(fileNotDir, 'not-a-directory.txt');
        fs.writeFileSync(plainFile, 'hello');
        const rFile = (await registry.invoke('atlas_wire', { project: plainFile })) as { error?: string };
        assert.ok(rFile.error, 'atlas_wire rejects a path that exists but is not a directory');

        const rMissingField = (await registry.invoke('atlas_wire', {})) as { error?: string };
        assert.ok(rMissingField.error, 'atlas_wire rejects a call missing the required `project` field');

        console.log('  ✓ CLAIM C: atlas_wire rejected for nonexistent path / non-directory path / missing field');
    }

    // ── CLAIM D — opt-in scan-path allowlist gate (not an arbitrary-write primitive) ──
    {
        const registry = buildRegistry(Date.now());
        const allowedRoot = tmp('atlas-rc-setup-allowed-');
        const outsideProject = tmp('atlas-rc-setup-outside-');

        const savedRoots = process.env['ATLAS_INDEX_ROOTS'];
        process.env['ATLAS_INDEX_ROOTS'] = allowedRoot;
        try {
            const rOutside = (await registry.invoke('atlas_wire', { project: outsideProject })) as { error?: string; ok?: boolean };
            assert.ok(rOutside.error, 'atlas_wire rejects a project outside the configured ATLAS_INDEX_ROOTS allowlist');
            assert.ok(!rOutside.ok, 'rejected call does not report ok:true');

            const insideProject = path.join(allowedRoot, 'proj');
            fs.mkdirSync(insideProject, { recursive: true });
            const rInside = (await registry.invoke('atlas_wire', { project: insideProject })) as { ok?: boolean };
            assert.equal(rInside.ok, true, 'atlas_wire allows a project inside the configured allowlist');
        } finally {
            if (savedRoots === undefined) delete process.env['ATLAS_INDEX_ROOTS'];
            else process.env['ATLAS_INDEX_ROOTS'] = savedRoots;
        }
        console.log('  ✓ CLAIM D: atlas_wire honors the opt-in ATLAS_INDEX_ROOTS allowlist (in + out of bounds)');
    }

    // ── CLAIM E — SECURITY: command-injection via `workspace` → RCE is BLOCKED ──
    {
        const registry = buildRegistry(Date.now());

        // A real git repo so the git-hook install path (the RCE sink) is actually
        // reached: installWire only calls installGitHookSync when isGitRepo(dir).
        const gitProject = tmp('atlas-rc-sec-git-');
        execFileSync('git', ['init', '-q'], { cwd: gitProject });
        // git needs an identity for later ops; harmless config, repo-local.
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: gitProject });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: gitProject });
        // Pin hooks to a repo-local dir so this test is deterministic and does NOT
        // write into this machine's shared global core.hooksPath (gitHooks.ts
        // honors core.hooksPath — RD-hooks-path — which is set globally here).
        const localHooks = path.join(gitProject, '.githooks');
        fs.mkdirSync(localHooks, { recursive: true });
        execFileSync('git', ['config', 'core.hooksPath', localHooks], { cwd: gitProject });

        // The canary: a file the injected shell would create if `workspace` ever
        // reached /bin/sh unsanitized. It lives OUTSIDE the project so it can't be
        // confused with any legit wired artifact.
        const canary = path.join(tmp('atlas-rc-sec-canary-'), 'pwned.txt');
        assert.ok(!fs.existsSync(canary), 'precondition: canary absent');

        // Classic break-out-of-the-double-quote payload. Interpolated into the hook
        // as `--workspace "<payload>"`, an unsanitized value would close the quote,
        // run `touch <canary>`, then re-open — executing on the next commit/hook run.
        const evil = `ws";touch ${canary};"`;

        const hookDir = localHooks; // where core.hooksPath points → where hooks land
        const settingsFile = path.join(gitProject, '.claude', 'settings.json');
        const claudeFile = path.join(gitProject, 'CLAUDE.md');

        // (E1) Authoritative choke point — installWire() rejects the payload.
        const direct = await installWire(gitProject, evil);
        assert.equal(direct.ok, false, `installWire must REJECT a non-slug workspace; got ${JSON.stringify(direct)}`);
        assert.match(String(direct.error), /invalid workspace name/i, 'installWire returns a clear invalid-workspace error');

        // No wiring artifacts written on the rejected path.
        assert.ok(!fs.existsSync(settingsFile), 'REJECTED: no .claude/settings.json written');
        assert.ok(!fs.existsSync(claudeFile), 'REJECTED: no CLAUDE.md written');
        for (const h of ['pre-commit', 'post-merge', 'post-checkout']) {
            assert.ok(!fs.existsSync(path.join(hookDir, h)), `REJECTED: no git ${h} hook written`);
        }

        // (E2) Tool-handler boundary (defense in depth) — same payload, same reject.
        const viaTool = (await registry.invoke('atlas_wire', { project: gitProject, workspace: evil })) as { error?: string; ok?: boolean };
        assert.ok(viaTool.error, 'atlas_wire tool handler REJECTS the injection payload');
        assert.ok(!viaTool.ok, 'rejected tool call does not report ok:true');
        assert.match(String(viaTool.error), /invalid workspace name/i, 'tool handler returns a clear invalid-workspace error');

        // (E3) THE proof: even if a hook had slipped through, actually FIRE the
        // git commit path and confirm the injected command never ran. The canary
        // must not exist after either the rejected wire OR a real commit.
        fs.writeFileSync(path.join(gitProject, 'f.txt'), 'x');
        execFileSync('git', ['add', '.'], { cwd: gitProject });
        // Commit may legitimately run whatever (harmless) hooks exist; --no-verify
        // is deliberately NOT used so any accidentally-written pre-commit executes.
        try { execFileSync('git', ['commit', '-q', '-m', 'sec-test'], { cwd: gitProject }); } catch { /* ok — no hook, or hook exit code */ }
        assert.ok(!fs.existsSync(canary), 'RCE BLOCKED: injected `touch` never executed — canary was not created');

        // (E4) No regression — a VALID slug still wires the full harness, hooks and all.
        const okWs = 'valid-ws-123';
        const good = await installWire(gitProject, okWs) as {
            ok: boolean; workspace?: string; settingsFile?: string; claudeFile?: string; skills?: string[];
            gitHookSync?: { ok?: boolean; hooksDir?: string };
        };
        assert.equal(good.ok, true, `valid workspace must still wire; got ${JSON.stringify(good)}`);
        assert.equal(good.workspace, okWs, 'valid workspace is used verbatim');
        assert.ok(good.settingsFile && fs.existsSync(good.settingsFile), 'VALID: .claude/settings.json written');
        assert.ok(good.claudeFile && fs.existsSync(good.claudeFile), 'VALID: CLAUDE.md written');
        assert.ok(good.gitHookSync?.ok, 'VALID: git hook sync installed (git-repo path exercised)');
        // Hooks land where git ACTUALLY looks (core.hooksPath) — the pinned dir.
        assert.equal(path.resolve(good.gitHookSync!.hooksDir!), path.resolve(hookDir), 'hooks written to the pinned core.hooksPath dir');
        // The written pre-commit hook must carry the slug verbatim and NOT the payload.
        const preCommit = fs.readFileSync(path.join(hookDir, 'pre-commit'), 'utf-8');
        assert.ok(preCommit.includes(`--workspace "${okWs}"`), 'hook references the valid slug');
        assert.ok(!preCommit.includes('touch '), 'hook contains no injected command');

        console.log('  ✓ CLAIM E: workspace command-injection → RCE is BLOCKED (installWire + tool handler); valid slug still wires');
    }

    // ── CLAIM F — ARCADE_SECRET_ env-scrub belt (defense-in-depth) ────────────
    // Lore's envScrub UNCONDITIONALLY keeps any ARCADE_SECRET_* var, even on the
    // embedded path Atlas uses — so an inherited arcade-secret var would survive
    // in Atlas's daemon env even though Atlas never enters arcade mode. Atlas's
    // belt (EmbeddedLore.open, just before createLore) deletes every process.env
    // key starting with ARCADE_SECRET_ BEFORE Lore's scrub runs. Prove it: set
    // one, open an embedded instance, assert the key is gone from process.env.
    {
        const key = 'ARCADE_SECRET_FOO';
        const hadBefore = Object.prototype.hasOwnProperty.call(process.env, key);
        const prev = process.env[key];
        process.env[key] = 'x';
        const dataDir = tmp('atlas-rc-setup-envbelt-');
        let lore: EmbeddedLore | undefined;
        try {
            lore = await EmbeddedLore.open(dataDir);
            assert.ok(
                !Object.prototype.hasOwnProperty.call(process.env, key),
                `${key} must be scrubbed from process.env after opening EmbeddedLore (env belt for the Lore envScrub ARCADE_SECRET_ prefix gap)`,
            );
            console.log('  ✓ CLAIM F: ARCADE_SECRET_* is stripped from process.env when EmbeddedLore opens (env-scrub belt)');
        } finally {
            if (lore) await lore.close().catch(() => undefined);
            fs.rmSync(dataDir, { recursive: true, force: true });
            // Restore the test env to its prior state (the belt deleted our probe).
            if (hadBefore) process.env[key] = prev; else delete process.env[key];
        }
    }

    // ── CLAIM G — `index --wait` / `index status` flag + subcommand parsing ───
    {
        const defaulted = parseArgs(['node', 'atlas', 'index', '.']);
        assert.equal(defaulted.wait, false, 'omitted --wait defaults to false (fire-and-forget stays the default)');

        const withWait = parseArgs(['node', 'atlas', 'index', '.', '--wait']);
        assert.equal(withWait.command, 'index');
        assert.deepEqual(withWait.positional, ['.']);
        assert.equal(withWait.wait, true, '--wait parses to wait:true');

        const waitWithWorkspace = parseArgs(['node', 'atlas', 'index', '.', '--workspace', 'ws1', '--wait']);
        assert.equal(waitWithWorkspace.workspace, 'ws1', '--wait does not interfere with adjacent flag parsing');
        assert.equal(waitWithWorkspace.wait, true);

        const status = parseArgs(['node', 'atlas', 'index', 'status', '--workspace', 'ws2']);
        assert.equal(status.command, 'index');
        assert.deepEqual(status.positional, ['status'], '"status" is the subcommand keyword runCli checks before treating positional[0] as a path');
        assert.equal(status.workspace, 'ws2', '--workspace still threads through for the status subcommand');
        console.log('  ✓ CLAIM G: `index --wait` parses (default false); `index status --workspace` parses correctly');
    }

    console.log('All RC one-step-setup tests passed.');
}

await main();
