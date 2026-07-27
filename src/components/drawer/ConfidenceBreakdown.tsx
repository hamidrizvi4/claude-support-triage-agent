import {
  ALWAYS_ESCALATE,
  CONFIDENCE_THRESHOLD,
  categoryLabel,
  confidenceTone,
  type QueueTicket,
} from "@/lib/data/types";
import { confidenceSegments } from "./logic";
import styles from "./drawer.module.css";

const TONE_VAR: Record<string, string> = {
  resolve: "var(--resolve)",
  escalate: "var(--escalate)",
  critical: "var(--critical)",
  muted: "var(--text-secondary)",
};

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Shows *why* a ticket landed where it did: the two weighted contributions
 * that make up `confidence`, against the 0.80 auto-resolve threshold.
 */
export function ConfidenceBreakdown({ ticket }: { ticket: QueueTicket }) {
  const retrieval = ticket.retrievalScore ?? 0;
  const certainty = ticket.selfCertainty ?? 0;
  const confidence = ticket.confidence ?? 0;

  // Each segment is its weighted contribution, so the two together span
  // exactly `confidence` of the track.
  const { retrievalPct, certaintyPct, thresholdPct } = confidenceSegments(
    retrieval,
    certainty
  );

  const tone = confidenceTone(ticket.confidence);
  const categoryForced = ticket.category
    ? ALWAYS_ESCALATE.has(ticket.category)
    : false;

  let verdict: React.ReactNode;
  if (categoryForced) {
    verdict = (
      <>
        <span className={styles.verdictStrong}>Routed by category.</span>{" "}
        {categoryLabel(ticket.category)} always goes to a human, whatever the
        score says.
      </>
    );
  } else if (confidence >= CONFIDENCE_THRESHOLD) {
    verdict = (
      <>
        <span className={styles.verdictStrong}>Cleared the threshold</span> by{" "}
        {fmt(confidence - CONFIDENCE_THRESHOLD)} — auto-resolved.
      </>
    );
  } else {
    verdict = (
      <>
        <span className={styles.verdictStrong}>Short of the threshold</span> by{" "}
        {fmt(CONFIDENCE_THRESHOLD - confidence)} — escalated for review.
      </>
    );
  }

  return (
    <div
      className={styles.confidence}
      style={{ "--tone": TONE_VAR[tone] } as React.CSSProperties}
    >
      <p className={styles.formula}>
        0.6 × <span className={styles.formulaValue}>{fmt(retrieval)}</span> + 0.4 ×{" "}
        <span className={styles.formulaValue}>{fmt(certainty)}</span> ={" "}
        <span className={styles.formulaValue}>{fmt(confidence)}</span>
      </p>

      <div>
        <div
          className={styles.track}
          role="img"
          aria-label={`Confidence ${fmt(confidence)} of a possible 1.00. Retrieval contributes ${fmt(
            retrievalPct / 100
          )}, self-certainty contributes ${fmt(
            certaintyPct / 100
          )}. Auto-resolve threshold is ${fmt(CONFIDENCE_THRESHOLD)}.`}
        >
          <div
            className={styles.segRetrieval}
            style={{ width: `${retrievalPct}%` }}
          />
          <div
            className={styles.segCertainty}
            style={{ width: `${certaintyPct}%` }}
          />
          <div className={styles.threshold} style={{ left: `${thresholdPct}%` }} />
        </div>
        <div className={styles.thresholdRow} aria-hidden="true">
          <span className={styles.thresholdLabel} style={{ left: `${thresholdPct}%` }}>
            {fmt(CONFIDENCE_THRESHOLD)} auto-resolve
          </span>
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchRetrieval}`} />
          retrieval 0.6 ×{" "}
          <span className={styles.legendValue}>{fmt(retrieval)}</span>
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchCertainty}`} />
          certainty 0.4 ×{" "}
          <span className={styles.legendValue}>{fmt(certainty)}</span>
        </span>
      </div>

      <p className={styles.verdict}>{verdict}</p>
    </div>
  );
}
