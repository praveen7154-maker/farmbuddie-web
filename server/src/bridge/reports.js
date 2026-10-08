// Farm reports for the Irrigo app's Reports screen: what each motor did, day
// by day - when it ran (start / end / how it was started / why it stopped),
// how long, roughly how much energy, when 3-phase power was there, which
// valves watered and for how long, faults, and the supply voltage through
// the day.
//
// Built here from the hub's own status stream (device_events, which the
// bridge records whether or not anyone has the app open) rather than from
// what a phone happened to see while it was connected. The hub publishes a
// status the moment the motor starts, stops or trips, and otherwise every
// 2 min while it runs / 10 min idle (Motor firmware config.h
// STATUS_INTERVAL_*), so start and stop times are exact and a run between
// two reports isn't lost.
//
// Pure functions only - storage and routes are in reportStore.js / server.js.

export const STATE_RUNNING = 1;
// India - the farms' (and the app's) local day.
export const DEFAULT_TZ_OFFSET_MIN = 330;
const DAY_MS = 86400000;
// Longer than this between two statuses = missing data (hub offline, no
// network), not "carried on as before". Running cadence is 2 min, idle 10.
const RUN_GAP_MS = 5 * 60000;
const IDLE_GAP_MS = 12 * 60000;
// Valve snapshots: on every change, else every 5 min running / 30 min idle.
const VALVE_GAP_MS = 35 * 60000;
// A phase counts as present above this (V, phase-to-neutral).
const PHASE_PRESENT_V = 100;
// No power-factor sensing on the hardware - a typical induction motor's.
export const ASSUMED_PF = 0.8;
const MAX_SESSIONS_PER_DAY = 200;

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/** "YYYY-MM-DD" of the local day [ms] falls in. */
export function dayKey(ms, offsetMin = DEFAULT_TZ_OFFSET_MIN) {
  return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10);
}

/** Epoch ms of local midnight starting [key]. */
export function dayStartMs(key, offsetMin = DEFAULT_TZ_OFFSET_MIN) {
  return Date.parse(`${key}T00:00:00Z`) - offsetMin * 60000;
}

export function dayKeysBetween(fromKey, toKey) {
  const out = [];
  for (let t = Date.parse(`${fromKey}T00:00:00Z`); t <= Date.parse(`${toKey}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** One device_events row (status / alert / valves) as a sample. */
export function toSample(row) {
  const t = row.recorded_at instanceof Date ? row.recorded_at.getTime() : Date.parse(row.recorded_at);
  const v = row.v || {};
  const i = row.i || {};
  return {
    t,
    type: row.event_type,
    state: num(row.state),
    fault: num(row.fault) ?? 0,
    v: [num(v.r) ?? 0, num(v.y) ?? 0, num(v.b) ?? 0],
    i: [num(i.r) ?? 0, num(i.y) ?? 0, num(i.b) ?? 0],
    runTotal: num(row.run_total_sec),
    mode: row.run_mode || null,
    manualStop: row.manual_stop === "true" || row.manual_stop === true,
    open: row.open ?? null
  };
}

/** Estimated kW from phase voltages / currents: 3 x Vph x I x PF. */
export function estimatedKw(s) {
  const vAvg = (s.v[0] + s.v[1] + s.v[2]) / 3;
  const iAvg = (s.i[0] + s.i[1] + s.i[2]) / 3;
  return (3 * vAvg * iAvg * ASSUMED_PF) / 1000;
}

const threePhase = (s) => s.v.every((x) => x >= PHASE_PRESENT_V);
const anyPhase = (s) => s.v.some((x) => x >= PHASE_PRESENT_V);

/**
 * Motor run sessions over all samples (sorted by time). Each: start, end,
 * mode (how it was started), endReason ("stopped" | "panel" | "fault" |
 * "no_data" | "running"), faultCode, kwh, sum of V/I for averages.
 */
export function runSessions(samples, endMs) {
  const sessions = [];
  let open = null;
  const close = (end, reason, faultCode = 0) => {
    open.end = end;
    open.endReason = reason;
    open.faultCode = faultCode;
    sessions.push(open);
    open = null;
  };
  samples = samples.filter((x) => x.state !== null);
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    const next = samples[k + 1];
    if (s.state !== STATE_RUNNING) {
      if (open) close(s.t, s.fault ? "fault" : s.manualStop ? "panel" : "stopped", s.fault);
      continue;
    }
    if (!open) open = { start: s.t, end: s.t, mode: s.mode, kwh: 0, vSum: 0, iSum: 0, n: 0 };
    if (!open.mode && s.mode) open.mode = s.mode;
    open.vSum += (s.v[0] + s.v[1] + s.v[2]) / 3;
    open.iSum += (s.i[0] + s.i[1] + s.i[2]) / 3;
    open.n += 1;
    const nextT = next ? next.t : endMs;
    let end = nextT;
    let capped = false;
    if (nextT - s.t > RUN_GAP_MS) {
      // A gap in the reports while running: the hub's lifetime run counter
      // (Motor 1 only) says how much of it the motor really ran.
      if (next && s.runTotal !== null && next.runTotal !== null && next.runTotal >= s.runTotal) {
        end = Math.min(nextT, s.t + (next.runTotal - s.runTotal) * 1000);
        capped = end < nextT;
      } else {
        end = s.t + RUN_GAP_MS;
        capped = true;
      }
    }
    end = Math.max(end, s.t);
    open.kwh += estimatedKw(s) * ((end - s.t) / 3600000);
    open.end = end;
    if (!next) {
      close(end, endMs - s.t <= RUN_GAP_MS ? "running" : "no_data");
    } else if (capped) {
      close(end, "no_data");
    }
  }
  return sessions;
}

/** Spans where [isOn] holds, each sample carrying until the next (capped at [gapMs]). */
export function spansWhere(samples, isOn, gapMs, endMs) {
  const spans = [];
  let cur = null;
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    const nextT = k + 1 < samples.length ? samples[k + 1].t : endMs;
    if (!isOn(s)) {
      cur = null;
      continue;
    }
    const end = Math.min(nextT, s.t + gapMs);
    if (cur && cur.end >= s.t) cur.end = Math.max(cur.end, end);
    else {
      cur = { start: s.t, end };
      spans.push(cur);
    }
    if (end < nextT) cur = null;
  }
  return spans.filter((x) => x.end > x.start);
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function hexMaskOpen(hex) {
  // Up to 64 valves - BigInt keeps every bit.
  let m;
  try {
    m = BigInt(`0x${hex || "0"}`);
  } catch {
    return [];
  }
  const out = [];
  for (let v = 1; v <= 64 && m > 0n; v++, m >>= 1n) if (m & 1n) out.push(v);
  return out;
}

/** Per valve, the spans it was open. */
export function valveSpans(valveSamples, endMs) {
  const byValve = new Map();
  for (let k = 0; k < valveSamples.length; k++) {
    const s = valveSamples[k];
    const nextT = k + 1 < valveSamples.length ? valveSamples[k + 1].t : endMs;
    const end = Math.min(nextT, s.t + VALVE_GAP_MS);
    if (end <= s.t) continue;
    for (const v of hexMaskOpen(s.open)) {
      const list = byValve.get(v) || [];
      const last = list[list.length - 1];
      if (last && last.end >= s.t) last.end = Math.max(last.end, end);
      else list.push({ start: s.t, end });
      byValve.set(v, list);
    }
  }
  return byValve;
}

const clip = (spans, d0, d1) =>
  spans.filter((x) => x.end > d0 && x.start < d1).map((x) => [Math.max(x.start, d0), Math.min(x.end, d1)]);
const sumSec = (pairs) => Math.round(pairs.reduce((a, [s, e]) => a + (e - s), 0) / 1000);

/**
 * Day-by-day reports for [dayKeys] from one motor's samples (status and
 * alert rows, sorted, starting a little before the first day so the state
 * at midnight is known) and - for Motor 1 - the hub's valve snapshots.
 */
export function buildDays({ dayKeys, samples, valveSamples = [], nowMs = Date.now(), offsetMin = DEFAULT_TZ_OFFSET_MIN }) {
  if (dayKeys.length === 0) return [];
  const rangeEnd = Math.min(nowMs, dayStartMs(dayKeys[dayKeys.length - 1], offsetMin) + DAY_MS);
  const motor = samples.filter((s) => s.state !== null);
  const sessions = runSessions(motor, rangeEnd);
  const power = spansWhere(motor, threePhase, IDLE_GAP_MS, rangeEnd);
  const faultSpans = new Map();
  for (const code of new Set(motor.map((s) => s.fault).filter((f) => f))) {
    faultSpans.set(code, spansWhere(motor, (s) => s.fault === code, IDLE_GAP_MS, rangeEnd));
  }
  const faultTrips = [];
  for (let k = 0; k < motor.length; k++) {
    const s = motor[k];
    if (s.fault && (k === 0 || motor[k - 1].fault !== s.fault)) faultTrips.push({ t: s.t, code: s.fault });
  }
  const valves = valveSpans(valveSamples, rangeEnd);
  const runPairs = sessions.map((x) => ({ start: x.start, end: x.end }));

  return dayKeys.map((day) => {
    const d0 = dayStartMs(day, offsetMin);
    const d1 = Math.min(d0 + DAY_MS, rangeEnd);
    const inDay = motor.filter((s) => s.t >= d0 && s.t < d1);
    if (d1 <= d0) return { day, dayStartMs: d0, hasData: false };

    const daySessions = sessions
      .filter((x) => x.end > d0 && x.start < d1)
      .slice(0, MAX_SESSIONS_PER_DAY)
      .map((x) => {
        const start = Math.max(x.start, d0);
        const end = Math.min(x.end, d1);
        const frac = x.end > x.start ? (end - start) / (x.end - x.start) : 0;
        return {
          start,
          end,
          durationSec: Math.round((end - start) / 1000),
          startedBefore: x.start < d0,
          continuesAfter: x.end > d1,
          mode: x.mode,
          endReason: x.end > d1 ? null : x.endReason,
          faultCode: x.faultCode || 0,
          kwh: Math.round(x.kwh * frac * 100) / 100,
          avgV: x.n ? Math.round(x.vSum / x.n) : null,
          avgA: x.n ? Math.round((x.iSum / x.n) * 10) / 10 : null
        };
      });
    const runSec = daySessions.reduce((a, x) => a + x.durationSec, 0);

    const valveList = [];
    for (const [valve, spans] of [...valves.entries()].sort((a, b) => a[0] - b[0])) {
      const open = clip(spans, d0, d1);
      if (open.length === 0) continue;
      let waterMs = 0;
      for (const [s, e] of open) for (const r of runPairs) waterMs += overlap(s, e, r.start, r.end);
      valveList.push({ valve, openSec: sumSec(open), waterSec: Math.round(waterMs / 1000), spans: open });
    }

    const faults = [];
    for (const [code, spans] of faultSpans) {
      const count = faultTrips.filter((f) => f.code === code && f.t >= d0 && f.t < d1).length;
      const downtimeSec = sumSec(clip(spans, d0, d1));
      if (count || downtimeSec) faults.push({ code, count, downtimeSec });
    }

    // Supply voltage by hour (mean of the three phases, only while there's power).
    const hourly = Array.from({ length: 24 }, () => null);
    for (const s of inDay) {
      if (!anyPhase(s)) continue;
      const h = Math.floor((s.t - d0) / 3600000);
      const avg = (s.v[0] + s.v[1] + s.v[2]) / 3;
      const b = hourly[h] || (hourly[h] = { min: avg, max: avg, sum: 0, n: 0 });
      b.min = Math.min(b.min, avg);
      b.max = Math.max(b.max, avg);
      b.sum += avg;
      b.n += 1;
    }

    const powerPairs = clip(power, d0, d1);
    return {
      day,
      dayStartMs: d0,
      hasData: inDay.length > 0 || daySessions.length > 0,
      runSec,
      starts: daySessions.filter((x) => !x.startedBefore).length,
      kwh: Math.round(daySessions.reduce((a, x) => a + x.kwh, 0) * 100) / 100,
      sessions: daySessions,
      powerSec: sumSec(powerPairs),
      powerSpans: powerPairs,
      valves: valveList,
      waterSec: valveList.reduce((a, x) => a + x.waterSec, 0),
      faults,
      faultEvents: faultTrips.filter((f) => f.t >= d0 && f.t < d1).slice(0, 50),
      voltage: hourly.map((b) => (b ? { min: Math.round(b.min), avg: Math.round(b.sum / b.n), max: Math.round(b.max) } : null)),
      samples: inDay.length
    };
  });
}

/** Range totals for the summary tiles. */
export function totalsOf(days) {
  const t = { runSec: 0, starts: 0, kwh: 0, powerSec: 0, waterSec: 0, faults: 0, daysWithData: 0 };
  const valves = new Map();
  const faultsByCode = new Map();
  for (const d of days) {
    if (!d.hasData) continue;
    t.daysWithData += 1;
    t.runSec += d.runSec;
    t.starts += d.starts;
    t.kwh += d.kwh;
    t.powerSec += d.powerSec;
    t.waterSec += d.waterSec;
    for (const v of d.valves) {
      const a = valves.get(v.valve) || { valve: v.valve, waterSec: 0, openSec: 0 };
      a.waterSec += v.waterSec;
      a.openSec += v.openSec;
      valves.set(v.valve, a);
    }
    for (const f of d.faults) {
      const a = faultsByCode.get(f.code) || { code: f.code, count: 0, downtimeSec: 0 };
      a.count += f.count;
      a.downtimeSec += f.downtimeSec;
      faultsByCode.set(f.code, a);
      t.faults += f.count;
    }
  }
  t.kwh = Math.round(t.kwh * 100) / 100;
  t.valves = [...valves.values()].sort((a, b) => a.valve - b.valve);
  t.faultsByCode = [...faultsByCode.values()].sort((a, b) => b.count - a.count);
  return t;
}
