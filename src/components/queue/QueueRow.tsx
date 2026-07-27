"use client";

import { forwardRef } from "react";
import {
  ALWAYS_ESCALATE,
  categoryLabel,
  confidenceTone,
  outcomeLabel,
  reasonLabel,
  type QueueTicket,
} from "@/lib/data/types";
import styles from "./queue.module.css";

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.34524, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

function relativeTime(iso: string): string {
  let delta = (Date.parse(iso) - Date.now()) / 1000;
  for (const [amount, unit] of DIVISIONS) {
    if (Math.abs(delta) < amount) return RTF.format(Math.round(delta), unit);
    delta /= amount;
  }
  return "";
}

const DOT_CLASS = {
  resolved: styles.dotResolved,
  escalated: styles.dotEscalated,
  incomplete: styles.dotIncomplete,
  rate_limited: styles.dotRateLimited,
} as const;

const SCORE_CLASS = {
  resolve: styles.scoreResolve,
  escalate: styles.scoreEscalate,
  critical: styles.scoreCritical,
  muted: styles.scoreMuted,
} as const;

type Props = {
  ticket: QueueTicket;
  active: boolean;
  onOpen: () => void;
  onFocus: () => void;
};

export const QueueRow = forwardRef<HTMLButtonElement, Props>(function QueueRow(
  { ticket, active, onOpen, onFocus },
  ref
) {
  // Only a completed run has a confidence worth colour-coding; a 429 or a
  // missing submit_resolution stores 0, which would read as a real red score.
  const decided = ticket.outcome === "resolved" || ticket.outcome === "escalated";
  const tone = decided ? confidenceTone(ticket.confidence) : "muted";
  const timestamp = ticket.draftedAt ?? ticket.createdAt;

  return (
    <li>
      <button
        ref={ref}
        type="button"
        onClick={onOpen}
        onFocus={onFocus}
        aria-current={active ? "true" : undefined}
        className={[
          styles.row,
          active ? styles.rowActive : "",
          ticket.outcome === "rate_limited" ? styles.rowRateLimited : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className={styles.subjectCell}>
          <span
            className={`${styles.dot} ${DOT_CLASS[ticket.outcome]}`}
            aria-hidden="true"
          />
          <span className={styles.subject}>{ticket.subject}</span>
          {ticket.outcome === "rate_limited" && (
            <span className={styles.limitTag}>rate limited</span>
          )}
          {ticket.reviewed && <span className={styles.reviewedTag}>reviewed</span>}
        </span>

        <span
          className={[
            styles.pill,
            ticket.category == null
              ? styles.pillMuted
              : ALWAYS_ESCALATE.has(ticket.category)
                ? styles.pillEscalate
                : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {categoryLabel(ticket.category)}
        </span>

        <span className={styles.reason}>{reasonLabel(ticket.escalationReason)}</span>

        <span className={`${styles.score} ${SCORE_CLASS[tone]}`}>
          {decided && ticket.confidence != null
            ? ticket.confidence.toFixed(2)
            : "—"}
          <span className="srOnly">
            {decided && ticket.confidence != null
              ? ` confidence, ${outcomeLabel(ticket.outcome)}`
              : ` no confidence score, ${outcomeLabel(ticket.outcome)}`}
          </span>
        </span>

        {/* Server and client render this milliseconds apart; at hour/day
            granularity the string is identical, so suppress the theoretical diff. */}
        <time className={styles.time} dateTime={timestamp} suppressHydrationWarning>
          {relativeTime(timestamp)}
        </time>
      </button>
    </li>
  );
});
