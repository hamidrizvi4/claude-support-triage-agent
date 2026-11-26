/**
 * Routing engine — pure function, mirrors the confidence & routing formula
 * in CLAUDE.md exactly. Category overrides first, then confidence.
 */
import { safetyNet } from "./safetyNet";

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

/**
 * Full routing decision for a ticket: the model's category rule, then the
 * deterministic safety net on the ticket text, then the confidence threshold.
 * `route()` above stays the pure score/category rule (the intro page's
 * calculator runs it); this adds the one check that doesn't trust the model.
 */
export function routeTicket(input: {
  category: string;
  retrievalScore: number;
  selfCertainty: number;
  text: string;
  useSafetyNet?: boolean;
}): Route {
  const base = route(input.category, input.retrievalScore, input.selfCertainty);
  if (base.status === "escalated" && base.reason?.startsWith("category:")) return base;
  if (input.useSafetyNet !== false) {
    const hit = safetyNet(input.text);
    if (hit) return { status: "escalated", confidence: base.confidence, reason: `safety_net:${hit.category}` };
  }
  return base;
}

/**
 * Retrieval score from the vector search itself, instead of the model's own
 * opinion of its search results: the best cosine similarity any search_docs /
 * check_pricing call returned, rescaled from the band where this corpus's
 * similarities actually live onto 0–1 so the 0.6/0.4 blend and the 0.8
 * threshold still mean something. FLOOR/CEIL come from the unlabeled
 * distribution of best-match similarities in the eval (≈ its 10th / 90th
 * percentiles), never from the labels.
 */
export const COSINE_FLOOR = 0.3;
export const COSINE_CEIL = 0.7;

export function cosineRetrievalScore(similarities: number[], floor = COSINE_FLOOR, ceil = COSINE_CEIL): number {
  const finite = similarities.filter((s) => Number.isFinite(s));
  if (finite.length === 0) return 0;
  const best = Math.max(...finite);
  return Math.min(1, Math.max(0, (best - floor) / (ceil - floor)));
}
