/**
 * tests/checkpoint.test.ts — index checkpoint workspace guard.
 *
 * The checkpoint at `<root>/.atlas/index-state.json` fingerprints files so
 * `--resume` can skip unchanged ones. It's keyed by filesystem ROOT, but the
 * same root can be indexed into different Lore workspaces — and a workspace's
 * data can be wiped out-of-band (Lore's Pass-3 "reset and re-ingest" recovery).
 * Honoring a stale checkpoint then skips files that aren't in the target
 * workspace, leaving a BROKEN partial graph (dangling folder `contains` edges).
 *
 *   CLAIM A — a checkpoint stamped for workspace W1 is INVALIDATED (fresh) when
 *             loaded for a different workspace W2; the SAME workspace round-trips
 *             its fingerprints, and the fresh one is re-stamped for W2.
 *   CLAIM B — a pre-existing checkpoint with NO workspace stamp is honored
 *             (back-compat — absent stamp = "any workspace").
 *   CLAIM C — checkpointWorkspace() reads the stamp RAW (no invalidation), so
 *             `atlas index` can default to the root's own recorded workspace
 *             instead of the machine-global config one (the misfiling trap);
 *             null when the checkpoint or its stamp is absent.
 *
 * The empty-workspace guard (resume against wiped data → drop the checkpoint)
 * lives in cli.ts (it needs a live embedded Lore) and is covered by the
 * reset-then-resume reproduction, not this pure unit test.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCheckpoint, saveCheckpoint, markIndexed, checkpointWorkspace } from '../src/cli/checkpoint.js';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ckpt-'));
}

async function main(): Promise<void> {
    console.log('Running index checkpoint workspace-guard tests…');

    // ── CLAIM A — workspace mismatch invalidates; same workspace round-trips ───
    {
        const root = tmpRoot();
        const f = path.join(root, 'a.ts');
        fs.writeFileSync(f, 'export const a = 1;');

        const cp = loadCheckpoint(root, 'ws1');
        cp.workspace = 'ws1';
        markIndexed(f, cp);
        saveCheckpoint(cp);
        assert.equal(Object.keys(cp.files).length, 1, 'precondition: a.ts fingerprinted');

        const same = loadCheckpoint(root, 'ws1');
        assert.equal(Object.keys(same.files).length, 1, 'same workspace keeps fingerprints');
        assert.equal(same.workspace, 'ws1', 'workspace stamp persisted');

        const other = loadCheckpoint(root, 'ws2');
        assert.equal(Object.keys(other.files).length, 0, 'different workspace invalidates fingerprints');
        assert.equal(other.workspace, 'ws2', 'fresh checkpoint re-stamped for the new workspace');
        console.log('  ✓ CLAIM A: invalidated on workspace switch; honored on same workspace');
    }

    // ── CLAIM B — legacy (unstamped) checkpoint is honored (back-compat) ───────
    {
        const root = tmpRoot();
        const f = path.join(root, 'b.ts');
        fs.writeFileSync(f, 'export const b = 2;');
        const st = fs.statSync(f);
        const dir = path.join(root, '.atlas');
        fs.mkdirSync(dir, { recursive: true });
        const legacy = {
            version: 1,
            root: path.resolve(root),
            files: { 'b.ts': { mtimeMs: st.mtimeMs, sizeBytes: st.size, indexedAt: 'x' } },
            updatedAt: 'x',
        };
        fs.writeFileSync(path.join(dir, 'index-state.json'), JSON.stringify(legacy));

        const cp = loadCheckpoint(root, 'anyws');
        assert.equal(Object.keys(cp.files).length, 1, 'legacy unstamped checkpoint honored (absent stamp = any)');
        assert.equal(checkpointWorkspace(root), null, 'unstamped checkpoint → no workspace to default to');
        console.log('  ✓ CLAIM B: legacy unstamped checkpoint honored (back-compat)');
    }

    // ── CLAIM C — raw workspace-stamp read for the `atlas index` default ───────
    {
        const root = tmpRoot();
        assert.equal(checkpointWorkspace(root), null, 'no checkpoint at all → null');

        const f = path.join(root, 'c.ts');
        fs.writeFileSync(f, 'export const c = 3;');
        const cp = loadCheckpoint(root, 'proj-ws');
        cp.workspace = 'proj-ws';
        markIndexed(f, cp);
        saveCheckpoint(cp);

        assert.equal(checkpointWorkspace(root), 'proj-ws', 'stamp read back raw');
        // The whole point: reading the stamp for a DIFFERENT-workspace caller
        // must NOT invalidate it the way loadCheckpoint(root, other) would —
        // it answers "what is this root's own workspace?", not "may I reuse
        // these fingerprints?".
        assert.equal(checkpointWorkspace(root), 'proj-ws', 'repeat read is stable (no side effects)');
        console.log('  ✓ CLAIM C: checkpointWorkspace raw stamp read (misfiling-trap default)');
    }

    console.log('All index checkpoint workspace-guard tests passed.');
}

await main();
