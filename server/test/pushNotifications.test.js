import { test } from "node:test";
import assert from "node:assert/strict";
import { isPushWorthy, buildNotification } from "../src/bridge/pushNotifications.js";

test("a fault trip is named even when the motor still holds an earlier fault", () => {
  // Phase loss (5) tripping while phase-reversed (7) is still the active fault.
  const payload = { event: 5, fault: 7 };
  assert.equal(isPushWorthy(payload), true);
  assert.match(buildNotification("n", 1, payload).body, /^Phase loss/);
});

test("a plain fault trip and a non-fault event are unchanged", () => {
  assert.match(buildNotification("n", 1, { event: 7, fault: 7 }).body, /^Phase order reversed/);
  assert.match(buildNotification("n", 1, { event: 10, fault: 10 }).body, /^Power outage/);
  assert.equal(isPushWorthy({ event: 10, fault: 0 }), true); // legacy voltage restored
  assert.doesNotMatch(buildNotification("n", 1, { event: 71, fault: 0 }).body, /stopped/);
});
