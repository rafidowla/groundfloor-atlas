/**
 * tests/pii-redaction.test.ts — regression for the PII redaction layer
 * (RD-pii-redact) in sanitizeContext.
 *
 * CLAIM A — personal information (emails, phone numbers, SSNs, payment
 *           cards) is redacted from ANY context before it reaches an LLM,
 *           in addition to the existing secret/credential patterns.
 * CLAIM B — common code/infra literals that merely LOOK numeric (dates,
 *           semver, ip:port, epoch timestamps, identifiers) are NOT
 *           redacted — over-eager patterns would gut answer quality.
 * CLAIM C — cloudContextAllowed() reads the persisted Settings toggle
 *           (config.json llm.allowCloudContext) and the env var overrides
 *           it in BOTH directions.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeContext, cloudContextAllowed } from '../src/mcp/tools/llmChat.js';

function redacted(input: string): boolean {
    return sanitizeContext(input).text.includes('[REDACTED]');
}

console.log('Running PII-redaction regression tests…');

// ── CLAIM A — PII forms are redacted ──────────────────────────────────────────
{
    const mustRedact: Array<[string, string]> = [
        ['email',           'contact jane.doe+dev@example.co for access'],
        ['ssn',             'ssn is 123-45-6789 ok'],
        ['card 4-4-4-4',    'card 4111 1111 1111 1111 exp 12/27'],
        ['card contiguous', 'pan=4111111111111111'],
        ['amex 4-6-5',      'amex 3782 822463 10005'],
        ['phone parens',    'call (555) 123-4567 today'],
        ['phone dashes',    'cell 555-123-4567'],
        // pre-existing secret patterns still hold:
        ['openai key',      'key sk-' + 'abcdefghijklmnopqrstuvwx123'],
        ['password kv',     'password: hunter2secret'],
    ];
    for (const [label, input] of mustRedact) {
        assert.ok(redacted(input), `expected redaction for ${label}: ${input}`);
    }
}

// ── CLAIM B — numeric-looking code/infra literals survive ────────────────────
{
    const mustSurvive: Array<[string, string]> = [
        ['iso date',   'released 2026-07-14 at noon'],
        ['semver',     'bump to v3.11.0 and 1.2.3'],
        ['ip:port',    'listening on 127.0.0.1:3848'],
        ['epoch ms',   'ts=1783477115474'],
        ['code line',  'const nodeCount = stats.nodeCount;'],
    ];
    for (const [label, input] of mustSurvive) {
        const out = sanitizeContext(input).text;
        assert.equal(out, input, `false positive on ${label}: got ${JSON.stringify(out)}`);
    }
}

// ── CLAIM C — consent: persisted toggle + env override both ways ─────────────
{
    // Isolated home so the REAL machine config is never read or touched.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-consent-'));
    const priorHome = process.env['ATLAS_HOME'];
    const priorEnv = process.env['ATLAS_LLM_ALLOW_CLOUD'];
    try {
        process.env['ATLAS_HOME'] = home;
        delete process.env['ATLAS_LLM_ALLOW_CLOUD'];

        // No config at all → fail closed.
        assert.equal(cloudContextAllowed(), false, 'no config → withheld');

        // Persisted toggle ON → allowed.
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
            llm: { provider: 'openai', model: 'gpt-4o-mini', allowCloudContext: true },
        }));
        assert.equal(cloudContextAllowed(), true, 'persisted toggle → allowed');

        // Env var forces OFF even when the toggle says on.
        process.env['ATLAS_LLM_ALLOW_CLOUD'] = '0';
        assert.equal(cloudContextAllowed(), false, 'env off-override wins');

        // Env var forces ON even when the toggle says off.
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
            llm: { provider: 'openai', model: 'gpt-4o-mini', allowCloudContext: false },
        }));
        process.env['ATLAS_LLM_ALLOW_CLOUD'] = '1';
        assert.equal(cloudContextAllowed(), true, 'env on-override wins');
    } finally {
        if (priorHome === undefined) delete process.env['ATLAS_HOME']; else process.env['ATLAS_HOME'] = priorHome;
        if (priorEnv === undefined) delete process.env['ATLAS_LLM_ALLOW_CLOUD']; else process.env['ATLAS_LLM_ALLOW_CLOUD'] = priorEnv;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

console.log('✓ PII-redaction + cloud-consent tests passed');
