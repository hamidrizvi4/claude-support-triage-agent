/**
 * Runs the tool-use loop for a single ticket until the model calls
 * submit_resolution (or the turn budget runs out). Every tool call —
 * including submit_resolution itself — is logged to tool_calls.
 */
import type OpenAI from "openai";
import { getSupabaseAdmin } from "../supabase";
import { openRouter } from "./llm";
import { resolveModel } from "../model";
import { TOOLS, searchDocs, checkStatus, checkPricing, lookupAccount, pricingQuery } from "./tools";

// Defaults to the free model per CLAUDE.md. Override with OPENROUTER_MODEL
// (same pattern as scripts/generate-tickets.ts) for a paid run — e.g. a
// portfolio-facing dataset on an Exacto-routed model for reliable tool calls.
// The eval harness passes `model` per run instead.
const MAX_TURNS = 8;
// Was 2048: the paid rerun lost one ticket to a submit_resolution payload
// (long draft + citations) cut off mid-JSON at the token limit.
const MAX_TOKENS = 4096;

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

/**
 * Free model doesn't reliably return well-typed numbers for retrieval_score /
 * self_certainty — coerce rather than let a bad value silently poison
 * confidence as NaN.
 */
export function coerceScore(value: unknown): number {
  return Number(value) || 0;
}

export type ToolLogger = (ticketId: string, toolName: string, input: unknown, output: unknown) => Promise<void>;

export type AgentOptions = {
  /** OpenRouter model slug; defaults to resolveModel(). */
  model?: string;
  /** Sampling seed, passed through where the provider honours it. */
  seed?: number;
  /** Where tool calls are recorded; defaults to the tool_calls table. */
  log?: ToolLogger;
  /**
   * Replaces the doc search behind search_docs and check_pricing (same query,
   * same top_k). The eval uses an in-memory copy of the same index so a busy
   * database can't masquerade as agent behaviour.
   */
  search?: (query: string, topK: number) => Promise<unknown>;
};

export type AgentUsage = { promptTokens: number; completionTokens: number; cost: number };

/** Everything a run produced, beyond the resolution itself. */
export type AgentRun = {
  resolution: Resolution;
  /** Every cosine similarity search_docs / check_pricing returned this run. */
  similarities: number[];
  /** Ids of every doc chunk search returned this run, de-duplicated: the evidence the draft could draw on. */
  retrieved: string[];
  usage: AgentUsage;
  turns: number;
  tools: string[];
  /** Tool calls that errored ("tool: message"); the agent saw the error text instead of a result. */
  toolErrors: string[];
};

/** Thrown when a run ends without a usable resolution; still carries what the run cost. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly partial: Omit<AgentRun, "resolution">
  ) {
    super(message);
  }
}

function chunkIdsFrom(output: unknown): string[] {
  const results = (output as { results?: { id?: unknown }[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => (r?.id == null ? "" : String(r.id))).filter(Boolean);
}

function similaritiesFrom(output: unknown): number[] {
  const results = (output as { results?: { similarity?: unknown }[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => (r?.similarity == null ? NaN : Number(r.similarity))).filter((n) => Number.isFinite(n));
}

async function logToolCall(ticketId: string, toolName: string, input: unknown, output: unknown) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("tool_calls").insert({ ticket_id: ticketId, tool_name: toolName, input, output });
  if (error) console.error(`  ! failed to log tool_call ${toolName}: ${error.message}`);
}

function handlers(search?: AgentOptions["search"]): Record<string, (input: Record<string, unknown>) => Promise<unknown>> {
  return {
    search_docs: (input) =>
      search ? search(input.query as string, (input.top_k as number) ?? 5) : searchDocs(input.query as string, (input.top_k as number) ?? 5),
    check_status: () => checkStatus(),
    check_pricing: (input) => (search ? search(pricingQuery(input.model as string), 3) : checkPricing(input.model as string)),
    lookup_account: (input) => lookupAccount(input.account_id as string),
  };
}

export async function runAgent(ticket: Ticket): Promise<Resolution> {
  return (await runAgentDetailed(ticket)).resolution;
}

export async function runAgentDetailed(ticket: Ticket, opts: AgentOptions = {}): Promise<AgentRun> {
  const openai = openRouter();
  const model = opts.model ?? resolveModel();
  const log = opts.log ?? logToolCall;
  const similarities: number[] = [];
  const retrieved: string[] = [];
  const tools: string[] = [];
  const toolErrors: string[] = [];
  const HANDLERS = handlers(opts.search);
  const usage: AgentUsage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  let turns = 0;
  const fail = (message: string) => new AgentRunError(message, { similarities, retrieved, usage, turns, tools, toolErrors });
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
    turns = turn + 1;
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await openai.chat.completions.create({
      model,
      max_tokens: MAX_TOKENS,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      // OpenRouter extension: report the request's actual cost in `usage`.
      ...({ usage: { include: true } } as object),
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
    } catch (err) {
      throw fail(`upstream error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const u = response.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
    usage.promptTokens += u?.prompt_tokens ?? 0;
    usage.completionTokens += u?.completion_tokens ?? 0;
    usage.cost += Number(u?.cost) || 0;

    const message = response.choices?.[0]?.message;
    if (!message) throw fail(`OpenRouter response had no choices: ${JSON.stringify(response).slice(0, 300)}`);
    messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });

    // TOOLS only registers `type: "function"` entries, so every call back is one.
    const toolCalls = (message.tool_calls ?? []).filter(
      (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function"
    );
    const submit = toolCalls.find((tc) => tc.function.name === "submit_resolution");
    if (submit) {
      tools.push("submit_resolution");
      let args: Resolution;
      try {
        args = JSON.parse(submit.function.arguments) as Resolution;
      } catch (err) {
        throw fail(`submit_resolution arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      args.retrieval_score = coerceScore(args.retrieval_score);
      args.self_certainty = coerceScore(args.self_certainty);
      await log(ticket.id, "submit_resolution", args, null);
      return { resolution: args, similarities, retrieved, usage, turns, tools, toolErrors };
    }

    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      tools.push(call.function.name);
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const handler = HANDLERS[call.function.name];
        if (!handler) throw new Error(`unknown tool ${call.function.name}`);
        const output = await handler(input);
        similarities.push(...similaritiesFrom(output));
        for (const id of chunkIdsFrom(output)) if (!retrieved.includes(id)) retrieved.push(id);
        await log(ticket.id, call.function.name, input, output);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolErrors.push(`${call.function.name}: ${message}`.slice(0, 200));
        await log(ticket.id, call.function.name, input, { error: message });
        messages.push({ role: "tool", tool_call_id: call.id, content: message });
      }
    }
  }

  throw fail(`agent did not call submit_resolution within ${MAX_TURNS} turns`);
}
