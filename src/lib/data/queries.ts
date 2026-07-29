/**
 * Server-only data access for the review UI. All reads go through the existing
 * admin client — v1 has no auth, so nothing here is ever imported by a client
 * component.
 */
import "server-only";
import { getSupabaseAdmin } from "../supabase";
import { classifyOutcome, parseCitations } from "./classify";
import {
  ALWAYS_ESCALATE,
  CONFIDENCE_THRESHOLD,
  DOC_GAP_THRESHOLD,
  categoryLabel,
  reasonLabel,
  type AgentCategory,
  type DashboardStats,
  type DocGap,
  type QueueTicket,
  type ReviewAction,
  type Review,
  type ToolCall,
} from "./types";

export { classifyOutcome, parseCitations } from "./classify";

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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
    supabase
      .from("reviews")
      .select("ticket_id, action, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("tool_calls").select("ticket_id, created_at"),
  ]);

  if (tickets.error) throw new Error(tickets.error.message);
  if (drafts.error) throw new Error(drafts.error.message);
  if (reviews.error) throw new Error(reviews.error.message);
  if (toolCalls.error) throw new Error(toolCalls.error.message);

  // Newest draft wins — ordered desc above, so first seen per ticket is latest.
  // Also record the second-latest draft's timestamp per ticket as an attempt
  // boundary: when a ticket is retried (e.g. rate-limited → retried clean),
  // stale tool_calls from the superseded attempt are still in the table, and
  // pairing one of those with the new draft would produce a bogus multi-hour
  // latency. Only tool_calls after this boundary belong to the latest attempt.
  const latestDraft = new Map<string, DraftRow>();
  const attemptCutoff = new Map<string, number>();
  for (const d of (drafts.data ?? []) as DraftRow[]) {
    if (!latestDraft.has(d.ticket_id)) {
      latestDraft.set(d.ticket_id, d);
    } else if (!attemptCutoff.has(d.ticket_id)) {
      attemptCutoff.set(d.ticket_id, new Date(d.created_at).getTime());
    }
  }

  // Ordered desc above, so first seen per ticket is its latest review action.
  const latestReviewAction = new Map<string, ReviewAction>();
  for (const r of (reviews.data ?? []) as { ticket_id: string; action: ReviewAction }[]) {
    if (!latestReviewAction.has(r.ticket_id)) latestReviewAction.set(r.ticket_id, r.action);
  }
  const reviewed = new Set(latestReviewAction.keys());

  const firstCall = new Map<string, number>();
  for (const c of (toolCalls.data ?? []) as { ticket_id: string; created_at: string }[]) {
    const cutoff = attemptCutoff.get(c.ticket_id) ?? -Infinity;
    const t = new Date(c.created_at).getTime();
    if (t <= cutoff) continue;
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
      reviewAction: latestReviewAction.get(t.id) ?? null,
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

  // Calibrates the confidence formula against what a reviewer actually did:
  // an auto-resolved ticket a reviewer rejected or had to edit is a formula
  // miss, not just a review-queue event.
  const reviewedAutoResolved = tickets.filter(
    (t) => t.outcome === "resolved" && t.reviewAction != null
  );
  const overturned = reviewedAutoResolved.filter((t) => t.reviewAction !== "approve");

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
    reviewCalibration: {
      reviewedAutoResolved: reviewedAutoResolved.length,
      overturned: overturned.length,
      overturnRate:
        reviewedAutoResolved.length === 0
          ? null
          : overturned.length / reviewedAutoResolved.length,
    },
  };
}

export { ALWAYS_ESCALATE, CONFIDENCE_THRESHOLD };
