import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { groupActions } from "../src/group.mjs";
import { JEV_ENDPOINT, fixtureFetch } from "../src/jev.mjs";
import { BUDGET, CAUSES, RETRY_CRITERIA, URGENCY, estimateTokens, planRequests, questionsFor } from "../src/questions.mjs";
import { readActions } from "../src/read.mjs";
import { KEY_ENV, runCli } from "./helpers/run.mjs";

const SMALL = fileURLToPath(new URL("./fixtures/small.json", import.meta.url));
const SNAPSHOT = new URL("./fixtures/request-body.json", import.meta.url);
const EXAMPLES = ["../examples/failed-actions.json", "../examples/past-due-actions.json"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

test("sends one request whose body matches the snapshot, with the key only in the header and no personal data", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => ({ model: "fixture", answers: {}, usage: { input_tokens: 0 } }));
  const { code } = await runCli([SMALL], { env: KEY_ENV, fetchImpl });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].headers.authorization, "Bearer test-secret-value");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(calls[0].body, JSON.parse(readFileSync(SNAPSHOT, "utf8")));

  const sent = JSON.stringify(calls[0].body);
  for (const secret of ["test-secret-value", "pat@example.com", "lee@example.org", "jo@example.com", "555", "abc123", "public_html", "501", "2026-09-20"]) {
    assert.equal(sent.includes(secret), false, `${secret} must not be sent`);
  }
  assert.equal(Object.keys(calls[0].body.state.groups).length, 3, "the past-due action is not sent");
});

test("asks a seven-way cause, a yes/no on rerunning unchanged and a four-level urgency, with no export text in the questions", () => {
  const questions = questionsFor("g07");
  assert.deepEqual(Object.keys(questions), ["g07_cause", "g07_retry", "g07_urgency"]);
  assert.equal(questions.g07_cause.type, "choice");
  assert.deepEqual(Object.keys(questions.g07_cause.criteria), [
    "transient-network-or-timeout",
    "rate-limited",
    "credentials-or-auth",
    "invalid-data",
    "code-error",
    "missing-plugin-or-callback",
    "other",
  ]);
  assert.equal(questions.g07_cause.criteria, CAUSES);
  assert.equal(questions.g07_retry.type, "noul");
  assert.equal(questions.g07_retry.criteria, RETRY_CRITERIA);
  assert.equal(questions.g07_urgency.type, "score");
  assert.equal(questions.g07_urgency.criteria, URGENCY);
  assert.equal(URGENCY.length, 4);
  for (const question of Object.values(questions)) {
    assert.match(question.instructions, /`groups\.g07`/);
    assert.equal(typeof question.instructions, "string", "instructions are fixed text naming the group's key");
  }
  assert.deepEqual(questionsFor("g08").g08_retry, { ...questions.g07_retry, instructions: questions.g07_retry.instructions.replace("g07", "g08") });
});

test("packs groups into as few requests as the token budget allows", async () => {
  const { actions } = await readActions(EXAMPLES);
  const { failed, stats } = groupActions(actions);
  const ids = failed.map((g) => g.id);

  const one = planRequests(failed, stats.last);
  assert.equal(one.length, 1, "12 groups fit in one request");
  assert.deepEqual(one[0].ids, ids);
  assert.ok(one[0].estimatedTokens < BUDGET.request);

  const budget = { state: 2000, request: 4000 };
  const several = planRequests(failed, stats.last, { budget });
  assert.ok(several.length > 3);
  assert.deepEqual(several.flatMap((r) => r.ids), ids, "every group once, in order");
  for (const request of several) {
    const longest = Math.max(...Object.values(request.questions).map(estimateTokens));
    assert.ok(request.estimatedTokens <= budget.request);
    assert.ok(estimateTokens(request.state) + longest <= budget.state);
    assert.equal(Object.keys(request.questions).length, request.ids.length * 3);
    assert.deepEqual(Object.keys(request.state.groups), request.ids);
  }

  assert.equal(planRequests(failed, stats.last, { maxGroups: 5 }).length, 3, "--batch 5");
  assert.equal(planRequests(failed, stats.last, { budget: { state: 10, request: 10 } }).length, 12, "a group too big for the budget still goes, alone");
  assert.deepEqual(planRequests([], null), []);
});
