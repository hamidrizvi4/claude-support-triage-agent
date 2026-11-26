/**
 * Safety-net self-test. Phrases are written for this file, not copied from the
 * eval set, so the eval stays an honest measurement of the net.
 * Usage: npm run test:safety-net
 */
import assert from "node:assert";
import { safetyNet } from "./safetyNet";
import { cosineRetrievalScore, routeTicket } from "./routing";

const hits: [string, string][] = [
  ["Our key got leaked in a screenshot", "security_abuse"],
  ["I think our API key was compromised last night", "security_abuse"],
  ["Someone is using the API to write phishing emails", "security_abuse"],
  ["Found a prompt injection that gets past your safety filter", "security_abuse"],
  ["We were charged two times for one top-up", "billing"],
  ["I'd like a refund for last month", "billing"],
  ["Looks like we got double-billed in March", "billing"],
  ["Card declined and now the account is past due", "billing"],
  ["Can we talk to sales about an enterprise agreement?", "sales_enterprise"],
  ["Our procurement team needs a signed DPA", "sales_enterprise"],
  ["Do you sign a BAA for HIPAA workloads?", "sales_enterprise"],
];
for (const [text, category] of hits) {
  assert.strictEqual(safetyNet(text)?.category, category, `expected ${category}: "${text}"`);
}

const misses = [
  "How are cache reads billed compared with normal input tokens?",
  "What does the pricing page say about batch discounts?",
  "How should I store an API key so it doesn't leak into logs?",
  "Streaming stops early with stop_reason max_tokens",
  "What's the difference between tool_choice any and auto?",
  "Is there a security best-practices page for the Console?",
];
for (const text of misses) {
  assert.strictEqual(safetyNet(text), null, `expected no hit: "${text}" (got ${JSON.stringify(safetyNet(text))})`);
}

// security outranks billing when both appear
assert.strictEqual(safetyNet("Our leaked key ran up an unexpected charge")?.category, "security_abuse");

// routeTicket: model's category rule first, then the net, then confidence
const t = (category: string, text: string, r = 0.95, c = 0.95, useSafetyNet = true) =>
  routeTicket({ category, retrievalScore: r, selfCertainty: c, text, useSafetyNet });
assert.strictEqual(t("billing", "anything").reason, "category:billing");
assert.strictEqual(t("feature_question", "please refund the duplicate charge").reason, "safety_net:billing");
assert.strictEqual(t("feature_question", "please refund the duplicate charge", 0.95, 0.95, false).status, "auto_resolved");
assert.strictEqual(t("feature_question", "how does tool_choice work?").status, "auto_resolved");
assert.strictEqual(t("feature_question", "how does tool_choice work?", 0.2, 0.9).reason, "low_confidence");
// the net never lowers a decision: an escalated ticket stays escalated
assert.strictEqual(t("technical_api_error", "refund please", 0.1, 0.1).status, "escalated");

// cosine retrieval score: best similarity, rescaled and clamped to [0, 1]
assert.strictEqual(cosineRetrievalScore([]), 0);
assert.strictEqual(cosineRetrievalScore([0.1, 0.2], 0.3, 0.7), 0);
assert.strictEqual(cosineRetrievalScore([0.9], 0.3, 0.7), 1);
assert.ok(Math.abs(cosineRetrievalScore([0.2, 0.5, NaN], 0.3, 0.7) - 0.5) < 1e-9);

console.log("safetyNet.selftest: all assertions passed");
