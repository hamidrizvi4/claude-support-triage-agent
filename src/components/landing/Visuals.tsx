/**
 * Static (server-rendered) visuals for the intro page: CSS/SVG-animated
 * cards and diagrams. Everything loops on its own, with no JS, and holds
 * still under prefers-reduced-motion.
 */
import styles from "./landing.module.css";

function Check() {
  return (
    <span className={styles.check} aria-hidden="true">
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
        <path d="M2 5.2 4.1 7.2 8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function SearchCard() {
  const chunks = [
    { url: "docs.claude.com/en/api/rate-limits", text: "Response headers · retry-after on 429s", sim: "0.81" },
    { url: "docs.claude.com/en/api/errors", text: "HTTP errors · 429 rate_limit_error", sim: "0.77" },
    { url: "support.claude.com/…/rate-limits-faq", text: "Why am I being rate limited?", sim: "0.69" },
  ];
  return (
    <div className={`${styles.card} ${styles.cardPad}`}>
      <span className={styles.callChip}>
        search_docs(&quot;<span className={styles.typed}>429 retry-after header</span>&quot;)
      </span>
      <div className={styles.found}>pgvector · cosine similarity · top_k 5 (illustrative)</div>
      {chunks.map((c) => (
        <div className={styles.chunk} key={c.url}>
          <Check />
          <div style={{ minWidth: 0 }}>
            <div className={styles.chunkUrl}>{c.url}</div>
            <div className={styles.chunkText}>{c.text}</div>
          </div>
          <span className={styles.sim}>{c.sim}</span>
        </div>
      ))}
    </div>
  );
}

/** Converging tool lines into the agent node, one output line to the resolution. */
export function ToolsDiagram() {
  const tools = [
    { name: "search_docs", sub: "pgvector · public docs", y: 40, kind: "live" },
    { name: "check_status", sub: "live status page", y: 110, kind: "live" },
    { name: "check_pricing", sub: "grounded docs", y: 180, kind: "live" },
    { name: "lookup_account", sub: "mocked accounts", y: 250, kind: "mock" },
  ];
  const agent = { x: 346, y: 145 };
  return (
    <div className={styles.card}>
      <svg viewBox="0 0 560 290" className={styles.diagram} role="img" aria-label="Four tools feed the agent, which emits one submit_resolution call.">
        {tools.map((t, i) => {
          const d = `M 184 ${t.y} C 260 ${t.y}, 262 ${agent.y}, ${agent.x - 26} ${agent.y}`;
          return (
            <g key={t.name}>
              <path id={`tool-path-${i}`} d={d} className={styles.dLine} />
              <circle r="3" className={`${styles.flowDot} ${t.kind === "mock" ? styles.dDot : styles.dDotLive}`}>
                <animateMotion dur={`${2.4 + i * 0.35}s`} repeatCount="indefinite" begin={`${i * 0.5}s`}>
                  <mpath href={`#tool-path-${i}`} />
                </animateMotion>
              </circle>
              <rect x="8" y={t.y - 20} width="176" height="40" rx="8" className={styles.dNode} />
              <text x="26" y={t.y - 3} className={styles.dLabel}>
                {t.name}
              </text>
              <text x="26" y={t.y + 11} className={t.kind === "mock" ? styles.dSubMock : styles.dSubLive}>
                {t.sub}
              </text>
            </g>
          );
        })}
        <path d={`M ${agent.x + 26} ${agent.y} L 436 ${agent.y}`} className={styles.dLineOut} />
        <path d={`M ${agent.x + 26} ${agent.y} L 436 ${agent.y}`} className={styles.dFlow} />
        <rect x={agent.x - 26} y={agent.y - 26} width="52" height="52" rx="12" className={styles.dNodeDark} />
        <path
          d={`M ${agent.x} ${agent.y - 13} l 11 6.5 v 13 l -11 6.5 l -11 -6.5 v -13 z`}
          fill="none"
          stroke="var(--resolve-tint)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx={agent.x} cy={agent.y} r="3.5" fill="var(--resolve-tint)" />
        <text x={agent.x} y={agent.y + 46} textAnchor="middle" className={styles.dSub}>
          agent · ≤ 8 turns
        </text>
        <rect x="436" y={agent.y - 20} width="116" height="40" rx="8" className={styles.dNode} />
        <text x="448" y={agent.y - 3} className={styles.dLabel}>
          submit_
        </text>
        <text x="448" y={agent.y + 11} className={styles.dLabel}>
          resolution
        </text>
      </svg>
    </div>
  );
}

export function ResolutionCard() {
  return (
    <div className={styles.card}>
      <div className={styles.payloadHead}>
        <span>submit_resolution · arguments</span>
        <span>forced on the final turn</span>
      </div>
      <pre className={styles.code}>
        {"{\n  "}
        <span className={styles.k}>&quot;category&quot;</span>
        {": "}
        <span className={styles.hl}>&quot;billing&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;draft_response&quot;</span>
        {": "}
        <span className={styles.s}>&quot;Thanks for flagging the batch loop…&quot;</span>
        {",\n  "}
        <span className={styles.k}>&quot;citations&quot;</span>
        {": [{ "}
        <span className={styles.k}>&quot;source_url&quot;</span>
        {": "}
        <span className={styles.s}>&quot;…/messages-batches&quot;</span>
        {" }],\n  "}
        <span className={styles.k}>&quot;retrieval_score&quot;</span>
        {": "}
        <span className={styles.n}>&quot;0.6&quot;</span>
        {"    "}
        <span className={styles.cm}>{"← coerced to 0.6"}</span>
        {",\n  "}
        <span className={styles.k}>&quot;self_certainty&quot;</span>
        {": "}
        <span className={styles.n}>0.7</span>
        {",\n  "}
        <span className={styles.k}>&quot;escalation_reason&quot;</span>
        {": "}
        <span className={styles.n}>null</span>
        {"     "}
        <span className={styles.cm}>{"← router decides"}</span>
        {"\n}"}
      </pre>
    </div>
  );
}

export function TraceCard() {
  const lines = [
    { t: "01", tool: "search_docs", out: '{ query: "batch job duplicate charges" }' },
    { t: "02", tool: "lookup_account", out: "{ plan_tier, monthly_usage, rate_limit }" },
    { t: "03", tool: "check_pricing", out: '{ model: "claude-…" }' },
    { t: "04", tool: "search_docs", out: '{ query: "refund policy usage charges" }' },
    { t: "05", tool: "submit_resolution", out: "category: billing → escalated", final: true },
  ];
  return (
    <div className={styles.card}>
      <div className={styles.payloadHead}>
        <span>tool_calls · ticket 18</span>
        <span>reasoning trace</span>
      </div>
      <div className={styles.log}>
        {lines.map((l, i) => (
          <div
            key={i}
            className={`${styles.logLine} ${l.final ? styles.logFinal : ""}`}
            style={{ animationDelay: `${i * 0.45}s` }}
          >
            <span className={styles.logTime}>{l.t}</span>
            <span className={styles.logTool}>{l.tool}</span>
            <span className={styles.logOut}>{l.out}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Full system: ingestion lane, agent lane, audit/review lane. */
export function ArchitectureDiagram() {
  return (
    <svg
      viewBox="0 0 1100 470"
      className={styles.arch}
      role="img"
      aria-label="Architecture: public docs are chunked, embedded and stored in pgvector. A ticket enters the agent orchestrator, which calls four tools and submits a resolution. A rules-based routing engine sends it to auto-resolve or the human review queue. Every tool call is logged and reviews feed the dashboard."
    >
      {/* lane labels */}
      <text x="0" y="28" className={styles.aLane}>INGEST · ONE-OFF</text>
      <text x="0" y="178" className={styles.aLane}>AGENT · PER TICKET</text>
      <text x="0" y="388" className={styles.aLane}>AUDIT + REVIEW</text>
      <line x1="0" x2="1100" y1="150" y2="150" className={styles.planeGrid} />
      <line x1="0" x2="1100" y1="360" y2="360" className={styles.planeGrid} />

      {/* Ingest lane */}
      <rect x="0" y="44" width="170" height="38" rx="8" className={styles.aBox} />
      <text x="14" y="68" className={styles.aS}>docs.claude.com</text>
      <rect x="0" y="92" width="170" height="38" rx="8" className={styles.aBox} />
      <text x="14" y="116" className={styles.aS}>support.claude.com</text>
      <path d="M 170 63 C 210 63, 210 87, 240 87" className={styles.aEdge} />
      <path d="M 170 111 C 210 111, 210 87, 240 87" className={styles.aEdge} />
      <rect x="240" y="60" width="210" height="54" rx="10" className={styles.aBox} />
      <text x="256" y="83" className={styles.aT}>Chunk + embed</text>
      <text x="256" y="100" className={styles.aS}>375-word chunks · 2048-d</text>
      <path d="M 450 87 L 520 87" className={styles.aEdgeFlow} />
      <rect x="520" y="56" width="200" height="62" rx="10" className={styles.aBoxStore} />
      <text x="536" y="81" className={styles.aT}>doc_chunks</text>
      <text x="536" y="98" className={styles.aS}>pgvector · RLS deny-all</text>

      {/* Agent lane */}
      <rect x="0" y="232" width="130" height="50" rx="10" className={styles.aBox} />
      <text x="16" y="254" className={styles.aT}>Ticket</text>
      <text x="16" y="270" className={styles.aS}>subject · body</text>
      <path d="M 130 257 L 200 257" className={styles.aEdgeFlow} />
      <rect x="200" y="222" width="190" height="70" rx="12" className={styles.aBoxKey} />
      <text x="218" y="250" className={styles.aTInv}>Orchestrator</text>
      <text x="218" y="268" className={styles.aSInv}>tool loop · ≤ 8 turns</text>
      <text x="218" y="281" className={styles.aSInv}>forced final call</text>

      {/* tools fan */}
      <rect x="430" y="176" width="176" height="32" rx="7" className={styles.aBox} />
      <text x="444" y="196" className={styles.aS}>search_docs</text>
      <rect x="430" y="214" width="176" height="32" rx="7" className={styles.aBox} />
      <text x="444" y="234" className={styles.aS}>check_status · live</text>
      <rect x="430" y="252" width="176" height="32" rx="7" className={styles.aBox} />
      <text x="444" y="272" className={styles.aS}>check_pricing</text>
      <rect x="430" y="290" width="176" height="32" rx="7" className={styles.aBox} />
      <text x="444" y="310" className={styles.aS}>lookup_account · mock</text>
      <path d="M 390 245 C 410 245, 410 192, 430 192" className={styles.aEdge} />
      <path d="M 390 250 C 410 250, 410 230, 430 230" className={styles.aEdge} />
      <path d="M 390 262 C 410 262, 410 268, 430 268" className={styles.aEdge} />
      <path d="M 390 268 C 410 268, 410 306, 430 306" className={styles.aEdge} />
      {/* search_docs ↔ pgvector */}
      <path d="M 606 192 C 630 192, 620 118, 620 118" className={styles.aEdgeAudit} />

      {/* resolution → router */}
      <path d="M 606 250 L 650 250" className={styles.aEdge} />
      <rect x="650" y="222" width="176" height="56" rx="10" className={styles.aBox} />
      <text x="666" y="245" className={styles.aT}>submit_resolution</text>
      <text x="666" y="262" className={styles.aS}>category · scores · cites</text>
      <path d="M 826 250 L 862 250" className={styles.aEdgeFlow} />
      <rect x="862" y="216" width="104" height="68" rx="12" className={styles.aBoxKey} />
      <text x="878" y="244" className={styles.aTInv}>Router</text>
      <text x="878" y="261" className={styles.aSInv}>pure fn</text>
      <text x="878" y="274" className={styles.aSInv}>route()</text>
      <path d="M 966 238 C 988 238, 985 196, 1000 196" className={styles.aEdge} />
      <path d="M 966 262 C 988 262, 985 304, 1000 304" className={styles.aEdge} />
      <rect x="1000" y="178" width="100" height="36" rx="8" className={styles.aBoxResolve} />
      <text x="1012" y="200" className={styles.aS} style={{ fill: "var(--resolve)" }}>auto-resolve</text>
      <rect x="1000" y="286" width="100" height="36" rx="8" className={styles.aBoxEscalate} />
      <text x="1012" y="308" className={styles.aS} style={{ fill: "var(--escalate)" }}>review queue</text>

      {/* Audit lane */}
      <path d="M 295 292 L 295 400" className={styles.aEdgeAudit} />
      <rect x="200" y="400" width="190" height="50" rx="10" className={styles.aBoxStore} />
      <text x="216" y="422" className={styles.aT}>tool_calls</text>
      <text x="216" y="438" className={styles.aS}>every call, incl. final</text>
      <path d="M 1050 322 L 1050 400" className={styles.aEdgeAudit} />
      <rect x="930" y="400" width="170" height="50" rx="10" className={styles.aBoxStore} />
      <text x="946" y="422" className={styles.aT}>reviews</text>
      <text x="946" y="438" className={styles.aS}>approve/edit/reject</text>
      <path d="M 390 425 L 550 425" className={styles.aEdgeAudit} />
      <path d="M 930 425 L 780 425" className={styles.aEdgeAudit} />
      <rect x="550" y="396" width="230" height="58" rx="10" className={styles.aBox} />
      <text x="566" y="420" className={styles.aT}>Dashboard</text>
      <text x="566" y="437" className={styles.aS}>rates · doc gaps · overturns</text>
    </svg>
  );
}
