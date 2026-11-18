import { test } from "node:test";
import assert from "node:assert/strict";
import { createFailureDetector, HUB_SILENCE_MS } from "../src/bridge/failureDetect.js";

const kinds = (list) => list.map((x) => `${x.unit}:${x.kind}`);

test("hub reboot, reconnect, low memory, loop stall, mesh drops", () => {
  const d = createFailureDetector();
  const t = 1_000_000;
  assert.deepEqual(d.onMessage("0002", "health_health", { device_uptime_sec: 5000, mqtt_connects: 1, max_alloc_heap: 90000,
    mesh: { drops: 2, inbox_dropped: 0, loop_busy_max_ms: 200 } }, t), []);   // seeds only
  const r = d.onMessage("0002", "health_health", { device_uptime_sec: 5300, mqtt_connects: 2, max_alloc_heap: 20000,
    mesh: { drops: 5, inbox_dropped: 3, loop_busy_max_ms: 45000 } }, t + 300000);
  assert.deepEqual(kinds(r), ["hub:hub_reconnect", "hub:hub_low_memory", "hub:hub_loop_stall", "hub:mesh_link_drops", "hub:mesh_inbox_dropped"]);
  assert.equal(r.find((x) => x.kind === "mesh_link_drops").detail.drops, 3);
  // Low memory noted once per boot.
  assert.ok(!kinds(d.onMessage("0002", "health_health", { device_uptime_sec: 5600, mqtt_connects: 2, max_alloc_heap: 20000 }, t + 600000)).includes("hub:hub_low_memory"));
  const b = d.onMessage("0002", "health_health", { device_uptime_sec: 40, reset_reason: "task_watchdog", restart_cause: "wdt_loop", mqtt_connects: 1 }, t + 900000);
  assert.deepEqual(kinds(b), ["hub:hub_reboot"]);
  assert.equal(b[0].detail.restart_cause, "wdt_loop");
  assert.equal(b[0].detail.uptime_before_s, 5600);
});

test("a fresh boot is recorded even as the first message seen", () => {
  const d = createFailureDetector();
  assert.deepEqual(kinds(d.onMessage("0003", "health_health", { device_uptime_sec: 120, reset_reason: "power_on" })), ["hub:hub_reboot"]);
  assert.deepEqual(kinds(d.onMessage("0004", "health_health", { device_uptime_sec: 99999 })), []);
});

test("hub silence is recorded when it reports again", () => {
  const d = createFailureDetector();
  d.onMessage("0002", "motor1_status", { state: 0 }, 0);
  assert.deepEqual(d.onMessage("0002", "motor1_status", { state: 0 }, 10 * 60000), []);
  const r = d.onMessage("0002", "valves_status", null, 10 * 60000 + HUB_SILENCE_MS + 60000);
  assert.deepEqual(kinds(r), ["hub:hub_silent"]);
  assert.equal(r[0].detail.minutes, 16);
});

test("motor node online flags, reboot, crash, mesh restart", () => {
  const d = createFailureDetector();
  d.onMessage("0002", "motor1_status", { motor_nodes: { 2: true, 3: true } }, 0);
  const off = d.onMessage("0002", "motor1_status", { motor_nodes: { 2: true, 3: false } }, 60000);
  assert.deepEqual(kinds(off), ["MOTOR_3:node_offline"]);
  const on = d.onMessage("0002", "motor1_status", { motor_nodes: { 2: true, 3: true } }, 660000);
  assert.deepEqual(kinds(on), ["MOTOR_3:node_online"]);
  assert.equal(on[0].detail.offline_s, 600);
  // Alerts on the status topic are not statuses.
  assert.deepEqual(d.onMessage("0002", "motor1_status", { event: 11, motor_nodes: { 2: false } }, 700000), []);

  assert.deepEqual(d.onMessage("0002", "motor3_status", { device_uptime_sec: 80000, mesh_restarts: 1 }, 0), []);
  assert.deepEqual(kinds(d.onMessage("0002", "motor3_status", { device_uptime_sec: 80100, mesh_restarts: 3, hub_silent_sec: 130 }, 1)),
    ["MOTOR_3:node_mesh_restart"]);
  const crash = d.onMessage("0002", "motor3_status", { device_uptime_sec: 36, reset_reason: "panic", crash: "abc12345 loopTask@0x400d1234 c28 v0x0 bt:400d1234" }, 2);
  assert.deepEqual(kinds(crash), ["MOTOR_3:node_reboot", "MOTOR_3:node_crash"]);
  // The same crash text in later statuses isn't recorded again.
  assert.deepEqual(d.onMessage("0002", "motor3_status", { device_uptime_sec: 60, crash: "abc12345 loopTask@0x400d1234 c28 v0x0 bt:400d1234" }, 3), []);
});

test("hub modem resets within a boot are recorded", () => {
  const d = createFailureDetector();
  d.onMessage("0002", "health_health", { device_uptime_sec: 1000, modem_resets: 0 }, 0);
  const r = d.onMessage("0002", "health_health", { device_uptime_sec: 1300, modem_resets: 1, signal_pct: 60 }, 300000);
  assert.deepEqual(kinds(r), ["hub:hub_modem_reset"]);
});

test("a hub crash is recorded once", () => {
  const d = createFailureDetector();
  d.onMessage("0002", "health_health", { device_uptime_sec: 9000 }, 0);
  const r = d.onMessage("0002", "health_health", { device_uptime_sec: 40, reset_reason: "panic", crash: "deadbeef loopTask@0x400d1 c28 v0x0 bt:400d1" }, 1);
  assert.deepEqual(kinds(r), ["hub:hub_reboot", "hub:hub_crash"]);
  assert.deepEqual(d.onMessage("0002", "health_health", { device_uptime_sec: 340, crash: "deadbeef loopTask@0x400d1 c28 v0x0 bt:400d1" }, 2), []);
});

test("LoRa: module not set up once per boot, a reverted speed change once", () => {
  const d = createFailureDetector();
  const h = (up, lora) => d.onMessage("0009", "health_health", { device_uptime_sec: up, lora });
  assert.deepEqual(h(5000, { kbps: "2.4", cfg: "ok" }).map((x) => x.kind), []);
  assert.deepEqual(h(5600, { kbps: "2.4", cfg: "no_answer", ch: 18 }).map((x) => x.kind), ["lora_module"]);
  assert.deepEqual(h(6200, { kbps: "2.4", cfg: "no_answer" }).map((x) => x.kind), []);
  const rev = "reverted to 2.4 kbps: VALVE_3 (+0) not heard at 9.6";
  const got = h(6800, { kbps: "2.4", cfg: "no_answer", change: rev });
  assert.deepEqual(got.map((x) => x.kind), ["lora_speed_reverted"]);
  assert.equal(got[0].detail.change, rev);
  assert.deepEqual(h(7400, { kbps: "2.4", cfg: "no_answer", change: rev }).map((x) => x.kind), []);
  assert.deepEqual(h(8000, { kbps: "9.6", cfg: "no_answer", change: "ok: 3 unit(s) at 9.6 kbps" }).map((x) => x.kind), []);
  // a reboot: the module problem is noted again
  assert.deepEqual(h(30, { kbps: "9.6", cfg: "wrong" }).map((x) => x.kind), ["hub_reboot", "lora_module"]);
});
