// Dates and times as the admin shows them: 12-hour clock with AM / PM,
// e.g. "28 Oct 2026, 2:05 PM" or "2:05:33 PM". Built from the pieces
// Intl gives, so it reads the same in every browser and language setting
// (left to itself, toLocaleString() gives 24-hour or "pm" depending on the
// viewer's browser).
//
// Every function takes a Date, milliseconds, an ISO string or a Firestore
// Timestamp, and returns "-" for nothing / an invalid date.

const IST = "Asia/Kolkata";

function toDate(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v
    : typeof v?.toDate === "function" ? v.toDate()
    : typeof v?.seconds === "number" ? new Date(v.seconds * 1000)
    : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cache = new Map();
function parts(d, timeZone, seconds) {
  const key = `${timeZone || ""}|${seconds}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}),
      hour12: true, ...(timeZone ? { timeZone } : {})
    });
    cache.set(key, f);
  }
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}

function clock(o, seconds) {
  return `${Number(o.hour)}:${o.minute}${seconds ? `:${o.second}` : ""} ${String(o.dayPeriod || "").toUpperCase()}`;
}

/** "28 Oct 2026, 2:05 PM" (seconds: "2:05:33 PM"), in the viewer's time zone. */
export function fmtDateTime(v, { seconds = false, timeZone } = {}) {
  const d = toDate(v);
  if (!d) return "-";
  const o = parts(d, timeZone, seconds);
  return `${o.day} ${o.month} ${o.year}, ${clock(o, seconds)}`;
}

/** "2:05 PM" (seconds: "2:05:33 PM"). */
export function fmtTime(v, { seconds = false, timeZone } = {}) {
  const d = toDate(v);
  if (!d) return "-";
  return clock(parts(d, timeZone, seconds), seconds);
}

/** "28 Oct 2026" */
export function fmtDate(v, { timeZone } = {}) {
  const d = toDate(v);
  if (!d) return "-";
  const o = parts(d, timeZone, false);
  return `${o.day} ${o.month} ${o.year}`;
}

/** The farms' time (IST), whatever the viewer's zone - for device clocks / logs. */
export const fmtIstDateTime = (v, opts = {}) => fmtDateTime(v, { ...opts, timeZone: IST });
export const fmtIstTime = (v, opts = {}) => fmtTime(v, { ...opts, timeZone: IST });
