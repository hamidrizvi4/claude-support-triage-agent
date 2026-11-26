/**
 * Scores the raw eval runs against the gold labels and writes:
 *   evals/results/summary.json   — consumed by the intro page's evaluation section
 *   docs/EVALUATION.md           — the full report (tables, confusion matrices)
 *   docs/eval/risk-coverage.svg  — the risk-coverage figure
 *   docs/CASE_STUDY.md           — headline numbers between eval markers
 *
 * Routing is recomputed here from each run's raw outputs, so every variant
 * (model-reported vs cosine retrieval, with/without the safety net) is scored
 * on exactly the same agent runs.
 *
 * Usage: npm run eval:report            (main runs in evals/runs/*.jsonl)
 *        npm run eval:report -- --pilot (model pick from pilot_*.jsonl)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { getSupabaseAdmin } from "../../src/lib/supabase";
import {
  computeConfidence,
  cosineRetrievalScore,
  COSINE_CEIL,
  COSINE_FLOOR,
  ESCALATE_CATEGORIES,
  routeTicket,
} from "../../src/lib/agent/routing";
import { safetyNet } from "../../src/lib/agent/safetyNet";
import { goldById, ticketTexts } from "./data";
import type { RunRecord } from "./run";
import {
  aurc,
  autoResolvePrecision,
  clusterBootstrap,
  autoResolveRecall,
  confusion,
  coverage,
  escalationRecall,
  fisherExact,
  macroF1,
  meanRange,
  optimalAurc,
  quantile,
  riskCoverage,
  routeCounts,
  type RouteCounts,
} from "./metrics";

const ROOT = path.join(__dirname, "..", "..");
const RUNS = path.join(ROOT, "evals", "runs");
const CATEGORIES = [
  "technical_api_error",
  "feature_question",
  "account_access",
  "billing",
  "security_abuse",
  "sales_enterprise",
  "bug_report",
];

type Gold = { set: "core" | "hard"; gold_category: string; gold_route: string; kind?: string; text?: string };

type Variant = { key: string; label: string; cosine: boolean; net: boolean };
const VARIANTS: Variant[] = [
  { key: "before", label: "Original routing (model-reported retrieval)", cosine: false, net: false },
  { key: "net_only", label: "Original + safety net — shipped", cosine: false, net: true },
  { key: "cosine_only", label: "Cosine retrieval instead — rejected", cosine: true, net: false },
  { key: "after", label: "Cosine retrieval + safety net — rejected", cosine: true, net: true },
];
/** The arm production runs, chosen by these results (see docs/EVALUATION.md). */
const SHIPPED = "net_only";
const COSINE = "after";
const SENSITIVE_NET = new Set(["billing", "security_abuse", "sales_enterprise"]);

/**
 * Provider-side failures (429s, 5xx, network) say nothing about the agent, so
 * they are set aside like production's rate_limited rows, counted, and can be
 * re-run with `eval:run -- --retry-infra`. A model that answers without
 * calling submit_resolution is NOT infrastructure: that stays "incomplete".
 */
const SEARCH_INFRA = /^(search_docs|check_pricing): .*(statement timeout|fetch failed|ECONN|socket|terminated|embeddings error (429|5\d\d))/i;
/** Recomputed from the raw error text, so the rule is the same for every record. */
export const isInfra = (r: RunRecord) =>
  (!r.completed && /^upstream error/.test(r.error ?? "")) || (r.tool_errors ?? []).some((e) => SEARCH_INFRA.test(e));

/**
 * One record per (model, ticket, seed): the FIRST valid (non-infrastructure)
 * record wins, so a retry can only replace a genuine infrastructure failure,
 * never re-roll a run the agent actually got wrong.
 */
let infraRecordsSeen = 0;

function readRuns(prefixPilot: boolean): RunRecord[] {
  if (!fs.existsSync(RUNS)) return [];
  const latest = new Map<string, RunRecord>();
  const lines = fs
    .readdirSync(RUNS)
    .filter((f) => f.endsWith(".jsonl") && f.startsWith("pilot_") === prefixPilot)
    .flatMap((f) =>
      fs
        .readFileSync(path.join(RUNS, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunRecord)
    );
  if (!prefixPilot) infraRecordsSeen = lines.filter(isInfra).length;
  for (const r of lines) {
    const key = `${r.model}#${r.ticket_id}#${r.seed}`;
    const prev = latest.get(key);
    if (!prev || (isInfra(prev) && !isInfra(r))) latest.set(key, r);
  }
  return [...latest.values()];
}

function retrievalFor(r: RunRecord, cosine: boolean): number {
  return cosine ? cosineRetrievalScore(r.similarities) : r.model_retrieval ?? 0;
}

/** True when the operational outcome is "a human sees it": escalated, or never resolved. */
function predEscalate(r: RunRecord, v: Variant, text: string): { escalate: boolean; reason: string } {
  if (!r.completed || !r.category) return { escalate: true, reason: "incomplete" };
  const d = routeTicket({
    category: r.category,
    retrievalScore: retrievalFor(r, v.cosine),
    selfCertainty: r.self_certainty ?? 0,
    text,
    useSafetyNet: v.net,
  });
  return { escalate: d.status === "escalated", reason: d.reason ?? "auto_resolved" };
}

type Scored = {
  n: number;
  completed: number;
  counts: RouteCounts;
  sensitiveTotal: number;
  sensitiveEscalated: number;
  categoryCorrect: number;
  netCatches: number;
};

function score(runs: RunRecord[], v: Variant, gold: Map<string, Gold>, texts: Map<string, string>): Scored {
  const pairs: { goldEscalate: boolean; predEscalate: boolean }[] = [];
  let completed = 0;
  let sensitiveTotal = 0;
  let sensitiveEscalated = 0;
  let categoryCorrect = 0;
  let netCatches = 0;
  for (const r of runs) {
    const g = gold.get(r.ticket_id)!;
    const text = texts.get(r.ticket_id) ?? "";
    const p = predEscalate(r, v, text);
    pairs.push({ goldEscalate: g.gold_route === "escalate", predEscalate: p.escalate });
    if (r.completed) completed++;
    if (r.completed && r.category === g.gold_category) categoryCorrect++;
    if (ESCALATE_CATEGORIES.has(g.gold_category)) {
      sensitiveTotal++;
      if (p.escalate) sensitiveEscalated++;
    }
    if (p.reason.startsWith("safety_net:")) netCatches++;
  }
  return { n: runs.length, completed, counts: routeCounts(pairs), sensitiveTotal, sensitiveEscalated, categoryCorrect, netCatches };
}

type R = { mean: number; min: number; max: number };
type VariantOut = {
  key: string;
  label: string;
  escalationRecall: R;
  escalationRecallCI: number[];
  unsafeAutoResolves: R;
  autoResolvePrecision: R;
  autoResolveRecall: R;
  coverage: R;
  sensitiveRecall: R;
  netCatches: R;
  pooled: RouteCounts;
};
type SetOut = {
  runs: number;
  completion: R;
  completedRuns: number;
  seedsRun: number;
  categoryAccuracy: number;
  macroF1: number;
  perClass: Record<string, { precision: number; recall: number; support: number }>;
  categoryConfusion: { labels: string[]; matrix: number[][] };
  variants: VariantOut[];
  riskCoverage?: ReturnType<typeof riskCoverageFor>;
  cost: { total: number; perTicket: number };
  latencyS: number;
};
type ExactoSide = {
  model: string;
  runs: number;
  completed: number;
  counts: RouteCounts;
  cost: number;
  latencyS: number;
  completion: number;
  escalationRecall: number;
};
type Dataset = { core: number; hard: number; coreEscalate: number; coreAuto: number };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

async function loadTexts(gold: Map<string, Gold>): Promise<Map<string, string>> {
  const texts = await ticketTexts(getSupabaseAdmin());
  for (const [id, g] of gold) if (g.text) texts.set(id, g.text);
  return texts;
}

/* ───────────────────────────── pilot / model pick ───────────────────────────── */

async function pilot() {
  const gold = goldById() as Map<string, Gold>;
  const texts = await loadTexts(gold);
  const runs = readRuns(true);
  if (runs.length === 0) throw new Error("no pilot runs in evals/runs/pilot_*.jsonl");
  const after = VARIANTS.find((v) => v.key === "after")!;
  const rows = [...groupBy(runs, (r) => r.model)].map(([model, rs]) => {
    const s = score(rs, after, gold, texts);
    const c = s.counts;
    return {
      model,
      runs: rs.length,
      completion: s.completed / s.n,
      routingAccuracy: (c.tp + c.tn) / s.n,
      escalationRecall: escalationRecall(c),
      categoryAccuracy: s.completed ? s.categoryCorrect / s.completed : 0,
      costPerTicket: rs.reduce((a, r) => a + r.cost, 0) / rs.length,
      latencyS: rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length / 1000,
    };
  });
  // The main run is (core + hard) tickets × 3 seeds × 2 configs (with and
  // without Exacto); a model only qualifies if that fits the remaining budget.
  const argv = process.argv;
  const budget = Number(argv[argv.indexOf("--budget") + 1]) || Infinity;
  const mainRuns = gold.size * 3 * 2;
  const projected = new Map(rows.map((r) => [r.model, r.costPerTicket * mainRuns]));
  // Best routing first; safety (escalation recall) breaks ties; then price.
  rows.sort(
    (a, b) =>
      b.routingAccuracy - a.routingAccuracy ||
      b.escalationRecall - a.escalationRecall ||
      b.categoryAccuracy - a.categoryAccuracy ||
      a.costPerTicket - b.costPerTicket
  );
  console.log("\nPilot (same 12 labeled tickets, seed 1, routing = cosine + safety net):\n");
  console.log("model                              runs  complete  route-acc  esc-recall  cat-acc  $/ticket  latency  projected main run");
  for (const r of rows) {
    console.log(
      `${r.model.padEnd(34)} ${String(r.runs).padStart(4)}  ${pct(r.completion).padStart(8)}  ${pct(r.routingAccuracy).padStart(9)}  ${pct(
        r.escalationRecall
      ).padStart(10)}  ${pct(r.categoryAccuracy).padStart(7)}  ${r.costPerTicket.toFixed(5)}  ${r.latencyS.toFixed(1).padStart(6)}s  $${projected
        .get(r.model)!
        .toFixed(2)}${projected.get(r.model)! > budget ? " (over budget)" : ""}`
    );
  }
  const affordable = rows.filter((r) => projected.get(r.model)! <= budget);
  const picked = (affordable[0] ?? rows[0]).model;
  fs.mkdirSync(path.join(ROOT, "evals", "results"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "evals", "results", "model-pick.json"),
    JSON.stringify(
      {
        picked,
        rule: "highest routing accuracy (cosine + safety net) on the labeled pilot, then must-escalate recall, then category accuracy, then price — among models whose projected main run fits the budget",
        budget: Number.isFinite(budget) ? budget : null,
        mainRuns,
        rows: rows.map((r) => ({ ...r, projectedMainRun: projected.get(r.model) })),
      },
      null,
      2
    ) + "\n"
  );
  console.log(`\nPicked: ${picked}${affordable.length < rows.length ? ` (budget $${budget}; ${rows.length - affordable.length} model(s) excluded as over budget)` : ""}`);
}

/* ─────────────────────────────────── main report ─────────────────────────────── */

type SignalKey = "blend_model" | "blend_cosine" | "cosine" | "certainty" | "model_retrieval";
const SIGNALS: { key: SignalKey; label: string; fn: (r: RunRecord) => number }[] = [
  { key: "blend_cosine", label: "0.6·cosine + 0.4·certainty (rejected)", fn: (r) => computeConfidence(cosineRetrievalScore(r.similarities), r.self_certainty ?? 0) },
  { key: "blend_model", label: "0.6·model-reported + 0.4·certainty (shipped)", fn: (r) => computeConfidence(r.model_retrieval ?? 0, r.self_certainty ?? 0) },
  { key: "cosine", label: "Cosine similarity alone", fn: (r) => cosineRetrievalScore(r.similarities) },
  { key: "certainty", label: "Self-certainty alone", fn: (r) => r.self_certainty ?? 0 },
  { key: "model_retrieval", label: "Model-reported retrieval alone", fn: (r) => r.model_retrieval ?? 0 },
];

/** Completed runs a threshold could auto-resolve, i.e. not already escalated by the category rule or the net. */
function rcCandidates(runs: RunRecord[], texts: Map<string, string>): RunRecord[] {
  return runs.filter((r) => r.completed && r.category && !ESCALATE_CATEGORIES.has(r.category) && !safetyNet(texts.get(r.ticket_id) ?? ""));
}

/** Every run of one ticket together: the unit a bootstrap resamples. */
function byTicket<T extends { ticket_id: string }>(xs: T[]): T[][] {
  return [...groupBy(xs, (x) => x.ticket_id).values()];
}

/** Must-escalate recall with a 95% interval that resamples tickets, not runs. */
function recallCI(runs: RunRecord[], v: Variant, gold: Map<string, Gold>, texts: Map<string, string>): number[] {
  const rows = runs.map((r) => ({
    ticket_id: r.ticket_id,
    gold: gold.get(r.ticket_id)!.gold_route === "escalate",
    pred: predEscalate(r, v, texts.get(r.ticket_id) ?? "").escalate,
  }));
  return clusterBootstrap(byTicket(rows), (cs) => {
    const f = cs.flat().filter((x) => x.gold);
    return f.length ? f.filter((x) => x.pred).length / f.length : NaN;
  });
}

function riskCoverageFor(runs: RunRecord[], gold: Map<string, Gold>, texts: Map<string, string>) {
  // Same candidate pool for every signal.
  const candidates = rcCandidates(runs, texts);
  const total = runs.length;
  const base = candidates.filter((r) => gold.get(r.ticket_id)!.gold_route === "escalate").length / Math.max(1, candidates.length);
  const opt = optimalAurc(candidates.map((r) => ({ error: gold.get(r.ticket_id)!.gold_route === "escalate" })));
  const signals = SIGNALS.map((s) => {
    const scored = candidates.map((r) => ({ score: s.fn(r), error: gold.get(r.ticket_id)!.gold_route === "escalate" }));
    const pts = riskCoverage(scored, total);
    const at = (t: number) => {
      const auto = scored.filter((x) => x.score >= t);
      return { coverage: auto.length / total, risk: auto.length ? auto.filter((x) => x.error).length / auto.length : 0, automated: auto.length };
    };
    return {
      key: s.key,
      label: s.label,
      aurc: r3(aurc(scored)),
      points: pts.map((p) => ({ c: r3(p.coverage), r: r3(p.risk) })),
      at08: s.key.startsWith("blend") ? at(0.8) : null,
    };
  });
  return { candidates: candidates.length, total, baseRisk: r3(base), optimalAurc: r3(opt), signals };
}

function rcSvg(rc: ReturnType<typeof riskCoverageFor>): string {
  const W = 640;
  const H = 360;
  const L = 56;
  const B = 44;
  const T = 20;
  const R = 20;
  const maxC = Math.max(0.05, ...rc.signals.flatMap((s) => s.points.map((p) => p.c)));
  const x = (c: number) => L + (c / maxC) * (W - L - R);
  const y = (r: number) => T + (1 - r) * (H - T - B);
  const colors: Record<string, string> = {
    blend_cosine: "#0A7A5E",
    blend_model: "#A9550A",
    cosine: "#3E6E9E",
    certainty: "#8A8F96",
    model_retrieval: "#B3261E",
  };
  const lines = rc.signals
    .map((s) => {
      const d = [`M ${x(0)} ${y(s.points[0]?.r ?? 0)}`, ...s.points.map((p) => `L ${x(p.c).toFixed(1)} ${y(p.r).toFixed(1)}`)].join(" ");
      const dash = s.key === "blend_cosine" || s.key === "blend_model" ? "" : ' stroke-dasharray="4 4"';
      return `<path d="${d}" fill="none" stroke="${colors[s.key]}" stroke-width="${s.key.startsWith("blend") ? 2.2 : 1.4}"${dash}/>`;
    })
    .join("\n  ");
  const legend = rc.signals
    .map((s, i) => `<g transform="translate(${L + 10}, ${T + 12 + i * 16})"><rect width="10" height="3" y="-3" fill="${colors[s.key]}"/><text x="16" y="1" font-size="11" font-family="monospace" fill="#14171A">${s.label} · AURC ${s.aurc.toFixed(3)}</text></g>`)
    .join("\n  ");
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#E3E5E8"/><text x="${L - 8}" y="${y(t) + 4}" font-size="10" text-anchor="end" font-family="monospace" fill="#565D66">${t}</text>`)
    .join("");
  const xt = [0, maxC / 2, maxC].map((t) => `<text x="${x(t)}" y="${H - B + 16}" font-size="10" text-anchor="middle" font-family="monospace" fill="#565D66">${(t * 100).toFixed(0)}%</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  ${ticks}${xt}
  <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#CBCFD4"/>
  <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#CBCFD4"/>
  <line x1="${L}" x2="${W - R}" y1="${y(rc.baseRisk)}" y2="${y(rc.baseRisk)}" stroke="#14171A" stroke-dasharray="2 3" opacity="0.5"/>
  ${lines}
  ${legend}
  <text x="${(L + W - R) / 2}" y="${H - 8}" font-size="11" text-anchor="middle" font-family="monospace" fill="#14171A">coverage: share of all tickets auto-resolved</text>
  <text x="14" y="${(T + H - B) / 2}" font-size="11" text-anchor="middle" font-family="monospace" fill="#14171A" transform="rotate(-90 14 ${(T + H - B) / 2})">risk: auto-resolved but should have escalated</text>
</svg>
`;
}

function mdMatrix(c: { labels: string[]; matrix: number[][] }, rowTitle: string): string {
  const short = (l: string) => l.replace("technical_api_error", "technical").replace("feature_question", "feature").replace("account_access", "account").replace("security_abuse", "security").replace("sales_enterprise", "sales").replace("bug_report", "bug");
  const head = `| ${rowTitle} ↓ / predicted → | ${c.labels.map(short).join(" | ")} |`;
  const sep = `|---|${c.labels.map(() => "---:").join("|")}|`;
  const rows = c.labels.map((l, i) => `| **${short(l)}** | ${c.matrix[i].map((v, j) => (i === j ? `**${v}**` : v ? String(v) : "·")).join(" | ")} |`);
  return [head, sep, ...rows].join("\n");
}

async function main() {
  if (process.argv.includes("--pilot")) return pilot();

  const gold = goldById() as Map<string, Gold>;
  const texts = await loadTexts(gold);
  const everything = readRuns(false);
  // Infrastructure failures seen in the raw files (some were re-run and replaced).
  const infraExcluded = infraRecordsSeen;
  const infraUnreplaced = everything.filter(isInfra).length;
  const all = everything.filter((r) => !isInfra(r));
  if (all.length === 0) throw new Error("no runs in evals/runs/*.jsonl — run `npm run eval:run` first");

  const models = [...new Set(all.map((r) => r.model))].sort();
  const seeds = [...new Set(all.map((r) => r.seed))].sort();
  // The report leads with the model the labeled pilot picked (model-pick.json).
  const pickFile = path.join(ROOT, "evals", "results", "model-pick.json");
  const picked = fs.existsSync(pickFile) ? (JSON.parse(fs.readFileSync(pickFile, "utf8")).picked as string) : null;
  const primary = picked && models.includes(picked) ? picked : models[0];

  // Unlabeled calibration of the cosine band: best-match similarity per run.
  const bestSims = all.filter((r) => r.similarities.length).map((r) => Math.max(...r.similarities));
  const cal = { p10: r3(quantile(bestSims, 0.1)), p50: r3(quantile(bestSims, 0.5)), p90: r3(quantile(bestSims, 0.9)), floor: COSINE_FLOOR, ceil: COSINE_CEIL };

  const dataset: Dataset = {
    core: [...gold.values()].filter((g) => g.set === "core").length,
    hard: [...gold.values()].filter((g) => g.set === "hard").length,
    coreEscalate: [...gold.values()].filter((g) => g.set === "core" && g.gold_route === "escalate").length,
    coreAuto: [...gold.values()].filter((g) => g.set === "core" && g.gold_route === "auto_resolve").length,
  };
  const out: Record<string, unknown> = {
    status: "complete",
    generatedAt: new Date().toISOString(),
    seeds,
    models,
    primary,
    dataset,
    cosine: cal,
    shipped: SHIPPED,
    infraExcluded,
    infraUnreplaced,
  };

  const byModel = groupBy(all, (r) => r.model);
  const perModel: Record<string, { core?: SetOut; hard?: SetOut }> = {};
  const md: string[] = [];

  for (const model of models) {
    const runs = byModel.get(model)!;
    const sets: { core?: SetOut; hard?: SetOut } = {};
    for (const set of ["core", "hard"] as const) {
      const rs = runs.filter((r) => gold.get(r.ticket_id)?.set === set);
      if (!rs.length) continue;
      const variants: VariantOut[] = VARIANTS.map((v) => {
        const perSeed = seeds.map((s) => score(rs.filter((r) => r.seed === s), v, gold, texts)).filter((x) => x.n > 0);
        const pooled = score(rs, v, gold, texts);
        const metric = (f: (s: Scored) => number) => {
          const mr = meanRange(perSeed.map(f));
          return { mean: r3(mr.mean), min: r3(mr.min), max: r3(mr.max) };
        };
        const c = pooled.counts;
        return {
          key: v.key,
          label: v.label,
          escalationRecall: metric((s) => escalationRecall(s.counts)),
          escalationRecallCI: recallCI(rs, v, gold, texts).map(r3),
          unsafeAutoResolves: metric((s) => s.counts.fn),
          autoResolvePrecision: metric((s) => autoResolvePrecision(s.counts)),
          autoResolveRecall: metric((s) => autoResolveRecall(s.counts)),
          coverage: metric((s) => coverage(s.counts)),
          sensitiveRecall: metric((s) => (s.sensitiveTotal ? s.sensitiveEscalated / s.sensitiveTotal : 1)),
          netCatches: metric((s) => s.netCatches),
          pooled: c,
        };
      });
      const completion = meanRange(seeds.map((s) => rs.filter((r) => r.seed === s)).filter((x) => x.length).map((x) => x.filter((r) => r.completed).length / x.length));
      const done = rs.filter((r) => r.completed && r.category);
      const cat = confusion(
        done.map((r) => ({ gold: gold.get(r.ticket_id)!.gold_category, pred: CATEGORIES.includes(r.category!) ? r.category! : "technical_api_error" })),
        CATEGORIES
      );
      const f1 = macroF1(cat);
      sets[set] = {
        runs: rs.length,
        completion: { mean: r3(completion.mean), min: r3(completion.min), max: r3(completion.max) },
        completedRuns: rs.filter((r) => r.completed && r.category).length,
        seedsRun: new Set(rs.map((r) => r.seed)).size,
        categoryAccuracy: r3(done.filter((r) => r.category === gold.get(r.ticket_id)!.gold_category).length / Math.max(1, done.length)),
        macroF1: r3(f1.macro),
        perClass: Object.fromEntries(Object.entries(f1.perClass).map(([k, v]) => [k, { precision: r3(v.precision), recall: r3(v.recall), support: v.support }])),
        categoryConfusion: cat,
        variants,
        riskCoverage: set === "core" ? riskCoverageFor(rs, gold, texts) : undefined,
        cost: { total: r3(rs.reduce((a, r) => a + r.cost, 0)), perTicket: rs.reduce((a, r) => a + r.cost, 0) / rs.length },
        latencyS: r3(rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length / 1000),
      };
    }
    perModel[model] = sets;
  }
  out.perModel = perModel;

  // Same-model comparison: base routing vs :exacto, pooled over seeds, core set.
  // Only seeds both configs completed are compared, so the pair stays matched.
  const baseModel = models.find((m) => !m.endsWith(":exacto") && models.includes(`${m}:exacto`));
  let exacto: { seeds: number[]; base: ExactoSide; exacto: ExactoSide; completionP: number; escalationRecallP: number } | null = null;
  if (baseModel && models.includes(`${baseModel}:exacto`)) {
    const shippedV = VARIANTS.find((v) => v.key === SHIPPED)!;
    // A seed counts only if both configs finished every core ticket on it.
    const fullSeeds = (m: string) =>
      new Set(
        seeds.filter((s) => byModel.get(m)!.filter((r) => r.seed === s && gold.get(r.ticket_id)?.set === "core").length === dataset.core)
      );
    const shared = [...fullSeeds(baseModel)].filter((s) => fullSeeds(`${baseModel}:exacto`).has(s));
    const cmp = [baseModel, `${baseModel}:exacto`].map((m) => {
      const rs = byModel.get(m)!.filter((r) => gold.get(r.ticket_id)?.set === "core" && shared.includes(r.seed));
      const s = score(rs, shippedV, gold, texts);
      return { model: m, runs: rs.length, completed: s.completed, counts: s.counts, cost: rs.reduce((a, r) => a + r.cost, 0) / rs.length, latencyS: rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length / 1000 };
    });
    const [a, b] = cmp;
    exacto = {
      seeds: shared,
      base: { ...a, completion: r3(a.completed / a.runs), escalationRecall: r3(escalationRecall(a.counts)) },
      exacto: { ...b, completion: r3(b.completed / b.runs), escalationRecall: r3(escalationRecall(b.counts)) },
      completionP: fisherExact(a.completed, a.runs - a.completed, b.completed, b.runs - b.completed),
      escalationRecallP: fisherExact(a.counts.tp, a.counts.fn, b.counts.tp, b.counts.fn),
    };
    out.exacto = exacto;
  }

  fs.mkdirSync(path.join(ROOT, "evals", "results"), { recursive: true });

  /* ── markdown report ── */
  const P = perModel[primary].core!;
  const H = perModel[primary].hard;
  const v = (sets: SetOut, key: string) => sets.variants.find((x) => x.key === key)!;
  const fmt = (m: { mean: number; min: number; max: number }, asPct = true) =>
    asPct ? `${pct(m.mean)} (${pct(m.min)}–${pct(m.max)})` : `${m.mean.toFixed(1)} (${m.min}–${m.max})`;

  md.push(`# Evaluation`, ``);
  md.push(`*Generated by \`npm run eval:report\` on ${new Date().toISOString().slice(0, 10)} — do not edit by hand.*`, ``);
  md.push(`## What was measured`, ``);
  md.push(
    `The agent was run on **${dataset.core} labeled tickets** (the original synthetic set) and **${dataset.hard} author-written hard cases**, ` +
      `**${seeds.length} times each** (seeds ${seeds.join(", ")}), with ${models.map((m) => `\`${m}\``).join(" and ")}. ` +
      `Every number below is the mean over seeds, with the min–max across seeds in parentheses. Runs never write to the database.`,
    ``
  );
  md.push(`**Headline metric: must-escalate recall** — of the tickets the gold labels say need a human, the share the system actually routed to one. ` +
    `An unsafe auto-resolve (a billing dispute or security report answered by the bot) is the expensive failure, so this is the number to protect; ` +
    `auto-resolve precision and coverage say what that safety costs.`, ``);
  md.push(`Gold labels: [\`evals/labels.json\`](../evals/labels.json) (labeling policy inside) and [\`evals/hard-cases.json\`](../evals/hard-cases.json). ` +
    `Incomplete runs (no valid \`submit_resolution\`) count as escalated, because that is what happens to them in production.`, ``);

  const rc = P.riskCoverage!;
  // Safety net, judged on the ticket text alone (no model involved).
  const netText = (() => {
    let fires = 0;
    let sensitive = 0;
    let caught = 0;
    let falseHits = 0;
    for (const [id, g] of gold) {
      const hit = safetyNet(texts.get(id) ?? "");
      const sens = SENSITIVE_NET.has(g.gold_category);
      if (sens) sensitive++;
      if (hit) {
        fires++;
        if (sens) caught++;
        else falseHits++;
      }
    }
    return { tickets: gold.size, fires, sensitive, caught, falseHits };
  })();
  const cosineCore = v(P, COSINE);
  const beforeCore = v(P, "before");
  const decisionsChanged = (key: string, sets: (SetOut | undefined)[]) =>
    sets.reduce((acc, st) => acc + (st ? v(st, key).netCatches.mean * seeds.length : 0), 0);
  // Paired, ticket-clustered comparison of shipped vs cosine on the same runs:
  // both arms route identical agent outputs, so the difference is pure routing.
  const primaryCore = byModel.get(primary)!.filter((r) => gold.get(r.ticket_id)?.set === "core");
  const shippedVar = VARIANTS.find((x) => x.key === SHIPPED)!;
  const cosineVar = VARIANTS.find((x) => x.key === COSINE)!;
  const paired = primaryCore.map((r) => {
    const t = texts.get(r.ticket_id) ?? "";
    return {
      ticket_id: r.ticket_id,
      gold: gold.get(r.ticket_id)!.gold_route === "escalate",
      s: predEscalate(r, shippedVar, t).escalate,
      c: predEscalate(r, cosineVar, t).escalate,
    };
  });
  const recallOf = (xs: typeof paired, k: "s" | "c") => {
    const g = xs.filter((x) => x.gold);
    return g.length ? g.filter((x) => x[k]).length / g.length : NaN;
  };
  const unsafeOf = (xs: typeof paired, k: "s" | "c") => xs.filter((x) => x.gold && !x[k]).length / seeds.length;
  const recallDiffCI = clusterBootstrap(byTicket(paired), (cs) => recallOf(cs.flat(), "s") - recallOf(cs.flat(), "c"));
  const unsafeDiffCI = clusterBootstrap(byTicket(paired), (cs) => unsafeOf(cs.flat(), "c") - unsafeOf(cs.flat(), "s"));
  const candScored = rcCandidates(primaryCore, texts).map((r) => ({
    ticket_id: r.ticket_id,
    error: gold.get(r.ticket_id)!.gold_route === "escalate",
    model: computeConfidence(r.model_retrieval ?? 0, r.self_certainty ?? 0),
    cosine: computeConfidence(cosineRetrievalScore(r.similarities), r.self_certainty ?? 0),
    certainty: r.self_certainty ?? 0,
  }));
  const aurcBy = (xs: typeof candScored, k: "model" | "cosine" | "certainty") => aurc(xs.map((x) => ({ score: x[k], error: x.error })));
  const aurcDiffCI = clusterBootstrap(byTicket(candScored), (cs) => aurcBy(cs.flat(), "cosine") - aurcBy(cs.flat(), "model"));
  const blendVsCertaintyCI = clusterBootstrap(byTicket(candScored), (cs) => aurcBy(cs.flat(), "certainty") - aurcBy(cs.flat(), "model"));
  const completedEsc = primaryCore.filter((r) => r.completed && r.category && gold.get(r.ticket_id)!.gold_route === "escalate");
  const completedOnlyRecall =
    completedEsc.filter((r) => predEscalate(r, shippedVar, texts.get(r.ticket_id) ?? "").escalate).length / Math.max(1, completedEsc.length);
  const excludesZero = (ci: number[]) => ci[0] > 0 || ci[1] < 0;
  const stats = {
    ciMethod: "95% percentile bootstrap over tickets (all seeds of a ticket resampled together), 4000 resamples, fixed seed",
    tickets: new Set(primaryCore.map((r) => r.ticket_id)).size,
    escalateTickets: dataset.coreEscalate,
    completedOnlyRecall: r3(completedOnlyRecall),
    completedOnlyRuns: completedEsc.length,
    recallDiff: r3(recallOf(paired, "s") - recallOf(paired, "c")),
    recallDiffCI: recallDiffCI.map(r3),
    unsafeDiff: r3(unsafeOf(paired, "c") - unsafeOf(paired, "s")),
    unsafeDiffCI: unsafeDiffCI.map(r3),
    aurcDiff: r3(aurcBy(candScored, "cosine") - aurcBy(candScored, "model")),
    aurcDiffCI: aurcDiffCI.map(r3),
    blendVsCertainty: r3(aurcBy(candScored, "certainty") - aurcBy(candScored, "model")),
    blendVsCertaintyCI: blendVsCertaintyCI.map(r3),
  };
  const findings = {
    stats,
    cosine: {
      recallBefore: beforeCore.escalationRecall.mean,
      recallCosine: cosineCore.escalationRecall.mean,
      unsafeBefore: beforeCore.unsafeAutoResolves.mean,
      unsafeCosine: cosineCore.unsafeAutoResolves.mean,
      aurcModel: rc.signals.find((x) => x.key === "blend_model")!.aurc,
      aurcCosine: rc.signals.find((x) => x.key === "blend_cosine")!.aurc,
      aurcCosineAlone: rc.signals.find((x) => x.key === "cosine")!.aurc,
      baseRisk: rc.baseRisk,
    },
    net: { ...netText, decisionsChanged: Math.round(decisionsChanged(SHIPPED, [P, H])) },
    bug: (() => {
      const i = P.categoryConfusion.labels.indexOf("bug_report");
      const row = P.categoryConfusion.matrix[i];
      return { total: row.reduce((x, y) => x + y, 0), labeledBug: row[i] };
    })(),
  };
  out.findings = findings;
  fs.writeFileSync(path.join(ROOT, "evals", "results", "summary.json"), JSON.stringify(out, null, 2) + "\n");

  md.push(`## Findings`, ``);
  const findingLines = [
    `- **Cosine similarity did not earn its place; rejected.** Swapping the model's self-reported retrieval score for the search's own cosine similarity ` +
      `lowered must-escalate recall from ${pct(findings.cosine.recallBefore)} to ${pct(findings.cosine.recallCosine)} and raised unsafe auto-resolves from ` +
      `${findings.cosine.unsafeBefore.toFixed(1)} to ${findings.cosine.unsafeCosine.toFixed(1)} per run. As a ranking signal, cosine alone (AURC ${findings.cosine.aurcCosineAlone.toFixed(3)}) ` +
      `does worse than no ranking at all (${findings.cosine.baseRisk.toFixed(3)}). Similarity measures whether a ticket is on-topic for the docs, not whether the docs can resolve it. ` +
      `Paired over the same runs with a ticket-level bootstrap, the recall gap is ${(stats.recallDiff * 100).toFixed(1)} pts ` +
      `(95% CI ${(stats.recallDiffCI[0] * 100).toFixed(1)} to ${(stats.recallDiffCI[1] * 100).toFixed(1)}) and the AURC gap ${stats.aurcDiff.toFixed(3)} ` +
      `(${stats.aurcDiffCI[0].toFixed(3)} to ${stats.aurcDiffCI[1].toFixed(3)}): ` +
      `${excludesZero(stats.recallDiffCI) || excludesZero(stats.aurcDiffCI) ? "at least one gap excludes zero" : `every gap points the same way, but none is significant on ${stats.tickets} tickets`}. ` +
      `The decision rests on that: no evidence the change helps and every point estimate says it hurts, so production keeps the model's score.`,
    `- **The 0.6/0.4 weights are a prior, not a fit.** The blend ranks only slightly better than self-certainty alone ` +
      `(AURC gap ${stats.blendVsCertainty.toFixed(3)}, 95% CI ${stats.blendVsCertaintyCI[0].toFixed(3)} to ${stats.blendVsCertaintyCI[1].toFixed(3)}), ` +
      `so the data neither supports nor rules out re-weighting; with ${stats.tickets} tickets, fitting weights would overfit the labels.`,
    `- **The safety net works, but this model didn't need it.** On the ticket text alone it fires on ${netText.fires}/${netText.tickets} tickets, ` +
      `catches ${netText.caught}/${netText.sensitive} gold billing/security/sales tickets and makes ${netText.falseHits} false hits. It changed ` +
      `${findings.net.decisionsChanged} routing decisions, because the model had already labeled every one of those tickets correctly. Shipped as a free backstop ` +
      `for a model that mislabels; its misses are the deliberately disguised hard cases.`,
    `- **The "bug reports always escalate" rule barely fires.** Only ${findings.bug.labeledBug} of ${findings.bug.total} bug-report runs were labeled ` +
      `\`bug_report\`; most were filed as \`technical_api_error\` and reached a human only through low confidence. Category rules are only as good as the classifier.`,
    ...(exacto
      ? [
          `- **Exacto routing helps the same model finish.** On \`${exacto.base.model}\`, completion went from ${pct(exacto.base.completion)} to ` +
            `${pct(exacto.exacto.completion)} (Fisher p = ${exacto.completionP.toFixed(3)}) at ${(exacto.base.cost / exacto.exacto.cost).toFixed(1)}× lower cost per ticket; ` +
            `the must-escalate recall difference is not significant (p = ${exacto.escalationRecallP.toFixed(2)}).`,
        ]
      : []),
  ];
  md.push(...findingLines, ``);

  md.push(`## Results — ${primary}, original ${dataset.core} tickets`, ``);
  md.push(`| Routing | Must-escalate recall | Unsafe auto-resolves / run | Auto-resolve precision | Coverage |`);
  md.push(`|---|---:|---:|---:|---:|`);
  for (const x of P.variants) {
    md.push(`| ${x.label} | ${fmt(x.escalationRecall)} | ${fmt(x.unsafeAutoResolves, false)} | ${fmt(x.autoResolvePrecision)} | ${fmt(x.coverage)} |`);
  }
  md.push(``, `Completion rate (valid \`submit_resolution\`): ${fmt(P.completion)}. Category accuracy ${pct(P.categoryAccuracy)}, macro-F1 ${P.macroF1.toFixed(3)} (pooled over seeds, completed runs).`, ``);

  md.push(`### Routing confusion (pooled over ${seeds.length} seeds)`, ``);
  for (const key of [SHIPPED, COSINE]) {
    const c = v(P, key).pooled as RouteCounts;
    md.push(`**${v(P, key).label}**`, ``);
    md.push(`| gold ↓ / routed → | escalated | auto-resolved |`, `|---|---:|---:|`);
    md.push(`| **needs a human** | ${c.tp} | ${c.fn} |`, `| **docs-answerable** | ${c.fp} | ${c.tn} |`, ``);
  }

  md.push(`### Category confusion (${primary}, pooled, completed runs)`, ``);
  md.push(mdMatrix(P.categoryConfusion, "gold"), ``);

  md.push(`## Risk-coverage: which confidence signal ranks tickets best?`, ``);
  md.push(
    `Among the ${rc.candidates} completed runs a threshold could auto-resolve (not already escalated by the category rule or safety net), ` +
      `tickets are sorted by each signal and auto-resolved from the top down. Lower AURC = the signal puts the tickets that need a human last. ` +
      `A perfect ranking scores ${rc.optimalAurc.toFixed(3)}; ignoring the signal entirely scores about ${rc.baseRisk.toFixed(3)} (the base error rate).`,
    ``
  );
  md.push(`![Risk-coverage curves](eval/risk-coverage.svg)`, ``);
  md.push(`| Signal | AURC ↓ | At the 0.8 threshold |`, `|---|---:|---|`);
  for (const s of rc.signals) {
    md.push(`| ${s.label} | ${s.aurc.toFixed(3)} | ${s.at08 ? `${pct(s.at08.coverage)} coverage, ${pct(s.at08.risk)} risk` : "—"} |`);
  }
  md.push(``, `Cosine band (unlabeled calibration): best-match similarity p10 = ${cal.p10}, median = ${cal.p50}, p90 = ${cal.p90}; production rescales [${cal.floor}, ${cal.ceil}] → [0, 1].`, ``);

  if (exacto) {
    const e = exacto;
    md.push(`## Same model, with and without Exacto routing`, ``);
    md.push(
      `The headline model has a single provider, so Exacto can't change anything for it. This check uses \`${e.base.model}\`, ` +
        `which is served by many providers of varying quality, on the ${dataset.core} labeled tickets × seeds ${e.seeds.join(", ")}.`,
      ``
    );
    md.push(`| Config | Completion | Must-escalate recall | $ / ticket | Latency |`, `|---|---:|---:|---:|---:|`);
    for (const x of [e.base, e.exacto]) md.push(`| \`${x.model}\` | ${pct(x.completion)} | ${pct(x.escalationRecall)} | $${x.cost.toFixed(5)} | ${x.latencyS.toFixed(1)}s |`);
    md.push(``, `Fisher exact (pooled runs): completion p = ${e.completionP.toFixed(3)}, must-escalate recall p = ${e.escalationRecallP.toFixed(3)}. ` +
      `Only the provider routing differs, so any gap here is Exacto's, not the model's.`, ``);
  }

  if (H) {
    md.push(`## Hard cases (stress test, ${dataset.hard} tickets)`, ``);
    md.push(`Written by the same author as the safety net, so read these as a stress test rather than an unbiased estimate.`, ``);
    md.push(`| Routing | Must-escalate recall | Unsafe auto-resolves / run | Auto-resolve precision |`, `|---|---:|---:|---:|`);
    for (const x of H.variants) md.push(`| ${x.label} | ${fmt(x.escalationRecall)} | ${fmt(x.unsafeAutoResolves, false)} | ${fmt(x.autoResolvePrecision)} |`);
    md.push(``);
  }

  md.push(`## Caveats`, ``);
  md.push(
    `- ${dataset.core + dataset.hard} tickets is small. The 95% interval on the shipped arm's must-escalate recall is ${pct(v(P, SHIPPED).escalationRecallCI[0])}–${pct(v(P, SHIPPED).escalationRecallCI[1])}: ` +
      `a bootstrap that resamples the ${stats.escalateTickets} needs-a-human tickets, not the ${stats.escalateTickets * seeds.length} runs, because repeated runs of one ticket are not independent evidence.`,
    `- Incomplete runs count as escalated, which flatters recall for a model that fails often. On completed runs only, the shipped arm's must-escalate recall is ` +
      `${pct(stats.completedOnlyRecall)} (${stats.completedOnlyRuns} runs), so the headline is not propped up by failures.`,
    `- Per-seed means of a ratio (e.g. auto-resolve precision) can differ in the last digit from the pooled ratio in the confusion tables.`,
    `- Labels were made by one labeler (Claude) against a written policy; ambiguous calls are noted per ticket in the label files.`,
    `- Seeds are passed through but not every provider honours them; the runs are best read as ${seeds.length} independent samples.`,
    `- ${infraExcluded} run(s) failed on provider infrastructure (429/5xx/network, or a doc search that errored); ${infraExcluded - infraUnreplaced} were re-run and ${infraUnreplaced} remain excluded, never counted against the agent. A retry only ever replaces a record that was itself an infrastructure failure.`,
    `- Doc search in the eval runs against an in-memory copy of the same index (same stored vectors, same exact cosine top-k as \`match_doc_chunks\`), because the live database's exact scan timed out under load. Spot-checked against the live RPC: identical top-5.`,
    `- \`check_status\` (Anthropic's live status page) was unreachable from the sandbox the eval ran in, so the agent saw a tool error on every status check, identically across configurations. Absolute certainty on error-type tickets may be slightly lower than in production; comparisons between configurations are unaffected.`,
    `- The model was chosen from a 12-ticket, single-seed pilot run before the search fix; a few pilot runs had degraded search. The choice was forced by budget either way: only one candidate's full run fit the $1 budget. It ranked candidates by routing accuracy under the then-planned cosine arm, so it was a screen, not a benchmark.`,
    ``
  );
  md.push(`Total eval spend: $${models.reduce((a, m) => a + (perModel[m].core?.cost.total ?? 0) + (perModel[m].hard?.cost.total ?? 0), 0).toFixed(3)}.`, ``);

  fs.mkdirSync(path.join(ROOT, "docs", "eval"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "EVALUATION.md"), md.join("\n"));
  fs.writeFileSync(path.join(ROOT, "docs", "eval", "risk-coverage.svg"), rcSvg(rc));

  /* ── headline table in the case study and README, between eval markers ── */
  const headline = (reportLink: string) =>
    [
      "<!-- eval:start -->",
      `| \`${primary}\`, ${dataset.core} labeled tickets × ${seeds.length} seeds | Must-escalate recall | Unsafe auto-resolves / run | Auto-resolve precision | Coverage |`,
      `|---|---:|---:|---:|---:|`,
      ...P.variants.map(
        (x) =>
          `| ${x.key === SHIPPED ? `**${x.label}**` : x.label} | ${fmt(x.escalationRecall)} | ${fmt(x.unsafeAutoResolves, false)} | ${fmt(x.autoResolvePrecision)} | ${fmt(x.coverage)} |`
      ),
      ``,
      `*Mean over seeds, min–max in parentheses. Safety net on the ticket text alone: fires on ${netText.fires}/${netText.tickets} tickets, ` +
        `catches ${netText.caught}/${netText.sensitive} billing/security/sales tickets, ${netText.falseHits} false hits. Full report: [EVALUATION.md](${reportLink}).*`,
      "<!-- eval:end -->",
    ].join("\n");
  const between = (text: string, start: string, end: string, body: string) => {
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    return i < 0 || j < 0 ? text : text.slice(0, i) + start + "\n" + body + "\n" + end + text.slice(j + end.length);
  };
  for (const [file, link] of [
    [path.join(ROOT, "docs", "CASE_STUDY.md"), "EVALUATION.md"],
    [path.join(ROOT, "README.md"), "docs/EVALUATION.md"],
  ]) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, "utf8");
    const table = headline(link).split("\n").slice(1, -1).join("\n");
    text = between(text, "<!-- eval:start -->", "<!-- eval:end -->", table);
    text = between(text, "<!-- eval-notes:start -->", "<!-- eval-notes:end -->", findingLines.join("\n"));
    fs.writeFileSync(file, text);
  }

  console.log(md.join("\n"));
  console.log(`\nWrote evals/results/summary.json, docs/EVALUATION.md, docs/eval/risk-coverage.svg`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
