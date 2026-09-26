import { blocked } from "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INPUTS, OUTPUTS, exampleFetch, exampleOutput } from "../examples/fixture.mjs";
import * as reportExports from "../src/report.mjs";
import { KEY_ENV, runCli } from "./helpers/run.mjs";

// The examples are run by their relative paths so the output matches the files in examples/.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

test("--dry-run prints the questions and a token estimate and sends nothing, even with a key", async () => {
  const { fetchImpl, calls } = exampleFetch();
  const text = await runCli([...INPUTS, "--dry-run"], { env: KEY_ENV, fetchImpl });
  assert.equal(text.code, 0);
  assert.match(text.out, /\(dry run: nothing was sent\)/);
  assert.match(text.out, /Would send 1 request to https:\/\/api\.typesafe\.ai\/v1\/systemone with model jev-latest/);
  assert.match(text.out, /^Estimated total: about [\d,]+ input tokens$/m);
  assert.match(text.out, /g01_cause \(choice\): What most likely caused the failures in `groups\.g01`\?/);
  assert.match(text.out, /g01_retry \(noul\): Is it safe to run the actions in `groups\.g01` again as they are/);
  assert.match(text.out, /g01_urgency \(score\): How soon should someone deal with the failures in `groups\.g01`\?/);
  assert.match(text.out, /2 past-due groups are listed in the report and never sent\./);

  const json = await runCli([...INPUTS, "--dry-run", "--json"], { env: {}, fetchImpl });
  const report = JSON.parse(json.out);
  assert.equal(report.dry_run, true);
  assert.equal(report.requests.length, 1);
  assert.deepEqual(Object.keys(report.requests[0].body), ["model", "state", "questions"]);
  assert.equal(Object.keys(report.requests[0].body.questions).length, 36);
  assert.ok(report.estimated_input_tokens > 0);
  assert.equal(calls.length, 0);
});

test("the JSON report lists every group most urgent first, with decisions, probabilities and retry commands", async () => {
  const { fetchImpl, calls } = exampleFetch();
  const { code, out } = await runCli([...INPUTS, "--json"], { env: KEY_ENV, fetchImpl });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  const report = JSON.parse(out);
  assert.deepEqual([report.groups_total, report.retry, report.fix_first, report.review, report.threshold], [12, 3, 7, 2, 0.8]);
  assert.deepEqual([report.failed, report.past_due, report.skipped_statuses], [87, 9, { canceled: 1 }]);
  const scores = report.groups.map((g) => g.urgency.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

  const [top] = report.groups;
  assert.deepEqual([top.hook, top.urgency.label, top.cause.choice, top.decision, top.safe_to_run_again], ["example_gateway_capture_payment", "now", "transient-network-or-timeout", "fix-first", 0.08]);
  assert.equal(top.retry_commands, undefined, "no commands for a group to fix first");
  assert.match(top.what_to_check, /payment gateway/);

  const crm = report.groups.find((g) => g.hook === "example_crm_sync_customer");
  assert.equal(crm.decision, "retry");
  assert.equal(crm.retry_commands.length, 22, "every action of the group, not only the ten in the text report");
  assert.match(crm.retry_commands[0], /^wp action-scheduler action create example_crm_sync_customer async --args='\{"customer_id":\d+\}' --group=example-crm$/);
  const rates = report.groups.find((g) => g.hook === "example_rates_refresh");
  assert.deepEqual([rates.decision, rates.retry_commands, rates.recurring], ["retry", [], "yes"], "recurring actions get no commands");
  assert.match(rates.pending_check, /--status=pending/);
  const mailer = report.groups.find((g) => g.hook === "example_mailer_send_receipt");
  assert.deepEqual(mailer.example_arguments[0], { order_id: 997, email: "<masked>" });

  const review = report.groups.filter((g) => g.decision === "review");
  assert.deepEqual(review.map((g) => g.hook), ["example_webhooks_deliver", "example_loyalty_award_points"]);
  assert.deepEqual(report.past_due_groups.map((g) => [g.hook, g.count, g.run_command]), [
    ["example_crm_sync_customer", 3, "wp action-scheduler run --hooks=example_crm_sync_customer"],
    ["example_search_index_rebuild", 6, "wp action-scheduler run --hooks=example_search_index_rebuild"],
  ]);

  const lenient = JSON.parse((await runCli([...INPUTS, "--json", "--threshold", "0.6"], { env: KEY_ENV, fetchImpl })).out);
  assert.deepEqual([lenient.retry, lenient.fix_first, lenient.review], [4, 7, 1], "at 0.60 the webhook group (0.64) counts as safe");
});

test("the text report has an overview most urgent first, then the three lists and the past-due actions", async () => {
  const { fetchImpl } = exampleFetch();
  const { out } = await runCli(INPUTS, { env: KEY_ENV, fetchImpl });
  assert.match(out, /^Threshold 0\.80: 3 safe to retry, 7 fix first, 2 for review$/m);
  assert.match(out, /^g02  now {7}fix first  transient-network-or-timeout {3}6  example_gateway_capture_payment$/m);
  const order = ["Failed groups, most urgent first", "Safe to retry, most urgent first", "Fix first, most urgent first", "For review, most urgent first", "Past due: pending actions"];
  const positions = order.map((title) => out.indexOf(title));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), "sections in order");
  assert.match(out, /Commands to run by hand \(printed only; this tool never runs them\):/);
  assert.match(out, /12 more commands in the JSON report \(--json\)\./);
  assert.match(out, /Review: safe to run again 0\.64, between 0\.20 and 0\.80\./);
  assert.match(out, /After the fix, check that it is scheduled again: wp action-scheduler action list --hook=example_reports_rebuild/);
  assert.doesNotMatch(out, /customer\d@example\.com|jane\.doe@example\.com/, "no email address from the export is printed");
});

test("every output gives token counts only, with no dollar cost, rate or price constant", async () => {
  const { fetchImpl } = exampleFetch();
  const outputs = {};
  for (const args of [[], ["--json"], ["--dry-run"], ["--dry-run", "--json"]]) {
    const { code, out } = await runCli([...INPUTS, ...args], { env: KEY_ENV, fetchImpl });
    assert.equal(code, 0);
    assert.doesNotMatch(out, /\$\s?\d|per million|cost/i, `output with options [${args.join(" ")}]`);
    outputs[args.join(" ")] = out;
  }
  assert.match(outputs[""], /^Jev: model fixture, 1 request, [\d,]+ input tokens$/m);
  assert.match(outputs["--dry-run"], /^Estimated total: about [\d,]+ input tokens$/m);
  assert.ok(JSON.parse(outputs["--json"]).usage.input_tokens > 0);
  assert.ok(JSON.parse(outputs["--dry-run --json"]).estimated_input_tokens > 0);
  assert.deepEqual(Object.keys(reportExports).filter((name) => /price|cost/i.test(name)), [], "src/report.mjs exports no price or cost");
});

test("reads an export from standard input when the file is -", async () => {
  const stdin = Readable.from([readFileSync("test/fixtures/small.json")]);
  const { code, out } = await runCli(["-", "--dry-run", "--json"], { stdin });
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.deepEqual([report.files, report.failed, report.past_due, report.groups_total, report.duplicates], [["-"], 4, 1, 3, 1]);
});

test("the files in examples/ are exactly what the code produces from the fixture answers", async () => {
  for (const [name, args] of Object.entries(OUTPUTS)) {
    const expected = readFileSync(`examples/${name}`, "utf8").replace(/\r\n/g, "\n");
    assert.equal(await exampleOutput(args), expected, `examples/${name} is out of date: run npm run example`);
  }
});

test("no test reached the network", () => {
  assert.deepEqual(blocked, []);
});
