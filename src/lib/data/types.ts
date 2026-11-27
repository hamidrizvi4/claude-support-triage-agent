/**
 * Shared shapes for the Day 3 UI. The agent pipeline writes raw rows; this
 * layer is the single place that decides what a row *means* so the queue and
 * the dashboard can never disagree about it.
 */
import { CONFIDENCE_THRESHOLD, ESCALATE_CATEGORIES } from "../agent/routing";

export type Citation = { source_url: string; title: string };

/** Mirrors the submit_resolution enum in CLAUDE.md. */
export type AgentCategory =
  | "technical_api_error"
  | "billing"
  | "feature_question"
  | "account_access"
  | "security_abuse"
  | "sales_enterprise"
  | "bug_report";

/** The four categories that always escalate regardless of confidence. */
export const ALWAYS_ESCALATE: ReadonlySet<string> = ESCALATE_CATEGORIES;

export { CONFIDENCE_THRESHOLD };
/** Below this retrieval_score the docs didn't really answer the question. */
export const DOC_GAP_THRESHOLD = 0.5;
/** Doc-gap rate above this reads as "content team needs to act". */
export const DOC_GAP_ALERT_RATE = 0.25;

/**
 * What actually happened on a run.
 * - resolved / escalated: the agent completed and submitted a resolution.
 * - incomplete: agent ran but never called submit_resolution (known free-model
 *   limitation, ~40-45%). A real agent outcome — counted, but flagged.
 * - rate_limited: OpenRouter 429. Infrastructure, not an agent decision —
 *   excluded from every dashboard statistic.
 */
export type RunOutcome = "resolved" | "escalated" | "incomplete" | "rate_limited";

export type QueueTicket = {
  id: string;
  subject: string;
  body: string;
  /** tickets.category — the synthetic seed label, not the agent's judgement. */
  seedCategory: string;
  status: string;
  accountId: string | null;
  createdAt: string;

  draftId: string | null;
  draftText: string;
  citations: Citation[];
  /** Agent-assigned category. Null when the run never completed. */
  category: AgentCategory | null;
  escalationReason: string | null;
  confidence: number | null;
  retrievalScore: number | null;
  selfCertainty: number | null;
  draftedAt: string | null;

  outcome: RunOutcome;
  reviewed: boolean;
  /** Latest review's action, if any. Used to calibrate the confidence formula. */
  reviewAction: ReviewAction | null;
  /** Seconds from first tool call to submitted draft. Null if not measurable. */
  latencySeconds: number | null;
};

export type ToolCall = {
  id: string;
  ticketId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  createdAt: string;
};

export type ReviewAction = "approve" | "edit_and_approve" | "reject";

export type Review = {
  id: string;
  ticketId: string;
  reviewer: string;
  action: ReviewAction;
  editedResponse: string | null;
  createdAt: string;
};

export type Breakdown = { label: string; count: number };

export type DocGap = {
  ticketId: string;
  subject: string;
  retrievalScore: number;
  category: AgentCategory | null;
};

export type DashboardStats = {
  /** Integrity of the run itself — shown above the KPIs, never folded into them. */
  runHealth: {
    completed: number;
    incomplete: number;
    rateLimited: number;
    /** completed / (completed + incomplete) */
    completionRate: number;
  };
  /** Denominator for all rates below = completed + incomplete (429s excluded). */
  decided: number;
  autoResolveRate: number;
  escalationRate: number;
  docGapRate: number;
  avgTimeToDraftSeconds: number | null;
  escalationByCategory: Breakdown[];
  escalationByReason: Breakdown[];
  docGaps: DocGap[];
  toolUsage: Breakdown[];
  /**
   * Validates the 0.6*retrieval + 0.4*certainty formula against what a human
   * reviewer actually did with auto-resolved tickets — the confidence formula
   * has no calibration behind it otherwise. Null rate until there's at least
   * one reviewed auto-resolve; small N is expected early on, shown honestly
   * rather than hidden.
   */
  reviewCalibration: {
    reviewedAutoResolved: number;
    overturned: number;
    overturnRate: number | null;
  };
};

const CATEGORY_LABELS: Record<string, string> = {
  technical_api_error: "Technical / API error",
  billing: "Billing",
  feature_question: "Feature question",
  account_access: "Account access",
  security_abuse: "Security / abuse",
  sales_enterprise: "Sales / enterprise",
  bug_report: "Bug report",
};

export function categoryLabel(category: string | null): string {
  if (!category) return "Unclassified";
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Escalation reasons are stored raw (they embed model/provider error text).
 * Collapse them into something a reviewer can scan.
 */
export function reasonLabel(reason: string | null): string {
  if (!reason) return "Auto-resolved";
  if (reason.startsWith("category:")) {
    return `Always escalates — ${categoryLabel(reason.slice("category:".length))}`;
  }
  if (reason.startsWith("safety_net:")) {
    return `Safety net — ${categoryLabel(reason.slice("safety_net:".length))}`;
  }
  if (reason === "low_confidence") return "Low confidence";
  if (reason === "checker:unavailable") return "Checker unavailable (failed closed)";
  if (reason.startsWith("checker:")) return `Checker — ${reason.slice("checker:".length).replace(/_/g, " ")}`;
  if (reason === "unsupported:writer") return "Docs don't support an answer";
  if (reason === "unsupported:citation_check") return "Failed citation check";
  if (reason.includes("429") || reason.includes("Rate limit")) return "Rate limited";
  if (reason.includes("did not call submit_resolution")) return "No resolution submitted";
  if (reason.startsWith("agent_error:")) return "Agent error";
  return reason;
}

export function outcomeLabel(outcome: RunOutcome): string {
  switch (outcome) {
    case "resolved":
      return "Auto-resolved";
    case "escalated":
      return "Escalated";
    case "incomplete":
      return "Incomplete";
    case "rate_limited":
      return "Rate limited";
  }
}

/** Confidence → semantic token name. Mirrors the queue colour rules. */
export function confidenceTone(
  confidence: number | null
): "resolve" | "escalate" | "critical" | "muted" {
  if (confidence == null) return "muted";
  if (confidence >= CONFIDENCE_THRESHOLD) return "resolve";
  if (confidence >= 0.5) return "escalate";
  return "critical";
}
