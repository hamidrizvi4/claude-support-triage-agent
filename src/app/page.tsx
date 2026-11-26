import type { Metadata } from "next";
import Link from "next/link";
import { HeroTriage } from "@/components/landing/HeroTriage";
import { Walkthrough } from "@/components/landing/Walkthrough";
import { RoutingLab } from "@/components/landing/RoutingLab";
import { Results } from "@/components/landing/Results";
import { Evaluation } from "@/components/landing/Evaluation";
import evalSummary from "../../evals/results/summary.json";
import { Reveal } from "@/components/landing/Reveal";
import {
  ArchitectureDiagram,
  ResolutionCard,
  SearchCard,
  ToolsDiagram,
  TraceCard,
} from "@/components/landing/Visuals";
import styles from "@/components/landing/landing.module.css";

export const metadata: Metadata = {
  title: "Triage Control — an AI agent for Claude API developer support",
  description:
    "Classifies developer support tickets, grounds answers in Anthropic's public docs, calls live tools, drafts cited responses, and lets a deterministic router decide when a human takes over.",
};

const REPO = "https://github.com/hamidrizvi4/claude-support-triage-agent";
const CASE_STUDY = "https://hamidrizvi.vercel.app/projects/triage/narrative";

function Mark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.5 12.2 4.5v6L7 13.5 1.8 10.5v-6L7 1.5Z"
        stroke="var(--resolve)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="7" r="1.8" fill="var(--resolve)" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg className={styles.arrow} width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8m-3.5-3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Headline numbers, read from the generated eval summary so they can't go stale. */
const STATS = (() => {
  const d = evalSummary.dataset;
  const core = evalSummary.perModel[evalSummary.primary as keyof typeof evalSummary.perModel].core;
  const shipped = core.variants.find((x) => x.key === evalSummary.shipped)!;
  return [
    { v: String(d.core + d.hard), l: `hand-labeled tickets × ${evalSummary.seeds.length} seeds` },
    { v: `${(shipped.escalationRecall.mean * 100).toFixed(1)}%`, l: "must-escalate recall, shipped routing" },
    { v: shipped.unsafeAutoResolves.mean.toFixed(1), l: `unsafe auto-resolves per ${d.core}-ticket run` },
    { v: `${(shipped.coverage.mean * 100).toFixed(0)}%`, l: "of tickets resolved without a human" },
    { v: "4", l: "categories that always escalate" },
    { v: `$${core.cost.perTicket.toFixed(4)}`, l: "per ticket on the headline model" },
  ];
})();

const ENGINEERING = [
  {
    key: "Evaluation",
    title: "Hand labels, not vibes",
    body: "Every ticket has a gold category and route. Three seeds per configuration, four routing variants scored on the same agent runs, and intervals that resample tickets rather than runs, so repeats never pose as evidence.",
    where: "docs/EVALUATION.md",
  },
  {
    key: "Determinism",
    title: "The model never gates itself",
    body: "Routing is a pure, separately self-tested function. Confidence is an input to it, not the decision.",
    where: "src/lib/agent/routing.ts",
  },
  {
    key: "Guardrails",
    title: "Default-deny data, allowlisted links",
    body: "RLS is on with zero policies on all six tables, the stray anon and authenticated grants are revoked, and the RPC search_path is pinned. Model-written links render only if they're http(s).",
    where: "0005_rls_and_search_path.sql",
  },
  {
    key: "Failure modes",
    title: "Every way it fails is its own outcome",
    body: "A missing submit_resolution is incomplete. Provider 429s are rate_limited, sorted out of the way and left out of every rate. Neither is ever silently counted as resolved.",
    where: "src/lib/data/classify.ts",
  },
  {
    key: "Observability",
    title: "The trace is the audit log",
    body: "Every tool call is written to tool_calls, including the final one. The reviewer's reasoning trace is rebuilt from that log, not from a summary the model wrote.",
    where: "tool_calls",
  },
  {
    key: "Untrusted output",
    title: "Model JSON is input, not truth",
    body: "Upstream responses are guarded and tool arguments are JSON-parsed. Scores are coerced to numbers, so \"0.6\" works, and junk becomes 0, which can only push a ticket toward a human.",
    where: "coerceScore()",
  },
  {
    key: "Calibration",
    title: "Measured against reviewers",
    body: "The dashboard tracks how often a reviewer rejects or edits an auto-resolved ticket. It's honest about small samples: the rate shows as null until there's data.",
    where: "reviewCalibration",
  },
  {
    key: "Known limits",
    title: "What it doesn't do yet",
    body: "Both confidence signals are the model's own: cosine similarity was tested as an objective replacement and showed no gain. The 0.6/0.4 weights are a prior, untuned. Bug reports are mostly misfiled, so their hard rule rarely fires. Exact vector search needs the 0006 index migration. No auth in v1.",
    where: "docs/EVALUATION.md",
    limit: true,
  },
];

const STACK = [
  { n: "Next.js 16", s: "App Router · server components" },
  { n: "TypeScript", s: "strict" },
  { n: "Supabase", s: "Postgres · pgvector · RLS" },
  { n: "OpenRouter", s: "OpenAI-compatible tool calling" },
  { n: "qwen3-embedding-8b", s: "2048-d embeddings" },
  { n: "Vercel", s: "deploy" },
];

export default function IntroPage() {
  return (
    <div className={styles.page}>
      <header className={`glassPanel ${styles.nav}`}>
        <div className={styles.navInner}>
          <Link href="/" className={styles.brand}>
            <span className={styles.brandMark}>
              <Mark />
            </span>
            <span>
              <span className={styles.brandName}>Triage Control</span>
              <span className={styles.brandSub}>Claude API support</span>
            </span>
          </Link>
          <nav className={styles.navLinks} aria-label="Sections">
            <a className={styles.navLink} href="#routing">Routing math</a>
            {evalSummary.status === "complete" && (
              <a className={styles.navLink} href="#evaluation">Evaluation</a>
            )}
            <a className={styles.navLink} href="#results">Models</a>
            <a className={styles.navLink} href="#agent">Agent</a>
            <a className={styles.navLink} href="#walkthrough">Walkthrough</a>
            <a className={styles.navLink} href="#engineering">Engineering</a>
          </nav>
          <div className={styles.navCtas}>
            <a className={`${styles.btn} ${styles.btnGhost} ${styles.navGhost}`} href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/queue">
              Try now <Arrow />
            </Link>
          </div>
        </div>
      </header>

      <div className={styles.frame}>
        {/* ── Hero ── */}
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>/support triage for the claude api</span>
            <h1 className={styles.h1}>
              <em>Resolves</em> what the docs answer. <strong>Routes</strong> what they can&apos;t.
            </h1>
            <p className={styles.heroLede}>
              An agent that classifies developer support tickets, grounds itself in Anthropic&apos;s public
              documentation, calls live tools and drafts a cited response. A deterministic router, not the
              model, decides when a human takes over.
            </p>
            <div className={styles.heroCtas}>
              <Link className={`${styles.btn} ${styles.btnResolve}`} href="/queue">
                Try the review queue <Arrow />
              </Link>
              <a className={`${styles.btn} ${styles.btnGhost}`} href="#evaluation">
                See how it was evaluated
              </a>
            </div>
            <p className={styles.heroNote}>Live demo · synthetic tickets · mocked accounts · no sign-in</p>
          </div>
          <HeroTriage />
        </section>

        <div className={styles.stats}>
          {STATS.map((s) => (
            <div className={styles.stat} key={s.l}>
              <span className={styles.statValue}>{s.v}</span>
              <span className={styles.statLabel}>{s.l}</span>
            </div>
          ))}
        </div>

        {/* ── Routing math ── */}
        <section className={styles.section} id="routing">
          <span className={styles.eyebrow}>/the math behind it</span>
          <h2 className={styles.h2}>The model reports. The rules decide.</h2>
          <p className={styles.lede}>
            Confidence is a 60/40 blend of two numbers the model reports: how well the docs it found
            match the question, and how sure it is of its answer.
            Four categories skip that math entirely. Drag the sliders: this panel runs the same{" "}
            <code>route()</code> the agent uses.
          </p>
          <RoutingLab />
          <div className={styles.why}>
            <div className={styles.whyItem}>
              <span className={styles.mono}>why two signals</span>
              <h4>A doc gap isn&apos;t the same as doubt</h4>
              <p>
                Retrieval and certainty stay as two visible numbers, not one opaque score. A reviewer can
                tell &ldquo;the docs didn&apos;t cover this&rdquo; from &ldquo;the docs covered it but the model
                wasn&apos;t sure&rdquo;, and the first one becomes a doc-gap signal.
              </p>
            </div>
            <div className={styles.whyItem}>
              <span className={styles.mono}>why 0.6 / 0.4</span>
              <h4>A prior, stated plainly</h4>
              <p>
                retrieval_score is tied to docs the agent actually fetched; self_certainty is pure
                introspection, so it gets less weight. The weights were set before any labels existed and
                left untuned: the eval finds the blend only marginally ahead of certainty alone. The
                geometry is strict: at full certainty, retrieval must still reach 0.67; with perfect
                retrieval, certainty needs 0.5.
              </p>
            </div>
            <div className={styles.whyItem}>
              <span className={styles.mono}>why hard rules</span>
              <h4>Asymmetric cost gets a category, not a probability</h4>
              <p>
                A slow answer on a rate-limit question is cheap. A wrong autonomous answer on a refund,
                a security report, a sales deal or a bug is not. Those four always reach a human,
                however confident the model claims to be.
              </p>
            </div>
          </div>
        </section>

        {/* ── Evaluation (only once a labeled run has been scored) ── */}
        {evalSummary.status === "complete" && (
          <section className={styles.section} id="evaluation">
            <span className={styles.eyebrow}>/evaluation</span>
            <h2 className={styles.h2}>Scored against hand labels, including what didn&apos;t work.</h2>
            <p className={styles.lede}>
              Every ticket has a gold label for where it should go. The headline metric is <b>must-escalate recall</b>: of the
              tickets that need a human, how many reached one. The expensive failure is an agent that confidently answers a billing
              dispute or a security report, so that&apos;s the number to protect.
            </p>
            <Evaluation />
          </section>
        )}

        {/* ── Results ── */}
        <section className={styles.section} id="results">
          <span className={styles.eyebrow}>/models &amp; cost</span>
          <h2 className={styles.h2}>Which model, and what finishing costs.</h2>
          <p className={styles.lede}>
            The labeled runs, compared by model and by provider routing. Safety comes from the router; the
            model mostly decides how often the agent finishes, and at what price.
          </p>
          <Results />
        </section>

        {/* ── Agent ── */}
        <section className={styles.section} id="agent">
          <span className={styles.eyebrow}>/the agent loop</span>
          <h2 className={styles.h2}>One ticket, one loop, every call on the record.</h2>
          <p className={styles.lede}>
            Support queues mix two very different tiers: repetitive questions the docs already answer,
            and billing, security, sales and bug tickets where a wrong autonomous answer is expensive.
            The agent handles the first tier and hands off the second with full context.
          </p>

          <div className={styles.rows}>
            <Reveal>
              <div className={styles.row}>
                <div className={styles.rowVisual}>
                  <SearchCard />
                </div>
                <div>
                  <span className={styles.rowTag}>search_docs</span>
                  <h3 className={styles.h3}>Grounded in real documentation</h3>
                  <p className={styles.rowBody}>
                    Public pages from docs.claude.com and support.claude.com are split into section-aware
                    chunks of about 375 words, embedded and stored in pgvector. The agent has to search
                    before it states a fact, and every claim in the draft cites the chunk it came from.
                  </p>
                  <ul className={styles.bullets}>
                    <li className={styles.bullet}>Pricing, limits and model behaviour are never answered from memory</li>
                    <li className={styles.bullet}>Weak matches surface on the dashboard as documentation gaps</li>
                  </ul>
                </div>
              </div>
            </Reveal>

            <Reveal>
              <div className={`${styles.row} ${styles.rowFlip}`}>
                <div className={styles.rowVisual}>
                  <ToolsDiagram />
                </div>
                <div>
                  <span className={styles.rowTag}>tool calling</span>
                  <h3 className={styles.h3}>Tools that touch real systems</h3>
                  <p className={styles.rowBody}>
                    <code>check_status</code> calls Anthropic&apos;s live status page whenever a ticket mentions
                    errors or degraded behaviour. <code>check_pricing</code> reads grounded docs.{" "}
                    <code>lookup_account</code> returns plan tier, usage and limits from a mocked table. It
                    has no real customer data, by design.
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal>
              <div className={styles.row}>
                <div className={styles.rowVisual}>
                  <ResolutionCard />
                </div>
                <div>
                  <span className={styles.rowTag}>structured output</span>
                  <h3 className={styles.h3}>One forced, typed resolution</h3>
                  <p className={styles.rowBody}>
                    The loop has to end with exactly one <code>submit_resolution</code>, which <code>tool_choice</code>{" "}
                    forces on the final turn. It carries a category, the draft, citations and two separate
                    confidence signals. Every field is parsed and validated before anything reads it.
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal>
              <div className={`${styles.row} ${styles.rowFlip}`}>
                <div className={styles.rowVisual}>
                  <TraceCard />
                </div>
                <div>
                  <span className={styles.rowTag}>audit trail</span>
                  <h3 className={styles.h3}>Explainable after the fact</h3>
                  <p className={styles.rowBody}>
                    Every tool call, inputs and outputs included, is written to <code>tool_calls</code>. A
                    reviewer opening any ticket sees the exact sequence that produced the draft, so you can
                    always answer &ldquo;why did it do that?&rdquo;.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── Walkthrough ── */}
        <section className={styles.section} id="walkthrough">
          <span className={styles.eyebrow}>/walkthrough</span>
          <h2 className={styles.h2}>Follow one ticket end to end.</h2>
          <p className={styles.lede}>
            Seven steps, from an inbound ticket to a human decision. Hover to pause, or click any step.
          </p>
          <Walkthrough />
        </section>

        {/* ── Product ── */}
        <section className={styles.section} id="product">
          <span className={styles.eyebrow}>/in the product</span>
          <h2 className={styles.h2}>Built for the person reviewing the agent.</h2>
          <p className={styles.lede}>
            Recorded from the real queue and dashboard, running on a synthetic fixture dataset.
          </p>
          <div className={styles.gifGrid}>
            <div className={styles.card}>
              <div className={styles.browserBar}>
                <span className={styles.dots} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className={styles.url}>/queue</span>
              </div>
              {/* A real GIF on purpose (it loops anywhere, even in a README); next/image would also pull in sharp. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={styles.gif}
                src="/landing/queue-walkthrough.gif"
                width={1280}
                height={800}
                alt="Review queue: moving through tickets with j/k, opening a ticket drawer with its reasoning trace, confidence breakdown and cited draft."
              />
            </div>
            <div className={styles.gifCaption}>
              <div className={styles.capItem}>
                <h4>A queue you can drive from the keyboard</h4>
                <p>j/k to move, Enter to open. Filter by category and escalation reason. Rate-limited runs sink to the bottom.</p>
              </div>
              <div className={styles.capItem}>
                <h4>The why, not just the what</h4>
                <p>The drawer shows the tool-call trace, the confidence split against the 0.8 line, and the draft with inline citations.</p>
              </div>
              <div className={styles.capItem}>
                <h4>Approve, edit or reject</h4>
                <p>Every decision is written to reviews, and that feeds the calibration metric on the dashboard.</p>
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.browser}`}>
            <div className={styles.browserBar}>
              <span className={styles.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className={styles.url}>/dashboard</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.gif}
              src="/landing/dashboard.gif"
              width={1280}
              height={800}
              alt="Reporting dashboard: run integrity, auto-resolve and escalation rates, confidence calibration, escalation breakdown and documentation gaps."
            />
          </div>
        </section>

        {/* ── Engineering ── */}
        <section className={styles.section} id="engineering">
          <span className={styles.eyebrow}>/engineering notes</span>
          <h2 className={styles.h2}>What I&apos;d check if I were reviewing it.</h2>
          <p className={styles.lede}>
            The questions that matter when an agent goes anywhere near production, and where each answer
            lives in the repo.
          </p>
          <div className={styles.eng}>
            {ENGINEERING.map((e) => (
              <div className={`${styles.engCard} ${e.limit ? styles.engLimit : ""}`} key={e.key}>
                <span className={styles.engKey}>{e.key}</span>
                <h3 className={styles.engTitle}>{e.title}</h3>
                <p className={styles.cardBody}>{e.body}</p>
                <span className={styles.engWhere}>{e.where}</span>
              </div>
            ))}
          </div>

          <div className={styles.stackRow}>
            {STACK.map((s) => (
              <span className={styles.stackItem} key={s.n}>
                {s.n} <span>{s.s}</span>
              </span>
            ))}
          </div>
        </section>

        {/* ── Architecture ── */}
        <section className={styles.section} id="architecture">
          <span className={styles.eyebrow}>/architecture</span>
          <h2 className={styles.h2}>Three lanes, one source of truth.</h2>
          <p className={styles.lede}>
            Ingestion runs once. The agent runs per ticket. Audit and review data accumulate underneath,
            and the queue and dashboard both read them through one shared classification layer, so they
            can never disagree about a number.
          </p>
          <div className={`${styles.card} ${styles.archWrap}`}>
            <ArchitectureDiagram />
          </div>
        </section>

        {/* ── CTA ── */}
        <section className={styles.cta}>
          <span className={styles.eyebrow}>/try it</span>
          <h2 className={styles.ctaTitle}>Open the queue and review the agent&apos;s work.</h2>
          <div className={styles.heroCtas} style={{ marginTop: 0 }}>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/queue">
              Try now <Arrow />
            </Link>
            <Link className={`${styles.btn} ${styles.btnGhost}`} href="/dashboard">
              View the dashboard
            </Link>
            <a className={`${styles.btn} ${styles.btnGhost}`} href={CASE_STUDY} target="_blank" rel="noreferrer">
              Read the case study
            </a>
          </div>
        </section>

        <footer className={styles.footer}>
          <p>
            Independent portfolio project, not affiliated with or endorsed by Anthropic. Grounded only in
            public documentation. Tickets are synthetic and account data is mocked.
          </p>
          <div className={styles.footLinks}>
            <Link href="/queue">Queue</Link>
            <Link href="/dashboard">Dashboard</Link>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={CASE_STUDY} target="_blank" rel="noreferrer">
              Case study
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
