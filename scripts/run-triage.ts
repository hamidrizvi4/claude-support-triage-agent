/**
 * Day 2: runs every row in `tickets` through the agent loop, persists the
 * result to draft_responses, updates tickets.status / tickets.confidence,
 * and prints an auto-resolve/escalation summary.
 *
 * Usage: npm run run-triage
 */
import "dotenv/config";
import { getSupabaseAdmin } from "../src/lib/supabase";
import { runAgent, type Resolution, type Ticket } from "../src/lib/agent/orchestrator";
import { route, type Route } from "../src/lib/agent/routing";

type TicketRow = Ticket & { category: string };

type Summary = {
  total: number;
  autoResolved: number;
  escalated: number;
  escalatedByCategory: Record<string, number>;
  escalatedByReason: Record<string, number>;
};

function pct(n: number, total: number) {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}

function tally(summary: Summary, category: string, decision: Route) {
  if (decision.status === "auto_resolved") {
    summary.autoResolved++;
    return;
  }
  summary.escalated++;
  summary.escalatedByCategory[category] = (summary.escalatedByCategory[category] ?? 0) + 1;
  const reasonKey = decision.reason ?? "unknown";
  summary.escalatedByReason[reasonKey] = (summary.escalatedByReason[reasonKey] ?? 0) + 1;
}

function printSummary(summary: Summary) {
  console.log("\n=== Triage summary ===");
  console.log(`Total tickets:  ${summary.total}`);
  console.log(`Auto-resolved:  ${summary.autoResolved} (${pct(summary.autoResolved, summary.total)})`);
  console.log(`Escalated:      ${summary.escalated} (${pct(summary.escalated, summary.total)})`);

  console.log("\nEscalated by category:");
  for (const [cat, count] of Object.entries(summary.escalatedByCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  console.log("\nEscalated by reason:");
  for (const [reason, count] of Object.entries(summary.escalatedByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
}

async function persist(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  ticket: TicketRow,
  resolution: Resolution,
  decision: Route
) {
  const { error: draftError } = await supabase.from("draft_responses").insert({
    ticket_id: ticket.id,
    draft_text: resolution.draft_response,
    citations: resolution.citations,
    confidence: decision.confidence,
    category: resolution.category,
    escalation_reason: decision.reason,
    retrieval_score: resolution.retrieval_score,
    self_certainty: resolution.self_certainty,
  });
  if (draftError) console.error(`  ! failed to write draft_responses: ${draftError.message}`);

  const { error: ticketError } = await supabase
    .from("tickets")
    .update({ status: decision.status, confidence: decision.confidence })
    .eq("id", ticket.id);
  if (ticketError) console.error(`  ! failed to update ticket: ${ticketError.message}`);
}

async function main() {
  const supabase = getSupabaseAdmin();
  const { data: tickets, error } = await supabase.from("tickets").select("id, subject, body, account_id, category");
  if (error) throw error;
  if (!tickets || tickets.length === 0) {
    console.log("No tickets found — run `npm run generate-tickets` first.");
    return;
  }

  const summary: Summary = {
    total: 0,
    autoResolved: 0,
    escalated: 0,
    escalatedByCategory: {},
    escalatedByReason: {},
  };

  for (const ticket of tickets as TicketRow[]) {
    summary.total++;
    console.log(`[${summary.total}/${tickets.length}] ${ticket.subject}`);

    let resolution: Resolution;
    let decision: Route;
    try {
      resolution = await runAgent(ticket);
      decision = route(resolution.category, resolution.retrieval_score, resolution.self_certainty);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ! agent failed: ${message}`);
      resolution = {
        category: ticket.category,
        draft_response: "",
        citations: [],
        retrieval_score: 0,
        self_certainty: 0,
        escalation_reason: `agent_error:${message}`,
      };
      decision = { status: "escalated", confidence: 0, reason: `agent_error:${message}` };
    }

    await persist(supabase, ticket, resolution, decision);
    tally(summary, resolution.category, decision);
    console.log(`  -> ${decision.status}${decision.reason ? ` (${decision.reason})` : ""} confidence=${decision.confidence.toFixed(2)}`);
  }

  printSummary(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
