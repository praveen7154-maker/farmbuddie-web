import { test } from "node:test";
import assert from "node:assert/strict";
import { hubSmsTarget, isMainFarmer, createSmsSync } from "../src/bridge/farmSms.js";

test("hub SMS number follows the main farmer's switch", () => {
  assert.equal(hubSmsTarget({ primaryMobile: "98765 43210" }), "+919876543210");
  assert.equal(hubSmsTarget({ primaryMobile: "9876543210", smsAlertsEnabled: true }), "+919876543210");
  assert.equal(hubSmsTarget({ primaryMobile: "9876543210", smsAlertsEnabled: false }), "");
  assert.equal(hubSmsTarget({}), null);
});

test("only the main farmer's login may switch it", () => {
  const doc = { primaryMobile: "9876543210" };
  assert.equal(isMainFarmer({ phone_number: "+919876543210" }, doc), true);
  assert.equal(isMainFarmer({ phone_number: "+919999999999" }, doc), false);
  assert.equal(isMainFarmer({ uid: "admin" }, doc), false);
});

test("SMS off sends an empty number; already empty sends nothing", async () => {
  const sent = [];
  const sync = createSmsSync({ loadNumber: async () => "", publish: async (t, p) => sent.push(p) });
  await sync("1", "MOTOR_1", { sms_to: "+919876543210" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].number, "");
  await sync("1", "MOTOR_1", { sms_to: "" });
  assert.equal(sent.length, 1);
});

test("no farm record leaves the hub alone", async () => {
  const sent = [];
  const sync = createSmsSync({ loadNumber: async () => null, publish: async (t, p) => sent.push(p) });
  await sync("1", "MOTOR_1", { sms_to: "+919876543210" });
  assert.equal(sent.length, 0);
});
