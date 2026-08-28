/**
 * tags.ts — tolerate BOTH tag shapes Lore can hand back.
 *
 * Lore "Tags Pass 3" (groundfloor-lore commit e0432b3) made `LoreNode.tags` a
 * `string[]` on read. Older Lore — and Atlas's own `.jsonl` exports — use a
 * comma-joined string. Every place Atlas READS tags off a node must accept
 * either, or it crashes (`tags.split` on an array throws) or silently drops the
 * tags (`typeof tags === 'string'` guards skip the array). These two helpers are
 * the single normalization point.
 *
 * WRITE paths are unaffected: Atlas writes comma-strings and Lore still accepts
 * them (it normalizes to the array internally), so StoreNodeInput / the tool
 * schemas keep `tags: string`.
 */

/** Normalize a node's tags (array, comma-string, or absent) to a string[]. */
export function tagsToArray(tags: string | string[] | undefined | null): string[] {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
    // Guard non-string truthy values too — several call sites read `n['tags']`
    // off an untyped record, so a stray shape must not throw here.
    if (typeof tags !== 'string') return [];
    return tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
}

/**
 * Normalize a node's tags to the comma-joined string Atlas uses in its `.jsonl`
 * export/import format. Returns `undefined` when there are no tags (so callers
 * keep their "only set the field if present" semantics).
 */
export function tagsToString(tags: string | string[] | undefined | null): string | undefined {
    const arr = tagsToArray(tags);
    return arr.length > 0 ? arr.join(',') : undefined;
}
