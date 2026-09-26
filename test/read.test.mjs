import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { actionsIn, parseDate, readActions } from "../src/read.mjs";

const SMALL = fileURLToPath(new URL("./fixtures/small.json", import.meta.url));

test("reads a WP-CLI export: fields, dates with offsets, numbered ids, repeated ids and entries without a hook", async () => {
  const { actions, stats } = await readActions([SMALL]);
  assert.deepEqual(stats, { files: 1, entries: 7, invalid: 1, duplicates: 1 });
  assert.deepEqual(
    actions.map((a) => [a.id, a.status]),
    [
      [11, "failed"],
      [12, "failed"],
      [13, "failed"],
      [14, "failed"],
      [15, "pending"],
      [16, "complete"],
    ],
  );
  const [first, second, third] = actions;
  assert.deepEqual([first.hook, first.group, first.recurring], ["example_sync_order", "example-sync", false]);
  assert.deepEqual(first.args, { order_id: 501, email: "pat@example.com" });
  assert.equal(first.logs.length, 3);
  assert.equal(first.logs[2].time, Date.UTC(2026, 8, 24, 10, 0, 16));
  assert.equal(second.scheduled, Date.UTC(2026, 8, 24, 10, 0, 0), "+0200 is taken into account");
  assert.equal(third.recurring, true);

  assert.equal(parseDate("0000-00-00 00:00:00"), null, "async actions have no date");
  assert.equal(parseDate("2026-09-24T10:00:00Z"), Date.UTC(2026, 8, 24, 10));
  assert.equal(parseDate("2026-09-24 10:00:00 -0130"), Date.UTC(2026, 8, 24, 11, 30));
  assert.equal(parseDate("yesterday"), null);
});

test("skips notices printed before the JSON, reads one action from `action get`, and rejects other input plainly", () => {
  const noisy = "PHP Deprecated:  Creation of dynamic property in /srv/wp-content/plugins/x.php on line 3\n[\n{\"id\":\"9\",\"hook\":\"h\",\"status\":\"failed\",\"args\":\"[1]\",\"log_entries\":\"[{\\\"date\\\":\\\"2026-09-01 00:00:00 +0000\\\",\\\"message\\\":\\\"action failed: boom\\\"}]\"}\n]\nWarning: something after\n";
  const { actions } = actionsIn(noisy);
  assert.equal(actions.length, 1);
  assert.deepEqual([actions[0].id, actions[0].args, actions[0].logs[0].message], [9, [1], "action failed: boom"], "values WP-CLI printed as JSON text are decoded");

  const single = actionsIn(JSON.stringify({ id: 3, hook: "one_hook", status: "failed", args: [], log_entries: [] }));
  assert.deepEqual(single.actions.map((a) => a.hook), ["one_hook"]);

  assert.throws(() => actionsIn("id,hook\n1,pat@example.com\n"), { message: "not valid JSON; export with --format=json" }, "the file's text is not repeated");
  assert.throws(() => actionsIn("   "), /the file is empty/);
  assert.throws(() => actionsIn('{"total": 3}'), /expected a JSON list of actions/);
});
