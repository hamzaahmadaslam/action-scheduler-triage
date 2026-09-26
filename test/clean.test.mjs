import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanMessage, failureOf, templateOf, visible } from "../src/clean.mjs";

const log = (...messages) => messages.map((message, i) => ({ time: i * 1000, message }));

test("finds the failure among the log entries: exceptions, fatal errors, both timeout wordings, a stopped schedule", () => {
  const exception = failureOf(log("action created", "action started via WP Cron", "action failed via WP Cron: Product 5521 not found"));
  assert.deepEqual(exception, { kind: "exception", text: "Product 5521 not found", time: 2000, stopped: false });

  const fatal = failureOf(log("action started via Async Request", "unexpected shutdown: PHP Fatal error Allowed memory size exhausted in /x/y.php on line 9"));
  assert.deepEqual([fatal.kind, fatal.text], ["fatal", "PHP Fatal error Allowed memory size exhausted in /x/y.php on line 9"]);

  const oldWording = failureOf(log("action marked as failed after 300 seconds. Unknown error occurred. Check server, PHP and database error logs to diagnose cause."));
  const newWording = failureOf(log("action was in-progress for at least 300 seconds without completing and has been marked as failed. Check server, PHP and database error logs to diagnose cause."));
  assert.equal(oldWording.kind, "timeout");
  assert.equal(oldWording.text, newWording.text, "both wordings of Action Scheduler's timeout become one message");

  const stopped = failureOf(
    log("action failed via WP Cron: boom", "This action appears to be consistently failing. A new instance will not be scheduled."),
  );
  assert.deepEqual([stopped.kind, stopped.text, stopped.stopped], ["exception", "boom", true]);

  assert.deepEqual(failureOf(log("action created", "action started via WP Cron")), { kind: "none", text: "", time: null, stopped: false });
  assert.equal(failureOf(log("Payment provider said: card declined")).kind, "logged", "a plugin's own log line is kept");
  assert.equal(failureOf([]).kind, "none");
});

test("templates remove ids, amounts, dates, numbers and email addresses but keep error and HTTP status codes", () => {
  const t = (text) => templateOf(cleanMessage(text));
  assert.equal(
    t("cURL error 28: Operation timed out after 10001 milliseconds with 0 bytes received"),
    "cURL error 28: Operation timed out after <n> milliseconds with <n> bytes received",
  );
  assert.equal(t("HTTP 429 Too Many Requests: retry after 60 seconds"), "HTTP 429 Too Many Requests: retry after <n> seconds");
  assert.equal(t("Remote returned 503 Service Unavailable"), "Remote returned 503 Service Unavailable");
  assert.equal(t("status code 401 from HTTP/1.1 server"), "status code 401 from HTTP/1.1 server");
  assert.equal(t("SQLSTATE[HY000] [2002] Connection refused"), "SQLSTATE[HY000] [2002] Connection refused");
  assert.equal(
    t("Gateway timed out while capturing order #1043 of $49.00 at 2026-09-25 14:02:05 +0000"),
    "Gateway timed out while capturing order #<id> of <amount> at <time>",
  );
  assert.equal(t("Product 5521 not found for user_id: 7"), "Product <id> not found for user_id: <id>");
  assert.equal(t("Invalid email jane.doe@example.com for list 7"), "Invalid email <email> for list <id>");
  assert.equal(t('Unknown SKU "Blue Hoodie Large" in feed'), 'Unknown SKU "<str>" in feed');
  assert.equal(t("array_merge(): Argument #2 must be of type array"), "array_merge(): Argument #2 must be of type array");
  assert.equal(t("Took 512MB and 30s"), "Took <n>MB and <n>s");
  assert.equal(
    t("Uncaught Error: Call to undefined function x() in /home/u/public_html/wp-content/plugins/p/a.php:12\nStack trace:\n#0 {main}"),
    "Uncaught Error: Call to undefined function x() in wp-content/plugins/p/a.php:<n>",
  );
  assert.equal(t("GET https://api.example.com/v1/items?key=secret&page=2 from 203.0.113.9 failed"), "GET https://api.example.com/v1/items?<query> from <ip> failed");
  assert.equal(t("HTTP 404 from https://api.example.com/v1/customers/118"), "HTTP 404 from https://api.example.com/v1/customers/<n>");
  assert.equal(t("user a1b2c3d4-e5f6-7890-abcd-ef1234567890 token 9f86d081884c7d659a2feaa0c55ad015"), "user <uuid> token <hash>");

  const hidden = `ok${String.fromCharCode(0x1b)}[31m red${String.fromCharCode(0x202e)}txt`;
  assert.equal(visible(hidden).includes(String.fromCharCode(0x1b)), false, "escape characters are removed before printing");
  assert.equal(visible(hidden).includes(String.fromCharCode(0x202e)), false, "text-direction overrides are removed");
});
