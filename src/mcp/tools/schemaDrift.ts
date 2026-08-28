/**
 * mcp/tools/schemaDrift.ts — atlas_schema_drift.
 *
 * Ported from lore-plugin-developer handlers.ts (handleCodeSchemaDrift),
 * adapted to take a repoRoot argument so Atlas can run without an
 * AtlasContext-style cached graph. The analytic itself is purely
 * file-based — no Lore round-trip needed — so this is the simplest of
 * the seven X4 tools. The Lore link is the caller convention: pass
 * `workspace` for symmetry with the other tools; it is unused today and
 * documented so future graph-aware drift work (cross-referencing
 * declared tables against indexed CodeSymbol entries) has a hook.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { runSchemaDrift } from '../../analytics/schemaDrift.js';
import type { LoreContextReader } from '../codeContext.js';
import { scanPathError } from '../../indexRoots.js';

interface SchemaDriftArgs {
    schemaFile: string;
    declaredFiles?: string[];
    repoRoot?: string;
    workspace?: string;
}

const SCHEMA_EXTS = new Set(['.sql', '.ddl', '.dml', '.prisma', '.graphql', '.gql']);

function discoverDeclaredFiles(repoRoot: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (SCHEMA_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
        }
    };
    walk(repoRoot);
    return out;
}

export async function runSchemaDriftTool(
    _reader: LoreContextReader,
    args: SchemaDriftArgs,
): Promise<unknown> {
    const repoRoot = args.repoRoot ?? process.cwd();
    const liveFilePath = path.isAbsolute(args.schemaFile)
        ? args.schemaFile
        : path.join(repoRoot, args.schemaFile);
    // Audit ATL-006 — opt-in scan-path allowlist (no-op unless configured).
    const scanErr = scanPathError(repoRoot) ?? scanPathError(liveFilePath);
    if (scanErr) return { error: scanErr };

    let declared: string[];
    if (args.declaredFiles && args.declaredFiles.length > 0) {
        declared = args.declaredFiles.map((f) => path.isAbsolute(f) ? f : path.join(repoRoot, f));
    } else {
        declared = discoverDeclaredFiles(repoRoot);
    }
    // Audit — gate caller-supplied absolute declaredFiles too; an absolute entry
    // ignores repoRoot, so it must be allowlist-checked like every other read.
    // (discoverDeclaredFiles output is under the already-gated repoRoot.)
    for (const f of declared) {
        const de = scanPathError(f);
        if (de) return { error: de };
    }

    if (declared.length === 0) {
        return {
            error: 'No declared schema files found',
            note: 'Pass declaredFiles[] explicitly or run `atlas index` over a repo containing .sql/.prisma/.graphql files.',
            repoRoot,
        };
    }

    return runSchemaDrift(liveFilePath, declared);
}
