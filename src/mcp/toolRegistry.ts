/**
 * mcp/toolRegistry.ts — internal tool registry backing the Groundfloor Atlas shim.
 *
 * The shim exposes three meta-tools to IDEs (atlas_tool_list,
 * atlas_tool_schema, atlas_tool_invoke). Every real Groundfloor Atlas tool lives in
 * this registry — invisible to the MCP client until invoked through the
 * shim. Adding a new tool = one register() call in allTools.ts; no
 * changes to server.ts.
 */

export interface AtlasToolDef {
    name: string;
    description: string;
    /** JSON Schema object describing the tool's input. */
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Hard ceiling for any unbounded `limit`/`max` so a caller can't ask
 *  Groundfloor Atlas to pull an unbounded result set (review #12). */
const LIMIT_CAP = 500;

interface PropSpec { type?: string; enum?: unknown[]; maximum?: number }
interface JsonSchemaLike { required?: string[]; properties?: Record<string, PropSpec> }

/**
 * Validate `args` against a tool's JSON Schema (review #12). Checks
 * required fields, primitive types, and enum membership; clamps integer
 * `limit`/`max` fields. Returns sanitized args (clamped) on success.
 * Unknown extra fields are allowed (some handlers spread args through).
 *
 * `workspace` is enforced like any other required field. It USED to be
 * exempted here on the theory that it "always falls back to config" — but
 * that fallback is loadConfig()'s single process-wide default, not the
 * calling project's workspace, so a caller that forgot `workspace` had its
 * write silently misfiled under the global default instead of failing
 * loudly. A tool schema that declares `workspace` optional (e.g.
 * knowledge_recall, knowledge_search) simply omits it from `required` and
 * keeps its documented config-default behavior untouched by this loop.
 */
export function validateToolArgs(
    schema: Record<string, unknown>,
    args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    const s = schema as JsonSchemaLike;
    const props = s.properties ?? {};
    const required = s.required ?? [];

    for (const key of required) {
        const v = args[key];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
            return { ok: false, error: `missing_required_field: ${key}` };
        }
    }

    const out: Record<string, unknown> = { ...args };
    for (const [key, spec] of Object.entries(props)) {
        if (!(key in args) || args[key] === undefined || args[key] === null) continue;
        let v = args[key];
        switch (spec.type) {
            case 'string':
                if (typeof v !== 'string') return { ok: false, error: `invalid_type: '${key}' must be a string` };
                break;
            case 'boolean':
                if (typeof v !== 'boolean') return { ok: false, error: `invalid_type: '${key}' must be a boolean` };
                break;
            case 'array':
                if (!Array.isArray(v)) return { ok: false, error: `invalid_type: '${key}' must be an array` };
                break;
            case 'integer':
            case 'number': {
                if (typeof v !== 'number' || !Number.isFinite(v)) {
                    return { ok: false, error: `invalid_type: '${key}' must be a number` };
                }
                v = spec.type === 'integer' ? Math.trunc(v) : v;
                if ((v as number) < 0) v = 0;
                const cap = typeof spec.maximum === 'number'
                    ? spec.maximum
                    : (key === 'limit' || key === 'max') ? LIMIT_CAP : undefined;
                if (cap !== undefined && (v as number) > cap) v = cap;
                out[key] = v;
                break;
            }
            default:
                break; // unconstrained (e.g. layerSpec) — pass through
        }
        if (spec.enum && !spec.enum.includes(v)) {
            return { ok: false, error: `invalid_enum: '${key}' must be one of ${JSON.stringify(spec.enum)}` };
        }
    }
    return { ok: true, value: out };
}

export class ToolRegistry {
    private readonly tools = new Map<string, AtlasToolDef>();

    register(def: AtlasToolDef): void {
        this.tools.set(def.name, def);
    }

    list(): Array<{ name: string; description: string }> {
        return Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
        }));
    }

    schema(name: string): { name: string; description: string; inputSchema: Record<string, unknown> } | null {
        const t = this.tools.get(name);
        if (!t) return null;
        return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    }

    async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
        const tool = this.tools.get(name);
        if (!tool) return { error: `unknown_tool: ${name}`, available: this.list().map((t) => t.name) };
        // #12: validate + clamp against the tool's schema before dispatch.
        const validated = validateToolArgs(tool.inputSchema, args ?? {});
        if (!validated.ok) {
            return { error: 'invalid_arguments', tool: name, detail: validated.error };
        }
        try {
            return await tool.handler(validated.value);
        } catch (err) {
            // RD-Mrawerr — log the full error server-side. Return a PATH-REDACTED,
            // first-line-only message to the caller: a blanket "internal error"
            // hid actionable validation failures (e.g. knowledge_store_edge's
            // "edge_endpoint_missing: target 'X' not found — store it first" read
            // as a mystery tool bug). Redaction strips filesystem paths/stack
            // frames so internal layout still never leaks.
            console.error(`[atlas] tool ${name} failed: ${(err as Error).message}`);
            return { error: 'tool_execution_failed', tool: name, detail: safeErrorDetail(err) };
        }
    }
}

/**
 * A caller-safe error detail: the FIRST line of the message (drops any leaked
 * multi-line stack), with absolute filesystem paths redacted and length capped.
 * Surfaces the useful "what you did wrong" part of a validation error without
 * exposing internal paths, stack traces, or DB internals.
 */
export function safeErrorDetail(err: unknown): string {
    const raw = (err as Error)?.message ?? String(err);
    let msg = (raw.split('\n')[0] ?? raw).trim();
    // Redact posix + windows absolute paths (keeps short relative names/ids).
    msg = msg.replace(/(?:\/[^\s'"()]+|[A-Za-z]:\\[^\s'"()]+)/g, '<path>');
    return msg.length > 300 ? `${msg.slice(0, 300)}…` : (msg || 'internal error');
}
