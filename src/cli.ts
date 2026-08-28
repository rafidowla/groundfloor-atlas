/**
 * cli.ts — Groundfloor Atlas CLI entry point.
 *
 * Subcommands:
 *   atlas serve                Start the daemon (foreground).
 *   atlas health [--port N]    Probe the running daemon's /health endpoint.
 *   atlas index <file>         Parse <file> and write CodeFile +
 *                              CodeSymbol nodes + CodeRelation edges to
 *                              Lore using the configured workspace + token.
 *   atlas help                 Print usage.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_PORT, ensureMcpAuthToken, loadConfig, mcpAuthEnabled, readAtlasToken, readMcpAuthToken } from './config.js';
// Native-free (see projectRegistry.ts) — safe to import statically from the CLI,
// which must keep `atlas memory *` off the kuzu/lancedb stack.
import { registerProject } from './projectRegistry.js';
import { invalidateWorkspaceResolverCache } from './pathWorkspaceResolver.js';
import { LoreClient, LoreAuthError, type LoreWriter } from './loreClient.js';
// TYPE-ONLY (erased at runtime) — the EmbeddedLore VALUE (and every other
// module that transitively loads the native stack: daemon.js,
// mcp/embeddedRegistry.js, @groundfloor/lore) is dynamic-imported at its use
// sites instead, so commands that don't need the DB (notably the stateless
// `memory show|grep|append`) never load kuzu/LanceDB/better-sqlite3.
import type { EmbeddedLore } from './lore/embeddedLore.js';
import { acquireWorkspaceWriteLock, WorkspaceLockedError } from './lore/writerLock.js';
import { parseFile } from './parser/index.js';
import { indexParsedFile } from './store/codeNodes.js';
import { buildSymbolTable } from './resolver/symbolTable.js';
import { buildResolutionContext } from './resolver/importGraph.js';
import { buildAllCodeEdges } from './resolver/index.js';
import { indexRepoFiles } from './indexCore.js';
import type { ParsedFile, ParsedRelation } from './parser/types.js';
import { walkRepo } from './cli/walker.js';
import { BatchWriter } from './cli/batchWriter.js';
import { loadCheckpoint, saveCheckpoint, needsReindex, markIndexed, checkpointWorkspace } from './cli/checkpoint.js';
import { printMcpConfig } from './cli/mcpConfig.js';
import { runConnect } from './cli/ideConnect.js';
import { exportMemory, importMemory, loadGroup, unionMemoryFileInPlace, type GroupMemberInput } from './cli/memorySync.js';
// W2 (Groundfloor Atlas) — the STATELESS memory surface (`memory show|grep|append`).
// These modules are dependency-free by contract (node builtins + the pure
// union .mjs only); the natives-reaching modules (daemon, embeddedLore,
// embeddedRegistry, @groundfloor/lore) are dynamic-imported at their use
// sites below so the memory file subcommands never load kuzu/LanceDB/sqlite
// (load-guard-tested in tests/memory-no-native.test.ts).
import { readMemoryFile, appendMemoryEntries, normalizeMemoryEntry, KNOWLEDGE_TYPE_SET, type KnowledgeType } from './memoryFile.js';
import { filterNodes, keywordSearch } from './memoryQuery.js';
// W3 (Groundfloor Atlas) — the PM read/write contract. Zero-native-deps like the W2
// surface it stands on (builders/validators/readers over memoryFile/memoryQuery).
import { recordPmDecision, validatePmDecision, flagUnbackedWork, formatFlagNudge } from './pmDecision.js';
import { exportCodeGraph, MEMBER_CODEGRAPH_RELPATH, readPackageName } from './cli/codeGraphSync.js';
import { createGroup, listGroups, resolveGroup, groupExists } from './cli/groups.js';
import { repoSlug, resolveRepoRoot } from './cli/repoId.js';
import { writeGroupYaml, readGroupYaml, hasGroupYaml, resolveYamlGroup, GROUP_YAML_RELPATH } from './cli/groupYaml.js';
import { listCommunities } from './communities/index.js';
import { traceProcess } from './processes/index.js';
import { installService, uninstallService, serviceStatus, configuredHome } from './cli/service.js';
import { installWire, uninstallWire, wireStatus } from './cli/wire.js';
import { installGlobalWire, uninstallGlobalWire } from './cli/globalWire.js';
import { installGitHookSync, uninstallGitHookSync, gitHookSyncStatus, installMergeDriverOnly } from './cli/gitHooks.js';

const HELP = `Groundfloor Atlas — standalone code-intelligence daemon

Usage:
  atlas <command> [options]

Commands:
  serve [--open]     Start the daemon (default port ${DEFAULT_PORT}) and serve
                     the browser UI at http://127.0.0.1:${DEFAULT_PORT}/. Prints an
                     open URL carrying the auth token (?token=…, the Jupyter
                     model). --open also launches the default browser to it.
  health [--port N]  Probe the running daemon's liveness endpoint
  index <path>       Index a file OR (Y3) a directory recursively.
                     If <path> is a directory or --recursive is set,
                     walks the tree honoring .gitignore + .atlasignore
                     and writes through Lore's W9 bulk endpoints.

                     Flags (Y3):
                       -r, --recursive       Force recursive walk on a path
                       --batch <n>           Files per bulk flush (default 50)
                       --exclude <glob>      Skip matched paths (repeatable)
                       --max-files <n>       Cap files crawled (default 50000)
                       --resume              Incremental index (DEFAULT):
                                             skip files unchanged since the
                                             last successful flush (uses
                                             <root>/.atlas/index-state.json)
                       --force, --no-resume  Force a full re-index, ignoring
                                             the checkpoint. ALSO required to
                                             MIGRATE an already-indexed git
                                             repo to git-aware <repo> ids: the
                                             repo namespace is now the git
                                             origin-remote slug (stable across
                                             machines), not the bare dir
                                             basename. Old basename-prefixed
                                             nodes are left as-is until a
                                             --force re-index regenerates them
                                             under the new slug (no in-place
                                             id migration).
                                             ALSO migrates legacy code edges
                                             to TYPED relations: Groundfloor Atlas now
                                             writes the real edge kind
                                             (calls/imports/extends/implements/
                                             contains/queries/writes/
                                             references) instead of the old
                                             collapsed 'related_to'. A
                                             workspace last indexed before this
                                             change keeps its 'related_to'
                                             edges (still handled by the legacy
                                             fallbacks) until a --force
                                             re-index repopulates the typed
                                             kinds. No DB migration — Lore edge
                                             relations are a free string, so
                                             this is a pure re-index.
                       -w, --workspace <n>   Index into workspace <n>. Default:
                                             the root's own .atlas/
                                             index-state.json stamp, else the
                                             config workspace. Use one
                                             workspace PER PROJECT to keep
                                             projects separate.
                       --wait                Block until the daemon-routed run
                                             actually finishes and print the
                                             real result (default: detach —
                                             see below).

                     With the daemon running, plain runs (no --force/--batch/
                     --exclude/--max-files) route THROUGH it automatically —
                     same incremental core, no single-writer lock conflict.
                     --force needs the daemon stopped (it holds the store).

                     --resume skips unchanged WRITES, but parsing + cross-file
                     resolution still cover the whole repo every run, so
                     wall-clock scales with repo SIZE, not diff size — minutes,
                     not seconds, on a large workspace. So a plain run (no
                     --wait) only waits ~5s for a small/fast run to actually
                     finish; on a bigger one it confirms the daemon picked the
                     job up, prints a queued notice, and returns immediately —
                     it does NOT block the caller. Poll completion separately:

  index status        Print the live progress of an in-flight (or last) index
                       run for a workspace — non-blocking, pollable ~1s while
                       active. Once phase="done", errorCount reports per-item
                       write failures from that run (0 = clean) — the one
                       success/failure signal a detached run still has, short
                       of a --wait re-run for the full error detail. Flags:
                       -w, --workspace <n> (default: config workspace).

                     Context layer (semantic code search) — GF-2:
                       atlas index now embeds a small natural-language
                       "context card" per file alongside the code graph.
                       This is what makes code semantically searchable
                       (code_file/code_symbol nodes are graph-only). It is
                       DEFAULT ON. Controls (env, set before the run):
                         ATLAS_CONTEXT_LAYER=0   force OFF (lean graph-only,
                                                 no embeds — fastest index)
                         ATLAS_CONTEXT_SPANS=1   span-mode: one card PER
                                                 multi-line SYMBOL (line-level
                                                 retrieval) instead of one per
                                                 file. ~5-10× more embeds.
                       Size guard (never a silent minutes-long index):
                         >${'10000'} files  → layer auto-OFF (graph-only)
                         >${'20000'} symbols + spans → auto-falls-back to
                                          file-mode. Each prints one stderr
                                          line. Override the caps with
                                          ATLAS_CONTEXT_LAYER_MAX_FILES /
                                          ATLAS_CONTEXT_SPANS_MAX_SYMBOLS.
  init <path>          Index <path> into a workspace (name derived from the
                       git slug or directory name). Run after \`atlas connect\`
                       so IDEs are already wired before the project is indexed.
                       Flags:
                         -w, --workspace <n>   Override the workspace name
  onboard [path]       ONE-COMMAND project onboarding (defaults to .): derive
                       the workspace from the repo slug (reusing an existing
                       one), register the project, fire indexing as a
                       BACKGROUND job, and install the wire harness (hooks,
                       CLAUDE.md + AGENTS.md, git memory-sync) — the
                       workspace_create + workspace_add_project + atlas_index
                       + atlas_wire sequence in a single step. Requires the
                       daemon. Prints a job id; poll with \`atlas index status
                       -w <workspace>\`. A stale .atlas/index-state.json whose
                       root doesn't match <path> triggers a full re-index
                       (with a warning) instead of a broken incremental one.
                       Flags:
                         -w, --workspace <n>   Override the workspace name
                         --wait                Block until the index finishes
                                               and print terminal counts
  hook install [path]  Install a git pre-commit hook in <path> (defaults to
                       current directory) that auto-exports .atlas/memory.jsonl
                       and stages it before every commit. Zero manual steps —
                       just commit as normal and memory travels with the code.
  hook uninstall [path] Remove the Groundfloor Atlas section from the pre-commit hook.
  hook status [path]   Check whether the hook is installed.
  mcp-config [client]  Print ready-to-paste MCP config (with auth token)
                       for: claude-code, claude-desktop, codex, cursor,
                       antigravity, or all (default).
  connect [client]     WRITE/merge the Groundfloor Atlas server (with token) into the
                       client's MCP config — backs up first, never clobbers.
                       omp instead installs the advisory hook into ~/.omp/agent
                       and registers it in config.yml's extensions: list.
                       Clients: claude-code, claude-desktop, codex, cursor,
                       opencode, antigravity (print-only), zcode, vscode, omp,
                       or all (default = installed). vscode is workspace-scoped:
                       run it from the project root — it writes .vscode/mcp.json
                       with the token kept out via VS Code's \${input:} prompt.
  disconnect [client]  Remove only the atlas entry from the client's config
                       (omp: just the extensions: line — the hook file stays;
                       vscode: the server entry + its inputs prompt entry).
  memory export <out-path>
                     Export this workspace's knowledge nodes (decision,
                     convention, bug_pattern, troubleshooting,
                     architecture) + the edges between them to a JSONL
                     file (typically <repo>/.atlas/memory.jsonl). Safe
                     to commit to git — no binary vectors, line-stable,
                     diff/merge-friendly. Embedded Lore mode only.
  memory import <in-path>
                     Re-upsert every node + edge from a memory.jsonl
                     file into the configured workspace. Vectors
                     regenerate locally (embed:true). Embedded Lore
                     mode only. Nodes are ingested before edges so
                     in-repo edges survive; an edge whose endpoints
                     are still missing is reported as deferred (its
                     target lives in a sibling repo — see group load).
  memory show [file] [--type t] [--tag x] [--include-superseded] [--json]
  memory grep <query> [file] [--limit n] [--type t] [--tag x] [--json]
  memory append <file> --json-lines <path|-> [--pm]
                     STATELESS ledger surface (W2) — reads/writes a
                     memory.jsonl file directly with NO daemon, NO
                     embedded Lore, and NO native modules (kuzu/LanceDB/
                     sqlite are never loaded; load-guard-tested). Works
                     in a bare clone with no ATLAS_* config. [file]
                     defaults to <repo-root>/.atlas/memory.jsonl.
                       show    List knowledge entries. Soft-superseded
                               entries are hidden unless
                               --include-superseded; --type/--tag are
                               repeatable filters (--tag = ALL must
                               match). --json prints one stable JSON
                               object for scripts.
                       grep    Case-insensitive keyword search over
                               label/content/tags (label hits weigh
                               3×, tags 2×), top --limit (default 20),
                               deterministic tie-break by id.
                       append  Union-append entries (one JSON object
                               per line, node or edge) from a file or
                               stdin (-). Same-id entries UPSERT (the
                               new entry wins); prior entries are NEVER
                               lost — the same union as the merge
                               driver. Nodes default to type 'decision';
                               header lines in the input are skipped.
                               Malformed/junk entries reject the whole
                               call before anything touches disk.
                               --pm enforces the PM change-request
                               decision contract on every node entry.
                     Exit codes: 0 ok, 1 bad file/entries, 2 usage.
  memory pm-record <file> --request-id <id> --label <l>
                     (--content <c> | --content-file <path|->)
                     --approved-by <who> [--approved-at <iso>]
                     [--area <a>] [--tag <t>]... [--json]
                     W3 — write ONE approved PM change-request
                     decision with a deterministic id
                     (knowledge:decision:pm-<requestId>, the
                     idempotency key — re-running the same request
                     UPSERTS to one node). No DB; union-append IS the
                     PM's export. Prints the id for the commit message.
  memory flag [file] [--type t]... [--include-superseded] [--json]
                     W3 — READ-ONLY developer-side reader: report
                     developer work (non-PM decisions) with no approved
                     PM change request behind it. Flag, NEVER block —
                     always exits 0.
  memory install-merge-driver [path]
                     W3 — install ONLY the union merge driver +
                     .gitattributes stanza (no export/import hooks) so a
                     NON-ATLAS clone (e.g. the PM's Lore-less checkout)
                     unions a conflicted .atlas/memory.jsonl on pull
                     instead of dropping a side. Idempotent.
  code-graph export <out-path>
                     OPT-IN (G-3). Export this workspace's CODE graph
                     (code_file / code_symbol / code_context / code_folder
                     / code_import nodes + their structural edges + the
                     context-card vectors) to a SEPARATE artifact
                     (typically <repo>/.atlas/code-graph.jsonl). This is
                     what a group co-loads for CROSS-REPO code traversal:
                     once two members ship their code graphs, a subgraph
                     BFS centered in repo A can cross into repo B via the
                     module-level import bridge (group load authors it).
                     NEVER writes to memory.jsonl — the knowledge moat
                     stays code-free by construction. The artifact is
                     large + fully regenerable → GITIGNORE it by default;
                     committing it is an explicit opt-in. Embedded Lore
                     mode only.
  group create <name> <path1> <path2> ... [--in-repo <anchorDir>]
                     Declare a NAMED group of repo checkouts so it can
                     be loaded by name later (G-1). Each <path> is a
                     repo working-copy root; the member name is its
                     basename and the git remote is captured when
                     resolvable. Validates each path exists; writes
                     <ATLAS_HOME>/groups/<name>.json.

                     --in-repo <anchorDir>  Instead write a TRAVELS-VIA-
                     GIT declaration to <anchorDir>/.atlas/group.yaml
                     (commit it). Members are recorded by their STABLE
                     repoSlug (git origin remote) + a relative path hint,
                     so a teammate who clones the anchor repo inherits the
                     group and it resolves on their machine.
  group list         List every declared group + its members.
  group load <anchorDir> | <name> | <f1> <f2> ...
                     Co-load several memory.jsonl members into ONE
                     workspace so CROSS-SEAM edges resolve: every
                     member's nodes are ingested first, then every
                     member's edges, so a decision in repo A that
                     references a decision in repo B (e.g.
                     atlas/dec-001 → lore/dec-Y) links up.

                     RESOLUTION ORDER (single arg): (a) a DIRECTORY with
                     .atlas/group.yaml → that travels-via-git declaration
                     is read and each member resolved to a local checkout
                     (indexed-repo registry remote→path first, then the
                     relative path hint, else skip+warn); (b) a declared
                     registry group name → members from <ATLAS_HOME>/groups
                     /<name>.json; (c) else the args are raw memory.jsonl
                     FILE PATHS. Named/yaml groups load into
                     workspace=<group> with PROVENANCE (each node stamped
                     project=<member> + metadata.sourceRepo, so a recall
                     hit shows WHICH repo it came from); a member whose
                     checkout or memory.jsonl is missing is skipped (not
                     fatal). Reports per-member
                     counts + fast/slow (a v1/no-vector member WARNs and
                     re-embeds), edges still dangling (target in no
                     member), and a WARNING for any knowledge id that
                     collides across members. Embedded Lore mode only.
  communities        Cluster code_file nodes into labeled
                     "neighborhoods" (modules) using their call/
                     import edges. Prints one line per community
                     (label + file count + sample files). Embedded
                     Lore mode only.

                     Flags:
                       -w, --workspace <n>   Workspace override
                       --min-size <n>        Drop communities smaller
                                             than n (default 2)
                       --sample-size <n>     Sample files/symbols per
                                             community (default 5)
  processes <entry>  Trace execution flow downstream from <entry>
                     (a symbol name, qualified suffix, or full
                     code-symbol id). Prints one indented line per
                     step in BFS order (depth-stable), with
                     [terminal] markers on leaves. JSON envelope on
                     the last line for scriptable consumers.
                     Embedded Lore mode only.

                     Flags:
                       -w, --workspace <n>   Workspace override
                       --max-depth <n>       Cap traversal depth
                                             (default 8)
                       --max-steps <n>       Cap total steps
                                             (default 200)
  service install [--port N] [--dev] [--no-connect]
                     Install + load a per-user macOS LaunchAgent
                     (com.groundfloor.atlas) so the daemon runs at
                     login and restarts on crash. Default runs the
                     BUILT daemon (dist/daemon.js) under plain node;
                     --dev runs the TypeScript entry via tsx. macOS
                     only. Idempotent (unloads any prior instance
                     first). Logs to <ATLAS_HOME>/daemon.err. After
                     a successful install, auto-connects every
                     detected IDE to the daemon (same as 'atlas
                     connect all') — pass --no-connect to skip.
  service uninstall  Unload + remove the LaunchAgent plist.
  service status     Report plist presence + launchctl load state
                     (installed / loaded / pid / lastExitStatus).
  wire [install] [path]
                     Install the auto-consultation harness into a project
                     (defaults to cwd): Claude Code PreToolUse/PostToolUse
                     hooks (search-enrich, blast-radius on edit, schema
                     guard, stale-index nudge) + a CLAUDE.md "consult Groundfloor Atlas
                     first" block + .claude/skills. Makes Groundfloor Atlas consulted
                     THROUGH the agent, not just callable. Idempotent.
                       --memory-only        Install ONLY the git memory sync
                                             (export/import hooks + union merge
                                             driver), skip the IDE harness — the
                                             open-source "team memory over git"
                                             first-run. Requires a git repo.
                       --merge-driver-only  Install ONLY the union merge driver
                                             (no hooks, no harness) — the
                                             non-Atlas / Lore-less participant
                                             (e.g. PM clone). Alias of
                                             'memory install-merge-driver'.
                       --all-projects       Wire EVERY project registered in
                                             Groundfloor Atlas (all lore-data
                                             workspaces). Refreshes CLAUDE.md,
                                             hooks, and skills in one shot.
                                             Ignores [path]; incompatible with
                                             --merge-driver-only.
                       --global             Merge the Atlas hook into the
                                             GLOBAL ~/.claude/settings.json
                                             instead of a per-repo one — ONE
                                             install covers every project, past
                                             and future, with no per-repo step.
                                             Workspace-less; each hook call
                                             resolves its workspace from cwd.
                                             An already-wired repo's own local
                                             hook keeps firing unchanged; the
                                             global hook steps aside for it
                                             (no double context). Ignores
                                             [path]/--workspace; incompatible
                                             with --memory-only,
                                             --merge-driver-only, and
                                             --all-projects.
                       -w, --workspace <n>  Workspace name the export hook bakes
                                             in (default: derived from repo name).
                                             Ignored with --all-projects (each
                                             repo uses its registry workspace)
                                             and with --global (no workspace
                                             is baked in).
  wire uninstall [path]
                     Remove the Groundfloor Atlas-owned hooks / CLAUDE.md block / skills.
                       --global             Remove EVERYTHING Groundfloor Atlas's
                                             auto-wire installed, machine-wide:
                                             the global ~/.claude/settings.json
                                             hook, per-repo wiring in every
                                             project the registry knows about
                                             (mirrors --all-projects), and every
                                             IDE's MCP connection (same as
                                             'atlas disconnect all'). Ignores
                                             [path]. Nothing Groundfloor Atlas
                                             writes ever re-installs it — a
                                             fresh agent session will not bring
                                             any of this back.
  wire status [path] Report whether hooks / CLAUDE.md / skills are installed.

  remember "<text>"  Queue a verbatim memory entry (append-only, byte-exact
                     text; re-storing identical text is an idempotent
                     upsert) via the daemon's verbatim_store tool with
                     source "cli:manual". Returns as soon as the entry is
                     QUEUED — the write lands via the daemon's background
                     bulk flush. Requires the daemon.

                     Flags:
                       -w, --workspace <n>   Workspace override (default:
                                             config workspace)
                       --topic <t>           Topic tag; entries sharing a
                                             topic are time-compared in
                                             verbatim_recall
  verbatim import <files...>
                     Import files as verbatim entries, one per file
                     (variadic; queued like remember). Timestamp = first
                     ISO date in the file's head, else mtime. Every path
                     is checked against the operator scan allowlist
                     BEFORE anything is read. Requires the daemon.

                     Flags:
                       -w, --workspace <n>   Workspace override (default:
                                             config workspace)
                       --topic <t>           Topic stamped on every
                                             imported entry
  help               Show this message
`;

// Exported (test-only consumer: tests/rc-setup.test.ts) purely so `--no-connect`
// / other flag parsing is unit-testable without spawning `service install` for
// real against this machine's actual LaunchAgents. No behavior change.
export interface ParsedArgs {
    command: string;
    port?: number;
    positional: string[];
    recursive: boolean;
    batchSize?: number;
    excludes: string[];
    /** RD-Mwalker — `--max-files <n>` caps the crawl (default DEFAULT_MAX_FILES). */
    maxFiles?: number;
    resume: boolean;
    /** RD-idx-async — `index --wait` opts BACK IN to the old fully-synchronous
     *  behavior (block until the daemon's atlas_index actually finishes).
     *  Default false: a plain daemon-routed run only waits QUEUE_WAIT_MS before
     *  detaching, so the calling agent/IDE is never held hostage by a large
     *  repo's parse+resolve cost (see cmdIndex). */
    wait: boolean;
    workspace?: string;
    /** WO-3 — `remember` / `verbatim import --topic <t>` tag; entries sharing
     *  a topic are time-compared in verbatim_recall. */
    topic?: string;
    minSize?: number;
    sampleSize?: number;
    maxDepth?: number;
    maxSteps?: number;
    /** PART 2 — `group create … --in-repo <anchorDir>` writes a travels-via-git
     *  .atlas/group.yaml into the anchor repo instead of (only) the registry. */
    inRepo?: string;
    /** `service install --dev` → run the TS entry via tsx instead of dist/daemon.js. */
    dev: boolean;
    /** `serve --open` → open the default browser to the token-bearing launch URL. */
    open: boolean;
    /** RD-F27token — `mcp-config --show-token` prints the live bearer (default redacted). */
    showToken: boolean;
    /** `init --connect <client>` — IDE target for atlas init (default: all). */
    connectTarget?: string;
    /** `service install --no-connect` — skip the post-install `connect all` auto-wire (default: on). */
    noConnect: boolean;
    /** W1 (merge-safety) — `memory export … --union` folds any prior-file-only
     *  entries back into the fresh export so the pre-commit hook can't clobber
     *  remote/PM knowledge the local DB hasn't imported yet. Default off; the
     *  git pre-commit section passes it. */
    union: boolean;
    /** `memory flag --nudge` — the developer-facing commit-time warning that names
     *  unbacked work and points to the PM (flag-never-block; silent when clean;
     *  suppressed by ATLAS_NO_NUDGE). Passed by the pre-commit hook. */
    nudge: boolean;
    /** W2 — `memory show --type <t>` knowledge-type filter (repeatable). */
    types: string[];
    /** W2 — `memory show --tag <x>` tag filter (repeatable, ALL must match). */
    tags: string[];
    /** W2 — `memory show --include-superseded` also lists soft-superseded entries. */
    includeSuperseded: boolean;
    /** W2 — `memory show|grep --json` machine-stable JSON output (the PM shells out to it). */
    json: boolean;
    /** W2 — `memory grep --limit <n>` result cap (default 20). */
    limit?: number;
    /** W2 — `memory append --json-lines <path|->` entries source (file or stdin). */
    jsonLines?: string;
    /** W3-T1 — `memory append --pm` enforces the PM change-request decision
     *  contract (validatePmDecision) on every node entry before writing. */
    pm: boolean;
    /** W3-T1 — `memory pm-record --request-id <id>` the change-request id (the
     *  deterministic-id idempotency key). */
    requestId?: string;
    /** W3-T1 — `memory pm-record --label <l>` the decision's imperative summary. */
    pmLabel?: string;
    /** W3-T1 — `memory pm-record --content <c>` inline decision content. */
    pmContent?: string;
    /** W3-T1 — `memory pm-record --content-file <path|->` content from file/stdin. */
    pmContentFile?: string;
    /** W3-T1 — `memory pm-record --approved-by <who>`. */
    approvedBy?: string;
    /** W3-T1 — `memory pm-record --approved-at <iso>` (defaults to now). */
    approvedAt?: string;
    /** W3-T1 — `memory pm-record --area <a>` optional area/domain tag. */
    area?: string;
    /** W4-T2 — `wire install --memory-only` installs ONLY the git-based memory
     *  sync (export/import hooks + union merge driver), skipping the IDE
     *  consultation harness (settings.json / CLAUDE.md / skills). The first-run
     *  path for a repo that just wants team memory over git, no agent wiring. */
    memoryOnly: boolean;
    /** W4-T2 — `wire install --merge-driver-only` installs ONLY the union merge
     *  driver (no export/import hooks, no IDE harness) — the non-Atlas / Lore-less
     *  participant path (e.g. the PM's clone). Alias of `memory install-merge-driver`. */
    mergeDriverOnly: boolean;
    /** `wire install --all-projects` — refresh harness in every registered repo. */
    allProjects: boolean;
    /** Auto-wire Part 3 — `wire install --global` merges the Atlas hook into
     *  the GLOBAL ~/.claude/settings.json (workspace-less; resolved per-cwd
     *  server-side) instead of a per-repo one. Ignores [path]/--workspace,
     *  incompatible with --memory-only/--merge-driver-only/--all-projects. */
    global: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2);
    const command = args[0] ?? 'help';
    let port: number | undefined;
    let recursive = false;
    let resume = true;
    let wait = false;
    let batchSize: number | undefined;
    let workspace: string | undefined;
    let topic: string | undefined;
    let minSize: number | undefined;
    let sampleSize: number | undefined;
    let maxDepth: number | undefined;
    let maxSteps: number | undefined;
    let inRepo: string | undefined;
    let dev = false;
    let open = false;
    let showToken = false;
    let maxFiles: number | undefined;
    let connectTarget: string | undefined;
    let noConnect = false;
    let union = false;
    let nudge = false;
    let includeSuperseded = false;
    let json = false;
    let limit: number | undefined;
    let jsonLines: string | undefined;
    let pm = false;
    let requestId: string | undefined;
    let pmLabel: string | undefined;
    let pmContent: string | undefined;
    let pmContentFile: string | undefined;
    let approvedBy: string | undefined;
    let approvedAt: string | undefined;
    let area: string | undefined;
    let memoryOnly = false;
    let mergeDriverOnly = false;
    let allProjects = false;
    let globalMode = false; // `--global`; named globalMode locally to avoid shadowing Node's `global`
    const types: string[] = [];
    const tags: string[] = [];
    const excludes: string[] = [];
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--port' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
            i += 1; continue;
        }
        if (a === '-r' || a === '--recursive') { recursive = true; continue; }
        if (a === '--resume') { resume = true; continue; }
        if (a === '--force' || a === '--no-resume') { resume = false; continue; }
        if (a === '--wait') { wait = true; continue; }
        if (a === '--batch' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0 && n <= 1000) batchSize = n;
            i += 1; continue;
        }
        if (a === '--exclude' && args[i + 1]) {
            excludes.push(args[i + 1]!);
            i += 1; continue;
        }
        if (a === '--max-files' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) maxFiles = n;
            i += 1; continue;
        }
        if ((a === '--workspace' || a === '-w') && args[i + 1]) {
            workspace = args[i + 1]!;
            i += 1; continue;
        }
        if (a === '--topic' && args[i + 1]) {
            topic = args[i + 1]!;
            i += 1; continue;
        }
        if (a === '--min-size' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) minSize = n;
            i += 1; continue;
        }
        if (a === '--sample-size' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) sampleSize = n;
            i += 1; continue;
        }
        if (a === '--max-depth' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) maxDepth = n;
            i += 1; continue;
        }
        if (a === '--max-steps' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) maxSteps = n;
            i += 1; continue;
        }
        if (a === '--in-repo' && args[i + 1]) {
            inRepo = args[i + 1]!;
            i += 1; continue;
        }
        if (a === '--dev') { dev = true; continue; }
        if (a === '--open') { open = true; continue; }
        if (a === '--show-token') { showToken = true; continue; }
        if (a === '--connect' && args[i + 1]) {
            connectTarget = args[i + 1]!;
            i += 1; continue;
        }
        if (a === '--no-connect') { noConnect = true; continue; }
        if (a === '--union') { union = true; continue; }
        if (a === '--nudge') { nudge = true; continue; }
        if (a === '--type' && args[i + 1]) {
            types.push(args[i + 1]!);
            i += 1; continue;
        }
        if (a === '--tag' && args[i + 1]) {
            tags.push(args[i + 1]!);
            i += 1; continue;
        }
        if (a === '--include-superseded') { includeSuperseded = true; continue; }
        if (a === '--json') { json = true; continue; }
        if (a === '--limit' && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isInteger(n) && n > 0) limit = n;
            i += 1; continue;
        }
        if (a === '--json-lines' && args[i + 1]) {
            jsonLines = args[i + 1]!;
            i += 1; continue;
        }
        if (a === '--pm') { pm = true; continue; }
        if (a === '--request-id' && args[i + 1]) { requestId = args[i + 1]!; i += 1; continue; }
        if (a === '--label' && args[i + 1]) { pmLabel = args[i + 1]!; i += 1; continue; }
        if (a === '--content' && args[i + 1]) { pmContent = args[i + 1]!; i += 1; continue; }
        if (a === '--content-file' && args[i + 1]) { pmContentFile = args[i + 1]!; i += 1; continue; }
        if (a === '--approved-by' && args[i + 1]) { approvedBy = args[i + 1]!; i += 1; continue; }
        if (a === '--approved-at' && args[i + 1]) { approvedAt = args[i + 1]!; i += 1; continue; }
        if (a === '--area' && args[i + 1]) { area = args[i + 1]!; i += 1; continue; }
        if (a === '--memory-only') { memoryOnly = true; continue; }
        if (a === '--merge-driver-only') { mergeDriverOnly = true; continue; }
        if (a === '--all-projects') { allProjects = true; continue; }
        if (a === '--global') { globalMode = true; continue; }
        positional.push(a);
    }
    return { command, port, positional, recursive, batchSize, excludes, maxFiles, resume, wait, workspace, topic, minSize, sampleSize, maxDepth, maxSteps, inRepo, dev, open, showToken, connectTarget, noConnect, union, nudge, types, tags, includeSuperseded, json, limit, jsonLines, pm, requestId, pmLabel, pmContent, pmContentFile, approvedBy, approvedAt, area, memoryOnly, mergeDriverOnly, allProjects, global: globalMode };
}

async function cmdHealth(portOverride?: number): Promise<number> {
    const cfg = loadConfig();
    const port = portOverride ?? cfg.port;
    const url = `http://127.0.0.1:${port}/health`;
    try {
        const res = await fetch(url);
        const body = (await res.json()) as { status?: string };
        if (res.ok && body.status === 'ok') {
            console.log(JSON.stringify(body));
            return 0;
        }
        console.error(`[atlas] health check failed: HTTP ${res.status} ${JSON.stringify(body)}`);
        return 1;
    } catch (err) {
        console.error(`[atlas] could not reach ${url}: ${(err as Error).message}`);
        console.error('  Start the daemon with `atlas serve` (foreground) or `atlas service install` (background service).');
        return 2;
    }
}

async function cmdIndex(
    target: string | undefined,
    args: { recursive: boolean; batchSize?: number; excludes: string[]; maxFiles?: number; resume: boolean; wait: boolean; workspace?: string },
): Promise<number> {
    if (!target) {
        console.error('atlas: index requires a <path> argument (file or directory)');
        return 64;
    }
    const cfg = loadConfig();
    const abs = path.resolve(target);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat) {
        console.error(`atlas: path not found: ${abs}`);
        return 64;
    }

    // F1: --workspace overrides the configured workspace, so each project
    // can be indexed into its OWN workspace (true separation) instead of
    // everything piling into one shared graph.
    //
    // RD-ws-default — without --workspace, prefer the root's OWN recorded
    // workspace (the .atlas/index-state.json stamp) over the machine-global
    // config default: `atlas index .` run inside a repo must land in THAT
    // repo's workspace, not wherever config.json happens to point (the
    // silent-misfiling trap — see decision-memory-sync-workspace-scoping).
    let workspace = args.workspace;
    if (!workspace) {
        const repoRoot = resolveRepoRoot(abs);
        const walkRoot = stat.isDirectory() ? abs : repoRoot;
        let stamped: { root: string; ws: string } | null = null;
        for (const r of walkRoot === repoRoot ? [walkRoot] : [walkRoot, repoRoot]) {
            const ws = checkpointWorkspace(r);
            if (ws) { stamped = { root: r, ws }; break; }
        }
        workspace = stamped?.ws ?? cfg.lore.workspace;
        console.error(stamped
            ? `[atlas] workspace '${workspace}' (from ${path.join(stamped.root, '.atlas', 'index-state.json')} — pass --workspace to override)`
            : `[atlas] workspace '${workspace}' (config default — pass --workspace if this repo belongs elsewhere)`);
    }

    // Register this repo in the workspace's projects.json. `atlas index <path>`
    // used to write the entire code graph WITHOUT registering, and projects.json
    // is the ONLY thing `atlas wire install --all-projects` enumerates — so a
    // machine could hold twenty indexed repos, four registry entries, and a bulk
    // wire that reported success after touching four of them. Registering here
    // (rather than after the write) covers BOTH the daemon-routed and the direct
    // path below with one call, and is correct even if the index later fails:
    // the repo does belong to this workspace either way. Idempotent, never throws.
    if (cfg.lore.mode === 'embedded' && stat.isDirectory()) {
        if (registerProject(cfg, workspace, abs)) invalidateWorkspaceResolverCache();
    }

    // RD-idx-daemon-first — Kùzu is single-writer per data dir, and the daemon
    // (a KeepAlive launchd service, normally always on) holds every active
    // workspace open — so the direct embedded open below could NEVER take the
    // lock, and `atlas index .`, the exact command the post-commit hook nudges,
    // failed on every wired machine. Same daemon-first shape as memory
    // export/import (tryExportViaDaemon): route plain runs through the daemon's
    // atlas_index — which since RD-idx-resume runs the SAME indexRepoFiles core
    // with the SAME cli/checkpoint.ts semantics (parse all, write changed) —
    // and fall through to the direct path only when the daemon is unreachable
    // (then nothing holds the lock). Runs the daemon tool can't express
    // (--force full re-write, --batch/--exclude/--max-files) stay direct and,
    // with the daemon up, fail legibly with bootout instructions.
    //
    // `abandonedDaemonCall` tracks the fall-through case: the 600s daemon call
    // is left dangling, and its open connection would keep this process's event
    // loop alive long after our own work finished — the confirmed-queued path
    // process.exit(0)s for exactly that reason; the fall-through must too
    // (handled after the finally cleanup at the bottom of cmdIndex).
    let abandonedDaemonCall = false;
    const plainRun = args.resume
        && args.batchSize === undefined
        && args.excludes.length === 0
        && args.maxFiles === undefined
        && (stat.isDirectory() || !args.recursive); // file + -r is a usage error — let the direct path report it
    if (cfg.lore.mode === 'embedded' && plainRun) {
        const port = cfg.port ?? DEFAULT_PORT;
        const daemonPromise = callDaemonTool(port, 'atlas_index', { path: abs, workspace }, 600_000);

        // RD-idx-async — RD-idx-resume only skips the WRITE step; parse + full
        // cross-file resolution (buildSymbolTable/buildResolutionContext) still
        // run over the WHOLE repo on every call (see indexRepoFiles), so
        // wall-clock scales with repo SIZE, not diff size. On this machine's
        // larger workspaces that's measured in MINUTES, not seconds — exactly
        // the "blocks the IDE" failure a nudged `atlas index .` must not cause.
        // Default (no --wait): only wait QUEUE_WAIT_MS for a small/fast run to
        // actually finish; otherwise confirm the daemon picked the job up
        // (index_status) and detach, leaving it to keep working. This reuses —
        // on purpose — the exact "no cancellation" property documented in
        // atlas-daemon-index-no-cancellation that made auto-firing this on every
        // commit unsafe: a client that stops waiting does NOT stop the
        // server-side run, which is precisely what fire-and-forget needs.
        const QUEUE_WAIT_MS = 5_000;
        const res = args.wait
            ? await daemonPromise
            : await Promise.race([daemonPromise, new Promise<'PENDING'>((resolve) => setTimeout(() => resolve('PENDING'), QUEUE_WAIT_MS))]);

        if (res === 'PENDING') {
            // Confirm the run actually started before claiming "queued" — a slow
            // health-check retry inside callDaemonTool could otherwise be
            // mistaken for a job in flight when nothing has happened yet.
            const confirm = await callDaemonTool(port, 'index_status', { workspace }, 3_000);
            const confirmText = (confirm?.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string')?.text;
            let liveStatus: { indexing?: boolean } | null = null;
            try { liveStatus = confirmText ? JSON.parse(confirmText) as { indexing?: boolean } : null; }
            catch { liveStatus = null; }
            if (liveStatus?.indexing === true) {
                console.log(JSON.stringify({
                    ok: true, queued: true, workspace, path: abs, via: 'daemon',
                    note: `Reindexing in the background — the daemon keeps running even though this command already returned. Check progress: atlas index status --workspace ${workspace}. Pass --wait to block until done instead.`,
                }));
                // Force-exit: `return 0` alone wouldn't — the abandoned daemon
                // call's open connection would keep Node's event loop (and this
                // process) alive until the multi-minute run eventually finishes.
                process.exit(0);
            }
            console.error(`[atlas] daemon didn't confirm the index started within ${QUEUE_WAIT_MS}ms — falling back to a direct index.`);
            abandonedDaemonCall = true;
            // Fall through to the direct path below (same as daemon-unreachable).
        } else if (res) {
            const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
            let daemonResult: Record<string, unknown> | null = null;
            try { daemonResult = textBlock?.text ? JSON.parse(textBlock.text) as Record<string, unknown> : null; }
            catch { daemonResult = null; }
            if (daemonResult && typeof daemonResult.error === 'string') {
                console.error(`atlas: daemon index refused: ${String(daemonResult.detail ?? daemonResult.error)}`);
                return daemonResult.error === 'index_in_progress' ? 9 : 7;
            }
            if (daemonResult) {
                console.log(JSON.stringify({ ...daemonResult, via: 'daemon' }));
                return daemonResult.ok === true ? 0 : 7;
            }
            console.error('[atlas] unreadable daemon atlas_index result — falling back to a direct index.');
        }
        // res === null → daemon unreachable: the direct path below can safely
        // take the writer lock (nothing else holds the store).
    }

    // A3 (PERFORMANCE.md): pre-warm the embedding model in parallel with parse +
    // Lore open, so the first card embed isn't a cold start. Best-effort; only
    // when the embed path (context layer) is active. Read the env flag HERE,
    // before EmbeddedLore.open() scrubs process.env.
    //
    // GF-2 — mirror the embed gate's new DEFAULT-ON polarity (`!== '0'`) so the
    // model still pre-warms in the new default; only an explicit
    // ATLAS_CONTEXT_LAYER=0 (force graph-only) skips the warm. Must read
    // identically to CONTEXT_LAYER_ENABLED in store/codeNodes.ts — same gate.
    if (process.env.ATLAS_CONTEXT_LAYER !== '0') {
        // Dynamic import — @groundfloor/lore eagerly loads the native stack
        // (lancedb/sqlite) at module load, which only the index/DB paths need.
        void import('@groundfloor/lore')
            .then((m) => m.preloadLocalModel())
            .catch(() => { /* best-effort warm */ });
    }

    // E6 — pick the write transport. 'embedded' runs a DEDICATED in-process
    // Lore (own kuzu+lancedb+sqlite under a per-workspace dataDir, no daemon,
    // no port, no token); 'http' talks to a separate Lore daemon (legacy).
    let client: LoreWriter;
    // RC #1 — single-writer lock on the workspace dataDir, shared with the
    // daemon's atlas_index. `atlas index` is a SEPARATE process from the
    // always-on daemon, so the daemon's in-process _indexInFlight guard can't
    // see this CLI write and vice versa; only a filesystem lock serializes the
    // two. Acquired BEFORE open (kuzu itself is single-writer, so a concurrent
    // open would otherwise race), released in the finally after close(). HTTP
    // mode writes through the daemon and never opens the dataDir directly, so
    // it needs no lock.
    let releaseLock: (() => void) | null = null;
    if (cfg.lore.mode === 'embedded') {
        // PF-3 / RD-F01 — sanitize the (user-supplied) workspace through the
        // single canonical guard so traversal can't slip past a drifted copy.
        // (Dynamic import: embeddedRegistry transitively loads the native
        // stack, which only the DB-touching commands may pull in.)
        const { embeddedDataDir } = await import('./mcp/embeddedRegistry.js');
        const dataDir = embeddedDataDir(cfg, workspace);
        try {
            releaseLock = acquireWorkspaceWriteLock(dataDir).release;
        } catch (err) {
            if (err instanceof WorkspaceLockedError) {
                console.error(
                    `[atlas] workspace '${workspace}' is being indexed by pid ${err.holderPid} ` +
                    `(likely the Atlas daemon or a concurrent 'atlas index'). ` +
                    `Wait for it to finish and retry — refusing to write concurrently ` +
                    `to avoid corrupting the store.`,
                );
                return 9;
            }
            console.error(`[atlas] could not acquire writer lock for ${dataDir}: ${(err as Error).message}`);
            return 6;
        }
        try {
            const { EmbeddedLore } = await import('./lore/embeddedLore.js');
            client = await EmbeddedLore.open(dataDir);
        } catch (err) {
            releaseLock();
            const msg = (err as Error).message;
            // RD-daemon-lock — same legible message as openEmbeddedForMemory: a
            // raw Kùzu "Could not set lock" reads like corruption when it just
            // means the daemon holds the store. Reached only on non-plain runs
            // (--force/--batch/--exclude/--max-files) — plain ones route through
            // the daemon above and never open directly while it's up.
            if (/could not set lock|lock on file/i.test(msg)) {
                console.error(
                    `atlas: the Groundfloor Atlas daemon is running and holds workspace '${workspace}' ` +
                    `(the embedded store is single-writer), so this command can't open it directly.\n` +
                    `  Plain runs (no --force/--batch/--exclude/--max-files) route through the daemon — retry without those flags.\n` +
                    `  For init, --force, or any flagged run, stop the daemon first:  launchctl bootout gui/$(id -u)/com.groundfloor.atlas\n` +
                    `  then re-run, and restart it after with:  atlas service install`,
                );
                return 6;
            }
            console.error(`[atlas] could not open embedded Lore at ${dataDir}: ${msg}`);
            return 6;
        }
        console.error(`[atlas] embedded Lore ready (workspace=${workspace}, dataDir=${dataDir})`);
    } else {
        const token = readAtlasToken(cfg.home);
        if (!token) {
            console.error(
                `atlas: no auth token found. Put a Lore bearer token at ${path.join(cfg.home, 'auth.token')} ` +
                'or set LORE_AUTH_TOKEN.',
            );
            return 3;
        }
        const http = new LoreClient({ mcpUrl: cfg.lore.mcpUrl, token });
        try {
            await http.connect();
        } catch (err) {
            if (err instanceof LoreAuthError) {
                console.error(`[atlas] ${err.message}`);
                return 5;
            }
            console.error(`[atlas] could not connect to Lore at ${cfg.lore.mcpUrl}: ${(err as Error).message}`);
            return 6;
        }
        client = http;
    }

    let code: number;
    try {
        // Y3 — directory walk OR explicit -r/--recursive flag flips into
        // the batch path. A plain file argument keeps the legacy
        // single-file behavior so existing scripts + IDE plug-ins don't
        // break.
        if (stat.isDirectory() || args.recursive) {
            code = await runRecursiveIndex(client, abs, cfg, args, workspace);
        } else {
            code = await runSingleFileIndex(client, abs, cfg, workspace);
        }
    } finally {
        await client.close().catch(() => undefined);
        // Release the single-writer lock AFTER close() so the store handle is
        // fully released before another writer can acquire.
        if (releaseLock) releaseLock();
    }
    if (abandonedDaemonCall) {
        // The daemon-confirm race fell through with the 600s daemon call still
        // dangling — its open connection would keep Node's event loop alive
        // long after our work printed its result (the confirmed-queued path
        // exits explicitly for exactly this reason). Store close + lock
        // release already happened above, so cutting the process is safe.
        process.exit(code);
    }
    return code;
}

/** `atlas index status [--workspace <ws>]` — the non-blocking companion to a
 *  detached daemon-first run (RD-idx-async): reads the daemon's live
 *  index_status snapshot (a pure in-memory read, never blocks on the store)
 *  so a caller who got a "queued" response can check completion on their own
 *  schedule instead of the CLI holding the terminal/tool-call open. */
async function cmdIndexStatus(workspaceOverride?: string): Promise<number> {
    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const res = await callDaemonTool(port, 'index_status', { workspace }, 5_000);
    if (!res) {
        console.error(`atlas: could not reach the daemon at 127.0.0.1:${port} to check index status.`);
        console.error('  Start it with `atlas serve` or `atlas service install`.');
        return 6;
    }
    const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
    if (!textBlock?.text) {
        console.error('atlas: unreadable index_status result from the daemon.');
        return 6;
    }
    console.log(textBlock.text);
    return 0;
}

/** `atlas onboard [path]` — one-call onboarding. All the orchestration lives
 *  in the daemon's atlas_onboard tool (workspace derive/reuse, stale-index
 *  detection, fire-and-forget index, wire install); the CLI is a thin shell
 *  that requires the daemon — a local in-process fallback would duplicate the
 *  whole orchestration for a rare case, and a local index of a big repo would
 *  block the CLI for the full run anyway. */
async function cmdOnboard(target: string | undefined, opts: { wait: boolean; workspace?: string }): Promise<number> {
    const cfg = loadConfig();
    const abs = path.resolve(target ?? '.');
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
        console.error(`atlas: onboard expects a project directory: ${abs}`);
        return 64;
    }
    const port = cfg.port ?? DEFAULT_PORT;
    const res = await callDaemonTool(
        port,
        'atlas_onboard',
        { path: abs, workspace: opts.workspace, wait: opts.wait },
        // wait mode blocks for the whole index run — same 600s allowance as
        // cmdIndex's daemon-routed --wait. Non-wait returns in milliseconds.
        opts.wait ? 600_000 : 60_000,
    );
    if (!res) {
        console.error(`atlas: onboard requires the daemon — could not reach it at 127.0.0.1:${port}.`);
        console.error('  Start it with `atlas serve` or `atlas service install`.');
        return 6;
    }
    const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
    let parsed: Record<string, unknown> | null = null;
    try { parsed = textBlock?.text ? JSON.parse(textBlock.text) as Record<string, unknown> : null; }
    catch { parsed = null; }
    if (!parsed) {
        console.error('atlas: unreadable atlas_onboard result from the daemon.');
        return 6;
    }
    if (typeof parsed.error === 'string') {
        console.error(`atlas: onboard failed: ${String(parsed.detail ?? parsed.error)}`);
        return parsed.error === 'index_in_progress' ? 9 : 7;
    }
    console.log(JSON.stringify({ ...parsed, via: 'daemon' }, null, 2));
    return 0;
}

async function runSingleFileIndex(
    client: LoreWriter,
    abs: string,
    cfg: ReturnType<typeof loadConfig>,
    workspace: string,
): Promise<number> {
    // PATH-DIVERGENCE FIX — root the single-file parse at the actual REPO ROOT
    // (git work-tree top-level), NOT the file's containing dirname. Rooting at
    // the dirname made ParsedFile.path relative to that dir (e.g. "foo.ts" for
    // /repo/src/foo.ts), so the code-file id (qualify(repo, file.path)) diverged
    // from the recursive index — which roots at the repo root and yields
    // "src/foo.ts". Re-indexing one nested file after a recursive index then
    // wrote a brand-new ORPHAN node instead of updating the existing one, and
    // its cross-file edges resolved against a degenerate one-file table. Rooting
    // both single-file and recursive at the same repo root keeps file.path —
    // and therefore the node id — identical, so the single-file write upserts.
    const repoRoot = resolveRepoRoot(abs);
    let parsed;
    try { parsed = await parseFile(abs, repoRoot); }
    catch (err) {
        console.error(`[atlas] parse failed: ${(err as Error).message}`);
        return 4;
    }
    if (!parsed) {
        console.error(`[atlas] no parser registered for ${abs} (unsupported language or unrecognized extension)`);
        return 4;
    }
    try {
        // Slug the resolved repo root so <repo> agrees with the recursive path
        // (repoForRoot) — both feed repoSlug the git work-tree, not a child dir.
        const repo = repoSlug(repoRoot);
        // Resolve the full symbol→symbol edge set (calls + imports +
        // inheritance + contains) so the graph carries real TYPED edges, not
        // just file→symbol containment. Without this the call graph / blast
        // radius / dead-code analytics are empty AND (Sprint 1) imports/
        // extends/implements never reach the store as typed relations.
        const table = buildSymbolTable([parsed]);
        const ctx = await buildResolutionContext(repoRoot, [parsed]);
        const relations = buildAllCodeEdges([parsed], table, ctx);
        const result = await indexParsedFile(client, parsed, {
            workspace,
            repo,
            absolutePath: abs,
        }, relations);
        console.log(JSON.stringify({
            ok: true,
            file: parsed.path,
            workspace,
            codeFileId: result.codeFileId,
            symbolsWritten: result.codeSymbolIds.length,
            relationsWritten: result.codeRelationCount,
            relationsDropped: result.droppedEdgeCount,
        }));
        return 0;
    } catch (err) {
        console.error(`[atlas] index failed: ${(err as Error).message}`);
        return 7;
    }
}

async function runRecursiveIndex(
    client: LoreWriter,
    rootAbs: string,
    cfg: ReturnType<typeof loadConfig>,
    args: { batchSize?: number; excludes: string[]; maxFiles?: number; resume: boolean },
    workspace: string,
): Promise<number> {
    if (!fs.statSync(rootAbs).isDirectory()) {
        console.error(`atlas: --recursive requires a directory (got ${rootAbs})`);
        return 64;
    }
    // PATH-DIVERGENCE FIX (subdir) — root the slug + every PATH (parse root,
    // resolution context, indexCore) at the git work-tree TOP-LEVEL, exactly
    // like the single-file path does, NOT at the user-passed dir. Rooting at
    // the passed dir made ParsedFile.path relative to THAT dir, so
    // `atlas index src/` produced `code-file:<slug>/foo.ts` while
    // `atlas index .` produced `code-file:<slug>/src/foo.ts` — same origin slug,
    // DIVERGENT relative paths → disjoint orphan nodes + a truncated repoFileSet
    // (imports/calls into files outside the subdir misclassified external). We
    // still WALK only the user-passed subdir (so `atlas index src/` indexes just
    // src/), but root paths + the resolution context at the repo top-level so a
    // subdir index upserts the full-repo nodes instead of duplicating them.
    const repoRoot = resolveRepoRoot(rootAbs);
    const repo = repoForRoot(repoRoot);
    // Checkpoint stays keyed on the WALK root (the user-passed subdir) — a
    // subdir crawl has its own fingerprint set; the workspace stamp below still
    // guards cross-workspace reuse.
    const checkpoint = loadCheckpoint(rootAbs, workspace);
    checkpoint.workspace = workspace; // stamp for future-run workspace guard

    // Footgun guard: a --resume against a workspace whose data was wiped
    // out-of-band (e.g. Lore's Pass-3 "delete the workspace and re-ingest"
    // recovery) would skip every "already-done" file and leave a BROKEN partial
    // graph — folder/file nodes never re-written, so their `contains` edges
    // dangle ("edge endpoint missing"). If the checkpoint claims indexed files
    // but the target workspace is actually empty, the data was reset → drop the
    // stale fingerprints and re-index in full. (Embedded only — the HTTP writer
    // exposes no read surface; the workspace stamp above still guards that path.)
    if (args.resume && Object.keys(checkpoint.files).length > 0 && cfg.lore.mode === 'embedded') {
        // mode==='embedded' ⇒ cmdIndex constructed `client` as EmbeddedLore, so
        // the instanceof below only ever narrows (it can't newly load the class
        // — the dynamic import resolves the already-loaded module). HTTP mode
        // skips this entirely, exactly as the old `instanceof` guard did (an
        // HTTP client is never an EmbeddedLore).
        const { EmbeddedLore } = await import('./lore/embeddedLore.js');
        if (client instanceof EmbeddedLore) {
            const probe = await client.listNodes(undefined, undefined, workspace, 1);
            if (probe.length === 0) {
                console.error(
                    `[atlas] checkpoint claims ${Object.keys(checkpoint.files).length} indexed file(s) but ` +
                    `workspace '${workspace}' is empty — its data was reset out-of-band. ` +
                    `Ignoring the stale checkpoint and re-indexing in full.`,
                );
                checkpoint.files = {};
            }
        }
    }

    const writer = new BatchWriter(client, {
        batchSize: args.batchSize,
        onProgress: (line) => console.error(`[atlas] ${line}`),
    });

    const startMs = Date.now();
    let parsed = 0, skipped = 0, parseErrors = 0;
    // RD-Mckptprune — checkpoint keys are repo-relative (same formula
    // needsReindex/markIndexed use: path.relative(root, abs) with POSIX
    // separators). Collected below as `items` is populated, then handed to
    // saveCheckpoint so stale entries (deleted/renamed files, no longer
    // walked at all) are pruned on flush instead of accumulating forever.
    const liveRelPaths = new Set<string>();

    // Pass 1: parse every eligible file (respecting --exclude).
    // We hold the parsed files so call/import resolution can run across the
    // WHOLE batch — cross-file edges are the point of the call graph, and a
    // per-file pass would miss every inter-file call.
    //
    // RESUME CORRECTNESS — decouple "what to parse for resolution" from "what to
    // write". On --resume we still PARSE every eligible file (changed AND
    // unchanged), so buildResolutionContext's repoFileSet and buildSymbolTable
    // see the WHOLE repo. Otherwise an edited file A that imports/calls into an
    // UNCHANGED file B would have B missing from repoFileSet (A's import gets
    // misclassified EXTERNAL) and missing from the symbol table (A→B call edge
    // silently dropped) — every incremental re-index would rot the edited file's
    // cross-file graph until a --force. We mark unchanged files `write: false`
    // so they feed resolution but are excluded from the node/edge batches and
    // the checkpoint below; only changed files (write: true) are re-written.
    const items: Array<{ pf: ParsedFile; abs: string; write: boolean }> = [];
    // MTIME-AT-PARSE — capture each file's fingerprint when it is PARSED so the
    // checkpoint records THAT content's mtime, not whatever the file looks like
    // when its batch lands minutes later (see markIndexed's knownStat param).
    const statAtParse = new Map<string, { mtimeMs: number; sizeBytes: number }>();
    for (const abs of walkRepo(rootAbs, { excludeGlobs: args.excludes, maxFiles: args.maxFiles })) {
        const write = !args.resume || needsReindex(abs, checkpoint);
        let pf;
        // Thread the REPO ROOT (git top-level) so ParsedFile.path is repo-relative
        // (e.g. `src/foo.ts`), not relative to the user-passed subdir (`foo.ts`).
        // This keeps a subdir index's node ids identical to a full-repo index, and
        // buildResolutionContext below is rooted at the same repoRoot so resolution
        // stays consistent. Absolute paths in node IDs break cross-device sync and
        // aren't stable keys.
        try { pf = await parseFile(abs, repoRoot); }
        catch (err) {
            parseErrors++;
            console.error(`[atlas] parse failed (${abs}): ${(err as Error).message}`);
            continue;
        }
        if (!pf) continue;
        try {
            const st = fs.statSync(abs);
            statAtParse.set(abs, { mtimeMs: st.mtimeMs, sizeBytes: st.size });
        } catch { /* vanished mid-run — markIndexed falls back to a fresh stat */ }
        if (write) parsed++; else skipped++;
        items.push({ pf, abs, write });
        // Every file walkRepo yielded (changed or unchanged) is "live" for
        // checkpoint-pruning purposes — only files walkRepo did NOT yield
        // (deleted, renamed, or newly excluded) should lose their entry.
        liveRelPaths.add(path.relative(checkpoint.root, abs).split(path.sep).join('/'));
    }

    // Hand the parsed files to the SHARED index core (src/indexCore.ts) — the
    // same orchestration the atlas_index MCP tool runs. Resolution over the full
    // parsed set, folder/import synthesis, and the node-pass-then-edge-pass write
    // all live there; this driver keeps only the CLI-specific resume/checkpoint
    // and JSON/exit shaping. `onLanded` checkpoints each landed file incrementally
    // (only write-flagged files reach the edge pass, so only they get marked).
    // RC #2 — reconcile stale nodes ONLY on a FULL index (--force / --no-resume)
    // that ALSO covers the WHOLE repo. Two independent guards:
    //   1. `!args.resume` — an incremental --resume writes just the changed
    //      subset, so a reconcile would delete every unchanged file's
    //      still-valid nodes.
    //   2. `coversWholeRepo` — a full-index run can still be NARROWER than
    //      the repo (user passed a subdirectory and/or --exclude globs).
    //      Reconcile deletes every repo node not in this run's live-set, so
    //      `atlas index --force src/` would wipe every file OUTSIDE src/
    //      from the graph. Only reconcile when the walk covered the repo
    //      root with no exclusions.
    const coversWholeRepo =
        path.resolve(rootAbs) === path.resolve(repoRoot) && args.excludes.length === 0;
    const reconcile = !args.resume && coversWholeRepo;
    if (!args.resume && !coversWholeRepo) {
        console.error(
            `[atlas] full index of a subdirectory/excluded walk — skipping stale-node ` +
            `reconcile (it is only safe when the run covers the whole repo).`,
        );
    }
    const core = await indexRepoFiles({
        writer,
        rootAbs: repoRoot,
        workspace,
        repo,
        items,
        batchSize: args.batchSize,
        // `client` is the write transport the reconcile deletes through (no-op
        // unless it's EmbeddedLore).
        reconcile,
        client,
        log: (msg) => console.error(`[atlas] ${msg}`),
        onLanded: (landedFiles) => {
            for (const l of landedFiles) markIndexed(l, checkpoint, statAtParse.get(l));
            // RD-Mckptprune — prune entries for files no longer in this run's
            // walk (deleted/renamed/excluded) on every flush, not just at the
            // end, so a long-running index that's killed mid-way still leaves
            // a checkpoint that's pruned as of the last landed batch rather
            // than one that only ever grows.
            saveCheckpoint(checkpoint, liveRelPaths);
        },
    });

    const wallSec = (Date.now() - startMs) / 1000;
    console.log(JSON.stringify({
        ok: core.errors.length === 0,
        root: rootAbs,
        workspace,
        repo,
        filesParsed: parsed,
        filesSkippedByResume: skipped,
        filesIndexed: core.filesIndexed,
        nodesWritten: core.nodesWritten,
        edgesWritten: core.edgesWritten,
        parseErrors,
        bulkErrors: core.errors.length,
        firstErrors: core.errors.slice(0, 5),
        wallClockSec: Math.round(wallSec * 10) / 10,
    }, null, 2));
    return core.errors.length === 0 ? 0 : 8;
}

function repoForRoot(rootAbs: string): string {
    // GIT-AWARE REPO ID (G-2/GROUPS hardening): derive a STABLE slug from the
    // git origin remote so two repos with the same dir basename (or both "src")
    // can't collide in a shared group store. Falls back to path.basename for
    // non-git dirs — identical to the legacy behavior.
    //
    // MIGRATION: a workspace already indexed under the OLD bare-basename id
    // keeps its old-prefix nodes until a `atlas index --force <root>` re-index
    // regenerates them under this slug. No in-place id migration (see repoId.ts).
    return repoSlug(rootAbs);
}

/**
 * Open the embedded Lore for a memory subcommand. Returns the open
 * client + the resolved workspace name + a description for logging.
 * Memory sync is embedded-only by design — the HTTP transport lacks
 * the listNodes/listEdges read surface we need, and the MVP isn't
 * worth back-porting to it.
 */
async function openEmbeddedForMemory(
    workspaceOverride?: string,
): Promise<
    | { ok: true; client: EmbeddedLore; workspace: string; dataDir: string }
    | { ok: false; exitCode: number }
> {
    const cfg = loadConfig();
    if (cfg.lore.mode !== 'embedded') {
        console.error(
            `atlas: memory export/import requires lore.mode='embedded' (got '${cfg.lore.mode}'). ` +
            `Memory sync only supports the in-process Lore transport.`,
        );
        return { ok: false, exitCode: 2 };
    }
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    // PF-3 / RD-F01 — sanitize the (user-supplied) --workspace through the same
    // canonical guard the daemon + index paths use, so memory/group/analytics
    // commands cannot path-traverse out of the lore-data root.
    let dataDir: string;
    try {
        // Dynamic import — see the type-only EmbeddedLore import note up top:
        // only DB-touching commands may pull in the native stack.
        const { embeddedDataDir } = await import('./mcp/embeddedRegistry.js');
        dataDir = embeddedDataDir(cfg, workspace);
    } catch (err) {
        console.error(`atlas: ${(err as Error).message}`);
        return { ok: false, exitCode: 2 };
    }
    try {
        const { EmbeddedLore } = await import('./lore/embeddedLore.js');
        const client = await EmbeddedLore.open(dataDir);
        return { ok: true, client, workspace, dataDir };
    } catch (err) {
        const msg = (err as Error).message;
        // RD-daemon-lock — Kùzu is single-writer per data dir. When the daemon
        // is up (the common case — it's a KeepAlive service) it holds the lock,
        // and a direct open here fails with a raw "Could not set lock on file"
        // stack that reads like corruption. Surface a clear, actionable message
        // instead. (Commands that HAVE a daemon tool — memory/communities/
        // processes — route through it and never reach this; the ones that
        // don't yet — code-graph export, group load — at least fail legibly.)
        if (/could not set lock|lock on file/i.test(msg)) {
            console.error(
                `atlas: the Groundfloor Atlas daemon is running and holds workspace '${workspace}' ` +
                `(the embedded store is single-writer), so this command can't open it directly.\n` +
                `  Stop the daemon first:  launchctl bootout gui/$(id -u)/com.groundfloor.atlas\n` +
                `  then re-run, and restart it after with:  atlas service install`,
            );
            return { ok: false, exitCode: 6 };
        }
        console.error(`[atlas] could not open embedded Lore at ${dataDir}: ${msg}`);
        return { ok: false, exitCode: 6 };
    }
}

async function cmdHookInstall(projectDir: string, workspaceOverride?: string): Promise<number> {
    // No --workspace given → falls back to loadConfig()'s generic default,
    // which is almost certainly NOT this project's own workspace. Print it
    // loudly rather than silently baking in a probably-wrong name — an
    // operator who runs this without -w should immediately notice if the
    // printed workspace isn't the one they meant to share.
    const workspace = workspaceOverride ?? loadConfig().lore.workspace;
    const r = await installGitHookSync(projectDir, workspace);
    if (!r.ok) {
        console.error(`atlas hook install: ${r.error}`);
        return 1;
    }
    console.log(`  Syncing workspace '${workspace}' via git${workspaceOverride ? '' : ' (default — pass --workspace <name> if this is the wrong one)'}.`);
    for (const [name, wasNew] of Object.entries(r.installed!)) {
        console.log(wasNew ? `✓ ${name} hook installed` : `✓ ${name} hook already installed`);
    }
    if (r.catchUpImport?.attempted) {
        console.log(r.catchUpImport.ok
            ? `✓ Caught up on an existing .atlas/memory.jsonl (${r.catchUpImport.detail})`
            : `⚠ Catch-up import failed (${r.catchUpImport.detail}) — the next pull/checkout will retry automatically.`);
    }
    console.log('  Fully automatic from here: your commits export .atlas/memory.jsonl, and');
    console.log('  pulling/cloning this repo imports it — no manual step needed on either side.');
    return 0;
}

function cmdHookUninstall(projectDir: string): number {
    const r = uninstallGitHookSync(projectDir);
    const any = Object.values(r.installed ?? {}).some(Boolean);
    if (!any) { console.log('No Atlas hook sections found.'); return 0; }
    for (const [name, wasRemoved] of Object.entries(r.installed!)) {
        if (wasRemoved) console.log(`✓ Atlas section removed from ${name}`);
    }
    return 0;
}

function cmdHookStatus(projectDir: string): number {
    const status = gitHookSyncStatus(projectDir);
    for (const [name, state] of Object.entries(status)) {
        console.log(`${name}: ${state === 'installed' ? 'installed' : state === 'no-hook-file' ? 'not installed (no hook file)' : 'not installed (hook exists, Atlas section absent)'}`);
    }
    return 0;
}

/**
 * RD-hook-daemon-lock — Kuzu is single-writer per data dir. If the Atlas
 * daemon is already running (the common case: it's a launchd service that's
 * normally always on), a SEPARATE CLI process opening its own embedded Lore
 * handle for the SAME workspace fails with a lock error. This mattered in
 * practice: the `atlas hook install` pre-commit hook runs `memory export` on
 * every commit, and with the daemon on that export was silently failing
 * every time (errors piped to /dev/null by design, so nothing ever
 * surfaced) — the hook LOOKED like it worked but never actually attached
 * anything to any commit. Route the export/import through the daemon's own
 * /mcp endpoint first (it already holds the handle safely); only fall back
 * to a direct open when the daemon isn't reachable (nothing else holds the
 * lock in that case).
 *
 * RD-daemon-flaky-retry — a single failed attempt here is NOT reliable
 * evidence the daemon is down. Confirmed in practice: calling this
 * immediately after another request to the SAME daemon (e.g. a
 * knowledge_store still finishing a local embedding computation) made the
 * daemon slow enough that a 1.5s health-check timeout gave up, the caller
 * fell back to a direct embedded open, and THAT lost the Kuzu-lock race
 * against the still-busy daemon — a second silent failure stacked on the
 * first. One retry after a short backoff, with a more generous timeout,
 * covers this: if the daemon really is down, the retry costs under a
 * second (a refused connection fails fast); if it was just briefly busy,
 * the retry succeeds and avoids a fallback that was going to lose anyway.
 */
async function callDaemonTool(
    port: number,
    toolName: string,
    args: Record<string, unknown>,
    /** Per-call MCP timeout override — index runs can legitimately exceed the
     *  SDK's 60s default (abandoning the call leaves the daemon grinding with
     *  no cancellation, so wait it out instead). */
    timeoutMs?: number,
): Promise<{ content?: Array<{ type?: string; text?: string }> } | null> {
    // Present the daemon's inbound MCP token so this works when the daemon
    // runs with auth ON (the default). Null when auth is off (no token file) →
    // no header, which an auth-off daemon ignores. Read once outside the retry.
    const mcpToken = readMcpAuthToken();
    const transportOpts = mcpToken
        ? { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }
        : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
        let client: Client | null = null;
        try {
            const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
            if (!health.ok) throw new Error(`unhealthy: ${health.status}`);
            const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), transportOpts);
            client = new Client({ name: 'atlas-cli-memory-sync', version: '0.2.0' }, { capabilities: {} });
            await client.connect(transport);
            return await client.callTool({
                name: 'atlas_tool_invoke',
                arguments: { tool: toolName, args },
            }, undefined, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined) as { content?: Array<{ type?: string; text?: string }> };
        } catch {
            if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, 800)); continue; }
            return null;
        } finally {
            await client?.close().catch(() => undefined);
        }
    }
    return null;
}

async function tryExportViaDaemon(
    port: number,
    workspace: string,
    absOutPath: string,
): Promise<{ nodeCount: number; edgeCount: number; bytes: number; path: string } | null> {
    const res = await callDaemonTool(port, 'knowledge_export_all', { workspace, outPath: absOutPath });
    if (!res) return null;
    // Same result shape as every other Atlas/Lore in-process MCP loopback
    // (embeddedLore.ts): { content: [{type:'text', text: JSON.stringify(...)}] }.
    const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
    if (!textBlock?.text) return null;
    const parsed = JSON.parse(textBlock.text) as {
        ok?: boolean; nodeCount?: number; edgeCount?: number; bytes?: number; path?: string;
    };
    if (!parsed.ok) return null;
    return {
        nodeCount: parsed.nodeCount ?? 0,
        edgeCount: parsed.edgeCount ?? 0,
        bytes: parsed.bytes ?? 0,
        path: parsed.path ?? absOutPath,
    };
}

async function cmdMemoryExport(outPath: string | undefined, workspaceOverride?: string, opts?: { union?: boolean }): Promise<number> {
    if (!outPath) {
        console.error('atlas: memory export requires an <out-path> argument (e.g. .atlas/memory.jsonl)');
        return 64;
    }
    // Resolve to absolute BEFORE trying the daemon path — the daemon's cwd
    // differs from the caller's (e.g. a git hook running with cwd = repo
    // root), so a relative path would resolve against the wrong directory.
    const absOutPath = path.resolve(outPath);

    // W1 (merge-safety) — capture the PRIOR file BEFORE export overwrites it, so
    // we can union file-only (remote/PM) entries back in afterwards. Done here in
    // the CLI wrapper (not inside exportMemory) on purpose: the daemon path below
    // runs exportMemory server-side and would otherwise bypass the union
    // entirely — i.e. the safety would silently not run in the common case that
    // a daemon is up, which is the exact class of failure the original bug was.
    // Unioning around BOTH paths client-side is the correct, robust placement.
    const union = opts?.union ?? false;
    const priorText = union && fs.existsSync(absOutPath) ? fs.readFileSync(absOutPath, 'utf8') : null;

    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const viaDaemon = await tryExportViaDaemon(port, workspace, absOutPath);
    if (viaDaemon) {
        // priorText !== null ⇒ union requested AND a prior file existed. Fold it
        // back in; report the merged counts (a pure DB snapshot under-reports the
        // file after a union).
        const merged = priorText !== null ? unionMemoryFileInPlace(absOutPath, priorText) : null;
        console.log(JSON.stringify({
            ok: true,
            command: 'memory.export',
            via: 'daemon',
            workspace,
            path: viaDaemon.path,
            nodeCount: merged?.nodeCount ?? viaDaemon.nodeCount,
            edgeCount: merged?.edgeCount ?? viaDaemon.edgeCount,
            bytes: merged?.bytes ?? viaDaemon.bytes,
            unioned: merged !== null,
        }));
        return 0;
    }

    const opened = await openEmbeddedForMemory(workspaceOverride);
    if (!opened.ok) return opened.exitCode;
    const { client, workspace: resolvedWorkspace } = opened;
    try {
        const r = await exportMemory(client, resolvedWorkspace, absOutPath);
        const merged = priorText !== null ? unionMemoryFileInPlace(absOutPath, priorText) : null;
        console.log(JSON.stringify({
            ok: true,
            command: 'memory.export',
            via: 'direct',
            workspace: resolvedWorkspace,
            path: r.path,
            nodeCount: merged?.nodeCount ?? r.nodeCount,
            edgeCount: merged?.edgeCount ?? r.edgeCount,
            bytes: merged?.bytes ?? r.bytes,
            unioned: merged !== null,
        }));
        return 0;
    } catch (err) {
        console.error(`[atlas] memory export failed: ${(err as Error).message}`);
        return 7;
    } finally {
        // Wave 1 pattern: drain async writers before exit.
        await client.close().catch(() => undefined);
    }
}

/** Mirrors tryExportViaDaemon — same single-writer-Kuzu reason to exist. */
async function tryImportViaDaemon(
    port: number,
    workspace: string,
    absInPath: string,
): Promise<{ nodeCount: number; edgeCount: number; skipped: number; errorCount: number; firstErrors: unknown[] } | null> {
    const res = await callDaemonTool(port, 'knowledge_import_all', { workspace, inPath: absInPath });
    if (!res) return null;
    const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
    if (!textBlock?.text) return null;
    const parsed = JSON.parse(textBlock.text) as {
        ok?: boolean; error?: string; nodeCount?: number; edgeCount?: number; skipped?: number; errorCount?: number; firstErrors?: unknown[];
    };
    // A structured import failure (bad file, etc.) still came FROM the
    // daemon successfully — surface it as a real result, not a "daemon
    // unreachable" null (which would wrongly trigger the direct-open
    // fallback and likely hit a lock conflict).
    if (parsed.error) return null;
    return {
        nodeCount: parsed.nodeCount ?? 0,
        edgeCount: parsed.edgeCount ?? 0,
        skipped: parsed.skipped ?? 0,
        errorCount: parsed.errorCount ?? 0,
        firstErrors: parsed.firstErrors ?? [],
    };
}

async function cmdMemoryImport(inPath: string | undefined, workspaceOverride?: string): Promise<number> {
    if (!inPath) {
        console.error('atlas: memory import requires an <in-path> argument');
        return 64;
    }
    const absInPath = path.resolve(inPath);

    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const viaDaemon = await tryImportViaDaemon(port, workspace, absInPath);
    if (viaDaemon) {
        console.log(JSON.stringify({
            ok: viaDaemon.errorCount === 0,
            command: 'memory.import',
            via: 'daemon',
            workspace,
            path: absInPath,
            nodeCount: viaDaemon.nodeCount,
            edgeCount: viaDaemon.edgeCount,
            skipped: viaDaemon.skipped,
            errorCount: viaDaemon.errorCount,
            firstErrors: viaDaemon.firstErrors,
        }));
        return viaDaemon.errorCount === 0 ? 0 : 8;
    }

    const opened = await openEmbeddedForMemory(workspaceOverride);
    if (!opened.ok) return opened.exitCode;
    const { client, workspace: resolvedWorkspace } = opened;
    try {
        const r = await importMemory(client, resolvedWorkspace, absInPath);
        console.log(JSON.stringify({
            ok: r.errors.length === 0,
            command: 'memory.import',
            via: 'direct',
            workspace: resolvedWorkspace,
            path: absInPath,
            nodeCount: r.nodeCount,
            edgeCount: r.edgeCount,
            skipped: r.skipped,
            errorCount: r.errors.length,
            firstErrors: r.errors.slice(0, 5),
        }));
        return r.errors.length === 0 ? 0 : 8;
    } catch (err) {
        console.error(`[atlas] memory import failed: ${(err as Error).message}`);
        return 7;
    } finally {
        await client.close().catch(() => undefined);
    }
}

// ── W2 (Groundfloor Atlas) — the STATELESS memory surface: show | grep | append ──────
//
// The no-DB CLI the PM (or any script) shells out to, and the human debugging
// window into the ledger. CONTRACT: these three subcommands read/write
// `.atlas/memory.jsonl` directly — no daemon, no embedded Lore, no config, no
// native modules (kuzu/LanceDB/sqlite are never loaded; the load-guard test
// tests/memory-no-native.test.ts fails the build if that regresses). They work
// in a bare clone with every ATLAS_* env unset. All logic lives in the library
// (src/memoryFile.ts / src/memoryQuery.ts) — these wrappers only parse args
// and shape output. Exit codes: 0 ok, 1 bad file/entries, 2 usage.

/** Default ledger path for the stateless subcommands:
 *  `<repo-root>/.atlas/memory.jsonl`, repo root = the git top-level of cwd
 *  (falls back to cwd outside a work-tree — resolveRepoRoot). */
function defaultMemoryFile(): string {
    return path.join(resolveRepoRoot(process.cwd()), '.atlas', 'memory.jsonl');
}

/** `atlas memory show [file] [--type t] [--tag x] [--include-superseded] [--json]` */
async function cmdMemoryShow(
    fileArg: string | undefined,
    opts: { types: string[]; tags: string[]; includeSuperseded: boolean; json: boolean },
): Promise<number> {
    const badType = opts.types.find((t) => !KNOWLEDGE_TYPE_SET.has(t));
    if (badType !== undefined) {
        console.error(`atlas: memory show: unknown --type '${badType}' (expected one of: decision, convention, bug_pattern, troubleshooting, architecture)`);
        return 2;
    }
    const file = path.resolve(fileArg ?? defaultMemoryFile());
    let view;
    try {
        view = await readMemoryFile(file);
    } catch (err) {
        console.error(`atlas: memory show: ${(err as Error).message}`);
        return 1;
    }
    const nodes = filterNodes(view, {
        types: opts.types as KnowledgeType[],
        tags: opts.tags,
        includeSuperseded: opts.includeSuperseded,
    });
    const envelope = {
        ok: true,
        command: 'memory.show',
        path: file,
        headerVersion: view.headerVersion,
        ...(view.exportedAt !== undefined ? { exportedAt: view.exportedAt } : {}),
        total: view.nodes.length,
        shown: nodes.length,
        edgeCount: view.edges.length,
        errorCount: view.errors.length,
    };
    if (opts.json) {
        // Machine-stable shape (the PM shells out to this): envelope + the
        // filtered nodes + per-line file problems, one JSON object.
        console.log(JSON.stringify({ ...envelope, nodes, errors: view.errors }));
        return 0;
    }
    // Human-readable: one line per node, then the JSON envelope (same
    // humans-skim / tools-`tail -1 | jq` split as communities/processes).
    for (const n of nodes) {
        const superseded = typeof n.supersededAt === 'string' && n.supersededAt ? '  (superseded)' : '';
        const tags = n.tags ? `  #${n.tags.split(',').map((t) => t.trim()).filter(Boolean).join(' #')}` : '';
        console.log(`${n.id}  [${n.type}]  ${n.label ?? ''}${tags}${superseded}`);
    }
    for (const e of view.errors) {
        console.error(`[atlas] memory.jsonl line ${e.line}: ${e.error}`);
    }
    console.log(JSON.stringify(envelope));
    return 0;
}

/** `atlas memory grep <query> [file] [--limit n] [--type t] [--tag x] [--include-superseded] [--json]` */
async function cmdMemoryGrep(
    query: string | undefined,
    fileArg: string | undefined,
    opts: { limit?: number; types: string[]; tags: string[]; includeSuperseded: boolean; json: boolean },
): Promise<number> {
    if (!query) {
        console.error('atlas: memory grep requires a <query> argument');
        return 2;
    }
    const file = path.resolve(fileArg ?? defaultMemoryFile());
    let view;
    try {
        view = await readMemoryFile(file);
    } catch (err) {
        console.error(`atlas: memory grep: ${(err as Error).message}`);
        return 1;
    }
    const results = keywordSearch(view, query, {
        limit: opts.limit,
        types: opts.types as KnowledgeType[],
        tags: opts.tags,
        includeSuperseded: opts.includeSuperseded,
    });
    const envelope = {
        ok: true,
        command: 'memory.grep',
        path: file,
        query,
        matches: results.length,
    };
    if (opts.json) {
        console.log(JSON.stringify({ ...envelope, results }));
        return 0;
    }
    for (const r of results) {
        console.log(`${String(r.score).padStart(4)}  ${r.node.id}  [${r.node.type}]  ${r.node.label ?? ''}`);
    }
    console.log(JSON.stringify(envelope));
    return 0;
}

/** `atlas memory append <file> --json-lines <path|->` — union-append entries
 *  (JSON Lines: one node/edge object per line) into the ledger. Same-id
 *  entries UPSERT (the new entry wins); prior entries are NEVER lost — the
 *  write goes through the same union as the merge driver. Nodes default to
 *  type 'decision'; header-shaped input lines are skipped (so piping a whole
 *  memory.jsonl works). Strict on the INPUT (a malformed entry rejects the
 *  whole call before anything touches disk) — the ledger must never gain junk
 *  the union's junk-tolerance then preserves forever. */
async function cmdMemoryAppend(
    fileArg: string | undefined,
    jsonLines: string | undefined,
    opts: { pm?: boolean } = {},
): Promise<number> {
    if (!fileArg) {
        console.error('atlas: memory append requires a <file> argument (e.g. .atlas/memory.jsonl)');
        return 2;
    }
    if (!jsonLines) {
        console.error('atlas: memory append requires --json-lines <path|-> (the entries to append, one JSON object per line; - = stdin)');
        return 2;
    }
    let text: string;
    try {
        text = jsonLines === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(jsonLines), 'utf8');
    } catch (err) {
        console.error(`atlas: memory append: could not read entries: ${(err as Error).message}`);
        return 1;
    }
    const entries: Array<ReturnType<typeof normalizeMemoryEntry>> = [];
    const rawLines = text.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i]!.trim();
        if (!line) continue;
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
            console.error(`atlas: memory append: entries line ${i + 1} is not valid JSON: ${(err as Error).message}`);
            return 1;
        }
        // Skip header-shaped lines (same identity rule as the union) so a
        // whole memory.jsonl can be piped in as an entries source.
        if (obj['kind'] === undefined && (obj['version'] !== undefined || obj['exportedTypes'] !== undefined)) continue;
        entries.push(normalizeMemoryEntry(obj));
    }
    // W3-T1 — `--pm` enforces the PM change-request decision contract on every
    // node entry (edges pass through — only endpoints/relation are checked by
    // appendMemoryEntries). Reject the WHOLE call before touching disk so a
    // malformed PM entry never lands in the ledger the union then preserves.
    if (opts.pm) {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            if (entry.kind !== 'node') continue;
            const v = validatePmDecision(entry);
            if (!v.ok) {
                console.error(`atlas: memory append --pm: entry ${i + 1} (${entry.id || 'no-id'}) is not a valid PM decision: ${v.errors.join('; ')}`);
                return 1;
            }
        }
    }
    try {
        const r = appendMemoryEntries(path.resolve(fileArg), entries);
        console.log(JSON.stringify({ ok: true, command: 'memory.append', ...r }));
        return 0;
    } catch (err) {
        // Library errors already carry the `memory append:` prefix.
        console.error(`atlas: ${(err as Error).message}`);
        return 1;
    }
}

/**
 * W3-T1/T3 — `atlas memory pm-record <file> --request-id <id> --label <l>
 * (--content <c> | --content-file <path|->) --approved-by <who> [--approved-at
 * <iso>] [--area <a>] [--tag <t>]... [--json]`.
 *
 * Builds the deterministic-id PM change-request `decision` entry, validates it
 * against the contract, and union-appends it (the SAME atomic/union write the
 * developer hook uses — the PM has no DB, so append IS its export). This is the
 * write step of the stateless PM loop; the git pull/commit/push around it is the
 * caller's job (scripts/pm-memory-cycle.mjs). Prints the deterministic id so the
 * caller can build the commit message. Zero native deps.
 */
async function cmdMemoryPmRecord(
    fileArg: string | undefined,
    opts: {
        requestId?: string; label?: string; content?: string; contentFile?: string;
        approvedBy?: string; approvedAt?: string; area?: string; tags: string[]; json: boolean;
    },
): Promise<number> {
    if (!fileArg) {
        console.error('atlas: memory pm-record requires a <file> argument (e.g. .atlas/memory.jsonl)');
        return 2;
    }
    if (!opts.requestId) { console.error('atlas: memory pm-record requires --request-id <id>'); return 2; }
    if (!opts.label) { console.error('atlas: memory pm-record requires --label <summary>'); return 2; }
    if (!opts.approvedBy) { console.error('atlas: memory pm-record requires --approved-by <who>'); return 2; }
    if (opts.content !== undefined && opts.contentFile !== undefined) {
        console.error('atlas: memory pm-record: pass only one of --content / --content-file');
        return 2;
    }
    let content = opts.content;
    if (content === undefined) {
        if (opts.contentFile === undefined) {
            console.error('atlas: memory pm-record requires --content <text> or --content-file <path|-> (- = stdin)');
            return 2;
        }
        try {
            content = opts.contentFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(opts.contentFile), 'utf8');
        } catch (err) {
            console.error(`atlas: memory pm-record: could not read --content-file: ${(err as Error).message}`);
            return 1;
        }
    }
    try {
        const r = recordPmDecision(path.resolve(fileArg), {
            requestId: opts.requestId,
            label: opts.label,
            content,
            approvedBy: opts.approvedBy,
            ...(opts.approvedAt !== undefined ? { approvedAt: opts.approvedAt } : {}),
            ...(opts.area !== undefined ? { area: opts.area } : {}),
            ...(opts.tags.length > 0 ? { tags: opts.tags } : {}),
        });
        console.log(JSON.stringify({
            ok: true, command: 'memory.pm-record',
            id: r.id, requestId: opts.requestId,
            path: r.path, nodeCount: r.nodeCount, edgeCount: r.edgeCount, bytes: r.bytes,
        }));
        return 0;
    } catch (err) {
        console.error(`atlas: ${(err as Error).message}`);
        return 1;
    }
}

/**
 * W3-T5 — `atlas memory flag [file] [--type t]... [--include-superseded] [--json]`.
 *
 * READ-ONLY developer-side flag reader: reports developer work (non-PM decisions
 * by default) with NO approved PM change request behind it. FLAG, NEVER BLOCK —
 * always exits 0 (surfacing a process gap must never fail a script or a hook).
 * Zero native deps.
 */
async function cmdMemoryFlag(
    fileArg: string | undefined,
    opts: { types: string[]; includeSuperseded: boolean; json: boolean; nudge?: boolean },
): Promise<number> {
    const badType = opts.types.find((t) => !KNOWLEDGE_TYPE_SET.has(t));
    if (badType !== undefined) {
        console.error(`atlas: memory flag: unknown --type '${badType}' (expected one of: decision, convention, bug_pattern, troubleshooting, architecture)`);
        return 2;
    }
    const file = path.resolve(fileArg ?? defaultMemoryFile());
    let view;
    try {
        view = await readMemoryFile(file);
    } catch (err) {
        console.error(`atlas: memory flag: ${(err as Error).message}`);
        return 1;
    }
    const flags = flagUnbackedWork(view, {
        ...(opts.types.length > 0 ? { types: opts.types as KnowledgeType[] } : {}),
        includeSuperseded: opts.includeSuperseded,
    });
    // Nudge mode (the pre-commit developer experience): print the friendly,
    // upsell-framed warning to stderr, stay silent when clean, and honor the
    // ATLAS_NO_NUDGE opt-out. Always exit 0 — flag, never block.
    if (opts.nudge) {
        if (!process.env['ATLAS_NO_NUDGE']) {
            for (const line of formatFlagNudge(flags)) console.error(line);
        }
        return 0;
    }
    const envelope = { ok: true, command: 'memory.flag', path: file, flagged: flags.length };
    if (opts.json) {
        console.log(JSON.stringify({
            ...envelope,
            flags: flags.map((f) => ({ id: f.node.id, type: f.node.type, label: f.node.label ?? '', reason: f.reason })),
        }));
        return 0;
    }
    for (const f of flags) {
        console.log(`[atlas] unbacked work: ${f.node.id}  [${f.node.type}]  ${f.node.label ?? ''} — ${f.reason}`);
    }
    console.log(JSON.stringify(envelope));
    return 0;
}

/**
 * W3-T2 — `atlas memory install-merge-driver [path]`. Installs ONLY the union
 * merge driver + `.gitattributes` stanza (no export/import hooks). For a
 * NON-ATLAS git participant — most importantly the PM's Lore-less clone, which
 * must union a conflicted `.atlas/memory.jsonl` on `git pull --rebase` but has
 * no DB to export from. Idempotent. Zero native deps.
 */
async function cmdMemoryInstallMergeDriver(pathArg: string | undefined): Promise<number> {
    const projectDir = pathArg ?? process.cwd();
    const r = installMergeDriverOnly(projectDir);
    if (!r.ok) {
        console.error(`atlas: memory install-merge-driver: ${r.error}`);
        return 1;
    }
    console.log(JSON.stringify({ ok: true, command: 'memory.install-merge-driver', repoRoot: r.repoRoot, mergeDriver: r.mergeDriver }));
    console.log('✓ union merge driver installed (.atlas/memory.jsonl merges by entry id — no knowledge loss on conflict)');
    return 0;
}

/**
 * G-3 — `atlas code-graph export <out-path>`. OPT-IN. Writes this workspace's
 * CODE graph (code_file / code_symbol / code_context / code_folder /
 * code_import nodes + their structural edges + A0 precomputed vectors for the
 * context cards) to a SEPARATE artifact (typically
 * <repo>/.atlas/code-graph.jsonl), so a group can co-load it for cross-repo
 * code traversal.
 *
 * This NEVER touches `.atlas/memory.jsonl` — the moat stays knowledge-only by
 * construction (exportCodeGraph iterates CODE_TYPES; `memory export` iterates
 * KNOWLEDGE_TYPES; there is no shared code path). The artifact is large + fully
 * regenerable → gitignore it by default; committing it is an explicit opt-in.
 */
async function cmdCodeGraphExport(outPath: string | undefined, workspaceOverride?: string): Promise<number> {
    if (!outPath) {
        console.error('atlas: code-graph export requires an <out-path> argument (e.g. .atlas/code-graph.jsonl)');
        return 64;
    }
    const opened = await openEmbeddedForMemory(workspaceOverride);
    if (!opened.ok) return opened.exitCode;
    const { client, workspace } = opened;
    try {
        const r = await exportCodeGraph(client, workspace, outPath);
        console.log(JSON.stringify({
            ok: true,
            command: 'code-graph.export',
            workspace,
            path: r.path,
            nodeCount: r.nodeCount,
            edgeCount: r.edgeCount,
            bytes: r.bytes,
        }));
        return 0;
    } catch (err) {
        console.error(`[atlas] code-graph export failed: ${(err as Error).message}`);
        return 7;
    } finally {
        // Wave 1 pattern: drain async writers before exit.
        await client.close().catch(() => undefined);
    }
}

/**
 * G-1 — `atlas group create <name> <p1> <p2> …`. Declare a named group of repo
 * checkouts so it can later be loaded by name with provenance. Each path is
 * validated to exist at create time. Writes `<home>/groups/<name>.json`.
 *
 * PART 2 — `--in-repo <anchorDir>` instead writes a TRAVELS-VIA-GIT declaration
 * to `<anchorDir>/.atlas/group.yaml`: each member is recorded by its STABLE
 * repoSlug (git origin remote) + a relative path hint, so a teammate who clones
 * the anchor repo inherits the group. The per-machine JSON registry is left
 * intact for non-anchored groups (G-1 is not removed).
 */
async function cmdGroupCreate(name: string | undefined, memberPaths: string[], inRepo?: string): Promise<number> {
    if (!name) {
        console.error('atlas: group create requires a <name> and at least one member path');
        return 64;
    }
    if (memberPaths.length === 0) {
        console.error(`atlas: group create '${name}' requires at least one member <path>`);
        return 64;
    }

    // PART 2 — in-repo declaration: write .atlas/group.yaml into the anchor repo.
    if (inRepo) {
        const anchorAbs = path.resolve(inRepo);
        const stat = fs.statSync(anchorAbs, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) {
            console.error(`atlas: group create --in-repo requires an existing anchor directory (got ${anchorAbs})`);
            return 64;
        }
        // Validate member paths up front (same contract as the registry form).
        for (const raw of memberPaths) {
            const abs = path.resolve(raw);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
                console.error(`atlas: group create --in-repo: member path not a directory: ${abs}`);
                return 64;
            }
        }
        try {
            const decl = writeGroupYaml(anchorAbs, name, memberPaths);
            console.log(JSON.stringify({
                ok: true,
                command: 'group.create',
                mode: 'in-repo',
                name: decl.name,
                path: path.join(anchorAbs, GROUP_YAML_RELPATH),
                members: decl.members.map((m) => ({ name: m.name, ...(m.remote ? { remote: m.remote } : {}), ...(m.path ? { path: m.path } : {}) })),
            }, null, 2));
            return 0;
        } catch (err) {
            console.error(`[atlas] group create --in-repo failed: ${(err as Error).message}`);
            return 7;
        }
    }

    const cfg = loadConfig();
    try {
        const rec = createGroup(cfg.home, name, memberPaths);
        console.log(JSON.stringify({
            ok: true,
            command: 'group.create',
            name: rec.name,
            createdAt: rec.createdAt,
            members: rec.members.map((m) => ({ name: m.name, path: m.path, ...(m.remote ? { remote: m.remote } : {}) })),
        }, null, 2));
        return 0;
    } catch (err) {
        console.error(`[atlas] group create failed: ${(err as Error).message}`);
        return 7;
    }
}

/**
 * G-1 — `atlas group list`. Print every declared group + its members (one
 * member line each), then a JSON envelope on the last line.
 */
async function cmdGroupList(): Promise<number> {
    const cfg = loadConfig();
    const groups = listGroups(cfg.home);
    for (const g of groups) {
        console.log(`[${g.name}] ${g.members.length} member(s):`);
        for (const m of g.members) {
            const remote = m.remote ? ` (${m.remote})` : '';
            console.log(`  - ${m.name}: ${m.path}${remote}`);
        }
    }
    console.log(JSON.stringify({
        ok: true,
        command: 'group.list',
        groups: groups.map((g) => ({
            name: g.name,
            createdAt: g.createdAt,
            members: g.members.map((m) => ({ name: m.name, path: m.path, ...(m.remote ? { remote: m.remote } : {}) })),
        })),
    }));
    return 0;
}

/**
 * G-1/G-2 + PART 2 — `atlas group load <arg1> <arg2> …`. Resolution order:
 *
 *   (a) IN-REPO group.yaml: if a SINGLE arg is a DIRECTORY containing
 *       `.atlas/group.yaml`, read that travels-via-git declaration and resolve
 *       each member to a LOCAL checkout (indexed-repo registry remote→path
 *       first, then the relative `path` hint vs the anchor dir, else skip+warn).
 *       Co-loads into workspace=<group.yaml name> with per-member provenance.
 *   (b) NAMED registry group (G-1): else if the FIRST arg names a DECLARED group
 *       (and is the only arg), resolve from `<home>/groups/<name>.json` → co-load
 *       every present member into workspace=<name> with PROVENANCE. Missing
 *       members are skipped-not-fatal.
 *   (c) RAW PATHS (G-2): else the args are treated as raw memory.jsonl FILE
 *       PATHS, co-loaded into the configured/overridden workspace with
 *       project=<workspace> for all (no per-repo provenance).
 *
 * The name/yaml forms win only with exactly ONE arg — a single raw file path
 * that collides with a group name is unambiguous (a path has separators / a
 * .jsonl suffix; a group name is a bare segment), and multi-arg always means
 * raw paths.
 */
/**
 * G-3 — derive the OPT-IN code-graph + bridge inputs for a member from its
 * checkout root. The code graph is included ONLY when `.atlas/code-graph.jsonl`
 * exists (the member ran `atlas code-graph export`); repoSlug + packageName are
 * the bridge inputs (best-effort — undefined doesn't block, just means that
 * member can't be a bridge target). Returns the fields to spread into a
 * GroupMemberInput. A member with no checkout / no code graph gets {} and is
 * loaded knowledge-only (cross-repo code traversal simply unavailable for it).
 */
function codeGraphInputs(checkoutRoot: string | undefined): Partial<GroupMemberInput> {
    if (!checkoutRoot || !fs.existsSync(checkoutRoot)) return {};
    const out: Partial<GroupMemberInput> = {};
    const cg = path.join(checkoutRoot, MEMBER_CODEGRAPH_RELPATH);
    if (fs.existsSync(cg)) out.codeGraphFile = cg;
    out.repoSlug = repoSlug(checkoutRoot);
    const pkg = readPackageName(checkoutRoot);
    if (pkg) out.packageName = pkg;
    return out;
}

async function cmdGroupLoad(args: string[], workspaceOverride?: string): Promise<number> {
    if (args.length === 0) {
        console.error('atlas: group load requires a <group-name>, an anchor dir with .atlas/group.yaml, OR one or more <memory.jsonl> member paths');
        return 64;
    }

    const cfg = loadConfig();
    const maybeName = args[0]!;
    // (a) IN-REPO group.yaml wins first when the single arg is such a dir.
    const isYamlGroup = args.length === 1 && hasGroupYaml(maybeName);
    const isNamedGroup = !isYamlGroup && args.length === 1 && groupExists(cfg.home, maybeName);

    // Resolve what we're loading + which workspace. For a named/yaml group the
    // workspace IS the group name (its shared dataDir); for raw paths we keep
    // the configured/overridden workspace (G-2 behavior).
    let memberInputs: Array<string | GroupMemberInput>;
    let workspaceForLoad: string | undefined;
    let skippedMembers: Array<{ name: string; reason: string }> = [];

    if (isYamlGroup) {
        const anchorAbs = path.resolve(maybeName);
        const decl = readGroupYaml(anchorAbs);
        if (!decl) {
            console.error(`[atlas] group load failed: could not parse ${path.join(anchorAbs, GROUP_YAML_RELPATH)}`);
            return 7;
        }
        const resolved = resolveYamlGroup(decl, anchorAbs);
        const present = resolved.filter((m) => !m.skipped);
        skippedMembers = resolved
            .filter((m) => m.skipped)
            .map((m) => ({ name: m.name, reason: m.skipReason ?? 'unresolved' }));
        for (const s of skippedMembers) {
            console.error(`[atlas] WARNING: group.yaml '${decl.name}' member '${s.name}' skipped — ${s.reason}`);
        }
        if (present.length === 0) {
            console.error(`[atlas] group load failed: no loadable members in ${path.join(anchorAbs, GROUP_YAML_RELPATH)} ` +
                `(all ${resolved.length} skipped)`);
            return 7;
        }
        // Per-member provenance: project=<member.name> (same as the registry form).
        // G-3 — also thread the OPT-IN code-graph + bridge inputs from each
        // member's checkout (no-op when the member shipped no code-graph.jsonl).
        memberInputs = present.map((m) => ({ file: m.memoryPath!, project: m.name, ...codeGraphInputs(m.checkoutPath) }));
        // The group.yaml's declared name is the shared workspace (one dataDir per
        // group), unless an explicit --workspace override is given.
        workspaceForLoad = workspaceOverride ?? (decl.name || maybeName);
    } else if (isNamedGroup) {
        let resolved;
        try {
            resolved = resolveGroup(cfg.home, maybeName);
        } catch (err) {
            console.error(`[atlas] group load failed: ${(err as Error).message}`);
            return 7;
        }
        const present = resolved.members.filter((m) => !m.skipped);
        skippedMembers = resolved.members
            .filter((m) => m.skipped)
            .map((m) => ({ name: m.name, reason: m.skipReason ?? 'missing' }));
        for (const s of skippedMembers) {
            console.error(`[atlas] WARNING: group '${maybeName}' member '${s.name}' skipped — ${s.reason}`);
        }
        if (present.length === 0) {
            console.error(`[atlas] group load failed: no loadable members in group '${maybeName}' ` +
                `(all ${resolved.members.length} skipped)`);
            return 7;
        }
        // G-1 provenance: project=<member.name> so each hit shows its source repo.
        // G-3 — resolveGroup already resolved the OPT-IN code-graph path + bridge
        // inputs (repoSlug + packageName) per member; thread them straight
        // through (all undefined for a member that shipped no code graph).
        memberInputs = present.map((m) => ({
            file: m.memoryPath,
            project: m.name,
            ...(m.codeGraphPath ? { codeGraphFile: m.codeGraphPath } : {}),
            ...(m.repoSlug ? { repoSlug: m.repoSlug } : {}),
            ...(m.packageName ? { packageName: m.packageName } : {}),
        }));
        // Override is honored if explicitly given; otherwise the group name is
        // the workspace (one shared dataDir per group).
        workspaceForLoad = workspaceOverride ?? maybeName;
    } else {
        // Raw-paths fallback (G-2): args are memory.jsonl files.
        memberInputs = args;
        workspaceForLoad = workspaceOverride;
    }

    const opened = await openEmbeddedForMemory(workspaceForLoad);
    if (!opened.ok) return opened.exitCode;
    const { client, workspace } = opened;
    try {
        const r = await loadGroup(client, workspace, memberInputs);

        // Human-readable: per-member line (with provenance + fast/slow), then
        // collision warnings, then the JSON envelope on the last line (mirrors
        // communities/processes — humans skim, tools `tail -1 | jq`).
        for (const m of r.members) {
            const errSuffix = m.errors.length > 0 ? ` (${m.errors.length} errors)` : '';
            // G-3 — surface co-loaded code nodes when the member opted in.
            const codeSuffix = m.codeNodeCount > 0 ? `, ${m.codeNodeCount} code nodes` : '';
            console.error(`[atlas] member ${m.project} (${m.path}): ${m.nodeCount} nodes${codeSuffix}, ` +
                `${m.skipped} skipped, ${m.speed}${errSuffix}`);
            // G-1 v1/dim load-time guard WARNING.
            if (m.speed === 'slow') {
                console.error(`[atlas] WARNING: member ${m.project}: ` +
                    `v${m.headerVersion ?? 1}/no-vectors → will re-embed (slower). ` +
                    `Run 'atlas memory export' in that repo to ship v2 vectors for the fast path.`);
            }
        }
        // G-2 — collision detector: WARN, never block. Same id in >1 member
        // means a silent upsert-clobber; the cure is member-namespaced ids.
        for (const c of r.collisions) {
            console.error(`[atlas] WARNING: knowledge id '${c.id}' appears in ${c.members.length} members ` +
                `(${c.members.join(', ')}) — co-load will upsert-clobber. Namespace cross-seam ids (e.g. "atlas/${c.id}").`);
        }
        if (r.deferredEdges.length > 0) {
            console.error(`[atlas] ${r.deferredEdges.length} edge(s) still dangling after group load ` +
                `(target in no member) — left unapplied.`);
        }
        // G-3 — report cross-repo bridges + a hint when code traversal is
        // unavailable because no member shipped a code-graph artifact.
        if (r.bridgeEdges.length > 0) {
            for (const b of r.bridgeEdges) {
                console.error(`[atlas] cross-repo bridge: code-import:${b.module} → ${b.member} (${b.targetId})`);
            }
        } else if (r.codeNodeCount === 0) {
            console.error(`[atlas] note: no code-graph artifacts present — cross-repo code traversal unavailable ` +
                `(run 'atlas code-graph export .atlas/code-graph.jsonl' in each member to enable it). ` +
                `Knowledge recall + cross-seam edges are unaffected.`);
        }

        const allErrors = r.members.flatMap((m) => m.errors).concat(r.edgeErrors);
        const resolvedAs = isYamlGroup ? 'yaml' : isNamedGroup ? 'name' : 'paths';
        console.log(JSON.stringify({
            ok: allErrors.length === 0,
            command: 'group.load',
            resolvedAs,
            ...(isYamlGroup || isNamedGroup ? { group: workspace } : {}),
            workspace,
            members: r.members.map((m) => ({
                project: m.project,
                path: m.path,
                nodeCount: m.nodeCount,
                skipped: m.skipped,
                speed: m.speed,
                headerVersion: m.headerVersion,
                errorCount: m.errors.length,
                ...(m.codeNodeCount > 0 ? { codeNodeCount: m.codeNodeCount } : {}),
            })),
            ...(skippedMembers.length > 0 ? { skippedMembers } : {}),
            nodeCount: r.nodeCount,
            edgeCount: r.edgeCount,
            deferredEdgeCount: r.deferredEdges.length,
            collisionCount: r.collisions.length,
            // G-3 — code co-load + cross-repo bridge rollup (0 / [] for a
            // knowledge-only group, so existing consumers see no change).
            codeNodeCount: r.codeNodeCount,
            bridgeEdgeCount: r.bridgeEdges.length,
            ...(r.bridgeEdges.length > 0 ? { bridges: r.bridgeEdges } : {}),
            errorCount: allErrors.length,
            firstErrors: allErrors.slice(0, 5),
        }));
        return allErrors.length === 0 ? 0 : 8;
    } catch (err) {
        console.error(`[atlas] group load failed: ${(err as Error).message}`);
        return 7;
    } finally {
        await client.close().catch(() => undefined);
    }
}

/**
 * RD-daemon-lock — run an embedded-only READ (communities/processes: they need
 * the unbounded listNodes+listEdges surface) daemon-FIRST. Kuzu is single-
 * writer per data dir, so a direct `EmbeddedLore.open` here loses the lock race
 * against a running daemon (the common case — it's a KeepAlive service), which
 * is exactly why these commands used to hard-fail (exit 6) whenever the daemon
 * was up. Route through the daemon's own tool first (it already holds the
 * handle safely); only open our own when the daemon is unreachable. The tool's
 * handler returns the same result object the CLI formats, so this is a
 * transport swap, not a behavior change.
 */
async function resolveEmbeddedRead<T>(
    workspaceOverride: string | undefined,
    toolName: string,
    toolArgs: Record<string, unknown>,
    fallback: (client: EmbeddedLore, workspace: string) => Promise<T>,
): Promise<{ ok: true; result: T; workspace: string } | { ok: false; exitCode: number }> {
    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const res = await callDaemonTool(port, toolName, { workspace, ...toolArgs });
    if (res) {
        // Daemon responded — trust its answer (success OR a structured error);
        // do NOT fall back to a direct open, which would only hit the same
        // error or the lock race and turn a clear message into a confusing one.
        const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
        if (textBlock?.text) {
            const parsed = JSON.parse(textBlock.text) as T & { error?: string; detail?: string };
            if (parsed.error) {
                console.error(`[atlas] ${toolName} failed (daemon): ${parsed.detail ?? parsed.error}`);
                return { ok: false, exitCode: 7 };
            }
            return { ok: true, result: parsed, workspace };
        }
    }
    // Daemon unreachable — safe to open our own handle (nothing else holds the lock).
    const opened = await openEmbeddedForMemory(workspaceOverride);
    if (!opened.ok) return { ok: false, exitCode: opened.exitCode };
    try {
        return { ok: true, result: await fallback(opened.client, opened.workspace), workspace: opened.workspace };
    } catch (err) {
        console.error(`[atlas] ${toolName} failed: ${(err as Error).message}`);
        return { ok: false, exitCode: 7 };
    } finally {
        await opened.client.close().catch(() => undefined);
    }
}

async function cmdCommunities(
    workspaceOverride: string | undefined,
    opts: { minSize?: number; sampleSize?: number },
): Promise<number> {
    const resolved = await resolveEmbeddedRead(
        workspaceOverride, 'atlas_communities',
        { minSize: opts.minSize, sampleSize: opts.sampleSize },
        (client, ws) => listCommunities(client, ws, opts),
    );
    if (!resolved.ok) return resolved.exitCode;
    const r = resolved.result;
    // Human-readable: one line per community. JSON envelope on the last line
    // for scriptable consumers (mirrors memory.export — humans skim, tools
    // tail -1 | jq).
    for (const c of r.communities) {
        const sampleStr = c.sampleFiles.length > 0 ? ` ${c.sampleFiles.join(', ')}` : '';
        console.log(`[${c.label}] ${c.fileCount} files:${sampleStr}`);
    }
    console.log(JSON.stringify({
        ok: true, command: 'communities', workspace: resolved.workspace,
        total: r.total, uncategorized: r.uncategorized,
    }));
    return 0;
}

async function cmdProcesses(
    entry: string | undefined,
    workspaceOverride: string | undefined,
    opts: { maxDepth?: number; maxSteps?: number },
): Promise<number> {
    if (!entry) {
        console.error('atlas: processes requires an <entry> argument (a symbol name, qualified suffix, or code-symbol id)');
        return 64;
    }
    const resolved = await resolveEmbeddedRead(
        workspaceOverride, 'atlas_processes',
        { entry, maxDepth: opts.maxDepth, maxSteps: opts.maxSteps },
        (client, ws) => traceProcess(client, ws, entry, opts),
    );
    if (!resolved.ok) return resolved.exitCode;
    const r = resolved.result;
    // Human-readable: one indented line per step, then the JSON envelope.
    for (const s of r.steps) {
        const indent = '  '.repeat(s.depth);
        const fileSuffix = s.file ? ` ${s.file}` : '';
        const term = s.isTerminal ? '  [terminal]' : '';
        console.log(`${indent}${s.name}${fileSuffix}${term}`);
    }
    console.log(JSON.stringify({
        ok: true, command: 'processes', workspace: resolved.workspace,
        entryQuery: r.entryQuery, entrySymbolId: r.entrySymbolId,
        ...(r.candidates ? { candidates: r.candidates } : {}),
        stepCount: r.stepCount, maxDepthReached: r.maxDepthReached,
        truncatedAtDepth: r.truncatedAtDepth,
    }));
    return 0;
}

// ── `atlas service` — macOS LaunchAgent lifecycle ───────────────────────────
//
// Thin wrappers that delegate to src/cli/service.ts with the REAL seams
// (default ~/Library/LaunchAgents + real launchctl). The module stays
// injectable so tests run against tmp dirs + a fake exec — never the real
// LaunchAgent, never real launchctl. Exit codes mirror the other subcommands:
//   0  success
//   1  guard/runtime failure (non-darwin, plist not loaded, preflight error)

/**
 * `atlas service install [--port N] [--dev] [--no-connect]`. After a
 * successful load, probe the daemon's /health to confirm it actually came up
 * (a failed probe is a non-fatal warning — launchd may still be spinning up),
 * then — unless `--no-connect` was passed — best-effort wire every detected
 * IDE (Claude Code/Cursor/opencode/ZCode/Claude Desktop/Antigravity, plus the
 * OMP advisory hook where ~/.omp exists) to the daemon via `runConnect('all')`,
 * so a fresh install is immediately usable from the IDE without a separate
 * `atlas connect` step. The daemon install already succeeded by this point —
 * a connect failure must never turn the whole command into a failure, so it's
 * wrapped in try/catch and only ever logs a warning.
 */
async function cmdServiceInstall(opts: { port?: number; dev: boolean; noConnect: boolean }): Promise<number> {
    const home = configuredHome();
    const r = installService(
        { dev: opts.dev, ...(typeof opts.port === 'number' ? { port: opts.port } : {}) },
        { home },
    );
    if (!r.ok) {
        console.error(`atlas: service install failed: ${String(r.error ?? r.hint ?? 'unknown error')}`);
        console.log(JSON.stringify(r, null, 2));
        return 1;
    }
    // Best-effort health probe — confirm the daemon is reachable post-load.
    const cfg = loadConfig();
    const port = opts.port ?? cfg.port;
    let healthy = false;
    for (let attempt = 0; attempt < 5 && !healthy; attempt++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            const body = (await res.json()) as { status?: string };
            healthy = res.ok && body.status === 'ok';
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 600));
        }
    }
    // Print the token-bearing launch URL (the Jupyter model) so the operator
    // who just installed the service can open the UI authenticated. The daemon
    // minted <ATLAS_HOME>/mcp.token on load; ensureMcpAuthToken reads that same
    // token. Do NOT log the full token elsewhere.
    const url = buildLaunchUrl(port, home);
    console.error(`[atlas] open the UI (token-authenticated, do not share this URL):`);
    console.error(`[atlas]   ${url}`);
    // Auto-connect installed IDEs (default on) — best-effort, never fails the
    // install: the daemon is already up by this point, so an IDE-config write
    // hiccup (permissions, malformed existing config, etc.) should surface as
    // a warning, not roll back a successful service install.
    let connected = false;
    if (!opts.noConnect) {
        try {
            console.error(`[atlas] connecting detected IDEs to the daemon…`);
            const connectExit = runConnect('all');
            connected = connectExit === 0;
            console.error(`[atlas] IDEs connected — restart/reload them to pick up Atlas.`);
        } catch (err) {
            console.error(`[atlas] warning: IDE auto-connect failed (service install still succeeded): ${(err as Error)?.message ?? String(err)}`);
        }
    }
    console.log(JSON.stringify({ ...r, health: healthy ? 'ok' : 'pending', openUrl: url, connected: opts.noConnect ? 'skipped' : connected }, null, 2));
    return 0;
}

/** `atlas service uninstall`. */
async function cmdServiceUninstall(): Promise<number> {
    const r = uninstallService();
    if (!r.ok) {
        console.error(`atlas: service uninstall failed: ${String(r.error ?? 'unknown error')}`);
        return 1;
    }
    console.log(JSON.stringify(r, null, 2));
    return 0;
}

/** `atlas service status`. */
async function cmdServiceStatus(): Promise<number> {
    const r = serviceStatus();
    if (!r.ok) {
        console.error(`atlas: service status failed: ${String(r.error ?? 'unknown error')}`);
        return 1;
    }
    console.log(JSON.stringify(r, null, 2));
    return 0;
}

// ── Token-via-URL launch (the Jupyter model) ────────────────────────────────
//
// The daemon boots with /mcp auth ON and serves the (public, secret-free) UI
// shell at its own origin. The bearer token reaches the browser OUT-OF-BAND:
// the invoking user's terminal prints a launch URL that carries the token as a
// query param, exactly like `jupyter notebook` prints `?token=…`. A DIFFERENT
// local user can load the shell but can't read the 0600 mcp.token file and never
// sees this terminal, so they can't authenticate. The frontend reads the token
// from the URL on first load and immediately strips it from the address bar
// (history.replaceState), so it isn't left in history/shoulder-surfed.

/** Build the token-bearing launch URL for a given port. Reads (mints if first
 *  boot) the SAME `<ATLAS_HOME>/mcp.token` the daemon enforces on /mcp. */
function buildLaunchUrl(port: number, home?: string): string {
    const token = ensureMcpAuthToken(home);
    return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

/** Best-effort, cross-platform "open this URL in the default browser". Never
 *  throws (a headless box / missing opener must not fail `serve`). */
function openBrowser(url: string): void {
    const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd'
            : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(opener, args, { stdio: 'ignore', detached: true });
        child.on('error', () => { /* opener missing (headless) — ignore */ });
        child.unref();
    } catch { /* spawn threw synchronously — ignore */ }
}

/** `atlas serve [--port N] [--open]` — start the daemon and print the launch URL
 *  WITH the token so the operator can open the UI authenticated. Does NOT log
 *  the full token anywhere else. When --open is set, best-effort-opens the
 *  browser. runDaemon() blocks (it owns the process until SIGTERM), so print +
 *  open BEFORE handing off. */
async function cmdServe(opts: { port?: number; open: boolean }): Promise<number> {
    const cfg = loadConfig();
    const port = opts.port ?? cfg.port;
    // Auth is ON by default; only mint/print a token URL when it's actually
    // enforced. With ATLAS_MCP_AUTH=off (trusted dev) there's no token to carry.
    if (mcpAuthEnabled()) {
        const url = buildLaunchUrl(port, cfg.home);
        console.error(`[atlas] open the UI (token-authenticated, do not share this URL):`);
        console.error(`[atlas]   ${url}`);
        if (opts.open) openBrowser(url);
    } else {
        console.error(`[atlas] auth OFF — open the UI at http://127.0.0.1:${port}/ (no token needed)`);
        if (opts.open) openBrowser(`http://127.0.0.1:${port}/`);
    }
    // Dynamic import — daemon.js transitively loads the native stack; only
    // `serve` (and the daemon itself) needs it.
    const { runDaemon } = await import('./daemon.js');
    await runDaemon(typeof opts.port === 'number' ? { port: opts.port } : {});
    return 0;
}

// ── verbatim memory CLI (WO-3) ──────────────────────────────────────────────

/** Shared tail of the two verbatim CLI commands: unwrap the daemon tool's
 *  MCP text block, surface a structured {error, detail} as a clean CLI
 *  failure (same shape resolveEmbeddedRead handles), else print the result
 *  JSON with the resolved workspace folded in — the tools' own results are
 *  workspace-less, and the config-default resolution would be invisible
 *  without it. */
function reportVerbatimResult(
    res: { content?: Array<{ type?: string; text?: string }> } | null,
    port: number,
    toolName: string,
    workspace: string,
): number {
    if (!res) {
        console.error(`atlas: could not reach the daemon at 127.0.0.1:${port} to run ${toolName}.`);
        console.error('  Start it with `atlas serve` or `atlas service install`.');
        return 1;
    }
    const textBlock = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
    let parsed: Record<string, unknown> = {};
    if (textBlock?.text) {
        try {
            parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
        } catch {
            parsed = { raw: textBlock.text };
        }
    }
    if (typeof parsed['error'] === 'string') {
        console.error(`atlas: ${toolName} failed (daemon): ${String(parsed['detail'] ?? parsed['error'])}`);
        return 7;
    }
    console.log(JSON.stringify({ workspace, ...parsed }));
    return 0;
}

/** `atlas remember "<text>" [--workspace <ws>] [--topic <t>]` — queue a
 *  verbatim memory entry through the daemon's verbatim_store tool. The entry
 *  is append-only and idempotent (id = sha256 of the text); the tool returns
 *  as soon as the entry is QUEUED — the write itself lands via the daemon's
 *  background bulk flush, so {ok, queued} is this command's terminal success.
 *  Workspace resolution matches every other workspace-flagged command
 *  (resolveEmbeddedRead): --workspace override, else the config default. */
async function cmdRemember(text: string | undefined, workspaceOverride?: string, topic?: string): Promise<number> {
    if (!text) {
        console.error('atlas: remember requires a <text> argument (quote multi-word text)\n  Usage: atlas remember "<text>" [--workspace <ws>] [--topic <t>]');
        return 64;
    }
    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const res = await callDaemonTool(port, 'verbatim_store', {
        workspace,
        text,
        source: 'cli:manual',
        ...(topic ? { topic } : {}),
    });
    return reportVerbatimResult(res, port, 'verbatim_store', workspace);
}

/** `atlas verbatim import <files...> [--workspace <ws>] [--topic <t>]` — bulk
 *  import files as verbatim entries through the daemon's verbatim_import tool
 *  (one entry per file, queued like remember). Variadic: every positional
 *  after `import` is a file path. The allowlist gate + read happen
 *  daemon-side; a forbidden path rejects the whole call before anything is
 *  read. */
async function cmdVerbatimImport(files: string[], workspaceOverride?: string, topic?: string): Promise<number> {
    if (files.length === 0) {
        console.error('atlas: verbatim import requires at least one <file> argument\n  Usage: atlas verbatim import <files...> [--workspace <ws>] [--topic <t>]');
        return 64;
    }
    const cfg = loadConfig();
    const workspace = workspaceOverride ?? cfg.lore.workspace;
    const port = cfg.port ?? DEFAULT_PORT;
    const res = await callDaemonTool(port, 'verbatim_import', {
        workspace,
        files,
        ...(topic ? { topic } : {}),
    });
    return reportVerbatimResult(res, port, 'verbatim_import', workspace);
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
    const { command, port, positional, recursive, batchSize, excludes, maxFiles, resume, wait, workspace, topic, minSize, sampleSize, maxDepth, maxSteps, inRepo, dev, open, showToken, connectTarget, noConnect, union, nudge, types, tags, includeSuperseded, json, limit, jsonLines, pm, requestId, pmLabel, pmContent, pmContentFile, approvedBy, approvedAt, area, memoryOnly, mergeDriverOnly, allProjects, global: globalMode } = parseArgs(argv);
    switch (command) {
        case 'serve':
            return cmdServe({ ...(typeof port === 'number' ? { port } : {}), open });
        case 'health':
            return cmdHealth(port);
        case 'init': {
            const targetPath = positional[0];
            if (!targetPath) {
                console.error('atlas init: <path> is required\n  Usage: atlas init <path> [-w <workspace>]');
                return 64;
            }
            const absPath = path.resolve(targetPath);
            const wsName = workspace ?? repoSlug(absPath) ?? path.basename(absPath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const effectivePort = typeof port === 'number' ? port : DEFAULT_PORT;
            console.error(`[atlas] init: indexing '${absPath}' into workspace '${wsName}'`);
            const indexCode = await cmdIndex(absPath, { recursive: false, batchSize: 50, excludes: [], maxFiles: undefined, resume: true, wait: true, workspace: wsName });
            if (indexCode !== 0) return indexCode;
            console.log(`\n✓  Workspace '${wsName}' ready.`);
            // Token-bearing URL (auth is ON by default — the old bare
            // localhost URL opened an unauthenticated session that 401'd,
            // and `localhost` risks IPv6 skew vs the 127.0.0.1 bind).
            console.log(`   Open UI:  ${buildLaunchUrl(effectivePort)}`);
            // --connect <client> was parsed but never consumed (dead flag):
            // honor it so `init . --connect claude-code` is the one-shot
            // setup the flag promises.
            if (connectTarget) {
                const connectCode = await runConnect(connectTarget);
                if (connectCode !== 0) return connectCode;
            } else {
                console.log(`   Tip:      Run 'atlas connect all' first if you haven't yet — or use Settings → IDE Connections in the UI.`);
            }
            console.log(`   Tip:      Run 'atlas hook install ${absPath}' to auto-sync memory on every git commit.`);
            return 0;
        }
        case 'onboard':
            return cmdOnboard(positional[0], { wait, workspace });
        case 'hook': {
            const sub = positional[0];
            const projectDir = positional[1] ?? process.cwd();
            if (sub === 'install') return cmdHookInstall(projectDir, workspace);
            if (sub === 'uninstall') return cmdHookUninstall(projectDir);
            if (sub === 'status') return cmdHookStatus(projectDir);
            console.error(`atlas hook: unknown subcommand '${sub ?? ''}' (expected 'install', 'uninstall', or 'status')`);
            return 64;
        }
        case 'index':
            // `index status` — a subcommand keyword, not a path (see cmdIndexStatus).
            if (positional[0] === 'status') return cmdIndexStatus(workspace);
            return cmdIndex(positional[0], { recursive, batchSize, excludes, maxFiles, resume, wait, workspace });
        case 'mcp-config':
            return printMcpConfig(positional[0], showToken);
        case 'connect':
            return runConnect(positional[0]);
        case 'disconnect':
            return runConnect(positional[0], { disconnect: true });
        case 'memory': {
            const sub = positional[0];
            const target = positional[1];
            if (sub === 'export') return cmdMemoryExport(target, workspace, { union });
            if (sub === 'import') return cmdMemoryImport(target, workspace);
            // W2 — the stateless (no-DB / no-daemon / no-natives) surface.
            if (sub === 'show') return cmdMemoryShow(target, { types, tags, includeSuperseded, json });
            if (sub === 'grep') return cmdMemoryGrep(target, positional[2], { limit, types, tags, includeSuperseded, json });
            if (sub === 'append') return cmdMemoryAppend(target, jsonLines, { pm });
            // W3 — the PM read/write integration surface (still no-DB / no-natives).
            if (sub === 'pm-record') return cmdMemoryPmRecord(target, { requestId, label: pmLabel, content: pmContent, contentFile: pmContentFile, approvedBy, approvedAt, area, tags, json });
            if (sub === 'flag') return cmdMemoryFlag(target, { types, includeSuperseded, json, nudge });
            if (sub === 'install-merge-driver') return cmdMemoryInstallMergeDriver(target);
            console.error(`atlas: unknown memory subcommand '${sub ?? ''}' (expected 'export', 'import', 'show', 'grep', 'append', 'pm-record', 'flag', or 'install-merge-driver')\n`);
            console.error(HELP);
            return 64;
        }
        case 'code-graph': {
            // G-3 — OPT-IN code-graph artifact. SEPARATE command + SEPARATE file
            // from `memory export` so the knowledge moat can never carry code.
            const sub = positional[0];
            const target = positional[1];
            if (sub === 'export') return cmdCodeGraphExport(target, workspace);
            console.error(`atlas: unknown code-graph subcommand '${sub ?? ''}' (expected 'export')\n`);
            console.error(HELP);
            return 64;
        }
        case 'group': {
            const sub = positional[0];
            // positional[0] is the sub; the rest are sub-specific args.
            //   create <name> <p1> <p2> ...  — declare a named group (G-1)
            //   load   <name> | <f1> <f2> …  — co-load by name (provenance) OR
            //                                   raw file paths (G-2 fallback)
            //   list                          — list declared groups (G-1)
            if (sub === 'create') return cmdGroupCreate(positional[1], positional.slice(2), inRepo);
            if (sub === 'load') return cmdGroupLoad(positional.slice(1), workspace);
            if (sub === 'list') return cmdGroupList();
            console.error(`atlas: unknown group subcommand '${sub ?? ''}' (expected 'create', 'load', or 'list')\n`);
            console.error(HELP);
            return 64;
        }
        case 'communities':
            return cmdCommunities(workspace, { minSize, sampleSize });
        case 'processes':
            return cmdProcesses(positional[0], workspace, { maxDepth, maxSteps });
        case 'service': {
            const sub = positional[0];
            if (sub === 'install') return cmdServiceInstall({ port, dev, noConnect });
            if (sub === 'uninstall') return cmdServiceUninstall();
            if (sub === 'status') return cmdServiceStatus();
            console.error(`atlas: unknown service subcommand '${sub ?? ''}' (expected 'install', 'uninstall', or 'status')\n`);
            console.error(HELP);
            return 64;
        }
        case 'wire': {
            // Install the auto-consultation harness (Claude Code hooks + CLAUDE.md
            // + skills) so the agent is consulted THROUGH Atlas before search /
            // edit / commit — not just able to call it.
            const sub = positional[0] ?? 'install';
            const projectDir = positional[1] ?? process.cwd();
            // Auto-wire Part 3 — `wire install --global` merges the Atlas hook
            // into the GLOBAL ~/.claude/settings.json instead of a per-repo
            // one; ignores [path]/--workspace, same as --all-projects does.
            if (sub === 'install' && globalMode) {
                const gr = installGlobalWire();
                if (!gr.ok) { console.error(`atlas: wire install --global failed: ${String(gr['error'] ?? 'unknown error')}`); return 1; }
                console.log(JSON.stringify(gr, null, 2));
                return 0;
            }
            // Part 6 — `wire uninstall --global` is the deliberate anti-GitNexus
            // counterweight to `wire install --global`: ONE command removes
            // everything Atlas's auto-wire put in place, and nothing anywhere
            // re-adds it afterward. Three steps, same enumeration `--all-projects`
            // uses for the middle one:
            //   (a) strip the machine-wide hook from ~/.claude/settings.json;
            //   (b) uninstallWire() every project the registry knows about;
            //   (c) `atlas disconnect all` to remove the IDE MCP entries.
            // A failure in one step still runs the rest (best-effort teardown —
            // an operator uninstalling wants as much removed as possible, not an
            // early abort that leaves the later steps untouched), and the overall
            // `ok` reflects whether every step succeeded.
            if (sub === 'uninstall' && globalMode) {
                const gr = uninstallGlobalWire();
                if (!gr.ok) console.error(`atlas: wire uninstall --global: removing the machine-wide hook failed: ${String(gr['error'] ?? 'unknown error')}`);

                // Lazy import — wireAllProjects statically pulls projectRegistry,
                // which is native-free, but keeping the import lazy here matches
                // the --all-projects install path above and avoids widening this
                // module's static import surface for an uninstall-only helper.
                const { uninstallWireAllProjects } = await import('./cli/wireAllProjects.js');
                const bulk = uninstallWireAllProjects(loadConfig());
                if (!bulk.ok) console.error(`atlas: wire uninstall --global: per-repo removal completed with ${bulk.failed} failure(s)`);

                console.error('# Disconnecting IDE MCP entries (atlas disconnect all)…');
                const disconnectCode = runConnect(undefined, { disconnect: true });
                if (disconnectCode !== 0) console.error('atlas: wire uninstall --global: IDE disconnect completed with failures');

                const result = {
                    ok: gr.ok && bulk.ok && disconnectCode === 0,
                    command: 'wire.uninstall.everything',
                    global: gr,
                    perRepo: bulk,
                    ideDisconnect: { ok: disconnectCode === 0, exitCode: disconnectCode },
                    hint: 'Removed the machine-wide Atlas hook, per-repo wiring in every registered project, and IDE MCP connections. Nothing Atlas writes reinstalls it — a fresh session will not bring any of this back.',
                };
                console.log(JSON.stringify(result, null, 2));
                return result.ok ? 0 : 1;
            }
            // W4-T2 — `wire install --merge-driver-only` is a thin alias for the
            // driver-only participant path (no export/import hooks, no IDE
            // harness); `--memory-only` installs the full git memory sync minus
            // the IDE harness.
            if (sub === 'install' && mergeDriverOnly) {
                const dr = installMergeDriverOnly(projectDir);
                if (!dr.ok) { console.error(`atlas: wire install --merge-driver-only failed: ${dr.error}`); return 1; }
                console.log(JSON.stringify({ ok: true, command: 'wire.install', mode: 'merge-driver-only', repoRoot: dr.repoRoot, mergeDriver: dr.mergeDriver }, null, 2));
                return 0;
            }
            if (sub === 'install' && allProjects) {
                // Dynamic import — wireAllProjects statically pulls
                // mcp/embeddedRegistry → lore/embeddedLore → @groundfloor/lore,
                // which loads the whole native stack (kuzu + lancedb +
                // better-sqlite3) at MODULE LOAD. A static import here put that
                // on EVERY cli.ts command, including `atlas memory show`, breaking
                // the bare-clone no-native contract that tests/memory-no-native.ts
                // pins (regressed in 02a59ef, which added this import). Same lazy
                // treatment cmdIndex and the daemon path already use.
                const { installWireAllProjects } = await import('./cli/wireAllProjects.js');
                const bulk = await installWireAllProjects(loadConfig(), { memoryOnly });
                if (!bulk.ok) {
                    console.error(`atlas: wire install --all-projects completed with ${bulk.failed} failure(s)`);
                }
                console.log(JSON.stringify(bulk, null, 2));
                return bulk.ok ? 0 : 1;
            }
            const r = sub === 'uninstall' ? uninstallWire(projectDir)
                : sub === 'status' ? wireStatus(projectDir)
                : sub === 'install' ? await installWire(projectDir, workspace, { memoryOnly })
                : null;
            if (!r) {
                console.error(`atlas: unknown wire subcommand '${sub}' (expected 'install', 'uninstall', or 'status')\n`);
                console.error(HELP);
                return 64;
            }
            if (!r.ok) { console.error(`atlas: wire ${sub} failed: ${String(r['error'] ?? 'unknown error')}`); return 1; }
            console.log(JSON.stringify(r, null, 2));
            return 0;
        }
        case 'remember':
            return cmdRemember(positional[0], workspace, topic);
        case 'verbatim': {
            const sub = positional[0];
            if (sub === 'import') return cmdVerbatimImport(positional.slice(1), workspace, topic);
            console.error(`atlas: unknown verbatim subcommand '${sub ?? ''}' (expected 'import')\n`);
            console.error(HELP);
            return 64;
        }
        case 'help':
        case '--help':
        case '-h':
            console.log(HELP);
            return 0;
        default:
            console.error(`atlas: unknown command '${command}'\n`);
            console.error(HELP);
            return 64;
    }
}

// Entry-point detection. Node reports import.meta.url as the module's REALPATH,
// but process.argv[1] is the path AS PASSED on the command line — they differ
// whenever the invocation traverses a symlink (/tmp→/private/tmp, a symlinked
// install dir, an npm-global/Homebrew bin shim). A plain string compare then
// falsely reports "not direct" and the CLI silently no-ops (exit 0, nothing
// started). Realpath both sides before comparing.
const isDirectInvocation = (() => {
    const invokedPath = process.argv[1];
    if (invokedPath === undefined) return false;
    try {
        return fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
})();

/** A native-module ABI mismatch produces an opaque "NODE_MODULE_VERSION …"
 *  error. Turn it into an actionable message: the native modules are built for
 *  the daemon's node, so the CLI must run under that same node. */
function explainNativeAbiError(err: unknown): string | undefined {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/NODE_MODULE_VERSION/.test(msg)) return undefined;
    return [
        '[atlas] Native module ABI mismatch — the CLI is running under the wrong Node version.',
        `        This node: ${process.version} (NODE_MODULE_VERSION ${process.versions.modules}).`,
        '        The native modules (kuzu-lite, better-sqlite3, lancedb, onnxruntime) are built',
        '        for the node the daemon runs. Fix by running the CLI under that node:',
        '          • set ATLAS_NODE=/path/to/that/node, or',
        '          • let bin/atlas auto-resolve it from the installed daemon (default), or',
        '          • switch your shell node to match (e.g. nvm use <daemon version>).',
        `        Original error: ${msg}`,
    ].join('\n');
}

if (isDirectInvocation) {
    runCli().then((code) => {
        if (code !== 0) process.exit(code);
    }).catch((err) => {
        const abiHelp = explainNativeAbiError(err);
        console.error(abiHelp ?? `[atlas] cli fatal: ${(err as Error).message}`);
        process.exit(1);
    });
}
