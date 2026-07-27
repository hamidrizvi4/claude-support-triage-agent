"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALWAYS_ESCALATE,
  categoryLabel,
  confidenceTone,
  outcomeLabel,
  reasonLabel,
  type QueueTicket,
  type ToolCall,
} from "@/lib/data/types";
import { ConfidenceBreakdown } from "./ConfidenceBreakdown";
import { DraftBody } from "./DraftBody";
import { ReasoningTrace } from "./ReasoningTrace";
import { ReviewActions } from "./ReviewActions";
import styles from "./drawer.module.css";

const EXIT_MS = 180;

const TONE_CLASS: Record<string, string> = {
  resolve: styles.toneResolve,
  escalate: styles.toneEscalate,
  critical: styles.toneCritical,
  muted: styles.toneMuted,
};

function outcomePillClass(outcome: QueueTicket["outcome"]): string {
  if (outcome === "resolved") return styles.pillResolve;
  if (outcome === "escalated") return styles.pillEscalate;
  return styles.pillNeutral;
}

export function TicketDrawer({
  ticket,
  toolCalls,
  onClose,
}: {
  ticket: QueueTicket | null;
  toolCalls: ToolCall[];
  onClose: () => void;
}): React.JSX.Element {
  // Keep the last ticket on screen while the exit animation plays.
  const [shown, setShown] = useState<QueueTicket | null>(ticket);
  // Editing is keyed to a ticket id so opening a different ticket resets it.
  const [edit, setEdit] = useState<{
    id: string | null;
    editing: boolean;
    text: string;
  }>({ id: ticket?.id ?? null, editing: false, text: ticket?.draftText ?? "" });

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Derived resets during render — React's sanctioned alternative to
  // synchronising props into state inside an effect.
  if (ticket && ticket !== shown) setShown(ticket);
  if (ticket && edit.id !== ticket.id) {
    setEdit({ id: ticket.id, editing: false, text: ticket.draftText });
  }

  const isOpen = ticket !== null;
  const exiting = !isOpen && shown !== null;

  // Unmount only after the exit animation has run.
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setShown(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  useEffect(() => {
    if (!isOpen) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [isOpen]);

  // Document-level so Escape still closes when focus sits on the scrim.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen, onClose]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    []
  );

  if (!shown) return <></>;

  const hasResolution = shown.outcome === "resolved" || shown.outcome === "escalated";
  const hasDraft = shown.draftText.trim().length > 0;
  const categoryForced = shown.category ? ALWAYS_ESCALATE.has(shown.category) : false;
  const tone = confidenceTone(shown.confidence);

  return (
    <>
      <div
        className={`${styles.scrim} ${exiting ? styles.scrimExit : styles.scrimEnter}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`glassPanel ${styles.panel} ${exiting ? styles.panelExit : styles.panelEnter}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-subject"
        onKeyDown={handleKeyDown}
      >
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <h2 id="drawer-subject" className={styles.subject}>
              {shown.subject}
            </h2>
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label="Close ticket detail"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M3.5 3.5l7 7m0-7l-7 7"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className={styles.headerMeta}>
            <span
              className={`${styles.pill} ${
                categoryForced ? styles.pillEscalate : styles.pillNeutral
              }`}
            >
              {categoryLabel(shown.category)}
            </span>
            <span className={`${styles.pill} ${outcomePillClass(shown.outcome)}`}>
              {outcomeLabel(shown.outcome)}
            </span>
            {hasResolution && (
              <span className={`${styles.confidenceBig} ${TONE_CLASS[tone]}`}>
                {shown.confidence?.toFixed(2) ?? "—"}
              </span>
            )}
          </div>

          {shown.escalationReason && hasResolution && (
            <p className={styles.sectionNote} style={{ marginTop: "var(--space-3)" }}>
              {reasonLabel(shown.escalationReason)}
            </p>
          )}
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Original ticket</h3>
              {shown.accountId && (
                <span className={styles.sectionNote}>
                  acct {shown.accountId.slice(0, 8)}
                </span>
              )}
            </div>
            <p className={styles.ticketBody}>{shown.body}</p>
          </section>

          {!hasResolution && (
            <section className={styles.section}>
              <div className={styles.notice}>
                {shown.outcome === "rate_limited" ? (
                  <>
                    <span className={styles.noticeTitle}>
                      Run stopped by the provider, not the agent
                    </span>
                    OpenRouter returned HTTP 429 before a resolution could be
                    produced. This is an infrastructure limit — it is excluded
                    from every dashboard statistic and is not an agent decision.
                  </>
                ) : (
                  <>
                    <span className={styles.noticeTitle}>
                      Agent never submitted a resolution
                    </span>
                    The model ran its tools but did not call{" "}
                    <code className={styles.code}>submit_resolution</code> within
                    the 8-turn budget. The free-tier model misses the forced tool
                    call on roughly 40–45% of tickets; the ticket was escalated to
                    a human rather than guessed at.
                  </>
                )}
                {shown.escalationReason && (
                  <span className={styles.noticeCode}>
                    <br />
                    {shown.escalationReason}
                  </span>
                )}
              </div>
            </section>
          )}

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Reasoning trace</h3>
              <span className={styles.sectionNote}>
                {toolCalls.length} call{toolCalls.length === 1 ? "" : "s"}
                {shown.latencySeconds != null
                  ? ` · ${shown.latencySeconds.toFixed(1)}s`
                  : ""}
              </span>
            </div>
            <ReasoningTrace calls={toolCalls} />
          </section>

          {hasResolution && (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>Confidence breakdown</h3>
              </div>
              <ConfidenceBreakdown ticket={shown} />
            </section>
          )}

          {hasDraft && (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>
                  {edit.editing ? "Editing draft" : "Draft response"}
                </h3>
                <span className={styles.sectionNote}>
                  {shown.citations.length} citation
                  {shown.citations.length === 1 ? "" : "s"}
                </span>
              </div>
              {edit.editing ? (
                <>
                  <textarea
                    className={styles.editor}
                    value={edit.text}
                    onChange={(e) =>
                      setEdit((prev) => ({ ...prev, text: e.target.value }))
                    }
                    aria-label="Edit draft response"
                  />
                  <p className={styles.editorHint}>
                    Your edit is stored with the review, the original draft is
                    kept intact.
                  </p>
                </>
              ) : (
                <DraftBody text={shown.draftText} citations={shown.citations} />
              )}
            </section>
          )}
        </div>

        <ReviewActions
          ticket={shown}
          editing={edit.editing}
          editedText={edit.text}
          onEdit={() =>
            setEdit({ id: shown.id, editing: true, text: shown.draftText })
          }
          onCancelEdit={() => setEdit((prev) => ({ ...prev, editing: false }))}
          onSubmitted={onClose}
        />
      </div>
    </>
  );
}
