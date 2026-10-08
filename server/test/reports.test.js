// node --test server/test  (from the repo root) - farm Reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDays, toSample, dayKey, dayStartMs, totalsOf, estimatedKw, runSessions } from "../src/bridge/reports.js";
import { createReportService, REPORT_VERSION } from "../src/bridge/reportService.js";

// Local (IST) wall-clock -> epoch ms.
const at = (day, hhmm) => dayStartMs(day) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60000;
const D1 = "2026-10-07";
const D2 = "2026-10-08";
const V = { r: 230, y: 228, b: 232 };
const OFF = { r: 0, y: 0, b: 0 };
const A = { r: 10, y: 10, b: 10 };
const status = (t, state, extra = {}) => ({
  event_type: "motor1_status", recorded_at: new Date(t), state: String(state), fault: String(extra.fault ?? 0),
  v: extra.v ?? V, i: extra.i ?? (state === 1 ? A : { r: 0, y: 0, b: 0 }),
  run_total_sec: extra.rt !== undefined ? String(extra.rt) : null, run_mode: extra.mode ?? null,
  manual_stop: extra.manualStop ? "true" : null, open: null
});
const valves = (t, hex) => ({ event_type: "valves_status", recorded_at: new Date(t), open: hex });

function scenario() {
  const rows = [];
  // Idle with power from 05:30, every 10 min.
  for (let m = 5 * 60 + 30; m < 6 * 60 + 10; m += 10) rows.push(status(dayStartMs(D1) + m * 60000, 0));
  // Scheduled cyclic run 06:10 - 07:10, every 2 min; trips on dry run.
  let rt = 1000;
  for (let m = 6 * 60 + 10; m < 7 * 60 + 10; m += 2) {
    rows.push(status(dayStartMs(D1) + m * 60000, 1, { mode: "schedule_cyclic", rt }));
    rt += 120;
  }
  rows.push(status(at(D1, "07:10"), 0, { fault: 1, rt }));
  // Fault stays 20 min, then cleared; idle with power until 09:00.
  for (let m = 7 * 60 + 20; m < 9 * 60; m += 10) rows.push(status(dayStartMs(D1) + m * 60000, 0, { fault: m < 7 * 60 + 30 ? 1 : 0, rt }));
  // Power cut 09:00 - 21:50 (still reporting every 10 min).
  for (let m = 9 * 60; m < 21 * 60 + 50; m += 10) rows.push(status(dayStartMs(D1) + m * 60000, 0, { v: OFF, rt }));
  rows.push(status(at(D1, "21:50"), 0, { rt }));
  // Manual night run from 22:00; the hub's reports stop (GSM down) until
  // 01:00 next day, when it's stopped - the lifetime counter says it ran 3h.
  rows.push(status(at(D1, "22:00"), 1, { mode: "manual", rt }));
  rows.push(status(at(D2, "01:00"), 0, { rt: rt + 3 * 3600 }));
  rows.push(status(at(D2, "01:10"), 0, { rt: rt + 3 * 3600 }));
  const vrows = [valves(at(D1, "06:09"), "1"), valves(at(D1, "06:40"), "2"), valves(at(D1, "07:10"), "0")];
  return { samples: rows.map(toSample), valveSamples: vrows.map(toSample) };
}

test("day boundaries are India local days", () => {
  assert.equal(dayKey(Date.parse("2026-10-07T18:29:00Z")), "2026-10-07");
  assert.equal(dayKey(Date.parse("2026-10-07T18:31:00Z")), "2026-10-08");
  assert.equal(dayStartMs("2026-10-08"), Date.parse("2026-10-07T18:30:00Z"));
});

test("runs: start/end/mode/why it stopped, split at midnight", () => {
  const { samples, valveSamples } = scenario();
  const [d1, d2] = buildDays({ dayKeys: [D1, D2], samples, valveSamples, nowMs: at(D2, "12:00") });
  assert.equal(d1.sessions.length, 2);
  const [morning, night] = d1.sessions;
  assert.equal(morning.start, at(D1, "06:10"));
  assert.equal(morning.end, at(D1, "07:10"));
  assert.equal(morning.mode, "schedule_cyclic");
  assert.equal(morning.endReason, "fault");
  assert.equal(morning.faultCode, 1);
  assert.equal(night.start, at(D1, "22:00"));
  assert.equal(night.continuesAfter, true);
  assert.equal(night.durationSec, 2 * 3600);
  assert.equal(d1.runSec, 3600 + 2 * 3600);
  assert.equal(d1.starts, 2);

  assert.equal(d2.sessions.length, 1);
  assert.equal(d2.sessions[0].startedBefore, true);
  assert.equal(d2.sessions[0].end, at(D2, "01:00"));
  assert.equal(d2.sessions[0].endReason, "stopped");
  assert.equal(d2.runSec, 3600);
  assert.equal(d2.starts, 0);
});

test("valves: water time is open AND motor running", () => {
  const { samples, valveSamples } = scenario();
  const [d1] = buildDays({ dayKeys: [D1], samples, valveSamples, nowMs: at(D2, "12:00") });
  const v1 = d1.valves.find((v) => v.valve === 1);
  const v2 = d1.valves.find((v) => v.valve === 2);
  assert.equal(v1.openSec, 31 * 60);       // 06:09 - 06:40
  assert.equal(v1.waterSec, 30 * 60);      // motor from 06:10
  assert.equal(v2.waterSec, 30 * 60);      // 06:40 - 07:10
  assert.equal(d1.waterSec, 60 * 60);
});

test("3-phase power hours, faults and voltage", () => {
  const { samples, valveSamples } = scenario();
  const [d1] = buildDays({ dayKeys: [D1], samples, valveSamples, nowMs: at(D2, "12:00") });
  // 05:30-09:00 and 21:50-24:00 (night run carries power through the gap? no:
  // power spans are capped at 12 min after the last report) -> 05:30-09:00 + 21:50-22:12
  assert.equal(d1.powerSpans[0][0], at(D1, "05:30"));
  assert.equal(d1.powerSpans[0][1], at(D1, "09:00"));
  assert.equal(d1.faults.length, 1);
  assert.deepEqual(d1.faults[0], { code: 1, count: 1, downtimeSec: 20 * 60 });
  assert.equal(d1.faultEvents[0].t, at(D1, "07:10"));
  assert.equal(d1.voltage[6].avg, 230);
  assert.equal(d1.voltage[12], null);      // power cut
  assert.ok(d1.kwh > 0);
});

test("energy estimate is 3 x Vph x I x PF", () => {
  const kw = estimatedKw({ v: [230, 230, 230], i: [10, 10, 10] });
  assert.equal(Math.round(kw * 100) / 100, 5.52);
});

test("a run still going, and a gap with no counter (motor node)", () => {
  const now = at(D1, "10:01");
  const live = [toSample(status(at(D1, "10:00"), 1, { mode: "manual" }))];
  assert.equal(runSessions(live, now)[0].endReason, "running");
  const gap = [
    toSample({ ...status(at(D1, "10:00"), 1), event_type: "motor2_status" }),
    toSample({ ...status(at(D1, "11:00"), 0), event_type: "motor2_status" })
  ];
  const s = runSessions(gap, at(D1, "12:00"))[0];
  assert.equal(s.endReason, "no_data");
  assert.equal(s.end - s.start, 5 * 60000);
});

test("totals add up across days", () => {
  const { samples, valveSamples } = scenario();
  const days = buildDays({ dayKeys: [D1, D2], samples, valveSamples, nowMs: at(D2, "12:00") });
  const t = totalsOf(days);
  assert.equal(t.runSec, 4 * 3600);
  assert.equal(t.starts, 2);
  assert.equal(t.faults, 1);
  assert.deepEqual(t.valves.map((v) => v.valve), [1, 2]);
});

test("service: saved days are reused, finished days are saved, today is live", async () => {
  const { samples, valveSamples } = scenario();
  const raw = [...samples, ...valveSamples].map((s) => ({
    event_type: s.type, recorded_at: new Date(s.t), state: s.state === null ? null : String(s.state),
    fault: String(s.fault), v: { r: s.v[0], y: s.v[1], b: s.v[2] }, i: { r: s.i[0], y: s.i[1], b: s.i[2] },
    run_total_sec: s.runTotal === null ? null : String(s.runTotal), run_mode: s.mode, manual_stop: null, open: s.open
  })).sort((a, b) => a.recorded_at - b.recorded_at);
  const savedRows = new Map();
  let rawQueries = 0;
  const store = {
    async samples(farm, types, from, to) {
      rawQueries++;
      return raw.filter((r) => types.includes(r.event_type) && r.recorded_at >= from && r.recorded_at < to);
    },
    async savedDays(farm, motor, keys) { return new Map(keys.filter((k) => savedRows.has(k)).map((k) => [k, savedRows.get(k)])); },
    async saveDays(farm, motor, days) { for (const d of days) savedRows.set(d.day, d); },
    async activeMotors() { return [{ farmId: "0001", motor: "1" }]; }
  };
  const svc = createReportService({ store, now: () => at(D2, "12:00"), log: { log() {}, error() {} } });
  const r1 = await svc.getReport("0001", "1", D1, D2);
  assert.equal(r1.days.length, 2);
  assert.equal(r1.totals.runSec, 4 * 3600);
  await new Promise((r) => setImmediate(r));
  assert.ok(savedRows.has(D1) && !savedRows.has(D2));   // today isn't saved
  assert.equal(savedRows.get(D1).v, REPORT_VERSION);
  rawQueries = 0;
  const r2 = await svc.getReport("0001", "1", D1, D1);
  assert.equal(rawQueries, 0);                           // came from report_days
  assert.equal(r2.days[0].runSec, r1.days[0].runSec);
  assert.throws(() => svc.parseRange({ from: "2026-10-09", to: "2026-10-08" }), /after/);
  assert.throws(() => svc.parseRange({ from: "2026-01-01", to: "2026-10-08" }), /At most/);
});
