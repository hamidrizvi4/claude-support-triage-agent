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
 *
 * Multi-agent comparison (records drafts + evidence for the grounding judge,
 * written under evals/runs/multi/ so the main report never mixes them in):
 *   npm run eval:run -- --model qwen/qwen3.7-flash --pipeline single --seeds 1,2
 *   npm run eval:run -- --model qwen/qwen3.7-flash --pipeline split  --seeds 1,2
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { getSupabaseAdmin } from "../../src/lib/supabase";
import { AgentRunError, runAgentDetailed, type Ticket } from "../../src/lib/agent/orchestrator";
import { SplitRunError, runSplitPipeline } from "../../src/lib/agent/split";
import { loadEvalSet, type EvalSet, type EvalTicket } from "./data";
import { downloadIndex, indexSize, localSearch, verifyAgainstDb } from "./localIndex";

type Pipeline = "single" | "split";
type Args = { model: string; seeds: number[]; set: EvalSet; concurrency: number; budget: number; out: string; limit: number; pipeline: Pipeline | null };

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
  const pipeline = (get("--pipeline") ?? null) as Pipeline | null;
  if (pipeline && pipeline !== "single" && pipeline !== "split") throw new Error("--pipeline must be single or split");
  return {
    pipeline,
    model,
    seeds,
    set,
    concurrency: Number(get("--concurrency") ?? 4),
    budget: Number(get("--budget") ?? 0.5),
    limit: Number(get("--limit") ?? Infinity),
    out:
      get("--out") ??
      (pipeline
        ? path.join("evals", "runs", "multi", `${pipeline}_${slug}.jsonl`)
        : path.join("evals", "runs", `${set === "pilot" ? "pilot_" : ""}${slug}.jsonl`)),
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
  /** Tool calls that errored during the run. */
  tool_errors: string[];
  /**
   * True when a doc search failed: the agent saw an error instead of results,
   * so the run measures the infrastructure, not the agent. Excluded from
   * scoring and re-runnable with --retry-infra.
   */
  infra: boolean;
  /* ── multi-agent comparison only (--pipeline) ── */
  pipeline?: Pipeline;
  draft?: string;
  cited_urls?: string[];
  /** Chunk ids of every doc passage retrieved during the run (the evidence available). */
  retrieved_ids?: string[];
  /** split only: chunk ids the researcher handed the writer, in order. */
  given_ids?: string[];
  /** split only: the writer's own verdict and the deterministic citation check. */
  answerable?: boolean;
  citation_ok?: boolean;
  claims?: number;
  uncited?: number;
  invalid_ids?: number;
  unknown_ids?: number;
  sentences?: { text: string; kind: string; passage_ids: string[] }[];
  failed_stage?: "researcher" | "writer" | null;
};

// A search failing for infrastructure reasons (DB timeout, network, provider
// errors) — not the model sending bad arguments, which is agent behaviour.
const SEARCH_INFRA = /^(search_docs|check_pricing): .*(statement timeout|fetch failed|ECONN|socket|terminated|embeddings error (429|5\d\d))/i;

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

async function runSplit(t: EvalTicket, model: string, seed: number): Promise<RunRecord> {
  const ticket: Ticket = { id: t.id, subject: t.subject, body: t.body, account_id: t.account_id };
  const started = Date.now();
  const base = { ticket_id: t.id, set: t.set, model, seed, pipeline: "split" as const };
  try {
    const run = await runSplitPipeline(ticket, { model, seed, log: noopLog, search: localSearch });
    const r = run.resolution;
    const idOf = new Map(run.retrieved.map((p) => [p.passage_id, p.chunk_id]));
    return {
      ...base,
      tool_errors: run.toolErrors,
      infra: run.toolErrors.some((e) => SEARCH_INFRA.test(e)),
      completed: true,
      error: null,
      category: r.category,
      model_retrieval: r.retrieval_score,
      self_certainty: r.self_certainty,
      similarities: run.similarities,
      citations: r.citations.length,
      draft_chars: r.draft_response.length,
      turns: run.turns,
      tools: run.tools,
      prompt_tokens: run.usage.promptTokens,
      completion_tokens: run.usage.completionTokens,
      cost: run.usage.cost,
      latency_ms: Date.now() - started,
      draft: r.draft_response,
      cited_urls: r.citations.map((c) => c.source_url),
      retrieved_ids: run.retrieved.map((p) => p.chunk_id),
      given_ids: run.passages.map((p) => p.chunk_id),
      answerable: run.writer.answerable,
      citation_ok: run.citationCheck.ok,
      claims: run.citationCheck.claims,
      uncited: run.citationCheck.uncited,
      invalid_ids: run.citationCheck.invalidIds,
      unknown_ids: run.evidence.unknownIds,
      sentences: run.writer.sentences.map((s) => ({ ...s, passage_ids: s.passage_ids.map((id) => idOf.get(id) ?? `invalid:${id}`) })),
      failed_stage: null,
    };
  } catch (err) {
    const partial = err instanceof SplitRunError ? err.partial : null;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      tool_errors: partial?.toolErrors ?? [],
      infra: /^upstream error/.test(message) || (partial?.toolErrors ?? []).some((e) => SEARCH_INFRA.test(e)),
      completed: false,
      error: message.slice(0, 300),
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
      retrieved_ids: (partial?.retrieved ?? []).map((p) => p.chunk_id),
      failed_stage: err instanceof SplitRunError ? err.stage : null,
    };
  }
}

async function runOne(t: EvalTicket, model: string, seed: number, recordDrafts = false): Promise<RunRecord> {
  const ticket: Ticket = { id: t.id, subject: t.subject, body: t.body, account_id: t.account_id };
  const started = Date.now();
  const base = { ticket_id: t.id, set: t.set, model, seed };
  try {
    const run = await runAgentDetailed(ticket, { model, seed, log: noopLog, search: localSearch });
    const r = run.resolution;
    return {
      ...base,
      tool_errors: run.toolErrors,
      infra: run.toolErrors.some((e) => SEARCH_INFRA.test(e)),
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
      ...(recordDrafts
        ? {
            pipeline: "single" as const,
            draft: r.draft_response ?? "",
            cited_urls: Array.isArray(r.citations) ? r.citations.map((c) => String(c?.source_url ?? "")) : [],
            retrieved_ids: run.retrieved,
          }
        : {}),
    };
  } catch (err) {
    const partial = err instanceof AgentRunError ? err.partial : null;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      tool_errors: partial?.toolErrors ?? [],
      infra: /^upstream error/.test(message) || (partial?.toolErrors ?? []).some((e) => SEARCH_INFRA.test(e)),
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
      ...(recordDrafts ? { pipeline: "single" as const, retrieved_ids: partial?.retrieved ?? [] } : {}),
    };
  }
}

async function main() {
  const args = parseArgs();
  const supabase = getSupabaseAdmin();
  const tickets = await loadEvalSet(supabase, args.set);
  await downloadIndex(supabase, process.argv.includes("--refresh-index"));
  console.log(`local index: ${indexSize()} chunks`);
  if (process.argv.includes("--verify-index")) {
    for (const v of await verifyAgainstDb(supabase, [
      "rate limit headers on 429 responses",
      "prompt caching pricing cache writes",
      "message batches results retention",
    ])) {
      console.log(`  verify "${v.query}": top-5 overlap ${v.overlap}, max |Δsim| ${v.maxDiff}`);
    }
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  const done = new Set<string>();
  if (fs.existsSync(args.out)) {
    for (const line of fs.readFileSync(args.out, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RunRecord;
      const infra = r.infra === true || (!r.completed && /^upstream error/.test(r.error ?? ""));
      if (infra && process.argv.includes("--retry-infra")) done.delete(`${r.ticket_id}#${r.seed}`);
      else done.add(`${r.ticket_id}#${r.seed}`);
    }
  }
  const queue = args.seeds
    .flatMap((seed) => tickets.map((t) => ({ t, seed })))
    .filter(({ t, seed }) => !done.has(`${t.id}#${seed}`))
    .slice(0, args.limit);
  console.log(`${args.pipeline ? `[${args.pipeline}] ` : ""}${args.model} · set=${args.set} · seeds=${args.seeds.join(",")} · ${tickets.length} tickets · ${queue.length} runs to go (${done.size} already in ${args.out})`);

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
      const rec = args.pipeline === "split" ? await runSplit(job.t, args.model, job.seed) : await runOne(job.t, args.model, job.seed, args.pipeline === "single");
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
