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
- OpenRouter — everything model-related, no other LLM provider in this repo:
  - Orchestration/tool-calling: `nvidia/nemotron-3-ultra-550b-a55b:free` (chat completions)
  - Embeddings: `nvidia/nemotron-3-embed-1b:free` (dedicated `/embeddings` endpoint)
  - Synthetic ticket generation: any free chat model
- Deploy target: Vercel + Supabase

## Model & API config
OpenRouter is OpenAI-compatible — use the `openai` npm package with
`baseURL: "https://openrouter.ai/api/v1"` and `apiKey: process.env.OPENROUTER_API_KEY`.
Do not add `@anthropic-ai/sdk` or an OpenAI account key anywhere in this repo.

- Chat/orchestration calls: `POST /chat/completions`, `model: "nvidia/nemotron-3-ultra-550b-a55b:free"`.
  This model is free and purpose-built for agent orchestration and tool calling.
  Free/open models are less reliable than Claude at forced structured tool calls —
  check OpenRouter's provider-routing docs for the highest-tool-calling-accuracy
  routing option (their "Exacto" mode) and enable it for this model.
- Embedding calls: `POST /embeddings`, `model: "nvidia/nemotron-3-embed-1b:free"`.
  Fixed output dimension of **2048** — the API rejects other `dimensions` values,
  so don't try to slim it down to match the old 1536 schema. Schema below is
  already updated to `vector(2048)`.

## Schema (Supabase / Postgres)
```sql
tickets(id, subject, body, category, account_id, status, confidence, created_at)
doc_chunks(id, source_url, title, content, embedding vector(2048), section)
tool_calls(id, ticket_id, tool_name, input jsonb, output jsonb, created_at)
draft_responses(id, ticket_id, draft_text, citations jsonb, confidence, created_at)
reviews(id, ticket_id, reviewer, action, edited_response, created_at)
accounts(id, name, plan_tier, monthly_usage, rate_limit)  -- MOCKED data only
```

## Agent tools — schemas for OpenRouter (OpenAI-compatible) tool use
Each entry is wrapped `{ type: "function", function: {...} }` — this is the
OpenAI function-calling shape, not Anthropic's `input_schema` shape. `parameters`
replaces `input_schema` as the key name.

```json
[
  {
    "type": "function",
    "function": {
      "name": "search_docs",
      "description": "Search Anthropic's public Claude API documentation for content relevant to the developer's question. Returns the most relevant chunks with source URLs.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query capturing the developer's question" },
          "top_k": { "type": "integer", "default": 5 }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "check_status",
      "description": "Check Anthropic's live status page (status.claude.com) for active incidents affecting the Claude API, Console, or specific models. Call this whenever the ticket mentions errors, timeouts, or degraded behavior.",
      "parameters": { "type": "object", "properties": {} }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "check_pricing",
      "description": "Look up current pricing for a specific Claude model from grounded documentation. Never answer pricing from memory — always call this.",
      "parameters": {
        "type": "object",
        "properties": { "model": { "type": "string" } },
        "required": ["model"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "lookup_account",
      "description": "Look up a (mocked) account's plan tier, current usage, and rate limits.",
      "parameters": {
        "type": "object",
        "properties": { "account_id": { "type": "string" } },
        "required": ["account_id"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "submit_resolution",
      "description": "Submit the final structured resolution for this ticket. Always call this last, exactly once, after gathering whatever context you need.",
      "parameters": {
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
  }
]
```

To force the final call: `tool_choice: { "type": "function", "function": { "name": "submit_resolution" } }`
on the turn where the loop should end (or after N turns as a hard stop).

Response parsing differs from Anthropic too: tool calls come back at
`response.choices[0].message.tool_calls` (an array), each with
`.function.name` and `.function.arguments` — the latter is a **JSON string**,
parse it. Reply to each with a `{ role: "tool", tool_call_id, content }`
message before the next request, per the OpenAI-compatible multi-turn tool
protocol (not Anthropic's single-message content-blocks pattern).

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

No prompt-caching optimization for now — `cache_control` breakpoints were an
Anthropic-specific feature and there's no equivalent guarantee on the free
OpenRouter model. Not a real issue at $0/token; revisit only if latency matters.

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
- [x] Day 2 — tools, orchestrator, routing engine, run-triage.ts, provider-swapped
      to OpenRouter end-to-end, 3 real bugs found and fixed, 3 runs completed on
      the free tier (a clean 4th run was blocked on daily free-tier quota at the
      time — resolved in Day 4 with a paid rerun, see below)
- [x] Day 3 — all three screens built against real persisted data. Queue,
      ticket drawer, dashboard. Production build + `tsc --noEmit` + eslint clean,
      Impeccable detector `[]`, review write-path verified end-to-end (Approve →
      `reviews` row → `tickets.status='reviewed'` → badge 30→29).
- [x] Retheme — dark "control room" → light, restrained liquid glass, per
      explicit request. Superseding the original dark-only/no-glassmorphism
      call below; see "Day 3 — retheme" for the new tokens and two real bugs
      the retheme surfaced.
- [x] Day 4 — pre-public security & polish pass. See "Day 4 — security & polish" below.
- [x] Intro page — marketing/intro page at `/` (`src/app/page.tsx`,
      `src/components/landing/`); the working screens moved into the `(app)`
      route group: queue is now `/queue`, dashboard stays `/dashboard`, and the
      sidebar shell lives in `src/app/(app)/layout.tsx`. The page is its own
      scroll container because `globals.css` locks `html, body` (the app shell
      must never document-scroll). The routing calculator imports the real
      `route()`, so it can't drift from the agent. `public/landing/*.gif` were
      recorded from the real UI against synthetic fixtures. Re-record them if
      the queue, drawer or dashboard UI changes.

### Day 3 — shared data layer
`src/lib/data/{types,queries}.ts` is the single place a raw row becomes a
*meaning*, so the queue and the dashboard can never disagree about a number.
`classifyOutcome()` maps rows to `resolved | escalated | incomplete |
rate_limited`; order matters there because a 429 also starts with
`agent_error:`. Verified counts on the current dataset: 5 / 8 / 17 / 10.
`avgTimeToDraft` is measured first-tool-call → draft (31.4s), not from ticket
creation, which would have been meaningless.

**Bug found and fixed post-launch:** `classifyOutcome` originally took
`tickets.status` as a second argument to distinguish resolved/escalated — but
the review write-path (`src/app/actions.ts`) overwrites that same column to
`'reviewed'` on approve/reject, silently reclassifying a ticket's outcome the
moment anyone reviews it and corrupting every dashboard stat retroactively.
Caught live: approving one ticket during testing drifted auto-resolve from
16.7%→13.3%. Fixed by deriving resolved/escalated purely from
`escalation_reason` (immutable, lives on `draft_responses`) — `classifyOutcome`
now takes one argument, never reads `tickets.status` for classification.

### Day 3 — retheme: dark control-room → light restrained liquid glass
Explicit user request, reversing the original "dark is the only theme" /
"no glassmorphism" calls below — that reversal is intentional, not drift.
Locked via a 3-question round: **restrained** glass (translucent blur on
chrome only — cards, chips, sidebar, drawer shell — never on data-bearing
surfaces: table rows, chart tracks, draft/reasoning text stay fully opaque),
**relit** semantic colors (same teal/resolve, amber/escalate, red/critical
meaning, new AA-verified values), **full scope** (all 3 screens + sidebar).

New tokens in `globals.css`: `--canvas:#F3F4F6`, `--surface:#FFFFFF`,
`--text-primary:#14171A`, `--text-secondary:#565D66`, `--text-tertiary:#63696F`
(this one now legitimately passes AA on light — no workaround needed, unlike
the dark theme). Accents relit and independently AA-verified as text against
canvas/surface and against their own `*-tint` background:
`--resolve:#0A7A5E`/`--resolve-tint:#DFF4EC`, `--escalate:#A9550A`/
`--escalate-tint:#FCEFDD`, `--critical:#B3261E`/`--critical-tint:#FBE6E3`. The
old dark-theme `color-mix` AA workaround for `--critical` is gone — the new
pair passes on its own. Shared `.glassPanel` global class (blur + translucency
+ border + a masked-gradient specular top edge) defined once in `globals.css`
so every screen composes the same material instead of reinventing it.

**Bug found and fixed post-retheme, non-obvious:** the drawer rendered with
zero blur — background text bled straight through the "glass" panel, sharp
and readable, not softened. Root cause was in the build tool, not the CSS:
Next 16's Turbopack CSS minifier (Lightning CSS) saw `backdrop-filter` and
`-webkit-backdrop-filter` declared adjacently with identical values inside one
rule and silently dropped the standard property, shipping only the
`-webkit-`-prefixed one — which current Chromium no longer renders on its own.
Confirmed via `getComputedStyle` on the built output (`backdropFilter: "none"`)
and by diffing source vs. compiled CSS directly, on both `--disable-gpu` and
real-GPU headless renders, ruling out a screenshot-tooling artifact. Adding a
`browserslist` field to `package.json` did *not* fix it. The actual fix: split
the two declarations into separate `@supports (-webkit-backdrop-filter: ...)`
/ `@supports (backdrop-filter: ...)` blocks so the minifier can't treat them as
a redundant pair to consolidate. If backdrop-filter silently regresses again
after a Next/Lightning CSS upgrade, check this first before assuming it's a
device or browser-support issue.

### Day 3 — queue ordering
Rate-limited runs sort to the *bottom*, not by recency. They were the most
recent run, so newest-first buried every real agent decision under 10
non-actionable rows. They're excluded from the header badge for the same reason.

### Day 4 — security & polish
Pre-public pass, prompted by `mcp__supabase__get_advisors` and a manual review.

**Security (fixed live, `0005_rls_and_search_path.sql`):** RLS was disabled
on all 6 tables (ERROR-level) and `0004` had additionally granted
anon/authenticated full `ALL` privilege as a fix for a different problem
(missing service_role grants). The app is 100% server-side (service_role,
`rolbypassrls=true`), so nothing broke — but the anon grant meant the first
client-side `supabase-js` call added with the publishable key would get
unauthenticated read/write on every table. Fixed with two independent
layers: revoked anon/authenticated's grants (incl. default-privilege
versions, so future tables aren't exposed either) and enabled RLS with zero
policies (default-deny for everyone except service_role). Also pinned
`match_doc_chunks`'s `search_path` (function search-path hijacking, WARN).
Verified via `get_advisors` before/after — both the ERROR and the WARN are
gone; a live `service_role` query still works.

**Citation URLs:** `parseCitations` accepted any string as `source_url`,
which becomes a real `<a href>` in the drawer — a `javascript:`/`data:` URI
in a model-generated citation would render as a clickable link. Same class
of bug existed independently in `DraftBody`'s raw-markdown-link fallback
(non-cited `[label](url)` links render straight from `draft_text`, bypassing
citations entirely). Both now allowlist `http:`/`https:` before becoming an
href. Low real-world severity today (synthetic data, no real users) but a
real, fixable gap, not a hypothetical one.

**Extracted `src/lib/data/classify.ts`:** `classifyOutcome` and
`parseCitations` used to live in `queries.ts`, which is gated by
`import "server-only"` — that throws unconditionally under plain
`tsx`/node (not just when bundled for a client component), so the functions
that had already caused two real dashboard-corrupting bugs were untestable
without pulling in a live Supabase client. Split the pure logic into its own
side-effect-free module; `queries.ts` re-exports both names, so no caller
changed. New `classify.selftest.ts` covers both functions; new
`orchestrator.selftest.ts` covers `coerceScore` (the NaN-guard from the
provider swap, extracted into a named export so it's directly testable).
Also wired the pre-existing but never-registered `drawer/logic.selftest.ts`
into `npm test`.

**Deduped two business constants:** `CONFIDENCE_THRESHOLD` was a literal
`0.8` in both `agent/routing.ts` and `data/types.ts`; `ALWAYS_ESCALATE`
(types.ts) mirrored `ESCALATE_CATEGORIES` (routing.ts) the same way. Same
failure mode both times — one gets edited, the other silently doesn't.
`routing.ts` (the actual agent decision logic) is now the single source for
both; `types.ts` imports and re-exports.

**Reviewer-overturn rate:** the confidence formula
(`0.6*retrieval + 0.4*certainty`, threshold 0.8) had no calibration behind
it even though `reviews` already captures the signal to check it — whether a
reviewer approved, edited, or rejected each auto-resolved ticket.
`getDashboardStats` now returns `reviewCalibration` (reviewed-auto-resolved
count, overturned count, rate — `null` rate until there's at least one
reviewed auto-resolve) and the dashboard shows it as a strip below the KPI
row, reusing the existing run-integrity styling. Honest at low N: with only
one real review in the dataset today it reads "0.0% overturned of 1 reviewed
auto-resolves," not a misleadingly precise-looking percentage.

**npm audit — triaged, not force-fixed:** 12 high-severity findings, in two
clusters, both currently non-exploitable in this app's actual usage: (1) the
`eslint`/`minimatch`/`brace-expansion`/`eslint-plugin-*` chain — 8 of 12,
all devDependencies, never shipped, and the ReDoS is only reachable via
attacker-controlled glob input, which doesn't happen here; (2) `next` →
`postcss`/`sharp` — `postcss` processes this repo's own authored CSS at
build time, never untrusted input; `sharp` is `next/image`'s optional image
dependency and `next/image` is never imported anywhere in `src/`, so its
vulnerable decode path is unreachable at runtime. The only `npm audit fix`
path for either cluster is a multi-major downgrade (Next 16→9.3.3 — pre-App
Router; eslint 9→10) that would break the codebase, so this is a documented,
accepted risk pending an upstream patch release, not a code change.

**README no longer undersells the finished UI** — it said Day 3 (queue,
drawer, dashboard) was "not built yet" after it had shipped.

**Added `LICENSE`** (MIT) — there wasn't one.

**Paid-model rerun — the 50% incomplete rate is gone.** `orchestrator.ts`'s
`MODEL` now reads `process.env.OPENROUTER_MODEL` (falls back to the free
nemotron default — same pattern as `generate-tickets.ts`), so a paid run is
an explicit opt-in, not a permanent swap. Reran all 40 tickets on
`deepseek/deepseek-v3.2:exacto` (Exacto-routed, tool-calling-accuracy
provider selection — see the free-model comment in `orchestrator.ts` for why
`:free` slugs don't get this). Result: 15 auto-resolved / 25 escalated, and
only **3 of 40 (7.5%) incomplete** — 2 genuine no-tool-call misses plus 1 new
failure mode, a `JSON.parse` error on `submit_resolution`'s arguments
(`Expected ',' or ']' after array element... position 2852`), almost
certainly `max_tokens: 2048` truncating a long draft_response+citations
payload mid-JSON. Worth raising `max_tokens` in a follow-up, not fixed here.
Actual cost: **$0.25** for the full run (OpenRouter key usage, confirmed via
`/api/v1/key`) — nowhere near the $10 budget. The free-tier 40-50% miss rate
stays in the case study as "here's what $0 costs you"; this paid run is the
clean portfolio-facing dataset.

## Progress: provider swap — done, resolved (was blocked on quota through Day 3)
All three real bugs found during testing are fixed and confirmed:
1. Guarded `response.choices[0]` — malformed/502 upstream responses now surface
   as a clean error, not a crash
2. Error-fallback path in `run-triage.ts` no longer writes `ticket.category`
   (wrong enum) into `draft_responses.category` — left `null` on that path instead
3. `submit_resolution` output is now coerced/validated before being cast to
   `Resolution` — no more silent `NaN` confidence from non-numeric model output

Known, accepted constraint: `nvidia/nemotron-3-ultra-550b-a55b:free` misses the
forced `submit_resolution` tool call on roughly 40–50% of tickets. OpenRouter's
"Exacto" tool-calling-accuracy routing isn't offered on `:free` model slugs, so
there's no config fix while staying at $0 — this is a real, disclosed tradeoff
of the free-model choice, not a bug to keep chasing. Stated plainly in the
README's Results table rather than hidden. This stayed **unresolved through
Day 3**: blocked on OpenRouter's daily free-tier quota, so Day 3's UI was
built against the real data already persisted from the three completed runs
(a mix of genuine auto-resolves/escalations and some quota-429 rows, kept
visually distinct in the UI and excluded from dashboard stats).

**Resolved in Day 4** (see "Day 4 — security & polish" above): `orchestrator.ts`
now reads `MODEL` from `process.env.OPENROUTER_MODEL`, defaulting to the free
model. Reran the full 40-ticket dataset on `deepseek/deepseek-v3.2:exacto`
(paid, Exacto-routed) — 15 resolved / 22 escalated / 3 incomplete, $0.25 total.
The free-tier run's numbers stay in the README as the disclosed $0 tradeoff;
the paid run is what the live queue/dashboard show now. No further quota
blocker — a rerun on either model is one `npm run run-triage` away.

## Day 3 scope: Review Queue + Reporting Dashboard

> **Superseded by the retheme** (see "Day 3 — retheme" in Progress, above):
> dark canvas and no-glassmorphism were the v1 call; the shipped UI is now
> light with restrained liquid glass, per explicit later request. Layout,
> component anatomy, motion timings, and copy below are all still current —
> only the color/material direction changed.

### Design direction — read this before writing any component
Aesthetic concept: **"control room, not a spreadsheet."** This is a tool for
someone triaging dozens of AI-drafted decisions a day — it should feel precise,
calm, and trustworthy, like monitoring infrastructure, not like generic SaaS
CRUD. Commit to this fully: dark canvas by default, restrained color used only
to encode the product's actual logic (not decoration), monospace for anything
that is data (scores, IDs, timestamps, tool-call payloads) and a distinctive
geometric sans for everything else. No purple gradients, no glassmorphism, no
generic dashboard-template look, no `Inter`/`Roboto`/`Arial`/system fonts.

The color system should **be** the product logic, not just decorate it: the
whole point of this agent is the auto-resolve/escalate split, so let amber mean
"needs a human" and teal mean "resolved with confidence" everywhere, consistently
— category pills, confidence numbers, dashboard KPIs, all of it.

### Design tokens (exact — use these, don't invent new ones)
```css
:root {
  /* Fonts — load via Google Fonts / Fontshare CDN */
  --font-ui: 'General Sans', system-ui, sans-serif;   /* headings, body, labels */
  --font-mono: 'Martian Mono', ui-monospace, monospace; /* scores, IDs, timestamps, tool-call JSON */

  /* Surfaces */
  --canvas: #0B0D0F;
  --surface: #14171A;
  --surface-raised: #1C2024;
  --surface-hover: #21262B;
  --border: #262B30;
  --border-strong: #363D44;

  /* Text */
  --text-primary: #F2F0EA;
  --text-secondary: #9DA3AA;
  --text-tertiary: #5C636B;

  /* Semantic accents — tied to actual product states, use nowhere else */
  --resolve: #2DD4A8;       /* auto-resolved, confidence >= 0.8 */
  --resolve-dim: #12332C;   /* bg tint for resolve-state chips/rows */
  --escalate: #F0A030;      /* escalated — needs human */
  --escalate-dim: #3A2A10;
  --critical: #E8563D;      /* security/abuse flag only — use sparingly */
  --critical-dim: #3A1912;

  /* Scale */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px; --space-16: 64px;
}
```
Fonts: `General Sans` from Fontshare (`api.fontshare.com/v2/css?f[]=general-sans@400,500,600`),
`Martian Mono` from Google Fonts. Both are distinctive, not overused — do not
substitute `Space Grotesk`, `JetBrains Mono`, or `Inter`.

### Screen 1 — Review Queue (default view)
- Thin left sidebar: logo mark, nav items (Queue / Dashboard), icon + label,
  active item indicated by a 2px left border in `--text-primary`, not a filled
  background
- Header: "Review queue" + live count badge (`--escalate` tinted pill showing
  count of un-reviewed tickets), filter chips for category and escalation reason
  (multi-select, toggle state = filled `--surface-raised` bg)
- Row list, one ticket per row: subject (truncated, `--font-ui` 15px/500),
  category pill (small, `--text-tertiary` bg for neutral categories,
  `--escalate-dim` bg + `--escalate` text for the four always-escalate
  categories), escalation reason as plain secondary text, confidence score
  right-aligned in `--font-mono`, color-coded by value (`--resolve` if ≥0.8,
  `--escalate` if 0.5–0.79, `--critical` if <0.5), relative timestamp
- Quota-429 rows: visually distinct — muted/dashed left border, small
  "rate limited" tag in `--text-tertiary`, excluded from any counts shown in
  the header badge
- Row hover (`@media (hover: hover)` only): background → `--surface-hover`,
  transition `background-color 150ms ease`
- Row click → opens Screen 2 as a right-side drawer, not full navigation —
  reviewers process many tickets in sequence and should keep queue context
- Empty state ("queue clear"): centered icon + "All caught up" message,
  restrained, this is a rare/first-time-feeling state so it's allowed a little
  more warmth than the rest of the UI
- Keyboard: `j`/`k` to move selection, `Enter` to open — **no animation on this
  navigation**, it's used too often per ticket batch to justify motion

### Screen 2 — Ticket Detail (right-side drawer)
- Slides in from the right, `width: 480px` on desktop, full-width on narrow
  viewports, `transform: translateX(...)`, `cubic-bezier(0.23, 1, 0.32, 1)`,
  **250ms enter / 180ms exit** (asymmetric — exit should feel faster than entry)
- Header: subject, category pill, confidence score large (`--font-mono`,
  24px), escalation reason badge
- Section: original ticket text, plain, `--text-secondary`
- Section: **reasoning trace** — chronological log of tool calls, styled like
  a compact terminal log using `--font-mono` at 13px: tool name in
  `--text-primary`, input/output as collapsed JSON (click to expand, no
  animation needed on expand/collapse — instant, it's a data-density toggle
  not a spatial transition), each entry left-bordered 2px in a neutral color
  (`--border-strong`) — do not color-code by tool, that adds noise without
  meaning
- Section: **confidence breakdown** — small horizontal bar visualizing
  `0.6 * retrieval_score + 0.4 * self_certainty`, two segments (retrieval
  weight, certainty weight) plus a vertical marker at the 0.8 auto-resolve
  threshold, so the reviewer can see at a glance why this ticket landed where
  it did. This is the single most product-relevant visual in the whole UI —
  give it real visual weight, don't shrink it to an afterthought
- Section: draft response with inline citation chips — small pills inline in
  the text, `--surface-raised` bg, hover shows source doc title + link
  (tooltip, 125–200ms, gated behind hover media query)
- Sticky footer action bar: **Reject** (ghost/outline, left-aligned, muted),
  **Edit & approve** (secondary style), **Approve** (primary, filled
  `--resolve`) — right-aligned as a group. Every button gets press feedback:
  `transform: scale(0.97)` on `:active`, 120ms, no exceptions
- Edit & approve turns the draft into an inline editable textarea, no modal

### Screen 3 — Reporting Dashboard
- KPI row, 4 metric cards: auto-resolve rate (`--resolve`), escalation rate
  (`--escalate`), doc-gap rate (flag in `--critical` if above a set threshold,
  otherwise neutral), avg time-to-draft. Big number 28px `--font-mono`,
  label 13px `--text-secondary` above it
- Escalation breakdown: two horizontal bar charts side by side or stacked —
  by category, by reason. Bars in `--escalate`, labels in `--font-mono`
- **Doc-gap section** — tickets with the lowest `retrieval_score`, sorted
  worst-first. This is the actual product insight (missing/unclear docs
  surfaced as a byproduct of triage) — give it a distinct heading and
  `--critical`-tinted accent so it reads as "needs the content team's
  attention," not just another list
- Optional if time allows: sparkline of auto-resolve rate across the three
  completed runs — simple line, no gridlines, no legend needed for one series
- On page load: rows/cards stagger in, `opacity 0 → 1` + `translateY(8px) → 0`,
  250ms `cubic-bezier(0.23, 1, 0.32, 1)`, **30–80ms delay between items**, never
  more — long staggers make the page feel slow

### Cross-cutting rules
- `prefers-reduced-motion: reduce` → keep opacity/color transitions, strip all
  transform/position motion
- Every color pairing must hit WCAG AA contrast — verify `--text-secondary`
  and the dim-accent backgrounds specifically, they're the easiest to get wrong
- No animation on any keyboard-triggered action (queue nav, form submission
  via Enter) — only on drawer open/close, filter toggles, and first-load stagger
- Loading states: skeleton pulses, not spinners, `opacity` only, no shimmer sweep
- Don't build a light/dark toggle — dark is the only theme for v1, that's a
  deliberate scope cut, not an oversight

**Do not build** anything beyond these three screens for Day 3 — no settings
page, no user management, no notification system.

## Environment variables needed
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
```
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are no longer used anywhere in this repo.

## Conventions
- TypeScript everywhere, strict mode
- Every tool call gets logged to `tool_calls` — no silent tool invocations
- Every draft response cites the specific `doc_chunks.source_url` it used
- Ask before running any script that needs credentials not yet in `.env.local`
