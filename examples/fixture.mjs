// Serves the hand-written answers in answers.json in place of Jev, so the example and the tests run without a key
// and without a network. The responses have the shape of TypeSafe's API; the numbers are not from a live call.
import { readFileSync } from "node:fs";
import { fixtureFetch } from "../src/jev.mjs";
import { run } from "../src/main.mjs";
import { CAUSES, URGENCY, estimateTokens } from "../src/questions.mjs";

export const ANSWERS = JSON.parse(readFileSync(new URL("./answers.json", import.meta.url), "utf8")).answers;

const round = (n) => Math.round(n * 100) / 100;

/** Confidence from a distribution, (n * largest - 1) / (n - 1), which matches TypeSafe's documented examples. */
export function confidenceOf(probabilities) {
  const values = Object.values(probabilities);
  return Math.max(0, Math.min(1, (values.length * Math.max(...values) - 1) / (values.length - 1)));
}

/** The three answers for one group in the API's shape, from the probabilities in answers.json. */
export function answersFrom(fixture) {
  const cause = Object.fromEntries(Object.keys(CAUSES).map((option) => [option, fixture.cause[option] ?? 0]));
  const levels = Object.fromEntries(URGENCY.map((_, i) => [String(i), fixture.urgency[String(i)] ?? 0]));
  const choice = Object.entries(cause).sort((a, b) => b[1] - a[1])[0][0];
  return {
    cause: { type: "choice", choice, probabilities: cause, confidence: round(confidenceOf(cause)) },
    retry: { type: "noul", noul: fixture.retry },
    urgency: {
      type: "score",
      score: round(Object.entries(levels).reduce((sum, [level, p]) => sum + Number(level) * p, 0)),
      legend: Object.fromEntries(URGENCY.map((text, i) => [String(i), text])),
      probabilities: levels,
      confidence: round(confidenceOf(levels)),
    },
  };
}

/** Answers one request body: every group whose hook is in answers.json gets its three answers. */
export function exampleResponder(body) {
  const answers = {};
  for (const [id, group] of Object.entries(body.state.groups)) {
    const fixture = ANSWERS.find((entry) => entry.hook === group.hook);
    if (!fixture) continue;
    const { cause, retry, urgency } = answersFrom(fixture);
    answers[`${id}_cause`] = cause;
    answers[`${id}_retry`] = retry;
    answers[`${id}_urgency`] = urgency;
  }
  const inputTokens = estimateTokens(body.state) + estimateTokens(body.questions);
  return { model: "fixture", answers, usage: { input_tokens: inputTokens, output_tokens: 0 } };
}

/** A fetch stand-in that answers from answers.json and records every request it receives. */
export function exampleFetch() {
  return fixtureFetch(exampleResponder);
}

export const INPUTS = ["examples/failed-actions.json", "examples/past-due-actions.json"];

/** The example outputs in this folder and the options that produce each one. */
export const OUTPUTS = {
  "report.txt": [],
  "report.json": ["--json"],
  "dry-run.txt": ["--dry-run"],
};

/** Runs the command in-process on the example exports with the fixture and returns what it printed. */
export async function exampleOutput(args) {
  let out = "";
  let err = "";
  const code = await run([...INPUTS, ...args], {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    env: { TYPESAFE_API_KEY: "example-only" },
    fetchImpl: exampleFetch().fetchImpl,
  });
  if (code !== 0) throw new Error(`the example run failed (exit ${code}): ${err}`);
  return out;
}
