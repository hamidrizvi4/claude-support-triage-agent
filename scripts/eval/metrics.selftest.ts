/**
 * Eval-math self-test, checked against hand-computed values.
 * Usage: npm run test:eval
 */
import assert from "node:assert";
import {
  clusterBootstrap,
  prng,
  aurc,
  autoResolvePrecision,
  confusion,
  coverage,
  escalationRecall,
  fisherExact,
  macroF1,
  optimalAurc,
  quantile,
  riskCoverage,
  routeCounts,
  wilson,
} from "./metrics";

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Wilson: 20/40 -> [0.352, 0.648], 3/40 -> [0.026, 0.199] (checked by hand)
near(wilson(20, 40)[0], 0.352);
near(wilson(20, 40)[1], 0.648);
near(wilson(3, 40)[0], 0.026);
near(wilson(3, 40)[1], 0.199);

// Fisher: 20/40 vs 3/40 incomplete -> p ~ 4.3e-5; 8/40 vs 15/40 -> p ~ 0.137
near(fisherExact(20, 20, 3, 37), 4.3e-5, 1e-5);
near(fisherExact(8, 32, 15, 25), 0.1374);
near(fisherExact(5, 5, 5, 5), 1);

// Confusion + macro-F1
const c = confusion(
  [
    { gold: "a", pred: "a" },
    { gold: "a", pred: "b" },
    { gold: "b", pred: "b" },
    { gold: "b", pred: "b" },
  ],
  ["a", "b"]
);
assert.deepStrictEqual(c.matrix, [
  [1, 1],
  [0, 2],
]);
const f = macroF1(c);
near(f.perClass.a.f1, 2 / 3); // p=1, r=0.5
near(f.perClass.b.f1, 0.8); // p=2/3, r=1
near(f.macro, (2 / 3 + 0.8) / 2);
assert.throws(() => confusion([{ gold: "x", pred: "a" }], ["a"]));

// Routing counts: 3 must-escalate (1 missed), 2 answerable (1 handed off needlessly)
const rc = routeCounts([
  { goldEscalate: true, predEscalate: true },
  { goldEscalate: true, predEscalate: true },
  { goldEscalate: true, predEscalate: false },
  { goldEscalate: false, predEscalate: true },
  { goldEscalate: false, predEscalate: false },
]);
assert.deepStrictEqual(rc, { tp: 2, fp: 1, fn: 1, tn: 1 });
near(escalationRecall(rc), 2 / 3);
near(autoResolvePrecision(rc), 0.5);
near(coverage(rc), 0.4);

// Risk-coverage: scores .9 (ok) .8 (error) .7 (ok), 5 tickets in the set
const cand = [
  { score: 0.9, error: false },
  { score: 0.8, error: true },
  { score: 0.7, error: false },
];
const pts = riskCoverage(cand, 5);
assert.deepStrictEqual(
  pts.map((p) => [p.coverage, p.risk]),
  [
    [0.2, 0],
    [0.4, 0.5],
    [0.6, 1 / 3],
  ]
);
// AURC = mean(0, 1/2, 1/3); perfect ranking = mean(0, 0, 1/3)
near(aurc(cand), (0 + 0.5 + 1 / 3) / 3);
near(optimalAurc(cand), (0 + 0 + 1 / 3) / 3);
// ties are scored pessimistically: identical scores can't hide an error
near(aurc([{ score: 1, error: false }, { score: 1, error: true }]), (1 + 0.5) / 2);

near(quantile([1, 2, 3, 4, 5], 0.5), 3);
near(quantile([0, 10], 0.1), 1);

// Cluster bootstrap: deterministic, brackets the point estimate, and is wider
// than a Wilson interval that wrongly treats 3 identical runs per ticket as 3 trials.
{
  const clusters = Array.from({ length: 20 }, (_, i) => [0, 1, 2].map(() => (i < 15 ? 1 : 0)));
  const mean = (cs: number[][]) => cs.flat().reduce((a, b) => a + b, 0) / cs.flat().length;
  const a = clusterBootstrap(clusters, mean, 2000, 7);
  const b = clusterBootstrap(clusters, mean, 2000, 7);
  assert.deepStrictEqual(a, b);
  assert.ok(a[0] < 0.75 && a[1] > 0.75);
  const w = wilson(45, 60);
  assert.ok(a[1] - a[0] > w[1] - w[0], "clustered interval should be wider than pooled Wilson");
  near(prng(1)(), prng(1)());
}

console.log("metrics.selftest: all assertions passed");
