import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsJson, commandsFor, retryCommand, runHookCommand, shellQuote } from "../src/commands.mjs";

test("writes create commands that copy the hook, arguments and group exactly, quoted for a POSIX shell", () => {
  assert.deepEqual(retryCommand({ hook: "example_sync_order", group: "example-sync", args: { order_id: 501, email: "pat@example.com" } }), {
    command: `wp action-scheduler action create example_sync_order async --args='{"order_id":501,"email":"pat@example.com"}' --group=example-sync`,
  });
  assert.deepEqual(retryCommand({ hook: "example_legacy", group: "", args: [] }), { command: "wp action-scheduler action create example_legacy async" });
  assert.deepEqual(retryCommand({ hook: "example_note", group: "shop notes", args: ["it's done", 2] }), {
    command: `wp action-scheduler action create example_note async --args='["it'\\''s done",2]' --group='shop notes'`,
  });

  assert.equal(shellQuote("plain_hook-1.2"), "plain_hook-1.2");
  assert.equal(shellQuote("$(rm -rf ~)"), "'$(rm -rf ~)'", "command substitution stays literal inside single quotes");
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  const sneaky = `note${String.fromCharCode(0x9b)}31m${String.fromCharCode(0x202e)}`;
  assert.equal(argsJson([sneaky]), '["note\\u009b31m\\u202e"]', "characters a terminal could act on are written as escapes");
  assert.deepEqual(JSON.parse(argsJson([sneaky])), [sneaky], "the escaped JSON decodes to the same value");
  assert.equal(runHookCommand("example_search_index_rebuild"), "wp action-scheduler run --hooks=example_search_index_rebuild");
  assert.equal(runHookCommand("a,b"), null, "--hooks is a comma-separated list");
});

test("refuses arguments it cannot copy exactly and prints no per-action commands for recurring actions", () => {
  assert.deepEqual(retryCommand({ hook: "h", group: "", args: { id: 12345678901234567890 } }), { reason: "an argument is a number too large to copy exactly" });
  assert.deepEqual(retryCommand({ hook: "h", group: "", args: { 2: "b", 1: "a" } }), { reason: "the arguments have numbered keys, whose order cannot be kept" });
  assert.deepEqual(retryCommand({ hook: "h", group: "", args: "[1" }), { reason: "the export holds no argument list for this action" });
  assert.deepEqual(retryCommand({ hook: `h${String.fromCharCode(10)}rm -rf /`, group: "", args: [] }), { reason: "the hook or group name holds control characters" });
  assert.deepEqual(retryCommand({ hook: "--require=/tmp/x.php", group: "", args: [] }), { reason: "the hook name starts with a dash" }, "WP-CLI would read it as an option");

  const group = {
    hook: "example_mixed",
    actions: [
      { id: 1, hook: "example_mixed", group: "g", args: [1], recurring: false },
      { id: 2, hook: "example_mixed", group: "g", args: [], recurring: true },
      { id: 3, hook: "example_mixed", group: "g", args: { 0: "x" }, recurring: false },
    ],
  };
  assert.deepEqual(commandsFor(group), {
    commands: ["wp action-scheduler action create example_mixed async --args='[1]' --group=g"],
    notCopied: [{ id: 3, reason: "the arguments have numbered keys, whose order cannot be kept" }],
  });
});
