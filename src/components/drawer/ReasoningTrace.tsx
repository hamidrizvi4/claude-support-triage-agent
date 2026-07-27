"use client";

import { useState } from "react";
import type { ToolCall } from "@/lib/data/types";
import styles from "./drawer.module.css";

function stringify(value: unknown): string {
  if (value == null) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in (output as Record<string, unknown>)
  );
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
}

function Entry({ call, index }: { call: ToolCall; index: number }) {
  const [open, setOpen] = useState(false);
  const failed = isError(call.output);

  return (
    <div className={styles.traceEntry}>
      <button
        type="button"
        className={styles.traceHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.traceIndex}>{String(index + 1).padStart(2, "0")}</span>
        <span className={failed ? styles.traceError : undefined}>
          {call.toolName}
          {failed ? " ✕" : ""}
        </span>
        <span className={styles.traceCaret} aria-hidden="true">
          {open ? "▼" : "▶"}
        </span>
        <span className={styles.traceTime}>{clockTime(call.createdAt)}</span>
      </button>

      {open && (
        <>
          <div className={styles.traceJson}>
            <span className={styles.traceJsonLabel}>input</span>
            {stringify(call.input)}
          </div>
          <div className={styles.traceJson}>
            <span className={styles.traceJsonLabel}>output</span>
            {stringify(call.output)}
          </div>
        </>
      )}
    </div>
  );
}

export function ReasoningTrace({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) {
    return (
      <p className={styles.notice}>
        <span className={styles.noticeTitle}>No tool calls recorded</span>
        The run failed before the agent reached its first tool.
      </p>
    );
  }

  return (
    <div className={styles.trace}>
      {calls.map((call, i) => (
        <Entry key={call.id} call={call} index={i} />
      ))}
    </div>
  );
}
