/**
 * Runs the tool-use loop for a single ticket until the model calls
 * submit_resolution (or the turn budget runs out). Every tool call —
 * including submit_resolution itself — is logged to tool_calls.
 */
import OpenAI from "openai";
import { getSupabaseAdmin } from "../supabase";
import { TOOLS, searchDocs, checkStatus, checkPricing, lookupAccount } from "./tools";

// Fixed per CLAUDE.md — free, purpose-built for agent orchestration/tool calling.
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
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

function getOpenRouterClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set");
  return new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
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
  const openai = getOpenRouterClient();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `New support ticket.\n\nSubject: ${ticket.subject}\n\nBody:\n${ticket.body}\n\n${
        ticket.account_id ? `account_id: ${ticket.account_id}` : "No account_id on this ticket."
      }`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const isLastTurn = turn === MAX_TURNS - 1;
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      tools: TOOLS,
      // Force a resolution on the final turn instead of letting the loop
      // exhaust the budget and throw. NOTE: OpenRouter's Auto Exacto routing
      // (higher tool-calling accuracy) is currently limited to a short list of
      // models (GLM-4.7/5, DeepSeek V3.2, gpt-oss-120b) that doesn't include
      // nemotron-3-ultra, and the explicit `:exacto` variant isn't offered on
      // `:free` slugs — so this model gets no tool-calling reliability boost.
      // Expect a non-trivial rate of forced-tool-call misses on this free model.
      ...(isLastTurn ? { tool_choice: { type: "function" as const, function: { name: "submit_resolution" } } } : {}),
      messages,
    });

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error(`OpenRouter response had no choices: ${JSON.stringify(response)}`);
    messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });

    // TOOLS only registers `type: "function"` entries, so every call back is one.
    const toolCalls = (message.tool_calls ?? []).filter(
      (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function"
    );
    const submit = toolCalls.find((tc) => tc.function.name === "submit_resolution");
    if (submit) {
      const args = JSON.parse(submit.function.arguments) as Resolution;
      // Free model doesn't reliably return well-typed numbers for these two —
      // coerce rather than let a bad value silently poison confidence as NaN.
      args.retrieval_score = Number(args.retrieval_score) || 0;
      args.self_certainty = Number(args.self_certainty) || 0;
      await logToolCall(ticket.id, "submit_resolution", args, null);
      return args;
    }

    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
      const handler = HANDLERS[call.function.name];
      try {
        if (!handler) throw new Error(`unknown tool ${call.function.name}`);
        const output = await handler(input);
        await logToolCall(ticket.id, call.function.name, input, output);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logToolCall(ticket.id, call.function.name, input, { error: message });
        messages.push({ role: "tool", tool_call_id: call.id, content: message });
      }
    }
  }

  throw new Error(`agent did not call submit_resolution within ${MAX_TURNS} turns`);
}
