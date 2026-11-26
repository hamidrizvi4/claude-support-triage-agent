/**
 * Runs the agent over the labeled eval set and records raw per-ticket outputs
 * to JSONL. Nothing is written to Supabase: tool calls go to a no-op logger,
 * so the live demo's data is untouched. Routing is NOT decided here — the
 * report recomputes every routing variant offline from these raw outputs, so
 * one paid run answers several questions (old vs new retrieval score, with
 * and without the safety net).
 *
 * Resumable: (ticket, seed) pairs already in the output file are skipped.
 * Stops before starting new work once the run's spend reaches --budget or
 * the OpenRouter key's own remaining limit drops below a safety margin.
 *
 * Usage:
 *   npm run eval:run -- --model qwen/qwen3.7-flash --seeds 1,2,3 --set all
 *   npm run eval:run -- --model qwen/qwen3.7-flash --set pilot --seeds 1
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { getSupabaseAdmin } from "../../src/lib/supabase";
import { AgentRunError, runAgentDetailed, type Ticket } from "../../src/lib/agent/orchestrator";
import { loadEvalSet, type EvalSet, type EvalTicket } from "./data";

type Args = { model: string; seeds: number[]; set: EvalSet; concurrency: number; budget: number; out: string; limit: number };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const model = get("--model");
  if (!model) throw new Error("--model is required");
  const set = (get("--set") ?? "all") as EvalSet;
  const seeds = (get("--seeds") ?? "1,2,3").split(",").map(Number);
  const slug = model.replace(/[/:]/g, "_");
  return {
    model,
    seeds,
    set,
    concurrency: Number(get("--concurrency") ?? 4),
    budget: Number(get("--budget") ?? 0.5),
    limit: Number(get("--limit") ?? Infinity),
    out: get("--out") ?? path.join("evals", "runs", `${set === "pilot" ? "pilot_" : ""}${slug}.jsonl`),
  };
}

export type RunRecord = {
  ticket_id: string;
  set: "core" | "hard";
  model: string;
  seed: number;
  completed: boolean;
  error: string | null;
  category: string | null;
  model_retrieval: number | null;
  self_certainty: number | null;
  similarities: number[];
  citations: number;
  draft_chars: number;
  turns: number;
  tools: string[];
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  latency_ms: number;
  provider_note?: string;
};

async function keyRemaining(): Promise<number | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    const json = await res.json();
    const r = json?.data?.limit_remaining;
    return typeof r === "number" ? r : null;
  } catch {
    return null;
  }
}

const noopLog = async () => {};

async function runOne(t: EvalTicket, model: string, seed: number): Promise<RunRecord> {
  const ticket: Ticket = { id: t.id, subject: t.subject, body: t.body, account_id: t.account_id };
  const started = Date.now();
  const base = { ticket_id: t.id, set: t.set, model, seed };
  try {
    const run = await runAgentDetailed(ticket, { model, seed, log: noopLog });
    const r = run.resolution;
    return {
      ...base,
      completed: true,
      error: null,
      category: r.category ?? null,
      model_retrieval: r.retrieval_score,
      self_certainty: r.self_certainty,
      similarities: run.similarities,
      citations: Array.isArray(r.citations) ? r.citations.length : 0,
      draft_chars: (r.draft_response ?? "").length,
      turns: run.turns,
      tools: run.tools,
      prompt_tokens: run.usage.promptTokens,
      completion_tokens: run.usage.completionTokens,
      cost: run.usage.cost,
      latency_ms: Date.now() - started,
    };
  } catch (err) {
    const partial = err instanceof AgentRunError ? err.partial : null;
    return {
      ...base,
      completed: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      category: null,
      model_retrieval: null,
      self_certainty: null,
      similarities: partial?.similarities ?? [],
      citations: 0,
      draft_chars: 0,
      turns: partial?.turns ?? 0,
      tools: partial?.tools ?? [],
      prompt_tokens: partial?.usage.promptTokens ?? 0,
      completion_tokens: partial?.usage.completionTokens ?? 0,
      cost: partial?.usage.cost ?? 0,
      latency_ms: Date.now() - started,
    };
  }
}

async function main() {
  const args = parseArgs();
  const tickets = await loadEvalSet(getSupabaseAdmin(), args.set);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  const done = new Set<string>();
  if (fs.existsSync(args.out)) {
    for (const line of fs.readFileSync(args.out, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RunRecord;
      done.add(`${r.ticket_id}#${r.seed}`);
    }
  }
  const queue = args.seeds
    .flatMap((seed) => tickets.map((t) => ({ t, seed })))
    .filter(({ t, seed }) => !done.has(`${t.id}#${seed}`))
    .slice(0, args.limit);
  console.log(`${args.model} · set=${args.set} · seeds=${args.seeds.join(",")} · ${tickets.length} tickets · ${queue.length} runs to go (${done.size} already in ${args.out})`);

  let spent = 0;
  let stopped: string | null = null;
  let finished = 0;
  let sinceCheck = 0;

  async function worker() {
    for (;;) {
      if (stopped) return;
      const job = queue.shift();
      if (!job) return;
      if (spent >= args.budget) {
        stopped = `run budget $${args.budget} reached`;
        return;
      }
      if (++sinceCheck >= 10) {
        sinceCheck = 0;
        const remaining = await keyRemaining();
        if (remaining !== null && remaining < 0.05) {
          stopped = `OpenRouter key limit nearly exhausted ($${remaining.toFixed(3)} left)`;
          return;
        }
      }
      const rec = await runOne(job.t, args.model, job.seed);
      spent += rec.cost;
      fs.appendFileSync(args.out, JSON.stringify(rec) + "\n");
      finished++;
      console.log(
        `  [${finished}/${queue.length + finished}] seed ${job.seed} ${job.t.id.slice(0, 8)} ${rec.completed ? rec.category : "INCOMPLETE"} ` +
          `$${rec.cost.toFixed(4)} (run total $${spent.toFixed(3)})${rec.error ? ` — ${rec.error.slice(0, 90)}` : ""}`
      );
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, worker));
  console.log(`\n${stopped ? `STOPPED: ${stopped}. ` : ""}Done: ${finished} runs, $${spent.toFixed(3)} this invocation → ${args.out}`);
  if (stopped) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
