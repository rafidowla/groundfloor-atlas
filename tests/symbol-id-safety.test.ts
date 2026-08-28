/**
 * tests/symbol-id-safety.test.ts — regression for the "code-symbol IDs outside
 * Lore's safe alphabet" bug (Atlas emits `{ where, params }` etc. into symbol
 * ids; Lore's assertSafeLanceId rejects the braces/brackets/commas, dropping the
 * node AND every edge that points at it — silent gaps in blast-radius/call-graph).
 *
 *   CLAIM A (fix a — backstop) — buildSymbolId / slugSymbolName force EVERY id
 *            inside Lore's SAFE_ID_RE, whatever the qualifiedName carries
 *            (destructuring, generics, computed keys), and are a NO-OP for normal
 *            names (so existing ids don't churn / edges stay consistent).
 *   CLAIM B (fix b — clean names) — the TS walker turns a destructuring binding
 *            into a readable name from the bound identifiers (`where_params`,
 *            `first_second`), not the raw pattern text.
 *   CLAIM C (end-to-end) — parsing a fixture with object AND array destructuring
 *            yields symbols whose ids ALL match SAFE_ID_RE (the exact thing Lore
 *            validates on write).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSymbolId, slugSymbolName } from '../src/parser/walkers/_base.js';
import { codeImportId, _CODE_IMPORT_PREFIX } from '../src/store/codeNodes.js';
import { parseFile } from '../src/parser/index.js';

// Mirror of Lore's assertSafeLanceId control (verbatimHistory.ts SAFE_ID_RE).
const SAFE_ID_RE = /^[A-Za-z0-9 :.\-_/@]+$/;

async function main(): Promise<void> {
    console.log('Running symbol-id safe-alphabet regression tests…');

    // ── CLAIM A — buildSymbolId / slugSymbolName always produce safe ids ──────
    {
        const unsafe = [
            '{ where, params }',      // object destructure
            '[nodeCount, edgeCount]', // array destructure
            'Foo<T>',                 // generic
            '[Symbol.iterator]',      // computed key
        ];
        for (const q of unsafe) {
            const id = buildSymbolId('src/x.ts', q, 'function');
            assert.ok(SAFE_ID_RE.test(id), `id must be safe for ${JSON.stringify(q)}: got ${id}`);
            assert.ok(!/[{}[\],<>]/.test(id), `id must not contain bracket/brace/comma/angle: ${id}`);
        }
        assert.equal(slugSymbolName('{ where, params }'), 'where_params');
        assert.equal(slugSymbolName('[nodeCount, edgeCount]'), 'nodeCount_edgeCount');

        // NO-OP for normal names → existing ids don't change (no re-index churn).
        assert.equal(slugSymbolName('foo'), 'foo');
        assert.equal(slugSymbolName('Foo.bar'), 'Foo.bar');
        assert.equal(
            buildSymbolId('src/a/b.ts', 'Klass.method', 'method'),
            'src/a/b.ts:Klass.method:method',
        );
    }

    // ── CLAIM B & C — parse a fixture with both destructuring forms ───────────
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-idtest-'));
        const file = path.join(dir, 'fixture.ts');
        fs.writeFileSync(
            file,
            [
                'export const { where, params } = buildQuery();',
                'export const [first, second] = makePair();',
                'function normalFn() { return 1; }',
                '',
            ].join('\n'),
        );
        try {
            const parsed = await parseFile(file, dir);
            assert.ok(parsed, 'parseFile returned a ParsedFile');
            const symbols = parsed!.symbols;
            assert.ok(symbols.length >= 3, `expected ≥3 symbols, got ${symbols.length}`);

            // CLAIM C — every id is safe (the exact Lore write constraint).
            for (const s of symbols) {
                assert.ok(SAFE_ID_RE.test(s.id), `symbol id outside safe alphabet: ${s.id}`);
            }

            // CLAIM B — destructuring produced readable, joined names.
            const names = new Set(symbols.map((s) => s.name));
            assert.ok(names.has('where_params'), `expected 'where_params' name, got: ${[...names].join(', ')}`);
            assert.ok(names.has('first_second'), `expected 'first_second' name, got: ${[...names].join(', ')}`);
            assert.ok(names.has('normalFn'), 'normal function name preserved');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── CLAIM D — codeImportId keeps import-node ids inside the safe alphabet ──
    // Same bug class as symbol ids, different code path: Rust/Python GROUPED
    // imports (`use std::io::{Read, Write}`) and generics carry `{ } , < >`,
    // which Lore rejects → the import node AND its file→import edges vanish.
    {
        // Grouped / generic specifiers slug to a safe id (no brace/comma/angle).
        for (const mod of ['std::io::{Read, Write}', 'std::process::{Child, Command}', 'Foo<Bar>']) {
            const id = codeImportId(mod);
            assert.ok(SAFE_ID_RE.test(id), `import id must be safe for ${JSON.stringify(mod)}: got ${id}`);
            assert.ok(!/[{}[\],<>]/.test(id), `import id must not contain brace/bracket/comma/angle: ${id}`);
            assert.ok(!/_$/.test(id), `trailing '}' must not leave a dangling underscore: ${id}`);
        }
        assert.equal(codeImportId('std::io::{Read, Write}'), 'code-import:std::io::_Read_Write');

        // NO-OP for already-safe specifiers → existing import identities (and the
        // cross-repo dedup keyed on them) don't churn.
        for (const mod of ['react', '@scope/pkg', 'lodash-es', './foo', '../bar/baz', 'std::io']) {
            assert.equal(codeImportId(mod), _CODE_IMPORT_PREFIX + mod, `import id must be byte-identical for ${mod}`);
        }

        // The exported prefix constant is the bare prefix — NOT what codeImportId('')
        // returns now (which slugs to '…:_'). memorySync relies on this for startsWith.
        assert.equal(_CODE_IMPORT_PREFIX, 'code-import:');
        assert.ok('code-import:react'.startsWith(_CODE_IMPORT_PREFIX), 'prefix must match normal import ids');
    }

    console.log('✓ symbol-id safe-alphabet tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
