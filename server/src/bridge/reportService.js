import { buildDays, dayKey, dayKeysBetween, dayStartMs, toSample, totalsOf, DEFAULT_TZ_OFFSET_MIN } from "./reports.js";

// Reports for the app (see reports.js for what's in one): finished days come
// from report_days when already computed; today, and any day not computed
// yet, from the raw status stream - and a finished day is then saved, so it
// survives the 15-day raw retention. A roll-up also saves yesterday for
// every active motor once an hour, so no farm's history depends on someone
// opening Reports in time.

export const REPORT_VERSION = 1;
export const RAW_RETENTION_DAYS = 15;   // postgres.js RETENTION_DAYS
export const MAX_RANGE_DAYS = 62;
const CONTEXT_MS = 35 * 60000;         // a little before midnight, to know the state at 00:00
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createReportService({ store, now = () => Date.now(), offsetMin = DEFAULT_TZ_OFFSET_MIN, log = console }) {
  const eventTypes = (motor) => (motor === "1" ? [`motor${motor}_status`, "valves_status"] : [`motor${motor}_status`]);

  async function compute(farmId, motor, keys) {
    if (keys.length === 0) return [];
    const from = dayStartMs(keys[0], offsetMin) - CONTEXT_MS;
    const to = dayStartMs(keys[keys.length - 1], offsetMin) + 86400000;
    const rows = (await store.samples(farmId, eventTypes(motor), from, to)).map(toSample);
    const samples = rows.filter((s) => s.type !== "valves_status");
    const valveSamples = rows.filter((s) => s.type === "valves_status");
    return buildDays({ dayKeys: keys, samples, valveSamples, nowMs: now(), offsetMin })
      .map((d) => ({ ...d, v: REPORT_VERSION }));
  }

  async function getReport(farmId, motor, fromKey, toKey) {
    const today = dayKey(now(), offsetMin);
    const oldestRaw = dayKey(now() - RAW_RETENTION_DAYS * 86400000, offsetMin);
    const keys = dayKeysBetween(fromKey, toKey <= today ? toKey : today);
    const saved = await store.savedDays(farmId, motor, keys.filter((k) => k < today));
    const usable = (k) => saved.has(k) && saved.get(k).v === REPORT_VERSION;
    const need = keys.filter((k) => k >= oldestRaw && (k >= today || !usable(k)));
    const fresh = await compute(farmId, motor, need);
    const toSave = fresh.filter((d) => d.day < today);
    if (toSave.length) store.saveDays(farmId, motor, toSave).catch((err) => log.error("[reports] save failed:", err));
    const freshByDay = new Map(fresh.map((d) => [d.day, d]));
    const days = keys.map((k) =>
      freshByDay.get(k) || (saved.has(k) ? saved.get(k) : { day: k, dayStartMs: dayStartMs(k, offsetMin), hasData: false }));
    return {
      farmId,
      motor,
      from: fromKey,
      to: keys[keys.length - 1],
      tzOffsetMin: offsetMin,
      generatedAt: new Date(now()).toISOString(),
      rawRetentionDays: RAW_RETENTION_DAYS,
      totals: totalsOf(days),
      days
    };
  }

  // Saves yesterday and the day before for every motor that reported then.
  async function rollUp() {
    const today = dayKey(now(), offsetMin);
    const yesterday = dayKey(now() - 86400000, offsetMin);
    const dayBefore = dayKey(now() - 2 * 86400000, offsetMin);
    const motors = await store.activeMotors(dayStartMs(dayBefore, offsetMin), dayStartMs(today, offsetMin));
    let saved = 0;
    for (const { farmId, motor } of motors) {
      const have = await store.savedDays(farmId, motor, [dayBefore, yesterday]);
      const missing = [dayBefore, yesterday].filter((k) => !(have.has(k) && have.get(k).v === REPORT_VERSION));
      if (missing.length === 0) continue;
      const days = await compute(farmId, motor, missing);
      await store.saveDays(farmId, motor, days);
      saved += days.length;
    }
    if (saved) log.log(`[reports] rolled up ${saved} day(s)`);
  }

  let timer = null;
  return {
    getReport,
    rollUp,
    startRollUp(intervalMs = 60 * 60000) {
      if (timer) return;
      timer = setInterval(() => rollUp().catch((err) => log.error("[reports] roll-up failed:", err)), intervalMs);
      setTimeout(() => rollUp().catch((err) => log.error("[reports] roll-up failed:", err)), 60000);
    },
    // Request checks - throws a 400-status Error.
    parseRange(query) {
      const today = dayKey(now(), offsetMin);
      const to = DAY_RE.test(query.to || "") ? query.to : today;
      const from = DAY_RE.test(query.from || "") ? query.from : dayKey(now() - 6 * 86400000, offsetMin);
      if (from > to) throw Object.assign(new Error("'from' is after 'to'"), { status: 400 });
      if (dayKeysBetween(from, to).length > MAX_RANGE_DAYS) {
        throw Object.assign(new Error(`At most ${MAX_RANGE_DAYS} days at a time`), { status: 400 });
      }
      return { from, to };
    }
  };
}
