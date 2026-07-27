import { CONFIDENCE_THRESHOLD, type Citation } from "@/lib/data/types";

/**
 * Drafts link citations with a fragment (`...#specifying-client-tools`) while
 * `citations[].source_url` is the bare page, so neither side is reliably the
 * longer string — match on either being a prefix of the other.
 */
export function matchCitation(
  url: string,
  citations: Citation[]
): Citation | undefined {
  return citations.find(
    (c) => url.startsWith(c.source_url) || c.source_url.startsWith(url)
  );
}

/**
 * The two weighted contributions to `confidence`, as percentages of a 0..1
 * track. They must sum to exactly confidence * 100 or the bar lies.
 */
export function confidenceSegments(retrieval: number, certainty: number) {
  return {
    retrievalPct: 60 * retrieval,
    certaintyPct: 40 * certainty,
    thresholdPct: CONFIDENCE_THRESHOLD * 100,
  };
}
