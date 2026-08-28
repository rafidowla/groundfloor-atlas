/**
 * tests/secret-scrub-on-write.test.ts — regression for the WRITE-path secret
 * scrub (security/secretScrub.ts).
 *
 * Background: the redaction patterns existed for a long time but were wired to
 * EGRESS only (context shipped to an LLM). Nothing scrubbed what went INTO the
 * graph, so a secret hardcoded in a tracked source file was extracted into an
 * embedded code_context card verbatim, and an agent-authored knowledge node went
 * to Lore — and therefore to .atlas/memory.jsonl and git — unfiltered.
 *
 * CLAIM A — scrubSecrets removes credential material from raw text, including
 *           the vendor prefixes that the original `sk-` rule missed.
 * CLAIM B — THE ACTUAL DEFECT: scrubbing must happen BEFORE identifier
 *           extraction. Extraction destroys the `key = "value"` adjacency the
 *           patterns key on, so a scrub applied afterwards is near-useless while
 *           the secret value survives intact. This is the ordering the context
 *           layer now uses.
 * CLAIM C — scrubKnowledgeFields covers every free-text field that reaches the
 *           git-synced memory file (label, content, tags, metadata).
 * CLAIM D — ordinary code/prose is NOT mangled. Over-redaction here would gut
 *           semantic code search, so the false-positive guard is a hard
 *           requirement, not a nicety.
 */
import * as assert from 'node:assert/strict';
import { scrubSecrets, scrubKnowledgeFields } from '../src/security/secretScrub.js';

/** The EXACT identifier extractor the context layer uses (store/codeNodes.ts). */
const identsOf = (text: string) => [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])];

console.log('Running write-path secret-scrub tests…');

// Fake credentials — shape-accurate, none real. The provider-prefixed ones are
// assembled by concatenation so no contiguous literal in this file is itself a
// secret-shaped string that a push-protection scanner would flag; at runtime
// each constant is byte-identical to the shape its claim asserts against.
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const STRIPE = 'sk_' + 'live_' + '51H8xQfLkdIwHu7ixAaBbCcDdEe';
const PASSWORD = 'hunter2secret';
const DBPASS = 'S3cretPassw0rd';
const GITHUB = 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456';
const SLACK = 'xoxb' + '-1234567890-abcdefghijklmnop';

// ── CLAIM A — credential material is removed from raw text ───────────────────
{
    const cases: Array<[string, string, string]> = [
        ['aws',       `const k = "${AWS}";`,          AWS],
        ['stripe',    `const s = "${STRIPE}";`,       STRIPE],
        ['github',    `token = "${GITHUB}"`,          GITHUB],
        ['slack',     `const t = "${SLACK}";`,        SLACK],
        ['password',  `password = "${PASSWORD}";`,    PASSWORD],
        ['db uri',    `postgres://admin:${DBPASS}@db.internal:5432/prod`, DBPASS],
    ];
    for (const [label, input, secret] of cases) {
        const out = scrubSecrets(input);
        assert.ok(!out.text.includes(secret), `${label}: secret survived scrubSecrets → ${out.text}`);
        assert.equal(out.redacted, true, `${label}: redacted flag not set`);
    }
}

// ── CLAIM B — the ordering defect. Scrub-then-extract must beat
//    extract-then-scrub, which is what the code used to effectively do. ───────
{
    const source = [
        `const AWS_KEY = "${AWS}";`,
        `const stripeKey = "${STRIPE}";`,
        `password = "${PASSWORD}";`,
        `const dbUrl = "postgres://admin:${DBPASS}@db.internal:5432/prod";`,
    ].join('\n');
    const secrets = [AWS, STRIPE, PASSWORD, DBPASS];

    // The CORRECT order, and what store/codeNodes.ts now does.
    const scrubFirst = identsOf(scrubSecrets(source).text).join(' ');
    for (const s of secrets) {
        assert.ok(!scrubFirst.includes(s), `scrub-before-extract leaked ${s}`);
    }

    // The BROKEN order, asserted explicitly so nobody "simplifies" the call site
    // by moving the scrub after extraction. This documents WHY the order matters:
    // key-adjacency patterns cannot fire once the `=` and quotes are gone.
    const extractFirst = scrubSecrets(identsOf(source).join(' ')).text;
    const leaked = secrets.filter((s) => extractFirst.includes(s));
    assert.ok(
        leaked.length > 0,
        'extract-then-scrub was expected to leak (that is the defect this ordering guards against); ' +
        'if it no longer leaks the patterns changed — re-verify the ordering rationale before relaxing it',
    );
}

// ── CLAIM C — every git-bound knowledge field is covered ─────────────────────
{
    const r = scrubKnowledgeFields({
        label: `Fixed login with ${AWS}`,
        content: `We set password = "${PASSWORD}" in the config.`,
        tags: `auth,${STRIPE}`,
        metadata: JSON.stringify({ note: `token = "${GITHUB}"` }),
    });
    assert.equal(r.redacted, true, 'redacted flag not set');
    for (const [field, value] of Object.entries(r.node)) {
        for (const s of [AWS, PASSWORD, STRIPE, GITHUB]) {
            assert.ok(!String(value).includes(s), `secret survived in knowledge field '${field}'`);
        }
    }
}

// ── CLAIM D — ordinary code and prose survive untouched ─────────────────────
{
    const mustSurvive = [
        'released 2026-07-14 at noon',
        'bump to v3.11.0 and 1.2.3',
        'listening on 127.0.0.1:3848',
        'ts=1783477115474',
        'const nodeCount = stats.nodeCount;',
        'export function resolveWorkspace(root: string): string {',
        'import { scrubSecrets } from "../security/secretScrub.js";',
    ];
    for (const input of mustSurvive) {
        const out = scrubSecrets(input);
        assert.equal(out.text, input, `false positive: ${JSON.stringify(input)} → ${JSON.stringify(out.text)}`);
        assert.equal(out.redacted, false, `false positive flag on: ${input}`);
    }
}

console.log('  ✓ write-path secret scrub: all claims hold');
