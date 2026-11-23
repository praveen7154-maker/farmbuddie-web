import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFarmElectrical } from "../src/bridge/farmElectrical.js";

test("the device SIM number comes from the farm record's sim.msisdn, digits only", () => {
  const cfg = normalizeFarmElectrical("F1", { sim: { msisdn: "5754 1826 99822" } });
  assert.equal(cfg.deviceSim, "5754182699822");
});

test("no SIM number on the record (or a stub) gives null", () => {
  assert.equal(normalizeFarmElectrical("F1", {}).deviceSim, null);
  assert.equal(normalizeFarmElectrical("F1", { sim: { msisdn: "12345" } }).deviceSim, null);
});
