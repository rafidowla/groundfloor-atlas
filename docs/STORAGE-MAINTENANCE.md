# Lore storage maintenance (automatic, in-process)

The Lore vector store (`lore_verbatim.lance`) accumulates an old-version
"history" folder (`_versions`) on every write. Without periodic cleanup it
crept into the **gigabytes** (4.4 GB of history for ~120 MB of real data). The
re-embedding *storm* is fixed in Lore v3.11.0, but the **version churn from a
high write rate** still needs periodic compaction.

## The fix — automatic, in-process compaction (no daemon, no setup)

Atlas embeds Lore **in-process** and maintains storage itself. There is nothing
to install: the Atlas daemon (`src/daemon.ts`) runs a self-contained
compaction/version-cleanup sweep on a timer, calling
`embeddedLore.runMaintenance()` directly (no port, no token, no separate
process).

- **What runs:** Lore's **`maintain`** operation (LanceDB compaction + version
  cleanup), online-safe — it runs while Atlas is up, no stop/restart.
- **How often:** every **20 minutes** (`MAINTENANCE_INTERVAL_MS` in
  `src/daemon.ts`).
- **Version cutoff:** **`15m`**. The tool's *default* cutoff is **7 days**,
  which never reclaims same-day churn — `15m` is safely past the 10-minute
  `lance#3718` grace window so today's old versions become eligible. The daemon
  passes this cutoff to `runMaintenance({ dryRun: false, cutoff: '15m' })`.

Look for this line in the daemon's stderr on startup:

```
[atlas] embedded storage maintenance every 20min (15m version cutoff)
```

**Proven:** one run took the table from **4.4 G → 333 M** (`_versions` 4.2 G →
183 M; 13,390 → 676 manifests). Steady state now oscillates in the
hundreds-of-MB range.

### Run it on demand

The same in-process maintenance is exposed through the embedded adapter
(`src/lore/embeddedLore.ts`), so a one-off compaction does not require touching
the timer. The daemon performs it automatically; manual invocation is only
needed for diagnostics.

## How to know it's healthy (monitoring)

| Check | Healthy | Bloating |
|---|---|---|
| `du -sh …/lore_verbatim.lance/_versions` | hundreds of MB | GBs ❌ |
| `ls …/_versions \| wc -l` | low thousands max | 10,000+ ❌ |
| Lore sweep log `re-embedded=` | **0** | climbing ❌ |
| Daemon stderr `versionsRemoved=` | non-zero each sweep | always 0 (cutoff too long) |

Path: `lore/lore-local-data/.lore/lancedb/lore_verbatim.lance`.

## Notes

- This maintenance now lives **inside Atlas** (a scheduled online compaction
  with a short grace window) so every embedded instance self-maintains. This is
  the embedded-product model — there is no machine-wide local Lore daemon at
  `127.0.0.1:3847`, and no `launchd` job, `scripts/lore-maintain.mjs`, or
  bootstrap-token wiring is involved. Those were the legacy http-mode (`:3847`)
  approach and do **not** apply to the embedded default.
- The deeper driver is **write amplification** (many `store_node` calls, e.g. an
  aggressive auto-store rule). Easing that rate reduces how much there is to
  compact in the first place.
