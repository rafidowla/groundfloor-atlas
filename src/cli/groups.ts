/**
 * cli/groups.ts — G-1 named group registry (declare-once, load-by-name).
 *
 * G-2 shipped `loadGroup(client, ws, files[])` + `atlas group load <f1> <f2>…`
 * (raw memory.jsonl paths) so cross-seam edges resolve when several repos are
 * co-loaded into one store. G-1 layers ERGONOMICS + PROVENANCE on top:
 *
 *   1. DECLARE a named group of repos ONCE (`atlas group create <name> <p1>…`).
 *   2. LOAD it by name (`atlas group load <name>`) — no re-typing paths.
 *   3. Each loaded node is tagged with its SOURCE repo (project=<memberName> +
 *      metadata.sourceRepo) so a recall hit shows WHERE it came from.
 *
 * This module owns layer (1): a tiny JSON registry under ATLAS_HOME, mirroring
 * the indexed-repo registry (`codeIndexer.ts` → `<LORE_HOME>/atlas-registry.json`).
 * We keep ONE file PER GROUP at `<home>/groups/<name>.json` (vs one combined
 * file) so a group is a self-contained, reviewable declaration and two groups
 * can never contend on one file.
 *
 * Degrade, don't fail: `resolveGroup` marks a member whose checkout path or
 * memory.jsonl is missing as `skipped` rather than throwing — a teammate whose
 * working-copy layout differs still loads every member that IS present (open
 * risk #7 in docs/GROUPS-DESIGN.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoSlug } from './repoId.js';
import { MEMBER_CODEGRAPH_RELPATH, readPackageName } from './codeGraphSync.js';

/** Default per-member memory export path, relative to the member checkout. */
export const MEMBER_MEMORY_RELPATH = path.join('.atlas', 'memory.jsonl');

/** G-3 — re-export so the CLI seam (group load) has a single import source for
 *  the member code-graph artifact path alongside MEMBER_MEMORY_RELPATH. */
export { MEMBER_CODEGRAPH_RELPATH };

/** A member as DECLARED in the registry (paths captured at create time). */
export interface GroupMember {
    /** Stable member name — derived from the checkout basename at create. */
    name: string;
    /** Absolute path to the member's checkout root (captured at create). */
    path: string;
    /** Git remote (origin) if the dir was a git repo at create — best-effort. */
    remote?: string;
}

/** The on-disk shape of `<home>/groups/<name>.json`. */
export interface GroupRecord {
    /** Registry schema version (forward-compat). */
    version: 1;
    /** Group name = the shared workspace/dataDir the members co-load into. */
    name: string;
    /** ISO timestamp the group was declared. */
    createdAt: string;
    members: GroupMember[];
}

/** A member RESOLVED for loading: its memory.jsonl path + presence verdict. */
export interface ResolvedMember {
    /** The declared member name (becomes project=<name> provenance on load). */
    name: string;
    /** Absolute checkout root from the registry. */
    path: string;
    /** Absolute path to the member's memory.jsonl (<path>/.atlas/memory.jsonl). */
    memoryPath: string;
    /**
     * True when the member should be SKIPPED at load time: its checkout path
     * or its memory.jsonl is missing. Degrade-don't-fail — the group still
     * loads every present member.
     */
    skipped: boolean;
    /** Human-readable reason when `skipped` is true (else undefined). */
    skipReason?: string;
    /**
     * G-3 (OPT-IN) — absolute path to this member's
     * `<path>/.atlas/code-graph.jsonl`, present ONLY when the file exists on
     * disk (the member ran `atlas code-graph export`). undefined → the member
     * is loaded knowledge-only and contributes no cross-repo code traversal.
     * NEVER affects `skipped`: a missing code graph is the common, expected
     * case, not a load failure.
     */
    codeGraphPath?: string;
    /**
     * G-3 — this member's repoSlug (git-aware id), the prefix its code-node ids
     * are qualified with. Used to name the bridge target `code-folder:<slug>/.`.
     * Best-effort (falls back to the checkout basename for non-git dirs).
     */
    repoSlug?: string;
    /**
     * G-3 — this member's package.json `name` (the bridge MATCH key). undefined
     * when there's no package.json / no name — that member just can't be a
     * bridge target, the rest of the group is unaffected.
     */
    packageName?: string;
}

/** Directory holding one JSON file per declared group. */
export function groupsDir(home: string): string {
    return path.join(home, 'groups');
}

/** Path to a single group's declaration file. */
export function groupPath(home: string, name: string): string {
    return path.join(groupsDir(home), `${sanitizeGroupName(name)}.json`);
}

/**
 * Restrict a group name to a safe single path segment so `groupPath` can never
 * escape `<home>/groups/`. Allows letters/digits/dash/underscore/dot; rejects
 * empties, separators, and traversal. Throws (loud) on a bad name rather than
 * silently rewriting it.
 */
export function sanitizeGroupName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('group name must not be empty');
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        throw new Error(
            `invalid group name '${name}': use letters, digits, '.', '-', '_' only ` +
            `(no path separators or traversal)`,
        );
    }
    return trimmed;
}

/**
 * Does a group with this name already exist? Tolerant of arbitrary input — a
 * name that isn't a valid single segment (e.g. a raw file path passed to
 * `group load`) simply CAN'T be a group, so we return false instead of
 * throwing. This is what lets `cmdGroupLoad` probe "is arg a group name?"
 * safely before falling back to treating args as file paths.
 */
export function groupExists(home: string, name: string): boolean {
    let p: string;
    try {
        p = groupPath(home, name);
    } catch {
        return false;
    }
    return fs.existsSync(p);
}

/**
 * Best-effort git origin remote for a checkout. Returns undefined when the dir
 * isn't a git repo, has no origin, or git isn't on PATH — provenance metadata,
 * never load-critical.
 */
function resolveGitRemote(dir: string): string | undefined {
    try {
        const res = spawnSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf-8',
            timeout: 5000,
        });
        if (res.status !== 0) return undefined;
        const url = (res.stdout ?? '').trim();
        return url.length > 0 ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Declare a named group of member checkouts and persist it to
 * `<home>/groups/<name>.json`.
 *
 * Each path is validated to exist (a typo'd checkout is a create-time error,
 * not a silent skip-at-load). The member NAME is the basename of the checkout;
 * the git origin remote is captured when resolvable (stable identity for a
 * teammate who re-points the local path). Refuses to overwrite an existing
 * group — delete the file or pick another name.
 */
export function createGroup(home: string, name: string, memberPaths: string[]): GroupRecord {
    const safeName = sanitizeGroupName(name);
    if (memberPaths.length === 0) {
        throw new Error(`group create: '${name}' needs at least one member path`);
    }
    if (groupExists(home, safeName)) {
        throw new Error(
            `group '${safeName}' already exists at ${groupPath(home, safeName)} — ` +
            `delete it first or choose another name`,
        );
    }

    const members: GroupMember[] = [];
    const seenNames = new Set<string>();
    for (const raw of memberPaths) {
        const abs = path.resolve(raw);
        if (!fs.existsSync(abs)) {
            throw new Error(`group create: member path not found: ${abs}`);
        }
        if (!fs.statSync(abs).isDirectory()) {
            throw new Error(`group create: member path is not a directory: ${abs}`);
        }
        let memberName = path.basename(abs);
        // Disambiguate two checkouts that share a basename so each member keeps
        // a distinct project=<name> provenance stamp (open risk #3).
        if (seenNames.has(memberName)) {
            let n = 2;
            while (seenNames.has(`${memberName}-${n}`)) n += 1;
            memberName = `${memberName}-${n}`;
        }
        seenNames.add(memberName);
        const member: GroupMember = { name: memberName, path: abs };
        const remote = resolveGitRemote(abs);
        if (remote) member.remote = remote;
        members.push(member);
    }

    const record: GroupRecord = {
        version: 1,
        name: safeName,
        createdAt: new Date().toISOString(),
        members,
    };

    const out = groupPath(home, safeName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return record;
}

/** Read one declared group, or null when no such group file exists / parses /
 *  the name isn't a valid single segment. Tolerant on read. */
export function getGroup(home: string, name: string): GroupRecord | null {
    let p: string;
    try {
        p = groupPath(home, name);
    } catch {
        return null;
    }
    if (!fs.existsSync(p)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as GroupRecord;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.members)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** List every declared group (sorted by name). Empty when none exist. */
export function listGroups(home: string): GroupRecord[] {
    const dir = groupsDir(home);
    if (!fs.existsSync(dir)) return [];
    const out: GroupRecord[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.json')) continue;
        const rec = getGroup(home, entry.slice(0, -'.json'.length));
        if (rec) out.push(rec);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Resolve a declared group's members to their memory.jsonl paths for loading.
 *
 * Throws ONLY when the group itself is undeclared (caller decides the
 * name-vs-paths fallback). A member whose checkout path or memory.jsonl is
 * MISSING is returned with `skipped: true` + a reason — NEVER thrown — so the
 * group degrades to its present members instead of failing wholesale
 * (open risk #7).
 */
export function resolveGroup(home: string, name: string): { record: GroupRecord; members: ResolvedMember[] } {
    const record = getGroup(home, name);
    if (!record) {
        throw new Error(`group '${name}' is not declared (no ${groupPath(home, name)})`);
    }
    const members: ResolvedMember[] = record.members.map((m) => {
        const memoryPath = path.join(m.path, MEMBER_MEMORY_RELPATH);
        let skipped = false;
        let skipReason: string | undefined;
        if (!fs.existsSync(m.path)) {
            skipped = true;
            skipReason = `checkout path missing: ${m.path}`;
        } else if (!fs.existsSync(memoryPath)) {
            skipped = true;
            skipReason = `memory.jsonl missing: ${memoryPath} (run 'atlas memory export' in ${m.name})`;
        }
        // G-3 — OPT-IN code-graph artifact + bridge inputs. Resolved ONLY when
        // the member checkout exists (no point probing a missing dir); a missing
        // code-graph.jsonl is the expected default and does NOT skip the member.
        let codeGraphPath: string | undefined;
        let memberRepoSlug: string | undefined;
        let packageName: string | undefined;
        if (!skipped || skipReason?.startsWith('memory.jsonl')) {
            if (fs.existsSync(m.path)) {
                const cg = path.join(m.path, MEMBER_CODEGRAPH_RELPATH);
                if (fs.existsSync(cg)) codeGraphPath = cg;
                memberRepoSlug = repoSlug(m.path);
                packageName = readPackageName(m.path);
            }
        }
        return { name: m.name, path: m.path, memoryPath, skipped, skipReason, codeGraphPath, repoSlug: memberRepoSlug, packageName };
    });
    return { record, members };
}
