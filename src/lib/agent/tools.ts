/**
 * Day 2 agent tools. Each function does the real work only — the
 * orchestrator is the single place that logs calls to tool_calls, so no
 * tool invocation here is silent.
 */
import type OpenAI from "openai";
import { embed } from "../embeddings";
import { getSupabaseAdmin } from "../supabase";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_docs",
      description:
        "Search Anthropic's public Claude API documentation for content relevant to the developer's question. Returns the most relevant chunks with source URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query capturing the developer's question" },
          top_k: { type: "integer", default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_status",
      description:
        "Check Anthropic's live status page for active incidents affecting the Claude API, Console, or specific models. Call this whenever the ticket mentions errors, timeouts, or degraded behavior.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_pricing",
      description:
        "Look up current pricing for a specific Claude model from grounded documentation. Never answer pricing from memory — always call this.",
      parameters: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_account",
      description: "Look up a (mocked) account's plan tier, current usage, and rate limits.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_resolution",
      description:
        "Submit the final structured resolution for this ticket. Always call this last, exactly once, after gathering whatever context you need.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "technical_api_error",
              "billing",
              "feature_question",
              "account_access",
              "security_abuse",
              "sales_enterprise",
              "bug_report",
            ],
          },
          draft_response: { type: "string" },
          citations: {
            type: "array",
            items: { type: "object", properties: { source_url: { type: "string" }, title: { type: "string" } } },
          },
          retrieval_score: { type: "number", description: "0-1, how well the retrieved docs matched the question" },
          self_certainty: { type: "number", description: "0-1, your own confidence the draft is correct and complete" },
          escalation_reason: { type: ["string", "null"] },
        },
        required: ["category", "draft_response", "citations", "retrieval_score", "self_certainty"],
      },
    },
  },
];

async function searchDocChunks(query: string, topK: number) {
  const [queryEmbedding] = await embed([query]);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("match_doc_chunks", {
    query_embedding: queryEmbedding,
    match_count: topK,
  });
  if (error) throw new Error(error.message);
  return { results: data ?? [] };
}

export function searchDocs(query: string, topK = 5) {
  return searchDocChunks(query, topK);
}

export function checkPricing(model: string) {
  return searchDocChunks(`${model} pricing cost per token`, 3);
}

export async function checkStatus() {
  // status.anthropic.com redirects here now; hit it directly to skip the hop.
  const res = await fetch("https://status.claude.com/api/v2/summary.json");
  if (!res.ok) throw new Error(`status page returned ${res.status}`);
  const json = await res.json();
  return {
    indicator: json.status.indicator,
    description: json.status.description,
    active_incidents: (json.incidents ?? []).map(
      (i: { name: string; status: string; impact: string; shortlink: string }) => ({
        name: i.name,
        status: i.status,
        impact: i.impact,
        shortlink: i.shortlink,
      })
    ),
  };
}

export async function lookupAccount(accountId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("accounts").select("*").eq("id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { error: `no account found for id ${accountId}` };
  return data;
}
