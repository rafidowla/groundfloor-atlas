#!/usr/bin/env node
/**
 * lore-maintain.mjs — DEPRECATED legacy storage-maintenance cron.
 *
 * ⚠️  QUARANTINED (2026-06-29). This script targets a STANDALONE Lore daemon at
 * http://127.0.0.1:3847/mcp — exactly the machine-wide local daemon that project
 * policy forbids and that the embedded-default product does NOT run. Atlas now
 * embeds Lore in-process and runs the same `maintain` sweep itself on a timer
 * (src/daemon.ts MAINTENANCE_INTERVAL_MS), so this external cron is redundant and
 * misleading. It no longer runs by default: invoking it just prints this notice
 * and exits 0 (so any stale launchd/cron job stops doing work without retry-spam).
 *
 * To run it anyway against a genuinely-separate Lore daemon (legacy http mode):
 *   LORE_MAINTAIN_LEGACY=1 node scripts/lore-maintain.mjs
 *
 *   MAINTAIN_DRY_RUN=1  → report only, change nothing
 *   LORE_MCP_URL        → default http://127.0.0.1:3847/mcp
 *   LORE_AUTH_TOKEN     → override; otherwise a bootstrap token is fetched
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const LORE_URL = process.env.LORE_MCP_URL || 'http://127.0.0.1:3847/mcp';
const DRY = process.env.MAINTAIN_DRY_RUN === '1';

async function getToken() {
  const env = process.env.LORE_AUTH_TOKEN;
  if (env && env.trim()) return env.trim();
  const base = LORE_URL.replace(/\/mcp\/?$/, '');
  const r = await fetch(`${base}/api/auth/bootstrap`);
  const j = await r.json();
  if (!j || !j.token) throw new Error('could not obtain a Lore auth token');
  return j.token;
}

async function main() {
  const token = await getToken();
  const transport = new StreamableHTTPClientTransport(new URL(LORE_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'lore-maintain-cron', version: '1.0.0' });
  await client.connect(transport);
  // maintain scans the graph + LanceDB across workspaces; give it room.
  const CALL_TIMEOUT = Number(process.env.MAINTAIN_TIMEOUT_MS || 600_000);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    if (process.env.MAINTAIN_VERBOSE === '1') console.error(`[lore-maintain] connected; tools=${names.join(',')}`);
    // The tool's default version cutoff is 7 DAYS, which never reclaims
    // same-day churn. Use a short window (default 15m) that is safely past
    // the 10-min lance#3718 grace so today's old versions become eligible.
    const cutoff = process.env.MAINTAIN_VERSION_CUTOFF || '15m';
    const input = { dry_run: DRY, cleanup_versions_older_than: cutoff };
    const opts = { timeout: CALL_TIMEOUT };
    let res;
    if (names.includes('maintain')) {
      res = await client.callTool({ name: 'maintain', arguments: input }, undefined, opts);
    } else if (names.includes('lore_tool_invoke')) {
      // Shim mode: real tools are hidden behind lore_tool_invoke(name, input).
      res = await client.callTool({ name: 'lore_tool_invoke', arguments: { name: 'maintain', input } }, undefined, opts);
    } else {
      throw new Error(`maintain tool not found; advertised tools = ${names.join(', ')}`);
    }
    const text = res?.content?.[0]?.text ?? JSON.stringify(res);
    let summary = String(text).slice(0, 300);
    try {
      const d = JSON.parse(text);
      const r = d.reports?.[0]?.lancedb;
      if (r) {
        const tbl = (r.tables || [])
          .map((t) => `${t.name} ${(t.beforeBytes / 1e9).toFixed(2)}G->${(t.afterBytes / 1e9).toFixed(2)}G (v-${t.versionsRemoved}, frag-${t.fragmentsRemoved})`)
          .join('; ');
        summary = `ok=${d.ok} reclaimed=${(r.totalBytesReclaimed / 1e6).toFixed(0)}MB versionsRemoved=${r.totalVersionsRemoved}${tbl ? ' [' + tbl + ']' : ''}`;
      }
    } catch { /* keep raw slice */ }
    console.log(`[lore-maintain] ${new Date().toISOString()} dry_run=${DRY} cutoff=${cutoff} -> ${summary}`);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

// Quarantine gate (2026-06-29): disabled by default — Atlas runs maintenance
// in-process, and this script targets the forbidden :3847 daemon. Opt in with
// LORE_MAINTAIN_LEGACY=1 to run the legacy http-mode sweep against a separate Lore.
if (process.env.LORE_MAINTAIN_LEGACY !== '1') {
  console.error(
    '[lore-maintain] DEPRECATED & disabled: Atlas embeds Lore in-process and runs maintenance\n' +
    '                itself (src/daemon.ts). This script targets the forbidden :3847 daemon.\n' +
    '                Set LORE_MAINTAIN_LEGACY=1 to force the legacy http-mode run. Exiting 0.',
  );
  process.exit(0);
}

main().catch((e) => { console.error(`[lore-maintain] FAILED: ${e.message}`); process.exit(1); });
