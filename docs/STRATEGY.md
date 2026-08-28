# Groundfloor Atlas strategy decisions (2026-06-21)

Complements `ROADMAP.md` (the task board) and `PERFORMANCE.md` (the speed plan).
Driven by a competitive review of a mature code-graph peer tool.

## The call

That peer leads on pure code-graph depth (PDG/taint, communities, processes, cross-repo,
rich graph UI). Groundfloor Atlas will **not** try to out-graph it. Instead: **wedge + selective
parity + git-synced shared memory.**

Groundfloor Atlas's defensible position = what pure code-graph tools structurally lack:
1. **Institutional memory** — decisions, conventions, bug-patterns, the *why* (Lore).
2. **Governance lenses** — schema drift, layer violations, hotspots.
3. **Git-synced team memory (the moat)** — memory travels with the repo. A new dev/machine
   clones, connects Groundfloor Atlas, and is instantly up to speed. The peer cannot do this (per-machine
   index, discarded). Compounds per *team*; viral. *(Already on ROADMAP.md as "developer-to-
   developer sync" — now elevated to a headline differentiator.)*

Plus **selective parity** on the two graph gaps agents most need: Communities + Processes.

## Git-synced memory — design decision (the critical fork)

Lore stores everything as **binary** (`graph` ~9 MB, `lancedb/`, `aux.sqlite`). Do **not**
commit those (bloat, un-diffable, merge hell). Instead, split by replaceability:

- **Code graph → NOT synced; regenerated locally on clone** (derivable from source — and the
  reason Speed/Option A is the prerequisite).
- **Memory/knowledge → synced as TEXT** (e.g. `.atlas/memory.jsonl`): export nodes+edges,
  commit like code, import + **re-embed locally** on connect (vectors regenerate from text).

Mostly **Groundfloor Atlas-side** — Lore already exposes `listNodes` (read all) + `nodeUpsert` (write),
so export/import needs little/no Lore change. Small, diffable, mergeable (append-style),
conflict-tolerant via Lore's supersede model.

## IN / OUT

**IN:** Speed (Option A, foundation) · Git-synced memory (moat) · Memory depth (code↔why) ·
Communities · Processes · Governance lenses (keep).

**OUT (for now):** PDG/CFG/taint · cross-repo groups/contracts · rich Sigma graph web UI ·
wiki generation · rename refactor · more languages (already at 14). GPU/Metal deferred.

## Sequencing

1. **Speed (Option A)** — `PERFORMANCE.md` order: pre-warm + lean cards → incremental-by-
   default + skip tests → Lore batch-embed ask (3-5×). Foundation + enables regenerate-on-clone.
2. **Git-synced memory MVP** — export/import knowledge as text; regenerate graph on connect.
3. **Communities**, then **Processes**.
4. **Memory depth** — ongoing throughout.
