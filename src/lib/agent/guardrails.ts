/**
 * Pure, side-effect-free guardrails for the multi-agent paths. Everything a
 * model says passes through one of these before code acts on it, and every
 * function here is exhaustively self-tested (guardrails.selftest.ts).
 *
 * The invariants, in plain words:
 * 1. A reviewer agent can only keep a route or make it more cautious. No
 *    output of any model can turn an escalation into an auto-resolve.
 * 2. Anything unparseable, out of schema, missing or late fails closed: the
 *    ticket goes to a human.
 * 3. Untrusted text (the ticket, and retrieved docs) reaches a model fenced
 *    and length-capped, so it reads as data, never as instructions.
 * 4. A reply ships only if every factual sentence cites a passage the
 *    researcher actually retrieved. That check is code, not a model.
 */
import type { Route } from "./routing";

/* ───────────────────────────── untrusted input ───────────────────────────── */

/**
 * Wraps untrusted text in <tag>…</tag> for a prompt. Any tag-like sequence for
 * the same tag inside the text is neutralised, so a ticket can't close its own
 * fence and continue as "system" text, and the content is length-capped.
 */
export function fenceUntrusted(text: string, tag: string, maxChars = 6000): string {
  const re = new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "gi");
  let body = String(text ?? "").replace(re, "[removed tag]");
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n[truncated]`;
  return `<${tag}>\n${body}\n</${tag}>`;
}

/* ──────────────────────────────── checker ──────────────────────────────── */

export const CHECKER_REASONS = [
  "account_action",
  "billing_or_refund",
  "security_or_abuse",
  "sales_or_contract",
  "bug_or_outage",
  "legal_or_privacy",
  "ambiguous_or_multi_issue",
  "not_answerable_from_docs",
  "instructions_in_ticket",
] as const;
export type CheckerReason = (typeof CHECKER_REASONS)[number];

export type CheckerReview = { verdict: "agree" } | { verdict: "escalate"; reason: CheckerReason };

/** Strict parse of the checker's tool arguments; anything else is `null` (= fail closed). */
export function parseCheckerReview(raw: unknown): CheckerReview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.verdict === "agree") return { verdict: "agree" };
  if (r.verdict === "escalate") {
    const reason = CHECKER_REASONS.includes(r.reason as CheckerReason) ? (r.reason as CheckerReason) : "ambiguous_or_multi_issue";
    return { verdict: "escalate", reason };
  }
  return null;
}

/**
 * Applies a checker review to the router's decision. The only function that
 * lets the checker affect routing, and it is monotone by construction:
 * - an escalated route is returned untouched (the checker is never consulted)
 * - `null` (error, timeout, malformed answer) escalates: fail closed
 * - "escalate" escalates; "agree" keeps the auto-resolve
 */
export function applyChecker(routed: Route, review: CheckerReview | null): Route {
  if (routed.status !== "auto_resolved") return routed;
  if (review === null) return { ...routed, status: "escalated", reason: "checker:unavailable" };
  if (review.verdict === "escalate") return { ...routed, status: "escalated", reason: `checker:${review.reason}` };
  return routed;
}

/* ─────────────────────────── researcher / writer ─────────────────────────── */

export type Evidence = { passageIds: string[]; coverage: number; unknownIds: number };

/** Researcher output: keeps only passage ids that were really retrieved, in order, de-duplicated, capped. */
export function parseEvidence(raw: unknown, retrieved: Set<string>, maxPassages = 8): Evidence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.passage_ids)) return null;
  const ids: string[] = [];
  let unknownIds = 0;
  for (const id of r.passage_ids) {
    const s = String(id).trim();
    if (!retrieved.has(s)) unknownIds++;
    else if (!ids.includes(s)) ids.push(s);
  }
  const coverage = clamp01(r.coverage);
  return { passageIds: ids.slice(0, maxPassages), coverage, unknownIds };
}

export type ReplySentence = { text: string; kind: "claim" | "framing"; passage_ids: string[] };

export type WriterOutput = {
  category: string;
  answerable: boolean;
  sentences: ReplySentence[];
  selfCertainty: number;
  escalationReason: string | null;
};

export const RESOLUTION_CATEGORIES = [
  "technical_api_error",
  "billing",
  "feature_question",
  "account_access",
  "security_abuse",
  "sales_enterprise",
  "bug_report",
] as const;

/** Strict parse of the writer's tool arguments; anything structurally wrong is `null` (= fail closed). */
export function parseWriterOutput(raw: unknown): WriterOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!RESOLUTION_CATEGORIES.includes(r.category as (typeof RESOLUTION_CATEGORIES)[number])) return null;
  if (typeof r.answerable !== "boolean") return null;
  if (!Array.isArray(r.sentences)) return null;
  const sentences: ReplySentence[] = [];
  for (const s of r.sentences) {
    if (!s || typeof s !== "object") return null;
    const o = s as Record<string, unknown>;
    if (typeof o.text !== "string" || !o.text.trim()) continue;
    sentences.push({
      text: o.text.trim(),
      // Anything not explicitly "framing" is treated as a claim, so a missing
      // or misspelled kind can only make the citation check stricter.
      kind: o.kind === "framing" ? "framing" : "claim",
      passage_ids: Array.isArray(o.passage_ids) ? o.passage_ids.map((x) => String(x).trim()) : [],
    });
  }
  return {
    category: r.category as string,
    answerable: r.answerable,
    sentences,
    selfCertainty: clamp01(r.self_certainty),
    escalationReason: typeof r.escalation_reason === "string" && r.escalation_reason.trim() ? r.escalation_reason.trim() : null,
  };
}

export type CitationCheck = {
  ok: boolean;
  claims: number;
  /** Claim sentences with no valid citation. */
  uncited: number;
  /** Cited ids the writer was never given. */
  invalidIds: number;
};

/**
 * Deterministic grounding check, run by code on every reply: each claim
 * sentence must cite at least one passage the writer was actually given, and
 * no sentence may cite an id outside that set. A reply with no claims at all
 * fails too: there is nothing to auto-send.
 */
export function checkCitations(sentences: ReplySentence[], given: Set<string>): CitationCheck {
  let claims = 0;
  let uncited = 0;
  let invalidIds = 0;
  for (const s of sentences) {
    const valid = s.passage_ids.filter((id) => given.has(id));
    invalidIds += s.passage_ids.length - valid.length;
    if (s.kind === "claim") {
      claims++;
      if (valid.length === 0) uncited++;
    }
  }
  return { ok: claims > 0 && uncited === 0 && invalidIds === 0, claims, uncited, invalidIds };
}

/**
 * Applies the writer's own verdict and the citation check to the router's
 * decision. Same shape as applyChecker: it can only escalate.
 */
export function applyGrounding(routed: Route, writer: WriterOutput, check: CitationCheck): Route {
  if (routed.status !== "auto_resolved") return routed;
  if (!writer.answerable) return { ...routed, status: "escalated", reason: "unsupported:writer" };
  if (!check.ok) return { ...routed, status: "escalated", reason: "unsupported:citation_check" };
  return routed;
}

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
