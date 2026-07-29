# Claude Support Triage Agent

An AI agent that triages incoming Claude API developer support tickets. See
[CLAUDE.md](./CLAUDE.md) for project scope and conventions, and
[docs/PRD.md](./docs/PRD.md) for the product spec.

## Day 1 — data foundation

- `supabase/migrations/0001_init.sql` — schema (`tickets`, `doc_chunks`, `tool_calls`,
  `draft_responses`, `reviews`, `accounts`) with `pgvector` enabled, plus a handful of
  mocked accounts.
- `scripts/ingest-docs.ts` — crawls docs.claude.com + support.claude.com, chunks and
  embeds each page, upserts into `doc_chunks`.
- `scripts/generate-tickets.ts` — generates ~40 synthetic tickets via OpenRouter,
  spanning every category in the routing table.

## Day 2 — agent loop

- `src/lib/agent/tools.ts` — the four tool schemas plus `search_docs` / `check_status`
  / `check_pricing` / `lookup_account` implementations. `search_docs` and
  `check_pricing` share a pgvector similarity search (`match_doc_chunks` RPC,
  `supabase/migrations/0002_agent_resolution.sql`); `check_status` hits the live
  Statuspage API at status.claude.com.
- `src/lib/agent/orchestrator.ts` — the Claude tool-use loop for one ticket. Logs
  every tool call (including `submit_resolution`) to `tool_calls`; loops until
  `submit_resolution` or an 8-turn budget runs out.
- `src/lib/agent/routing.ts` — pure confidence + routing function from CLAUDE.md's
  formula. `npm run test:routing` is a tiny assert-based self-check.
- `scripts/run-triage.ts` — runs every row in `tickets` through the loop, writes
  `draft_responses`, updates `tickets.status` / `tickets.confidence`, prints an
  auto-resolve/escalation summary.

## Day 3 — review queue + reporting dashboard

- `src/app/page.tsx` + `src/components/queue/*` — the review queue: filterable,
  keyboard-navigable (`j`/`k`/`Enter`) list of triaged tickets.
- `src/components/drawer/*` — the ticket detail drawer (reasoning trace, confidence
  breakdown, cited draft response, approve/edit/reject actions writing to `reviews`).
- `src/app/dashboard/page.tsx` + `src/components/dashboard/*` — KPIs, escalation
  breakdowns, and the doc-gap list (lowest-`retrieval_score` tickets, i.e. where the
  docs corpus is thin).
- `src/lib/data/{types,queries}.ts` — the shared layer that turns raw rows into
  `resolved | escalated | incomplete | rate_limited` outcomes, so the queue and the
  dashboard can never disagree about a number.

### Setup

```bash
npm install
cp .env.local.example .env.local   # fill in credentials
```

Apply the migrations to your Supabase project (via the Supabase SQL editor or CLI),
then:

```bash
npm run ingest-docs
npm run generate-tickets
npm run run-triage
npm run dev
```

`npm run dev` serves the review queue at `/` and the dashboard at `/dashboard`.
