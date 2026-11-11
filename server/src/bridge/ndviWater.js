// Water status for crop health: is each valve's crop short of water?
//
// Two signals, each judged on its own, then combined:
//  1. Leaf moisture (NDMI) from the same satellite images as crop vigour -
//     water in the leaves, read only where the crop covers the ground. Like
//     vigour it is judged against the farm's other valves of the same crop
//     (same day, same weather) and against its own last reading. It usually
//     falls days BEFORE vigour does - the early warning.
//  2. The last 7 days' water balance: the crop's need (FAO-56: reference
//     evaporation x crop factor) against effective rain and, when the valve's
//     flow is set, the water its run time delivered (litres on its land = mm).
//
// Pure functions only (no database); used by ndvi.js's buildFarmReport.

const DAY_MS = 86400000;

// ---- crop factor (Kc), FAO-56 tables 11 / 12 ---------------------------
// Seasonal crops: [Kc ini, Kc mid, Kc end] and stage lengths [ini, dev, mid,
// late] in days from sowing. Perennials / orchards: one Kc (mature, the
// usual case on a farm with drip). Same ids as the crop picker / CROPS.
const S = (kc, stages) => ({ kc, stages });
const P = (kc) => ({ kc });
export const KC = {
  paddy: S([1.05, 1.2, 0.9], [30, 30, 60, 30]), maize: S([0.3, 1.2, 0.6], [25, 40, 45, 30]),
  sorghum: S([0.3, 1.0, 0.55], [20, 35, 40, 30]), pearl_millet: S([0.3, 1.0, 0.3], [15, 25, 40, 25]),
  finger_millet: S([0.3, 1.0, 0.3], [15, 25, 40, 25]), wheat: S([0.3, 1.15, 0.4], [15, 25, 50, 30]),
  black_gram: S([0.4, 1.05, 0.6], [20, 30, 35, 15]), green_gram: S([0.4, 1.05, 0.6], [20, 30, 35, 15]),
  red_gram: S([0.4, 1.15, 0.35], [20, 60, 60, 40]), bengal_gram: S([0.4, 1.0, 0.35], [20, 30, 35, 15]),
  cowpea: S([0.4, 1.05, 0.6], [20, 30, 35, 15]), horse_gram: S([0.4, 1.0, 0.35], [20, 30, 35, 15]),
  groundnut: S([0.4, 1.15, 0.6], [25, 35, 45, 25]), sesame: S([0.35, 1.1, 0.25], [20, 30, 40, 20]),
  sunflower: S([0.35, 1.05, 0.35], [25, 35, 45, 25]), castor: S([0.35, 1.15, 0.55], [25, 40, 65, 50]),
  sugarcane: S([0.4, 1.25, 0.75], [35, 60, 190, 120]), cotton: S([0.35, 1.15, 0.6], [30, 50, 60, 55]),
  turmeric: S([0.5, 1.05, 0.8], [30, 60, 120, 60]), tapioca: S([0.3, 0.8, 0.3], [20, 40, 90, 60]),
  tobacco: S([0.5, 1.1, 0.8], [20, 30, 30, 30]), betel: P(1.0),
  tomato: S([0.6, 1.15, 0.8], [30, 40, 40, 25]), brinjal: S([0.6, 1.05, 0.9], [30, 40, 40, 20]),
  chilli: S([0.6, 1.05, 0.9], [30, 35, 40, 20]), onion: S([0.7, 1.05, 0.75], [15, 25, 70, 40]),
  bhindi: S([0.6, 1.05, 0.9], [25, 30, 40, 20]), cabbage: S([0.7, 1.05, 0.95], [40, 60, 50, 15]),
  cauliflower: S([0.7, 1.05, 0.95], [35, 50, 40, 15]), potato: S([0.5, 1.15, 0.75], [25, 30, 45, 30]),
  carrot: S([0.7, 1.05, 0.95], [20, 30, 50, 20]), beans: S([0.5, 1.05, 0.9], [20, 30, 30, 10]),
  cucumber: S([0.6, 1.0, 0.75], [20, 30, 40, 15]), gourds: S([0.5, 1.0, 0.8], [25, 35, 50, 20]),
  drumstick: P(0.9), greens: S([0.7, 1.0, 0.95], [20, 20, 15, 5]), vegetables: S([0.6, 1.05, 0.9], [25, 35, 40, 20]),
  banana: S([0.5, 1.1, 1.0], [120, 90, 120, 60]), mango: P(0.9), guava: P(0.9),
  papaya: S([0.6, 1.0, 0.9], [60, 120, 180, 0]), pomegranate: P(0.8), lemon: P(0.7), grapes: P(0.8),
  sapota: P(0.9), jackfruit: P(0.9), watermelon: S([0.4, 1.0, 0.75], [20, 30, 30, 30]),
  muskmelon: S([0.5, 0.85, 0.6], [25, 35, 40, 20]), amla: P(0.8),
  coconut: P(1.0), arecanut: P(1.0), tea: P(1.0), coffee: P(1.0),
  jasmine: P(0.9), marigold: S([0.6, 1.05, 0.9], [20, 30, 40, 20]), rose: P(0.95),
  chrysanthemum: S([0.6, 1.05, 0.9], [20, 40, 50, 20]),
  fodder: P(1.0)
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Kc from the canopy itself (Kcb ~ 1.36 NDVI - 0.03, plus a little soil evaporation). */
export const kcFromNdvi = (ndvi) => clamp(1.36 * ndvi + 0.07, 0.3, 1.2);

/**
 * The crop factor for a valve today -> { kc, basis }. basis: "stage" (crop +
 * days since sowing, FAO-56 curve), "crop" (perennial), "canopy" (from the
 * valve's own NDVI: crop or sowing date not set) or "default" (1.0, nothing known).
 */
export function kcFor(cropId, ageDays, ndvi) {
  const c = KC[cropId];
  if (c && !c.stages) return { kc: c.kc, basis: "crop" };
  if (c && ageDays !== null && ageDays !== undefined && ageDays >= 0) {
    const [ini, mid, end] = c.kc;
    const [l1, l2, l3, l4] = c.stages;
    let kc;
    if (ageDays <= l1) kc = ini;
    else if (ageDays <= l1 + l2) kc = ini + (mid - ini) * (ageDays - l1) / l2;
    else if (ageDays <= l1 + l2 + l3) kc = mid;
    else if (l4 > 0 && ageDays <= l1 + l2 + l3 + l4) kc = mid + (end - mid) * (ageDays - l1 - l2 - l3) / l4;
    else kc = end;
    return { kc: round(kc, 2), basis: "stage" };
  }
  if (Number.isFinite(ndvi)) return { kc: round(kcFromNdvi(ndvi), 2), basis: "canopy" };
  return { kc: 1.0, basis: "default" };
}

// ---- 7-day water balance -------------------------------------------------
export const BALANCE_DAYS = 7;
// Rain below this on a day mostly wets leaves and evaporates; above it ~80% counts.
const RAIN_MIN_MM = 3;
const RAIN_EFFECTIVE = 0.8;
// Less need than this over the window (cool, cloudy, rainy weeks) - no verdict.
export const MIN_NEED_MM = 7;
// Supply / need: below these the valve is short of water.
export const COVER_STRESS = 0.5;
export const COVER_WATCH = 0.75;
// Over this, more water than the crop can use (waste, waterlogging, nutrients washed out).
export const COVER_TOO_MUCH = 1.6;

export const effectiveRain = (mm) => (Number.isFinite(mm) && mm >= RAIN_MIN_MM ? mm * RAIN_EFFECTIVE : 0);

/**
 * The window's balance. [days]: the weather days in the window (oldest first,
 * { day, rain_mm, et0_mm }); [irrigationSec]: the valve's run time over the
 * same days (null = unknown); [flowLph] / [areaM2] turn it into mm.
 */
export function balance({ days, kc, irrigationSec = null, flowLph = null, areaM2 = 0 }) {
  const usable = (days || []).filter((d) => Number.isFinite(d.et0_mm));
  if (!usable.length) return null;
  const needMm = usable.reduce((s, d) => s + d.et0_mm * kc, 0);
  const rainMm = usable.reduce((s, d) => s + (Number.isFinite(d.rain_mm) ? d.rain_mm : 0), 0);
  const effRainMm = usable.reduce((s, d) => s + effectiveRain(d.rain_mm), 0);
  const flowSet = Number.isFinite(flowLph) && flowLph > 0;
  const irrigationMm = flowSet && Number.isFinite(irrigationSec) && areaM2 > 0
    ? (irrigationSec / 3600) * flowLph / areaM2 : null;
  const supplyMm = effRainMm + (irrigationMm ?? 0);
  return {
    fromDay: usable[0].day, toDay: usable[usable.length - 1].day, days: usable.length,
    needMm: round(needMm), rainMm: round(rainMm), effRainMm: round(effRainMm),
    irrigationMm: round(irrigationMm), flowSet,
    // Share of the need met. Without the flow only rain is known - a floor, not the whole story.
    coverPct: needMm > 0 ? Math.round(100 * supplyMm / needMm) : null,
    rainCoverPct: needMm > 0 ? Math.round(100 * effRainMm / needMm) : null
  };
}

/** The balance's verdict: ok / watch / stress / too_much, or null (can't tell). */
export function balanceLevel(b) {
  if (!b || b.needMm === null || b.needMm < MIN_NEED_MM) return null;
  const cover = (b.coverPct ?? 0) / 100;
  if (!b.flowSet) return b.rainCoverPct !== null && b.rainCoverPct >= 100 ? "ok" : null;   // rain alone covered it
  if (cover < COVER_STRESS) return "stress";
  if (cover < COVER_WATCH) return "watch";
  if (cover > COVER_TOO_MUCH) return "too_much";
  return "ok";
}

// ---- leaf moisture (NDMI) --------------------------------------------------
// Against the other valves of the same crop on the same image.
export const LEAF_STRESS_VS = -0.08;
export const LEAF_WATCH_VS = -0.04;
// Fall since the valve's previous reading (within LEAF_CHANGE_DAYS).
export const LEAF_STRESS_DROP = -0.12;
export const LEAF_WATCH_DROP = -0.08;
const LEAF_CHANGE_DAYS = 30;
// A full canopy (NDVI >= this) with leaves this dry is short of water whatever the others do.
const FULL_CANOPY_NDVI = 0.5;
export const LEAF_ABS_STRESS = -0.05;
export const LEAF_ABS_WATCH = 0.05;
// Leaf moisture changes within days: an older reading is shown but not judged.
export const LEAF_FRESH_DAYS = 15;

/** What a leaf moisture value means, for display: dry / low / moist / wet. */
export function leafMeaning(ndmi) {
  if (!Number.isFinite(ndmi)) return null;
  if (ndmi < 0) return "dry";
  if (ndmi < 0.15) return "low";
  if (ndmi < 0.3) return "moist";
  return "wet";
}

/**
 * -> { level: ok / watch / stress / null, ndmi, meaning, vsPeers, change, changeDays, acquiredAt, fresh }
 * [cur]/[prev]: history rows (ndmi_usable, ndmi_median, mean, acquired_at); [peers]: Map valve -> ndmi
 * of the same-crop valves on the same image (this valve included).
 */
export function leafLevel({ valve, cur, prev, peers, now }) {
  if (!cur || !cur.ndmi_usable || !Number.isFinite(cur.ndmi_median)) return null;
  const at = toMs(cur.acquired_at);
  const ndmi = cur.ndmi_median;
  const others = [...(peers || new Map()).entries()].filter(([v, x]) => v !== valve && Number.isFinite(x)).map(([, x]) => x);
  const vsPeers = others.length ? ndmi - median(others) : null;
  const prevOk = prev && prev.ndmi_usable && Number.isFinite(prev.ndmi_median);
  const changeDays = prevOk ? Math.round((at - toMs(prev.acquired_at)) / DAY_MS) : null;
  const change = prevOk && changeDays <= LEAF_CHANGE_DAYS ? ndmi - prev.ndmi_median : null;
  const fresh = now - at <= LEAF_FRESH_DAYS * DAY_MS;
  let level = "ok";
  if (vsPeers !== null && vsPeers <= LEAF_STRESS_VS) level = "stress";
  else if (vsPeers !== null && vsPeers <= LEAF_WATCH_VS) level = "watch";
  if (change !== null && change <= LEAF_STRESS_DROP) level = worst(level, "stress");
  else if (change !== null && change <= LEAF_WATCH_DROP) level = worst(level, "watch");
  if (Number.isFinite(cur.mean) && cur.mean >= FULL_CANOPY_NDVI) {
    if (ndmi < LEAF_ABS_STRESS) level = worst(level, "stress");
    else if (ndmi < LEAF_ABS_WATCH) level = worst(level, "watch");
  }
  return {
    level: fresh ? level : null, ndmi: round(ndmi, 2), meaning: leafMeaning(ndmi),
    vsPeers: round(vsPeers, 2), change: round(change, 2), changeDays: change !== null ? changeDays : null,
    acquiredAt: new Date(at).toISOString(), fresh
  };
}

// ---- combined -----------------------------------------------------------
const RANK = { ok: 0, too_much: 0, watch: 1, stress: 2 };
export const worst = (a, b) => (a === null || a === undefined ? b : b === null || b === undefined ? a : RANK[b] > RANK[a] ? b : a);

/**
 * A valve's water status and its short advice codes.
 * [vigour]: the valve's crop-vigour level (good / watch / low / waiting).
 * -> { level: ok / watch / stress / unknown, leaf, balance, balanceLevel, tooMuch, advice: [codes] }
 */
export function waterStatus({ vigour, leaf, bal }) {
  const bl = balanceLevel(bal);
  const tooMuch = bl === "too_much";
  let level = worst(leaf?.level ?? null, bl === "too_much" ? "ok" : bl);
  if (level === null) level = "unknown";
  const advice = [];
  const vigourBad = vigour === "low" || vigour === "watch";
  if (level === "stress" || level === "watch") {
    advice.push(vigourBad ? "water_short" : "water_early");
  } else if (level === "ok" && vigourBad) {
    advice.push("not_water");
  }
  if (tooMuch) advice.push("too_much_water");
  if (bal && !bal.flowSet) advice.push("set_flow");
  if (bal && bal.rainCoverPct !== null && bal.rainCoverPct >= 100 && level !== "stress") advice.push("rain_covered");
  if (leaf && !leaf.fresh) advice.push("leaf_old");
  return { level, balanceLevel: bl, tooMuch, advice };
}

/** The weather days in the window ending at the newest day with data (at most [n] days). */
export function windowDays(weather, n = BALANCE_DAYS) {
  const rows = (weather || []).filter((d) => Number.isFinite(d.et0_mm)).sort((a, b) => (dayOf(a.day) < dayOf(b.day) ? -1 : 1));
  if (!rows.length) return [];
  const last = Date.parse(`${dayOf(rows[rows.length - 1].day)}T00:00:00Z`);
  const first = last - (n - 1) * DAY_MS;
  return rows.filter((d) => Date.parse(`${dayOf(d.day)}T00:00:00Z`) >= first).map((d) => ({ ...d, day: dayOf(d.day) }));
}

export const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const toMs = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
