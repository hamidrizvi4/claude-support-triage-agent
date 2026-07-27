/**
 * Server-only data access for the review UI. All reads go through the existing
 * admin client — v1 has no auth, so nothing here is ever imported by a client
 * component.
 */
import "server-only";
import { getSupabaseAdmin } from "../supabase";
import {
  ALWAYS_ESCALATE,
  CONFIDENCE_THRESHOLD,
  DOC_GAP_THRESHOLD,
  categoryLabel,
  reasonLabel,
  type AgentCategory,
  type Citation,
  type DashboardStats,
  type DocGap,
  type QueueTicket,
  type Review,
  type RunOutcome,
  type ToolCall,
} from "./types";

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The one place a raw row becomes a meaning. Classification reads only
 * draft_responses.escalation_reason — never tickets.status, which the review
 * write-path overwrites to 'reviewed' the moment anyone approves/rejects a
 * ticket. Reading status here would silently reclassify resolved<->escalated
 * on review, corrupting every dashboard stat retroactively.
 * Order matters: a 429 also starts with "agent_error:", so it's tested first.
 * Assumes every ticket has exactly one draft_responses row by the time this
 * runs — true for anything that has passed through run-triage.ts, which
 * always persists a row (real or fallback) even when the agent call throws.
 * A ticket never yet run has no row at all and would misclassify as
 * "resolved"; that state doesn't occur in this pipeline today.
 */
export function classifyOutcome(escalationReason: string | null): RunOutcome {
  const reason = escalationReason ?? "";
  if (reason.includes("429") || reason.includes("Rate limit")) return "rate_limited";
  if (reason.startsWith("agent_error:")) return "incomplete";
  return reason === "" ? "resolved" : "escalated";
}

type TicketRow = {
  id: string;
  subject: string;
  body: string;
  category: string;
  account_id: string | null;
  status: string;
  created_at: string;
};

type DraftRow = {
  id: string;
  ticket_id: string;
  draft_text: string | null;
  citations: unknown;
  confidence: unknown;
  category: string | null;
  escalation_reason: string | null;
  retrieval_score: unknown;
  self_certainty: unknown;
  created_at: string;
};

function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const { source_url, title } = c as Record<string, unknown>;
    if (typeof source_url !== "string") return [];
    return [{ source_url, title: typeof title === "string" ? title : source_url }];
  });
}

export async function getQueueTickets(): Promise<QueueTicket[]> {
  const supabase = getSupabaseAdmin();

  const [tickets, drafts, reviews, toolCalls] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, subject, body, category, account_id, status, created_at"),
    supabase
      .from("draft_responses")
      .select(
        "id, ticket_id, draft_text, citations, confidence, category, escalation_reason, retrieval_score, self_certainty, created_at"
      )
      .order("created_at", { ascending: false }),
    supabase.from("reviews").select("ticket_id"),
    supabase.from("tool_calls").select("ticket_id, created_at"),
  ]);

  if (tickets.error) throw new Error(tickets.error.message);
  if (drafts.error) throw new Error(drafts.error.message);
  if (reviews.error) throw new Error(reviews.error.message);
  if (toolCalls.error) throw new Error(toolCalls.error.message);

  // Newest draft wins — ordered desc above, so first seen per ticket is latest.
  const latestDraft = new Map<string, DraftRow>();
  for (const d of (drafts.data ?? []) as DraftRow[]) {
    if (!latestDraft.has(d.ticket_id)) latestDraft.set(d.ticket_id, d);
  }

  const reviewed = new Set((reviews.data ?? []).map((r) => r.ticket_id as string));

  const firstCall = new Map<string, number>();
  for (const c of (toolCalls.data ?? []) as { ticket_id: string; created_at: string }[]) {
    const t = new Date(c.created_at).getTime();
    const seen = firstCall.get(c.ticket_id);
    if (seen == null || t < seen) firstCall.set(c.ticket_id, t);
  }

  const rows = ((tickets.data ?? []) as TicketRow[]).map((t): QueueTicket => {
    const d = latestDraft.get(t.id);
    const draftedAt = d?.created_at ?? null;
    const started = firstCall.get(t.id);

    let latencySeconds: number | null = null;
    if (started != null && draftedAt) {
      const secs = (new Date(draftedAt).getTime() - started) / 1000;
      if (secs >= 0) latencySeconds = secs;
    }

    return {
      id: t.id,
      subject: t.subject,
      body: t.body,
      seedCategory: t.category,
      status: t.status,
      accountId: t.account_id,
      createdAt: t.created_at,

      draftId: d?.id ?? null,
      draftText: d?.draft_text ?? "",
      citations: parseCitations(d?.citations),
      category: (d?.category as AgentCategory | null) ?? null,
      escalationReason: d?.escalation_reason ?? null,
      confidence: num(d?.confidence),
      retrievalScore: num(d?.retrieval_score),
      selfCertainty: num(d?.self_certainty),
      draftedAt,

      outcome: classifyOutcome(d?.escalation_reason ?? null),
      reviewed: reviewed.has(t.id),
      latencySeconds,
    };
  });

  // Actionable work first, then most-recently-drafted. Rate-limited runs are
  // infrastructure noise a reviewer can do nothing about, so they sink to the
  // bottom instead of burying real decisions under whichever run failed last.
  return rows.sort((a, b) => {
    const aNoise = a.outcome === "rate_limited" ? 1 : 0;
    const bNoise = b.outcome === "rate_limited" ? 1 : 0;
    if (aNoise !== bNoise) return aNoise - bNoise;
    const at = a.draftedAt ? Date.parse(a.draftedAt) : 0;
    const bt = b.draftedAt ? Date.parse(b.draftedAt) : 0;
    return bt - at;
  });
}

export async function getToolCalls(ticketId: string): Promise<ToolCall[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tool_calls")
    .select("id, ticket_id, tool_name, input, output, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    ticketId: r.ticket_id as string,
    toolName: r.tool_name as string,
    input: r.input,
    output: r.output,
    createdAt: r.created_at as string,
  }));
}

/**
 * Every tool call, grouped by ticket. The whole table is ~200 rows, so the
 * queue fetches it once server-side rather than firing a request per drawer open.
 */
export async function getToolCallsByTicket(): Promise<Record<string, ToolCall[]>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tool_calls")
    .select("id, ticket_id, tool_name, input, output, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const grouped: Record<string, ToolCall[]> = {};
  for (const r of data ?? []) {
    const call: ToolCall = {
      id: r.id as string,
      ticketId: r.ticket_id as string,
      toolName: r.tool_name as string,
      input: r.input,
      output: r.output,
      createdAt: r.created_at as string,
    };
    (grouped[call.ticketId] ??= []).push(call);
  }
  return grouped;
}

export async function getReviews(ticketId: string): Promise<Review[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("reviews")
    .select("id, ticket_id, reviewer, action, edited_response, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    ticketId: r.ticket_id as string,
    reviewer: r.reviewer as string,
    action: r.action as Review["action"],
    editedResponse: (r.edited_response as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

function tally(labels: string[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const tickets = await getQueueTickets();

  const rateLimited = tickets.filter((t) => t.outcome === "rate_limited");
  const incomplete = tickets.filter((t) => t.outcome === "incomplete");
  const completed = tickets.filter(
    (t) => t.outcome === "resolved" || t.outcome === "escalated"
  );

  // 429s are infrastructure noise — they never touch a rate.
  const decided = completed.length + incomplete.length;
  const resolvedCount = tickets.filter((t) => t.outcome === "resolved").length;
  const escalatedCount = decided - resolvedCount;

  const withRetrieval = completed.filter((t) => t.retrievalScore != null);
  const docGapCount = withRetrieval.filter(
    (t) => (t.retrievalScore as number) < DOC_GAP_THRESHOLD
  ).length;

  const latencies = completed
    .map((t) => t.latencySeconds)
    .filter((s): s is number => s != null);

  const escalatedRows = tickets.filter(
    (t) => t.outcome === "escalated" || t.outcome === "incomplete"
  );

  const docGaps: DocGap[] = withRetrieval
    .map((t) => ({
      ticketId: t.id,
      subject: t.subject,
      retrievalScore: t.retrievalScore as number,
      category: t.category,
    }))
    .sort((a, b) => a.retrievalScore - b.retrievalScore)
    .slice(0, 8);

  const supabase = getSupabaseAdmin();
  const { data: toolRows } = await supabase.from("tool_calls").select("tool_name");
  const toolUsage = tally((toolRows ?? []).map((r) => r.tool_name as string));

  return {
    runHealth: {
      completed: completed.length,
      incomplete: incomplete.length,
      rateLimited: rateLimited.length,
      completionRate: decided === 0 ? 0 : completed.length / decided,
    },
    decided,
    autoResolveRate: decided === 0 ? 0 : resolvedCount / decided,
    escalationRate: decided === 0 ? 0 : escalatedCount / decided,
    docGapRate: withRetrieval.length === 0 ? 0 : docGapCount / withRetrieval.length,
    avgTimeToDraftSeconds:
      latencies.length === 0
        ? null
        : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    escalationByCategory: tally(
      escalatedRows.map((t) => categoryLabel(t.category))
    ),
    escalationByReason: tally(
      escalatedRows.map((t) => reasonLabel(t.escalationReason))
    ),
    docGaps,
    toolUsage,
  };
}

export { ALWAYS_ESCALATE, CONFIDENCE_THRESHOLD };
