"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./landing.module.css";

/** Fades a block up once as it scrolls into view. Never re-hides it. */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`${styles.reveal} ${inView ? styles.revealIn : ""}`}
      style={{ transitionDelay: inView ? `${delay}ms` : undefined }}
    >
      {children}
    </div>
  );
}
