/**
 * cli/ompHook.ts — canonical, versioned source of OMP's Atlas advisory hook.
 *
 * `atlas connect omp` (cli/ideConnect.ts) copies this verbatim to
 * ~/.omp/agent/hooks/pre/atlas-consult.ts and registers that path in
 * ~/.omp/agent/config.yml's `extensions:` list. Until this module existed the
 * hook only lived as a hand-placed file on one machine — nothing versioned to
 * install FROM. This string is byte-identical to that verified-working hook
 * (WO-5), and tests/ide-connect-omp.test.ts pins the installed file to it.
 *
 * The hook mirrors scripts/atlas-hook.mjs's contract (POST /hooks/context,
 * 1500ms timeout, fail-silent-always-continue) as an OMP `tool_result`
 * extension — see the header comment inside the string for the full rationale.
 * It resolves the MCP token at RUNTIME (env or <ATLAS_HOME>/mcp.token), so the
 * installed file embeds no secrets and needs no templating.
 */

/** File name OMP loads the hook under (hooks/pre/<this>). */
export const OMP_HOOK_FILENAME = 'atlas-consult.ts';

/** The exact bytes `atlas connect omp` writes to
 * ~/.omp/agent/hooks/pre/atlas-consult.ts (see applyOmp in cli/ideConnect.ts). */
export const OMP_HOOK_SOURCE = `/**
 * atlas-consult.ts — OMP's counterpart to Claude Code's \`atlas-hook.mjs\`
 * (groundfloor-atlas repo, scripts/atlas-hook.mjs): after a search/edit/bash
 * tool call, ask the Atlas daemon's /hooks/context endpoint whether it has
 * anything worth telling the agent (blast-radius on an edit target, a
 * workspace-onboarding announcement, stale-index nudge, …), and if so append
 * it onto the tool's own result so the LLM sees it alongside the output it
 * already expects.
 *
 * MIRRORS atlas-hook.mjs's contract exactly:
 *   - same endpoint: POST http://127.0.0.1:\${ATLAS_PORT||3848}/hooks/context
 *   - same body shape: {event, workspace, cwd, toolName, toolInput}
 *   - same token resolution: $ATLAS_MCP_TOKEN, else <ATLAS_HOME>/mcp.token
 *     (ATLAS_HOME defaults to ~/.groundfloor/atlas), else no Authorization header
 *   - same timeout: 1500ms
 *   - same fail-silent-always-continue contract: ANY error/timeout/non-2xx
 *     response is swallowed — this hook must NEVER block, delay, or disrupt a
 *     tool call. Only a genuinely non-empty \`additionalContext\` string
 *     produces any visible effect.
 *
 * WHY tool_result, NOT tool_call: a \`tool_call\` handler that calls
 * \`pi.sendMessage()\` mid-call queues a "system"-sourced steering message —
 * verified directly against a real session transcript, this made the
 * harness SKIP the in-flight tool call outright ("Skipped due to pending
 * system advisory", forcing a retry loop) instead of just adding context.
 * That is a disruptive side effect this hook must never cause. \`tool_result\`
 * fires AFTER the tool already ran and its \`ToolResultEventResult.content\`
 * lets a handler APPEND to the tool's own result content non-disruptively —
 * the direct OMP analogue of Claude Code's PreToolUse
 * hookSpecificOutput.additionalContext, which likewise never blocks the
 * tool, only adds context the model sees alongside it.
 *
 * Event mapping mirrors cli/wire.ts's settings.json matcher groups exactly:
 * Grep|Glob -> pre-search, Edit|Write|MultiEdit -> pre-edit, Bash -> post-bash.
 * OMP's tool names are lowercase (grep/glob/edit/write/bash); read/task/hub/
 * eval and everything else is not hooked, same as Claude Code's own harness.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { HookAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const PORT = Number(process.env.ATLAS_PORT || 3848);
const TIMEOUT_MS = 1500;

const ATLAS_HOME = process.env.ATLAS_HOME || path.join(os.homedir(), ".groundfloor", "atlas");
const TOKEN_PATH = path.join(ATLAS_HOME, "mcp.token");

/** Read-only mirror of atlas-hook.mjs's readMcpToken(): env var wins, else the
 *  daemon's own minted token file, else no auth header at all. */
function readMcpToken(): string | null {
	const env = process.env.ATLAS_MCP_TOKEN;
	if (env && env.trim()) return env.trim();
	try {
		const raw = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
		if (raw && !/[^\\x21-\\x7e]/.test(raw)) return raw;
	} catch {
		/* ENOENT (auth-off daemon, or daemon never booted) -> no header */
	}
	return null;
}

/** grep|glob -> pre-search, edit|write -> pre-edit, bash -> post-bash. Any
 *  other tool name (read, task, hub, eval, …) is not hooked at all — same
 *  coverage cli/wire.ts's settings.json install gives Claude Code. */
function eventFor(toolName: string): "pre-search" | "pre-edit" | "post-bash" | null {
	if (toolName === "grep" || toolName === "glob") return "pre-search";
	if (toolName === "edit" || toolName === "write") return "pre-edit";
	if (toolName === "bash") return "post-bash";
	return null;
}

/** POST /hooks/context and resolve with the daemon's \`additionalContext\`
 *  string, or '' on ANY failure (bad response, timeout, connection refused,
 *  malformed JSON) — never rejects, mirroring atlas-hook.mjs's fail-open
 *  \`done('')\` path for every non-happy branch. */
function fetchContext(body: string, token: string | null): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body).toString(),
	};
	if (token) headers["Authorization"] = \`Bearer \${token}\`;

	const req = http.request(
		{ host: "127.0.0.1", port: PORT, path: "/hooks/context", method: "POST", headers },
		(res) => {
			let out = "";
			res.setEncoding("utf-8");
			res.on("data", (c) => { out += c; });
			res.on("end", () => {
				try {
					const status = res.statusCode || 0;
					if (status < 200 || status >= 300) return resolve("");
					const parsed = JSON.parse(out) as { additionalContext?: unknown };
					resolve(typeof parsed.additionalContext === "string" ? parsed.additionalContext : "");
				} catch {
					resolve("");
				}
			});
		},
	);
	req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(""); });
	req.on("error", () => resolve(""));
	req.write(body);
	req.end();
	return promise;
}

export default function atlasConsultHook(pi: HookAPI): void {
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		try {
			const atlasEvent = eventFor(event.toolName);
			if (!atlasEvent) return;

			const body = JSON.stringify({
				event: atlasEvent,
				// Workspace-less (like the global Claude Code hook) — the daemon
				// resolves the workspace server-side from \`cwd\` via the
				// path->workspace resolver, same as cli/globalWire.ts's install.
				workspace: "",
				cwd: ctx.cwd,
				toolName: event.toolName,
				toolInput: event.input,
			});
			const context = await fetchContext(body, readMcpToken());
			if (!context.trim()) return; // the common case — nothing worth saying

			// Append, never replace: the model still sees the tool's real output,
			// plus this as an extra text block — no disruption to the tool result.
			return { content: [...event.content, { type: "text" as const, text: \`\\n[Atlas] \${context}\` }] };
		} catch {
			/* never throw, never block, never disrupt the tool result */
		}
	});
}
`;
