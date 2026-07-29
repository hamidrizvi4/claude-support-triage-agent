/**
 * classifyOutcome has already caused two real dashboard-corrupting bugs
 * (see CLAUDE.md). parseCitations is the one guard between model-generated
 * JSON and a rendered <a href>. Both get a check.
 * Usage: npm run test:classify
 */
import assert from "node:assert";
import { classifyOutcome, parseCitations } from "./classify";

// classifyOutcome — order matters: 429 is checked before agent_error: prefix,
// since a rate-limit failure is also reported as an agent_error string.
assert.strictEqual(classifyOutcome(null), "resolved");
assert.strictEqual(classifyOutcome(""), "resolved");
assert.strictEqual(classifyOutcome("category:billing"), "escalated");
assert.strictEqual(classifyOutcome("low_confidence"), "escalated");
assert.strictEqual(classifyOutcome("some other reason"), "escalated");
assert.strictEqual(classifyOutcome("agent_error: 429 Too Many Requests"), "rate_limited");
assert.strictEqual(classifyOutcome("Rate limit exceeded"), "rate_limited");
assert.strictEqual(
  classifyOutcome("agent_error: did not call submit_resolution within 8 turns"),
  "incomplete"
);

// parseCitations — malformed / non-array input never throws, just yields [].
assert.deepStrictEqual(parseCitations(null), []);
assert.deepStrictEqual(parseCitations("not an array"), []);
assert.deepStrictEqual(parseCitations([1, "x", null]), []);

// valid entry passes through; missing title falls back to source_url.
assert.deepStrictEqual(
  parseCitations([{ source_url: "https://docs.claude.com/pricing", title: "Pricing" }]),
  [{ source_url: "https://docs.claude.com/pricing", title: "Pricing" }]
);
assert.deepStrictEqual(
  parseCitations([{ source_url: "https://docs.claude.com/pricing" }]),
  [{ source_url: "https://docs.claude.com/pricing", title: "https://docs.claude.com/pricing" }]
);

// plain http is still allowed...
assert.strictEqual(parseCitations([{ source_url: "http://docs.claude.com" }]).length, 1);

// ...but a javascript:/data: URI must never survive to become an <a href>.
assert.deepStrictEqual(parseCitations([{ source_url: "javascript:alert(1)" }]), []);
assert.deepStrictEqual(
  parseCitations([{ source_url: "data:text/html,<script>alert(1)</script>" }]),
  []
);
assert.deepStrictEqual(parseCitations([{ source_url: 123 }]), []);

console.log("classify.selftest: all assertions passed");
