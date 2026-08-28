/**
 * tests/tags.test.ts — Lore "Tags Pass 3" compatibility (groundfloor-lore e0432b3).
 *
 * Lore now returns `LoreNode.tags` as a string[] on read; older Lore + Atlas's
 * own .jsonl exports use a comma-joined string. tagsToArray / tagsToString are
 * the single normalization point that lets every READ site accept either shape.
 *
 *   CLAIM A — tagsToArray accepts BOTH a comma-string and a string[] (and the
 *             stray/empty shapes), so hasAtlasTag's `.includes('atlas')` works
 *             on a Pass-3 array — the exact case that used to throw
 *             `tags.split is not a function`.
 *   CLAIM B — tagsToString round-trips either shape back to the comma-string
 *             export format, and returns undefined when empty (so the .jsonl
 *             "only set the field if present" semantics are preserved — no
 *             silent drop of array tags).
 *   CLAIM C — the ORIGINAL bug is real: calling .split on an array throws. This
 *             locks in WHY the helper exists.
 */
import * as assert from 'node:assert/strict';
import { tagsToArray, tagsToString } from '../src/tags.js';

const ATLAS_TAG = 'atlas';

async function main(): Promise<void> {
    console.log('Running Lore Tags Pass 3 compatibility tests…');

    // ── CLAIM A — tagsToArray normalizes every shape ──────────────────────────
    {
        // Pass-3 array (the shape that broke hasAtlasTag).
        assert.deepEqual(tagsToArray(['atlas', 'code-file']), ['atlas', 'code-file']);
        // Legacy comma-string.
        assert.deepEqual(tagsToArray('atlas,code-file'), ['atlas', 'code-file']);
        // Whitespace + empties are trimmed/dropped, both shapes.
        assert.deepEqual(tagsToArray(' atlas , , code-file '), ['atlas', 'code-file']);
        assert.deepEqual(tagsToArray([' atlas ', '', 'code-file']), ['atlas', 'code-file']);
        // Absent / empty.
        assert.deepEqual(tagsToArray(undefined), []);
        assert.deepEqual(tagsToArray(null), []);
        assert.deepEqual(tagsToArray(''), []);
        assert.deepEqual(tagsToArray([]), []);
        // Stray non-string/array (call sites read `n['tags']` off an untyped
        // record) must not throw — return [].
        assert.deepEqual(tagsToArray(42 as unknown as string), []);

        // hasAtlasTag's exact logic now works on a Pass-3 array.
        assert.equal(tagsToArray(['atlas', 'x']).includes(ATLAS_TAG), true);
        assert.equal(tagsToArray('atlas,x').includes(ATLAS_TAG), true);
        assert.equal(tagsToArray(['code-file']).includes(ATLAS_TAG), false);
        console.log('  ✓ CLAIM A: tagsToArray accepts string[] AND comma-string; hasAtlasTag logic works on both');
    }

    // ── CLAIM B — tagsToString preserves the comma-string export format ────────
    {
        assert.equal(tagsToString(['atlas', 'code-file']), 'atlas,code-file');
        assert.equal(tagsToString('atlas,code-file'), 'atlas,code-file');
        assert.equal(tagsToString([' atlas ', 'code-file']), 'atlas,code-file');
        // No tags ⇒ undefined, so `if (tagStr) line.tags = tagStr` skips cleanly
        // instead of writing an empty string (preserves the old semantics).
        assert.equal(tagsToString(undefined), undefined);
        assert.equal(tagsToString(''), undefined);
        assert.equal(tagsToString([]), undefined);
        console.log('  ✓ CLAIM B: tagsToString round-trips both shapes to comma-string; undefined when empty (no silent drop)');
    }

    // ── CLAIM C — the original crash is real (locks in the regression) ─────────
    {
        const arrayTags: unknown = ['atlas', 'code-file'];
        assert.throws(
            () => (arrayTags as string).split(','),
            /split is not a function/,
            'an array has no .split — this is exactly what crashed hasAtlasTag before the fix',
        );
        console.log('  ✓ CLAIM C: .split on a Pass-3 array throws — the bug the helper fixes');
    }

    console.log('All Lore Tags Pass 3 compatibility tests passed.');
}

await main();
