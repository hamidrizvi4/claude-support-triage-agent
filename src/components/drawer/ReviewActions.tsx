"use client";

import { useState, useTransition } from "react";
import { submitReview } from "@/app/actions";
import type { QueueTicket, ReviewAction } from "@/lib/data/types";
import styles from "./drawer.module.css";

export function ReviewActions({
  ticket,
  editing,
  editedText,
  onEdit,
  onCancelEdit,
  onSubmitted,
}: {
  ticket: QueueTicket;
  editing: boolean;
  editedText: string;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSubmitted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hasDraft = ticket.draftText.trim().length > 0;

  function run(action: ReviewAction) {
    setError(null);
    startTransition(async () => {
      const result = await submitReview({
        ticketId: ticket.id,
        action,
        editedResponse: action === "edit_and_approve" ? editedText : null,
      });
      if (result.ok) {
        onSubmitted();
      } else {
        setError(result.error);
      }
    });
  }

  if (ticket.reviewed) {
    return (
      <div className={styles.footer}>
        <span className={styles.reviewedBanner}>
          <span aria-hidden="true">✓</span> Reviewed — already actioned by a human.
        </span>
      </div>
    );
  }

  if (!hasDraft) {
    return (
      <div className={styles.footer}>
        <p className={styles.footerNote}>
          No draft to action — the agent never produced a response for this
          ticket.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.footer}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!error &&
        (editing ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={onCancelEdit}
            disabled={pending}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => run("reject")}
            disabled={pending}
          >
            Reject
          </button>
        ))}

      <div className={styles.footerGroup}>
        {editing ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => run("edit_and_approve")}
            disabled={pending || editedText.trim().length === 0}
          >
            {pending ? "Saving…" : "Save & approve"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={onEdit}
              disabled={pending}
            >
              Edit &amp; approve
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => run("approve")}
              disabled={pending}
            >
              {pending ? "Saving…" : "Approve"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
