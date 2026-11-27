/**
 * Multi-agent report. Recomputes every arm offline from the raw run, checker
 * and judge records, using the same functions production uses (routeTicket,
 * applyChecker, applyGrounding), and writes:
 *   evals/results/multiagent.json  (the intro page renders only from this)
 *   docs/MULTI_AGENT.md
 *   the tables between <!-- multi:start --> / <!-- multi:end --> in README and case study
 *
 * Usage: npm run eval:multi
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { getSupabaseAdmin } from "../../src/lib/supabase";
import { applyChecker, parseCheckerReview } from "../../src/lib/agent/guardrails";
import type { Route } from "../../src/lib/agent/routing";
import { clusterBootstrap } from "./metrics";
import { loadEvalSet, type EvalTicket } from "./data";
import type { RunRecord } from "./run";
import { JUDGE_MODEL } from "./judge";
import { RUNS, ROOT, loadAllRuns, readJsonl, runKey, shippedRoute, type CheckerRecord, type JudgeRecord } from "./multiData";

const PRIMARY = "qwen/qwen3.7-flash";
const CHECKERS = ["deepseek/deepseek-v4-flash", "qwen/qwen3.7-flash"];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

type Row = { r: RunRecord; t: EvalTicket; gold: boolean; route: Route; extraCost: number; checked: boolean; checkerVerdict: string | null };

function rowsFor(records: RunRecord[], tickets: Map<string, EvalTicket>, source: string, checker: Map<string, CheckerRecord> | null): Row[] {
  const out: Row[] = [];
  for (const r of records) {
    const t = tickets.get(r.ticket_id);
    if (!t) continue;
    const base = shippedRoute(r, `${t.subject}\n\n${t.body}`);
    let route = base;
    let extraCost = 0;
    let checked = false;
    let checkerVerdict: string | null = null;
    if (checker && base.status === "auto_resolved") {
      const c = checker.get(`${source}|${runKey(r)}`);
      checked = true;
      // A proposal with no usable review fails closed, exactly as in production.
      const review = c && !c.transport ? parseCheckerReview(c.verdict === "escalate" ? { verdict: "escalate", reason: c.reason } : c.verdict === "agree" ? { verdict: "agree" } : null) : null;
      route = applyChecker(base, review);
      extraCost = c?.cost ?? 0;
      checkerVerdict = review ? review.verdict : "unavailable";
    }
    out.push({ r, t, gold: t.gold_route === "escalate", route, extraCost, checked, checkerVerdict });
  }
  return out;
}

type Arm = {
  key: string;
  label: string;
  set: "core" | "hard";
  runs: number;
  seeds: number;
  completion: number;
  recall: number;
  recallCI: number[];
  unsafePerRun: number;
  coverage: number;
  autoPrecision: number;
  costPerTicket: number;
  extraCostPerTicket: number;
  latencyS: number;
  checker?: { reviewed: number; agreed: number; escalated: number; unavailable: number; caught: number; falseAlarms: number; unsafeProposals: number; safeProposals: number };
};

function summarize(key: string, label: string, set: "core" | "hard", rows: Row[]): Arm {
  const seeds = [...new Set(rows.map((x) => x.r.seed))].sort();
  const perSeed = seeds.map((s) => rows.filter((x) => x.r.seed === s));
  const recallOf = (xs: Row[]) => {
    const g = xs.filter((x) => x.gold);
    return g.length ? g.filter((x) => x.route.status === "escalated").length / g.length : NaN;
  };
  const autoOf = (xs: Row[]) => xs.filter((x) => x.route.status === "auto_resolved");
  const ci = clusterBootstrap([...groupBy(rows, (x) => x.r.ticket_id).values()], (cs) => recallOf(cs.flat()));
  const checked = rows.filter((x) => x.checked);
  return {
    key,
    label,
    set,
    runs: rows.length,
    seeds: seeds.length,
    completion: r3(rows.filter((x) => x.r.completed).length / Math.max(1, rows.length)),
    recall: r3(mean(perSeed.map(recallOf))),
    recallCI: ci.map(r3),
    unsafePerRun: r3(mean(perSeed.map((xs) => autoOf(xs).filter((x) => x.gold).length))),
    coverage: r3(mean(perSeed.map((xs) => autoOf(xs).length / xs.length))),
    autoPrecision: r3(autoOf(rows).length ? autoOf(rows).filter((x) => !x.gold).length / autoOf(rows).length : NaN),
    costPerTicket: r3w(mean(rows.map((x) => x.r.cost + x.extraCost))),
    extraCostPerTicket: r3w(mean(rows.map((x) => x.extraCost))),
    latencyS: r3(mean(rows.map((x) => x.r.latency_ms)) / 1000),
    ...(checked.length
      ? {
          checker: {
            reviewed: checked.length,
            agreed: checked.filter((x) => x.checkerVerdict === "agree").length,
            escalated: checked.filter((x) => x.checkerVerdict === "escalate").length,
            unavailable: checked.filter((x) => x.checkerVerdict === "unavailable").length,
            unsafeProposals: checked.filter((x) => x.gold).length,
            safeProposals: checked.filter((x) => !x.gold).length,
            caught: checked.filter((x) => x.gold && x.route.status === "escalated").length,
            falseAlarms: checked.filter((x) => !x.gold && x.route.status === "escalated").length,
          },
        }
      : {}),
  };
}

const r3w = (x: number) => Math.round(x * 1e6) / 1e6;

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

/** Paired, ticket-clustered difference (b − a) of a per-run statistic between two arms over the same runs. */
function pairedDiff(a: Row[], b: Row[], stat: (xs: Row[]) => number) {
  const key = (x: Row) => `${x.r.ticket_id}#${x.r.seed}`;
  const bByKey = new Map(b.map((x) => [key(x), x]));
  const pairs = a.filter((x) => bByKey.has(key(x))).map((x) => ({ ticket_id: x.r.ticket_id, a: x, b: bByKey.get(key(x))! }));
  const f = (ps: typeof pairs) => stat(ps.map((p) => p.b)) - stat(ps.map((p) => p.a));
  return { diff: r3(f(pairs)), ci: clusterBootstrap([...groupBy(pairs, (p) => p.ticket_id).values()], (cs) => f(cs.flat())).map(r3), n: pairs.length };
}

const recallStat = (xs: Row[]) => {
  const g = xs.filter((x) => x.gold);
  return g.length ? g.filter((x) => x.route.status === "escalated").length / g.length : NaN;
};
const coverageStat = (xs: Row[]) => xs.filter((x) => x.route.status === "auto_resolved").length / Math.max(1, xs.length);
const excludesZero = (ci: number[]) => ci[0] > 0 || ci[1] < 0;

async function main() {
  const tickets = new Map((await loadEvalSet(getSupabaseAdmin(), "all")).map((t) => [t.id, t]));
  const sources = loadAllRuns(PRIMARY);
  const checkerRecs = new Map(
    CHECKERS.map((m) => {
      const recs = readJsonl<CheckerRecord>(path.join(RUNS, "checker", `${m.replace(/[/:]/g, "_")}.jsonl`));
      const byKey = new Map<string, CheckerRecord>();
      for (const c of recs) {
        const k = `${c.source}|${runKey(c)}`;
        const prev = byKey.get(k);
        if (!prev || (prev.transport && !c.transport)) byKey.set(k, c);
      }
      return [m, byKey];
    })
  );
  const main = sources.find((s) => s.label === "main")!.records;
  const single = sources.find((s) => s.label.startsWith("single_"))?.records ?? [];
  const split = sources.find((s) => s.label.startsWith("split_"))?.records ?? [];
  const singleLabel = sources.find((s) => s.label.startsWith("single_"))?.label ?? "";
  const splitLabel = sources.find((s) => s.label.startsWith("split_"))?.label ?? "";
  const [diffChecker, sameChecker] = CHECKERS;

  /* ── 1. Router + independent checker, on the main 3-seed runs ── */
  const checkerArms: Arm[] = [];
  const checkerPairs: Record<string, unknown> = {};
  for (const set of ["core", "hard"] as const) {
    const recs = main.filter((r) => r.set === set);
    const none = rowsFor(recs, tickets, "main", null);
    const diff = rowsFor(recs, tickets, "main", checkerRecs.get(diffChecker)!);
    const same = rowsFor(recs, tickets, "main", checkerRecs.get(sameChecker)!);
    checkerArms.push(
      summarize("shipped", "Router alone (shipped)", set, none),
      summarize("checker_diff", `+ checker, different model (${diffChecker.split("/")[1]})`, set, diff),
      summarize("checker_same", `+ checker, same model (${sameChecker.split("/")[1]})`, set, same)
    );
    checkerPairs[set] = {
      diff: { recall: pairedDiff(none, diff, recallStat), coverage: pairedDiff(none, diff, coverageStat) },
      same: { recall: pairedDiff(none, same, recallStat), coverage: pairedDiff(none, same, coverageStat) },
    };
  }

  /* ── 2. Researcher → writer split vs single agent, matched seeds ── */
  const judgeRecs = readJsonl<JudgeRecord>(path.join(RUNS, "judge", `${JUDGE_MODEL.replace(/[/:]/g, "_")}.jsonl`));
  const judged = new Map<string, JudgeRecord>();
  for (const j of judgeRecs) if (j.ok && !judged.has(runKey(j))) judged.set(runKey(j), j);
  const splitArms: Arm[] = [];
  const grounding: Record<string, unknown> = {};
  const splitPairs: Record<string, unknown> = {};
  for (const set of ["core", "hard"] as const) {
    const s1 = rowsFor(single.filter((r) => r.set === set), tickets, singleLabel, null);
    const s2 = rowsFor(split.filter((r) => r.set === set), tickets, splitLabel, null);
    const s1c = rowsFor(single.filter((r) => r.set === set), tickets, singleLabel, checkerRecs.get(diffChecker)!);
    const s2c = rowsFor(split.filter((r) => r.set === set), tickets, splitLabel, checkerRecs.get(diffChecker)!);
    splitArms.push(
      summarize("single", "Single agent", set, s1),
      summarize("split", "Researcher → writer", set, s2),
      summarize("single_checker", "Single agent + checker", set, s1c),
      summarize("split_checker", "Researcher → writer + checker", set, s2c)
    );
    splitPairs[set] = { recall: pairedDiff(s1, s2, recallStat), coverage: pairedDiff(s1, s2, coverageStat) };
  }

  // Grounding, core + hard together (the judge grades replies, not routes).
  const groundingFor = (rows: Row[], autoOnly: boolean) => {
    const xs = rows.filter((x) => x.r.completed && (!autoOnly || x.route.status === "auto_resolved"));
    const js = xs.map((x) => ({ x, j: judged.get(runKey(x.r)) })).filter((p): p is { x: Row; j: JudgeRecord } => !!p.j);
    return {
      replies: xs.length,
      judged: js.length,
      claimsPerReply: r3(mean(js.map((p) => p.j.claims))),
      unsupportedPerReply: r3(mean(js.map((p) => p.j.unsupported))),
      unsupportedShare: r3(js.reduce((a, p) => a + p.j.unsupported, 0) / Math.max(1, js.reduce((a, p) => a + p.j.claims, 0))),
      repliesWithUnsupported: r3(js.filter((p) => p.j.unsupported > 0).length / Math.max(1, js.length)),
    };
  };
  const allSingle = rowsFor(single, tickets, singleLabel, null);
  const allSplit = rowsFor(split, tickets, splitLabel, null);
  const chunkUrl = (() => {
    const file = path.join(ROOT, "evals", ".cache", "chunks.json");
    const m = new Map<string, string>();
    if (fs.existsSync(file)) for (const c of JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; source_url: string }[]) m.set(c.id, c.source_url);
    return m;
  })();
  const citationsOutside = (rows: Row[]) => {
    const xs = rows.filter((x) => x.r.completed);
    let total = 0;
    let outside = 0;
    for (const x of xs) {
      const urls = new Set((x.r.retrieved_ids ?? []).map((id) => chunkUrl.get(id)).filter(Boolean));
      for (const u of x.r.cited_urls ?? []) {
        total++;
        if (!urls.has(u)) outside++;
      }
    }
    return { citations: total, outsideRetrieved: outside };
  };
  // Paired by (ticket, seed): split − single unsupported claims per reply, over replies both judged.
  const unsupportedPair = (() => {
    const a = new Map(allSingle.filter((x) => judged.has(runKey(x.r))).map((x) => [`${x.r.ticket_id}#${x.r.seed}`, judged.get(runKey(x.r))!]));
    const pairs = allSplit
      .filter((x) => judged.has(runKey(x.r)) && a.has(`${x.r.ticket_id}#${x.r.seed}`))
      .map((x) => ({ ticket_id: x.r.ticket_id, s: a.get(`${x.r.ticket_id}#${x.r.seed}`)!, w: judged.get(runKey(x.r))! }));
    const f = (ps: typeof pairs) => mean(ps.map((p) => p.w.unsupported)) - mean(ps.map((p) => p.s.unsupported));
    return { diff: r3(f(pairs)), ci: clusterBootstrap([...groupBy(pairs, (p) => p.ticket_id).values()], (cs) => f(cs.flat())).map(r3), n: pairs.length };
  })();
  const splitCompleted = split.filter((r) => r.completed);
  grounding.single = { all: groundingFor(allSingle, false), autoResolved: groundingFor(allSingle, true), ...citationsOutside(allSingle) };
  grounding.split = {
    all: groundingFor(allSplit, false),
    autoResolved: groundingFor(allSplit, true),
    ...citationsOutside(allSplit),
    citationCheckPass: r3(splitCompleted.filter((r) => r.citation_ok).length / Math.max(1, splitCompleted.length)),
    writerAnswerable: r3(splitCompleted.filter((r) => r.answerable).length / Math.max(1, splitCompleted.length)),
    groundingEscalations: allSplit.filter((x) => x.route.reason?.startsWith("unsupported:")).length,
    uncitedClaims: splitCompleted.reduce((a, r) => a + (r.uncited ?? 0), 0),
    invalidIds: splitCompleted.reduce((a, r) => a + (r.invalid_ids ?? 0), 0),
    researcherInventedIds: splitCompleted.reduce((a, r) => a + (r.unknown_ids ?? 0), 0),
  };
  grounding.unsupportedDiff = unsupportedPair;

  // Judge validation.
  const val = readJsonl<JudgeRecord>(path.join(RUNS, "judge", `validate_${JUDGE_MODEL.replace(/[/:]/g, "_")}.jsonl`)).filter((j) => j.ok);
  const judgeValidation = {
    planted: val.filter((j) => j.validation === "planted").length,
    plantedCaught: val.filter((j) => j.validation === "planted" && j.unsupported > 0).length,
    verbatim: val.filter((j) => j.validation === "verbatim").length,
    verbatimAccepted: val.filter((j) => j.validation === "verbatim" && j.unsupported === 0).length,
  };

  const probesFile = path.join(ROOT, "evals", "results", "probes.json");
  const probes = fs.existsSync(probesFile) ? JSON.parse(fs.readFileSync(probesFile, "utf8")) : null;

  // Spend across every multi-agent artifact.
  const spend = {
    runs: r3w([...single, ...split].reduce((a, r) => a + r.cost, 0)),
    checker: r3w([...checkerRecs.values()].flatMap((m) => [...m.values()]).reduce((a, c) => a + c.cost, 0)),
    judge: r3w([...judgeRecs, ...readJsonl<JudgeRecord>(path.join(RUNS, "judge", `validate_${JUDGE_MODEL.replace(/[/:]/g, "_")}.jsonl`))].reduce((a, j) => a + j.cost, 0)),
    probes: r3w(probes?.cost ?? 0),
  };

  const out = {
    status: single.length && split.length && checkerArms.length ? "complete" : "partial",
    generatedAt: new Date().toISOString(),
    router: PRIMARY,
    checkers: { different: diffChecker, same: sameChecker },
    judge: JUDGE_MODEL,
    checker: { arms: checkerArms, paired: checkerPairs, seeds: [...new Set(main.map((r) => r.seed))].length },
    split: { arms: splitArms, paired: splitPairs, seeds: [...new Set(split.map((r) => r.seed))].length },
    grounding,
    judgeValidation,
    probes: probes ? { probes: probes.probes, pass: probes.pass } : null,
    spend: { ...spend, total: r3w(spend.runs + spend.checker + spend.judge + spend.probes) },
  };
  fs.writeFileSync(path.join(ROOT, "evals", "results", "multiagent.json"), JSON.stringify(out, null, 2) + "\n");

  /* ── markdown ── */
  const A = (arms: Arm[], key: string, set: "core" | "hard") => arms.find((a) => a.key === key && a.set === set)!;
  const ciTxt = (ci: number[], scale = 100, unit = " pts") => `${(ci[0] * scale).toFixed(1)} to ${(ci[1] * scale).toFixed(1)}${unit}`;
  const cp = checkerPairs.core as { diff: { recall: ReturnType<typeof pairedDiff>; coverage: ReturnType<typeof pairedDiff> }; same: { recall: ReturnType<typeof pairedDiff>; coverage: ReturnType<typeof pairedDiff> } };
  const sp = splitPairs.core as { recall: ReturnType<typeof pairedDiff>; coverage: ReturnType<typeof pairedDiff> };
  const g = grounding as {
    single: { all: ReturnType<typeof groundingFor>; autoResolved: ReturnType<typeof groundingFor>; citations: number; outsideRetrieved: number };
    split: { all: ReturnType<typeof groundingFor>; autoResolved: ReturnType<typeof groundingFor>; citations: number; outsideRetrieved: number; citationCheckPass: number; writerAnswerable: number; groundingEscalations: number };
  };
  const table = (arms: Arm[], set: "core" | "hard", extra = true) => {
    const lines = [
      `| Arm | Must-escalate recall (95% CI) | Unsafe auto-resolves / run | Coverage | Auto-resolve precision | $ / ticket${extra ? " (extra)" : ""} |`,
      `|---|---:|---:|---:|---:|---:|`,
    ];
    for (const a of arms.filter((x) => x.set === set))
      lines.push(
        `| ${a.label} | ${pct(a.recall)} (${pct(a.recallCI[0], 0)}–${pct(a.recallCI[1], 0)}) | ${a.unsafePerRun.toFixed(1)} | ${pct(a.coverage)} | ${Number.isFinite(a.autoPrecision) ? pct(a.autoPrecision) : "—"} | $${a.costPerTicket.toFixed(4)}${extra && a.extraCostPerTicket ? ` (+$${a.extraCostPerTicket.toFixed(5)})` : ""} |`
      );
    return lines.join("\n");
  };
  const cd = A(checkerArms, "checker_diff", "core");
  const cs = A(checkerArms, "checker_same", "core");
  const c0 = A(checkerArms, "shipped", "core");
  const s1 = A(splitArms, "single", "core");
  const s2 = A(splitArms, "split", "core");

  const headline = [
    `| ${PRIMARY}, ${tickets.size - 12} labeled tickets | Must-escalate recall | Unsafe auto-resolves / run | Coverage | Extra $ / ticket |`,
    `|---|---:|---:|---:|---:|`,
    `| Router alone (shipped) | ${pct(c0.recall)} | ${c0.unsafePerRun.toFixed(1)} | ${pct(c0.coverage)} | — |`,
    `| + independent checker (${diffChecker.split("/")[1]}) | ${pct(cd.recall)} | ${cd.unsafePerRun.toFixed(1)} | ${pct(cd.coverage)} | +$${cd.extraCostPerTicket.toFixed(5)} |`,
    `| + same-model checker | ${pct(cs.recall)} | ${cs.unsafePerRun.toFixed(1)} | ${pct(cs.coverage)} | +$${cs.extraCostPerTicket.toFixed(5)} |`,
    ``,
    `| Grounding (all completed replies, core + hard) | Unsupported claims / reply | Replies with any unsupported claim |`,
    `|---|---:|---:|`,
    `| Single agent | ${g.single.all.unsupportedPerReply.toFixed(2)} | ${pct(g.single.all.repliesWithUnsupported)} |`,
    `| Researcher → writer | ${g.split.all.unsupportedPerReply.toFixed(2)} | ${pct(g.split.all.repliesWithUnsupported)} |`,
  ].join("\n");

  const findings = [
    `- **The independent checker trades coverage for safety.** On the ${c0.runs / c0.seeds} core tickets × ${c0.seeds} seeds, a ${diffChecker.split("/")[1]} checker took must-escalate recall from ${pct(c0.recall)} to ${pct(cd.recall)} ` +
      `(paired change ${(cp.diff.recall.diff * 100).toFixed(1)} pts, 95% CI ${ciTxt(cp.diff.recall.ci)}) and unsafe auto-resolves from ${c0.unsafePerRun.toFixed(1)} to ${cd.unsafePerRun.toFixed(1)} per run, ` +
      `but coverage fell from ${pct(c0.coverage)} to ${pct(cd.coverage)} (CI ${ciTxt(cp.diff.coverage.ci)}). It caught ${cd.checker?.caught}/${cd.checker?.unsafeProposals} unsafe auto-resolve proposals and blocked ${cd.checker?.falseAlarms}/${cd.checker?.safeProposals} safe ones. ` +
      `Extra cost: $${cd.extraCostPerTicket.toFixed(5)} per ticket.`,
    `- **A second model family matters more than a second prompt.** The same-model checker (same prompt, ${sameChecker.split("/")[1]}) caught ${cs.checker?.caught}/${cs.checker?.unsafeProposals} unsafe proposals and blocked ${cs.checker?.falseAlarms}/${cs.checker?.safeProposals} safe ones: ` +
      `recall ${pct(cs.recall)} (paired change ${(cp.same.recall.diff * 100).toFixed(1)} pts, CI ${ciTxt(cp.same.recall.ci)}), coverage ${pct(cs.coverage)}.`,
    `- **The researcher → writer split cuts unsupported claims.** Graded by ${JUDGE_MODEL} against the evidence each writer actually had, unsupported claims per reply went from ${g.single.all.unsupportedPerReply.toFixed(2)} (single agent) to ${g.split.all.unsupportedPerReply.toFixed(2)} ` +
      `(paired change ${unsupportedPair.diff.toFixed(2)}, 95% CI ${unsupportedPair.ci[0].toFixed(2)} to ${unsupportedPair.ci[1].toFixed(2)}${excludesZero(unsupportedPair.ci) ? "" : ", not significant"}); replies with any unsupported claim went from ${pct(g.single.all.repliesWithUnsupported)} to ${pct(g.split.all.repliesWithUnsupported)}. ` +
      `On replies that would actually auto-send: ${g.single.autoResolved.unsupportedPerReply.toFixed(2)} vs ${g.split.autoResolved.unsupportedPerReply.toFixed(2)}.`,
    `- **The split's routing.** Must-escalate recall ${pct(s1.recall)} → ${pct(s2.recall)} (paired ${(sp.recall.diff * 100).toFixed(1)} pts, CI ${ciTxt(sp.recall.ci)}), coverage ${pct(s1.coverage)} → ${pct(s2.coverage)} (CI ${ciTxt(sp.coverage.ci)}), ` +
      `cost $${s1.costPerTicket.toFixed(4)} → $${s2.costPerTicket.toFixed(4)} per ticket. The citation check passed on ${pct(g.split.citationCheckPass)} of completed split replies; ${g.split.groundingEscalations} runs were escalated by the grounding gate.`,
    `- **The judge was checked before it was trusted.** It flagged ${judgeValidation.plantedCaught}/${judgeValidation.planted} planted fabrications and accepted ${judgeValidation.verbatimAccepted}/${judgeValidation.verbatim} sentences copied verbatim from the evidence.`,
    ...(probes
      ? [
          `- **Prompt-injection probes (${probes.probes}).** Escalated with no canary leak: single agent ${probes.pass.single}/${probes.probes}, with checker ${probes.pass.singleWithChecker}/${probes.probes}; ` +
            `split ${probes.pass.split}/${probes.probes}, with checker ${probes.pass.splitWithChecker}/${probes.probes}. The checker alone, shown each probe as a proposed auto-resolve, escalated ${probes.pass.checkerAloneEscalated}/${probes.probes}. Canary leaks in any draft: ${probes.pass.canaryLeaks}.`,
        ]
      : []),
  ];

  const md = [
    `# Multi-agent evaluation`,
    ``,
    `*Generated by \`npm run eval:multi\` on ${new Date().toISOString().slice(0, 10)} — do not edit by hand.*`,
    ``,
    `Two multi-agent additions, measured on the same labeled tickets as [EVALUATION.md](EVALUATION.md). Every arm is recomputed offline from raw records with the exact functions production runs (\`routeTicket\`, \`applyChecker\`, \`applyGrounding\`). Intervals are 95% percentile bootstraps over tickets; differences are paired on the same (ticket, seed) runs.`,
    ``,
    `## Findings`,
    ``,
    ...findings,
    ``,
    `## 1. Router + independent checker`,
    ``,
    `The router routes. A second agent sees **only the ticket and the proposed route** (auto-resolve + the router's category) — not the draft, the tool calls or the router's scores — on a different prompt and, in the main arm, a different model family. It has no tools and can only answer \`agree\` or \`escalate\`; code applies that with \`applyChecker()\`, which can only make a route more cautious and fails closed. It is consulted only for proposed auto-resolves, so its cost lands only on those.`,
    ``,
    `Measured on the main eval's ${c0.seeds}-seed runs (the checker needs nothing else, so the router's outputs are reused unchanged).`,
    ``,
    `### Core set`,
    ``,
    table(checkerArms, "core"),
    ``,
    `### Hard cases (author-written stress test)`,
    ``,
    table(checkerArms, "hard"),
    ``,
    `## 2. Researcher → writer split`,
    ``,
    `The researcher can only search and returns passage ids plus a coverage score; the writer has no tools, sees only the ticket and those passages, and must cite a passage for every claim sentence. Code then checks every citation against the passages actually handed over; any uncited claim, invented id, or "not answerable" verdict escalates. Matched comparison: both pipelines ran fresh on the same ${tickets.size} tickets × ${out.split.seeds} seeds.`,
    ``,
    `### Core set`,
    ``,
    table(splitArms, "core"),
    ``,
    `### Hard cases`,
    ``,
    table(splitArms, "hard"),
    ``,
    `### Grounding (LLM judge: ${JUDGE_MODEL}, plus a deterministic citation check)`,
    ``,
    `| | Single agent | Researcher → writer |`,
    `|---|---:|---:|`,
    `| Completed replies judged | ${g.single.all.judged} | ${g.split.all.judged} |`,
    `| Claims per reply | ${g.single.all.claimsPerReply.toFixed(2)} | ${g.split.all.claimsPerReply.toFixed(2)} |`,
    `| **Unsupported claims per reply** | **${g.single.all.unsupportedPerReply.toFixed(2)}** | **${g.split.all.unsupportedPerReply.toFixed(2)}** |`,
    `| Share of claims unsupported | ${pct(g.single.all.unsupportedShare)} | ${pct(g.split.all.unsupportedShare)} |`,
    `| Replies with any unsupported claim | ${pct(g.single.all.repliesWithUnsupported)} | ${pct(g.split.all.repliesWithUnsupported)} |`,
    `| …on replies that would auto-send | ${pct(g.single.autoResolved.repliesWithUnsupported)} (${g.single.autoResolved.judged}) | ${pct(g.split.autoResolved.repliesWithUnsupported)} (${g.split.autoResolved.judged}) |`,
    `| Citations pointing outside retrieved docs | ${g.single.outsideRetrieved}/${g.single.citations} | ${g.split.outsideRetrieved}/${g.split.citations} |`,
    ``,
    `Judge validation: ${judgeValidation.plantedCaught}/${judgeValidation.planted} planted fabrications flagged, ${judgeValidation.verbatimAccepted}/${judgeValidation.verbatim} verbatim evidence sentences accepted.`,
    ``,
    `## Guardrails`,
    ``,
    `| Guardrail | Where |`,
    `|---|---|`,
    `| Monotone authority: a reviewer can only keep or escalate, proven over every verdict × route in a self-test | \`applyChecker\`, \`applyGrounding\` |`,
    `| Fail closed: timeout, transport error, refusal or malformed output escalates | \`applyChecker(route, null)\` |`,
    `| Strict schemas: forced single tool call, enum verdicts, parsed and validated before use | \`parseCheckerReview\`, \`parseWriterOutput\`, \`parseEvidence\` |`,
    `| Independence: checker sees ticket + proposed route only, different model family, no tools | \`checker.ts\` |`,
    `| Least privilege: researcher has search only, writer and checker have no tools | \`split.ts\`, \`checker.ts\` |`,
    `| Untrusted-input fencing: tickets and docs are fenced, tag-break attempts neutralised, length-capped | \`fenceUntrusted\` |`,
    `| Deterministic grounding: every claim must cite a passage the writer was given | \`checkCitations\` |`,
    `| Bounded compute: timeouts, token ceilings, capped reasoning budget, retries only on transport errors | \`llm.ts\` |`,
    `| Audit trail: every checker, researcher and writer call logged to \`tool_calls\` | \`run-triage.ts\`, \`split.ts\` |`,
    `| Kill switch and model pinning: \`CHECKER=off\`, \`CHECKER_MODEL\` | \`checker.ts\` |`,
    `| Red team: prompt-injection probes, each needing a human and carrying a canary | \`evals/injection-probes.json\` |`,
    ``,
    `## Caveats`,
    ``,
    `- ${tickets.size - 12} core tickets is small; intervals are wide and stated. Labels are one labeler's.`,
    `- The checker is scored on the main runs' recorded router outputs; it ran once per proposal (temperature 0), so its own run-to-run variance is not measured.`,
    `- The judge is an LLM. It was validated on planted and verbatim probes, but a claim it misreads counts the same in both pipelines.`,
    `- The split's writer call has a capped reasoning budget; the single agent's loop does not. Completion differences are partly that, not only the split.`,
    `- Single and split arms are fresh runs (2 seeds), separate from the main eval's 3-seed runs, so their absolute numbers differ slightly from EVALUATION.md.`,
    `- Spend for everything on this page: $${out.spend.total.toFixed(3)} (runs $${spend.runs.toFixed(3)}, checker $${spend.checker.toFixed(3)}, judge $${spend.judge.toFixed(3)}, probes $${spend.probes.toFixed(3)}).`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(ROOT, "docs", "MULTI_AGENT.md"), md);

  for (const file of [path.join(ROOT, "README.md"), path.join(ROOT, "docs", "CASE_STUDY.md")]) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, "utf8");
    const a = "<!-- multi:start -->";
    const b = "<!-- multi:end -->";
    const i = text.indexOf(a);
    const j = text.indexOf(b);
    if (i >= 0 && j > i) text = text.slice(0, i) + a + "\n" + headline + "\n\n" + findings.join("\n") + "\n" + b + text.slice(j + b.length);
    fs.writeFileSync(file, text);
  }
  console.log(findings.join("\n"));
  console.log(`\nWrote evals/results/multiagent.json, docs/MULTI_AGENT.md · spend $${out.spend.total.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
