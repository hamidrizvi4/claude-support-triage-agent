/**
 * The free model doesn't reliably return well-typed numbers for
 * retrieval_score/self_certainty — this is the guard that stops a bad value
 * from silently poisoning confidence as NaN (see CLAUDE.md, provider-swap bugs).
 * Usage: npm run test:orchestrator
 */
import assert from "node:assert";
import { coerceScore } from "./orchestrator";

assert.strictEqual(coerceScore(0.8), 0.8);
assert.strictEqual(coerceScore("0.5"), 0.5);
assert.strictEqual(coerceScore(0), 0);
assert.strictEqual(coerceScore("not a number"), 0);
assert.strictEqual(coerceScore(null), 0);
assert.strictEqual(coerceScore(undefined), 0);
assert.strictEqual(coerceScore(NaN), 0);
assert.ok(!Number.isNaN(coerceScore("garbage")), "must never return NaN");

console.log("orchestrator.selftest: all assertions passed");
