"use client";

import { useState } from "react";
import { CONFIDENCE_THRESHOLD, ESCALATE_CATEGORIES, route } from "@/lib/agent/routing";
import { categoryLabel } from "@/lib/data/types";
import styles from "./landing.module.css";

/**
 * Interactive routing calculator. It imports the same `route()` the agent
 * runs in production, so whatever this panel shows is what the router does.
 */
const CATEGORIES = [
  "technical_api_error",
  "feature_question",
  "account_access",
  "billing",
  "security_abuse",
  "sales_enterprise",
  "bug_report",
];

// Plane geometry: unit square mapped onto a 280×280 plot.
const P = 280;
const PAD_L = 40;
const PAD_T = 14;
const x = (v: number) => PAD_L + v * P;
const y = (v: number) => PAD_T + (1 - v) * P;
// 0.6·r + 0.4·c = 0.8 crosses c = 1 at r = 2/3 and r = 1 at c = 0.5.
const R_AT_C1 = (CONFIDENCE_THRESHOLD - 0.4) / 0.6;
const C_AT_R1 = (CONFIDENCE_THRESHOLD - 0.6) / 0.4;

export function RoutingLab() {
  const [retrieval, setRetrieval] = useState(0.82);
  const [certainty, setCertainty] = useState(0.9);
  const [category, setCategory] = useState("feature_question");

  const r = route(category, retrieval, certainty);
  const sensitive = ESCALATE_CATEGORIES.has(category);
  const resolved = r.status === "auto_resolved";
  const tone = resolved ? "var(--resolve)" : "var(--escalate)";
  const tint = resolved ? "var(--resolve-tint)" : "var(--escalate-tint)";
  const branch = sensitive ? 0 : resolved ? 1 : 2;

  return (
    <div className={styles.lab}>
      <div className={styles.labControls}>
        <div className={styles.control}>
          <label htmlFor="lab-retrieval">
            <span>retrieval_score · how well the docs matched</span>
            <span className={styles.controlValue}>{retrieval.toFixed(2)}</span>
          </label>
          <input
            id="lab-retrieval"
            className={styles.range}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={retrieval}
            onChange={(e) => setRetrieval(Number(e.target.value))}
          />
        </div>
        <div className={styles.control}>
          <label htmlFor="lab-certainty">
            <span>self_certainty · the model&apos;s own confidence</span>
            <span className={styles.controlValue}>{certainty.toFixed(2)}</span>
          </label>
          <input
            id="lab-certainty"
            className={styles.range}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={certainty}
            onChange={(e) => setCertainty(Number(e.target.value))}
          />
        </div>
        <div>
          <span className={styles.controlLabel}>
            <span>category · dashed = always escalates</span>
          </span>
          <div className={styles.catChips} role="radiogroup" aria-label="Ticket category">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                className={`${styles.catChip} ${ESCALATE_CATEGORIES.has(c) ? styles.catChipSensitive : ""} ${
                  category === c ? styles.catChipOn : ""
                }`}
                onClick={() => setCategory(c)}
              >
                {categoryLabel(c)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardPad}>
            <div className={styles.formula}>
              confidence = 0.6 × <b>{retrieval.toFixed(2)}</b> + 0.4 × <b>{certainty.toFixed(2)}</b> ={" "}
              <b style={{ color: tone }}>{r.confidence.toFixed(3)}</b>
            </div>
            <div className={styles.labBar} aria-hidden="true">
              <div className={styles.labSegA} style={{ width: `${0.6 * retrieval * 100}%`, background: tone }} />
              <div className={styles.labSegB} style={{ width: `${0.4 * certainty * 100}%`, background: tone }} />
              <div className={styles.threshold} style={{ left: `${CONFIDENCE_THRESHOLD * 100}%` }}>
                <span className={styles.thresholdLabel}>{CONFIDENCE_THRESHOLD}</span>
              </div>
            </div>
            <div className={styles.labLegend}>
              <span>
                <i className={styles.sw} style={{ background: tone }} /> 0.6 · retrieval
              </span>
              <span>
                <i className={styles.sw} style={{ background: tone, opacity: 0.55 }} /> 0.4 · certainty
              </span>
            </div>
          </div>
          <div className={styles.labVerdict} style={{ background: tint, color: tone, borderRadius: 0 }} aria-live="polite">
            <span>{resolved ? "Auto-resolve" : "Escalate to a human"}</span>
            <span className={styles.mono}>
              {`{ status: "${r.status}", reason: ${r.reason ? `"${r.reason}"` : "null"} }`}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.plane}>
          <svg
            viewBox={`0 0 ${PAD_L + P + 16} ${PAD_T + P + 40}`}
            className={styles.diagram}
            role="img"
            aria-label="Decision plane: retrieval on the x axis, certainty on the y axis. Only the top-right corner above the threshold line auto-resolves."
          >
            <defs>
              <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="7" height="7" fill="var(--escalate-tint)" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="var(--escalate)" strokeWidth="1" opacity="0.35" />
              </pattern>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line className={styles.planeGrid} x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} />
                <line className={styles.planeGrid} x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} />
                <text className={styles.planeAxis} x={x(t)} y={y(0) + 16} textAnchor="middle">
                  {t}
                </text>
                <text className={styles.planeAxis} x={x(0) - 8} y={y(t) + 3} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            <polygon
              className={styles.planeRegion}
              points={`${x(R_AT_C1)},${y(1)} ${x(1)},${y(1)} ${x(1)},${y(C_AT_R1)}`}
              style={{ opacity: sensitive ? 0 : 1 }}
            />
            <line className={styles.planeLine} x1={x(R_AT_C1)} y1={y(1)} x2={x(1)} y2={y(C_AT_R1)} />
            <rect
              className={styles.planeBlock}
              x={x(0)}
              y={y(1)}
              width={P}
              height={P}
              style={{ opacity: sensitive ? 0.9 : 0 }}
            />
            {sensitive ? (
              <text className={styles.planeNote} x={x(0.5)} y={y(0.5)} textAnchor="middle" style={{ fill: "var(--escalate)" }}>
                {categoryLabel(category)}: escalates at any score
              </text>
            ) : (
              <>
                <text className={styles.planeNote} x={x(0.62)} y={y(0.9)} textAnchor="end" style={{ fill: "var(--resolve)" }}>
                  auto-resolve →
                </text>
                <text className={styles.planeNote} x={x(0.36)} y={y(0.36)} textAnchor="middle">
                  escalate · low_confidence
                </text>
              </>
            )}
            <circle
              className={styles.planePoint}
              cx={x(retrieval)}
              cy={y(certainty)}
              r={7}
              fill={tone}
              stroke="var(--surface)"
              strokeWidth={2.5}
            />
            <text className={styles.planeAxis} x={x(0.5)} y={y(0) + 34} textAnchor="middle">
              retrieval_score →
            </text>
            <text className={styles.planeAxis} x={x(0) + 6} y={y(1) + 14}>
              ↑ self_certainty
            </text>
          </svg>

          <pre className={`${styles.code} ${styles.srcBlock}`} style={{ padding: 0 }}>
            <span className={styles.cm}>{"// src/lib/agent/routing.ts\n"}</span>
            <span className={`${styles.srcLine} ${branch === 0 ? styles.srcLineOn : ""}`}>
              {"if (ESCALATE_CATEGORIES.has(category)) → escalated"}
            </span>
            <span className={`${styles.srcLine} ${branch === 1 ? styles.srcLineOn : ""}`}>
              {"else if (confidence >= 0.8)          → auto_resolved"}
            </span>
            <span className={`${styles.srcLine} ${branch === 2 ? styles.srcLineOn : ""}`}>
              {"else                                 → low_confidence"}
            </span>
          </pre>
        </div>
      </div>
    </div>
  );
}
