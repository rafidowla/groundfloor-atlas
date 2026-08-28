/**
 * mcp/tools/health.ts — atlas_health implementation.
 *
 * Returns liveness payload. Uptime is measured from `bootTimeMs` set
 * by the server at registration time so the value is stable across
 * concurrent calls and survives the JSON-RPC round-trip.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HealthResult {
    status: 'ok';
    version: string;
    uptime_ms: number;
}

function readVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        // src/mcp/tools/health.ts → repo root is three up.
        // dist/mcp/tools/health.js → same shape, three up.
        const pkgPath = join(here, '..', '..', '..', 'package.json');
        const raw = readFileSync(pkgPath, 'utf-8');
        const parsed = JSON.parse(raw) as { version?: string };
        return parsed.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

const PKG_VERSION = readVersion();

export function runHealth(bootTimeMs: number): HealthResult {
    return {
        status: 'ok',
        version: PKG_VERSION,
        uptime_ms: Date.now() - bootTimeMs,
    };
}
