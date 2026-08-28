#!/usr/bin/env tsx
/**
 * scripts/dump-tool-schemas.ts — emit the MCP tool surface to a committed file.
 *
 * WHY THIS EXISTS. An embedding host pinned its build spec to
 * daemon version 0.2.6 and planned to reconcile against the next release by
 * diffing tool schemas. That plan silently broke: `knowledge_retract` and
 * `llm_chat` usage both shipped WITHOUT a version bump, so 0.2.6 named two
 * different tool surfaces and a mechanical comparison would have passed while
 * comparing the wrong one. The version string alone cannot be trusted to
 * describe the surface unless something forces the two to move together.
 *
 * THE ARTIFACT. `docs/tool-schemas.json` is the machine-readable contract:
 * every tool's name, description and input JSON Schema, sorted by name, stamped
 * with the package version. `git diff` between two release tags over that one
 * file IS the schema diff an integrator needs — no timestamps or other churn in
 * it, so an unchanged surface produces an empty diff.
 *
 * THE GUARD. `--check` re-derives the dump from the live registry and fails if
 * it differs from the committed file. tests/tool-schema-dump.test.ts runs it, so
 * adding/renaming/re-typing a tool fails the suite until the dump is
 * regenerated — which puts the regenerated dump (and therefore the reader's
 * attention on the version) in the SAME commit as the surface change.
 *
 * Usage:
 *   npm run schemas:dump          # regenerate docs/tool-schemas.json
 *   npm run schemas:check         # verify the committed dump is current (CI)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '../src/mcp/allTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const DUMP_PATH = path.join(REPO_ROOT, 'docs', 'tool-schemas.json');

export interface ToolSchemaDump {
    /** Package version this surface belongs to — the pin an integrator quotes. */
    atlasVersion: string;
    toolCount: number;
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

/**
 * Derive the dump from the live registry.
 *
 * Tools are sorted by name and NOT stamped with a generation time on purpose:
 * the file must be a pure function of the code, so re-running this on an
 * unchanged tree produces a byte-identical file and a real diff means a real
 * surface change.
 */
export function buildDump(): ToolSchemaDump {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version?: string };
    // bootTimeMs only feeds atlas_health's uptime at CALL time; registration
    // never reads it, so any value yields the same schema surface.
    const registry = buildRegistry(0);
    const tools = registry.list()
        .map(({ name }) => registry.schema(name))
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        atlasVersion: pkg.version ?? '0.0.0',
        toolCount: tools.length,
        tools,
    };
}

/** Canonical serialization — 4-space JSON + trailing newline, matching the
 *  repo's other committed JSON artifacts. */
export function serializeDump(dump: ToolSchemaDump): string {
    return `${JSON.stringify(dump, null, 4)}\n`;
}

/** The committed dump, or null when it does not exist yet. */
export function readCommittedDump(): string | null {
    try { return fs.readFileSync(DUMP_PATH, 'utf-8'); }
    catch { return null; }
}

/**
 * Compare the live surface against the committed file. Returns a human-readable
 * summary of what moved (added / removed / changed tools, or a version bump)
 * rather than a raw text diff, so a failing CI job names the culprit.
 */
export function checkDump(): { ok: true } | { ok: false; reason: string } {
    const expected = serializeDump(buildDump());
    const actual = readCommittedDump();
    if (actual === null) {
        return { ok: false, reason: `${path.relative(REPO_ROOT, DUMP_PATH)} does not exist — run \`npm run schemas:dump\`` };
    }
    if (actual === expected) return { ok: true };

    // Name the specific drift instead of "files differ".
    const problems: string[] = [];
    let prev: ToolSchemaDump | null = null;
    try { prev = JSON.parse(actual) as ToolSchemaDump; } catch { /* corrupt — fall through */ }
    const next = JSON.parse(expected) as ToolSchemaDump;
    if (!prev) {
        problems.push('committed dump is not valid JSON');
    } else {
        if (prev.atlasVersion !== next.atlasVersion) {
            problems.push(`version ${prev.atlasVersion} -> ${next.atlasVersion}`);
        }
        const prevByName = new Map(prev.tools.map((t) => [t.name, t]));
        const nextByName = new Map(next.tools.map((t) => [t.name, t]));
        for (const name of nextByName.keys()) if (!prevByName.has(name)) problems.push(`added tool: ${name}`);
        for (const name of prevByName.keys()) if (!nextByName.has(name)) problems.push(`REMOVED tool: ${name}`);
        for (const [name, nt] of nextByName) {
            const pt = prevByName.get(name);
            if (!pt) continue;
            if (JSON.stringify(pt.inputSchema) !== JSON.stringify(nt.inputSchema)) problems.push(`schema changed: ${name}`);
            else if (pt.description !== nt.description) problems.push(`description changed: ${name}`);
        }
    }
    return {
        ok: false,
        reason: `${path.relative(REPO_ROOT, DUMP_PATH)} is stale — ${problems.join('; ') || 'content differs'}. Run \`npm run schemas:dump\` and bump the package version if the surface changed.`,
    };
}

function main(): void {
    const check = process.argv.includes('--check');
    if (check) {
        const res = checkDump();
        if (!res.ok) {
            console.error(`[schemas] ${res.reason}`);
            process.exit(1);
        }
        console.log('[schemas] docs/tool-schemas.json is current');
        return;
    }
    const dump = buildDump();
    fs.mkdirSync(path.dirname(DUMP_PATH), { recursive: true });
    fs.writeFileSync(DUMP_PATH, serializeDump(dump));
    console.log(`[schemas] wrote ${path.relative(REPO_ROOT, DUMP_PATH)} — ${dump.toolCount} tools, version ${dump.atlasVersion}`);
}

// Run only when invoked directly; the test imports the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
