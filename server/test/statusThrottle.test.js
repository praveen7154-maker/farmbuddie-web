import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatusThrottle, signature } from "../src/bridge/statusThrottle.js";

const MIN = 60 * 1000;

test("moving readings don't count as a change; state, faults and nested nodes do", () => {
  const a = { state: 1, fault: 0, volt_r: 230, curr_r: 5.1, run_sec: 10, motor_nodes: { 2: true }, step_remaining_sec: 50 };
  assert.equal(signature(a), signature({ ...a, volt_r: 231, curr_r: 5.3, run_sec: 70, step_remaining_sec: 40 }));
  assert.notEqual(signature(a), signature({ ...a, state: 0 }));
  assert.notEqual(signature(a), signature({ ...a, fault: 3 }));
  assert.notEqual(signature(a), signature({ ...a, motor_nodes: { 2: false } }));
});

test("writes on change, on heartbeat, and once when a farm goes quiet", () => {
  let t = 0;
  const th = createStatusThrottle({ heartbeatMs: 20 * MIN, offlineAfterMs: 11 * MIN, now: () => t });
  const ok = (r, fields) => { assert.equal(r.write, true); th.written("0001", fields ?? r.fields); };

  // first report: written
  ok(th.note("0001", "MOTOR_1", "motor1", { state: 1, volt_r: 230 }));
  // readings only, every 10 s for 5 min: nothing written
  let writes = 0;
  for (let i = 1; i <= 30; i++) { t += 10_000; if (th.note("0001", "MOTOR_1", "motor1", { state: 1, volt_r: 230 + i }).write) writes++; }
  assert.equal(writes, 0);
  // health arrives (new kind): written, together with the newest motor1 reading
  t += 1000;
  const h = th.note("0001", "MOTOR_1", "health", { fw_version: "1.0.4", signal_pct: 70 });
  assert.equal(h.write, true);
  assert.equal(h.fields.motor1.volt_r, 260);
  th.written("0001", h.fields);
  // motor stops: written at once
  t += 30_000;
  ok(th.note("0001", "MOTOR_1", "motor1", { state: 0, volt_r: 229 }));
  // quiet readings for 19 min: no write; at 20 min: heartbeat write
  t += 19 * MIN;
  assert.equal(th.note("0001", "MOTOR_1", "health", { fw_version: "1.0.4", signal_pct: 60 }).write, false);
  t += 2 * MIN;
  ok(th.note("0001", "MOTOR_1", "health", { fw_version: "1.0.4", signal_pct: 61 }));
  // no reports for 11+ min: due offline once
  t += 12 * MIN;
  assert.deepEqual(th.dueOffline(), ["0001"]);
  assert.equal(th.snapshot("0001").online, false);
  th.markedOffline("0001");
  assert.deepEqual(th.dueOffline(), []);
  // back: written at once even though nothing changed
  t += MIN;
  ok(th.note("0001", "MOTOR_1", "health", { fw_version: "1.0.4", signal_pct: 61 }));
  assert.equal(th.snapshot("0001").online, true);
});

test("about 90% fewer writes over a typical day", () => {
  let t = 0;
  const th = createStatusThrottle({ now: () => t });
  let reports = 0, writes = 0;
  const send = (field, p) => { reports++; const r = th.note("0001", "MOTOR_1", field, p); if (r.write) { writes++; th.written("0001", r.fields); } };
  let state = 0;
  for (let s = 0; s < 24 * 3600; s += 10) {
    t = s * 1000;
    const hour = s / 3600;
    const running = (hour >= 6 && hour < 10) || (hour >= 16 && hour < 18);
    const appOpen = hour >= 7 && hour < 8;
    if (running !== !!state) state = running ? 1 : 0;
    const every = appOpen ? 10 : running ? 120 : 600;
    if (s % every === 0) send("motor1", { state, volt_r: 220 + (s % 17), curr_r: running ? 5 + (s % 3) / 10 : 0, run_sec: s });
    if (s % 300 === 0) send("health", { fw_version: "1.0.4", signal_pct: 60 + (s % 9), uptime_sec: s });
  }
  assert.ok(writes / reports < 0.2, `${writes} writes for ${reports} reports`);
  assert.ok(writes <= 100, `${writes} writes`);
});
