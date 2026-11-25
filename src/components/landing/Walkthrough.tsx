"use client";

import { useEffect, useState, type ReactNode } from "react";
import styles from "./landing.module.css";

/**
 * Auto-advancing walkthrough of one ticket, step by step. The left list is
 * the narrative; the right panel highlights where that step sits in the
 * pipeline and shows the actual payload shape at that point.
 */
const NODES = ["Ticket", "Agent", "Tools", "Resolution", "Router", "Human"];

type Step = {
  title: string;
  desc: string;
  node: number;
  file: string;
  payload: ReactNode;
};

function J({ children }: { children: ReactNode }) {
  return <pre className={styles.code}>{children}</pre>;
}

const STEPS: Step[] = [
  {
    title: "A ticket arrives",
    desc: "Subject, body and an account id. That's all the agent gets. The tickets are synthetic and LLM-generated, never scraped from a real user.",
    node: 0,
    file: "tickets",
    payload: (
      <J>
        {"{\n  "}
        <span className={styles.k}>&quot;subject&quot;</span>: <span className={styles.s}>&quot;Rate limit headers missing on 429 responses&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;body&quot;</span>: <span className={styles.s}>&quot;We get 429s but don&apos;t see retry-after…&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;account_id&quot;</span>: <span className={styles.s}>&quot;5e0b…c41a&quot;</span>
        <span className={styles.cm}>{"  // uuid → mocked accounts row"}</span>
        {"\n}"}
      </J>
    ),
  },
  {
    title: "The agent plans its calls",
    desc: "A tool-calling loop, at most 8 turns. The system prompt sets the rules: ground every factual claim, check status on any error, never answer pricing or limits from memory.",
    node: 1,
    file: "orchestrator.ts",
    payload: (
      <J>
        <span className={styles.cm}>{"// one ticket, one loop\n"}</span>
        {"for (turn = 0; turn < "}
        <span className={styles.n}>MAX_TURNS</span>
        {" /* 8 */; turn++) {\n  res = chat.completions.create({\n    model, tools, max_tokens: "}
        <span className={styles.n}>2048</span>
        {",\n    ...(isLastTurn && { tool_choice: "}
        <span className={styles.hl}>submit_resolution</span>
        {" })\n  })\n  "}
        <span className={styles.cm}>{"// every call → tool_calls, before the next turn\n"}</span>
        {"}"}
      </J>
    ),
  },
  {
    title: "It grounds itself in the docs",
    desc: "search_docs embeds the query and runs a cosine-similarity search over chunks of docs.claude.com and support.claude.com stored in pgvector.",
    node: 2,
    file: "tool_calls · search_docs",
    payload: (
      <J>
        <span className={styles.k}>input</span>
        {"  { query: "}
        <span className={styles.s}>&quot;429 retry-after header&quot;</span>
        {", top_k: "}
        <span className={styles.n}>5</span>
        {" }\n"}
        <span className={styles.k}>output</span>
        {" [\n  { source_url: "}
        <span className={styles.s}>&quot;docs.claude.com/…/rate-limits&quot;</span>
        {",\n    section: "}
        <span className={styles.s}>&quot;Response headers&quot;</span>
        {" },\n  …4 more chunks\n]"}
      </J>
    ),
  },
  {
    title: "It checks live state",
    desc: "check_status calls Anthropic's real status page. lookup_account and check_pricing fill in the rest. Account data is mocked.",
    node: 2,
    file: "tool_calls · check_status",
    payload: (
      <J>
        <span className={styles.k}>check_status</span>
        {"   → "}
        <span className={styles.hlResolve}>live</span>
        {" status.claude.com\n               { incidents: [] }\n"}
        <span className={styles.k}>lookup_account</span>
        {" → "}
        <span className={styles.hl}>mocked</span>
        {" accounts table\n               { plan_tier, monthly_usage, rate_limit }"}
      </J>
    ),
  },
  {
    title: "It submits one structured resolution",
    desc: "The loop must end with exactly one submit_resolution call. Its arguments are parsed and coerced before use, and a missing call is recorded as incomplete. It never counts as resolved.",
    node: 3,
    file: "submit_resolution",
    payload: (
      <J>
        {"{\n  "}
        <span className={styles.k}>&quot;category&quot;</span>: <span className={styles.s}>&quot;technical_api_error&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;draft_response&quot;</span>: <span className={styles.s}>&quot;Rate-limit responses include…&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;citations&quot;</span>: [ … ]
        {",\n  "}
        <span className={styles.k}>&quot;retrieval_score&quot;</span>: <span className={styles.n}>0.74</span>
        {",\n  "}
        <span className={styles.k}>&quot;self_certainty&quot;</span>: <span className={styles.n}>0.79</span>
        {"\n}"}
      </J>
    ),
  },
  {
    title: "Rules decide the route",
    desc: "A pure function, not the model, makes the call. Four categories always escalate. Everything else needs a blended confidence of 0.8 or higher.",
    node: 4,
    file: "routing.ts",
    payload: (
      <J>
        {"route("}
        <span className={styles.s}>&quot;technical_api_error&quot;</span>
        {", "}
        <span className={styles.n}>0.74</span>
        {", "}
        <span className={styles.n}>0.79</span>
        {")\n\n"}
        <span className={styles.cm}>{"// 0.6 × 0.74 + 0.4 × 0.79 = 0.760\n"}</span>
        {"→ { status: "}
        <span className={styles.hl}>&quot;escalated&quot;</span>
        {", reason: "}
        <span className={styles.hl}>&quot;low_confidence&quot;</span>
        {" }"}
      </J>
    ),
  },
  {
    title: "A human closes the loop",
    desc: "The reviewer sees the draft, its citations and the full tool-call trace, then approves, edits or rejects it. Overturned auto-resolves feed back into calibration.",
    node: 5,
    file: "reviews",
    payload: (
      <J>
        {"reviews.insert({\n  action: "}
        <span className={styles.s}>&quot;approve&quot;</span>
        <span className={styles.cm}>{" | \"edit_and_approve\" | \"reject\""}</span>
        {",\n  edited_response: "}
        <span className={styles.n}>null</span>
        {"\n})\n\n"}
        <span className={styles.cm}>{"// dashboard: overturned ÷ reviewed auto-resolves"}</span>
      </J>
    ),
  },
];

const STEP_MS = 5200;

export function Walkthrough() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [active, paused]);

  const step = STEPS[active];
  const W = 600;
  const gap = W / NODES.length;

  return (
    <div className={styles.walk} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <ol className={styles.walkSteps}>
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <button
              type="button"
              className={`${styles.walkStep} ${i === active ? styles.walkStepOn : ""}`}
              aria-current={i === active ? "step" : undefined}
              onClick={() => setActive(i)}
            >
              <span className={styles.walkNum}>{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className={styles.walkTitle}>{s.title}</span>
                <span className={styles.walkDesc}>{s.desc}</span>
              </span>
              {i === active && !paused && (
                <span
                  key={active}
                  className={styles.walkProgress}
                  style={{ animationDuration: `${STEP_MS}ms` }}
                  aria-hidden="true"
                />
              )}
            </button>
          </li>
        ))}
      </ol>

      <div className={`${styles.card} ${styles.walkPanel}`}>
        <div className={styles.pipe}>
          <svg viewBox={`0 0 ${W} 64`} className={styles.diagram} role="img" aria-label={`Pipeline, step: ${NODES[step.node]}`}>
            {NODES.slice(0, -1).map((_, i) => (
              <line
                key={i}
                x1={gap * i + gap / 2 + 42}
                x2={gap * (i + 1) + gap / 2 - 42}
                y1={32}
                y2={32}
                className={`${styles.pipeEdge} ${i < step.node ? styles.pipeEdgeDone : ""}`}
              />
            ))}
            {NODES.map((n, i) => {
              const on = i === step.node;
              const done = i < step.node;
              return (
                <g key={n}>
                  <rect
                    x={gap * i + gap / 2 - 42}
                    y={18}
                    width={84}
                    height={28}
                    rx={7}
                    className={`${styles.pipeNode} ${on ? styles.pipeNodeOn : ""} ${done ? styles.pipeNodeDone : ""}`}
                  />
                  <text
                    x={gap * i + gap / 2}
                    y={36}
                    textAnchor="middle"
                    className={`${styles.pipeText} ${on ? styles.pipeTextOn : ""}`}
                  >
                    {n}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className={styles.walkPayload} key={active}>
          <div className={styles.payloadHead}>
            <span>{step.file}</span>
            <span>
              step {active + 1}/{STEPS.length}
            </span>
          </div>
          {step.payload}
        </div>
      </div>
    </div>
  );
}
