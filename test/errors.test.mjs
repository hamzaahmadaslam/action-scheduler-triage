import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureFetch } from "../src/jev.mjs";
import { KEY_ENV, runCli } from "./helpers/run.mjs";

const SMALL = fileURLToPath(new URL("./fixtures/small.json", import.meta.url));
const NO_STACK = /\n\s+at |Error:\s/;

test("a missing key is a one-line error with exit code 2, and nothing is sent", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => ({ answers: {} }));
  for (const env of [{}, { TYPESAFE_API_KEY: "   " }]) {
    const { code, out, err } = await runCli([SMALL], { env, fetchImpl });
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.match(err, /^TYPESAFE_API_KEY is not set\. .*--dry-run/);
    assert.equal(err.trim().split("\n").length, 1);
  }
  assert.equal(calls.length, 0);
});

test("401, 422, 429, 529 and timeouts end with a one-line error, without the key or a stack trace", async () => {
  const cases = [
    [401, /^TypeSafe error: the API key was refused\n$/],
    [422, /^TypeSafe error: the request was invalid: \{"error":"fixture"\}\n$/],
    [429, /^TypeSafe error: rate limited; try again later\n$/],
    [529, /^TypeSafe error: TypeSafe is overloaded; try again later\n$/],
  ];
  for (const [status, pattern] of cases) {
    const { code, out, err } = await runCli([SMALL], { env: KEY_ENV, fetchImpl: fixtureFetch(() => status).fetchImpl, jev: { retries: 0 } });
    assert.equal(code, 1, `status ${status}`);
    assert.equal(out, "");
    assert.match(err, pattern);
    assert.doesNotMatch(err, /test-secret-value/);
  }

  // A request that never answers is cut off by the timeout on the request's own abort signal. The interval stands
  // in for the open socket of a real request, which keeps the process running until the timeout fires.
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      const socket = setInterval(() => {}, 1000);
      init.signal.addEventListener("abort", () => {
        clearInterval(socket);
        reject(init.signal.reason);
      });
    });
  const timedOut = await runCli([SMALL], { env: KEY_ENV, fetchImpl: hang, jev: { retries: 0, timeoutMs: 20 } });
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.err, "Could not reach TypeSafe: timed out\n");
});

test("retries 429 and 529 with backoff, then uses the answer", async () => {
  const { fetchImpl, calls } = fixtureFetch((_body, n) => (n === 1 ? 429 : n === 2 ? 529 : { model: "fixture", answers: {}, usage: { input_tokens: 5 } }));
  const { code, out } = await runCli([SMALL], { env: KEY_ENV, fetchImpl, jev: { retries: 2 } });
  assert.equal(code, 0);
  assert.equal(calls.length, 3);
  assert.match(out, /Jev: model fixture, 1 request, 5 input tokens/);
  assert.match(out, /^Threshold 0\.80: 0 safe to retry, 0 fix first, 3 for review$/m, "groups without answers go to review");
});

test("bad options and unreadable or malformed exports are one-line errors with exit code 2", async () => {
  const usageErrors = [
    [[SMALL, "--threshold", "2"], "--threshold must be a number from 0.5 to 1."],
    [[SMALL, "--threshold", "0.3"], "--threshold must be a number from 0.5 to 1."],
    [[SMALL, "--threshold", "high"], "--threshold must be a number from 0.5 to 1."],
    [[SMALL, "--batch", "0"], "--batch must be a whole number above 0."],
    [[SMALL, "--batch", "2.5"], "--batch must be a whole number above 0."],
    [[], "Give the path to an export (JSON from wp action-scheduler action list), or - to read standard input."],
    [["-", "-"], "Standard input (-) can be read only once."],
  ];
  for (const [args, message] of usageErrors) {
    const { code, err } = await runCli(args, { env: KEY_ENV });
    assert.equal(code, 2, args.join(" "));
    assert.equal(err.split("\n")[0], message);
    assert.match(err, /Usage: action-scheduler-triage/);
  }
  const unknown = await runCli([SMALL, "--nope"], { env: KEY_ENV });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Unknown option '--nope'/);

  const missing = await runCli(["no-such-export.json", "--dry-run"]);
  assert.deepEqual([missing.code, missing.err], [2, "Cannot read no-such-export.json: no such file\n"]);
  const folder = fileURLToPath(new URL("./fixtures", import.meta.url));
  const isFolder = await runCli([folder, "--dry-run"]);
  assert.deepEqual([isFolder.code, isFolder.err], [2, `Cannot read ${folder}: it is a folder, not a file\n`]);
  const json = fileURLToPath(new URL("../package.json", import.meta.url));
  const notActions = await runCli([json, "--dry-run"]);
  assert.equal(notActions.code, 2);
  assert.ok(notActions.err.startsWith(`Cannot read ${json}: expected a JSON list of actions`), notActions.err);
  assert.equal(notActions.err.trim().split("\n").length, 1);
  for (const result of [unknown, missing, isFolder, notActions]) assert.doesNotMatch(result.err, NO_STACK);

  assert.match((await runCli(["--help"])).out, /^Usage: action-scheduler-triage/);
  assert.match((await runCli(["--version"])).out, /^\d+\.\d+\.\d+\n$/);
});
