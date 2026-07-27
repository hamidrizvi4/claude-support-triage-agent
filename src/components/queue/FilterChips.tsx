"use client";

import styles from "./queue.module.css";

type Props = {
  label: string;
  options: { value: string; count: number }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
};

export function FilterChips({ label, options, selected, onToggle }: Props) {
  if (options.length === 0) return null;

  return (
    <div className={styles.filterGroup} role="group" aria-label={`Filter by ${label}`}>
      <span className={styles.filterLabel}>{label}</span>
      {options.map(({ value, count }) => {
        const on = selected.has(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(value)}
            className={`${styles.chip} ${on ? styles.chipOn : "glassPanel"}`}
          >
            {value}
            <span className={styles.chipCount}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
