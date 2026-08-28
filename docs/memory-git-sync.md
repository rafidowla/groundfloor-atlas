# Team memory over git — quickstart

Groundfloor Atlas gives a team a **shared, versioned knowledge ledger that travels in
git**: decisions, conventions, bug patterns, troubleshooting notes, and
architecture facts, written once and picked up by every teammate (and every
coding agent) on the next pull. No server, no account, no separate database to
run — the ledger is a plain text file, `.atlas/memory.jsonl`, committed
alongside your code.

This doc is the copy-paste-runnable first-run. It assumes the `atlas` (a.k.a.
`groundfloor-atlas`) CLI is installed; see `docs/PACKAGING.md` for install.

---

## 1. Turn it on (one command)

Run this once per repo, at the repo root:

```bash
atlas wire install --memory-only
```

That installs the git-based memory sync and nothing else:

- a **pre-commit** hook that exports your knowledge to `.atlas/memory.jsonl`
  and stages it on every commit;
- **post-merge / post-checkout** hooks that import the ledger back after every
  pull / clone / checkout;
- a **union merge driver** so a conflicting merge of `.atlas/memory.jsonl`
  resolves by combining both sides instead of dropping a teammate's entries.

The workspace name (which knowledge bucket this repo's commits export) is
derived from the repo directory name. Override it if several repos share one
logical workspace:

```bash
atlas wire install --memory-only --workspace my-team-workspace
```

> Want the full agent-consultation harness too (Claude Code hooks + a
> `CLAUDE.md` "consult Groundfloor Atlas first" block + skills)? Drop `--memory-only` and
> run `atlas wire install` — it installs everything above **plus** the IDE
> wiring.

Not a git repo yet? `--memory-only` fails with an actionable message — run
`git init` first, then re-run the command. (Plain `atlas wire install` still
installs the IDE harness in a non-git dir and simply skips the git half.)

### Your first commit creates the ledger

There is nothing to commit by hand. Store a piece of knowledge (via an agent's
`knowledge_store`, or `atlas` while the daemon runs), then commit as usual — the
pre-commit hook writes `.atlas/memory.jsonl` with a correctly-named workspace
and stages it for you. Push, and your teammates get it on their next pull.

---

## 2. How the ledger works

`.atlas/memory.jsonl` is one JSON object per line:

```
line 1        {"version":2,"exportedAt":"…","exportedTypes":[…]}   ← header
lines 2…N     {"kind":"node",…}  or  {"kind":"edge",…}             ← entries
```

- **Nodes** are knowledge entries, one of five types: `decision`, `convention`,
  `bug_pattern`, `troubleshooting`, `architecture`.
- **Edges** connect them (`relates_to`, `supersedes`, …).
- It is **line-stable and diff/merge-friendly** — no binary vectors, so git
  diffs read cleanly and the union merge driver can combine two sides by entry
  identity.

Read or search the ledger directly, with **no daemon and no database** (works in
a bare clone with nothing configured):

```bash
atlas memory show                       # list current knowledge (default .atlas/memory.jsonl)
atlas memory show --type decision       # filter by type
atlas memory show --tag sync --json     # machine-readable, filtered by tag
atlas memory grep "merge driver"        # keyword search, ranked
atlas memory grep "retry" --limit 5 --json
```

Append entries without a database (this is how a non-Atlas participant — e.g. a
PM tool — writes; see `docs/pm-memory-contract.md`):

```bash
echo '{"kind":"node","id":"knowledge:decision:use-union-driver","type":"decision","label":"Use the union merge driver","content":"Resolve memory.jsonl conflicts by union.","tags":"sync"}' \
  | atlas memory append .atlas/memory.jsonl --json-lines -
```

`show`, `grep`, and `append` never load kuzu / LanceDB / sqlite — the file is
all they need (this is enforced by a load-guard test).

---

## 3. The truth / index split (why this is safe)

Two kinds of storage, and only one of them is precious:

| | What it is | Where | Status |
|---|---|---|---|
| **`.atlas/memory.jsonl`** | the knowledge ledger | in git | **source of truth — irreplaceable** |
| kuzu + LanceDB + sqlite | graph, vector, and relational **indexes** over the ledger | each machine's Atlas data dir (gitignored) | **rebuildable cache — disposable** |

The developer side keeps a local embedded database to answer semantic
`recall`/`search` fast, but that database holds **nothing the JSONL doesn't**.
Delete the data dir and it rebuilds from the ledger — proven by the portability
test (`tests/memory-portability.test.ts`), which wipes the entire data dir and
reconstitutes the knowledge layer from `.atlas/memory.jsonl` alone. The vectors
are re-embedded locally on import (text syncs, not vectors).

Fixed constraints for this layer:

- **git is the single source of truth.** The JSONL travels in git; nothing edits
  it "live."
- **The databases are rebuildable indexes.** Never treat them as truth; never
  make the JSONL derivable-only-from-a-DB.
- **Lore Cloud real-time sync is out of scope.** Git stays primary; there are no
  cloud hooks or endpoints in this layer.

---

## 4. Recovery

### Rebuild the local index from the ledger

If your local database is wiped, corrupted, or ABI-broken after an upgrade, just
re-import the ledger:

```bash
atlas memory import .atlas/memory.jsonl --workspace <your-workspace>
```

Nodes are ingested before edges, vectors regenerate locally, and the import is
idempotent (upsert by id) — safe to run any time.

### Restore knowledge deleted with a workspace

Deleting a workspace (`workspace_delete`) first writes a **pre-delete snapshot**
to `<ATLAS_HOME>/knowledge-backups/<workspace>.pre-delete.jsonl`, outside the
wiped data dir. To restore:

```bash
atlas memory import "$ATLAS_HOME/knowledge-backups/<workspace>.pre-delete.jsonl" --workspace <workspace>
```

A continuously-mirrored copy also lives at
`<ATLAS_HOME>/knowledge-backups/<workspace>.jsonl`.

### Deletion caveat (read this before relying on hard delete)

**Soft-supersede is the supported deletion path under git sync**, not hard
delete. `knowledge_supersede` stamps `supersededAt`, which round-trips through
export and drops the entry out of the default `recall`/`show` while keeping it in
history (surface it with `--include-superseded`).

A **hard** `knowledge_delete` is **local-only**: because the union merge driver
and the pre-commit fold-back both preserve any entry still present in the file or
on another clone, a hard-deleted entry is resurrected on the next sync. Tombstone
entries that would make hard delete propagate are future work — until then, use
supersede when you want an entry gone for everyone.

---

## 5. Participants who don't run Atlas

A clone that has no embedded Lore (e.g. an automation or a PM tool that only
reads and appends the ledger) must **not** install the export/import hooks —
there's no database to export from — but it **must** have the union merge driver,
or its `git pull --rebase` regresses to raw text-conflict behavior on
`.atlas/memory.jsonl`. Install just the driver:

```bash
atlas memory install-merge-driver          # or: atlas wire install --merge-driver-only
```

See `docs/pm-memory-contract.md` for the full read → reason → append → commit →
push loop such a participant follows.
