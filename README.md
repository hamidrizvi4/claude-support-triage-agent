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

## Results

Two full runs of the 40-ticket synthetic dataset, same tickets, same routing
formula — only the orchestration model changed. Outcome buckets are mutually
exclusive (`resolved | escalated | incomplete | rate_limited`), matching what
`src/lib/data/classify.ts` and the dashboard actually compute.

| | Free (`nemotron-3-ultra:free`) | Paid, Exacto-routed (`deepseek/deepseek-v3.2:exacto`) |
|---|---|---|
| Auto-resolved | 8 (20%) | 15 (37.5%) |
| Escalated | 12 (30%) | 22 (55%) |
| Incomplete — no `submit_resolution` call | 20 (50%) | 3 (7.5%) |
| Cost | $0 | $0.25 |

**Disclosed tradeoff, not hidden:** the free model misses the forced
`submit_resolution` tool call on roughly 40–50% of tickets — OpenRouter's
Exacto tool-calling-accuracy routing isn't offered on `:free` model slugs,
so there's no config fix while staying at $0. That's the free-tier finding,
and it stays in this table on purpose. The paid run is what the live
queue/dashboard show today; `OPENROUTER_MODEL` in `orchestrator.ts` defaults
to the free model and only switches on an explicit env override (see
`scripts/run-triage.ts`).

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
