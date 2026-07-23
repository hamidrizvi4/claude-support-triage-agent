# Claude Support Triage Agent — Project Context

## What this is
An AI agent that triages incoming Claude API developer support tickets: classifies
them, retrieves grounded context from Anthropic's public docs, calls tools (live
status check, pricing lookup, mocked account lookup), drafts a response with
citations, and routes to human review when confidence is low or the category
requires a human (billing, security, sales, bugs).

Portfolio piece demonstrating: multi-step agentic reasoning, real tool use,
confidence-based human-in-the-loop routing, and a full audit trail.

## Hard constraint — read this before writing any ingestion or seed code
Only public data. Grounding corpus = docs.claude.com + support.claude.com public
pages only. No real Anthropic customer/account data anywhere in this repo.
Account data is mocked. Test tickets are synthetic (LLM-generated), never scraped
from a real user, forum post, or support thread.

## Stack
- Next.js (App Router) + TypeScript — frontend + API routes
- Supabase (Postgres + pgvector + Auth) — data + vector store
- Claude API (Sonnet) — agent orchestration + tool calling
- OpenRouter (Nemotron / other free models) — synthetic ticket generation, cheap bulk tasks
- Deploy target: Vercel + Supabase

## Schema (Supabase / Postgres)
```sql
tickets(id, subject, body, category, account_id, status, confidence, created_at)
doc_chunks(id, source_url, title, content, embedding vector(1536), section)
tool_calls(id, ticket_id, tool_name, input jsonb, output jsonb, created_at)
draft_responses(id, ticket_id, draft_text, citations jsonb, confidence, created_at)
reviews(id, ticket_id, reviewer, action, edited_response, created_at)
accounts(id, name, plan_tier, monthly_usage, rate_limit)  -- MOCKED data only
```

## Agent tools — schemas for Claude API tool use

```json
[
  {
    "name": "search_docs",
    "description": "Search Anthropic's public Claude API documentation for content relevant to the developer's question. Returns the most relevant chunks with source URLs.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search query capturing the developer's question" },
        "top_k": { "type": "integer", "default": 5 }
      },
      "required": ["query"]
    }
  },
  {
    "name": "check_status",
    "description": "Check Anthropic's live status page for active incidents affecting the Claude API, Console, or specific models. Call this whenever the ticket mentions errors, timeouts, or degraded behavior.",
    "input_schema": { "type": "object", "properties": {} }
  },
  {
    "name": "check_pricing",
    "description": "Look up current pricing for a specific Claude model from grounded documentation. Never answer pricing from memory — always call this.",
    "input_schema": {
      "type": "object",
      "properties": { "model": { "type": "string" } },
      "required": ["model"]
    }
  },
  {
    "name": "lookup_account",
    "description": "Look up a (mocked) account's plan tier, current usage, and rate limits.",
    "input_schema": {
      "type": "object",
      "properties": { "account_id": { "type": "string" } },
      "required": ["account_id"]
    }
  },
  {
    "name": "submit_resolution",
    "description": "Submit the final structured resolution for this ticket. Always call this last, exactly once, after gathering whatever context you need.",
    "input_schema": {
      "type": "object",
      "properties": {
        "category": { "type": "string", "enum": ["technical_api_error", "billing", "feature_question", "account_access", "security_abuse", "sales_enterprise", "bug_report"] },
        "draft_response": { "type": "string" },
        "citations": { "type": "array", "items": { "type": "object", "properties": { "source_url": {"type": "string"}, "title": {"type": "string"} } } },
        "retrieval_score": { "type": "number", "description": "0-1, how well the retrieved docs matched the question" },
        "self_certainty": { "type": "number", "description": "0-1, your own confidence the draft is correct and complete" },
        "escalation_reason": { "type": ["string", "null"] }
      },
      "required": ["category", "draft_response", "citations", "retrieval_score", "self_certainty"]
    }
  }
]
```

## Agent system prompt (draft — refine as needed)
> You are a support triage agent for Anthropic's Claude API developer support
> team. For every ticket: classify it, use `search_docs` to ground any factual
> claim (never answer pricing, limits, or model behavior from memory — those
> change), call `check_status` if the ticket mentions errors or degraded
> behavior, call `lookup_account` if the question is account-specific, then
> call `submit_resolution` exactly once with your structured output. Cite every
> doc chunk you actually used. Be honest in `self_certainty` — if the docs
> don't clearly answer the question, say so; a low-confidence honest answer is
> far better than a confident wrong one.

Consider enabling prompt caching on the system prompt + tool definitions — they're
identical across every ticket, so this cuts cost/latency meaningfully at volume.

## Confidence & routing formula
```
confidence = 0.6 * retrieval_score + 0.4 * self_certainty

route(ticket):
  if category in [billing, security_abuse, sales_enterprise, bug_report]:
    -> escalate, reason = "category:" + category
  elif confidence >= 0.8:
    -> auto_resolve
  else:
    -> escalate, reason = "low_confidence"
```

## Routing rules
| Condition | Route |
|---|---|
| Informational, strong doc match, confidence ≥ 0.8 | auto-resolve |
| Billing dispute / refund / account charge | human review |
| Security or abuse report | human review, flag urgent |
| Enterprise / sales inquiry | human review → sales |
| Bug report | human review → eng |
| Weak/no doc match or low confidence | human review |

## Progress
- [x] Day 1 — repo scaffold, Supabase schema, docs ingestion pipeline, synthetic tickets
- [x] Day 2 — tool implementations, agent orchestrator, routing engine, run-triage.ts (code complete; not yet run against real credentials — see below)

## Today's scope: Day 2
Build, in order:
1. Implement all four tools below as real functions, each call logged to `tool_calls`
2. Agent orchestrator (Claude API, tool use) using the system prompt below — forces
   a final `submit_resolution` tool call so output is structured, not freeform text
3. Routing engine — category overrides first, then the confidence formula below
4. `scripts/run-triage.ts` — runs every row in `tickets` through the full loop,
   writes the result to `draft_responses`, updates `tickets.status` / `tickets.confidence`
5. Run it against all Day 1 synthetic tickets, print a summary: auto-resolve rate,
   escalation rate broken down by category and by reason

**Do not build** the review UI or reporting dashboard yet. That's Day 3.

## Environment variables needed
```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
```

## Conventions
- TypeScript everywhere, strict mode
- Every tool call gets logged to `tool_calls` — no silent tool invocations
- Every draft response cites the specific `doc_chunks.source_url` it used
- Ask before running any script that needs credentials not yet in `.env.local`
