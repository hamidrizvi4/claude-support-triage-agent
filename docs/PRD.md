# PRD — Claude API Support Triage Agent

## Problem
Developer support volume for an API product includes a large tier of repetitive,
doc-answerable questions (rate limits, pricing, tool-use syntax, migration steps)
alongside genuinely sensitive cases — billing disputes, security reports,
enterprise sales, bug reports — that need a human. Today every ticket costs
roughly equal human attention regardless of complexity.

## Goal
An agent that resolves the doc-answerable tier autonomously, with citations, and
reliably escalates everything else — with a full audit trail and confidence-based
routing, not a black box.

## Users
- Developer support team — reviews the escalated queue
- Indirectly, API developers filing tickets — faster resolution on the easy tier

## Workflow
1. Ticket received (subject + body + account_id)
2. Agent classifies category
3. Agent retrieves grounded context via `search_docs`
4. Agent calls `check_status` / `check_pricing` / `lookup_account` as needed
5. Agent drafts a response with inline citations to source doc chunks
6. Agent scores confidence (retrieval relevance + self-reported certainty)
7. Routing engine decides: auto-resolve or escalate to human queue
8. If escalated: human sees the draft, citations, and full tool-call trace —
   can approve, edit-and-approve, or reject

## Routing rules
| Condition | Route |
|---|---|
| Informational, strong doc match, confidence ≥ 0.8 | auto-resolve |
| Billing dispute / refund / account charge | human review |
| Security or abuse report | human review, flag urgent |
| Enterprise / sales inquiry | human review → sales |
| Bug report | human review → eng |
| Weak/no doc match or low confidence | human review |

## Success metrics
- **Auto-resolve rate** — % of tickets resolved without a human touch
- **Escalation accuracy** — % of escalations a human agrees were correctly escalated
- **Doc-gap rate** — % of tickets with no strong doc match (signals missing/unclear docs — a product feedback loop, not just a support metric)
- **Time-to-draft**

## Explicit non-goals / scope cuts
- No real customer or account data — `accounts` table is mocked
- No real ticket data — synthetic tickets only, generated to be realistic, never scraped
- No actual ticket delivery/email integration — this is a triage demo, not a shipped support tool
- No fine-tuning — prompting + retrieval only

## Data sources
- docs.claude.com (public docs, ingested via `.md` pages)
- support.claude.com (public FAQs)
- status.anthropic.com (live status API)

## Out of scope for Day 1
Agent tool-calling loop, human review UI, reporting dashboard — see CLAUDE.md
for the day-by-day build sequence.
