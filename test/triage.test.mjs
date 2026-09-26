import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAnswers, rank } from "../src/triage.mjs";

const group = (id, count = 1, order = 0) => ({ id, count, order });
const answers = (id, { cause = "transient-network-or-timeout", confidence = 0.9, retry = 0.9, score = 1.2 } = {}) => ({
  [`${id}_cause`]: { type: "choice", choice: cause, probabilities: { [cause]: 0.9, other: 0.1 }, confidence },
  [`${id}_retry`]: { type: "noul", noul: retry },
  [`${id}_urgency`]: { type: "score", score, probabilities: { 1: 0.8, 2: 0.2 }, confidence: 0.6 },
});
const decide = (options, threshold = 0.8) => applyAnswers(group("g01"), answers("g01", options), threshold);

test("decides retry, fix first or review from answers at, above and below the threshold", () => {
  assert.equal(decide({ retry: 0.81 }).decision, "retry");
  assert.equal(decide({ retry: 0.8, confidence: 0.8 }).decision, "retry", "at the threshold");
  assert.equal(decide({ cause: "rate-limited", retry: 0.95 }).decision, "retry");
  assert.equal(decide({ retry: 0.2 }).decision, "fix-first", "at 1 minus the threshold");
  assert.equal(decide({ cause: "code-error", retry: 0.03 }).decision, "fix-first");
  assert.equal(decide({ cause: "transient-network-or-timeout", retry: 0.05 }).decision, "fix-first", "temporary, but a rerun could repeat a payment");

  const unsure = decide({ retry: 0.64 });
  assert.equal(unsure.decision, "review");
  assert.deepEqual(unsure.reviewReasons, ["safe to run again 0.64, between 0.20 and 0.80"]);
  const lowCause = decide({ confidence: 0.79, retry: 0.1 });
  assert.deepEqual([lowCause.decision, lowCause.reviewReasons], ["review", ["cause confidence 0.79, below 0.80"]]);
  assert.equal(decide({ retry: 0.64 }, 0.6).decision, "retry", "a lower threshold");
  assert.equal(decide({ retry: 0.97 }, 0.98).decision, "review", "a higher threshold");

  const decided = decide({ score: 2.6 });
  assert.deepEqual([decided.urgency.level, decided.urgency.label, decided.retry], [3, "now", 0.9]);
  assert.equal(decided.cause.probabilities.other, 0.1, "probabilities are kept for the report");
});

test("sends a group with a missing, malformed or disagreeing answer to review", () => {
  assert.deepEqual(applyAnswers(group("g02"), {}, 0.8).reviewReasons, [
    "no cause answer from Jev",
    "no safe-to-run-again answer from Jev",
    "no urgency answer from Jev",
  ]);
  assert.equal(applyAnswers(group("g02"), undefined, 0.8).decision, "review");
  const odd = {
    g02_cause: { type: "choice", choice: "cosmic-rays", probabilities: {}, confidence: 1 },
    g02_retry: { type: "noul", noul: 1.7 },
    g02_urgency: { type: "score", score: "high", confidence: 1 },
  };
  const result = applyAnswers(group("g02"), odd, 0.8);
  assert.deepEqual([result.decision, result.cause, result.retry, result.urgency], ["review", null, null, null]);

  const disagree = decide({ cause: "code-error", retry: 0.9 });
  assert.equal(disagree.decision, "review");
  assert.deepEqual(disagree.reviewReasons, ["Jev says safe to run again (0.90) but the cause is code-error"]);
  assert.equal(decide({ cause: "other", retry: 0.95 }).decision, "review", "only a temporary cause can be retried");
});

test("ranks by urgency score, then by count, then by first appearance, with unanswered groups last", () => {
  const scored = (id, score, count, order) => ({ ...group(id, count, order), urgency: { score } });
  const ranked = rank([scored("a", 1.2, 5, 1), scored("b", 2.9, 1, 2), scored("c", 1.2, 9, 3), group("d", 50, 4), scored("e", 1.2, 9, 0)]);
  assert.deepEqual(
    ranked.map((g) => g.id),
    ["b", "e", "c", "a", "d"],
  );
});
