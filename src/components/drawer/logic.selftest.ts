/**
 * Smallest check that fails if the drawer's two pieces of real logic break.
 * Usage: npx tsx src/components/drawer/logic.selftest.ts
 */
import assert from "node:assert";
import { matchCitation, confidenceSegments } from "./logic";
import type { Citation } from "@/lib/data/types";

const cites: Citation[] = [
  {
    title: "Define tools",
    source_url: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools",
  },
  { title: "Pricing", source_url: "https://platform.claude.com/docs/en/about-claude/pricing" },
];

// Real case: the draft links the page with a fragment appended.
assert.strictEqual(
  matchCitation(
    "https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#specifying-client-tools",
    cites
  )?.title,
  "Define tools"
);
// Exact match still resolves.
assert.strictEqual(
  matchCitation("https://platform.claude.com/docs/en/about-claude/pricing", cites)?.title,
  "Pricing"
);
// An unrelated link must NOT be dressed up as a cited source.
assert.strictEqual(matchCitation("https://example.com/blog", cites), undefined);

// The two segments must sum to exactly confidence — otherwise the bar lies
// about why the ticket routed the way it did.
for (const [r, c] of [
  [0.92, 0.95],
  [0.35, 0.6],
  [0, 0],
  [1, 1],
]) {
  const { retrievalPct, certaintyPct } = confidenceSegments(r, c);
  const confidence = 0.6 * r + 0.4 * c;
  assert.ok(
    Math.abs(retrievalPct + certaintyPct - confidence * 100) < 1e-9,
    `segments must sum to confidence for r=${r} c=${c}`
  );
}

assert.strictEqual(confidenceSegments(0, 0).thresholdPct, 80);

console.log("drawer/logic.selftest: all assertions passed");
