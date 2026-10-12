import { test } from "node:test";
import assert from "node:assert/strict";
import { farmUnitCounts, unitsForProduct } from "../src/bridge/farmUnits.js";

test("a farm with nothing paired has no node units", () => {
  assert.deepEqual(farmUnitCounts({ deviceStatus: { motor1: { state: "OFF" } } }), { motorNodes: 0, valves: 0, backwash: 0 });
  assert.deepEqual(farmUnitCounts({}), { motorNodes: 0, valves: 0, backwash: 0 });
});

test("motor nodes come from the app's paired list or the hub's motor_nodes", () => {
  assert.equal(farmUnitCounts({ pairedUnits: { motorNodes: { MOTOR_2: {}, MOTOR_3: {} } } }).motorNodes, 2);
  assert.equal(farmUnitCounts({ deviceStatus: { motor1: { motor_nodes: { 2: true } } } }).motorNodes, 1);
  assert.equal(farmUnitCounts({ deviceStatus: { motor1: { motor2_online: false } } }).motorNodes, 1);
  // A motor3 status left in the record after the node was removed doesn't count.
  assert.equal(farmUnitCounts({ deviceStatus: { motor1: {}, motor3: { state: "OFF" } } }).motorNodes, 0);
});

test("a backwash node is not counted as a valve unit", () => {
  const f = { pairedUnits: { valves: { V1: { hasPressureSensors: false }, FB: { hasPressureSensors: true } } },
              deviceStatus: { valves: { units: [{ u: "V1" }, { u: "FB" }] } } };
  assert.deepEqual(farmUnitCounts(f), { motorNodes: 0, valves: 1, backwash: 1 });
  // Only a backwash node, never synced by the app, but its pressure is live.
  const g = { deviceStatus: { motor1: { backwash: { pressure_data_online: true } } } };
  assert.equal(farmUnitCounts(g).backwash, 1);
});

test("unitsForProduct picks the right count", () => {
  const u = { motorNodes: 2, valves: 0, backwash: 1 };
  assert.equal(unitsForProduct(u, "motor-node"), 2);
  assert.equal(unitsForProduct(u, "valve"), 0);
  assert.equal(unitsForProduct(u, "filter-backwash"), 1);
  assert.equal(unitsForProduct(u, "hub"), null);
});

test("a removed unit an old phone uploaded again doesn't count; a new pairing does", () => {
  const f = { pairedUnits: {
    motorNodes: { MOTOR_2: { nodeLabel: "MOTOR_2", provisionedAtMs: 1000 }, MOTOR_3: { nodeLabel: "MOTOR_3", provisionedAtMs: 9000 } },
    valves: { V1: { unitLabel: "V1", provisionedAtMs: 1000 } },
    removed: { motorNodes: { MOTOR_2: 5000, MOTOR_3: 5000 }, valves: { V1: 5000 } }
  } };
  assert.deepEqual(farmUnitCounts(f), { motorNodes: 1, valves: 0, backwash: 0 });
});
