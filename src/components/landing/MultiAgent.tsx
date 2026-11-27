/**
 * Multi-agent section for the intro page: the independent checker and the
 * researcher → writer split. Renders only from evals/results/multiagent.json
 * (written by `npm run eval:multi` from raw run, checker and judge records),
 * so nothing here is typed in by hand. Renders nothing until that exists.
 */
import data from "../../../evals/results/multiagent.json";
import styles from "./landing.module.css";

type Arm = {
  key: string;
  label: string;
  set: "core" | "hard";
  runs: number;
  seeds: number;
  completion: number;
  recall: number;
  recallCI: [number, number];
  unsafePerRun: number;
  coverage: number;
  autoPrecision: number;
  costPerTicket: number;
  extraCostPerTicket: number;
  checker?: { reviewed: number; caught: number; falseAlarms: number; unsafeProposals: number; safeProposals: number; unavailable: number };
};
type Pair = { diff: number; ci: [number, number]; n: number };
type Grounding = { judged: number; claimsPerReply: number; unsupportedPerReply: number; unsupportedShare: number; repliesWithUnsupported: number };
type Multi = {
  status: string;
  router: string;
  checkers: { different: string; same: string };
  judge: string;
  checker: { arms: Arm[]; paired: Record<"core" | "hard", { diff: { recall: Pair; coverage: Pair }; same: { recall: Pair; coverage: Pair } }>; seeds: number };
  split: { arms: Arm[]; paired: Record<"core" | "hard", { recall: Pair; coverage: Pair }>; seeds: number };
  grounding: {
    single: { all: Grounding; autoResolved: Grounding; citations: number; outsideRetrieved: number };
    split: { all: Grounding; autoResolved: Grounding; citations: number; outsideRetrieved: number; citationCheckPass: number; groundingEscalations: number };
    unsupportedDiff: Pair;
  };
  judgeValidation: { planted: number; plantedCaught: number; verbatim: number; verbatimAccepted: number };
  probes: { probes: number; pass: { single: number; singleWithChecker: number; split: number; splitWithChecker: number; checkerAloneEscalated: number; canaryLeaks: number } } | null;
  spend: { total: number };
};

const m = data as unknown as Multi;
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const short = (slug: string) => slug.split("/")[1] ?? slug;
const signed = (x: number, d = 1, unit = "") => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(d)}${unit}`;
const sig = (ci: [number, number]) => ci[0] > 0 || ci[1] < 0;

export const GUARDRAILS = [
  { k: "Monotone authority", t: "A reviewer can only say no", b: "applyChecker and applyGrounding can keep a route or escalate it, never the reverse. A self-test runs every verdict against every route.", w: "guardrails.ts" },
  { k: "Fail closed", t: "Silence means a human", b: "Timeout, transport error, refusal or malformed output from the checker escalates the ticket. It never defaults to agree.", w: "applyChecker(route, null)" },
  { k: "Strict schemas", t: "One forced call, enum verdicts", b: "Each agent answers through a single forced tool call. Verdicts are enums, and code parses and validates every field before reading it.", w: "parseCheckerReview()" },
  { k: "Independence", t: "The checker sees almost nothing", b: "Ticket text and the proposed route only. No draft, tool calls or scores to anchor on, a different prompt and a different model family.", w: "checker.ts" },
  { k: "Least privilege", t: "Tools only where needed", b: "The researcher can search and nothing else. The writer and the checker have no tools at all.", w: "split.ts" },
  { k: "Input fencing", t: "Tickets are data, not instructions", b: "Ticket and doc text is fenced and length-capped. Attempts to close the fence are neutralised before any prompt sees them.", w: "fenceUntrusted()" },
  { k: "Deterministic grounding", t: "Every claim cites a passage", b: "Code checks that each claim sentence cites a passage the writer was actually given. Any gap escalates.", w: "checkCitations()" },
  { k: "Operations", t: "Bounded, audited, switchable", b: "Timeouts, token ceilings and a capped reasoning budget; retries only on transport errors. Every call is logged to tool_calls, and CHECKER=off is the kill switch.", w: "llm.ts · run-triage.ts" },
];

function CheckerDiagram() {
  return (
    <div className={styles.card}>
      <svg viewBox="0 0 560 250" className={styles.diagram} role="img" aria-label="The router proposes an auto-resolve; the checker sees only the ticket and the proposed route and can agree or escalate; any failure escalates.">
        <rect x="8" y="20" width="150" height="44" rx="8" className={styles.dNode} />
        <text x="22" y="39" className={styles.dLabel}>ticket</text>
        <text x="22" y="54" className={styles.dSub}>subject + body</text>
        <rect x="8" y="150" width="150" height="44" rx="8" className={styles.dNode} />
        <text x="22" y="169" className={styles.dLabel}>router</text>
        <text x="22" y="184" className={styles.dSub}>says: auto-resolve</text>
        <path d="M 158 42 C 200 42, 200 104, 222 104" className={styles.dLine} />
        <path d="M 158 172 C 200 172, 200 116, 222 116" className={styles.dLine} />
        <rect x="222" y="80" width="140" height="60" rx="10" className={styles.dNodeDark} />
        <text x="292" y="106" textAnchor="middle" className={styles.dLabelInv}>checker</text>
        <text x="292" y="123" textAnchor="middle" className={styles.dSubInv}>{short(m.checkers.different)}</text>
        <path d="M 362 98 C 400 98, 400 52, 430 52" className={styles.dLineOut} />
        <path d="M 362 98 C 400 98, 400 52, 430 52" className={styles.dFlow} />
        <path d="M 362 122 C 400 122, 400 168, 430 168" className={styles.dLineEsc} />
        <rect x="430" y="32" width="122" height="40" rx="8" className={styles.dNode} />
        <text x="444" y="49" className={styles.dLabel}>agree</text>
        <text x="444" y="63" className={styles.dSubLive}>answer ships</text>
        <rect x="430" y="148" width="122" height="40" rx="8" className={styles.dNode} />
        <text x="444" y="165" className={styles.dLabel}>escalate</text>
        <text x="444" y="179" className={styles.dSubEsc}>human reviews</text>
        <text x="292" y="222" textAnchor="middle" className={styles.dSub}>timeout · error · bad output → escalate</text>
        <text x="292" y="238" textAnchor="middle" className={styles.dSub}>no draft · no tool calls · no scores</text>
      </svg>
    </div>
  );
}

function SplitDiagram() {
  return (
    <div className={styles.card}>
      <svg viewBox="0 0 560 250" className={styles.diagram} role="img" aria-label="A researcher that can only search hands passages to a writer with no tools; code checks every citation before the router runs.">
        <rect x="8" y="40" width="128" height="56" rx="10" className={styles.dNodeDark} />
        <text x="72" y="64" textAnchor="middle" className={styles.dLabelInv}>researcher</text>
        <text x="72" y="81" textAnchor="middle" className={styles.dSubInv}>search_docs only</text>
        <path d="M 136 68 L 212 68" className={styles.dLineOut} />
        <path d="M 136 68 L 212 68" className={styles.dFlow} />
        {["P1", "P2", "P3"].map((p, i) => (
          <g key={p}>
            <rect x={150 + i * 20} y={86} width="18" height="16" rx="3" className={styles.dNode} />
            <text x={159 + i * 20} y={98} textAnchor="middle" className={styles.dSub}>{p}</text>
          </g>
        ))}
        <rect x="212" y="40" width="128" height="56" rx="10" className={styles.dNodeDark} />
        <text x="276" y="64" textAnchor="middle" className={styles.dLabelInv}>writer</text>
        <text x="276" y="81" textAnchor="middle" className={styles.dSubInv}>no tools</text>
        <path d="M 340 68 L 416 68" className={styles.dLine} />
        <rect x="416" y="40" width="136" height="56" rx="10" className={styles.dNode} />
        <text x="430" y="62" className={styles.dLabel}>citation check</text>
        <text x="430" y="78" className={styles.dSub}>code, not a model</text>
        <path d="M 484 96 L 484 150" className={styles.dLine} />
        <rect x="416" y="150" width="136" height="44" rx="8" className={styles.dNode} />
        <text x="430" y="169" className={styles.dLabel}>router</text>
        <text x="430" y="184" className={styles.dSub}>usual rules</text>
        <path d="M 416 74 C 360 140, 260 160, 196 172" className={styles.dLineEsc} />
        <rect x="64" y="150" width="132" height="44" rx="8" className={styles.dNode} />
        <text x="78" y="169" className={styles.dLabel}>escalate</text>
        <text x="78" y="184" className={styles.dSubEsc}>uncited · bad id</text>
        <text x="276" y="24" textAnchor="middle" className={styles.dSub}>each sentence: claim [P2] or framing</text>
        <text x="280" y="232" textAnchor="middle" className={styles.dSub}>writer can also say &ldquo;not answerable&rdquo; → escalate</text>
      </svg>
    </div>
  );
}

export function MultiAgent() {
  if (m.status !== "complete") return null;
  const arm = (arms: Arm[], key: string, set: "core" | "hard" = "core") => arms.find((a) => a.key === key && a.set === set)!;
  const base = arm(m.checker.arms, "shipped");
  const diff = arm(m.checker.arms, "checker_diff");
  const same = arm(m.checker.arms, "checker_same");
  const pc = m.checker.paired.core;
  const single = arm(m.split.arms, "single");
  const split = arm(m.split.arms, "split");
  const g = m.grounding;
  const ud = g.unsupportedDiff;
  const jv = m.judgeValidation;
  const pr = m.probes;
  const tickets = base.runs / base.seeds;

  return (
    <>
      {/* ── 1. Router + independent checker ── */}
      <div className={styles.evalTwo}>
        <CheckerDiagram />
        <div className={styles.about}>
          <h3>Router + independent checker</h3>
          <p>
            The router routes. Before an auto-resolve ships, a second agent on a different model family reviews it. It sees
            only the ticket and the proposed route, has no tools, and has two possible answers: <code>agree</code> or{" "}
            <code>escalate</code>. Code applies the verdict, and anything else, including silence, sends the ticket to a human.
            A second model can only make things safer; the question is what that costs.
          </p>
        </div>
      </div>

      <div className={styles.evalKpis}>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Must-escalate recall</span>
          <span className={styles.evalValue} style={{ color: diff.recall >= base.recall ? "var(--resolve)" : "var(--escalate)" }}>
            {pct(diff.recall)}
          </span>
          <span className={styles.evalWas}>
            was {pct(base.recall)} · {signed(pc.diff.recall.diff * 100, 1, " pts")}
          </span>
          <span className={styles.evalRange}>
            paired 95% CI {signed(pc.diff.recall.ci[0] * 100, 1)} to {signed(pc.diff.recall.ci[1] * 100, 1)}
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Unsafe auto-resolves per run</span>
          <span className={styles.evalValue} style={{ color: diff.unsafePerRun ? "var(--escalate)" : "var(--resolve)" }}>
            {diff.unsafePerRun.toFixed(1)}
          </span>
          <span className={styles.evalWas}>was {base.unsafePerRun.toFixed(1)}</span>
          <span className={styles.evalRange}>
            caught {diff.checker?.caught} of {diff.checker?.unsafeProposals} unsafe proposals
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Coverage</span>
          <span className={styles.evalValue}>{pct(diff.coverage)}</span>
          <span className={styles.evalWas}>was {pct(base.coverage)}</span>
          <span className={styles.evalRange}>
            blocked {diff.checker?.falseAlarms} of {diff.checker?.safeProposals} safe proposals
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Extra cost per ticket</span>
          <span className={styles.evalValue}>${diff.extraCostPerTicket.toFixed(5)}</span>
          <span className={styles.evalWas}>only auto-resolves are reviewed</span>
          <span className={styles.evalRange}>{diff.checker?.unavailable ?? 0} reviews failed closed</span>
        </div>
      </div>
      <p className={styles.evalFoot}>
        <code>{short(m.router)}</code> router, {tickets} labeled tickets × {base.seeds} seeds, checker{" "}
        <code>{short(m.checkers.different)}</code>. Paired on the same runs, so the router&apos;s output is identical across arms.
      </p>

      <div className={styles.evalTwo}>
        <div className={styles.card}>
          <div className={styles.payloadHead}>
            <span>same runs, three arms</span>
            <span>recall · unsafe/run · coverage</span>
          </div>
          <ul className={`${styles.arms} ${styles.arms3}`}>
            {[base, diff, same].map((a) => (
              <li key={a.key} className={a.key === "checker_diff" ? styles.armShipped : ""}>
                <span>{a.label}</span>
                <b>{pct(a.recall)}</b>
                <b>{a.unsafePerRun.toFixed(1)}</b>
                <b>{pct(a.coverage, 0)}</b>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.about}>
          <h3>Same prompt, different model</h3>
          <p>
            Run with the same prompt on the router&apos;s own model family, the checker caught {same.checker?.caught} of{" "}
            {same.checker?.unsafeProposals} unsafe proposals; on a different family it caught {diff.checker?.caught}.{" "}
            {(diff.checker?.caught ?? 0) > (same.checker?.caught ?? 0)
              ? "That fits a reviewer that shares the router's blind spots agreeing with it, though five cases can't settle it. "
              : "Here, model diversity did not buy extra catches. "}
            The cost side: the different-model checker blocked {diff.checker?.falseAlarms} of {diff.checker?.safeProposals} safe
            auto-resolves, the same-model one {same.checker?.falseAlarms}. Fewer wrong answers sent means more tickets a human
            reads.{" "}
            {sig(pc.diff.recall.ci)
              ? "The recall gain's paired interval excludes zero."
              : `On ${tickets} tickets the recall gain's paired interval still includes zero.`}
          </p>
        </div>
      </div>

      {/* ── 2. Researcher → writer ── */}
      <div className={styles.evalTwo} style={{ marginTop: "var(--space-16)" }}>
        <SplitDiagram />
        <div className={styles.about}>
          <h3>Researcher → writer split</h3>
          <p>
            One agent only searches and hands over passages. A second agent writes the reply from those passages alone, with no
            tools, and tags every sentence with the passages behind it. Code then checks each citation against what was actually
            handed over. An uncited claim, an invented passage id or a writer that says the docs don&apos;t cover it sends the
            ticket to a human. It targets hallucination directly, which is what matters most for anything customer-facing.
          </p>
        </div>
      </div>

      <div className={styles.evalKpis}>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Unsupported claims per reply</span>
          <span
            className={styles.evalValue}
            style={{ color: g.split.all.unsupportedPerReply < g.single.all.unsupportedPerReply ? "var(--resolve)" : "var(--escalate)" }}
          >
            {g.split.all.unsupportedPerReply.toFixed(2)}
          </span>
          <span className={styles.evalWas}>single agent {g.single.all.unsupportedPerReply.toFixed(2)}</span>
          <span className={styles.evalRange}>
            paired 95% CI {signed(ud.ci[0], 2)} to {signed(ud.ci[1], 2)}
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Replies with any unsupported claim</span>
          <span className={styles.evalValue}>{pct(g.split.all.repliesWithUnsupported, 0)}</span>
          <span className={styles.evalWas}>single agent {pct(g.single.all.repliesWithUnsupported, 0)}</span>
          <span className={styles.evalRange}>
            judged {g.split.all.judged} vs {g.single.all.judged} replies
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Must-escalate recall</span>
          <span className={styles.evalValue}>{pct(split.recall)}</span>
          <span className={styles.evalWas}>single agent {pct(single.recall)}</span>
          <span className={styles.evalRange}>
            coverage {pct(split.coverage, 0)} vs {pct(single.coverage, 0)} · core set
          </span>
        </div>
        <div className={styles.evalKpi}>
          <span className={styles.evalLabel}>Cost per ticket</span>
          <span className={styles.evalValue}>${split.costPerTicket.toFixed(4)}</span>
          <span className={styles.evalWas}>single agent ${single.costPerTicket.toFixed(4)}</span>
          <span className={styles.evalRange}>citation check passed on {pct(g.split.citationCheckPass, 0)}</span>
        </div>
      </div>
      <p className={styles.evalFoot}>
        Each reply is broken into atomic claims by <code>{short(m.judge)}</code>, a third model family, and graded only against
        the evidence its writer actually had. The judge was tested first: it flagged {jv.plantedCaught} of {jv.planted} planted
        fabrications and accepted {jv.verbatimAccepted} of {jv.verbatim} sentences copied straight from the docs.
      </p>

      {/* ── Guardrails ── */}
      <h3 className={styles.h3} style={{ marginTop: "var(--space-16)" }}>
        Guardrails, and where each one lives
      </h3>
      <div className={styles.eng} style={{ marginTop: "var(--space-6)" }}>
        {GUARDRAILS.map((x) => (
          <div className={styles.engCard} key={x.k}>
            <span className={styles.engKey}>{x.k}</span>
            <h3 className={styles.engTitle}>{x.t}</h3>
            <p className={styles.cardBody}>{x.b}</p>
            <span className={styles.engWhere}>{x.w}</span>
          </div>
        ))}
      </div>

      <div className={styles.method}>
        <h4>Methodology</h4>
        <ul className={styles.methodList}>
          <li>
            <b>Checker:</b>{" "}scored on the main evaluation&apos;s recorded runs. It needs only the ticket and the proposed route, so
            the router&apos;s outputs are reused unchanged and every difference between arms is the checker&apos;s.
          </li>
          <li>
            <b>Split:</b> single agent and split pipeline run fresh on the same {tickets} + 12 hard tickets × {split.seeds} seeds,
            same router model, same doc index. Differences are paired by ticket and seed, with intervals that resample tickets.
          </li>
          {pr && (
            <li>
              <b>Red team:</b> {pr.probes} prompt-injection probes, each needing a human and each trying to steer the system (fake
              approvals, fake system messages, fence breaks, smuggled links). Escalated with nothing leaked: single agent{" "}
              {pr.pass.single}/{pr.probes}, with checker {pr.pass.singleWithChecker}/{pr.probes}; split {pr.pass.split}/{pr.probes},
              with checker {pr.pass.splitWithChecker}/{pr.probes}. Canary strings found in any draft: {pr.pass.canaryLeaks}.
            </li>
          )}
          <li>
            <b>Caveats:</b> {tickets}{" "}core tickets is small and one labeler wrote the labels. The judge is an LLM, validated but
            not perfect. The writer call has a capped reasoning budget the single agent doesn&apos;t. Total spend for this section:
            ${m.spend.total.toFixed(2)}. Full tables in <code>docs/MULTI_AGENT.md</code>.
          </li>
        </ul>
      </div>
    </>
  );
}
