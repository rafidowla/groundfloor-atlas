/**
 * welcomeMessage — pure helpers for the chat welcome banner.
 *
 * Split out of ChatPanel so the "which welcome does this workspace get?" decision
 * is unit-testable without rendering React. A knowledge-only workspace (no indexed
 * code) must not advertise code-analysis features (dead code, hotspots, blast
 * radius) that can't run until a project is indexed (tester issue 11).
 */

export type WelcomeKind = 'code' | 'knowledge';

/** 'code' when the workspace has indexed source (files/symbols), else 'knowledge'. */
export function pickWelcomeKind(typeBreakdown: Record<string, number> | undefined): WelcomeKind {
  const bd = typeBreakdown ?? {};
  const codeCount = (bd['code_symbol'] ?? 0) + (bd['code_file'] ?? 0);
  return codeCount > 0 ? 'code' : 'knowledge';
}

export function welcomeText(kind: WelcomeKind): string {
  return kind === 'knowledge'
    ? "Hi! I'm Groundfloor Atlas. This workspace has team knowledge indexed but no code yet — ask about decisions, conventions, and bug patterns, or how many nodes it holds. To unlock code analysis (dead code, hotspots, blast radius, layer violations), index a project first with `atlas index <path>`."
    : "Hi! I'm Groundfloor Atlas. Ask me about your codebase — dead code, hotspots, blast radius, layer violations — or ask why a decision was made and I'll search your team's knowledge graph.";
}
