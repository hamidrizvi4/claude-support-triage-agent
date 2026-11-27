/**
 * Shared OpenRouter plumbing for the single-call agents (checker, writer,
 * judge). One forced tool call per request: the model can only answer in the
 * tool's JSON shape, and the caller validates that shape before trusting it.
 *
 * Guardrails that live here, so every caller gets them:
 * - a hard per-request timeout and a small token ceiling
 * - retries only for transient transport failures (429 / 5xx / network),
 *   never for a bad answer: a malformed answer is the model's behaviour and
 *   is reported to the caller, which fails closed
 * - temperature 0 and a pass-through seed, so reruns are as stable as the
 *   provider allows
 * - a capped reasoning budget: uncapped, a reasoning model can deliberate
 *   until it hits max_tokens and never make the call (seen in testing:
 *   8,192 tokens of reasoning, no answer). The answer gets its own headroom
 *   on top of the cap.
 * - cost read from OpenRouter's own usage accounting
 */
import OpenAI from "openai";

export function openRouter(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set");
  return new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
}

export type LlmUsage = { promptTokens: number; completionTokens: number; cost: number };

export const emptyUsage = (): LlmUsage => ({ promptTokens: 0, completionTokens: 0, cost: 0 });

export function addUsage(into: LlmUsage, response: OpenAI.Chat.Completions.ChatCompletion | null | undefined): void {
  const u = response?.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
  into.promptTokens += u?.prompt_tokens ?? 0;
  into.completionTokens += u?.completion_tokens ?? 0;
  into.cost += Number(u?.cost) || 0;
}

export type ForcedCallResult =
  | { ok: true; args: unknown; usage: LlmUsage; latencyMs: number }
  | { ok: false; error: string; transport: boolean; usage: LlmUsage; latencyMs: number };

const TRANSIENT = /\b(429|500|502|503|504)\b|timed? ?out|ECONN|fetch failed|socket|terminated|overloaded|rate limit/i;

/**
 * One request that must come back as a call to `tool`. Returns the parsed
 * arguments (still untyped — the caller validates them) or a structured
 * failure. `transport: true` means the request never produced an answer.
 */
export async function callForcedTool(opts: {
  model: string;
  system: string;
  user: string;
  tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  seed?: number;
  /** Tokens for the answer itself, on top of the reasoning budget. */
  maxTokens?: number;
  /** Cap on reasoning tokens (OpenRouter `reasoning.max_tokens`); ignored by non-reasoning models. */
  reasoningTokens?: number;
  timeoutMs?: number;
  retries?: number;
}): Promise<ForcedCallResult> {
  const client = openRouter();
  const usage = emptyUsage();
  const started = Date.now();
  const retries = opts.retries ?? 2;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create(
        {
          model: opts.model,
          temperature: 0,
          max_tokens: (opts.maxTokens ?? 1024) + (opts.reasoningTokens ?? 2048),
          ...({ reasoning: { max_tokens: opts.reasoningTokens ?? 2048 } } as object),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...({ usage: { include: true } } as object),
          tools: [opts.tool],
          tool_choice: { type: "function", function: { name: opts.tool.function.name } },
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        },
        { timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 }
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < retries && TRANSIENT.test(lastError)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return { ok: false, error: `transport: ${lastError}`.slice(0, 300), transport: true, usage, latencyMs: Date.now() - started };
    }
    addUsage(usage, response);
    const call = response.choices?.[0]?.message?.tool_calls?.find(
      (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        tc.type === "function" && tc.function.name === opts.tool.function.name
    );
    if (!call) {
      return { ok: false, error: `model did not call ${opts.tool.function.name}`, transport: false, usage, latencyMs: Date.now() - started };
    }
    try {
      return { ok: true, args: JSON.parse(call.function.arguments), usage, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: `${opts.tool.function.name} arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        transport: false,
        usage,
        latencyMs: Date.now() - started,
      };
    }
  }
  return { ok: false, error: `transport: ${lastError}`.slice(0, 300), transport: true, usage, latencyMs: Date.now() - started };
}
