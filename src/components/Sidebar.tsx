"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { modelDisplayName } from "@/lib/model";
import styles from "./Sidebar.module.css";

const NAV = [
  {
    href: "/",
    label: "Queue",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <path
          d="M2 3.75h11M2 7.5h11M2 11.25h7"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <path
          d="M2.5 12.5V8m4 4.5V3.5m4 9V6.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export function Sidebar({ model }: { model: string }) {
  const pathname = usePathname();

  return (
    <nav className={`glassPanel ${styles.sidebar}`} aria-label="Primary">
      <div className={styles.brand}>
        <div className={styles.mark} aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 1.5 12.2 4.5v6L7 13.5 1.8 10.5v-6L7 1.5Z"
              stroke="var(--resolve)"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <circle cx="7" cy="7" r="1.8" fill="var(--resolve)" />
          </svg>
        </div>
        <span className={styles.brandText}>
          <span className={styles.brandName}>Triage Control</span>
          <span className={styles.brandSub}>Claude API support</span>
        </span>
      </div>

      <div className={styles.nav}>
        <span className={styles.navLabel}>Workspace</span>
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.item} ${active ? styles.itemActive : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerRow}>
          <span className={styles.dot} aria-hidden="true" />
          agent v0.3
        </span>
        <span className={styles.footerRow}>{modelDisplayName(model)}</span>
      </div>
    </nav>
  );
}
