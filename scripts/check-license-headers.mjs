#!/usr/bin/env node
/**
 * scripts/check-license-headers.mjs — W4-T1 licensing verifier (CI-runnable).
 *
 * Verifies the Apache-2.0 licensing story for the open-source Groundfloor Atlas release:
 *
 *   1. LICENSE is the verbatim Apache License 2.0.
 *   2. NOTICE exists and carries the copyright line.
 *   3. package.json declares "license": "Apache-2.0".
 *   4. Every declared PRODUCTION dependency of THIS package, plus everything the
 *      embedded @groundfloor/lore pulls in transitively, is under a permissive
 *      license — anything copyleft (GPL/LGPL/AGPL) or UNKNOWN is flagged for
 *      human review and fails the check (do NOT resolve unaided — see NOTICE).
 *   4b. @groundfloor/lore ITSELF is the one deliberate exception: it is
 *      Elastic-2.0, not permissive, and that is fine — Apache-2.0 is not viral,
 *      so an Apache Atlas embedding an ELv2 Lore in-process is not a licensing
 *      conflict. What is NOT fine is a NOTICE that goes quiet about it. The
 *      engine that actually SHIPS is the vendored tarball package.json
 *      resolves (`file:vendor/groundfloor-lore-<version>.tgz`), so this check
 *      reads THAT tarball's package.json and asserts its declared license is
 *      EXACTLY Elastic-2.0 and its version matches the one in its filename
 *      (catches packing a mismatched build under a stale name). A future
 *      license or version change upstream can never ship into an Apache
 *      release unnoticed.
 *   4c. package-lock.json sweep: every locked package whose license contains
 *      GPL/LGPL/AGPL must either have a permissive OR-branch (dual licenses
 *      like jszip's) or match a pattern NOTICE explicitly discloses (the
 *      @img/sharp-* libvips binaries, LGPL-3.0-or-later). This exists because
 *      exactly that defect shipped once: NOTICE claimed "no copyleft" while
 *      sharp's libvips platform binaries — LGPL — sat one level below the
 *      audited set. Section 4 alone cannot see them.
 *   5. Per-file consistency: this repo does NOT adopt a repo-wide SPDX per-file
 *      header convention (it never has — a mass-edit would be pure churn), so
 *      headers are NOT required. But IF a file carries an
 *      `SPDX-License-Identifier`, it MUST say Apache-2.0, so a stray/contradictory
 *      header can't creep in. This keeps the door open to adopting per-file
 *      headers later without silently shipping an inconsistent one now.
 *
 * Exit 0 = clean; exit 1 = one or more checks failed (prints why). Zero deps.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];
function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }

// ── 1. LICENSE is verbatim Apache 2.0 ────────────────────────────────────────
const licensePath = path.join(repoRoot, 'LICENSE');
if (!fs.existsSync(licensePath)) {
    fail('LICENSE file is missing');
} else {
    const txt = fs.readFileSync(licensePath, 'utf8');
    for (const needle of ['Apache License', 'Version 2.0, January 2004', 'APPENDIX: How to apply the Apache License']) {
        if (!txt.includes(needle)) fail(`LICENSE does not look like the verbatim Apache 2.0 text (missing: "${needle}")`);
    }
}

// ── 2. NOTICE present with a copyright line ──────────────────────────────────
const noticePath = path.join(repoRoot, 'NOTICE');
if (!fs.existsSync(noticePath)) {
    fail('NOTICE file is missing');
} else {
    const txt = fs.readFileSync(noticePath, 'utf8');
    if (!/copyright/i.test(txt)) fail('NOTICE is missing a copyright line');
}

// ── 3. package.json license field ────────────────────────────────────────────
const pkgPath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.license !== 'Apache-2.0') {
    fail(`package.json "license" is "${pkg.license}" — expected "Apache-2.0"`);
}

// ── 4. Production dependency license audit ───────────────────────────────────
// Permissive SPDX ids we accept without review. Anything else (copyleft or
// unrecognized) is surfaced for a human — NOTICE says these must not be
// resolved unaided.
const PERMISSIVE = new Set([
    'MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
    'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'MPL-2.0', 'Python-2.0',
]);

const COPYLEFT_RE = /\b(GPL|LGPL|AGPL)\b/i;

// Resolve a dependency's declared license by reading its installed
// package.json, searching this package's node_modules first, then the
// installed lore's (npm may nest its deps instead of hoisting them — there is
// no sibling ../groundfloor-lore checkout anymore). Returns null if not
// installed (then we can't audit it).
const searchRoots = [
    path.join(repoRoot, 'node_modules'),
    path.join(repoRoot, 'node_modules', '@groundfloor', 'lore', 'node_modules'),
];
function resolveLicense(depName) {
    for (const base of searchRoots) {
        const p = path.join(base, depName, 'package.json');
        if (fs.existsSync(p)) {
            try {
                const dp = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (typeof dp.license === 'string') return dp.license;
                if (Array.isArray(dp.licenses) && dp.licenses[0]?.type) return dp.licenses[0].type;
                return 'UNKNOWN';
            } catch { return 'UNKNOWN'; }
        }
    }
    return null; // not installed
}

// Direct prod deps of this package. @groundfloor/lore is excluded from the
// PERMISSIVE audit below on purpose (it is the one known exception — see the
// explicit assertion right after this block) and must never be silently
// dropped: the exclusion and the assertion live together so removing one
// without the other is a visible diff, not a quiet gap.
const directDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== '@groundfloor/lore');

// ── 4b. @groundfloor/lore's OWN license — asserted, never silently skipped ───
// The engine that actually SHIPS is the vendored tarball package.json resolves
// (`file:vendor/groundfloor-lore-<version>.tgz`), so the tarball is what gets
// asserted — not a sibling git checkout, which no longer feeds the build.
const EXPECTED_LORE_LICENSE = 'Elastic-2.0';
const loreSpec = pkg.dependencies?.['@groundfloor/lore'] ?? '';
const loreTarball = loreSpec.replace(/^file:/, '');
const loreTarballMatch = loreTarball.match(/groundfloor-lore-(.+)\.tgz$/);
if (!loreTarballMatch) {
    fail(`package.json's "@groundfloor/lore" must be a vendored "file:vendor/groundfloor-lore-<version>.tgz" spec — got "${loreSpec}"`);
}
let lorePkg = null;
if (loreTarballMatch) {
    const tarballPath = path.join(repoRoot, loreTarball);
    if (!fs.existsSync(tarballPath)) {
        fail(`vendored @groundfloor/lore tarball is missing: ${loreTarball} (referenced by package.json — broken checkout, or the dependency moved off the vendor flow without updating this check)`);
    } else {
        const extracted = spawnSync('tar', ['-xzOf', tarballPath, 'package/package.json'], { encoding: 'utf8' });
        if (extracted.status !== 0) {
            fail(`could not read package/package.json inside ${loreTarball} (tar exited ${extracted.status})`);
        } else {
            try {
                lorePkg = JSON.parse(extracted.stdout);
            } catch {
                fail(`package/package.json inside ${loreTarball} is not valid JSON`);
            }
        }
    }
}
if (lorePkg !== null) {
    if (lorePkg.license !== EXPECTED_LORE_LICENSE) {
        fail(
            `vendored @groundfloor/lore (${loreTarball}) declares license "${lorePkg.license}", expected "${EXPECTED_LORE_LICENSE}" — ` +
            `NOTICE's "Embedded knowledge-layer dependencies" section names this license explicitly and must ` +
            `be updated to match before release if this changed on purpose`,
        );
    } else if (lorePkg.version !== loreTarballMatch[1]) {
        fail(
            `vendored tarball ${loreTarball} contains @groundfloor/lore version "${lorePkg.version}", ` +
            `expected "${loreTarballMatch[1]}" (the version in its filename) — the tarball was likely ` +
            `packed from a mismatched build; re-pack and re-vendor it`,
        );
    } else {
        console.log(`[check-license] vendored @groundfloor/lore ${lorePkg.version} declares ${EXPECTED_LORE_LICENSE} as expected — embedding it in Apache-2.0 Atlas is not a conflict (Apache-2.0 is not viral), and NOTICE discloses it explicitly.`);
    }
}
// The embedded lore's prod + optional deps (the DB/embedding stack ships inside
// the same process, so it belongs in our redistribution audit) — these must
// still be permissive; only Lore's own top-level license is the exception.
let embeddedDeps = [];
if (lorePkg !== null) {
    embeddedDeps = [
        ...Object.keys(lorePkg.dependencies ?? {}),
        ...Object.keys(lorePkg.optionalDependencies ?? {}),
    ];
}

const auditSet = new Set([...directDeps, ...embeddedDeps]);
let audited = 0, notInstalled = 0;
for (const dep of [...auditSet].sort()) {
    const lic = resolveLicense(dep);
    if (lic === null) { notInstalled++; continue; }
    audited++;
    if (lic === 'UNKNOWN') { fail(`dependency ${dep} declares no recognizable license (UNKNOWN) — human review required`); continue; }
    if (COPYLEFT_RE.test(lic)) { fail(`dependency ${dep} is copyleft (${lic}) — human review required before release`); continue; }
    // Handle simple SPDX expressions like "(MIT OR Apache-2.0)".
    const tokens = lic.replace(/[()]/g, ' ').split(/\s+(?:OR|AND|or|and)\s+|\s+/).filter(Boolean);
    const ok = tokens.some((t) => PERMISSIVE.has(t));
    if (!ok) fail(`dependency ${dep} license "${lic}" is not on the permissive allowlist — human review required`);
}

// ── 4c. Lockfile copyleft sweep ─────────────────────────────────────────────
// Section 4 only audits direct deps + the embedded lore's direct deps — all of
// which resolve to permissive top-level licenses. An LGPL payload can hide one
// level deeper: sharp is Apache-2.0, but its @img/sharp-libvips-* platform
// binaries (and @img/sharp-wasm32 / @img/sharp-win32-*) are LGPL-3.0-or-later.
// Walk the whole lockfile and require every copyleft-licensed package to be
// one NOTICE explicitly discloses; (X OR Y) expressions with a permissive
// branch (e.g. jszip's "(MIT OR GPL-3.0-or-later)") pass because the
// permissive branch is chosen.
const DISCLOSED_COPYLEFT = [
    /^@img\/sharp-libvips-/,                      // prebuilt libvips — LGPL-3.0-or-later
    /^@img\/sharp-(wasm32|win32-(arm64|ia32|x64))/, // embedded libvips — "Apache-2.0 AND LGPL-3.0-or-later"
];
const OR_TOKENS_RE = /\s+OR\s+/i;
const lockPath = path.join(repoRoot, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
    console.log('[check-license] no package-lock.json present — skipping lockfile copyleft sweep (run after `npm install`)');
} else {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const entries = Object.entries(lock.packages ?? {});
    let disclosed = 0;
    for (const [p, meta] of entries) {
        const lic = meta?.license;
        if (typeof lic !== 'string' || !COPYLEFT_RE.test(lic)) continue;
        const branches = lic.replace(/[()]/g, ' ').split(OR_TOKENS_RE);
        if (branches.some((b) => PERMISSIVE.has(b.trim()))) continue; // permissive branch chosen
        const name = p.split('node_modules/').pop();
        if (DISCLOSED_COPYLEFT.some((re) => re.test(name))) { disclosed++; continue; }
        fail(`lockfile package ${name} declares copyleft license "${lic}" that NOTICE does not disclose — human review required`);
    }
    console.log(`[check-license] lockfile sweep: ${entries.length} entries scanned, ${disclosed} match the NOTICE-disclosed LGPL libvips pattern(s), no undisclosed copyleft`);
}

// ── 5. SPDX header consistency (present-only; headers are NOT required) ───────
const HEADER_EXT = new Set(['.ts', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', '.git', 'atlas-ui', 'grammars', 'bench', 'index.js']);
function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, out);
        } else if (HEADER_EXT.has(path.extname(entry.name))) {
            out.push(full);
        }
    }
}
let sourceFiles = [];
for (const sub of ['src', 'scripts', 'tests']) {
    const d = path.join(repoRoot, sub);
    if (fs.existsSync(d)) walk(d, sourceFiles);
}
let withHeader = 0;
for (const f of sourceFiles) {
    // Only the first ~40 lines matter for a license header.
    const head = fs.readFileSync(f, 'utf8').split('\n', 40).join('\n');
    const m = head.match(/SPDX-License-Identifier:\s*([^\s*]+)/);
    if (!m) continue;
    withHeader++;
    if (m[1] !== 'Apache-2.0') {
        fail(`${path.relative(repoRoot, f)} has SPDX header "${m[1]}" — expected Apache-2.0`);
    }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`[check-license] audited ${audited} installed prod dependencies (${notInstalled} declared-but-not-installed, skipped)`);
console.log(`[check-license] scanned ${sourceFiles.length} source files; ${withHeader} carry an SPDX header (per-file headers are optional in this repo)`);
for (const w of warnings) console.warn(`[check-license] warning: ${w}`);
if (failures.length) {
    console.error(`\n[check-license] FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log(`[check-license] OK — LICENSE + NOTICE present, package.json Apache-2.0, vendored @groundfloor/lore ${lorePkg?.version ?? '??'} asserted (Elastic-2.0, disclosed above), all other prod deps permissive.`);
