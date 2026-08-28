/**
 * cli/groupYaml.ts — IN-REPO group declaration that TRAVELS VIA GIT.
 *
 * G-1 gave us a per-machine JSON registry (`<ATLAS_HOME>/groups/<name>.json`):
 * great ergonomics, but it lives outside any repo, so a teammate who clones the
 * anchor repo inherits NOTHING. This module adds a complementary in-repo
 * declaration — `<anchorRepo>/.atlas/group.yaml` — that is committed alongside
 * the code, so cloning the anchor repo carries the group with it.
 *
 * The two layers coexist (G-1 is NOT removed):
 *   - per-machine JSON registry → groups you declare locally, by absolute path.
 *   - in-repo group.yaml        → groups that ship inside an anchor repo and
 *                                 reference members by STABLE git-remote slug
 *                                 (repoSlug), so they resolve on any machine.
 *
 * group.yaml shape (flat YAML; parsed by the minimal reader below — no external
 * dependency required):
 *
 *     name: atlas-lore
 *     members:
 *       - name: atlas
 *         remote: github.com-groundfloor-atlas   # repoSlug, stable across machines
 *         path: ../groundfloor-atlas   # OPTIONAL local hint
 *       - name: lore
 *         remote: github.com-groundfloor-lore
 *         path: ../groundfloor-lore
 *
 * `remote` is the PRIMARY identity (the repoSlug — same on every machine).
 * `path` is an OPTIONAL relative hint (a teammate's layout may differ); it is
 * resolved against the anchor dir as a last resort. Resolution order is:
 *
 *   1. indexed-repo registry (<LORE_HOME>/atlas-registry.json) — match a member
 *      `remote` slug to a registered repo's local checkout (the strongest
 *      signal: this machine has actually indexed that repo).
 *   2. the relative `path` hint resolved against the anchor dir.
 *   3. SKIP + WARN (degrade-don't-fail) — a member that resolves to nothing is
 *      dropped, never fatal, so the group still co-loads every member present.
 *
 * Degrade-don't-fail mirrors the G-1 registry's resolveGroup contract.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { repoSlug } from './repoId.js';
import { MEMBER_MEMORY_RELPATH } from './groups.js';

/** Relative path of the in-repo group declaration inside an anchor repo. */
export const GROUP_YAML_RELPATH = path.join('.atlas', 'group.yaml');

/** A member as DECLARED in `.atlas/group.yaml`. */
export interface YamlGroupMember {
    /** Stable member name (provenance label on load). */
    name: string;
    /** repoSlug of the member's git origin remote — primary, machine-stable id. */
    remote?: string;
    /** OPTIONAL relative path hint (resolved against the anchor dir). */
    path?: string;
}

/** Parsed shape of an `.atlas/group.yaml`. */
export interface YamlGroupDecl {
    name: string;
    members: YamlGroupMember[];
}

/** A member RESOLVED to a local checkout (or marked skipped). */
export interface ResolvedYamlMember {
    /** Declared member name (becomes project=<name> provenance on load). */
    name: string;
    /** Declared remote slug (if any). */
    remote?: string;
    /** Local checkout root we resolved to (undefined when skipped). */
    checkoutPath?: string;
    /** Absolute path to the member's memory.jsonl (undefined when skipped). */
    memoryPath?: string;
    /** How we resolved: which signal won (for diagnostics). */
    resolvedVia?: 'registry' | 'path-hint';
    /** True when the member could not be resolved to a present memory.jsonl. */
    skipped: boolean;
    /** Human-readable reason when skipped (else undefined). */
    skipReason?: string;
}

/* ─── Minimal flat YAML (read) ─────────────────────────────────────────────
 *
 * We deliberately support ONLY the narrow shape group.yaml uses — a top-level
 * `name:` scalar and a `members:` list of `{name, remote, path}` maps — instead
 * of pulling in a full YAML parser. The grammar accepted:
 *
 *   name: <scalar>
 *   members:
 *     - name: <scalar>
 *       remote: <scalar>
 *       path: <scalar>
 *     - ...
 *
 * `# comments` and blank lines are ignored. Quotes (single/double) around a
 * scalar are stripped. Anything outside this shape is ignored, not an error —
 * the file is small and author-written, and a strict parser would be brittle
 * for no benefit. (If js-yaml is later adopted, swap parseGroupYaml's body.)
 */

function stripComment(line: string): string {
    // Strip an unquoted trailing comment. We only need to honor quotes enough
    // not to truncate a quoted scalar containing '#', which is rare for slugs/
    // paths but cheap to guard.
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i);
    }
    return line;
}

function unquote(v: string): string {
    const t = v.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
        return t.slice(1, -1);
    }
    return t;
}

/** Parse a `key: value` pair from a line; returns null when it isn't one. */
function parseKv(line: string): { key: string; value: string } | null {
    const idx = line.indexOf(':');
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim();
    const value = unquote(line.slice(idx + 1));
    if (!key) return null;
    return { key, value };
}

/**
 * Parse the narrow group.yaml grammar. Returns null when the text has no usable
 * `name`/`members` (so the caller can treat it as "not a group.yaml").
 */
export function parseGroupYaml(text: string): YamlGroupDecl | null {
    const lines = text.split(/\r?\n/);
    let name: string | undefined;
    const members: YamlGroupMember[] = [];
    let inMembers = false;
    let current: YamlGroupMember | null = null;

    const flush = () => {
        if (current && current.name) members.push(current);
        else if (current && (current.remote || current.path)) {
            // A member with no explicit name: fall back to the remote slug or the
            // path basename so it still carries a provenance label.
            current.name = current.remote ?? (current.path ? path.basename(current.path) : '');
            if (current.name) members.push(current);
        }
        current = null;
    };

    for (const rawLine of lines) {
        const line = stripComment(rawLine);
        if (!line.trim()) continue;

        const indent = line.length - line.trimStart().length;

        // Top-level keys (no indent).
        if (indent === 0) {
            const kv = parseKv(line);
            if (!kv) continue;
            if (kv.key === 'name') { flush(); name = kv.value; inMembers = false; }
            else if (kv.key === 'members') { flush(); inMembers = true; }
            else { flush(); inMembers = false; }
            continue;
        }

        if (!inMembers) continue;

        // A new list item starts a new member. The "- " may itself carry the
        // first key (e.g. "- name: atlas").
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
            flush();
            current = { name: '' };
            const after = trimmed.slice(1).trim();
            if (after) {
                const kv = parseKv(after);
                if (kv) assignMemberKey(current, kv.key, kv.value);
            }
            continue;
        }

        // A continuation key of the current member.
        if (current) {
            const kv = parseKv(trimmed);
            if (kv) assignMemberKey(current, kv.key, kv.value);
        }
    }
    flush();

    if (!name && members.length === 0) return null;
    return { name: name ?? '', members };
}

function assignMemberKey(member: YamlGroupMember, key: string, value: string): void {
    if (key === 'name') member.name = value;
    else if (key === 'remote') member.remote = value;
    else if (key === 'path') member.path = value;
    // Unknown keys are ignored (forward-compat).
}

/** Read + parse `<anchorDir>/.atlas/group.yaml`. Returns null when absent or
 *  unparseable into the expected shape (tolerant on read). */
export function readGroupYaml(anchorDir: string): YamlGroupDecl | null {
    const p = path.join(anchorDir, GROUP_YAML_RELPATH);
    if (!fs.existsSync(p)) return null;
    try {
        return parseGroupYaml(fs.readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/** True when `arg` is a directory that contains an `.atlas/group.yaml`. */
export function hasGroupYaml(arg: string): boolean {
    try {
        const stat = fs.statSync(arg, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) return false;
        return fs.existsSync(path.join(arg, GROUP_YAML_RELPATH));
    } catch {
        return false;
    }
}

/* ─── Minimal YAML (write) ───────────────────────────────────────────────── */

/** Quote a scalar when it would break the parse round-trip (contains ':' or
 *  '#', has edge whitespace, or starts with a quote char). The companion
 *  parser (stripComment/unquote above) is quote-aware but does NO escape
 *  processing, so never backslash-escape here — pick the quote char that
 *  doesn't appear in the value. A value containing BOTH quote chars can't
 *  round-trip through this minimal grammar; left bare (legacy behavior). */
function yamlScalar(v: string): string {
    if (!/[:#]|^\s|\s$|^["']/.test(v)) return v;
    if (!v.includes('"')) return `"${v}"`;
    if (!v.includes("'")) return `'${v}'`;
    return v;
}

/** Serialize a YamlGroupDecl back to the flat group.yaml shape (deterministic,
 *  diff-friendly, safe to commit). */
export function serializeGroupYaml(decl: YamlGroupDecl): string {
    const lines: string[] = [];
    lines.push(`name: ${yamlScalar(decl.name)}`);
    lines.push('members:');
    for (const m of decl.members) {
        lines.push(`  - name: ${yamlScalar(m.name)}`);
        if (m.remote) lines.push(`    remote: ${yamlScalar(m.remote)}`);
        if (m.path) lines.push(`    path: ${yamlScalar(m.path)}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Write `<anchorDir>/.atlas/group.yaml` declaring `members` (each given as an
 * absolute checkout path). Each member's `name` = checkout basename, `remote` =
 * its repoSlug (stable across machines), `path` = a relative hint from the
 * anchor dir to the member. Returns the parsed declaration that was written.
 *
 * Atomic via temp+rename so a crash can't leave a half-file for git to commit.
 */
export function writeGroupYaml(anchorDir: string, name: string, memberPaths: string[]): YamlGroupDecl {
    const members: YamlGroupMember[] = memberPaths.map((raw) => {
        const abs = path.resolve(raw);
        const member: YamlGroupMember = { name: path.basename(abs) };
        const slug = repoSlug(abs);
        // Only record `remote` when it's a real git slug (differs from the bare
        // basename → the dir is a git repo with an origin). A non-git member
        // still gets a `path` hint so it can resolve locally.
        if (slug && slug !== path.basename(abs)) member.remote = slug;
        const rel = path.relative(path.resolve(anchorDir), abs);
        member.path = rel || '.';
        return member;
    });
    const decl: YamlGroupDecl = { name, members };

    const outDir = path.join(path.resolve(anchorDir), '.atlas');
    const out = path.join(outDir, 'group.yaml');
    fs.mkdirSync(outDir, { recursive: true });
    // RD-F29tmp — unique temp name (pid + random) defeats symlink races and
    // concurrent-writer collisions on a fixed `.tmp` path.
    const tmp = `${out}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, serializeGroupYaml(decl), 'utf-8');
    fs.renameSync(tmp, out);
    return decl;
}

/* ─── Resolution: member remote/path → local checkout ──────────────────────── */

/** A registered repo as read from `<LORE_HOME>/atlas-registry.json`. We only
 *  need name + path; other fields are ignored. */
interface RegistryRepo { name?: string; path?: string }

/** Path to the indexed-repo registry (mirrors codeIndexer.atlasRegistryPath). */
function atlasRegistryPath(): string {
    const loreHome = process.env['LORE_HOME'] || path.join(os.homedir(), '.groundfloor');
    return path.join(loreHome, 'atlas-registry.json');
}

/**
 * Build a remote-slug → local-checkout-path map from the indexed-repo registry.
 * Each registered repo's local `path` is slugged with repoSlug so a member's
 * declared `remote` slug can be matched to "where this machine cloned it".
 * Tolerant: a missing/unreadable registry yields an empty map.
 *
 * `registryPathOverride` is for tests (point at a fixture registry).
 */
export function buildRemoteToPath(registryPathOverride?: string): Map<string, string> {
    const map = new Map<string, string>();
    const p = registryPathOverride ?? atlasRegistryPath();
    let repos: RegistryRepo[];
    try {
        repos = JSON.parse(fs.readFileSync(p, 'utf-8')) as RegistryRepo[];
    } catch {
        return map;
    }
    if (!Array.isArray(repos)) return map;
    for (const r of repos) {
        if (!r || typeof r.path !== 'string' || !fs.existsSync(r.path)) continue;
        const slug = repoSlug(r.path);
        if (slug) map.set(slug, r.path);
    }
    return map;
}

/**
 * RD-N5 — true if `resolved` (an already-absolute path) lands inside a
 * well-known OS system directory. A repo checkout never lives there, so a
 * group.yaml path hint resolving into one is treated as a traversal escape.
 */
function escapesToSystemRoot(resolved: string): boolean {
    const norm = path.resolve(resolved);
    const unixRoots = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys', '/root', '/var/root'];
    for (const r of unixRoots) {
        if (norm === r || norm.startsWith(r + '/')) return true;
    }
    // Windows: anything under the system root (C:\Windows) or a drive root.
    if (process.platform === 'win32') {
        const lower = norm.toLowerCase();
        const sysRoot = (process.env['SystemRoot'] ?? 'c:\\windows').toLowerCase();
        if (lower === sysRoot || lower.startsWith(sysRoot + '\\')) return true;
    }
    return false;
}

/**
 * Resolve every member of an in-repo group declaration to a LOCAL checkout's
 * memory.jsonl, applying the documented order: registry (remote→path) first,
 * then the relative `path` hint against the anchor dir, else skip+warn.
 *
 * `anchorDir` is the directory that contained the group.yaml. Never throws —
 * a member that can't resolve is returned skipped (degrade-don't-fail).
 */
export function resolveYamlGroup(
    decl: YamlGroupDecl,
    anchorDir: string,
    opts: { remoteToPath?: Map<string, string>; registryPathOverride?: string } = {},
): ResolvedYamlMember[] {
    const remoteToPath = opts.remoteToPath ?? buildRemoteToPath(opts.registryPathOverride);
    const anchorAbs = path.resolve(anchorDir);

    return decl.members.map((m): ResolvedYamlMember => {
        // (1) registry: match the declared remote slug to an indexed checkout.
        let checkoutPath: string | undefined;
        let resolvedVia: ResolvedYamlMember['resolvedVia'] | undefined;
        if (m.remote && remoteToPath.has(m.remote)) {
            checkoutPath = remoteToPath.get(m.remote);
            resolvedVia = 'registry';
        }
        // (2) path hint: resolve the relative path against the anchor dir.
        // RD-N5 — the path hint is RELATIVE by design (it "travels across
        // machines" — sibling/cousin checkouts under arbitrary parents), so we
        // can't pin it to a single subtree. We instead refuse the two shapes a
        // malicious group.yaml would use to escape: an ABSOLUTE path (embedding
        // a fixed system location directly) and any relative path that RESOLVES
        // into a well-known system directory. A normal repo checkout never
        // lives under those roots, so this blocks the abuse without breaking
        // the legitimate relative-hint contract.
        if (!checkoutPath && m.path && !path.isAbsolute(m.path)) {
            const candidate = path.resolve(anchorAbs, m.path);
            if (!escapesToSystemRoot(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                checkoutPath = candidate;
                resolvedVia = 'path-hint';
            }
        }
        // (3) skip+warn.
        if (!checkoutPath) {
            return {
                name: m.name,
                remote: m.remote,
                skipped: true,
                skipReason: m.remote
                    ? `no local checkout for remote '${m.remote}' (not in atlas-registry.json) and path hint ${m.path ? `'${m.path}' did not resolve` : 'absent'}`
                    : `path hint ${m.path ? `'${m.path}' did not resolve` : 'absent'} and no remote declared`,
            };
        }

        const memoryPath = path.join(checkoutPath, MEMBER_MEMORY_RELPATH);
        if (!fs.existsSync(memoryPath)) {
            return {
                name: m.name,
                remote: m.remote,
                checkoutPath,
                resolvedVia,
                skipped: true,
                skipReason: `memory.jsonl missing: ${memoryPath} (run 'atlas memory export' in ${m.name})`,
            };
        }

        return { name: m.name, remote: m.remote, checkoutPath, memoryPath, resolvedVia, skipped: false };
    });
}
