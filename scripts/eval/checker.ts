/**
 * Runs the independent checker over recorded agent runs. The checker only
 * needs the ticket and the proposed route, so the existing labeled runs can be
 * reviewed after the fact: for every run whose shipped route is an
 * auto-resolve, ask the checker, and record its verdict. The report then
 * applies applyChecker() offline — the same function production uses.
 *
 * Nothing is written to Supabase. Resumable; transport failures are retried
 * on the next invocation (a real production failure would fail closed, and
 * the report counts any that remain that way).
 *
 * Usage:
 *   npm run eval:checker -- --checker deepseek/deepseek-v4-flash
 *   npm run eval:checker -- --checker qwen/qwen3.7-flash      (same-model arm)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { getSupabaseAdmin } from "../../src/lib/supabase";
import { reviewRoute } from "../../src/lib/agent/checker";
import { loadEvalSet, type EvalTicket } from "./data";
import type { RunRecord } from "./run";
import { RUNS, loadAllRuns, pipelineOf, readJsonl, runKey, shippedRoute, type CheckerRecord } from "./multiData";

const PRIMARY = "qwen/qwen3.7-flash";

async function main() {
  const argv = process.argv.slice(2);
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const checker = get("--checker") ?? "deepseek/deepseek-v4-flash";
  const budget = Number(get("--budget") ?? 0.1);
  const concurrency = Number(get("--concurrency") ?? 6);
  const out = path.join(RUNS, "checker", `${checker.replace(/[/:]/g, "_")}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const tickets = new Map((await loadEvalSet(getSupabaseAdmin(), "all")).map((t) => [t.id, t]));
  const done = new Set(
    readJsonl<CheckerRecord>(out)
      .filter((r) => !r.transport)
      .map((r) => `${r.source}|${runKey(r)}`)
  );

  const jobs: { source: string; key: string; rec: EvalTicket; run: RunRecord }[] = [];
  for (const src of loadAllRuns(PRIMARY)) {
    for (const r of src.records) {
      const t = tickets.get(r.ticket_id);
      if (!t) continue;
      const routed = shippedRoute(r, `${t.subject}\n\n${t.body}`);
      if (routed.status !== "auto_resolved") continue; // escalations never reach the checker
      const key = `${src.label}|${runKey(r)}`;
      if (done.has(key)) continue;
      jobs.push({ source: src.label, key, rec: t, run: r });
    }
  }
  console.log(`checker ${checker}: ${jobs.length} auto-resolve proposals to review (${done.size} already in ${out})`);

  let spent = 0;
  let n = 0;
  async function worker() {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      if (spent >= budget) return;
      const res = await reviewRoute(job.rec, { category: job.run.category! }, { model: checker, seed: job.run.seed });
      spent += res.usage.cost;
      const row: CheckerRecord = {
        source: job.source,
        model: job.run.model,
        pipeline: pipelineOf(job.run),
        ticket_id: job.run.ticket_id,
        seed: job.run.seed,
        checker_model: checker,
        verdict: res.review?.verdict ?? null,
        reason: res.review?.verdict === "escalate" ? res.review.reason : null,
        note: res.note,
        error: res.error,
        transport: res.transport,
        cost: res.usage.cost,
        latency_ms: res.latencyMs,
      };
      fs.appendFileSync(out, JSON.stringify(row) + "\n");
      console.log(`  [${++n}] ${job.source} ${job.run.ticket_id.slice(0, 8)} s${job.run.seed} → ${row.verdict ?? `FAIL (${row.error?.slice(0, 60)})`}${row.reason ? ` (${row.reason})` : ""} $${row.cost.toFixed(5)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\nDone: ${n} reviews, $${spent.toFixed(4)} → ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
