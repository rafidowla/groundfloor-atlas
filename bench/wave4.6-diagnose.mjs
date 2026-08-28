/**
 * bench/wave4.6-diagnose.mjs
 *
 * Wave 4.6 — CJS edge-emission diagnostic probe (instrumentation ONLY,
 * no fixes). Per Wave 4.5's verify-agent charter: count emitted
 * ParsedImports vs persisted CodeRelations on dayjs; the delta is the bug.
 *
 * Stages measured:
 *   A. Top-level `require(literal)` AND `import ... from '...'` calls in dayjs sources (upper bound)
 *   B. ParsedImport objects the walker emits for those
 *   C. ParsedImports that resolve to a known target file
 *   D. Cross-file CodeRelations actually written (i.e. import edges that point
 *      to a symbol that exists in the target file)
 *
 * Plus per-name probe for src/index.js (constant, locale/en, utils).
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const DAYJS_ROOT = '/private/tmp/dayjs';
const ATLAS_DIST = path.resolve(process.env.ATLAS_DIST ?? '../dist'); // built parser/resolver output of this repo

const { parseFile, parseRepo } = await import(path.join(ATLAS_DIST, 'parser/index.js'));
const { buildSymbolTable } = await import(path.join(ATLAS_DIST, 'resolver/symbolTable.js'));
const { buildResolutionContext, buildImportEdges, resolveImport } = await import(path.join(ATLAS_DIST, 'resolver/importGraph.js'));

function header(s) {
  console.log('\n' + '='.repeat(72));
  console.log(s);
  console.log('='.repeat(72));
}

function listJsFiles() {
  const res = spawnSync('git', ['ls-files'], { cwd: DAYJS_ROOT, encoding: 'utf-8' });
  return res.stdout.split('\n').filter(f => f && /\.(js|jsx|ts|tsx)$/.test(f));
}

header('STAGE A — top-level require(literal) + import from in dayjs');

const allFiles = listJsFiles();
console.log(`Total JS/TS files (incl. tests): ${allFiles.length}`);

// Stage A counts via grep — establish upper bound on what *could* become edges.
let stageA_require = 0;
let stageA_import = 0;
let stageA_requireRelative = 0;
let stageA_importRelative = 0;
const stageAByFile = new Map();

for (const rel of allFiles) {
  const abs = path.join(DAYJS_ROOT, rel);
  let txt;
  try { txt = await fs.readFile(abs, 'utf-8'); } catch { continue; }
  // top-level require(literal): const x = require('...') or { ... } = require('...')
  const reqMatches = [...txt.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)];
  const impMatches = [...txt.matchAll(/^\s*import\s[^;]*?from\s+['"`]([^'"`]+)['"`]/gm)];
  const sideEffectImps = [...txt.matchAll(/^\s*import\s+['"`]([^'"`]+)['"`]/gm)];
  const imp = impMatches.length + sideEffectImps.length;
  stageA_require += reqMatches.length;
  stageA_import += imp;
  for (const m of reqMatches) if (m[1].startsWith('.')) stageA_requireRelative += 1;
  for (const m of [...impMatches, ...sideEffectImps]) if (m[1].startsWith('.')) stageA_importRelative += 1;
  stageAByFile.set(rel, { req: reqMatches.length, imp });
}

console.log(`Total require(literal): ${stageA_require} (relative: ${stageA_requireRelative})`);
console.log(`Total import-from:      ${stageA_import} (relative: ${stageA_importRelative})`);
const stageA = stageA_require + stageA_import;
console.log(`STAGE A TOTAL: ${stageA}  (relative: ${stageA_requireRelative + stageA_importRelative})`);

header('STAGE B — ParsedImports emitted by walker');

const parsed = await parseRepo(DAYJS_ROOT);
console.log(`Parsed files: ${parsed.files.length} (skipped: ${parsed.skipped.length}, diagnostics: ${parsed.diagnostics.length})`);

let stageB = 0;
let stageB_relative = 0;
let stageB_dayjsBare = 0;
const stageBByFile = new Map();
for (const f of parsed.files) {
  stageB += f.imports.length;
  stageBByFile.set(f.path, f.imports.length);
  for (const i of f.imports) {
    if (i.moduleSpecifier.startsWith('.')) stageB_relative += 1;
    if (i.moduleSpecifier === 'dayjs') stageB_dayjsBare += 1;
  }
}
console.log(`STAGE B TOTAL ParsedImports: ${stageB} (relative: ${stageB_relative}, bare 'dayjs': ${stageB_dayjsBare})`);
console.log(`DELTA A->B: ${stageA - stageB} requires/imports lost at walker stage`);

header('STAGE C — ParsedImports that RESOLVE to a target file');

const table = buildSymbolTable(parsed.files);
const ctx = await buildResolutionContext(DAYJS_ROOT, parsed.files);

let stageC = 0;
let stageC_relative = 0;
let stageC_relativeButTargetEmpty = 0;
const stageCByFile = new Map();
for (const f of parsed.files) {
  let count = 0;
  for (const imp of f.imports) {
    const tgt = resolveImport(f.path, f.language, imp, ctx);
    if (tgt) {
      stageC += 1;
      count += 1;
      if (imp.moduleSpecifier.startsWith('.')) {
        stageC_relative += 1;
        const fileMap = table.byFile.get(tgt);
        if (!fileMap || fileMap.size === 0) stageC_relativeButTargetEmpty += 1;
      }
    }
  }
  stageCByFile.set(f.path, count);
}
console.log(`STAGE C resolved imports: ${stageC} (relative: ${stageC_relative})`);
console.log(`Of relative resolved: ${stageC_relativeButTargetEmpty} had EMPTY target symbol-map (no symbols extracted from target)`);
console.log(`DELTA B->C: ${stageB - stageC} ParsedImports failed to resolve`);

header('STAGE D — cross-file CodeRelations actually emitted by buildImportEdges');

const importResult = buildImportEdges(parsed.files, table, ctx);
let stageD = importResult.edges.length;
// Cross-file: sourceId starts with "file:..." and targetId is a symbol id whose file differs.
let stageD_crossFile = 0;
for (const e of importResult.edges) {
  // sourceId is "file:<path>"; targetId is "<file>:<qname>:<kind>"
  const srcFile = e.sourceId.replace(/^file:/, '');
  const tgtFile = e.targetId.split(':')[0];
  if (srcFile !== tgtFile) stageD_crossFile += 1;
}
console.log(`STAGE D total import edges: ${stageD} (resolved=${importResult.resolved}, unresolved=${importResult.unresolved})`);
console.log(`STAGE D cross-file import edges: ${stageD_crossFile}`);
console.log(`DELTA C->D: ${stageC - stageD} resolved imports produced no edges (target file had no matching symbol by name)`);

header('PER-FILE PROBE — src/index.js (dayjs)');

const idxFile = parsed.files.find(f => f.path === 'src/index.js');
if (!idxFile) {
  console.log('src/index.js NOT in parsed files!');
} else {
  console.log(`Walker imports[] for src/index.js (${idxFile.imports.length} entries):`);
  for (const imp of idxFile.imports) {
    console.log(`  spec="${imp.moduleSpecifier}"  names=[${imp.names.join(',')}]`);
  }
  // For each of the 3 expected: ./constant, ./locale/en, ./utils
  const targets = [
    { spec: './constant', expectFile: 'src/constant.js' },
    { spec: './locale/en', expectFile: 'src/locale/en.js' },
    { spec: './utils', expectFile: 'src/utils.js' },
  ];
  for (const t of targets) {
    const imp = idxFile.imports.find(i => i.moduleSpecifier === t.spec);
    console.log(`\n  --- ${t.spec} ---`);
    console.log(`    Stage A (in source): YES (grep confirms)`);
    console.log(`    Stage B (ParsedImport): ${imp ? 'YES, names=' + JSON.stringify(imp.names) : 'NO'}`);
    if (imp) {
      const r = resolveImport('src/index.js', 'javascript', imp, ctx);
      console.log(`    Stage C (resolves to file): ${r ?? 'NO'}`);
      if (r) {
        const fileMap = table.byFile.get(r);
        const symCount = fileMap ? [...fileMap.values()].flat().length : 0;
        console.log(`    Target file has ${symCount} symbols in symbolTable`);
        if (fileMap) {
          const namesInTarget = [...fileMap.keys()];
          console.log(`    Target symbol names: ${JSON.stringify(namesInTarget.slice(0, 20))}`);
        }
        const ns = imp.names.length ? imp.names : ['*'];
        for (const n of ns) {
          if (n === '*') {
            // wildcard: emits an edge per public symbol
            const sc = fileMap ? [...fileMap.values()].flat().length : 0;
            console.log(`    Stage D (wildcard '*'): ${sc} edges expected`);
          } else {
            const matches = fileMap?.get(n);
            console.log(`    Stage D (name='${n}'): match in target? ${matches && matches.length > 0 ? 'YES (' + matches.length + ')' : 'NO'}`);
          }
        }
      }
    }
  }
}

header('PER-FILE PROBE — src/utils.js (dayjs)');

const utilsFile = parsed.files.find(f => f.path === 'src/utils.js');
if (utilsFile) {
  console.log(`Symbols extracted from src/utils.js (count=${utilsFile.symbols.length}):`);
  for (const s of utilsFile.symbols.slice(0, 30)) {
    console.log(`  ${s.kind}  name="${s.name}"  qname="${s.qualifiedName}"`);
  }
  // Check raw source for module.exports pattern
  const raw = await fs.readFile(path.join(DAYJS_ROOT, 'src/utils.js'), 'utf-8');
  const exportLines = raw.split('\n').filter(l => /export|module\.exports/.test(l));
  console.log(`\nExport statements in src/utils.js (raw):`);
  for (const l of exportLines) console.log(`  ${l.trim()}`);
}

header('PER-FILE PROBE — src/constant.js (dayjs)');

const constFile = parsed.files.find(f => f.path === 'src/constant.js');
if (constFile) {
  console.log(`Symbols extracted from src/constant.js (count=${constFile.symbols.length}):`);
  for (const s of constFile.symbols.slice(0, 30)) {
    console.log(`  ${s.kind}  name="${s.name}"  qname="${s.qualifiedName}"`);
  }
  const raw = await fs.readFile(path.join(DAYJS_ROOT, 'src/constant.js'), 'utf-8');
  const exportLines = raw.split('\n').filter(l => /export/.test(l));
  console.log(`\nExport statements in src/constant.js (first 20):`);
  for (const l of exportLines.slice(0, 20)) console.log(`  ${l.trim()}`);
}

header('CJS module.exports EXPORT TRACKING test');
// Sanity probe: synthesize a CJS file and a CJS importer in a tmp dir to confirm
// behaviour for the Wave 4.5 hypothesis (CJS module.exports={a,b} → are a,b
// indexed as named-exports?).
const tmp = await fs.mkdtemp('/tmp/atlas-cjs-probe-');
await fs.writeFile(path.join(tmp, 'lib.js'), `
function helper() { return 42; }
function other() { return helper(); }
module.exports = { helper, other };
`);
await fs.writeFile(path.join(tmp, 'main.js'), `
const { helper, other } = require('./lib');
console.log(helper(), other());
`);
// Need a fake git repo
spawnSync('git', ['init', '-q'], { cwd: tmp });
spawnSync('git', ['add', '.'], { cwd: tmp });
spawnSync('git', ['-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: tmp });

const tmpParsed = await parseRepo(tmp);
const tmpMain = tmpParsed.files.find(f => f.path === 'main.js');
const tmpLib = tmpParsed.files.find(f => f.path === 'lib.js');
console.log(`main.js imports[]: ${JSON.stringify(tmpMain?.imports)}`);
console.log(`main.js symbol count: ${tmpMain?.symbols.length}`);
console.log(`lib.js  symbol names: ${JSON.stringify(tmpLib?.symbols.map(s => `${s.kind}:${s.name}`))}`);
const tmpTable = buildSymbolTable(tmpParsed.files);
const tmpCtx = await buildResolutionContext(tmp, tmpParsed.files);
const tmpEdges = buildImportEdges(tmpParsed.files, tmpTable, tmpCtx);
console.log(`CJS edges produced: total=${tmpEdges.edges.length} resolved=${tmpEdges.resolved} unresolved=${tmpEdges.unresolved}`);
for (const e of tmpEdges.edges) console.log(`  edge: ${e.sourceId} -> ${e.targetId}  (${e.reason})`);

header('SUMMARY');
console.log(`Stage A (source-level requires+imports): ${stageA}  [relative-only: ${stageA_requireRelative + stageA_importRelative}]`);
console.log(`Stage B (walker ParsedImports):          ${stageB}  [relative-only: ${stageB_relative}]`);
console.log(`Stage C (resolved to target file):       ${stageC}  [relative-only: ${stageC_relative}]`);
console.log(`Stage D (import edges written):          ${stageD}  [cross-file: ${stageD_crossFile}]`);
console.log(`\nDELTAS:`);
console.log(`  A → B: ${stageA - stageB} dropped at walker layer`);
console.log(`  B → C: ${stageB - stageC} dropped at resolver (couldn't resolve specifier)`);
console.log(`  C → D: ${stageC - stageD} dropped at edge-writer (resolved but no symbol match)`);
