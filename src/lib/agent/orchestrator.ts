/**
 * Runs the Claude tool-use loop for a single ticket until it calls
 * submit_resolution (or the turn budget runs out). Every tool call —
 * including submit_resolution itself — is logged to tool_calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "../supabase";
import { TOOLS, searchDocs, checkStatus, checkPricing, lookupAccount } from "./tools";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 8;

const SYSTEM_PROMPT = `You are a support triage agent for Anthropic's Claude API developer support
team. For every ticket: classify it, use \`search_docs\` to ground any factual
claim (never answer pricing, limits, or model behavior from memory — those
change), call \`check_status\` if the ticket mentions errors or degraded
behavior, call \`lookup_account\` if the question is account-specific, then
call \`submit_resolution\` exactly once with your structured output. Cite every
doc chunk you actually used. Be honest in \`self_certainty\` — if the docs
don't clearly answer the question, say so; a low-confidence honest answer is
far better than a confident wrong one.`;

export type Resolution = {
  category: string;
  draft_response: string;
  citations: { source_url: string; title: string }[];
  retrieval_score: number;
  self_certainty: number;
  escalation_reason: string | null;
};

export type Ticket = {
  id: string;
  subject: string;
  body: string;
  account_id: string | null;
};

function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");
  return new Anthropic({ apiKey });
}

async function logToolCall(ticketId: string, toolName: string, input: unknown, output: unknown) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("tool_calls").insert({ ticket_id: ticketId, tool_name: toolName, input, output });
  if (error) console.error(`  ! failed to log tool_call ${toolName}: ${error.message}`);
}

const HANDLERS: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  search_docs: (input) => searchDocs(input.query as string, (input.top_k as number) ?? 5),
  check_status: () => checkStatus(),
  check_pricing: (input) => checkPricing(input.model as string),
  lookup_account: (input) => lookupAccount(input.account_id as string),
};

export async function runAgent(ticket: Ticket): Promise<Resolution> {
  const anthropic = getAnthropicClient();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `New support ticket.\n\nSubject: ${ticket.subject}\n\nBody:\n${ticket.body}\n\n${
        ticket.account_id ? `account_id: ${ticket.account_id}` : "No account_id on this ticket."
      }`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const submit = toolUses.find((b) => b.name === "submit_resolution");
    if (submit) {
      await logToolCall(ticket.id, "submit_resolution", submit.input, null);
      return submit.input as Resolution;
    }

    if (toolUses.length === 0) break;

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const handler = HANDLERS[use.name];
      try {
        if (!handler) throw new Error(`unknown tool ${use.name}`);
        const output = await handler(use.input as Record<string, unknown>);
        await logToolCall(ticket.id, use.name, use.input, output);
        resultBlocks.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logToolCall(ticket.id, use.name, use.input, { error: message });
        resultBlocks.push({ type: "tool_result", tool_use_id: use.id, content: message, is_error: true });
      }
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  throw new Error(`agent did not call submit_resolution within ${MAX_TURNS} turns`);
}
