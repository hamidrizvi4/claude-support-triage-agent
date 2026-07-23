/**
 * Smallest possible check that fails if the routing logic breaks.
 * Usage: npm run test:routing
 */
import assert from "node:assert";
import { computeConfidence, route, CONFIDENCE_THRESHOLD } from "./routing";

// confidence formula: 0.6 * retrieval + 0.4 * certainty
assert.strictEqual(computeConfidence(1, 1), 1);
assert.strictEqual(computeConfidence(0, 0), 0);
assert.strictEqual(computeConfidence(0.5, 0.5), 0.5);
assert.strictEqual(computeConfidence(1, 0), 0.6);
assert.strictEqual(computeConfidence(0, 1), 0.4);

// category override wins even at max confidence
for (const category of ["billing", "security_abuse", "sales_enterprise", "bug_report"]) {
  const r = route(category, 1, 1);
  assert.strictEqual(r.status, "escalated", `${category} should escalate`);
  assert.strictEqual(r.reason, `category:${category}`);
}

// non-override category, high confidence -> auto_resolve, no reason
const highConfidence = route("feature_question", 0.9, 0.9);
assert.strictEqual(highConfidence.status, "auto_resolved");
assert.strictEqual(highConfidence.reason, null);

// non-override category, low confidence -> escalate, low_confidence
const lowConfidence = route("technical_api_error", 0.3, 0.3);
assert.strictEqual(lowConfidence.status, "escalated");
assert.strictEqual(lowConfidence.reason, "low_confidence");

// boundary: exactly the threshold auto-resolves (>=, not >)
const boundary = route("account_access", CONFIDENCE_THRESHOLD, CONFIDENCE_THRESHOLD);
assert.strictEqual(computeConfidence(CONFIDENCE_THRESHOLD, CONFIDENCE_THRESHOLD), CONFIDENCE_THRESHOLD);
assert.strictEqual(boundary.status, "auto_resolved");

console.log("routing.selftest: all assertions passed");
