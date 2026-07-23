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
```

Review UI and reporting dashboard are Day 3 — not built yet.
