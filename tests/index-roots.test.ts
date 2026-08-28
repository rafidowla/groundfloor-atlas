/**
 * tests/index-roots.test.ts — opt-in scan-path allowlist (audit ATL-004/005/006).
 *
 * Off by default (no roots → everything allowed, zero behavior change). When the
 * operator sets ATLAS_INDEX_ROOTS / config.index.roots, a caller-supplied path
 * handed to a scan/index/git tool must resolve to a descendant of an approved
 * root — and the check must resist traversal, prefix-collision, and symlink
 * escape.
 *
 *   CLAIM A — unset allowlist is permissive (default; no behavior change).
 *   CLAIM B — containment holds; `..` traversal and prefix-collision are rejected.
 *   CLAIM C — a symlink that escapes an approved root is rejected (realpath).
 *   CLAIM D — ATLAS_INDEX_ROOTS env is parsed + enforced.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanPathError, effectiveIndexRoots } from '../src/indexRoots.js';

function tmp(): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-roots-')));
}

async function main(): Promise<void> {
    console.log('Running scan-path allowlist tests…');

    // ── CLAIM A — permissive when unset ───────────────────────────────────────
    {
        assert.equal(scanPathError('/etc/passwd', []), null, 'no roots → permissive');
        assert.equal(scanPathError(os.homedir(), []), null, 'no roots → any path allowed');
        console.log('  ✓ CLAIM A: unset allowlist = permissive (no behavior change)');
    }

    // ── CLAIM B — containment, traversal, prefix-collision ────────────────────
    {
        const base = tmp();
        fs.mkdirSync(path.join(base, 'proj', 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'proj', 'src', 'x.ts'), 'x');
        fs.mkdirSync(path.join(base, 'proj-secret'), { recursive: true }); // prefix-collision trap
        const roots = [path.join(base, 'proj')];

        assert.equal(scanPathError(path.join(base, 'proj', 'src', 'x.ts'), roots), null, 'inside root allowed');
        assert.equal(scanPathError(path.join(base, 'proj'), roots), null, 'the root itself allowed');
        assert.ok(scanPathError(os.homedir(), roots), 'outside rejected');
        assert.ok(scanPathError(path.join(base, 'proj', '..', 'secret'), roots), 'traversal rejected');
        assert.ok(scanPathError(path.join(base, 'proj-secret', 'a'), roots), 'prefix-collision rejected (proj-secret ⊄ proj)');
        console.log('  ✓ CLAIM B: containment holds; traversal + prefix-collision rejected');
    }

    // ── CLAIM C — symlink escape ──────────────────────────────────────────────
    {
        const base = tmp();
        const outside = tmp();
        fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(base, 'proj', 'link.txt'));
        const roots = [path.join(base, 'proj')];

        assert.ok(scanPathError(path.join(base, 'proj', 'link.txt'), roots), 'symlink escaping the root is rejected');
        console.log('  ✓ CLAIM C: symlink that escapes the root is rejected (realpath)');
    }

    // ── CLAIM D — env precedence + parsing ────────────────────────────────────
    {
        const r1 = tmp(), r2 = tmp();
        const saved = process.env['ATLAS_INDEX_ROOTS'];
        process.env['ATLAS_INDEX_ROOTS'] = [r1, r2].join(path.delimiter);
        try {
            const eff = effectiveIndexRoots();
            assert.deepEqual([...eff].sort(), [r1, r2].sort(), 'env ATLAS_INDEX_ROOTS parsed');
            assert.equal(scanPathError(path.join(r2, 'a', 'b')), null, 'path under an env root allowed');
            assert.ok(scanPathError(os.homedir()), 'path outside the env roots rejected');
        } finally {
            if (saved === undefined) delete process.env['ATLAS_INDEX_ROOTS'];
            else process.env['ATLAS_INDEX_ROOTS'] = saved;
        }
        console.log('  ✓ CLAIM D: ATLAS_INDEX_ROOTS env parsed + enforced');
    }

    // ── CLAIM E — symlink escape via NON-EXISTENT leaf (audit bypass regression) ─
    {
        const base = tmp();
        const outside = tmp();
        fs.mkdirSync(path.join(base, 'proj', 'real'), { recursive: true });
        fs.symlinkSync(outside, path.join(base, 'proj', 'out')); // dir symlink → outside the root
        const roots = [path.join(base, 'proj')];
        // The leaf doesn't exist yet — the OLD code fell back to a textual resolve
        // and WRONGLY ALLOWED this (it points through `out` to outside the root).
        assert.ok(
            scanPathError(path.join(base, 'proj', 'out', 'late.conf'), roots),
            'symlink-to-outside + non-existent leaf must be rejected (deepest-existing-ancestor realpath)',
        );
        // Sanity: a non-existent leaf under a REAL in-root dir stays allowed.
        assert.equal(
            scanPathError(path.join(base, 'proj', 'real', 'new.ts'), roots), null,
            'non-existent leaf under a real in-root dir stays allowed',
        );
        console.log('  ✓ CLAIM E: symlink escape via non-existent leaf rejected; in-root non-existent allowed');
    }

    // ── CLAIM F — '..' refused while an allowlist is active (symlink+.. mismatch) ─
    {
        const base = tmp();
        fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
        const roots = [path.join(base, 'proj')];
        // Raw literal '..' (NOT path.join, which would pre-collapse it) — this is
        // the verbatim-absolute case the gated sinks pass through unchanged.
        assert.ok(scanPathError(`${path.join(base, 'proj')}/sub/../x`, roots), "raw '..' rejected under an active allowlist");
        assert.ok(scanPathError('/allowed/link/../etc/x', roots), 'absolute path with .. rejected');
        // Permissive default (no roots) is unaffected — '..' allowed when off.
        assert.equal(scanPathError('/whatever/../x', []), null, "'..' allowed when the allowlist is OFF");
        console.log("  ✓ CLAIM F: '..' refused under active allowlist; permissive default unaffected");
    }

    console.log('All scan-path allowlist tests passed.');
}

await main();
