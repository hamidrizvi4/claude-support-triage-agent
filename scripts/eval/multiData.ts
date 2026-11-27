/**
 * Shared helpers for the multi-agent eval (checker, researcher/writer split,
 * grounding judge): reading run files, de-duplicating them the same way the
 * main report does, and recomputing the shipped route offline.
 */
import fs from "node:fs";
import path from "node:path";
import { routeTicket, type Route } from "../../src/lib/agent/routing";
import { applyGrounding, type CitationCheck, type WriterOutput } from "../../src/lib/agent/guardrails";
import type { RunRecord } from "./run";

export const ROOT = path.join(__dirname, "..", "..");
export const RUNS = path.join(ROOT, "evals", "runs");
export const MULTI = path.join(RUNS, "multi");

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const SEARCH_INFRA = /^(search_docs|check_pricing): .*(statement timeout|fetch failed|ECONN|socket|terminated|embeddings error (429|5\d\d))/i;
export const isInfra = (r: RunRecord) =>
  (!r.completed && /^upstream error/.test(r.error ?? "")) || (r.tool_errors ?? []).some((e) => SEARCH_INFRA.test(e));

/** One record per key; the FIRST non-infrastructure record wins, as in the main report. */
export function dedupe(records: RunRecord[]): RunRecord[] {
  const out = new Map<string, RunRecord>();
  for (const r of records) {
    const key = runKey(r);
    const prev = out.get(key);
    if (!prev || (isInfra(prev) && !isInfra(r))) out.set(key, r);
  }
  return [...out.values()].filter((r) => !isInfra(r));
}

export const pipelineOf = (r: RunRecord) => r.pipeline ?? "single";
export const runKey = (r: { model: string; pipeline?: string; ticket_id: string; seed: number }) =>
  `${r.model}#${r.pipeline ?? "single"}#${r.ticket_id}#${r.seed}`;

/** The primary 3-seed runs (main eval) plus the multi-agent comparison runs. */
export function loadAllRuns(primaryModel: string): { label: string; records: RunRecord[] }[] {
  const sources: { label: string; records: RunRecord[] }[] = [];
  const main = path.join(RUNS, `${primaryModel.replace(/[/:]/g, "_")}.jsonl`);
  sources.push({ label: "main", records: dedupe(readJsonl<RunRecord>(main)) });
  if (fs.existsSync(MULTI)) {
    for (const f of fs.readdirSync(MULTI).filter((f) => f.endsWith(".jsonl") && !f.startsWith("smoke_"))) {
      sources.push({ label: f.replace(/\.jsonl$/, ""), records: dedupe(readJsonl<RunRecord>(path.join(MULTI, f))) });
    }
  }
  return sources;
}

/**
 * The shipped route for a recorded run, recomputed offline: category rule →
 * safety net → confidence threshold, and for the split pipeline the grounding
 * gate (writer verdict + citation check). Incomplete runs escalate.
 */
export function shippedRoute(r: RunRecord, text: string): Route {
  if (!r.completed || !r.category) return { status: "escalated", confidence: 0, reason: "incomplete" };
  const base = routeTicket({ category: r.category, retrievalScore: r.model_retrieval ?? 0, selfCertainty: r.self_certainty ?? 0, text });
  if (pipelineOf(r) !== "split") return base;
  const writer = { answerable: r.answerable === true } as WriterOutput;
  const check = { ok: r.citation_ok === true } as CitationCheck;
  return applyGrounding(base, writer, check);
}

export type CheckerRecord = {
  source: string;
  model: string;
  pipeline: string;
  ticket_id: string;
  seed: number;
  checker_model: string;
  verdict: "agree" | "escalate" | null;
  reason: string | null;
  note: string | null;
  error: string | null;
  transport: boolean;
  cost: number;
  latency_ms: number;
  probe?: boolean;
};

export type JudgeRecord = {
  model: string;
  pipeline: string;
  ticket_id: string;
  seed: number;
  judge_model: string;
  ok: boolean;
  error: string | null;
  claims: number;
  unsupported: number;
  unsupported_claims: string[];
  evidence_passages: number;
  cost: number;
  validation?: "planted" | "verbatim";
};
