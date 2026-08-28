#!/usr/bin/env node
/**
 * scripts/pm-memory-cycle.mjs — W3-T3: the reference PM operating loop.
 *
 * The canonical, normative sequence the external PM digital employee (a separate
 * paid product) runs to record ONE approved change-request decision into a
 * repo's git-synced `.atlas/memory.jsonl`. Pure node — it shells out to git and
 * to the `atlas memory pm-record` CLI (single core: the schema/validation/append
 * logic lives ONCE in src/pmDecision.ts + src/memoryFile.ts; this script is only
 * the git orchestration around it). The PM product embeds or imitates this.
 *
 * The PM is STATELESS by design: the git file IS the state. Every cycle re-reads
 * fresh (via the union merge on pull), writes through the same union/atomic path
 * a developer's pre-commit hook uses, and never caches across tasks.
 *
 * Normative sequence (see docs/pm-memory-contract.md §"Operating loop"):
 *   1. git pull --rebase           — the union merge driver (install via
 *                                    `atlas memory install-merge-driver`)
 *                                    resolves any memory.jsonl conflict.
 *   2. read fresh                  — implicit: the union on pull + append is a
 *                                    fresh read of the file's state.
 *   3. reason                      — (the PM's LLM step; out of scope here).
 *   4. write                       — `atlas memory pm-record` builds the
 *                                    deterministic-id decision (idempotency key
 *                                    knowledge:decision:pm-<requestId>), validates
 *                                    it, and union-appends. Append IS the PM's
 *                                    export — it has no DB.
 *   5. commit ONLY .atlas/memory.jsonl.
 *   6. push with bounded retry     — on reject: pull --rebase (driver unions) →
 *                                    push again, up to --max-retries. NEVER
 *                                    push --force.
 *
 * Failure modes / recovery:
 *   - pull with no upstream/remote → skipped (first push on a fresh branch); the
 *     step logs and continues.
 *   - pm-record validation/IO failure → the script aborts BEFORE committing;
 *     nothing is pushed, safe to retry the whole cycle.
 *   - push rejected repeatedly (concurrent writers) → after --max-retries the
 *     cycle exits non-zero with the commit sitting locally, retried next cycle.
 *   - a same-requestId re-run UPSERTS to exactly one node (deterministic id), so
 *     re-running a failed cycle is idempotent.
 *
 * Usage:
 *   node scripts/pm-memory-cycle.mjs --repo <dir> \
 *     --request-id <id> --label <summary> \
 *     (--content <text> | --content-file <path|->) \
 *     --approved-by <who> [--approved-at <iso>] [--area <a>] [--tag <t>]... \
 *     [--file <relpath>]        (default .atlas/memory.jsonl) \
 *     [--remote <name>]         (default origin) \
 *     [--branch <name>]         (default: current branch) \
 *     [--no-pull] [--no-push] [--max-retries <n>] (default 3) \
 *     [--atlas-argv <tok>]...   (the atlas CLI argv; default: bin/atlas next to
 *                                this script. Repeatable & space-safe, e.g.
 *                                --atlas-argv node --atlas-argv /path/tsx/cli
 *                                --atlas-argv /path/src/cli.ts)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const out = { tags: [], atlasArgv: [], pull: true, push: true, maxRetries: 3, file: '.atlas/memory.jsonl' };
    const single = {
        '--repo': 'repo', '--request-id': 'requestId', '--label': 'label',
        '--content': 'content', '--content-file': 'contentFile', '--approved-by': 'approvedBy',
        '--approved-at': 'approvedAt', '--area': 'area', '--remote': 'remote',
        '--branch': 'branch', '--file': 'file',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a in single) { out[single[a]] = argv[++i]; continue; }
        if (a === '--tag') { out.tags.push(argv[++i]); continue; }
        if (a === '--atlas-argv') { out.atlasArgv.push(argv[++i]); continue; }
        if (a === '--max-retries') { out.maxRetries = Number(argv[++i]); continue; }
        if (a === '--no-pull') { out.pull = false; continue; }
        if (a === '--no-push') { out.push = false; continue; }
        throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function git(repo, args, opts = {}) {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** git that returns {ok, stdout, stderr} instead of throwing — for the steps
 *  whose failure is a normal control-flow branch (pull with no upstream, a
 *  rejected push). */
function gitTry(repo, args) {
    try {
        return { ok: true, stdout: git(repo, args), stderr: '' };
    } catch (err) {
        return { ok: false, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '') };
    }
}

function resolveAtlasArgv(atlasArgv) {
    if (atlasArgv.length > 0) return atlasArgv;
    // Default: the bin/atlas shipped next to this script's repo.
    return [path.resolve(__dirname, '..', 'bin', 'atlas')];
}

function log(msg) { process.stderr.write(`[pm-cycle] ${msg}\n`); }

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.repo) throw new Error('--repo <dir> is required');
    if (!opts.requestId) throw new Error('--request-id <id> is required');
    if (!opts.label) throw new Error('--label <summary> is required');
    if (!opts.approvedBy) throw new Error('--approved-by <who> is required');
    if (opts.content === undefined && opts.contentFile === undefined) {
        throw new Error('one of --content / --content-file is required');
    }
    const repo = path.resolve(opts.repo);
    const remote = opts.remote ?? 'origin';
    const atlasArgv = resolveAtlasArgv(opts.atlasArgv);
    const [atlasBin, ...atlasPrefix] = atlasArgv;
    const memoryFileAbs = path.join(repo, opts.file);

    // ── Step 1 — pull --rebase (the union driver resolves any conflict) ──────
    if (opts.pull) {
        const branch = opts.branch ?? git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        const r = gitTry(repo, ['pull', '--rebase', remote, branch]);
        if (r.ok) log(`pulled ${remote}/${branch} (union driver resolved any conflict)`);
        else log(`pull skipped/failed (first push on a fresh branch?): ${r.stderr.trim().split('\n').pop()}`);
    }

    // ── Step 4 — write: build + validate + union-append the PM decision ──────
    // Single core: shell to `atlas memory pm-record` (schema lives in the TS
    // library). Append IS the PM's export — no DB.
    const recordArgs = [
        ...atlasPrefix, 'memory', 'pm-record', memoryFileAbs,
        '--request-id', opts.requestId, '--label', opts.label,
        '--approved-by', opts.approvedBy,
        ...(opts.approvedAt ? ['--approved-at', opts.approvedAt] : []),
        ...(opts.area ? ['--area', opts.area] : []),
        ...opts.tags.flatMap((t) => ['--tag', t]),
        ...(opts.content !== undefined ? ['--content', opts.content] : ['--content-file', opts.contentFile]),
    ];
    let recordOut;
    try {
        recordOut = execFileSync(atlasBin, recordArgs, {
            encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
        });
    } catch (err) {
        log(`pm-record FAILED (nothing committed): ${String(err.stderr ?? err.message ?? '')}`);
        process.exit(1);
    }
    const envelope = JSON.parse(recordOut.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    log(`recorded ${envelope.id} (nodeCount=${envelope.nodeCount})`);

    // ── Step 5 — commit ONLY .atlas/memory.jsonl ─────────────────────────────
    git(repo, ['add', '--', opts.file]);
    // Nothing staged (idempotent re-run produced a byte-identical file) → skip
    // the commit; the cycle is already at rest.
    const staged = gitTry(repo, ['diff', '--cached', '--quiet', '--', opts.file]);
    if (staged.ok) {
        log('no change to commit (idempotent re-run) — done');
        printResult(envelope, false, true);
        return;
    }
    git(repo, ['commit', '-m', `pm: decision ${opts.requestId}`, '--', opts.file]);
    log(`committed pm: decision ${opts.requestId}`);

    // ── Step 6 — push with bounded retry (NEVER --force) ─────────────────────
    if (!opts.push) { printResult(envelope, true, false); return; }
    const branch = opts.branch ?? git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    let pushed = false;
    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
        const r = gitTry(repo, ['push', remote, branch]);
        if (r.ok) { pushed = true; log(`pushed (attempt ${attempt})`); break; }
        log(`push rejected (attempt ${attempt}/${opts.maxRetries}) — pulling --rebase and retrying`);
        const pr = gitTry(repo, ['pull', '--rebase', remote, branch]);
        if (!pr.ok) { log(`pull --rebase during retry failed: ${pr.stderr.trim().split('\n').pop()}`); }
    }
    if (!pushed) {
        log(`push FAILED after ${opts.maxRetries} attempts — commit sits locally, retry next cycle`);
        process.exit(2);
    }
    printResult(envelope, true, true);
}

function printResult(envelope, committed, pushed) {
    process.stdout.write(JSON.stringify({ ok: true, id: envelope.id, requestId: envelope.requestId, committed, pushed }) + '\n');
}

try {
    main();
} catch (err) {
    log(`error: ${err.message}`);
    process.exit(1);
}
