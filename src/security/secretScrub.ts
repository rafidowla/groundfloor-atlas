/**
 * security/secretScrub.ts — the single secret/PII pattern set, shared by the
 * EGRESS path (context shipped to an LLM) and the WRITE path (anything that
 * lands in the graph).
 *
 * WHY THIS MODULE EXISTS. The patterns used to live in mcp/tools/llmChat.ts and
 * were only ever applied on egress — `sanitizeContext` was called from the chat
 * modules and from nowhere else. Nothing scrubbed what went INTO the store, so:
 *
 *   1. A secret hardcoded in a TRACKED source file (which .gitignore cannot
 *      exclude — it is source the indexer is supposed to read) was extracted
 *      into an embedded code_context card verbatim.
 *   2. A knowledge node authored by an agent went to Lore unfiltered — and
 *      knowledge nodes are exported to .atlas/memory.jsonl, which the wire
 *      harness COMMITS AND PUSHES. That is a publishing surface.
 *
 * ORDERING IS THE WHOLE TRICK. Most of these patterns are anchored on key/value
 * adjacency (`password: hunter2`, `api_key = "…"`). The context layer does not
 * store raw source — it stores identifier-shaped tokens pulled out with
 * /[A-Za-z_][A-Za-z0-9_]{2,}/g. That extraction DELETES the `=` and the quotes,
 * so a detector run afterwards sees `password hunter2secret` as two unrelated
 * words and matches nothing, while the secret value survives intact. Measured
 * before this module existed: 4 planted secrets, 3 redacted from raw source,
 * only 1 from the extracted card.
 *
 * So callers on the write path MUST scrub the RAW text first and derive from the
 * scrubbed copy — never scrub the derived artifact. See store/codeNodes.ts,
 * where scrubSecrets() runs on the file body before identifiers are pulled.
 *
 * Bias is deliberately toward OVER-redaction: a false positive costs a little
 * retrieval quality, a false negative puts a live credential in a git-tracked
 * file. Non-secret shapes that merely look numeric (dates, semver, ip:port,
 * epoch ms) are protected by tests/pii-redaction.test.ts.
 */

/** Secret/credential + PII patterns. Order is not significant — all are applied. */
export const REDACTION_PATTERNS: RegExp[] = [
    // ── Secrets / credentials — vendor-prefixed (survive identifier extraction,
    //    because the prefix is part of the token itself rather than context) ──
    /sk-ant-[A-Za-z0-9_-]{20,}/g,                       // Anthropic keys
    /sk-[A-Za-z0-9]{20,}/g,                             // OpenAI keys
    // Stripe and friends use an UNDERSCORE after the prefix, so the `sk-` rule
    // above never matched them — a real miss found while auditing the write path.
    /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}/g,        // Stripe sk_live_/pk_test_/rk_live_…
    /gh[pousr]_[A-Za-z0-9]{20,}/g,                      // GitHub tokens
    /glpat-[A-Za-z0-9_-]{15,}/g,                        // GitLab PATs
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,                    // Slack tokens
    /\bAIza[A-Za-z0-9_-]{30,}/g,                        // Google API keys
    /\bya29\.[A-Za-z0-9_-]{20,}/g,                      // Google OAuth access tokens
    /\bnpm_[A-Za-z0-9]{30,}/g,                          // npm automation tokens
    /\bAKIA[0-9A-Z]{16}/g,                              // AWS access key ids
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
    /Bearer\s+[A-Za-z0-9._-]{20,}/gi,                   // bearer tokens
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
    // ── Secrets / credentials — key/value shaped. These are the ones that only
    //    work BEFORE identifier extraction; see the ordering note above. ──
    /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"',}]{6,}/gi,
    // The rule above requires the keyword to stand alone (`\bpassword\b`), so it
    // misses the far more common code shape: a camelCase or prefixed identifier
    // like `dbPassword`, `stripeSecret`, `userApiKey`. Allow the keyword to sit
    // anywhere inside the identifier — but REQUIRE a quoted literal on the right,
    // which is what keeps this from eating ordinary code. Without the quote
    // requirement, `const tokenizer = createTokenizer();` would match on
    // `token`-as-substring and redact a real symbol signature.
    /\b[A-Za-z0-9_]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[A-Za-z0-9_]*\s*[:=]\s*["'][^"'\n]{4,}["']/gi,
    // Credentials embedded in a connection URI (postgres://user:pass@host, and
    // the same shape for mysql/mongodb/redis/amqp/https). Captures the scheme and
    // user so the URI stays readable; only the password is destroyed.
    /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s:@]+@/gi,
    // ── PII — personal info must never reach a cloud LLM, and must never be
    //    memorized into a store that syncs to git either. ──
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,        // email addresses
    /\b\d{3}-\d{2}-\d{4}\b/g,                                     // US SSN (3-2-4)
    /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g,                    // payment cards, 4-4-4-N
    /\b\d{4}[ -]\d{6}[ -]\d{5}\b/g,                               // payment cards, AmEx 4-6-5
    /\b\d{15,16}\b/g,                                             // contiguous card-length digit runs
    /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,     // phone numbers (separator-required)
];

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Redact secrets + PII from `text`. Pure redaction — NO size cap, so it is safe
 * on the write path where truncating stored content would silently lose data
 * (the egress caller applies its own cap afterwards).
 *
 * Returns the scrubbed text plus whether anything matched, so a caller can log
 * or count redactions without diffing the strings itself.
 */
export function scrubSecrets(text: string): { text: string; redacted: boolean } {
    if (!text) return { text, redacted: false };
    let out = text;
    let redacted = false;
    for (const re of REDACTION_PATTERNS) {
        const before = out;
        // The URI-credential rule keeps its scheme+user capture group; every
        // other rule replaces the whole match.
        out = out.replace(re, (match, ...groups) => {
            const g1 = typeof groups[0] === 'string' ? groups[0] : undefined;
            return g1 !== undefined ? `${g1}:${REDACTION_PLACEHOLDER}@` : REDACTION_PLACEHOLDER;
        });
        if (out !== before) redacted = true;
    }
    return { text: out, redacted };
}

/**
 * Scrub the free-text fields of a knowledge node in place-safe fashion (returns
 * a new object). Applied by every write path that persists agent-authored text:
 * knowledge_store, schema_confirm, alerts_dismiss.
 *
 * `tags` and `metadata` are scrubbed too — an agent can just as easily paste a
 * token into a tag or a metadata blob, and both are exported to memory.jsonl.
 */
export function scrubKnowledgeFields<T extends {
    label?: string | undefined;
    content?: string | undefined;
    tags?: string | undefined;
    metadata?: string | undefined;
}>(node: T): { node: T; redacted: boolean } {
    let redacted = false;
    const pass = (v: string | undefined): string | undefined => {
        if (typeof v !== 'string') return v;
        const r = scrubSecrets(v);
        if (r.redacted) redacted = true;
        return r.text;
    };
    return {
        node: {
            ...node,
            label: pass(node.label),
            content: pass(node.content),
            tags: pass(node.tags),
            metadata: pass(node.metadata),
        },
        redacted,
    };
}
