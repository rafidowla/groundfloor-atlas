/**
 * analytics/schemaDrift.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Schema drift detection — file-based, no live DB connection needed.
 *
 * Original work authored for groundfloor-lore.
 *
 * Phase: 9b (schema drift).
 *
 * Usage:
 *   1. Produce a schema dump from your database:
 *        pg_dump --schema-only mydb > .lore/db-schema.sql
 *        mysqldump --no-data mydb > .lore/db-schema.sql
 *        prisma db pull          (writes prisma/schema.prisma)
 *   2. Call code_schema_drift({ schemaFile: ".lore/db-schema.sql" })
 *
 * The tool compares the live dump against declared schema files in the
 * repo (.sql migrations, schema.prisma, .graphql SDL) and reports:
 *   - Tables / models present in the live DB but not in any source file
 *     (added directly to the DB, never through a migration)
 *   - Tables / models present in source files but missing from the live DB
 *     (migration written but not yet applied)
 *   - Column-level drift for matching tables (columns added/dropped
 *     directly, or in a migration that wasn't applied)
 *
 * Parsing is purely regex-based — no tree-sitter required — because
 * the input is predictable DDL output from pg_dump / mysqldump / prisma.
 *
 * Limitations (v1):
 *   - ALTER TABLE ADD COLUMN in migration files is NOT parsed; only
 *     CREATE TABLE / CREATE VIEW / model / type statements are scanned.
 *     This means "declared" columns come from schema files only, not
 *     from incremental migration files. Use a schema dump from both
 *     sides for the most accurate comparison.
 *   - Column type drift (VARCHAR(255) vs TEXT) is not reported; only
 *     presence/absence of column names.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── public types ─────────────────────────────────────────────────────────────

/** One table / view / model as parsed from either a dump or a source file. */
export interface TableSchema {
    /** Lowercase name used for case-insensitive comparison. */
    name: string;
    /** Original-case name as written in the file. */
    displayName: string;
    kind: 'table' | 'view';
    /** Lowercase column / field names. Empty for views (DDL may omit them). */
    columns: string[];
    /** Absolute path to the source file this came from. */
    sourceFile: string;
}

/** Column-level drift for one table that exists on both sides. */
export interface ColumnDiff {
    table: string;
    /** In the live DB but not in any source file — added directly. */
    onlyInLive: string[];
    /** In source files but not in the live DB — migration not applied. */
    onlyInDeclared: string[];
}

export interface DriftReport {
    liveFile: string;
    liveTableCount: number;
    declaredFileCount: number;
    /** Tables in the live DB not found in any repo schema file. */
    onlyInLive: Array<{ name: string; kind: string }>;
    /** Tables in repo schema files not found in the live DB dump. */
    onlyInDeclared: Array<{ name: string; kind: string; file: string }>;
    /** Tables present on both sides with mismatched column sets. */
    columnDiffs: ColumnDiff[];
    /** True when there are zero differences at any level. */
    clean: boolean;
    summary: string;
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

/**
 * SQL constraint keywords — a CREATE TABLE body line that starts with
 * one of these is a table-level constraint, not a column definition.
 */
const SQL_CONSTRAINT_START = new Set([
    'constraint', 'primary', 'foreign', 'unique', 'index', 'key',
    'check', 'exclude', 'partition',
]);

/**
 * Split `text` by top-level commas (ignoring commas inside parentheses).
 * Handles DEFAULT expressions like `DEFAULT gen_random_uuid()`.
 */
function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

/**
 * Extract column names from a CREATE TABLE body — the text that sits
 * between the outermost `( )`. Skips table-level constraints and
 * PostgreSQL partition syntax.
 */
function extractSqlColumns(body: string): string[] {
    const columns: string[] = [];
    for (const part of splitTopLevelCommas(body)) {
        const trimmed = part.trim().replace(/\s+/g, ' ');
        if (!trimmed) continue;
        // Strip leading quote if present (PostgreSQL quoted identifiers).
        const firstWord = trimmed.replace(/^"/, '').split(/[\s"]/)[0]?.toLowerCase() ?? '';
        if (!firstWord || SQL_CONSTRAINT_START.has(firstWord)) continue;
        if (!/^[a-z_]/i.test(firstWord)) continue;
        columns.push(firstWord);
    }
    return columns;
}

/**
 * Find the body of a `CREATE TABLE ... ( ... )` statement: returns the
 * text between the matching outer parentheses starting at or after
 * `fromIndex`. Returns null if no opening paren found.
 */
function extractParenBody(sql: string, fromIndex: number): string | null {
    const start = sql.indexOf('(', fromIndex);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
            depth--;
            if (depth === 0) return sql.slice(start + 1, i);
        }
    }
    return null; // unmatched paren (truncated file)
}

/**
 * Parse `CREATE TABLE` and `CREATE VIEW` statements from SQL DDL text
 * (e.g. the output of `pg_dump --schema-only`).
 *
 * Handles:
 *   - `CREATE TABLE name (`
 *   - `CREATE TABLE IF NOT EXISTS name (`
 *   - `CREATE TABLE schema.name (`
 *   - `CREATE [OR REPLACE] [TEMP] VIEW name AS`
 *   - Double-quoted identifiers: `CREATE TABLE "public"."users" (`
 */
export function parseSqlDdl(ddlText: string, sourceFile: string): TableSchema[] {
    const tables: TableSchema[] = [];

    // ── tables ──
    const TABLE_RE =
        /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)/gi;
    let m: RegExpExecArray | null;
    TABLE_RE.lastIndex = 0;
    while ((m = TABLE_RE.exec(ddlText)) !== null) {
        const rawName = m[1].replace(/"/g, '');
        const parts = rawName.split('.');
        const displayName = parts[parts.length - 1] ?? rawName;
        const name = displayName.toLowerCase();
        const body = extractParenBody(ddlText, m.index + m[0].length);
        const columns = body ? extractSqlColumns(body) : [];
        tables.push({ name, displayName, kind: 'table', columns, sourceFile });
    }

    // ── views ──
    const VIEW_RE =
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)/gi;
    VIEW_RE.lastIndex = 0;
    while ((m = VIEW_RE.exec(ddlText)) !== null) {
        const rawName = m[1].replace(/"/g, '');
        const parts = rawName.split('.');
        const displayName = parts[parts.length - 1] ?? rawName;
        const name = displayName.toLowerCase();
        // Views have a column list only in `CREATE VIEW name (col1, col2) AS …`
        // — rare in pg_dump output; default to empty for v1.
        tables.push({ name, displayName, kind: 'view', columns: [], sourceFile });
    }

    return tables;
}

// ─── Prisma helpers ──────────────────────────────────────────────────────────

/**
 * Parse `model`, `view`, and `enum` blocks from a Prisma schema file.
 * Returns only `model` and `view` blocks (with field names) — enums are
 * schema-level types, not tables.
 */
export function parsePrismaSchema(prismaText: string, sourceFile: string): TableSchema[] {
    const tables: TableSchema[] = [];
    const BLOCK_RE = /^(model|view)\s+(\w+)\s*\{/gm;
    let m: RegExpExecArray | null;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(prismaText)) !== null) {
        const displayName = m[2];
        const name = displayName.toLowerCase();
        // Scan for the closing brace of this block.
        let depth = 0;
        let blockEnd = m.index + m[0].length - 1; // points at the `{`
        let found = false;
        for (let i = blockEnd; i < prismaText.length; i++) {
            if (prismaText[i] === '{') depth++;
            else if (prismaText[i] === '}') {
                depth--;
                if (depth === 0) { blockEnd = i; found = true; break; }
            }
        }
        if (!found) continue;
        const blockBody = prismaText.slice(m.index + m[0].length, blockEnd);
        const columns = extractPrismaFields(blockBody);
        tables.push({ name, displayName, kind: 'table', columns, sourceFile });
    }
    return tables;
}

/**
 * Extract field names from a Prisma model / view body (between `{ }`).
 * Skips block-level directives (`@@`), comments (`//`), and empty lines.
 */
function extractPrismaFields(blockBody: string): string[] {
    const fields: string[] = [];
    for (const line of blockBody.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
        const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s/i);
        if (match) fields.push(match[1].toLowerCase());
    }
    return fields;
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

/**
 * Parse `type` and `interface` declarations from a GraphQL SDL file.
 * Only object types / interfaces map to DB entities; scalars, enums,
 * unions, and input types are skipped.
 */
export function parseGraphQlSchema(gqlText: string, sourceFile: string): TableSchema[] {
    const tables: TableSchema[] = [];
    // Match: type Foo { or interface Bar {  (no extend, no scalar/enum/union/input)
    const TYPE_RE = /^(?:type|interface)\s+(\w+)\s*(?:implements\s+[^\{]+)?\{/gm;
    let m: RegExpExecArray | null;
    TYPE_RE.lastIndex = 0;
    while ((m = TYPE_RE.exec(gqlText)) !== null) {
        const displayName = m[1];
        // Skip built-in introspection types and Query/Mutation/Subscription
        // (they're operation roots, not data tables).
        if (/^(Query|Mutation|Subscription|__\w+)$/.test(displayName)) continue;
        const name = displayName.toLowerCase();
        let depth = 0;
        let blockEnd = m.index + m[0].length - 1;
        let found = false;
        for (let i = blockEnd; i < gqlText.length; i++) {
            if (gqlText[i] === '{') depth++;
            else if (gqlText[i] === '}') {
                depth--;
                if (depth === 0) { blockEnd = i; found = true; break; }
            }
        }
        if (!found) continue;
        const blockBody = gqlText.slice(m.index + m[0].length, blockEnd);
        const columns = extractGraphQlFields(blockBody);
        tables.push({ name, displayName, kind: 'table', columns, sourceFile });
    }
    return tables;
}

/**
 * Extract field names from a GraphQL type / interface body.
 * Skips directives and comments.
 */
function extractGraphQlFields(blockBody: string): string[] {
    const fields: string[] = [];
    for (const line of blockBody.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Field pattern: fieldName(args?): Type
        const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s*:/i);
        if (match) fields.push(match[1].toLowerCase());
    }
    return fields;
}

// ─── file loader ──────────────────────────────────────────────────────────────

/**
 * Load and parse a schema file. Routes to the appropriate parser by
 * file extension. Returns an empty array for unknown extensions.
 */
export function loadSchemaFile(absolutePath: string): TableSchema[] {
    let text: string;
    try {
        text = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
        return [];
    }
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    switch (ext) {
        case 'sql':
        case 'ddl':
        case 'dml':
            return parseSqlDdl(text, absolutePath);
        case 'prisma':
            return parsePrismaSchema(text, absolutePath);
        case 'graphql':
        case 'gql':
            return parseGraphQlSchema(text, absolutePath);
        default:
            return [];
    }
}

// ─── diff ─────────────────────────────────────────────────────────────────────

/**
 * Merge multiple `TableSchema[]` arrays into a single Map keyed by
 * lowercase name. When the same table name appears in multiple files
 * (e.g. CREATE TABLE in one migration + ALTER TABLE in another), the
 * column sets are unioned.
 */
function mergeSchemas(schemas: TableSchema[][]): Map<string, TableSchema> {
    const merged = new Map<string, TableSchema>();
    for (const list of schemas) {
        for (const t of list) {
            const existing = merged.get(t.name);
            if (!existing) {
                merged.set(t.name, { ...t, columns: [...t.columns] });
            } else {
                // Union columns — a later migration may add columns.
                const colSet = new Set(existing.columns);
                for (const col of t.columns) colSet.add(col);
                existing.columns = Array.from(colSet);
            }
        }
    }
    return merged;
}

/**
 * Diff a live schema against a declared schema.
 * Both sides are represented as Maps from lowercase name → TableSchema.
 */
export function diffSchemas(
    live: Map<string, TableSchema>,
    declared: Map<string, TableSchema>,
    liveFile: string,
    declaredFileCount: number,
): DriftReport {
    const onlyInLive: DriftReport['onlyInLive'] = [];
    const onlyInDeclared: DriftReport['onlyInDeclared'] = [];
    const columnDiffs: ColumnDiff[] = [];

    // Tables in live but not declared.
    for (const [name, t] of live) {
        if (!declared.has(name)) {
            onlyInLive.push({ name: t.displayName, kind: t.kind });
        }
    }

    // Tables in declared but not live; or in both → column diff.
    for (const [name, decl] of declared) {
        const liveT = live.get(name);
        if (!liveT) {
            onlyInDeclared.push({ name: decl.displayName, kind: decl.kind, file: decl.sourceFile });
            continue;
        }
        // Both sides have this table — diff columns if either side has them.
        if (decl.columns.length === 0 && liveT.columns.length === 0) continue;
        if (decl.columns.length === 0 || liveT.columns.length === 0) continue; // can't compare
        const liveColSet = new Set(liveT.columns);
        const declColSet = new Set(decl.columns);
        const onlyLive = liveT.columns.filter((c) => !declColSet.has(c));
        const onlyDecl = decl.columns.filter((c) => !liveColSet.has(c));
        if (onlyLive.length > 0 || onlyDecl.length > 0) {
            columnDiffs.push({ table: decl.displayName, onlyInLive: onlyLive, onlyInDeclared: onlyDecl });
        }
    }

    const clean = onlyInLive.length === 0 && onlyInDeclared.length === 0 && columnDiffs.length === 0;
    const lines: string[] = [];
    if (clean) {
        lines.push(`✓ No drift. Live DB matches declared schema (${live.size} tables / views).`);
    } else {
        if (onlyInLive.length > 0) lines.push(`${onlyInLive.length} table(s) in live DB but not in source (added directly to DB).`);
        if (onlyInDeclared.length > 0) lines.push(`${onlyInDeclared.length} table(s) in source but not in live DB (migration not applied).`);
        if (columnDiffs.length > 0) lines.push(`${columnDiffs.length} table(s) with column-level drift.`);
    }

    return {
        liveFile,
        liveTableCount: live.size,
        declaredFileCount,
        onlyInLive,
        onlyInDeclared,
        columnDiffs,
        clean,
        summary: lines.join(' '),
    };
}

// ─── main entry point ─────────────────────────────────────────────────────────

/**
 * Run a full schema drift check.
 *
 * @param liveFilePath  Absolute path to the schema dump file (SQL / Prisma).
 * @param declaredPaths Absolute paths to all declared schema files in the repo.
 * @returns DriftReport
 */
export function runSchemaDrift(
    liveFilePath: string,
    declaredPaths: string[],
): DriftReport {
    // Parse live (dump) file.
    const liveSchemas = loadSchemaFile(liveFilePath);
    const liveMap = mergeSchemas([liveSchemas]);

    // Parse declared (repo) files.
    const declaredByFile = declaredPaths
        .filter((p) => p !== liveFilePath) // don't compare against itself
        .map((p) => loadSchemaFile(p))
        .filter((list) => list.length > 0);
    const declaredMap = mergeSchemas(declaredByFile);

    return diffSchemas(liveMap, declaredMap, liveFilePath, declaredByFile.length);
}
