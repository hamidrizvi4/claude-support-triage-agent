/**
 * Pure evaluation math — no I/O, no dependencies, unit-tested in
 * metrics.selftest.ts. Everything the report states is computed here.
 */

/** 95% Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Two-sided Fisher exact test for the 2x2 table [[a, b], [c, d]]. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const p = (x: number) => Math.exp(logChoose(col1, x) + logChoose(n - col1, row1 - x) - logChoose(n, row1));
  const observed = p(a);
  let total = 0;
  for (let x = Math.max(0, row1 - (n - col1)); x <= Math.min(row1, col1); x++) {
    const px = p(x);
    if (px <= observed * (1 + 1e-9)) total += px;
  }
  return Math.min(1, total);
}

export type Confusion = { labels: string[]; matrix: number[][] };

/** matrix[i][j] = count of gold labels[i] predicted as labels[j]. */
export function confusion(pairs: { gold: string; pred: string }[], labels: string[]): Confusion {
  const index = new Map(labels.map((l, i) => [l, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const { gold, pred } of pairs) {
    const g = index.get(gold);
    const p = index.get(pred);
    if (g === undefined || p === undefined) throw new Error(`label not in set: ${gold} -> ${pred}`);
    matrix[g][p]++;
  }
  return { labels, matrix };
}

/** Per-class precision/recall/F1 and their unweighted (macro) mean over classes present in gold. */
export function macroF1(c: Confusion): { perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>; macro: number } {
  const perClass: Record<string, { precision: number; recall: number; f1: number; support: number }> = {};
  const f1s: number[] = [];
  c.labels.forEach((label, i) => {
    const tp = c.matrix[i][i];
    const support = c.matrix[i].reduce((a, b) => a + b, 0);
    const predicted = c.matrix.reduce((a, row) => a + row[i], 0);
    const precision = predicted === 0 ? 0 : tp / predicted;
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[label] = { precision, recall, f1, support };
    if (support > 0) f1s.push(f1);
  });
  return { perClass, macro: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0 };
}

export type RouteCounts = {
  /** gold escalate, predicted escalate */
  tp: number;
  /** gold auto_resolve, predicted escalate (an unnecessary handoff) */
  fp: number;
  /** gold escalate, predicted auto_resolve (an unsafe automation) */
  fn: number;
  /** gold auto_resolve, predicted auto_resolve */
  tn: number;
};

export function routeCounts(pairs: { goldEscalate: boolean; predEscalate: boolean }[]): RouteCounts {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const { goldEscalate, predEscalate } of pairs) {
    if (goldEscalate && predEscalate) c.tp++;
    else if (!goldEscalate && predEscalate) c.fp++;
    else if (goldEscalate && !predEscalate) c.fn++;
    else c.tn++;
  }
  return c;
}

export const escalationRecall = (c: RouteCounts) => (c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn));
export const autoResolvePrecision = (c: RouteCounts) => (c.tn + c.fn === 0 ? 1 : c.tn / (c.tn + c.fn));
export const autoResolveRecall = (c: RouteCounts) => (c.tn + c.fp === 0 ? 0 : c.tn / (c.tn + c.fp));
export const coverage = (c: RouteCounts) => {
  const n = c.tp + c.fp + c.fn + c.tn;
  return n === 0 ? 0 : (c.tn + c.fn) / n;
};

export type RcPoint = { threshold: number; coverage: number; risk: number; automated: number };

/**
 * Risk-coverage curve for selective automation. `candidates` are the tickets a
 * confidence threshold could auto-resolve (completed, not escalated by a hard
 * rule); `total` is every ticket in the set, so coverage is the share of the
 * whole queue automated. Risk = share of automated tickets that gold says
 * needed a human. Thresholds sweep every distinct score, highest first.
 */
export function riskCoverage(candidates: { score: number; error: boolean }[], total: number): RcPoint[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const points: RcPoint[] = [];
  let errors = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].error) errors++;
    const last = i === sorted.length - 1 || sorted[i + 1].score !== sorted[i].score;
    if (last) {
      const k = i + 1;
      points.push({ threshold: sorted[i].score, coverage: k / total, risk: errors / k, automated: k });
    }
  }
  return points;
}

/**
 * Area under the risk-coverage curve over the candidates, the standard
 * selective-prediction summary (lower is better): mean of the selective risk
 * at every cut-off of the confidence-sorted list. Ties are broken pessimistically
 * (errors first within a tie) so a signal can't win by having many equal scores.
 */
export function aurc(candidates: { score: number; error: boolean }[]): number {
  if (candidates.length === 0) return 0;
  const sorted = [...candidates].sort((a, b) => b.score - a.score || Number(b.error) - Number(a.error));
  let errors = 0;
  let sum = 0;
  sorted.forEach((c, i) => {
    if (c.error) errors++;
    sum += errors / (i + 1);
  });
  return sum / sorted.length;
}

/** AURC of a perfect ranking (all correct before any error): the floor any signal can reach. */
export function optimalAurc(candidates: { error: boolean }[]): number {
  return aurc(candidates.map((c) => ({ score: c.error ? 0 : 1, error: c.error })));
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function meanRange(values: number[]): { mean: number; min: number; max: number } {
  if (values.length === 0) return { mean: NaN, min: NaN, max: NaN };
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
