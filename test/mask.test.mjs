import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsShape, isPersonalKey, maskArgs } from "../src/mask.mjs";

test("masks personal values in example arguments and sends Jev only names and value types", () => {
  const args = {
    order_id: 1043,
    billing_email: "pat@example.com",
    customerPhone: 5550100199,
    note: "Leave at the back door",
    api_key: "abc",
    ref: "contact pat@example.com or +1 (555) 010-0199",
    callback: "https://hooks.example.com/in?secret=1",
    sessionToken: "x",
    batch: [1, 2, 3],
    sent: true,
    code: "EX-ITEM-5521",
  };
  assert.deepEqual(maskArgs(args), {
    order_id: 1043,
    billing_email: "<masked>",
    customerPhone: "<masked>",
    note: "<masked>",
    api_key: "<masked>",
    ref: "contact <email> or <phone>",
    callback: "https://hooks.example.com/in?<query>",
    sessionToken: "<masked>",
    batch: [1, 2, 3],
    sent: true,
    code: "EX-ITEM-5521",
  });
  assert.deepEqual(maskArgs(["+44 20 7946 0958", "203.0.113.9", "f3a9c2e1b4d5a6f7e8d9c0b1a2f3e4d5", 42]), ["<phone>", "<ip>", "<token>", 42]);
  assert.deepEqual(maskArgs({ "pat@example.com": 1 }), { "<email>": 1 }, "keys holding an email address are masked too");

  assert.deepEqual(argsShape(args), {
    order_id: "number",
    billing_email: "text",
    customerPhone: "number",
    note: "text",
    api_key: "text",
    ref: "text",
    callback: "text",
    sessionToken: "text",
    batch: ["number", "number", "number"],
    sent: "true or false",
    code: "text",
  });
  assert.equal(JSON.stringify(argsShape(args)).includes("1043"), false, "no value is sent");

  assert.equal(isPersonalKey("webhook_id"), false);
  assert.equal(isPersonalKey("product_name"), true, "names are treated as personal, whatever they name");
  assert.equal(isPersonalKey("bypass"), false, "words are matched whole");
});
