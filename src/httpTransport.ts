/**
 * httpTransport.ts — the single secure outbound HTTP path for Groundfloor Atlas.
 *
 * Centralizes the transport-safety fixes (review #2 / #3 / #6) so no
 * caller hand-rolls `node:http` with `port || 80` again:
 *
 *   - #2  Protocol is selected from the URL (`https:` → TLS, default 443;
 *         otherwise http, default 80). Never hard-codes cleartext + 80.
 *   - #3  Refuses to send a bearer token in cleartext to a NON-loopback
 *         host — so a misconfigured `https` cloud URL routed over `http`
 *         can never leak the token.
 *   - #6  Every request has a timeout against the small keep-alive pool,
 *         so a stalled peer can't hang the caller (and exhaust sockets)
 *         forever.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export interface TransportResult {
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
}

export interface RequestOpts {
    /** Bearer token; only sent when the destination is TLS or loopback. */
    token?: string;
    /** Already-serialized request body (e.g. JSON.stringify(payload)). */
    body?: string;
    /** Per-request timeout. Default 30s. */
    timeoutMs?: number;
    /** Content-Type for a body. Default application/json. */
    contentType?: string;
    /** Extra headers (e.g. Accept) merged last. */
    headers?: Record<string, string>;
}

export class PlaintextTokenError extends Error {
    constructor(host: string) {
        super(`refusing to send a bearer token over plaintext http to non-loopback host '${host}' — use https`);
        this.name = 'PlaintextTokenError';
    }
}

const DEFAULT_TIMEOUT_MS = 30_000;

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, maxFreeSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, maxFreeSockets: 4 });

// ── SSRF / loopback classification (audit ATL: encoding-complete) ────────────
//
// node:URL preserves alternate host encodings VERBATIM in `u.hostname` and does
// no range classification, so a raw string-match guard is trivially bypassed:
//   decimal 2130706433, hex 0x7f000001, octal 0177.0.0.1, short 127.1 (all
//   =127.0.0.1), 0.0.0.0, 100.64/10 CGNAT, and IPv6 ULA/link-local (fd00::1,
//   fe80::1). We canonicalize numeric IPv4 forms and classify by RANGE, and
//   cover IPv6 loopback/ULA/link-local + IPv4-mapped. (Hostnames that RESOLVE to
//   a private IP — DNS rebinding — are still not covered here; that needs
//   resolve-at-connect-time and is out of scope for this literal-input guard.)

/** inet_aton-style parse of the many legal IPv4 textual forms → dotted-decimal, or null. */
function parseIpv4ish(s: string): string | null {
    const parts = s.split('.');
    if (parts.length < 1 || parts.length > 4) return null;
    const nums: number[] = [];
    for (const p of parts) {
        let n: number;
        if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p, 16);
        else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
        else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
        else return null;
        if (!Number.isFinite(n) || n < 0) return null;
        nums.push(n);
    }
    // inet_aton: the final part absorbs the remaining low-order bytes.
    const k = nums.length;
    let value: number;
    if (k === 1) {
        value = nums[0]!;
    } else {
        let hi = 0;
        for (let i = 0; i < k - 1; i++) { if (nums[i]! > 255) return null; hi = hi * 256 + nums[i]!; }
        const maxLast = Math.pow(2, 8 * (4 - (k - 1)));
        if (nums[k - 1]! >= maxLast) return null;
        value = hi * maxLast + nums[k - 1]!;
    }
    if (value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

type HostClass = 'loopback' | 'private' | 'metadata' | null;

function classifyV4(v4: string): HostClass {
    const o = v4.split('.').map(Number);
    const a = o[0]!, b = o[1]!;
    if (v4 === '169.254.169.254') return 'metadata';
    if (a === 127 || a === 0) return 'loopback';            // 127/8, 0/8 ("this host")
    if (a === 169 && b === 254) return 'private';           // 169.254/16 link-local
    if (a === 10) return 'private';                         // 10/8
    if (a === 192 && b === 168) return 'private';           // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return 'private';  // 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64/10 CGNAT
    return null;
}

function classifyV6(v6: string): HostClass {
    if (v6 === '::1' || v6 === '::') return 'loopback';
    const m = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (m) return classifyV4(m[1]!);                        // IPv4-mapped
    if (/^f[cd]/.test(v6)) return 'private';                // fc00::/7 ULA
    if (/^fe[89ab]/.test(v6)) return 'private';             // fe80::/10 link-local
    return null;
}

/** Canonicalize a URL hostname: strip IPv6 brackets, lowercase, normalize
 *  numeric IPv4 encodings. Returns the family-tagged form for classification. */
function canonicalHost(hostname: string): { v4?: string; v6?: string; name: string } {
    const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (name.includes(':')) return { v6: name, name };
    const v4 = parseIpv4ish(name);
    return v4 ? { v4, name } : { name };
}

export function isLoopbackHost(hostname: string): boolean {
    const c = canonicalHost(hostname);
    if (c.name === 'localhost') return true; // RFC 6761; only the exact name, not *.localhost
    if (c.v4) return classifyV4(c.v4) === 'loopback';
    if (c.v6) return classifyV6(c.v6) === 'loopback';
    return false;
}

/** Cloud metadata endpoints + RFC-1918/link-local/CGNAT/loopback (any IPv4 or
 *  IPv6 encoding) — never valid cloud-sync targets (SSRF guard, review #4). */
export function isMetadataOrPrivateHost(hostname: string): boolean {
    const c = canonicalHost(hostname);
    if (c.name === 'metadata.google.internal') return true;
    if (c.v4) return classifyV4(c.v4) !== null;
    if (c.v6) return classifyV6(c.v6) !== null;
    return false;
}

/** Returns an error string if `urlStr` is not a safe cloud-sync target
 *  (must be https, not loopback, not metadata/private). null = OK. */
export function cloudUrlError(urlStr: string): string | null {
    let u: URL;
    try { u = new URL(urlStr); } catch { return `invalid cloud URL: ${urlStr}`; }
    if (u.protocol !== 'https:') return 'cloud URL must use https';
    if (isLoopbackHost(u.hostname)) return 'cloud URL must not be loopback';
    if (isMetadataOrPrivateHost(u.hostname)) return 'cloud URL must not target a metadata or private-network address';
    return null;
}

/** Returns an error string if `urlStr` is not a loopback URL. null = OK.
 *  Used to pin ollamaUrl to the local machine (review #4). */
export function loopbackUrlError(urlStr: string): string | null {
    let u: URL;
    try { u = new URL(urlStr); } catch { return `invalid URL: ${urlStr}`; }
    if (!isLoopbackHost(u.hostname)) return 'ollamaUrl must be a loopback address (127.0.0.1 / localhost)';
    return null;
}

export function secureRequest(method: string, urlStr: string, opts: RequestOpts = {}): Promise<TransportResult> {
    let u: URL;
    try {
        u = new URL(urlStr);
    } catch {
        return Promise.reject(new Error(`invalid URL: ${urlStr}`));
    }
    const isTls = u.protocol === 'https:';
    if (opts.token && !isTls && !isLoopbackHost(u.hostname)) {
        return Promise.reject(new PlaintextTokenError(u.hostname));
    }
    const transport = isTls ? https : http;
    const agent = isTls ? httpsAgent : httpAgent;
    const port = u.port || (isTls ? '443' : '80');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const headers: http.OutgoingHttpHeaders = { ...(opts.headers ?? {}) };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) {
        headers['Content-Type'] = opts.contentType ?? 'application/json';
        headers['Content-Length'] = Buffer.byteLength(opts.body).toString();
    }

    return new Promise((resolve, reject) => {
        const req = transport.request(
            { agent, hostname: u.hostname, port, path: u.pathname + u.search, method, headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c as Buffer));
                res.on('end', () => resolve({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                    headers: res.headers,
                }));
                res.on('error', reject);
            },
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${method} ${u.hostname}${u.pathname}`));
        });
        req.on('error', reject);
        if (opts.body !== undefined) req.write(opts.body);
        req.end();
    });
}
