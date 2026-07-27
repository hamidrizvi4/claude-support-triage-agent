import type { Breakdown } from "@/lib/data/types";
import styles from "./dashboard.module.css";

/**
 * Horizontal bars, proportional to the largest value in the set. Counts are
 * rendered as text, so the bars themselves are decorative to a screen reader.
 */
export function BreakdownChart({
  title,
  data,
}: {
  title: string;
  data: Breakdown[];
}) {
  const max = data.reduce((m, d) => Math.max(m, d.count), 0);

  return (
    <section className={`glassPanel ${styles.chart}`} aria-label={title}>
      <h3 className={styles.chartTitle}>{title}</h3>

      {data.length === 0 ? (
        <p className={styles.empty}>Nothing escalated in this run.</p>
      ) : (
        <ul className={styles.bars}>
          {data.map((d) => (
            <li key={d.label} className={styles.barRow}>
              <span className={styles.barLabel}>{d.label}</span>
              <span className={styles.barCount}>{d.count}</span>
              <span className={styles.barTrack} aria-hidden="true">
                <span
                  className={styles.barFill}
                  /* Floor at 3% so a count of 1 is still visibly a bar. */
                  style={{ width: `${max === 0 ? 0 : Math.max(3, (d.count / max) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
