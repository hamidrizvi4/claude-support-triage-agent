"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  categoryLabel,
  reasonLabel,
  type QueueTicket,
  type ToolCall,
} from "@/lib/data/types";
import { TicketDrawer } from "@/components/drawer/TicketDrawer";
import { FilterChips } from "./FilterChips";
import { QueueRow } from "./QueueRow";
import styles from "./queue.module.css";

type Props = {
  tickets: QueueTicket[];
  toolCallsByTicket: Record<string, ToolCall[]>;
};

function countBy(values: string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

export function QueueView({ tickets, toolCallsByTicket }: Props) {
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const categoryOptions = useMemo(
    () => countBy(tickets.map((t) => categoryLabel(t.category))),
    [tickets]
  );
  const reasonOptions = useMemo(
    () => countBy(tickets.map((t) => reasonLabel(t.escalationReason))),
    [tickets]
  );

  const visible = useMemo(
    () =>
      tickets.filter(
        (t) =>
          (categories.size === 0 || categories.has(categoryLabel(t.category))) &&
          (reasons.size === 0 || reasons.has(reasonLabel(t.escalationReason)))
      ),
    [tickets, categories, reasons]
  );

  // 429s never count — they aren't decisions anyone needs to review.
  const awaiting = useMemo(
    () => tickets.filter((t) => !t.reviewed && t.outcome !== "rate_limited").length,
    [tickets]
  );

  const filtered = categories.size > 0 || reasons.size > 0;
  const clearFilters = useCallback(() => {
    setCategories(new Set());
    setReasons(new Set());
  }, []);

  // Filtering can leave the cursor past the end of the list. Clamp on read
  // instead of in an effect — an effect here would cascade a second render on
  // every filter change.
  const activeIndex = Math.min(cursor, Math.max(0, visible.length - 1));

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const el = event.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (visible.length === 0) return;

      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        setCursor(
          Math.max(
            0,
            Math.min(visible.length - 1, activeIndex + (event.key === "j" ? 1 : -1))
          )
        );
      } else if (event.key === "Enter") {
        const ticket = visible[activeIndex];
        if (!ticket) return;
        event.preventDefault();
        setSelectedId(ticket.id);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activeIndex]);

  // Instant, never smooth — this fires on every j/k of a long triage batch.
  useEffect(() => {
    const ticket = visible[activeIndex];
    if (ticket) rowRefs.current.get(ticket.id)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible]);

  const selected = useMemo(
    () => tickets.find((t) => t.id === selectedId) ?? null,
    [tickets, selectedId]
  );

  return (
    <div className={styles.screen}>
      <header className={`glassPanel ${styles.header}`}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Review queue</h1>
          <span className={styles.badge}>
            {awaiting}
            <span className={styles.badgeWord}>awaiting review</span>
          </span>
        </div>

        <div className={styles.filters}>
          <FilterChips
            label="Category"
            options={categoryOptions}
            selected={categories}
            onToggle={(v) => setCategories((s) => toggle(s, v))}
          />
          <FilterChips
            label="Reason"
            options={reasonOptions}
            selected={reasons}
            onToggle={(v) => setReasons((s) => toggle(s, v))}
          />
          {filtered && (
            <div className={styles.filterGroup}>
              <span className={styles.filterLabel} aria-hidden="true" />
              <button type="button" className={styles.clear} onClick={clearFilters}>
                Clear filters · showing {visible.length} of {tickets.length}
              </button>
            </div>
          )}
        </div>
      </header>

      {visible.length > 0 && (
        <div className={styles.meta} aria-hidden="true">
          <span>Ticket</span>
          <span>Category</span>
          <span>Routing reason</span>
          <span className={styles.metaRight}>Conf</span>
          <span className={styles.metaRight}>Drafted</span>
        </div>
      )}

      {visible.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M5 10.5 8.5 14 15 7"
                stroke="var(--resolve)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <p className={styles.emptyTitle}>
            {filtered ? "Nothing matches those filters" : "All caught up"}
          </p>
          <p className={styles.emptyBody}>
            {filtered
              ? "No tickets in this run carry that combination of category and routing reason."
              : "Every ticket in this run has been reviewed. New drafts land here as the agent works through the queue."}
          </p>
          {filtered && (
            <button type="button" className={styles.emptyAction} onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <ul className={styles.list}>
          {visible.map((ticket, index) => (
            <QueueRow
              key={ticket.id}
              ticket={ticket}
              active={index === activeIndex}
              onOpen={() => {
                setCursor(index);
                setSelectedId(ticket.id);
              }}
              onFocus={() => setCursor(index)}
              ref={(el) => {
                if (el) rowRefs.current.set(ticket.id, el);
                else rowRefs.current.delete(ticket.id);
              }}
            />
          ))}
        </ul>
      )}

      <div className={styles.hint}>
        <span className={styles.key}>J</span>
        <span className={styles.key}>K</span>
        <span>move</span>
        <span className={styles.key}>↵</span>
        <span>open ticket</span>
      </div>

      <TicketDrawer
        ticket={selected}
        toolCalls={selected ? (toolCallsByTicket[selected.id] ?? []) : []}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
