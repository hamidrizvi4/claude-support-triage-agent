import type { CSSProperties } from "react";
import { getDashboardStats } from "@/lib/data/queries";
import {
  DOC_GAP_ALERT_RATE,
  DOC_GAP_THRESHOLD,
  categoryLabel,
} from "@/lib/data/types";
import { BreakdownChart } from "@/components/dashboard/BreakdownChart";
import styles from "@/components/dashboard/dashboard.module.css";

/** Live ops view — always read the current run, never serve a build-time snapshot. */
export const dynamic = "force-dynamic";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const rise = (step: number): CSSProperties => ({ animationDelay: `${step * 40}ms` });

export default async function DashboardPage() {
  const stats = await getDashboardStats();
  const { runHealth, decided } = stats;

  const totalRuns =
    runHealth.completed + runHealth.incomplete + runHealth.rateLimited;
  const width = (n: number) => (totalRuns === 0 ? 0 : (n / totalRuns) * 100);

  const docGapAlert = stats.docGapRate > DOC_GAP_ALERT_RATE;
  const threshold = DOC_GAP_THRESHOLD.toFixed(2);
  const toolCallTotal = stats.toolUsage.reduce((sum, t) => sum + t.count, 0);
  // Both breakdowns are built from the same escalated + incomplete rows, so
  // their total is the exact escalated count — no rounding off a rate.
  const escalatedCount = stats.escalationByReason.reduce((sum, r) => sum + r.count, 0);

  return (
    <div className={styles.page}>
      <header className={`${styles.header} ${styles.rise}`} style={rise(0)}>
        <h1 className={styles.title}>Reporting</h1>
        <p className={styles.subtitle}>
          Agent decision quality across the current triage dataset — what
          resolved on its own, what needed a human, and where the docs came up
          short.
        </p>
      </header>

      {/* Run integrity — stated before any rate, so no metric is read out of context. */}
      <section
        className={`${styles.integrity} ${styles.rise}`}
        style={rise(1)}
        aria-label="Run integrity"
      >
        <div className={styles.integrityTop}>
          <span className={styles.integrityLabel}>Run integrity</span>
          <span className={styles.integrityRate}>
            {pct(runHealth.completionRate)}{" "}
            <span>of {decided} decided runs completed</span>
          </span>
        </div>

        <div className={styles.meter} aria-hidden="true">
          <span
            className={`${styles.meterSegment} ${styles.segCompleted}`}
            style={{ width: `${width(runHealth.completed)}%` }}
          />
          <span
            className={`${styles.meterSegment} ${styles.segIncomplete}`}
            style={{ width: `${width(runHealth.incomplete)}%` }}
          />
          <span
            className={`${styles.meterSegment} ${styles.segExcluded}`}
            style={{ width: `${width(runHealth.rateLimited)}%` }}
          />
        </div>

        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${styles.segCompleted}`}
              aria-hidden="true"
            />
            <span className={styles.legendCount}>{runHealth.completed}</span>
            completed
          </span>
          <span className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${styles.segIncomplete}`}
              aria-hidden="true"
            />
            <span className={styles.legendCount}>{runHealth.incomplete}</span>
            incomplete
          </span>
          <span className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${styles.segExcluded}`}
              aria-hidden="true"
            />
            <span className={styles.legendCount}>{runHealth.rateLimited}</span>
            rate limited — excluded from all metrics
          </span>
        </div>

        <p className={styles.note}>
          <code>nemotron-3-ultra:free</code> does not reliably honour the forced{" "}
          <code>submit_resolution</code> call: {runHealth.incomplete} of {decided}{" "}
          decided runs ended without one and escalate to a human with no draft.
          OpenRouter&rsquo;s tool-calling accuracy routing is not offered on{" "}
          <code>:free</code> model slugs, so this is a disclosed cost of running
          the pipeline at $0 — not an open bug. The {runHealth.rateLimited}{" "}
          rate-limited runs hit a daily quota and are excluded from every metric
          below.
        </p>
      </section>

      <div className={`${styles.kpiRow} ${styles.rise}`} style={rise(2)}>
        <div className={`glassPanel ${styles.kpi}`}>
          <span className={styles.kpiLabel}>Auto-resolve rate</span>
          <span className={`${styles.kpiValue} ${styles.kpiResolve}`}>
            {pct(stats.autoResolveRate)}
          </span>
          <span className={styles.kpiFoot}>of {decided} decided runs</span>
        </div>

        <div className={`glassPanel ${styles.kpi}`}>
          <span className={styles.kpiLabel}>Escalation rate</span>
          <span className={`${styles.kpiValue} ${styles.kpiEscalate}`}>
            {pct(stats.escalationRate)}
          </span>
          <span className={styles.kpiFoot}>of {decided} decided runs</span>
        </div>

        <div className={`glassPanel ${styles.kpi}`}>
          <span className={styles.kpiLabel}>Doc-gap rate</span>
          <span
            className={`${styles.kpiValue} ${docGapAlert ? styles.kpiCritical : ""}`}
          >
            {pct(stats.docGapRate)}
          </span>
          <span className={styles.kpiFoot}>retrieval below {threshold}</span>
        </div>

        <div className={`glassPanel ${styles.kpi}`}>
          <span className={styles.kpiLabel}>Avg time to draft</span>
          <span className={styles.kpiValue}>
            {stats.avgTimeToDraftSeconds == null
              ? "—"
              : `${stats.avgTimeToDraftSeconds.toFixed(1)}s`}
          </span>
          <span className={styles.kpiFoot}>first tool call to draft</span>
        </div>
      </div>

      <section className={`${styles.section} ${styles.rise}`} style={rise(3)}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Escalation breakdown</h2>
          <span className={styles.sectionMeta}>{escalatedCount} escalated</span>
        </div>
        <div className={styles.chartGrid}>
          <BreakdownChart title="By category" data={stats.escalationByCategory} />
          <BreakdownChart title="By reason" data={stats.escalationByReason} />
        </div>
      </section>

      {/* The product insight: triage surfaces which docs failed to answer. */}
      <section className={`${styles.section} ${styles.rise}`} style={rise(4)}>
        <div className={`glassPanel ${styles.docGaps}`}>
          <div className={styles.docGapsHead}>
            <span className={styles.docGapsTitleWrap}>
              <span className={styles.criticalDot} aria-hidden="true" />
              <h2 className={styles.sectionTitle}>Documentation gaps</h2>
            </span>
            <span className={styles.docGapsRate}>
              {pct(stats.docGapRate)} of completed runs below {threshold}
            </span>
          </div>

          {stats.docGaps.length === 0 ? (
            <p className={styles.docGapEmpty}>
              No completed run scored a retrieval gap.
            </p>
          ) : (
            <ul>
              {stats.docGaps.map((gap) => (
                <li key={gap.ticketId} className={styles.docGapRow}>
                  <span
                    className={`${styles.docGapScore} ${
                      gap.retrievalScore >= DOC_GAP_THRESHOLD
                        ? styles.docGapScoreOk
                        : ""
                    }`}
                  >
                    {gap.retrievalScore.toFixed(2)}
                  </span>
                  <span className={styles.docGapSubject}>{gap.subject}</span>
                  <span className={styles.docGapCategory}>
                    {categoryLabel(gap.category)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={`${styles.section} ${styles.rise}`} style={rise(5)}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Tool calls</h2>
          <span className={styles.sectionMeta}>{toolCallTotal} total</span>
        </div>
        <div className={styles.tools}>
          {stats.toolUsage.map((tool) => (
            <div key={tool.label} className={styles.tool}>
              <span className={styles.toolName}>{tool.label}</span>
              <span className={styles.toolCount}>{tool.count}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
