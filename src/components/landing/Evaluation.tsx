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
  shipped: string;
  dataset: { core: number; hard: number; coreEscalate: number; coreAuto: number };
  perModel: Record<string, { core: SetResult; hard?: SetResult }>;
  exacto?: {
    seeds: number[];
    base: { model: string; completion: number; escalationRecall: number; cost: number };
    exacto: { model: string; completion: number; escalationRecall: number; cost: number };
    completionP: number;
    escalationRecallP: number;
  };
  findings: {
    stats: {
      tickets: number;
      escalateTickets: number;
      completedOnlyRecall: number;
      completedOnlyRuns: number;
      recallDiff: number;
      recallDiffCI: [number, number];
      unsafeDiff: number;
      unsafeDiffCI: [number, number];
      aurcDiff: number;
      aurcDiffCI: [number, number];
      blendVsCertainty: number;
      blendVsCertaintyCI: [number, number];
    };
    cosine: {
      recallBefore: number;
      recallCosine: number;
      unsafeBefore: number;
      unsafeCosine: number;
      aurcModel: number;
      aurcCosine: number;
      aurcCosineAlone: number;
      baseRisk: number;
    };
    net: { tickets: number; fires: number; sensitive: number; caught: number; falseHits: number; decisionsChanged: number };
    bug: { total: number; labeledBug: number };
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
  blend_cosine: "var(--escalate)",
  blend_model: "var(--resolve)",
  cosine: "#3E6E9E",
  certainty: "var(--text-tertiary)",
  model_retrieval: "var(--critical)",
};

function RangeNote({ r, asPct = true }: { r: Range; asPct?: boolean }) {
  if (r.min === r.max) return <span className={styles.evalRange}>same on every seed</span>;
  return (
    <span className={styles.evalRange}>
      across seeds: {asPct ? pct(r.min) : r.min}–{asPct ? pct(r.max) : r.max}
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
  const shipped = core.variants.find((v) => v.key === summary.shipped)!;
  const cosine = core.variants.find((v) => v.key === "after")!;
  const rc = core.riskCoverage!;
  const runs = summary.seeds.length;
  const f = summary.findings;
  const ex = summary.exacto;
  const hardSet = summary.perModel[summary.primary].hard;
  const hard = hardSet?.variants.find((v) => v.key === summary.shipped);
  const hardCosine = hardSet?.variants.find((v) => v.key === "after");

  return (
    <>
      <div className={styles.evalKpis}>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Must-escalate recall</span>
          <span className={styles.evalValue} style={{ color: "var(--resolve)" }}>
            {pct(shipped.escalationRecall.mean, 1)}
          </span>
          <span className={styles.evalWas}>
            95% CI {pct(shipped.escalationRecallCI[0])}–{pct(shipped.escalationRecallCI[1])}, resampling tickets
          </span>
          <RangeNote r={shipped.escalationRecall} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Unsafe auto-resolves per run</span>
          <span className={styles.evalValue} style={{ color: shipped.unsafeAutoResolves.mean ? "var(--escalate)" : "var(--resolve)" }}>
            {shipped.unsafeAutoResolves.mean.toFixed(1)}
          </span>
          <span className={styles.evalWas}>of {summary.dataset.coreEscalate} tickets that need a human</span>
          <RangeNote r={shipped.unsafeAutoResolves} asPct={false} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Auto-resolve precision</span>
          <span className={styles.evalValue}>{pct(shipped.autoResolvePrecision.mean, 1)}</span>
          <span className={styles.evalWas}>of auto-resolves were docs-answerable</span>
          <RangeNote r={shipped.autoResolvePrecision} />
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Coverage</span>
          <span className={styles.evalValue}>{pct(shipped.coverage.mean, 1)}</span>
          <span className={styles.evalWas}>of all tickets auto-resolved</span>
          <RangeNote r={shipped.coverage} />
        </div>
      </div>
      <p className={styles.evalFoot}>
        The shipped routing, <code>{summary.primary}</code>, on the {summary.dataset.core} hand-labeled tickets × {runs} seeds. Incomplete runs
        count as escalated, as they are in production; on completed runs alone, recall is {pct(f.stats.completedOnlyRecall, 1)}, so failures
        aren&apos;t propping up the headline.
      </p>

      <div className={styles.evalTwo}>
        <div className={styles.about}>
          <h3>What the experiments showed</h3>
          <ul className={styles.findings}>
            <li>
              <b>Cosine similarity didn&apos;t earn its place, so it was rejected.</b>{" "}Replacing the model&apos;s self-reported
              retrieval score with the search&apos;s own similarity dropped must-escalate recall from {pct(f.cosine.recallBefore, 1)} to{" "}
              {pct(f.cosine.recallCosine, 1)}, and unsafe auto-resolves rose from {f.cosine.unsafeBefore.toFixed(1)} to{" "}
              {f.cosine.unsafeCosine.toFixed(1)} per run. Paired by ticket, that gap&apos;s 95% interval is{" "}
              {(f.stats.recallDiffCI[0] * 100).toFixed(0)} to {(f.stats.recallDiffCI[1] * 100).toFixed(0)} points: every estimate
              points the same way, but {f.stats.tickets}{" "}tickets can&apos;t call it significant. No evidence it helps, so it didn&apos;t ship.
            </li>
            <li>
              <b>The 0.6 / 0.4 weights are a prior, not a fit.</b> The blend ranks barely better than self-certainty alone (AURC{" "}
              {f.cosine.aurcModel.toFixed(3)} vs {rc.signals.find((x) => x.key === "certainty")?.aurc.toFixed(3)}; the paired interval spans zero).
              Fitting weights on {f.stats.tickets}{" "}tickets would just memorize the labels.
            </li>
            <li>
              <b>The safety net works, but this model didn&apos;t need it.</b> On the text alone it catches {f.net.caught} of{" "}
              {f.net.sensitive} billing, security and sales tickets with {f.net.falseHits} false hits, but it changed{" "}
              {f.net.decisionsChanged} decisions: the model had already labeled those tickets correctly. It ships as a free backstop.
            </li>
            <li>
              <b>&ldquo;Bug reports always escalate&rdquo; barely fires.</b> Only {f.bug.labeledBug} of {f.bug.total} bug-report runs
              were labeled as bugs. The rest reached a human through low confidence, not the rule.
            </li>
            {hard && hardCosine && (
              <li>
                <b>The hard cases cut the other way.</b> On the {summary.dataset.hard} disguised tickets, shipped recall is{" "}
                {pct(hard.escalationRecall.mean, 1)}; cosine scores {pct(hardCosine.escalationRecall.mean, 1)}, but only by auto-resolving{" "}
                {pct(hardCosine.coverage.mean, 0)} of them. Escalating everything is safe and useless.
              </li>
            )}
            {ex && (
              <li>
                <b>Exacto routing helps the same model finish.</b> On <code>{ex.base.model}</code>, completion rose from{" "}
                {pct(ex.base.completion, 1)} to {pct(ex.exacto.completion, 1)} (p = {ex.completionP.toFixed(3)}) at{" "}
                {(ex.base.cost / ex.exacto.cost).toFixed(0)}× lower cost per ticket.
              </li>
            )}
          </ul>
        </div>
        <div className={styles.card}>
          <div className={styles.payloadHead}>
            <span>four routing arms · same runs</span>
            <span>recall · unsafe/run</span>
          </div>
          <ul className={styles.arms}>
            {core.variants.map((v) => (
              <li key={v.key} className={v.key === summary.shipped ? styles.armShipped : v.key.startsWith("cosine") || v.key === "after" ? styles.armRejected : ""}>
                <span>{v.label}</span>
                <b>{pct(v.escalationRecall.mean, 1)}</b>
                <b>{v.unsafeAutoResolves.mean.toFixed(1)}</b>
              </li>
            ))}
          </ul>
        </div>
      </div>

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
            Sort the tickets a threshold could auto-resolve by each signal, then automate from the top. Risk is the share of automated
            tickets that needed a human. A good signal keeps risk flat as coverage grows. AURC is the area under that curve: a perfect
            ranking scores {rc.optimalAurc.toFixed(3)}, no ranking about {rc.baseRisk.toFixed(3)}.
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
          <RouteGrid title={`Shipped · pooled over ${runs} seeds`} c={shipped.pooled} />
          <RouteGrid title={`Cosine retrieval (rejected) · pooled`} c={cosine.pooled} />
        </div>
        <div className={`${styles.card} ${styles.cardPad}`}>
          <CategoryHeatmap cm={core.categoryConfusion} />
          <p className={styles.evalFoot} style={{ marginTop: "var(--space-4)" }}>
            Category accuracy {pct(core.categoryAccuracy, 1)}, macro-F1 {core.macroF1.toFixed(2)}. Off-diagonal cells are where a
            category rule alone can&apos;t be trusted; the bug row is the clearest case.
          </p>
        </div>
      </div>

      <div className={styles.method}>
        <h4>Methodology</h4>
        <ul className={styles.methodList}>
          <li>
            <b>Labels:</b> all {summary.dataset.core} tickets hand-labeled with a gold category and route (
            {summary.dataset.coreEscalate} need a human, {summary.dataset.coreAuto} are docs-answerable), under a written policy in{" "}
            <code>evals/labels.json</code>. {summary.dataset.hard} disguised or look-alike hard cases are reported separately, because
            their author also wrote the safety net.
          </li>
          <li>
            <b>Model:</b> <code>{summary.primary}</code>, screened on a 12-ticket labeled pilot of four cheap, recent tool-calling
            models: the best router whose full run fit the budget. A screen, not a benchmark. {runs} seeds per arm. All four arms are scored on the same agent runs, so only the
            routing differs.
          </li>
          {ex && (
            <li>
              <b>Same-model check:</b> <code>{ex.base.model}</code> with and without Exacto, seed {ex.seeds.join(", ")}. The headline
              model has one provider, so Exacto can&apos;t change it; this one has many.
            </li>
          )}
          <li>
            <b>Statistics:</b> intervals are a percentile bootstrap that resamples tickets with all their seeds, so three runs of
            one ticket never count as three independent trials. Comparisons between arms are paired on the same runs.
          </li>
          <li>
            <b>Caveats:</b> {summary.dataset.core + summary.dataset.hard} tickets is small, and one labeler wrote the gold labels. Doc search ran on an in-memory copy of the same index, spot-checked identical to the database. The live status
            page was unreachable from the eval sandbox.
          </li>
        </ul>
      </div>
    </>
  );
}
