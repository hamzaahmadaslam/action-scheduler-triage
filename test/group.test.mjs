import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { groupActions } from "../src/group.mjs";
import { readActions } from "../src/read.mjs";

const SMALL = fileURLToPath(new URL("./fixtures/small.json", import.meta.url));
const EXAMPLES = ["../examples/failed-actions.json", "../examples/past-due-actions.json"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

test("groups failures by hook and template, with first and last failure, and lists past-due actions apart", async () => {
  const { actions } = await readActions([SMALL]);
  const { failed, pastDue, stats } = groupActions(actions);
  assert.deepEqual(
    failed.map((g) => [g.id, g.hook, g.count]),
    [
      ["g01", "example_sync_order", 2],
      ["g02", "example_render_report", 1],
      ["g03", "example_notify_customer", 1],
    ],
  );
  const [sync, report, notify] = failed;
  assert.equal(sync.error, "cURL error 28: Operation timed out after <n> milliseconds with <n> bytes received from https://api.example.com/v1/orders?<query>");
  assert.deepEqual([sync.first, sync.last], [Date.UTC(2026, 8, 24, 10, 0, 16), Date.UTC(2026, 8, 24, 10, 30, 16)]);
  assert.deepEqual([sync.ids, sync.actionGroups, sync.recurring, sync.distinctArgs], [[11, 12], ["example-sync"], "no", 2]);
  assert.deepEqual(sync.examples, [
    { order_id: 501, email: "<masked>" },
    { order_id: 502, email: "<masked>" },
  ]);
  assert.deepEqual(sync.actions[0].args, { order_id: 501, email: "pat@example.com" }, "the exact arguments are kept for the commands");
  assert.deepEqual([report.failure, report.recurring, report.stopped], ["fatal", "yes", true]);
  assert.equal(notify.error, "Customer <id> has no email address on file (<email> was removed on <time>)");
  assert.deepEqual(notify.actionGroups, []);

  assert.deepEqual(
    pastDue.map((g) => [g.id, g.hook, g.count, g.first]),
    [["p01", "example_sync_order", 1, Date.UTC(2026, 8, 25, 10)]],
  );
  assert.deepEqual(stats.other, { complete: 1 });
  assert.deepEqual([stats.failed, stats.pastDue, stats.first, stats.last], [4, 1, Date.UTC(2026, 8, 23, 3, 0, 2), Date.UTC(2026, 8, 25, 8, 0, 4)]);
});

test("the example export forms twelve groups; errors that differ only in ids, amounts or timeout wording merge", async () => {
  const { actions } = await readActions(EXAMPLES);
  const { failed, pastDue } = groupActions(actions);
  assert.equal(failed.length, 12);
  assert.equal(pastDue.length, 2);
  const byHook = Object.fromEntries(failed.map((g) => [g.hook, g]));
  assert.equal(byHook.example_gateway_capture_payment.count, 6, "six orders and amounts, one group");
  assert.equal(byHook.example_loyalty_award_points.count, 4, "old and new timeout wording, one group");
  assert.equal(byHook.example_crm_sync_customer.count, 22, "retry-after values differ, one group");
  assert.equal(failed.reduce((sum, g) => sum + g.count, 0), 87);
});
