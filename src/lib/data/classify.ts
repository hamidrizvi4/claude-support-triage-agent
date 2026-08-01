/**
 * Pure row->meaning logic, split out from queries.ts so it's importable
 * without pulling in "server-only" + the Supabase admin client — that's what
 * made this untestable before (see queries.selftest.ts).
 */
import type { Citation, RunOutcome } from "./types";

/**
 * The one place a raw row becomes a meaning. Classification reads only
 * draft_responses.escalation_reason — never tickets.status, which the review
 * write-path overwrites to 'reviewed' the moment anyone approves/rejects a
 * ticket. Reading status here would silently reclassify resolved<->escalated
 * on review, corrupting every dashboard stat retroactively.
 * Order matters: a 429 also starts with "agent_error:", so it's tested first.
 * Assumes every ticket has exactly one draft_responses row by the time this
 * runs — true for anything that has passed through run-triage.ts, which
 * always persists a row (real or fallback) even when the agent call throws.
 * A ticket never yet run has no row at all and would misclassify as
 * "resolved"; that state doesn't occur in this pipeline today.
 */
export function classifyOutcome(escalationReason: string | null): RunOutcome {
  const reason = escalationReason ?? "";
  if (reason.includes("429") || reason.includes("Rate limit")) return "rate_limited";
  if (reason.startsWith("agent_error:")) return "incomplete";
  return reason === "" ? "resolved" : "escalated";
}

/**
 * source_url comes from the model's JSON output — downstream of ticket text
 * and doc content, both attacker-influenceable in principle. Without this,
 * a javascript:/data: URI would render as a real clickable link.
 */
export function isHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fallback label when the model omits a title (or, seen in the wild, echoes
 * the URL back as the title) — the last path segment, humanized, reads far
 * better in a citation chip than a raw, mid-word-truncated URL.
 */
function titleFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const segment = path.split("/").pop();
  if (!segment) return url;
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const { source_url, title } = c as Record<string, unknown>;
    if (typeof source_url !== "string" || !isHttpUrl(source_url)) return [];
    const hasRealTitle =
      typeof title === "string" && title.trim().length > 0 && !isHttpUrl(title);
    return [{ source_url, title: hasRealTitle ? title : titleFromUrl(source_url) }];
  });
}
