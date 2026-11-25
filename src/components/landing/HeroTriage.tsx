"use client";

import { useEffect, useState } from "react";
import { CONFIDENCE_THRESHOLD, route } from "@/lib/agent/routing";
import { categoryLabel, reasonLabel } from "@/lib/data/types";
import styles from "./landing.module.css";

/**
 * Hero loop: one synthetic ticket at a time goes through the agent's steps,
 * then the real `route()` from src/lib/agent/routing.ts decides the outcome.
 * The verdict is computed, not hard-coded, so the copy can never drift from
 * the routing rules it illustrates.
 */
type Scenario = {
  n: number;
  subject: string;
  body: string;
  category: string;
  tools: { name: string; out: string }[];
  retrieval: number;
  certainty: number;
};

const SCENARIOS: Scenario[] = [
  {
    n: 7,
    subject: "Streaming responses cutting off mid-sentence",
    body: "Long completions stop partway with no error. Using stream=true with the Python SDK.",
    category: "technical_api_error",
    tools: [
      { name: "search_docs", out: "5 chunks · streaming, max_tokens, stop_reason" },
      { name: "check_status", out: "no active incidents" },
    ],
    retrieval: 0.88,
    certainty: 0.85,
  },
  {
    n: 18,
    subject: "Refund request — runaway batch job burned $200+ in 2 hours",
    body: "A loop in our batch script resubmitted the same jobs. Can these charges be reversed?",
    category: "billing",
    tools: [
      { name: "lookup_account", out: "mocked account · plan tier, usage, limits" },
      { name: "search_docs", out: "5 chunks · batch processing, billing" },
      { name: "check_pricing", out: "batch rates for the model in use" },
    ],
    retrieval: 0.6,
    certainty: 0.7,
  },
  {
    n: 31,
    subject: "Rate limit headers missing on 429 responses",
    body: "We get 429s but don't see retry-after in the response headers we log.",
    category: "technical_api_error",
    tools: [
      { name: "search_docs", out: "5 chunks · rate limits, response headers" },
      { name: "check_status", out: "no active incidents" },
    ],
    retrieval: 0.74,
    certainty: 0.79,
  },
];

const STEP_MS = 750;
const HOLD_MS = 2800;

export function HeroTriage() {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState(0);
  const s = SCENARIOS[index];

  // Phases: 0 = ticket only, 1..tools = each tool call, then submit_resolution,
  // then the meter fills, then the verdict lands, then hold and advance.
  const submitPhase = s.tools.length + 1;
  const meterPhase = submitPhase + 1;
  const verdictPhase = meterPhase + 1;

  useEffect(() => {
    const delay = phase === verdictPhase ? HOLD_MS : STEP_MS;
    const id = window.setTimeout(() => {
      if (phase >= verdictPhase) {
        setIndex((i) => (i + 1) % SCENARIOS.length);
        setPhase(0);
      } else {
        setPhase((p) => p + 1);
      }
    }, delay);
    return () => window.clearTimeout(id);
  }, [phase, verdictPhase]);

  const r = route(s.category, s.retrieval, s.certainty);
  const resolved = r.status === "auto_resolved";
  const steps = [
    ...s.tools,
    {
      name: "submit_resolution",
      out: `${s.category} · retrieval ${s.retrieval.toFixed(2)} · certainty ${s.certainty.toFixed(2)}`,
    },
  ];
  const meterOn = phase >= meterPhase;

  return (
    <div className={`glassPanel ${styles.triage}`} aria-label="Animated example of one ticket being triaged">
      <div className={styles.triageHead}>
        <span className={styles.liveDot} aria-hidden="true" />
        run-triage
        <span className={styles.triageCount}>ticket {String(s.n).padStart(2, "0")} / 40</span>
      </div>

      <div className={styles.triageBody} key={index}>
        <div className={styles.ticket}>
          <div className={styles.ticketMeta}>
            <span>SUBJECT</span>
            <span>·</span>
            <span>synthetic ticket</span>
          </div>
          <div className={styles.ticketSubject}>{s.subject}</div>
          <div className={styles.ticketBody}>{s.body}</div>
        </div>

        <ol className={styles.steps}>
          {steps.map((step, i) => (
            <li key={step.name + i} className={`${styles.step} ${phase > i ? styles.stepOn : ""}`}>
              <span className={styles.stepIcon} aria-hidden="true">
                {phase > i && (
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5.2 4.1 7.2 8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className={styles.stepName}>{step.name}</span>
              <span className={styles.stepOut}>{step.out}</span>
            </li>
          ))}
        </ol>

        <div className={styles.meter}>
          <div className={styles.meterTop}>
            <span>confidence = 0.6·retrieval + 0.4·certainty</span>
            <span className={styles.meterValue}>{meterOn ? r.confidence.toFixed(2) : "—"}</span>
          </div>
          <div className={styles.track}>
            <div
              className={`${styles.fill} ${meterOn ? (resolved ? styles.fillResolve : styles.fillEscalate) : ""}`}
              style={{ width: meterOn ? `${r.confidence * 100}%` : "0%" }}
            />
            <div className={styles.threshold} style={{ left: `${CONFIDENCE_THRESHOLD * 100}%` }}>
              <span className={styles.thresholdLabel}>auto-resolve ≥ {CONFIDENCE_THRESHOLD}</span>
            </div>
          </div>
        </div>

        <div className={styles.verdictRow} aria-live="polite">
          {phase >= verdictPhase ? (
            <>
              <span className={`${styles.verdict} ${resolved ? styles.verdictResolve : styles.verdictEscalate}`}>
                {resolved
                  ? "Auto-resolved"
                  : `Escalated · ${
                      r.reason?.startsWith("category:") ? categoryLabel(s.category) : reasonLabel(r.reason)
                    }`}
              </span>
              <span className={styles.verdictBy}>
                {r.reason?.startsWith("category:")
                  ? `${categoryLabel(s.category)} is always human-reviewed`
                  : "decided by route(), not the model"}
              </span>
            </>
          ) : (
            <span className={styles.verdictBy}>
              {phase >= submitPhase ? "routing…" : "agent working…"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
