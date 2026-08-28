/**
 * tests/httptransport.test.ts — SSRF / loopback classification hardening (audit ATL).
 *
 * node:URL preserves alternate IPv4 encodings verbatim and does no range
 * classification, so the old string-match guards were bypassable. These lock in
 * encoding-complete classification: numeric IPv4 (decimal/hex/octal/short),
 * 127/8 + 0/8 loopback, RFC-1918 + 169.254/16 + 100.64/10, and IPv6
 * loopback/ULA/link-local/IPv4-mapped.
 *
 *   CLAIM A — loopback is recognized across every encoding; '*.localhost' is NOT.
 *   CLAIM B — private/metadata ranges are recognized across every encoding.
 *   CLAIM C — genuine external https targets still pass cloudUrlError.
 */
import * as assert from 'node:assert/strict';
import { isLoopbackHost, isMetadataOrPrivateHost, cloudUrlError, loopbackUrlError } from '../src/httpTransport.js';

async function main(): Promise<void> {
    console.log('Running httpTransport SSRF/loopback hardening tests…');

    // ── CLAIM A — loopback across encodings ───────────────────────────────────
    {
        for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '127.0.0.255', '0.0.0.0', '0']) {
            assert.equal(isLoopbackHost(h), true, `expected loopback: ${h}`);
        }
        // The over-broad '*.localhost' shortcut is gone (could be remapped via /etc/hosts).
        assert.equal(isLoopbackHost('evil.localhost'), false, 'evil.localhost must NOT be loopback');
        assert.equal(isLoopbackHost('example.com'), false);
        assert.equal(isLoopbackHost('8.8.8.8'), false);
        console.log('  ✓ CLAIM A: loopback recognized across encodings; *.localhost rejected');
    }

    // ── CLAIM B — private/metadata across encodings ───────────────────────────
    {
        for (const h of ['169.254.169.254', 'metadata.google.internal', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.1',
            '100.64.0.1', '169.254.1.1', '0xa000001', '167772161', '[fd00::1]', '[fe80::1]', '[::ffff:10.0.0.1]', '127.0.0.1']) {
            assert.equal(isMetadataOrPrivateHost(h), true, `expected private/metadata/loopback: ${h}`);
        }
        for (const h of ['8.8.8.8', 'example.com', '1.2.3.4', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
            assert.equal(isMetadataOrPrivateHost(h), false, `expected PUBLIC: ${h}`);
        }
        console.log('  ✓ CLAIM B: private/metadata/CGNAT/IPv6-ULA recognized across encodings; public stays public');
    }

    // ── CLAIM C — cloudUrlError end-to-end ────────────────────────────────────
    {
        // genuine external https → OK
        assert.equal(cloudUrlError('https://api.groundfloor.io/lore/mcp'), null, 'real external https must pass');
        // encoded loopback / private → blocked
        assert.ok(cloudUrlError('https://2130706433/'), 'decimal loopback must be blocked');
        assert.ok(cloudUrlError('https://[fd00::1]/mcp'), 'IPv6 ULA must be blocked');
        assert.ok(cloudUrlError('https://10.0.0.5/x'), 'RFC-1918 must be blocked');
        assert.ok(cloudUrlError('http://example.com/'), 'non-https must be blocked');
        // ollama loopback pin
        assert.equal(loopbackUrlError('http://127.0.0.1:11434'), null);
        assert.ok(loopbackUrlError('http://evil.localhost:11434'), 'ollama pin must reject *.localhost');
        console.log('  ✓ CLAIM C: cloudUrlError blocks encoded loopback/private; passes real external https');
    }

    console.log('All httpTransport SSRF/loopback hardening tests passed.');
}

await main();
