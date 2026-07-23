/**
 * Routing engine — pure function, mirrors the confidence & routing formula
 * in CLAUDE.md exactly. Category overrides first, then confidence.
 */
export const ESCALATE_CATEGORIES = new Set(["billing", "security_abuse", "sales_enterprise", "bug_report"]);
export const CONFIDENCE_THRESHOLD = 0.8;

export type Route = {
  status: "auto_resolved" | "escalated";
  confidence: number;
  reason: string | null;
};

export function computeConfidence(retrievalScore: number, selfCertainty: number): number {
  return 0.6 * retrievalScore + 0.4 * selfCertainty;
}

export function route(category: string, retrievalScore: number, selfCertainty: number): Route {
  const confidence = computeConfidence(retrievalScore, selfCertainty);

  if (ESCALATE_CATEGORIES.has(category)) {
    return { status: "escalated", confidence, reason: `category:${category}` };
  }
  if (confidence >= CONFIDENCE_THRESHOLD) {
    return { status: "auto_resolved", confidence, reason: null };
  }
  return { status: "escalated", confidence, reason: "low_confidence" };
}
