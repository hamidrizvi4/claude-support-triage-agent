/**
 * Evaluation section for the intro page. Renders only from
 * evals/results/summary.json, which `npm run eval:report` writes from the
 * raw labeled runs — nothing here is typed in by hand, so the page can't
 * drift from the measured numbers. Until a report exists the section renders
 * nothing.
 */
import summaryJson from "../../../evals/results/summary.json";
import styles from "./landing.module.css";

type Range = { mean: number; min: number; max: number };
type Counts = { tp: number; fp: number; fn: number; tn: number };
type Variant = {
  key: string;
  label: string;
  escalationRecall: Range;
  escalationRecallCI: [number, number];
  unsafeAutoResolves: Range;
  autoResolvePrecision: Range;
  autoResolveRecall: Range;
  coverage: Range;
  netCatches: Range;
  pooled: Counts;
};
type Signal = { key: string; label: string; aurc: number; points: { c: number; r: number }[]; at08: { coverage: number; risk: number } | null };
type SetResult = {
  runs: number;
  completion: Range;
  categoryAccuracy: number;
  macroF1: number;
  categoryConfusion: { labels: string[]; matrix: number[][] };
  variants: Variant[];
  riskCoverage?: { candidates: number; total: number; baseRisk: number; optimalAurc: number; signals: Signal[] };
  cost: { total: number; perTicket: number };
};
type Summary = {
  status: string;
  seeds: number[];
  models: string[];
  primary: string;
  dataset: { core: number; hard: number; coreEscalate: number; coreAuto: number };
  perModel: Record<string, { core: SetResult; hard?: SetResult }>;
  exacto?: {
    base: { model: string; completion: number; escalationRecall: number; cost: number };
    exacto: { model: string; completion: number; escalationRecall: number; cost: number };
    completionP: number;
    escalationRecallP: number;
  };
};

const summary = summaryJson as unknown as Summary;

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const SHORT: Record<string, string> = {
  technical_api_error: "Technical",
  feature_question: "Feature",
  account_access: "Account",
  billing: "Billing",
  security_abuse: "Security",
  sales_enterprise: "Sales",
  bug_report: "Bug",
};
const SIGNAL_COLOR: Record<string, string> = {
  blend_cosine: "var(--resolve)",
  blend_model: "var(--escalate)",
  cosine: "#3E6E9E",
  certainty: "var(--text-tertiary)",
  model_retrieval: "var(--critical)",
};

function RangeNote({ r, asPct = true }: { r: Range; asPct?: boolean }) {
  if (r.min === r.max) return <span className={styles.evalRange}>same on every seed</span>;
  return (
    <span className={styles.evalRange}>
      seeds: {asPct ? pct(r.min) : r.min}–{asPct ? pct(r.max) : r.max}
    </span>
  );
}

function RiskCoverage({ rc }: { rc: NonNullable<SetResult["riskCoverage"]> }) {
  const W = 520;
  const H = 300;
  const L = 44;
  const B = 34;
  const T = 12;
  const R = 12;
  const maxC = Math.max(0.05, ...rc.signals.flatMap((s) => s.points.map((p) => p.c)));
  const x = (c: number) => L + (c / maxC) * (W - L - R);
  const y = (r: number) => T + (1 - r) * (H - T - B);
  const shown = rc.signals.filter((s) => s.key !== "model_retrieval");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.diagram} role="img" aria-label="Risk-coverage curves for each confidence signal">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line className={styles.planeGrid} x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
          <text className={styles.planeAxis} x={L - 8} y={y(t) + 3} textAnchor="end">
            {pct(t)}
          </text>
        </g>
      ))}
      {[0, maxC / 2, maxC].map((t) => (
        <text key={t} className={styles.planeAxis} x={x(t)} y={H - B + 14} textAnchor="middle">
          {pct(t)}
        </text>
      ))}
      <line x1={L} x2={W - R} y1={y(rc.baseRisk)} y2={y(rc.baseRisk)} stroke="var(--text-primary)" strokeDasharray="2 3" opacity={0.45} />
      <text className={styles.planeAxis} x={W - R} y={y(rc.baseRisk) - 4} textAnchor="end">
        no ranking ({pct(rc.baseRisk)})
      </text>
      {shown.map((s) => {
        const d = [`M ${x(0)} ${y(s.points[0]?.r ?? 0)}`, ...s.points.map((p) => `L ${x(p.c)} ${y(p.r)}`)].join(" ");
        const main = s.key.startsWith("blend");
        return (
          <path
            key={s.key}
            d={d}
            fill="none"
            stroke={SIGNAL_COLOR[s.key]}
            strokeWidth={main ? 2.2 : 1.4}
            strokeDasharray={main ? undefined : "4 4"}
          />
        );
      })}
      <text className={styles.planeAxis} x={(L + W - R) / 2} y={H - 4} textAnchor="middle">
        coverage: share of all tickets auto-resolved →
      </text>
    </svg>
  );
}

function RouteGrid({ title, c }: { title: string; c: Counts }) {
  return (
    <div>
      <div className={styles.evalGridTitle}>{title}</div>
      <div className={styles.routeGrid}>
        <span />
        <span className={styles.routeHead}>escalated</span>
        <span className={styles.routeHead}>auto-resolved</span>
        <span className={styles.routeRow}>needs a human</span>
        <span className={`${styles.routeCell} ${styles.cellGood}`}>{c.tp}</span>
        <span className={`${styles.routeCell} ${c.fn ? styles.cellBad : styles.cellGood}`}>{c.fn}</span>
        <span className={styles.routeRow}>docs-answerable</span>
        <span className={`${styles.routeCell} ${styles.cellMeh}`}>{c.fp}</span>
        <span className={`${styles.routeCell} ${styles.cellGood}`}>{c.tn}</span>
      </div>
    </div>
  );
}

function CategoryHeatmap({ cm }: { cm: SetResult["categoryConfusion"] }) {
  const max = Math.max(1, ...cm.matrix.flat());
  const present = cm.labels.map((_, i) => cm.matrix[i].some(Boolean) || cm.matrix.some((row) => row[i]));
  const idx = cm.labels.map((_, i) => i).filter((i) => present[i]);
  return (
    <div>
      <div className={styles.evalGridTitle}>Category: gold ↓ · predicted →</div>
      <div className={styles.heat} style={{ gridTemplateColumns: `76px repeat(${idx.length}, minmax(0, 1fr))` }}>
        <span />
        {idx.map((j) => (
          <span key={j} className={styles.heatHead}>
            {SHORT[cm.labels[j]]}
          </span>
        ))}
        {idx.map((i) => (
          <div key={i} style={{ display: "contents" }}>
            <span className={styles.heatRow}>{SHORT[cm.labels[i]]}</span>
            {idx.map((j) => {
              const v = cm.matrix[i][j];
              const a = v / max;
              return (
                <span
                  key={j}
                  className={styles.heatCell}
                  style={{
                    background: v === 0 ? "transparent" : i === j ? `rgba(10,122,94,${0.12 + a * 0.6})` : `rgba(169,85,10,${0.12 + a * 0.6})`,
                    color: a > 0.55 ? "#fff" : "var(--text-primary)",
                  }}
                >
                  {v || "·"}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Evaluation() {
  if (summary.status !== "complete") return null;
  const core = summary.perModel[summary.primary].core;
  const before = core.variants.find((v) => v.key === "before")!;
  const after = core.variants.find((v) => v.key === "after")!;
  const rc = core.riskCoverage!;
  const hard = summary.perModel[summary.primary].hard;
  const hardBefore = hard?.variants.find((v) => v.key === "before");
  const hardAfter = hard?.variants.find((v) => v.key === "after");
  const runs = summary.seeds.length;

  return (
    <>
      <div className={styles.evalKpis}>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Must-escalate recall</span>
          <span className={styles.evalValue} style={{ color: "var(--resolve)" }}>
            {pct(after.escalationRecall.mean, 1)}
          </span>
          <span className={styles.evalWas}>was {pct(before.escalationRecall.mean, 1)}</span>
          <RangeNote r={after.escalationRecall} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Unsafe auto-resolves per run</span>
          <span className={styles.evalValue} style={{ color: after.unsafeAutoResolves.mean ? "var(--escalate)" : "var(--resolve)" }}>
            {after.unsafeAutoResolves.mean.toFixed(1)}
          </span>
          <span className={styles.evalWas}>was {before.unsafeAutoResolves.mean.toFixed(1)}</span>
          <RangeNote r={after.unsafeAutoResolves} asPct={false} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Auto-resolve precision</span>
          <span className={styles.evalValue}>{pct(after.autoResolvePrecision.mean, 1)}</span>
          <span className={styles.evalWas}>was {pct(before.autoResolvePrecision.mean, 1)}</span>
          <RangeNote r={after.autoResolvePrecision} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Coverage (auto-resolved)</span>
          <span className={styles.evalValue}>{pct(after.coverage.mean, 1)}</span>
          <span className={styles.evalWas}>was {pct(before.coverage.mean, 1)}</span>
          <RangeNote r={after.coverage} />
        </div>
      </div>
      <p className={styles.evalFoot}>
        <code>{summary.primary}</code> on the {summary.dataset.core} hand-labeled tickets × {runs} seeds. Before: the model&apos;s own
        retrieval score, no safety net. After: cosine retrieval + safety net. Incomplete runs count as escalated, as they are in
        production.
      </p>

      <div className={styles.evalTwo}>
        <div className={styles.card}>
          <div className={styles.payloadHead}>
            <span>risk-coverage · {rc.candidates} eligible runs</span>
            <span>lower is better</span>
          </div>
          <div className={styles.cardPad}>
            <RiskCoverage rc={rc} />
          </div>
        </div>
        <div className={styles.about}>
          <h3>Which signal should gate automation?</h3>
          <p>
            Sort the tickets a threshold could auto-resolve by each signal, then automate from the top. Risk is the share of
            automated tickets that needed a human. A good signal keeps risk flat as coverage grows. AURC is the area under that
            curve: a perfect ranking scores {rc.optimalAurc.toFixed(3)}.
          </p>
          <ul className={styles.aurcList}>
            {rc.signals.map((s) => (
              <li key={s.key}>
                <i className={styles.sw} style={{ background: SIGNAL_COLOR[s.key] }} />
                <span>{s.label}</span>
                <b>{s.aurc.toFixed(3)}</b>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={styles.evalTwo}>
        <div className={`${styles.card} ${styles.cardPad} ${styles.evalGrids}`}>
          <RouteGrid title={`Before · pooled over ${runs} seeds`} c={before.pooled} />
          <RouteGrid title={`After · pooled over ${runs} seeds`} c={after.pooled} />
        </div>
        <div className={`${styles.card} ${styles.cardPad}`}>
          <CategoryHeatmap cm={core.categoryConfusion} />
          <p className={styles.evalFoot} style={{ marginTop: "var(--space-4)" }}>
            Category accuracy {pct(core.categoryAccuracy, 1)}, macro-F1 {core.macroF1.toFixed(2)}. Off-diagonal cells are where the
            hard category rule alone can&apos;t be trusted.
          </p>
        </div>
      </div>

      <div className={styles.method}>
        <h4>Methodology</h4>
        <ul className={styles.methodList}>
          <li>
            <b>Labels:</b> all {summary.dataset.core} tickets hand-labeled with a gold category and route (
            {summary.dataset.coreEscalate} need a human, {summary.dataset.coreAuto} are docs-answerable), under a written policy in{" "}
            <code>evals/labels.json</code>.
          </li>
          <li>
            <b>Model:</b> <code>{summary.primary}</code>, picked by a labeled pilot of cheap tool-calling models on routing accuracy,
            then cost. {runs} seeds per configuration.
          </li>
          {summary.exacto && (
            <li>
              <b>Same-model check:</b> <code>{summary.exacto.base.model}</code> with and without Exacto routing. Completion{" "}
              {pct(summary.exacto.base.completion)} vs {pct(summary.exacto.exacto.completion)} (p = {summary.exacto.completionP.toFixed(2)}),
              must-escalate recall {pct(summary.exacto.base.escalationRecall)} vs {pct(summary.exacto.exacto.escalationRecall)}.
            </li>
          )}
          {hardBefore && hardAfter && (
            <li>
              <b>Hard cases:</b> {summary.dataset.hard} disguised or look-alike tickets, reported separately because their author also
              wrote the safety net. Must-escalate recall {pct(hardBefore.escalationRecall.mean)} → {pct(hardAfter.escalationRecall.mean)}.
            </li>
          )}
          <li>
            <b>Caveat:</b> {summary.dataset.core + summary.dataset.hard} tickets is small. Seed ranges and a Wilson interval (
            {pct(after.escalationRecallCI[0])}–{pct(after.escalationRecallCI[1])} on recall) are reported so nothing looks more
            precise than it is.
          </li>
        </ul>
      </div>
    </>
  );
}
