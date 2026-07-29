# Case study: Claude API support triage agent

**TL;DR** — An AI agent that triages developer support tickets for a public
API: grounds itself in real documentation, reasons through a multi-step
tool-calling workflow, and routes to a human whenever the stakes or the
uncertainty are too high. After the core build shipped, I ran it through a
7-point external code review and worked it the way a senior engineer works
review feedback — verifying every claim against the live system rather than
trusting the write-up, and treating "not in the review" as not the same as
"not a problem." That process surfaced a real pre-launch security exposure,
several bugs the review didn't catch, and a disclosed, financially-verified
tradeoff between a $0 model and a $0.25 one. It also produced three moments
where the right move was to *not* decide something unilaterally — which,
for a project whose entire thesis is "know when to escalate to a human,"
turned out to be the most on-theme part of building it.

*Independent portfolio project. Not affiliated with or endorsed by Anthropic.
Built entirely on Anthropic's public documentation — no private data.*

## Context

Every API company faces the same support-ops problem: a large tier of
repetitive, doc-answerable questions (rate limits, pricing, migration steps)
sits alongside a smaller tier of genuinely sensitive tickets — billing
disputes, security reports, enterprise sales, bug reports — that need a
human. Most teams give every ticket roughly equal attention regardless of
which tier it's in. I used Anthropic's public developer docs as a real,
richly-structured grounding corpus to build a triage agent against — not a
toy dataset.

## Problem

Build an agent that takes real business context, reasons through a
multi-step workflow, uses tools — including at least one live external
system — generates a structured, citable output, and routes intelligently
to a human, with a full audit trail of why.

## What I built

An agent loop with five tools: `search_docs` (RAG over ingested public docs),
`check_status` (a live call to Anthropic's real status page), `check_pricing`
and `lookup_account` (grounded/mocked lookups), and a forced final
`submit_resolution` call producing structured, validated output — category,
draft response, citations, and two independent confidence signals
(`retrieval_score`, `self_certainty`).

A rules-based routing engine, not the model itself, makes the final call:
billing, security, sales, and bug-report categories always route to a human
regardless of model confidence, because the cost of a wrong autonomous
answer there is asymmetric. Everything else routes on a confidence
threshold (`0.6 × retrieval_score + 0.4 × self_certainty`, threshold 0.8).
Every tool call is logged. A review queue, ticket-detail drawer, and
reporting dashboard sit on top, including a "doc-gap" view surfacing
tickets where the agent found no strong doc match — a proxy for missing or
unclear documentation.

That's the version that shipped through what I was calling "Day 3." What
follows is what happened next.

## The audit: an external review, worked the way a senior engineer works one

Once the core product was live, I ran the repo through a 7-point external
code review and treated the findings the way I'd want a senior engineer to
treat feedback on my own code: verify everything independently against the
live system before touching anything, and don't assume the review's scope
was complete. In three of the seven areas, the actual problem was larger
than what was reported.

**1. Live security misconfiguration.** The review flagged Row-Level
Security as disabled. I didn't take that on faith — I ran Supabase's own
advisor tooling against the live project and confirmed it directly: RLS
disabled at ERROR level on all six tables, plus a WARN on a mutable
function search path. Reading the migration history explained why: an
earlier fix for an unrelated problem (the app's service-role key needed
explicit grants, since Postgres's row-security bypass doesn't imply base
table grants) had, as a side effect, given the `anon` and `authenticated`
roles full read/write on every table too. Nothing had broken in practice
only because the app happened to be 100% server-side — one client-side
Supabase call away from unauthenticated read/write on every ticket and
review in the database. Fixed with two independent layers: revoked the
anon/authenticated grants (including the default-privilege versions, so
future tables aren't exposed either) and enabled RLS with zero policies —
default-deny for everyone except the service role. Verified by re-running
the advisor scan (the ERROR and WARN both gone) and confirming the app's
actual service-role query path still worked. I also found and documented,
but deliberately didn't touch, a lower-severity advisory about the vector
extension living in the public schema — fixing it means dropping and
recreating the extension, a real risk for a marginal gain, and it wasn't
part of what was reported.

**2. A README that undersold its own product.** It still ended with "review
UI and dashboard are Day 3 — not built yet," after they'd shipped. Fixed
with an honest description of what's actually there.

**3. Citation URLs rendered unsafely — and a second copy of the same bug.**
The named issue: a citation's `source_url`, sourced from the model's JSON
output, was rendered straight into `<a href>` with no protocol check — a
`javascript:`/`data:` URI would render as a live clickable link. While
fixing it, I found an independent second path to the exact same
vulnerability class: the draft-response renderer has a fallback for
markdown-style `[label](url)` links that don't match a known citation, and
that fallback rendered the raw URL as an href too, completely bypassing the
citations pipeline. Fixed both with the same protocol allowlist.

**4. Thin test coverage — with a structural blocker underneath it.** The
named gap: the function that had already caused two real dashboard-corrupting
bugs earlier in the project had zero tests. When I tried to write them, I
found out why: that function lived in a file gated by `import "server-only"`,
which throws unconditionally the moment the file loads outside a bundler —
not just when bundled for a client component, which is the common
assumption. A plain test runner crashed before ever reaching the function
under test. So the missing coverage wasn't an oversight; the file was
structurally hostile to testing. Fixed by extracting the pure logic into
its own side-effect-free module with no `server-only` and no Supabase
import, then writing real test suites against it — including the specific
ordering rule that had caused a prior bug (a rate-limit failure is also
reported as a generic agent error, so the classifier has to check the
specific case first). Also found an existing test file that had been
written at some point but never wired into `npm test` — wired it in. Four
test suites now run as one command.

**5. Git history that undercut its own narrative.** A history of large
squashed commits doesn't read as "found and fixed real bugs" even when it's
true. I didn't rewrite it — squashing or reordering already-published
commits is destructive, and that's not a call to make unilaterally. Flagged
it as an observation, left it alone.

**6. A headline number that could undercut the pitch.** 50% of tickets
(20/40) came back "incomplete" on the free-tier run — a real, disclosed
finding, but also a number that could read as "the demo doesn't work" to
someone skimming. This wasn't mine to decide: spend real money to also show
a clean run, or reframe the story, or leave it as-is. I surfaced it as an
explicit choice rather than picking one. The call: spend a small budget
(~$10) on a paid-model rerun, and keep the free-tier result in the write-up
as the disclosed cost of building at $0, not something to hide behind a
better number.

**7. Everything else the review bundled as "smaller issues."** Each one
had a second layer once I looked closely. The confidence threshold constant
was duplicated between two files — and so, it turned out, was the entire
"which categories always escalate" list, an independent instance of the
identical failure mode. Deduped both down to one source of truth. The
confidence formula itself had no empirical validation, even though the
`reviews` table already contained the exact signal needed — whether a human
approved, edited, or rejected each auto-resolved ticket. Added a
reviewer-overturn calibration metric to the dashboard, computed live from
that table, and made it degrade honestly at low sample size (at the time,
exactly one real review existed — it shows "0.0% overturned of 1 reviewed
auto-resolve," not a falsely precise-looking percentage). The review's
`npm audit` claim also undercounted: it reported 3 high-severity findings;
the actual count was 12, in two independent dependency clusters. Rather than
force-fixing blindly, I checked whether either cluster was actually
reachable in this codebase — one is entirely inside dev-only lint tooling
never shipped in the built app, the other requires either processing
untrusted CSS (this repo's CSS is 100% author-written) or an image-decode
path (`next/image`) that's never imported anywhere in the source. Both
documented as accepted, non-exploitable risk rather than forced downgrades
that would've broken the app. Also added the LICENSE the repo didn't have.

## The paid-model economics experiment

Finding #6 turned into the most concrete artifact in the whole project: a
real, measured comparison instead of a guess.

In the project's own stated ethos — never answer pricing or model behavior
from memory, because it changes — I researched rather than assumed which
OpenRouter models actually support accuracy-optimized tool-calling routing
and what they cost, pulling current pricing directly from OpenRouter's own
model pages rather than trusting cached knowledge. Made the orchestration
model an environment variable instead of a hardcoded constant, so a paid
run is an explicit, visible opt-in and the free tier stays the shipped
default. One pre-flight check surfaced a small but pointed confirmation of
finding #1: unused Supabase publishable keys were already sitting in the
local environment file, unreferenced by any code — exactly the kind of
loaded gun the RLS fix had closed off, sitting right there.

Ran the identical 40-ticket set through both configurations:

| Run | Model | Resolved | Escalated | Incomplete | Cost |
|---|---|---|---|---|---|
| Free-tier | `nemotron-3-ultra:free` | 8 (20%) | 12 (30%) | 20 (50%) | $0 |
| Paid, Exacto-routed | `deepseek-v3.2:exacto` | 15 (37.5%) | 22 (55%) | 3 (7.5%) | $0.25 |

Both numbers are independently verified, not projected: the free-tier
50%-incomplete figure was re-derived directly from the database using the
same classification logic the dashboard uses, and matches the original
review's claim exactly. The cost figure came from OpenRouter's own billing
API, not an estimate — $0.25 for all 40 tickets against a $10 budget. Along
the way, the outcome tally required deliberately *not* trusting the
pipeline script's own printed summary, which lumps certain error-fallback
rows into its "escalated" count in a way that would have overstated that
number if copied directly — the numbers above are recomputed independently
against the dashboard's actual classification rules. And the paid run
surfaced a genuinely new failure mode the free tier never hit: one ticket's
`submit_resolution` call came back with truncated JSON, almost certainly
`max_tokens` cutting off a long response mid-payload — a different failure
mode than a missed tool call, and a clear next fix rather than a mystery.

Both rows stay in the write-up. The free-tier result is the actual finding
about what "free" costs; the paid run is the clean dataset the rest of the
product is built to demonstrate against.

## What I deliberately didn't decide

Three separate moments in this process were about recognizing a decision
wasn't mine to make alone, which is worth calling out on its own: declining
to rewrite published git history even though it would have made the
narrative cleaner; surfacing the 50%-incomplete number as an explicit
choice between spending money, reframing, or leaving it, rather than
picking the option that looked best; and one unplanned one — a later
verification pass found that git only showed a single commit covering what
should have been roughly a dozen files' worth of changes, with no record of
having run that commit in the visible working session. Rather than guess at
an explanation or silently rewrite it into something tidier, I surfaced the
discrepancy plainly and asked which way to go. The call was to leave it as
one commit and move forward, and a small follow-up commit went in cleanly
on top.

None of these were mistakes to fix. They're the same judgment call the
product itself is built to make — route the confidence-decisions to
whoever's in the loop, don't quietly overreach — applied to the process of
building it, not just the code.

## Bugs and findings, in full

| # | Phase | Finding | Fix |
|---|---|---|---|
| 1 | Provider swap | Unguarded API response access crashed opaquely on malformed upstream responses | Guarded, fails cleanly with a readable error |
| 2 | Provider swap | Error-fallback path wrote an invalid enum into a constraint-checked column, failing silently on every agent-error ticket | Leaves the field null on that path |
| 3 | Provider swap | Untrusted model output cast without validation, letting non-numeric confidence become `NaN` | Coerced and validated |
| 4 | Post-launch | Outcome classification read a column the review-approval flow itself mutates, silently corrupting dashboard stats the moment a ticket was reviewed | Derives outcome from an immutable field instead |
| 5 | Post-retheme | CSS minifier silently dropped a standard property declared adjacent to its vendor-prefixed twin — a visual effect that quietly did nothing | Split into separate `@supports` blocks |
| 6 | Audit | RLS disabled repo-wide plus an unintended full-privilege grant to unauthenticated roles | Two independent fix layers, verified before/after |
| 7 | Audit | Citation and markdown-link URLs rendered as hrefs with no protocol check, in two independent code paths | Protocol allowlist applied at both sites |
| 8 | Audit | Core classification logic untestable due to a structural import issue, not just undertested | Extracted to a pure module, full test coverage added |
| 9 | Audit | Confidence threshold and escalation-category list each duplicated across two files | Single source of truth for both |
| 10 | Audit | Confidence formula had no empirical validation against real human review decisions | Reviewer-overturn calibration metric added |
| 11 | Audit | `npm audit` findings undercounted (12 actual vs. 3 reported) | Full reachability analysis on both clusters, documented as accepted risk |
| 12 | Paid rerun | `submit_resolution` JSON truncated mid-payload on one ticket, likely `max_tokens` | Documented, targeted for a follow-up fix |

## What I'd do next

- Raise `max_tokens` and re-verify against finding #12
- Use the doc-gap signal as an active feedback loop into documentation planning
- Track the reviewer-overturn calibration metric over a larger review sample
  as real usage accumulates
- Revisit the vector-extension-in-public advisory once there's a maintenance
  window to safely drop and recreate it

## Architecture

```
docs.claude.com ─┐
support.claude.com ─┼─▶ ingestion (chunk + embed) ─▶ Supabase / pgvector (RLS enabled)
status.claude.com ─┘

ticket ─▶ agent orchestrator (tool-calling loop) ─▶ routing engine ─▶ auto-resolve
                     │                                              └▶ human review queue
                     ▼
              tool_calls (audit trail)
```

## Tech stack

Next.js, TypeScript, Supabase (Postgres + pgvector + Row-Level Security),
OpenRouter (model selectable via env var — free `nemotron-3-ultra` or
Exacto-routed `deepseek-v3.2` for the clean dataset).

## Links

- Repository: *(add GitHub URL)*
- Live demo: *(add if deployed)*
