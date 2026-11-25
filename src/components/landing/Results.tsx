"use client";

import { useState } from "react";
import styles from "./landing.module.css";

/**
 * Free vs paid run on the identical 40-ticket set — the numbers are the
 * verified figures from the README / case study, not live queries, so this
 * section reads the same no matter what state the demo database is in.
 */
const RUNS = [
  {
    model: "nemotron-3-ultra",
    sub: ":free · $0",
    resolved: 8,
    escalated: 12,
    incomplete: 20,
    cost: 0,
  },
  {
    model: "deepseek-v3.2",
    sub: ":exacto · paid",
    resolved: 15,
    escalated: 22,
    incomplete: 3,
    cost: 0.25,
  },
];
const TOTAL = 40;

const VIEWS = ["Outcome mix", "Incomplete rate", "Cost per run"] as const;
type View = (typeof VIEWS)[number];

export function Results() {
  const [view, setView] = useState<View>("Outcome mix");
  const vi = VIEWS.indexOf(view);

  return (
    <div className={styles.results}>
      <div>
        <div className={styles.selectRow}>
          <div className={styles.selectLike}>
            <span className={styles.selectDot} aria-hidden="true" />
            Free vs paid orchestration · same 40 tickets
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            aria-label="Previous view"
            onClick={() => setView(VIEWS[(vi + VIEWS.length - 1) % VIEWS.length])}
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            aria-label="Next view"
            onClick={() => setView(VIEWS[(vi + 1) % VIEWS.length])}
          >
            ›
          </button>
        </div>

        <div className={styles.card}>
          <div className={styles.tabs} role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={`${styles.tab} ${view === v ? styles.tabOn : ""}`}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>

          <div className={styles.chartBody} key={view} role="tabpanel">
            {RUNS.map((run) => (
              <div className={styles.barRow} key={run.model}>
                <div className={styles.barLabel}>
                  {run.model}
                  <span>{run.sub}</span>
                </div>
                {view === "Outcome mix" && (
                  <div className={styles.stack} aria-label={`${run.resolved} resolved, ${run.escalated} escalated, ${run.incomplete} incomplete`}>
                    <div className={`${styles.stackSeg} ${styles.segResolve}`} style={{ width: `${(run.resolved / TOTAL) * 100}%` }}>
                      {run.resolved}
                    </div>
                    <div
                      className={`${styles.stackSeg} ${styles.segEscalate}`}
                      style={{ width: `${(run.escalated / TOTAL) * 100}%`, animationDelay: "80ms" }}
                    >
                      {run.escalated}
                    </div>
                    <div
                      className={`${styles.stackSeg} ${styles.segIncomplete}`}
                      style={{ width: `${(run.incomplete / TOTAL) * 100}%`, animationDelay: "160ms" }}
                    >
                      {run.incomplete}
                    </div>
                  </div>
                )}
                {view === "Incomplete rate" && (
                  <div className={styles.single}>
                    <div
                      className={`${styles.singleBar} ${styles.segIncomplete}`}
                      style={{ width: `${(run.incomplete / TOTAL) * 100}%` }}
                    />
                    <span className={styles.singleVal}>{((run.incomplete / TOTAL) * 100).toFixed(1)}%</span>
                  </div>
                )}
                {view === "Cost per run" && (
                  <div className={styles.single}>
                    <div
                      className={styles.singleBar}
                      style={{
                        width: run.cost === 0 ? "2px" : "62%",
                        background: run.cost === 0 ? "var(--border-strong)" : "var(--text-primary)",
                      }}
                    />
                    <span className={styles.singleVal}>${run.cost.toFixed(2)}</span>
                  </div>
                )}
              </div>
            ))}

            {view === "Outcome mix" && (
              <div className={styles.legendRow}>
                <span>
                  <i className={`${styles.sw} ${styles.segResolve}`} /> auto-resolved
                </span>
                <span>
                  <i className={`${styles.sw} ${styles.segEscalate}`} /> escalated
                </span>
                <span>
                  <i className={`${styles.sw} ${styles.segIncomplete}`} /> incomplete
                </span>
              </div>
            )}
            <p className={styles.axisNote}>
              {view === "Outcome mix" && "tickets out of 40"}
              {view === "Incomplete rate" && "no submit_resolution call · lower is better"}
              {view === "Cost per run" && "full 40-ticket run · OpenRouter key usage"}
            </p>
          </div>
        </div>
      </div>

      <div className={styles.about}>
        <h3>What this experiment tests</h3>
        <p>
          The agent defaults to a free model, so I measured what that costs. I ran the same tickets
          through the same routing formula twice and changed only the model. Half the free
          runs never finished: the model skipped its own required output call. Exacto routing cut
          that to 3 of 40, and the whole paid run cost a quarter.
        </p>
        <div className={styles.method}>
          <h4>Methodology</h4>
          <ul className={styles.methodList}>
            <li>
              <b>Dataset:</b> 40 synthetic, LLM-generated support tickets. None are scraped from real users.
            </li>
            <li>
              <b>Variable:</b> the orchestration model only, set with <code>OPENROUTER_MODEL</code>. Tools, prompt,
              threshold and routing are identical.
            </li>
            <li>
              <b>Incomplete:</b> the run ended without a valid <code>submit_resolution</code> call. On the paid run,
              that&apos;s 2 missing calls plus 1 argument payload truncated at <code>max_tokens</code>.
            </li>
            <li>
              <b>Why Exacto:</b> OpenRouter&apos;s tool-calling-accuracy routing isn&apos;t offered on <code>:free</code>{" "}
              slugs, so no config change can fix the free run at $0.
            </li>
            <li>
              <b>Cost:</b> read from OpenRouter&apos;s key-usage API after the run, not estimated from a price sheet.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
