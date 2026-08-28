/**
 * tests/wire-tools-status.test.ts — WO-5: `wireStatus`'s cross-tool `tools`
 * report — {claudeCode, omp, codex, cursor, vscode}, each one of
 * 'wired' | 'partial' | 'not-installed' | 'unknown'.
 *
 * Every scenario points `wireStatus`'s `home` opt at a throwaway tmpdir
 * (never the real machine's ~/.cursor or ~/.omp), so this test never reads
 * or writes this machine's real Cursor/OMP config.
 *
 * Coverage:
 *   CLAIM A — shape: `tools` always has exactly the five keys, each a valid
 *             ToolWireStatus value.
 *   CLAIM B — not-installed: nothing wired anywhere (fresh project, fresh
 *             home) reports 'not-installed' on all four surfaces.
 *   CLAIM C — partial: after `installWire` (repo-local artifacts land) but
 *             with NO machine-level Cursor/OMP config, cursor and codex land
 *             on 'partial' (repo half present, machine half absent) while
 *             claudeCode reaches 'wired' and omp stays 'not-installed'
 *             (neither of its two parts exist).
 *   CLAIM D — wired: a home with a correct ~/.cursor/mcp.json entry AND the
 *             repo's `.cursor/rules/atlas-consult.mdc`, plus a home with the
 *             OMP hook file present AND registered in config.yml's
 *             `extensions:` list, both report 'wired'.
 *   CLAIM E — unknown: an unparseable ~/.cursor/mcp.json and an
 *             inline/flow-style `extensions:` value in OMP's config.yml (which
 *             the naive line-scanner cannot resolve either way) both report
 *             'unknown' — never a guessed 'not-installed' or 'wired'.
 *   CLAIM F — codex reaches 'wired' only when BOTH halves are real: the
 *             repo AGENTS.md block AND a ~/.codex/config.toml entry
 *             (`atlas connect codex` writes it). A malformed config.toml is
 *             'unknown', never a guessed verdict.
 *
 * tsx-style: node:assert, top-level await, tmp dirs — no test framework.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installWire, wireStatus, type ToolWireStatus } from '../src/cli/wire.js';

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(repo: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A temp git repo whose hooks dir is isolated to itself, so `installWire`'s
 *  git memory-sync half never touches this machine's shared hooks. */
function freshRepo(name: string): string {
    const dir = tmp(`atlas-wts-${name}-`);
    git(dir, 'init');
    const hooks = path.join(dir, '.isolated-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(dir, 'config', 'core.hooksPath', hooks);
    return dir;
}

const VALID: Record<ToolWireStatus, true> = { wired: true, partial: true, 'not-installed': true, unknown: true };

function assertShape(tools: unknown, label: string): asserts tools is Record<'claudeCode' | 'omp' | 'codex' | 'cursor' | 'vscode', ToolWireStatus> {
    assert.ok(tools && typeof tools === 'object', `${label}: tools must be an object`);
    const keys = Object.keys(tools as Record<string, unknown>).sort();
    assert.deepEqual(keys, ['claudeCode', 'codex', 'cursor', 'omp', 'vscode'], `${label}: exactly the five expected keys`);
    for (const [k, v] of Object.entries(tools as Record<string, unknown>)) {
        assert.ok(VALID[v as ToolWireStatus], `${label}: ${k} must be a valid ToolWireStatus, got ${JSON.stringify(v)}`);
    }
}

async function main(): Promise<void> {
    console.log('Running wire-tools-status tests…');

    // ── CLAIM A/B — shape + not-installed on a completely untouched pair ───
    {
        const home = tmp('atlas-wts-a-home-');
        const repo = freshRepo('a-repo');
        const status = wireStatus(repo, { home }) as { tools: unknown };
        assertShape(status.tools, 'A');
        const tools = status.tools as Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus>;
        assert.equal(tools.claudeCode, 'not-installed', 'B: claudeCode not-installed on an unwired repo');
        assert.equal(tools.omp, 'not-installed', 'B: omp not-installed with no hook file and no config.yml');
        assert.equal(tools.codex, 'not-installed', 'B: codex not-installed with no AGENTS.md');
        assert.equal(tools.vscode, 'not-installed', 'B: vscode not-installed with no .vscode/mcp.json');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        console.log('  ✓ CLAIM A/B — shape pinned; fresh project+home reports not-installed everywhere');
    }

    // ── CLAIM C — partial: repo-local artifacts present, machine-level absent ─
    {
        const home = tmp('atlas-wts-c-home-'); // stays empty — no .cursor, no .omp
        const repo = freshRepo('c-repo');
        const r = await installWire(repo);
        assert.equal(r.ok, true, `C: installWire must succeed, got ${JSON.stringify(r)}`);
        const status = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assertShape(status.tools, 'C');
        assert.equal(status.tools.claudeCode, 'wired', 'C: claudeCode wired — full install wrote hooks+CLAUDE.md+skills');
        assert.equal(status.tools.cursor, 'partial', 'C: cursor partial — rules file present, no ~/.cursor/mcp.json');
        assert.equal(status.tools.codex, 'partial', 'C: codex partial — AGENTS.md present, no ~/.codex/config.toml entry');
        assert.equal(status.tools.omp, 'not-installed', 'C: omp not-installed — installWire never touches machine-level OMP config');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        console.log('  ✓ CLAIM C — repo-local-only wiring reports partial on cursor/codex, wired on claudeCode');
    }

    // ── CLAIM D — wired: both halves present for cursor and omp ────────────
    {
        const home = tmp('atlas-wts-d-home-');
        const repo = freshRepo('d-repo');
        const r = await installWire(repo);
        assert.equal(r.ok, true, `D: installWire must succeed, got ${JSON.stringify(r)}`);

        // Cursor's machine half: a valid ~/.cursor/mcp.json with the atlas entry.
        const cursorDir = path.join(home, '.cursor');
        fs.mkdirSync(cursorDir, { recursive: true });
        fs.writeFileSync(path.join(cursorDir, 'mcp.json'), JSON.stringify({
            mcpServers: { 'groundfloor-atlas': { url: 'http://127.0.0.1:3848/mcp', headers: {} } },
        }));

        // OMP's two halves: the hook file on disk AND registered in config.yml.
        const ompHooksDir = path.join(home, '.omp', 'agent', 'hooks', 'pre');
        fs.mkdirSync(ompHooksDir, { recursive: true });
        fs.writeFileSync(path.join(ompHooksDir, 'atlas-consult.ts'), '// stub hook file for the test\n');
        fs.writeFileSync(path.join(home, '.omp', 'agent', 'config.yml'), [
            'extensions: ',
            '  - ~/.omp/agent/hooks/pre/delegation-check.ts',
            '  - ~/.omp/agent/hooks/pre/atlas-consult.ts',
            'composer: ',
            '  shape: box',
        ].join('\n'));

        const status = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assertShape(status.tools, 'D');
        assert.equal(status.tools.cursor, 'wired', 'D: cursor wired — mcp.json entry + rules file both present');
        assert.equal(status.tools.omp, 'wired', 'D: omp wired — hook file present AND registered in extensions:');
        assert.equal(status.tools.codex, 'partial', 'D: codex still only partial — AGENTS.md present but this home has no ~/.codex/config.toml');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        console.log('  ✓ CLAIM D — cursor and omp both reach wired once both of their halves are present');
    }

    // ── CLAIM E — unknown: unparseable cursor config + inline-style omp extensions ─
    {
        const home = tmp('atlas-wts-e-home-');
        const repo = freshRepo('e-repo');

        const cursorDir = path.join(home, '.cursor');
        fs.mkdirSync(cursorDir, { recursive: true });
        fs.writeFileSync(path.join(cursorDir, 'mcp.json'), '{ this is not valid json,,,');

        fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
        // Flow-style YAML the naive line-scanner deliberately does not attempt
        // to parse — it cannot tell whether atlas-consult.ts is in this list.
        fs.writeFileSync(path.join(home, '.omp', 'agent', 'config.yml'), 'extensions: [~/.omp/agent/hooks/pre/atlas-consult.ts]\n');

        const status = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assertShape(status.tools, 'E');
        assert.equal(status.tools.cursor, 'unknown', 'E: cursor unknown — mcp.json exists but is not valid JSON');
        assert.equal(status.tools.omp, 'unknown', 'E: omp unknown — extensions: uses a flow-style value the scanner cannot resolve');
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        console.log('  ✓ CLAIM E — malformed/ambiguous machine config reports unknown, never a guessed verdict');
    }

    // ── CLAIM F — codex 'wired' needs BOTH halves; malformed TOML → unknown ─
    {
        const home = tmp('atlas-wts-f-home-');
        const repo = freshRepo('f-repo');
        await installWire(repo); // writes AGENTS.md (the repo half)

        // Repo half only — no machine-level ~/.codex/config.toml yet.
        const partial = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assert.equal(partial.tools.codex, 'partial', 'F: codex partial with AGENTS.md but no config.toml entry');

        // Machine half: the exact TOML `atlas connect codex` writes.
        const codexDir = path.join(home, '.codex');
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(path.join(codexDir, 'config.toml'), [
            '[mcp_servers.other-tool]',
            'command = "uvx"',
            '',
            '[mcp_servers.groundfloor-atlas]',
            'command = "npx"',
            'args = ["-y", "mcp-remote", "http://127.0.0.1:3848/mcp", "--header", "Authorization: Bearer ${ATLAS_MCP_TOKEN}"]',
            '',
            '[mcp_servers.groundfloor-atlas.env]',
            'ATLAS_MCP_TOKEN = "t"',
            '',
        ].join('\n'));
        const wired = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assert.equal(wired.tools.codex, 'wired', 'F: codex wired once config.toml entry AND AGENTS.md are both present');

        // Machine half alone (no AGENTS.md) — still partial, and an
        // unparseable config.toml is 'unknown', never a guess.
        const repoB = freshRepo('f-repo-b');
        const noAgents = wireStatus(repoB, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assert.equal(noAgents.tools.codex, 'partial', 'F: codex partial with the TOML entry but no AGENTS.md block');
        fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers.broken\n');
        const malformed = wireStatus(repo, { home }) as { tools: Record<'claudeCode' | 'omp' | 'codex' | 'cursor', ToolWireStatus> };
        assert.equal(malformed.tools.codex, 'unknown', 'F: malformed config.toml reports unknown, never a guessed verdict');

        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(repoB, { recursive: true, force: true });
        console.log('  ✓ CLAIM F — codex wired only with both halves; malformed TOML is unknown');
    }

    // ── CLAIM G — vscode: repo-scoped .vscode/mcp.json drives the verdict ──
    {
        const home = tmp('atlas-wts-g-home-');
        const repo = freshRepo('g-repo');
        // Not even present → not-installed.
        const absent = wireStatus(repo, { home }) as { tools: Record<string, ToolWireStatus> };
        assert.equal(absent.tools.vscode, 'not-installed', 'G: vscode not-installed with no .vscode/mcp.json');

        // The exact file `atlas connect vscode` writes → wired.
        const vscodeDir = path.join(repo, '.vscode');
        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(path.join(vscodeDir, 'mcp.json'), JSON.stringify({
            servers: { 'groundfloor-atlas': { type: 'http', url: 'http://127.0.0.1:3848/mcp', headers: { Authorization: 'Bearer ${input:groundfloor-atlas-token}' } } },
            inputs: [{ type: 'promptString', id: 'groundfloor-atlas-token', description: 'Groundfloor Atlas MCP token', password: true }],
        }));
        const wired = wireStatus(repo, { home }) as { tools: Record<string, ToolWireStatus> };
        assert.equal(wired.tools.vscode, 'wired', 'G: vscode wired with the connect-written servers entry');

        // A file without our entry (any legacy name) is not-installed; an
        // unparseable file is 'unknown', never a guess.
        fs.writeFileSync(path.join(vscodeDir, 'mcp.json'), JSON.stringify({ servers: { 'someone-else': { type: 'http', url: 'http://x/mcp' } } }));
        const onlyOthers = wireStatus(repo, { home }) as { tools: Record<string, ToolWireStatus> };
        assert.equal(onlyOthers.tools.vscode, 'not-installed', 'G: vscode not-installed when only unrelated servers are configured');
        fs.writeFileSync(path.join(vscodeDir, 'mcp.json'), '{ broken');
        const malformed = wireStatus(repo, { home }) as { tools: Record<string, ToolWireStatus> };
        assert.equal(malformed.tools.vscode, 'unknown', 'G: malformed .vscode/mcp.json reports unknown, never a guessed verdict');

        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        console.log('  ✓ CLAIM G — vscode wired/not-installed/unknown from the workspace mcp.json');
    }

    console.log('All wire-tools-status tests passed.');
}

await main();
