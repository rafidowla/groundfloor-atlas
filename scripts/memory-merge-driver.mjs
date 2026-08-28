#!/usr/bin/env node
/**
 * memory-merge-driver.mjs — git merge driver for `.atlas/memory.jsonl`.
 *
 * WHY: the team knowledge mirror is an append-mostly JSONL export. A plain
 * text merge conflicts whenever two clones added different nodes, and the
 * conflict was silently mis-resolved by the sync hooks (the post-merge import
 * never ran because the merge didn't complete, then the pre-commit export
 * overwrote the resolved file with only the local DB's contents — dropping
 * every remote-only entry). This driver resolves the conflict CORRECTLY at
 * merge time by UNIONing both sides by entry identity, so nothing is lost and
 * there is no conflict left for the hooks to mishandle.
 *
 * Pure JSONL/JSON only — deliberately no Kuzu/LanceDB/native imports — so it
 * runs even when the CLI's native modules are ABI-mismatched.
 *
 * git invokes:  node memory-merge-driver.mjs %O %A %B
 *   %O = common-ancestor version (unused; a union needs only both sides)
 *   %A = OURS / current — the driver MUST leave the merged result here
 *   %B = THEIRS / incoming
 * Exit 0 = merged cleanly (result written to %A). Non-zero = leave conflict.
 *
 * Identity: header line (has `version`+`exportedTypes`, no `kind`) → keep the
 * one with the newer exportedAt. node → `id`. edge → `sourceId|targetId|relation`.
 * On a same-key collision OURS wins (the branch being merged into); this only
 * affects entries edited on BOTH sides — an entry present on one side only is
 * ALWAYS preserved, which is the property the old flow violated.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Parse JSONL text into {header, entries:Map<key,{line,obj}>} preserving order. */
function parse(text) {
  let header = null;
  const entries = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // tolerate junk/partial
    if (obj && obj.kind === undefined && (obj.version !== undefined || obj.exportedTypes !== undefined)) {
      header = { line, obj };
      continue;
    }
    const key = keyOf(obj);
    if (key) entries.set(key, { line, obj });
  }
  return { header, entries };
}

function keyOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.kind === 'edge') return `edge\0${obj.sourceId}\0${obj.targetId}\0${obj.relation}`;
  if (obj.id !== undefined) return `node\0${obj.id}`;
  return null;
}

/** Pick the header with the newer exportedAt (ours on tie / parse failure). */
function pickHeader(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.obj?.exportedAt ?? '') || 0;
  const tb = Date.parse(b.obj?.exportedAt ?? '') || 0;
  return tb > ta ? b : a;
}

/**
 * Union two JSONL exports. `ours` wins on a same-key collision. Entries present
 * on only one side are always kept. Returns the merged JSONL text (no trailing
 * newline duplication).
 * @param {string} oursText
 * @param {string} theirsText
 */
export function unionMemoryJsonl(oursText, theirsText) {
  const ours = parse(oursText);
  const theirs = parse(theirsText);

  // theirs first so ours overrides on collision; preserves theirs-only entries.
  const merged = new Map();
  for (const [k, v] of theirs.entries) merged.set(k, v);
  for (const [k, v] of ours.entries) merged.set(k, v);

  const header = pickHeader(ours.header, theirs.header);
  const lines = [];
  if (header) lines.push(header.line);
  for (const { line } of merged.values()) lines.push(line);
  return lines.join('\n') + '\n';
}

// ── CLI entry (skipped when imported by a test) ─────────────────────────────
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const [, , , oursPath, theirsPath] = process.argv; // %O %A %B → argv[2..4]
  if (!oursPath || !theirsPath) {
    console.error('usage: memory-merge-driver.mjs <ancestor> <ours> <theirs>');
    process.exit(2);
  }
  try {
    const merged = unionMemoryJsonl(readFileSync(oursPath, 'utf8'), readFileSync(theirsPath, 'utf8'));
    writeFileSync(oursPath, merged); // git takes the result from the OURS path
    process.exit(0);
  } catch (err) {
    console.error(`[memory-merge-driver] ${err?.message ?? err}`);
    process.exit(1); // leave the conflict rather than risk a bad write
  }
}
