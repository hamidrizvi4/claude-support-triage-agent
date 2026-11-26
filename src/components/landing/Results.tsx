"use client";

import { useState } from "react";
import summaryJson from "../../../evals/results/summary.json";
import styles from "./landing.module.css";

/**
 * Model and provider comparison from the latest labeled eval runs. Everything
 * here comes from evals/results/summary.json (written by `npm run eval:report`),
 * scored under the shipped routing, so it can't drift from the measured runs.
 * Only the "before the eval" note is a fixed historical figure.
 */
type Range = { mean: number; min: number; max: number };
type Counts = { tp: number; fp: number; fn: number; tn: number };
type Core = {
  runs: number;
  completedRuns: number;
  seedsRun: number;
  completion: Range;
  variants: { key: string; escalationRecall: Range; escalationRecallCI: [number, number]; pooled: Counts }[];
  cost: { total: number; perTicket: number };
  latencyS: number;
};
type Summary = {
  status: string;
  primary: string;
  shipped: string;
  dataset: { core: number };
  perModel: Record<string, { core: Core }>;
  exacto?: { completionP: number; escalationRecallP: number };
};
const summary = summaryJson as unknown as Summary;

const VIEWS = ["Outcome mix", "Must-escalate recall", "Cost per ticket"] as const;
type View = (typeof VIEWS)[number];

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

function rows() {
  const models = Object.keys(summary.perModel).sort((a, b) => (a === summary.primary ? -1 : b === summary.primary ? 1 : a.localeCompare(b)));
  return models.map((m) => {
    const c = summary.perModel[m].core;
    const v = c.variants.find((x) => x.key === summary.shipped)!;
    const auto = v.pooled.fn + v.pooled.tn;
    const incomplete = c.runs - c.completedRuns;
    const escalated = c.runs - auto - incomplete;
    const exacto = m.endsWith(":exacto");
    const name = m.split("/")[1].replace(":exacto", "");
    const seeds = `${c.seedsRun} seed${c.seedsRun === 1 ? "" : "s"}`;
    return {
      key: m,
      name,
      sub: m === summary.primary ? `headline · ${seeds}` : `${exacto ? ":exacto" : "default"} · ${seeds}`,
      runs: c.runs,
      auto: auto / c.runs,
      escalated: escalated / c.runs,
      incomplete: incomplete / c.runs,
      recall: v.escalationRecall.mean,
      ci: v.escalationRecallCI,
      cost: c.cost.perTicket,
      latency: c.latencyS,
    };
  });
}

export function Results() {
  const [view, setView] = useState<View>("Outcome mix");
  if (summary.status !== "complete") return null;
  const vi = VIEWS.indexOf(view);
  const data = rows();
  const maxCost = Math.max(...data.map((d) => d.cost));
  const ex = summary.exacto;

  return (
    <div className={styles.results}>
      <div>
        <div className={styles.selectRow}>
          <div className={styles.selectLike}>
            <span className={styles.selectDot} aria-hidden="true" />
            Latest labeled runs · {summary.dataset.core} tickets · shipped routing
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
            {data.map((run) => (
              <div className={styles.barRow} key={run.key}>
                <div className={styles.barLabel}>
                  {run.name}
                  <span>{run.sub}</span>
                </div>
                {view === "Outcome mix" && (
                  <div
                    className={styles.stack}
                    aria-label={`${pct(run.auto)} auto-resolved, ${pct(run.escalated)} escalated, ${pct(run.incomplete)} incomplete, of ${run.runs} runs`}
                  >
                    <div className={`${styles.stackSeg} ${styles.segResolve}`} style={{ width: `${run.auto * 100}%` }}>
                      {pct(run.auto)}
                    </div>
                    <div className={`${styles.stackSeg} ${styles.segEscalate}`} style={{ width: `${run.escalated * 100}%`, animationDelay: "80ms" }}>
                      {pct(run.escalated)}
                    </div>
                    <div
                      className={`${styles.stackSeg} ${styles.segIncomplete}`}
                      style={{ width: `${run.incomplete * 100}%`, animationDelay: "160ms" }}
                    >
                      {run.incomplete >= 0.08 ? pct(run.incomplete) : ""}
                    </div>
                  </div>
                )}
                {view === "Must-escalate recall" && (
                  <div className={styles.single}>
                    <div className={styles.ciTrack} aria-label={`${pct(run.recall, 1)}, 95% CI ${pct(run.ci[0])} to ${pct(run.ci[1])}`}>
                      <div className={`${styles.singleBar} ${styles.segResolve}`} style={{ width: `${run.recall * 100}%` }} />
                      <span className={styles.ciWhisker} style={{ left: `${run.ci[0] * 100}%`, width: `${(run.ci[1] - run.ci[0]) * 100}%` }} />
                    </div>
                    <span className={styles.singleVal}>{pct(run.recall, 1)}</span>
                  </div>
                )}
                {view === "Cost per ticket" && (
                  <div className={styles.single}>
                    <div className={styles.singleBar} style={{ width: `${(run.cost / maxCost) * 62}%`, background: "var(--text-primary)" }} />
                    <span className={styles.singleVal}>
                      ${run.cost.toFixed(4)} · {run.latency.toFixed(0)}s
                    </span>
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
              {view === "Outcome mix" && "share of runs · incomplete = no valid submit_resolution"}
              {view === "Must-escalate recall" && "whisker = 95% interval, resampling tickets · higher is safer"}
              {view === "Cost per ticket" && "OpenRouter-reported cost per ticket · mean latency"}
            </p>
          </div>
        </div>
      </div>

      <div className={styles.about}>
        <h3>Same tickets, same routing, different models</h3>
        <p>
          Every row ran the same {summary.dataset.core} labeled tickets through the same tools, prompt and routing. The
          two <code>gpt-oss-120b</code>{" "}rows differ only in OpenRouter&apos;s provider routing, so that gap is
          Exacto&apos;s, not the model&apos;s.
          {ex && (
            <>
              {" "}Exacto raised completion (p = {ex.completionP.toFixed(3)}); its recall difference is not significant
              (p = {ex.escalationRecallP.toFixed(2)}).
            </>
          )}{" "}
          A finished run that escalates is fine. An unfinished one costs a reviewer the draft.
        </p>
        <div className={styles.method}>
          <h4>Methodology</h4>
          <ul className={styles.methodList}>
            <li>
              <b>Dataset:</b> {summary.dataset.core} synthetic, LLM-generated tickets with hand-written gold routes. None are scraped
              from real users.
            </li>
            <li>
              <b>Scoring:</b>{" "}the shipped routing, recomputed offline from each run&apos;s raw output. Incomplete runs count as
              escalated, which is what production does with them.
            </li>
            <li>
              <b>Cost:</b>{" "}OpenRouter&apos;s own per-request usage accounting, not a price-sheet estimate.
            </li>
            <li>
              <b>Before the eval:</b> one unlabeled run each. Free <code>nemotron-3-ultra</code> left 20 of 40 tickets
              incomplete; paid <code>deepseek-v3.2:exacto</code> left 3, for $0.25. That run changed the model and the provider
              routing together, and it is the dataset the live demo queue still shows.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
