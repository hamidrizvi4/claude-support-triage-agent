/**
 * Single source for "which model is running the agent" — orchestrator.ts,
 * generate-tickets.ts, and the sidebar's display label all read this instead
 * of each carrying their own copy of the same literal. CLAUDE.md's Day 4 notes
 * flag exactly this duplication pattern (CONFIDENCE_THRESHOLD, ALWAYS_ESCALATE)
 * as a repeat bug source — one copy gets edited for a paid rerun, the other
 * silently doesn't.
 */
export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

export function resolveModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/** "nvidia/nemotron-3-ultra-550b-a55b:free" -> "nemotron-3-ultra-550b-a55b" */
export function modelDisplayName(slug: string): string {
  const afterSlash = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  return afterSlash.split(":")[0];
}
