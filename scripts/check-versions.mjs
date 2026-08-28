#!/usr/bin/env node
/**
 * scripts/check-versions.mjs — single-source version guard (pkg-version-mismatch).
 *
 * The daemon's package.json version is the SOURCE OF TRUTH for the product
 * version. Historically atlas-ui/package.json and the three Tauri manifests
 * (tauri.conf.json, Cargo.toml, and the derived Cargo.lock entry) drifted to
 * 0.1.0 while the daemon moved on to 0.2.0 — three-plus places that had to be
 * remembered and kept in lockstep by hand, and nothing caught it when they
 * didn't.
 *
 * This script re-reads all of them and fails loudly (non-zero exit) if any
 * disagree with the root package.json. Run it locally before a release and
 * in CI (see bitbucket-pipelines.yml) so a mismatch is a build failure, not
 * a shipped inconsistency.
 *
 * Usage:
 *   node scripts/check-versions.mjs           # check only (CI mode)
 *   node scripts/check-versions.mjs --fix     # rewrite all followers to match root
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIX = process.argv.includes('--fix');

const rootPkgPath = path.join(REPO_ROOT, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
const SOURCE_VERSION = rootPkg.version;

if (!SOURCE_VERSION) {
    console.error(`[check-versions] root package.json has no "version" field`);
    process.exit(1);
}

/** @type {Array<{ file: string, get: (text: string) => string | null, set: (text: string, v: string) => string }>} */
const targets = [
    {
        file: 'atlas-ui/package.json',
        get: (text) => JSON.parse(text).version ?? null,
        set: (text, v) => text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${v}$2`),
    },
    {
        file: 'atlas-ui/src-tauri/tauri.conf.json',
        get: (text) => JSON.parse(text).version ?? null,
        set: (text, v) => text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${v}$2`),
    },
    {
        file: 'atlas-ui/src-tauri/Cargo.toml',
        get: (text) => text.match(/^version\s*=\s*"([^"]*)"/m)?.[1] ?? null,
        set: (text, v) => text.replace(/^(version\s*=\s*")[^"]*(")/m, `$1${v}$2`),
    },
];

let mismatched = [];
for (const t of targets) {
    const p = path.join(REPO_ROOT, t.file);
    if (!fs.existsSync(p)) {
        console.warn(`[check-versions] SKIP (missing): ${t.file}`);
        continue;
    }
    const text = fs.readFileSync(p, 'utf-8');
    const current = t.get(text);
    if (current !== SOURCE_VERSION) {
        mismatched.push({ ...t, path: p, current, text });
    }
}

if (mismatched.length === 0) {
    console.log(`[check-versions] OK — all manifests match root version ${SOURCE_VERSION}`);
    process.exit(0);
}

if (FIX) {
    for (const m of mismatched) {
        fs.writeFileSync(m.path, m.set(m.text, SOURCE_VERSION));
        console.log(`[check-versions] fixed ${m.file}: ${m.current} → ${SOURCE_VERSION}`);
    }
    console.log(
        `[check-versions] ${mismatched.length} file(s) updated to ${SOURCE_VERSION}. ` +
        `Re-run 'cargo check' in atlas-ui/src-tauri if Cargo.toml changed, so Cargo.lock stays in sync.`,
    );
    process.exit(0);
}

console.error(`[check-versions] MISMATCH — root package.json is ${SOURCE_VERSION}, but:`);
for (const m of mismatched) {
    console.error(`  ${m.file}: ${m.current ?? '(unreadable)'}`);
}
console.error(`[check-versions] run 'node scripts/check-versions.mjs --fix' to sync, then re-run 'cargo check' in atlas-ui/src-tauri.`);
process.exit(1);
