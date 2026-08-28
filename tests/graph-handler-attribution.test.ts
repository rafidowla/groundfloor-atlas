/**
 * tests/graph-handler-attribution.test.ts — regression tests for the
 * call-graph handler-attribution + callee-resolution fixes.
 *
 * Shape follows tests/audit-medium.test.ts: node:assert/strict, async
 * main(), '  ✓ CLAIM …' lines, ends `await main()`.
 *
 * BUGS COVERED (found via the claims benchmark against this repo):
 *   H1. Calls inside anonymous object-property handlers
 *       (`registry.register({ name: 't', handler: async (args) => { …f()… } })`)
 *       were attributed to the enclosing NAMED function (buildRegistry), so
 *       upstream queries collapsed every handler's calls onto the builder.
 *       Fixed by the TS walker's extractObjectHandlerSymbols pass.
 *   R1. `EmbeddedLore.open(x)` calls mis-resolved to an unrelated same-file
 *       local named `open` (cli.ts's `let open` inside parseArgs) because the
 *       same-file match ignored the receiver hint and accepted ANY symbol
 *       kind (variables included). Fixed by receiver-qualified matching
 *       (step 0) + callable-kind filtering (step 1).
 *   R2. Bare cross-file name fallback matched a free `open()` call (a Tauri
 *       dialog function from a dynamic import in atlas-ui) to the scoped
 *       method `EmbeddedLore.open` — a cross-file false edge. Fixed by
 *       restricting the bare-name fallback to callable, module-level
 *       (unqualified) symbols.
 *   D1. The new handler symbols must not flood atlas_find_dead_code —
 *       function-scoped nested callables are data-reachable through their
 *       parent (registered/passed by reference); exempt them.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedFile, ParsedRelation } from '../src/parser/types.js';
import { parseFile } from '../src/parser/index.js';
import { buildSymbolTable } from '../src/resolver/symbolTable.js';
import { buildResolutionContext } from '../src/resolver/importGraph.js';
import { buildCallEdges } from '../src/resolver/callGraph.js';
import { deadCode } from '../src/analytics/deadCode.js';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Parse every file currently in `dir` and resolve call edges over the set. */
async function parseDir(dir: string): Promise<{ files: ParsedFile[]; edges: ParsedRelation[] }> {
    const files: ParsedFile[] = [];
    for (const f of fs.readdirSync(dir)) {
        const parsed = await parseFile(path.join(dir, f), dir);
        if (parsed) files.push(parsed);
    }
    const table = buildSymbolTable(files);
    const ctx = await buildResolutionContext(dir, files);
    return { files, edges: buildCallEdges(files, table, ctx).edges };
}

async function writeAndParse(dir: string, name: string, source: string): Promise<ParsedFile | null> {
    fs.writeFileSync(path.join(dir, name), source);
    return parseFile(path.join(dir, name), dir);
}

// ── H1 — object-property handler calls attributed to the handler, not the builder ──
async function testHandlerAttribution(cleanup: string[]): Promise<void> {
    console.log('\n[H1] handler-map calls collapse onto the enclosing named function');
    const dir = mkTmp('atlas-h1-');
    cleanup.push(dir);

    const pf = await writeAndParse(dir, 'allTools.ts', [
        'import { resolveCodeReader } from "./factory.js";',
        'export function buildRegistry(): void {',
        '    registry.register({',
        "        name: 'atlas_call_graph',",
        '        handler: async (args) => resolveCodeReader(),',
        '    });',
        '    registry.register({',
        "        name: 'atlas_find_dead_code',",
        '        handler: async (args) => resolveCodeReader(),',
        '    });',
        '}',
        '',
    ].join('\n'));
    assert.ok(pf, 'TS parsed');

    // H1a: each handler is its own symbol, named after the descriptor's
    // `name` sibling, qualified by the enclosing function.
    const handlers = pf.symbols.filter((s) => s.qualifiedName.startsWith('buildRegistry.'));
    assert.equal(handlers.length, 2, `expected 2 handler symbols, got ${handlers.length}`);
    assert.ok(handlers.some((s) => s.qualifiedName === 'buildRegistry.atlas_call_graph'),
        'handler named after its name sibling');
    assert.ok(handlers.some((s) => s.qualifiedName === 'buildRegistry.atlas_find_dead_code'),
        'second handler named after its name sibling');

    // H1b: calls inside a handler body are attributed to the handler symbol.
    const handlerIds = new Set(handlers.map((s) => s.id));
    const handlerCalls = pf.calls.filter((c) => handlerIds.has(c.callerSymbolId));
    assert.equal(handlerCalls.length, 2,
        `both resolveCodeReader() calls owned by their handlers (got ${handlerCalls.length})`);
    const builderId = pf.symbols.find((s) => s.qualifiedName === 'buildRegistry')!.id;
    const swallowed = pf.calls.filter((c) => c.callerSymbolId === builderId && c.calleeName === 'resolveCodeReader');
    assert.equal(swallowed.length, 0,
        `no resolveCodeReader() call left on the enclosing buildRegistry (got ${swallowed.length})`);
    console.log('  ✓ CLAIM H1: handler bodies own their calls; builder no longer swallows them');
}

// ── H1-fallback — no-name-sibling descriptors fall back to the property key ──
async function testHandlerKeyFallback(cleanup: string[]): Promise<void> {
    console.log('\n[H1-fallback] handler without a name sibling uses the property key');
    const dir = mkTmp('atlas-h1fb-');
    cleanup.push(dir);

    const pf = await writeAndParse(dir, 'props.ts', [
        'export function MyComponent(): void {',
        '    const props = {',
        '        onClick: () => save(),',
        '    };',
        '    return props;',
        '}',
        'function save(): void {}',
        '',
    ].join('\n'));
    assert.ok(pf, 'TS parsed');
    const onClick = pf.symbols.find((s) => s.qualifiedName === 'MyComponent.onClick');
    assert.ok(onClick, 'property-key fallback symbol MyComponent.onClick exists');
    const saveCall = pf.calls.find((c) => c.calleeName === 'save');
    assert.ok(saveCall, 'save() call extracted');
    assert.equal(saveCall!.callerSymbolId, onClick!.id, 'save() owned by MyComponent.onClick');
    console.log('  ✓ CLAIM H1-fallback: key-named handler symbol owns its body calls');
}

// ── R1 — receiver-qualified match beats same-file variable collisions ──
async function testReceiverQualifiedResolution(cleanup: string[]): Promise<void> {
    console.log('\n[R1] EmbeddedLore.open(x) mis-resolves to a same-file local `open`');
    const dir = mkTmp('atlas-r1-');
    cleanup.push(dir);

    await writeAndParse(dir, 'embeddedLore.ts', [
        'export class EmbeddedLore {',
        '    static async open(dir: string): Promise<EmbeddedLore> { return new EmbeddedLore(); }',
        '}',
        '',
    ].join('\n'));
    await writeAndParse(dir, 'cli.ts', [
        'import { EmbeddedLore } from "./embeddedLore.js";',
        'export function parseArgs(): { open: boolean } {',
        '    let open = false;',
        '    return { open };',
        '}',
        'export async function cmdIndex(): Promise<number> {',
        '    const client = await EmbeddedLore.open("/tmp/x");',
        '    return 0;',
        '}',
        '',
    ].join('\n'));

    const { edges } = await parseDir(dir);
    const openEdges = edges.filter((e) => e.sourceId.includes('cmdIndex'));
    assert.equal(openEdges.length, 1, `cmdIndex has exactly one resolved call edge (got ${openEdges.length})`);
    assert.ok(openEdges[0]!.targetId.includes('EmbeddedLore.open:method'),
        `edge targets EmbeddedLore.open, not a local variable (got ${openEdges[0]!.targetId})`);
    assert.match(openEdges[0]!.reason, /receiver-qualified/, 'resolved via the receiver hint');
    assert.equal(
        edges.filter((e) => e.targetId.includes('parseArgs.open')).length, 0,
        'no edge to the unrelated parseArgs.open variable',
    );
    console.log('  ✓ CLAIM R1: EmbeddedLore.open resolves by receiver; local `open` variable never matches');
}

// ── R2 — bare-name fallback must not jump to scoped (class-member) symbols ──
async function testBareNameScopedExclusion(cleanup: string[]): Promise<void> {
    console.log('\n[R2] bare open() cross-file match to a scoped class method');
    const dir = mkTmp('atlas-r2-');
    cleanup.push(dir);

    await writeAndParse(dir, 'embeddedLore.ts', [
        'export class EmbeddedLore {',
        '    static async open(dir: string): Promise<EmbeddedLore> { return new EmbeddedLore(); }',
        '}',
        '',
    ].join('\n'));
    await writeAndParse(dir, 'unrelated.ts', [
        'export async function pickFolder(): Promise<string | null> {',
        '    const { open } = await import("@tauri-apps/plugin-dialog");',
        '    return open({ directory: true });',
        '}',
        '',
    ].join('\n'));

    const first = await parseDir(dir);
    assert.equal(
        first.edges.filter((e) => e.sourceId.includes('pickFolder')).length, 0,
        'dynamically-imported bare open() resolves to nothing (no false cross-file edge)',
    );

    // Same-named MODULE-LEVEL functions must still bare-match (guard against
    // over-tightening the fallback).
    await writeAndParse(dir, 'freestanding.ts', 'export function helperTop(): void {}\n');
    await writeAndParse(dir, 'caller.ts', 'export function useFree(): void { helperTop(); }\n');
    const second = await parseDir(dir);
    assert.ok(second.edges.some((e) => e.sourceId.includes('useFree') && e.targetId.includes('helperTop')),
        'module-level bare-name fallback still works for unqualified functions');
    console.log('  ✓ CLAIM R2: scoped members excluded from bare fallback; module-level still matches');
}

// ── D1 — handler symbols are exempt from dead-code flagging ──
async function testDeadCodeHandlerExemption(cleanup: string[]): Promise<void> {
    console.log('\n[D1] handler symbols would flood find_dead_code');
    const dir = mkTmp('atlas-d1-');
    cleanup.push(dir);

    const pf = await writeAndParse(dir, 'reg.ts', [
        'export function buildRegistry(): void {',
        '    registry.register({',
        "        name: 'atlas_call_graph',",
        '        handler: async (args) => helper(),',
        '    });',
        '}',
        'function helper(): void {}',
        'export class Widget {',
        '    unusedMethod(): void {}',
        '}',
        '',
    ].join('\n'));
    assert.ok(pf, 'TS parsed');
    const table = buildSymbolTable([pf]);
    const contains = pf.symbols
        .filter((s) => s.parentSymbolId)
        .map((s) => ({ sourceId: s.parentSymbolId!, targetId: s.id, kind: 'contains', confidence: 1, reason: 'test' }));
    const report = deadCode(table, contains);
    const flagged = report.candidates.map((c) => c.qualifiedName);
    assert.ok(!flagged.includes('buildRegistry.atlas_call_graph'),
        `handler symbol not flagged as dead (flagged: ${JSON.stringify(flagged)})`);
    assert.ok(flagged.some((n) => n.startsWith('Widget.')),
        `class members keep the full dead-code treatment (flagged: ${JSON.stringify(flagged)})`);
    console.log('  ✓ CLAIM D1: function-scoped handlers exempt; class members still flagged');
}

async function main(): Promise<void> {
    console.log('Running graph handler-attribution + callee-resolution regression tests…');
    const cleanup: string[] = [];
    try {
        await testHandlerAttribution(cleanup);
        await testHandlerKeyFallback(cleanup);
        await testReceiverQualifiedResolution(cleanup);
        await testBareNameScopedExclusion(cleanup);
        await testDeadCodeHandlerExemption(cleanup);
    } finally {
        for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log('\nAll graph handler-attribution regression tests passed ✓');
}

await main();
