/**
 * tests/audit-urgent4.test.ts — regression tests for the four urgent leftovers:
 *  #9.  llm_config_set / cloud_sync_config_set wipe the stored API key when
 *       the UI saves with a blank key field ("leave blank to keep" promise).
 *  #10. atlas_call_graph's ambiguity error says "pass a repo qualifier" but
 *       the advertised inputSchema had no repo property (agent retry loop).
 *  #12. wire status reported wired:false after a SUCCESSFUL --memory-only
 *       install (status judged by the full-wire trio only).
 *
 * (#11 is a README/docs fix — no runnable test.)
 *
 * Shape follows tests/audit-high-severity.test.ts.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── #9 — blank-key saves must not wipe the stored credential ────────────────
async function testBlankKeyKeepsExisting(cleanup: string[]): Promise<void> {
    console.log('\n[#9] HIGH — "leave blank to keep" wiped the API key');
    const home = mkTmp('atlas-audit-u9-');
    cleanup.push(home);
    process.env['ATLAS_HOME'] = home; // before the config import's load-time snapshot
    try {
        const { buildRegistry } = await import('../src/mcp/allTools.js');
        const registry = buildRegistry(0);
        const tools = (registry as unknown as {
            tools: Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
        }).tools;

        const readKey = (section: 'llm' | 'cloudSync'): string | undefined => {
            const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, Record<string, unknown>>;
            return raw[section]?.['apiKey'] as string | undefined;
        };

        // LLM: save with a key, then re-save provider+model with a BLANK key.
        const llmSet = tools.get('llm_config_set')!.handler;
        await llmSet({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-real-key' });
        assert.equal(readKey('llm'), 'sk-real-key', 'setup: key persisted');
        const r = await llmSet({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: '' }) as Record<string, unknown>;
        assert.ok(r['ok'] !== false, `re-save accepted: ${JSON.stringify(r)}`);
        assert.equal(readKey('llm'), 'sk-real-key',
            'CLAIM #9a: blank-key LLM save keeps the stored key (previously wiped it)');
        console.log('  ✓ CLAIM #9a: llm_config_set honors "leave blank to keep"');

        // Cloud sync: same contract.
        const cloudSet = tools.get('cloud_sync_config_set')!.handler;
        await cloudSet({ enabled: true, cloudMcpUrl: 'https://api.example.com/mcp', syncDirection: 'push', apiKey: 'cloud-key-1' });
        assert.equal(readKey('cloudSync'), 'cloud-key-1', 'setup: cloud key persisted');
        await cloudSet({ enabled: true, cloudMcpUrl: 'https://api.example.com/mcp', syncDirection: 'bidirectional' });
        assert.equal(readKey('cloudSync'), 'cloud-key-1',
            'CLAIM #9b: key-less Cloud Sync save keeps the stored key');
        console.log('  ✓ CLAIM #9b: cloud_sync_config_set honors "leave blank to keep"');

        // An explicit NEW key still replaces.
        await llmSet({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-new-key' });
        assert.equal(readKey('llm'), 'sk-new-key', 'explicit new key still replaces');
        console.log('  ✓ CLAIM #9c: an explicit new key still replaces the old one');
    } finally {
        delete process.env['ATLAS_HOME'];
    }
}

// ── #10 — call_graph schema advertises the repo qualifier ───────────────────
async function testCallGraphRepoParam(cleanup: string[]): Promise<void> {
    console.log('\n[#10] HIGH — call_graph error says "pass repo" but schema hid it');
    void cleanup;
    const { buildRegistry } = await import('../src/mcp/allTools.js');
    const registry = buildRegistry(0);
    const cg = registry.schema('atlas_call_graph');
    assert.ok(cg, 'atlas_call_graph registered');
    const props = (cg!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok('repo' in props,
        `CLAIM #10: repo is in the advertised schema (an agent following the ambiguity error can actually comply); got ${Object.keys(props).join(',')}`);
    console.log('  ✓ CLAIM #10: atlas_call_graph schema includes the repo qualifier');
}

// ── #12 — wire status is mode-aware ─────────────────────────────────────────
async function testWireStatusModes(cleanup: string[]): Promise<void> {
    console.log('\n[#12] HIGH — wire status said wired:false after a good --memory-only install');
    const { installWire, wireStatus } = await import('../src/cli/wire.js');
    const dir = mkTmp('atlas-audit-u12-');
    cleanup.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir }); // repo-local; never touch shared hooks

    // Before anything: not wired, mode 'none'.
    const before = wireStatus(dir) as Record<string, unknown>;
    assert.equal(before['wired'], false);
    assert.equal(before['mode'], 'none');

    // After a memory-only install: wired via the git-sync component alone.
    const inst = await installWire(dir, 'u12ws', { memoryOnly: true }) as Record<string, unknown>;
    assert.equal(inst['ok'], true, `memory-only install succeeded: ${JSON.stringify(inst['error'] ?? '')}`);
    const after = wireStatus(dir) as Record<string, unknown>;
    assert.equal(after['wired'], true, 'CLAIM #12a: memory-only install reports wired:true');
    assert.equal(after['mode'], 'memory-only', 'CLAIM #12b: mode is reported as memory-only');
    console.log('  ✓ CLAIM #12a/b: wire status is mode-aware after --memory-only');
}

async function main(): Promise<void> {
    console.log('Running urgent-4 regression tests…');
    const cleanup: string[] = [];
    try {
        await testBlankKeyKeepsExisting(cleanup);
        await testCallGraphRepoParam(cleanup);
        await testWireStatusModes(cleanup);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log('\nAll urgent-4 regression tests passed ✓');
}

await main();
