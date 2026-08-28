# PM ↔ Groundfloor Atlas memory contract (Wave 3)

How an external **PM digital employee** (a separate paid product) reads and
writes a repo's git-synced knowledge ledger, `.atlas/memory.jsonl`, without
running Atlas's database. The PM is just another git participant: it pulls,
reads the file, appends one well-shaped entry when a change request is approved,
commits, and pushes. Everything here is **zero-native-deps** — no kuzu / LanceDB
/ sqlite / embedding stack is ever loaded on the PM side (the file is the state;
the DB is a rebuildable index the *developer* side keeps locally).

The contract stands on the Wave 2 stateless surface (`src/memoryFile.ts`,
`src/memoryQuery.ts`) and the Wave 1 union merge-safety layer (the union merge
driver + the pre-commit fold-back). Read those first if you need the mechanics.

For the developer-side story — install, how the ledger works, the truth/index
split, and recovery — see **`docs/memory-git-sync.md`**. The truth/index split it
describes is the guarantee this contract relies on: `.atlas/memory.jsonl` in git
is the source of truth, the databases are disposable rebuildable indexes (proven
by `tests/memory-portability.test.ts`), so the PM's clone needs no database at
all.

---

## 1. The approved-change-request decision entry (W3-T1)

An approved change request is expressed **today** with the existing knowledge
type `decision` — no new `KNOWLEDGE_TYPES` member. That enum is a compatibility
surface shared by every already-shipped parser/importer/MCP tool; extending it
is a separate, header-version-gated decision (plan §6.5). The PM entry fits
inside `decision`.

**Node shape** (built by `buildPmDecision` in `src/pmDecision.ts`):

| Field | Value |
|---|---|
| `kind` | `"node"` |
| `id` | `knowledge:decision:pm-<requestId>` — **deterministic**, via `makeKnowledgeId('decision', 'pm-<requestId>')`. This IS the idempotency key. |
| `type` | `"decision"` |
| `label` | imperative summary of what was approved |
| `content` | what was approved, why, scope, constraints (the text embedded for dev-side semantic recall) |
| `tags` | `pm,change-request[,<area>][,<extra>…]` (fixed tags first, deduped) |
| `metadata` | provenance block, below |
| `supersededAt` | `null` (soft-lifecycle stamp; set only when retired) |

**`metadata` provenance block:**

| Key | Meaning |
|---|---|
| `source` | always `"pm"` — the moat provenance marker the dev-side reader keys off |
| `requestId` | the change-request id the deterministic node id is derived from |
| `approvedBy` | who approved it (human handle or system actor) |
| `approvedAt` | ISO 8601 approval timestamp |
| `status` | `approved` \| `superseded` \| `withdrawn` (default `approved`) |
| `contentHash` | `sha256` over `[requestId, label, content, approvedBy]` — lets the dev side detect a revised approval that reused the same id, and lets `validatePmDecision` catch a tampered/partial entry |
| `revision` | present (and ≥1) **only** on a revised approval that minted a new id via the `-r<n>` suffix; absent on the base entry |

**Determinism:** `buildPmDecision` with a fixed `approvedAt` produces a
byte-identical node. Re-running the PM task for the same request therefore
appends the same id, and `appendMemoryEntries`' ours-wins union **upserts** to
exactly one node rather than duplicating.

**Validation:** `validatePmDecision(entry)` returns `{ ok, errors[] }` (never
throws) and enforces every rule above — including the invariant that the id is
derived from `metadata.requestId` (a mismatch would break upsert) and that
`contentHash` recomputes. The `--pm` flag on `atlas memory append` runs it on
every node entry and rejects the whole call before touching disk.

### Optional edges

A PM decision may point at an existing entry (a decision / architecture id
discovered with `atlas memory grep` before writing):

```
{"kind":"edge","sourceId":"knowledge:decision:pm-<requestId>","targetId":"<existing id>","relation":"relates_to"|"supersedes"}
```

Built by `buildPmDecisionEdge(requestId, targetId, relation)`. A **dangling**
target is legal — the importer defers an edge whose endpoints aren't present yet
(its target may live in a sibling repo) — but callers should lint-warn on one.

### Revisions — supersede, don't silently overwrite

A *revised* approval for the same request has two supported shapes:

- **Overwrite (same id):** re-`pm-record` with the same `requestId` and new
  content → the base id upserts in place. Use when the prior text was simply
  wrong and no history is wanted.
- **Supersede (new id + retire the old):** mint a new id with `revision: n`
  (`knowledge:decision:pm-<requestId>-r<n>`) for the new approval, **and** append
  a `supersedePmDecision()` copy of the prior entry (same id, `supersededAt`
  stamped, `status: "superseded"`). The prior entry stays in the ledger for
  history but drops out of the dev's default `knowledge_recall`
  (`filterNodes` excludes non-null `supersededAt` by default). **This is the
  chosen rule for revisions.**

---

## 2. Two worked JSONL examples

### Example A — a base approval with an edge

```jsonl
{"version":2,"exportedAt":"2026-07-16T14:30:00.000Z","exportedTypes":["decision","convention","bug_pattern","troubleshooting","architecture"]}
{"kind":"node","id":"knowledge:decision:pm-CR-118","type":"decision","label":"Adopt union merge driver for memory.jsonl","content":"Approved CR-118: register a git union merge driver so a conflicting merge of .atlas/memory.jsonl resolves by entry id instead of dropping a side. Scope: sync layer only. Constraint: pure JSONL, zero native deps.","tags":"pm,change-request,sync","metadata":{"source":"pm","requestId":"CR-118","approvedBy":"example@example.com","approvedAt":"2026-07-16T14:30:00.000Z","status":"approved","contentHash":"2fbfe2cd2f276f182b47391cc35147b1aebc445ecc2d47342f0ce1c572247185"},"supersededAt":null}
{"kind":"edge","sourceId":"knowledge:decision:pm-CR-118","targetId":"knowledge:architecture:git-sync-layer","relation":"relates_to"}
```

Produced by:

```sh
atlas memory pm-record .atlas/memory.jsonl \
  --request-id CR-118 \
  --label "Adopt union merge driver for memory.jsonl" \
  --content "Approved CR-118: register a git union merge driver … zero native deps." \
  --approved-by example@example.com --approved-at 2026-07-16T14:30:00.000Z --area sync
# then the optional edge:
echo '{"kind":"edge","sourceId":"knowledge:decision:pm-CR-118","targetId":"knowledge:architecture:git-sync-layer","relation":"relates_to"}' \
  | atlas memory append .atlas/memory.jsonl --json-lines -
```

### Example B — a revised approval (supersede the base, mint `-r1`)

After a base `knowledge:decision:pm-CR-204` already exists, a revised approval
appends **two** lines: the retired base (superseded) and the new revision.

```jsonl
{"kind":"node","id":"knowledge:decision:pm-CR-204","type":"decision","label":"Cap PM push retries at 3","content":"Approved CR-204: the PM push loop retries with pull --rebase at most 3 times, never --force.","tags":"pm,change-request,sync","metadata":{"source":"pm","requestId":"CR-204","approvedBy":"pm-bot","approvedAt":"2026-07-16T09:00:00.000Z","status":"superseded","contentHash":"e7fd73550d98e6f93b2a4da8a8bd37c0d40b7f492b342c924ef320520597bbfe"},"supersededAt":"2026-07-16T16:00:00.000Z"}
{"kind":"node","id":"knowledge:decision:pm-CR-204-r1","type":"decision","label":"Cap PM push retries at 5","content":"Revised CR-204: raise the PM push retry cap from 3 to 5; still never --force.","tags":"pm,change-request,sync","metadata":{"source":"pm","requestId":"CR-204","approvedBy":"pm-bot","approvedAt":"2026-07-16T16:00:00.000Z","status":"approved","contentHash":"12fe050b92ffbfed22b4a99693909d5df948c8cc118134c40b79c703569153a3","revision":1},"supersededAt":null}
```

The dev's default recall now returns only `…pm-CR-204-r1`; the base is retained
for history and surfaces only with `--include-superseded`.

---

## 3. Operating loop (W3-T3)

The normative sequence the PM runs per approved request. Reference
implementation: `scripts/pm-memory-cycle.mjs` (pure node; it shells to git and
to `atlas memory pm-record`, so the schema/append logic lives **once** in the
library). The PM is **stateless** — the git file is the state; never cache
across tasks.

1. **`git pull --rebase`** — the union merge driver (installed via
   `atlas memory install-merge-driver`, W3-T2) resolves any `memory.jsonl`
   conflict by unioning both sides.
   *Recovery:* no upstream yet (first push on a fresh branch) → the step is
   skipped and the cycle continues.
2. **Read fresh** — `atlas memory show --json` / `readMemoryFile()`. The union
   on pull + the append below *is* a fresh read of the file's state.
3. **Reason** — `atlas memory grep` / `keywordSearch` → `toContextBlock` → the
   PM's LLM context. (Out of scope for this contract.)
4. **Write** — `validatePmDecision` → `appendMemoryEntries`, via
   `atlas memory pm-record` (deterministic `knowledge:decision:pm-<requestId>`).
   **Append IS the PM's export** — it has no DB.
   *Recovery:* a validation/IO failure aborts **before** the commit; nothing is
   pushed; the whole cycle is safe to retry (idempotent).
5. **Commit only `.atlas/memory.jsonl`** — `git add .atlas/memory.jsonl &&
   git commit -m "pm: decision <requestId>"`. A byte-identical re-run stages
   nothing → the commit is skipped and the cycle is already at rest.
6. **Push with bounded retry** — on reject → `git pull --rebase` (driver unions)
   → push again, **≤3 attempts**, then surface failure to the PM host.
   **Never `push --force`.**
   *Recovery:* still rejected after 3 attempts (heavy concurrent traffic) → the
   commit sits locally and is retried next cycle; nothing is lost.

### Conflict & idempotency behavior (stated explicitly)

- **Same-request re-run upserts** (deterministic id, ours-wins union) → exactly
  one node; a byte-identical file makes no new commit.
- **A dev editing the same entry concurrently** resolves by the driver's
  ours-wins at whichever side rebases. Note: a `git rebase` **inverts**
  ours/theirs — while replaying a local commit, `ours` (`%A`) is the *upstream*
  tip and `theirs` (`%B`) is the replayed commit — so the **first pusher
  (upstream) is the recorded winner** of a true collision. Entries present on
  only one side are always safe; both-sides-edited is rare at pilot scale
  (plan §6.2).
- **A failed cycle mid-way** leaves at worst an unpushed local commit, retried
  next cycle.

---

## 4. CLI surface (all zero-native-deps)

| Command | Purpose |
|---|---|
| `atlas memory pm-record <file> --request-id <id> --label <l> (--content <c> \| --content-file <path\|->) --approved-by <who> [--approved-at <iso>] [--area <a>] [--tag <t>]… [--json]` | Build + validate + union-append one approved decision. Prints the deterministic id for the commit message. |
| `atlas memory append <file> --json-lines <path\|-> [--pm]` | Union-append raw JSONL entries; `--pm` enforces `validatePmDecision` on every node entry. |
| `atlas memory flag [file] [--type t]… [--include-superseded] [--json]` | **Read-only** developer-side reader (W3-T5): report developer work (non-PM decisions) with no approved PM change request behind it. **Flag, never block — always exits 0.** |
| `atlas memory install-merge-driver [path]` | W3-T2: install ONLY the union merge driver + `.gitattributes` stanza (no export/import hooks) so a **non-Atlas / Lore-less clone** — e.g. the PM's checkout — unions a conflicted `memory.jsonl` on pull instead of dropping a side. Idempotent. Also reachable as `atlas wire install --merge-driver-only` (W4-T2 alias). |

Exit codes: `0` ok, `1` bad file/entries, `2` usage. `--json` output is
machine-stable (the last JSON line is the envelope).

---

## 5. Developer-side flag reader (W3-T5)

`atlas memory flag` / `flagUnbackedWork(view, opts)` is the mirror of the PM
write path: given the ledger, it lists developer decisions that have **no
approved PM change request behind them** — neither PM-authored themselves nor
edge-linked (either direction) to an approved, non-superseded `pm` decision.
This surfaces process gaps to the developer. It is **read-only**, deterministic
(file order then id-sorted), never throws, and **never blocks** — a hook or
script that runs it must keep its exit code unchanged.
