/**
 * Day 2: runs every row in `tickets` through the agent loop, persists the
 * result to draft_responses, updates tickets.status / tickets.confidence,
 * and prints an auto-resolve/escalation summary.
 *
 * Multi-agent options (see docs/MULTI_AGENT.md for the eval behind them):
 * - Independent checker: when the router proposes an auto-resolve, a second
 *   agent on a different model (CHECKER_MODEL, default deepseek-v4-flash)
 *   reviews the ticket and the proposed route and can only agree or escalate.
 *   On by default; CHECKER=off is the kill switch. Fails closed.
 * - --pipeline split: researcher (search only) → writer (no tools, must cite
 *   a retrieved passage for every claim) instead of the single agent.
 *
 * Usage: npm run run-triage [-- --pipeline split]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getSupabaseAdmin } from "../src/lib/supabase";
import { runAgentDetailed, type Resolution, type Ticket } from "../src/lib/agent/orchestrator";
import { routeTicket, type Route } from "../src/lib/agent/routing";
import { runSplitPipeline } from "../src/lib/agent/split";
import { checkerEnabled, reviewRoute } from "../src/lib/agent/checker";
import { applyChecker } from "../src/lib/agent/guardrails";
import { resolveModel } from "../src/lib/model";

async function logCall(ticketId: string, toolName: string, input: unknown, output: unknown) {
  const { error } = await getSupabaseAdmin().from("tool_calls").insert({ ticket_id: ticketId, tool_name: toolName, input, output });
  if (error) console.error(`  ! failed to log tool_call ${toolName}: ${error.message}`);
}

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
  decision: Route,
  draftCategory: string | null
) {
  const { error: draftError } = await supabase.from("draft_responses").insert({
    ticket_id: ticket.id,
    draft_text: resolution.draft_response,
    citations: resolution.citations,
    confidence: decision.confidence,
    category: draftCategory,
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
  const argv = process.argv.slice(2);
  const pipeline = argv.includes("--pipeline") ? argv[argv.indexOf("--pipeline") + 1] : "single";
  if (pipeline !== "single" && pipeline !== "split") throw new Error("--pipeline must be single or split");
  console.log(`pipeline=${pipeline} · checker=${checkerEnabled() ? "on" : "off"}`);
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
    let draftCategory: string | null;
    try {
      if (pipeline === "split") {
        // Researcher → writer; the grounding gate (writer verdict + citation
        // check) is already applied inside, on top of the usual router.
        const run = await runSplitPipeline(ticket, { model: resolveModel(), log: logCall });
        resolution = run.resolution;
        decision = run.route;
      } else {
        const run = await runAgentDetailed(ticket);
        resolution = run.resolution;
        // Retrieval stays the model's own score: the labeled eval tested replacing
        // it with the search's cosine similarity, and that showed no gain (every
        // estimate pointed the wrong way, none significant). See docs/EVALUATION.md.
        // The safety net re-checks the ticket text for the always-escalate
        // categories, independent of the model's label.
        decision = routeTicket({
          category: resolution.category,
          retrievalScore: resolution.retrieval_score,
          selfCertainty: resolution.self_certainty,
          text: `${ticket.subject}\n\n${ticket.body}`,
        });
      }
      // Independent checker: only an auto-resolve is reviewed, and the review
      // can only keep it or escalate. Any failure escalates (fail closed).
      if (decision.status === "auto_resolved" && checkerEnabled()) {
        const review = await reviewRoute(ticket, { category: resolution.category });
        await logCall(ticket.id, "checker_review", { model: review.model, proposed: { route: "auto_resolve", category: resolution.category } }, {
          verdict: review.review?.verdict ?? null,
          reason: review.review?.verdict === "escalate" ? review.review.reason : null,
          note: review.note,
          error: review.error,
          cost: review.usage.cost,
        });
        decision = applyChecker(decision, review.review);
      }
      draftCategory = resolution.category;
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
      // ticket.category is the ticket-generation enum (informational/billing/...),
      // not draft_responses' resolution-category enum — leave it null rather than
      // fail the check constraint with a category the agent never actually produced.
      draftCategory = null;
    }

    await persist(supabase, ticket, resolution, decision, draftCategory);
    tally(summary, resolution.category, decision);
    console.log(`  -> ${decision.status}${decision.reason ? ` (${decision.reason})` : ""} confidence=${decision.confidence.toFixed(2)}`);
  }

  printSummary(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
