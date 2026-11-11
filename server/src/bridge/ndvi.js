// Crop health (NDVI) for the Irrigo app: each mapped valve's land is an
// irrigation zone; the NDVI worker (farmbuddie-web/ndvi) measures every
// zone from free Copernicus Sentinel-2 images; this file turns those
// numbers into what the farmer sees - a level per zone and plain advice.
//
// The level compares a zone with the farm's OTHER zones on the same image
// (same day, same haze, usually the same crop stage) and with its own last
// reading, more than with fixed thresholds: what is "low" depends heavily
// on the crop and its age. The crop's typical range is only a guide.
//
// NDVI never controls a pump or valve. It points at a zone to inspect; the
// water each zone got (valve run times, from Reports) says whether watering
// is the likely reason.
//
// Pure functions only - storage in ndviStore.js, routes in ndviRoutes.js.

import { balance, kcFor, leafLevel, waterStatus, windowDays } from "./ndviWater.js";

export const MAX_VALVE = 64;
export const MAX_ZONE_POINTS = 200;
const DAY_MS = 86400000;

// [low, high] typical NDVI at full canopy, days after sowing / planting to
// reach it (0 = perennial / orchard, always grown), and the crop group.
// Orchards and vines leave soil between plants, so their 10 m pixels read
// lower than a closed field crop. Same ids as the app's crop picker.
const C = (group, typical, canopyDays) => ({ group, typical, canopyDays });
export const CROPS = {
  // cereals and millets
  paddy: C("cereal", [0.6, 0.85], 60), maize: C("cereal", [0.65, 0.85], 55), sorghum: C("cereal", [0.55, 0.8], 60),
  pearl_millet: C("cereal", [0.5, 0.75], 50), finger_millet: C("cereal", [0.5, 0.75], 55), wheat: C("cereal", [0.6, 0.85], 60),
  // pulses
  black_gram: C("pulse", [0.5, 0.75], 45), green_gram: C("pulse", [0.5, 0.75], 45), red_gram: C("pulse", [0.55, 0.8], 90),
  bengal_gram: C("pulse", [0.5, 0.75], 50), cowpea: C("pulse", [0.5, 0.75], 45), horse_gram: C("pulse", [0.45, 0.7], 45),
  // oilseeds
  groundnut: C("oilseed", [0.55, 0.8], 50), sesame: C("oilseed", [0.45, 0.7], 45), sunflower: C("oilseed", [0.55, 0.8], 50),
  castor: C("oilseed", [0.5, 0.75], 70),
  // cash crops
  sugarcane: C("cash", [0.65, 0.85], 120), cotton: C("cash", [0.55, 0.8], 75), turmeric: C("cash", [0.55, 0.8], 90),
  tapioca: C("cash", [0.6, 0.85], 90), tobacco: C("cash", [0.55, 0.8], 60), betel: C("cash", [0.55, 0.8], 0),
  // vegetables
  tomato: C("vegetable", [0.5, 0.75], 50), brinjal: C("vegetable", [0.5, 0.75], 55), chilli: C("vegetable", [0.5, 0.75], 60),
  onion: C("vegetable", [0.4, 0.7], 50), bhindi: C("vegetable", [0.5, 0.75], 45), cabbage: C("vegetable", [0.5, 0.8], 50),
  cauliflower: C("vegetable", [0.5, 0.8], 50), potato: C("vegetable", [0.55, 0.8], 50), carrot: C("vegetable", [0.5, 0.75], 50),
  beans: C("vegetable", [0.5, 0.75], 45), cucumber: C("vegetable", [0.45, 0.75], 40), gourds: C("vegetable", [0.45, 0.75], 50),
  drumstick: C("vegetable", [0.45, 0.75], 0), greens: C("vegetable", [0.45, 0.75], 30), vegetables: C("vegetable", [0.45, 0.75], 45),
  // fruits
  banana: C("fruit", [0.65, 0.85], 150), mango: C("fruit", [0.45, 0.75], 0), guava: C("fruit", [0.45, 0.75], 0),
  papaya: C("fruit", [0.5, 0.8], 120), pomegranate: C("fruit", [0.4, 0.7], 0), lemon: C("fruit", [0.45, 0.75], 0),
  grapes: C("fruit", [0.4, 0.7], 0), sapota: C("fruit", [0.5, 0.8], 0), jackfruit: C("fruit", [0.55, 0.8], 0),
  watermelon: C("fruit", [0.4, 0.7], 45), muskmelon: C("fruit", [0.4, 0.7], 45), amla: C("fruit", [0.45, 0.75], 0),
  // plantation
  coconut: C("plantation", [0.55, 0.8], 0), arecanut: C("plantation", [0.6, 0.85], 0), tea: C("plantation", [0.6, 0.85], 0),
  coffee: C("plantation", [0.6, 0.85], 0),
  // flowers
  jasmine: C("flower", [0.45, 0.75], 0), marigold: C("flower", [0.5, 0.75], 45), rose: C("flower", [0.45, 0.75], 0),
  chrysanthemum: C("flower", [0.5, 0.75], 60),
  // others
  fodder: C("other", [0.6, 0.85], 45), other: C("other", null, null)
};

// Level thresholds (NDVI units).
export const LOW_VS_FARM = -0.1;
export const WATCH_VS_FARM = -0.05;
export const DROP = -0.1;
// A zone getting less than this share of the farm's typical water.
export const LOW_WATER_RATIO = 0.75;
export const WATER_DAYS = 14;
// Below this much water on the other valves, there's nothing to compare with.
export const MIN_COMPARE_WATER_SEC = 3600;
// Older than this, the reading is flagged (clouds hid the farm since).
export const OLD_OBS_DAYS = 20;
export const YOUNG_CROP_DAYS = 30;
// Weak spots covering this much of a valve's land make the valve "watch".
export const WEAK_AREA_WATCH_PCT = 10;
// A spot within this distance of one on an earlier image is the same spot.
export const SAME_SPOT_M = 25;
const RECENT_IMAGES = 4;

const metresBetween = (a, b) => {
  const k = Math.PI / 180;
  const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371008.8;
};

/**
 * The valve's weak spots on its newest image, labelled 1A, 1B, ... (largest /
 * worst first), each with how many of the last few clear images also had a
 * weak spot there: new (1) = something recent - pests, disease, a blocked
 * dripper; seen again and again = a lasting cause - soil, a dry line, gaps.
 * [recent]: the valve's usable rows, newest first (the current one included).
 */
export function weakSpotsView(valve, cur, recent) {
  const spots = Array.isArray(cur.weak_spots) ? cur.weak_spots : [];
  const earlier = recent.filter((r) => r.scene_id !== cur.scene_id).slice(0, RECENT_IMAGES - 1);
  return spots.map((sp, i) => {
    const label = `${valve}${String.fromCharCode(65 + i)}`;
    const seen = 1 + earlier.filter((r) => (Array.isArray(r.weak_spots) ? r.weak_spots : [])
      .some((o) => metresBetween(o, sp) <= SAME_SPOT_M)).length;
    const params = { label, acres: round(sp.area_m2 / 4046.86, 2), ndvi: round(sp.mean, 2), rest: round((cur.median ?? sp.mean + sp.drop), 2), times: seen };
    return {
      label, lat: sp.lat, lng: sp.lng, areaM2: sp.area_m2, areaAcres: params.acres, ndvi: params.ndvi,
      rest: params.rest, drop: round(sp.drop, 2), seenTimes: seen, outOf: 1 + earlier.length,
      persistent: seen >= 2,
      advice: advice(seen >= 2 ? "spot_persistent" : "spot_new", params)
    };
  });
}

/**
 * The valve's dry spots (leaf moisture clearly below the rest of the valve),
 * labelled 1D1, 1D2, ... and how often each was dry on the last clear images.
 */
export function drySpotsView(valve, cur, recent) {
  const spots = Array.isArray(cur.dry_spots) ? cur.dry_spots : [];
  const earlier = recent.filter((r) => r.scene_id !== cur.scene_id).slice(0, RECENT_IMAGES - 1);
  return spots.map((sp, i) => {
    const label = `${valve}D${i + 1}`;
    const seen = 1 + earlier.filter((r) => (Array.isArray(r.dry_spots) ? r.dry_spots : [])
      .some((o) => metresBetween(o, sp) <= SAME_SPOT_M)).length;
    return {
      label, lat: sp.lat, lng: sp.lng, areaM2: sp.area_m2, areaAcres: round(sp.area_m2 / 4046.86, 2),
      ndmi: round(sp.mean, 2), rest: round(cur.ndmi_median ?? sp.mean + sp.drop, 2), seenTimes: seen,
      outOf: 1 + earlier.length, persistent: seen >= 2
    };
  });
}

const bad = (message) => ({ status: 400, message });
const round = (x, d = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

export const zoneId = (farmId, valve) => `${farmId}-${valve}`;

/** "0003-5" -> { farmId: "0003", valve: 5 }, or null. */
export function parseZoneId(id) {
  const m = /^(\d{1,6})-(\d{1,2})$/.exec(String(id || ""));
  if (!m) return null;
  const valve = Number(m[2]);
  return valve >= 1 && valve <= MAX_VALVE ? { farmId: m[1], valve } : null;
}

function cleanPoints(points, label) {
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_ZONE_POINTS) {
    throw bad(`${label}: 1-${MAX_ZONE_POINTS} points required`);
  }
  return points.map((p, i) => {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw bad(`${label}: point ${i + 1} is not a valid location`);
    }
    return { lat: Math.round(lat * 1e7) / 1e7, lng: Math.round(lng * 1e7) / 1e7 };
  });
}

/** App's valve boundaries -> [{ valve, points, plottedAt }]; throws { status: 400 } on bad input. */
export function validateZones(input) {
  if (!Array.isArray(input) || input.length > MAX_VALVE) throw bad(`zones must be an array of at most ${MAX_VALVE}`);
  const seen = new Set();
  return input.map((z, i) => {
    const valve = z?.valve;
    if (!Number.isInteger(valve) || valve < 1 || valve > MAX_VALVE) throw bad(`Zone ${i + 1}: invalid valve`);
    if (seen.has(valve)) throw bad(`Valve ${valve} appears twice`);
    seen.add(valve);
    const plotted = Number(z.plottedAtMs);
    return {
      valve,
      points: cleanPoints(z.points, `Valve ${valve}`),
      plottedAt: Number.isFinite(plotted) && plotted > 0 ? new Date(plotted).toISOString() : null
    };
  });
}

/** { crop, sowingDate } -> cleaned; crop null clears it. */
export function validateCrop(body, now = Date.now()) {
  const crop = body?.crop === null || body?.crop === "" || body?.crop === undefined ? null : String(body.crop).toLowerCase();
  if (crop !== null && !Object.hasOwn(CROPS, crop)) throw bad("Unknown crop");
  let sowingDate = body?.sowingDate ?? null;
  if (sowingDate === "") sowingDate = null;
  if (sowingDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sowingDate) || Number.isNaN(Date.parse(`${sowingDate}T00:00:00Z`))) {
      throw bad("sowingDate must be YYYY-MM-DD");
    }
    const t = Date.parse(`${sowingDate}T00:00:00Z`);
    if (t > now + 2 * DAY_MS) throw bad("Sowing date is in the future");
    if (t < now - 30 * 365 * DAY_MS) throw bad("Sowing date is too old");
  }
  return { crop, sowingDate };
}

// A valve's flow: litres per hour (a drip valve is a few hundred to a few thousand).
export const MAX_FLOW_LPH = 200000;

/** { flowLph } -> a number, or null to clear; throws { status: 400 } on bad input. */
export function validateFlow(body) {
  const v = body?.flowLph;
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_FLOW_LPH) throw bad(`flowLph must be 0-${MAX_FLOW_LPH} litres per hour`);
  return Math.round(n * 10) / 10;
}

export const hasArea = (points) => Array.isArray(points) && points.length >= 3;

export function samePoints(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.lat - b[i].lat) < 1e-7 && Math.abs(p.lng - b[i].lng) < 1e-7);
}

/** Area of a small lat/lng polygon in m^2 (local flat projection; < 0.1 % off at farm size). */
export function areaM2(points) {
  if (!hasArea(points)) return 0;
  const lat0 = (points.reduce((s, p) => s + p.lat, 0) / points.length) * (Math.PI / 180);
  const R = 6371008.8;
  const xy = points.map((p) => [R * (p.lng * Math.PI / 180) * Math.cos(lat0), R * (p.lat * Math.PI / 180)]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** A valve's location: its pin, or the middle of its land. */
export function valvePoint(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (points.length < 3) return points[0];
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length
  };
}

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function cropAgeDays(sowingDate, atMs) {
  if (!sowingDate) return null;
  return Math.floor((atMs - Date.parse(`${sowingDate}T00:00:00Z`)) / DAY_MS);
}

const toMs = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));

function obsView(o) {
  if (!o) return null;
  return {
    sceneId: o.scene_id, acquiredAt: new Date(toMs(o.acquired_at)).toISOString(),
    mean: round(o.mean, 3), min: round(o.min, 3), max: round(o.max, 3), p10: round(o.p10, 3), p90: round(o.p90, 3),
    validPct: round(o.valid_pct, 0), pixels: o.pixels,
    ndmi: o.ndmi_usable ? round(o.ndmi_median, 3) : null
  };
}

const LEVEL_RANK = { good: 0, watch: 1, low: 2 };
const worse = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

/** Short plain-English advice text (the app shows its own translation of each code). */
export function adviceText(code, p = {}) {
  switch (code) {
    case "check_uniformity": return `Got ${p.lessPct}% less water than other valves. Check water reaches all of it.`;
    case "inspect_pest_nutrient": return "Water was normal. Check for pests, disease, nutrients.";
    case "inspect_zone": return "Walk this area. Look for what is different.";
    case "dropping": return `Vigour fell ${p.drop} in ${p.days} days. Check soon.`;
    case "below_typical": return `Below normal for this crop (${p.typical}).`;
    case "check_soil_moisture": return "Feel the soil at root depth before changing watering.";
    case "young_crop": return "Young crop - low value is normal.";
    case "old_observation": return `Reading is ${p.days} days old (clouds).`;
    case "spot_new": return `New weak spot ${p.label}. Check pests, disease, water.`;
    case "spot_persistent": return `Weak spot ${p.label}, ${p.times} times. Check soil and water reach.`;
    case "small_zone": return "Small area - value is approximate.";
    // water status
    case "water_early": return "Leaves drying. Water this valve soon.";
    case "water_short": return "Too little water. Check run time, emitters, pressure.";
    case "not_water": return "Water is fine. Check pests, disease, nutrients.";
    case "too_much_water": return "More water than needed. Cut run time.";
    case "rain_covered": return "Rain covered the need. You can skip a turn.";
    case "set_flow": return "Set valve flow for exact water.";
    case "leaf_old": return "Leaf reading is old (clouds).";
    default: return "";
  }
}

const advice = (code, params = {}) => ({ code, params, text: adviceText(code, params) });

/**
 * The farm's crop-health report.
 *   zones:     ndvi_zones rows (farm_id, valve, points, area_m2, crop, sowing_date)
 *   latest:    Map valve -> newest usable history row
 *   previous:  Map valve -> the usable row before it (>= 4 days earlier)
 *   sceneRows: usable history rows of the farm's newest clear image (every zone in it)
 *   water:     Map valve -> water seconds in the last WATER_DAYS days (null = unknown)
 */
export function buildFarmReport({ farmId, zones, latest, previous, recent = new Map(), sceneRows = [], water = null, status = null, latestScene = null, now = Date.now(), weather = [], waterWindow = null }) {
  const sceneMeans = new Map(sceneRows.map((r) => [r.valve, r.mean]));
  const sceneNdmi = new Map(sceneRows.filter((r) => r.ndmi_usable && Number.isFinite(r.ndmi_median)).map((r) => [r.valve, r.ndmi_median]));
  const window = windowDays(weather);
  const cropOf = new Map(zones.map((z) => [z.valve, z.crop || null]));
  const farmMedian = sceneMeans.size >= 2 ? median([...sceneMeans.values()]) : null;
  // A zone is compared with the median of the farm's OTHER zones (with two
  // zones, the farm median would sit halfway and hide the difference).
  const others = (m, valve, keep = () => true) => median([...m.entries()].filter(([v, x]) => v !== valve && keep(x)).map(([, x]) => x));
  const zoneValves = new Set(zones.map((z) => z.valve));
  const waterOf = (valve) => (water ? water.get(valve) ?? 0 : null);
  const waterOthers = (valve) => (water ? others(new Map([...zoneValves].map((v) => [v, waterOf(v)])), valve, (x) => x > 0) : null);

  const out = zones.map((z) => {
    const pts = z.points || [];
    const area = z.area_m2 ?? areaM2(pts);
    const sowing = z.sowing_date ? (z.sowing_date instanceof Date ? z.sowing_date.toISOString().slice(0, 10) : String(z.sowing_date).slice(0, 10)) : null;
    const base = {
      zoneId: zoneId(farmId, z.valve), valve: z.valve, crop: z.crop || null, sowingDate: sowing,
      areaM2: Math.round(area), areaAcres: round(area / 4046.86, 2), mapped: hasArea(pts),
      location: valvePoint(pts), points: hasArea(pts) ? pts : [], waterSec: water ? (water.get(z.valve) ?? 0) : null
    };
    base.flowLph = Number.isFinite(z.flow_lph) && z.flow_lph > 0 ? z.flow_lph : null;
    if (!base.mapped) return { ...base, level: "not_mapped", latest: null, previous: null, advice: [], water: null };
    const cur = latest.get(z.valve);
    if (!cur) {
      // No clear image yet - the weather balance can still say something.
      const ageNow = cropAgeDays(sowing, now);
      return { ...base, level: "waiting", latest: null, previous: null, advice: [],
        water: waterView({ z, base, cur: null, prev: null, vigour: "waiting", ageDays: ageNow, window, waterWindow, peers: null, now }) };
    }

    const prev = previous.get(z.valve) || null;
    const curMs = toMs(cur.acquired_at);
    const ageDays = cropAgeDays(sowing, curMs);
    const crop = CROPS[z.crop] || null;
    // Compared only with valves growing the same crop (a just-sown plot next
    // to a coconut garden always looks "low"). A crop with no other valve on
    // the farm is judged by its own trend and the crop's typical range only.
    // Valves with no crop set are compared with each other.
    const peers = new Map([...sceneMeans].filter(([v]) => v === z.valve || (cropOf.get(v) ?? null) === (z.crop ?? null)));
    const othersMean = peers.has(z.valve) && peers.size >= 2 ? others(peers, z.valve) : null;
    const vsFarm = othersMean !== null ? round(sceneMeans.get(z.valve) - othersMean, 3) : null;
    const change = prev ? round(cur.mean - prev.mean, 3) : null;
    const changeDays = prev ? Math.round((curMs - toMs(prev.acquired_at)) / DAY_MS) : null;

    let level = "good";
    const tips = [];
    if (vsFarm !== null && vsFarm <= LOW_VS_FARM) level = "low";
    else if (vsFarm !== null && vsFarm <= WATCH_VS_FARM) level = "watch";
    if (change !== null && change <= DROP && changeDays <= 45) {
      level = worse(level, vsFarm !== null && vsFarm <= WATCH_VS_FARM ? "low" : "watch");
      tips.push(advice("dropping", { drop: round(-change, 2), days: changeDays }));
    }
    const mature = crop && crop.typical && (crop.canopyDays === 0 || (ageDays !== null && ageDays >= crop.canopyDays));
    if (mature && cur.mean < crop.typical[0] - 0.1) {
      level = worse(level, "watch");
      tips.push(advice("below_typical", { crop: z.crop, typical: `${crop.typical[0]}-${crop.typical[1]}` }));
    }
    // Weak spots inside this valve's land, numbered for the field (1A, 1B, ...).
    const spots = weakSpotsView(z.valve, cur, recent.get(z.valve) || []);
    const weakPct = Number(cur.weak_pct) || 0;
    if (spots.length && weakPct >= WEAK_AREA_WATCH_PCT) level = worse(level, "watch");
    const peersNdmi = cur.scene_id === latestScene?.scene_id
      ? new Map([...sceneNdmi].filter(([v]) => v === z.valve || (cropOf.get(v) ?? null) === (z.crop ?? null))) : null;
    const waterInfo = waterView({ z, base, cur, prev, vigour: level, ageDays: cropAgeDays(sowing, now), window, waterWindow, peers: peersNdmi, now, recentRows: recent.get(z.valve) || [] });
    if (level !== "good" && waterInfo.level !== "unknown") {
      // The water status says whether water is the reason (water_short / not_water).
    } else if (level !== "good") {
      const w = waterOf(z.valve);
      const wOthers = waterOthers(z.valve);
      if (w !== null && wOthers && wOthers >= MIN_COMPARE_WATER_SEC) {
        const ratio = w / wOthers;
        if (ratio < LOW_WATER_RATIO) tips.unshift(advice("check_uniformity", { lessPct: Math.round((1 - ratio) * 100) }));
        else tips.unshift(advice("inspect_pest_nutrient"));
      } else {
        tips.unshift(advice("inspect_zone"));
      }
      tips.push(advice("check_soil_moisture"));
    }
    if (ageDays !== null && ageDays >= 0 && ageDays < YOUNG_CROP_DAYS) tips.push(advice("young_crop"));
    const obsAge = Math.floor((now - curMs) / DAY_MS);
    if (obsAge > OLD_OBS_DAYS) tips.push(advice("old_observation", { days: obsAge }));
    if (cur.pixels < 10) tips.push(advice("small_zone"));

    return {
      ...base, level, latest: obsView(cur), previous: obsView(prev),
      change: round(change, 3), changeDays, vsFarm: round(vsFarm, 3), cropAgeDays: ageDays,
      typical: crop?.typical || null,
      // Plain hours (a % against the other valves read as nonsense when one valve barely ran).
      waterOthersSec: water ? Math.round(waterOthers(z.valve) ?? 0) : null,
      advice: tips,
      zoneMedian: round(cur.median, 3), weakPct: round(weakPct, 1), uniformPct: spots.length ? round(100 - weakPct, 0) : 100,
      weakSpots: spots,
      water: waterInfo
    };
  });

  return {
    farmId, fieldId: farmId, generatedAt: new Date(now).toISOString(),
    latestImage: latestScene ? {
      sceneId: latestScene.scene_id, acquiredAt: new Date(toMs(latestScene.acquired_at)).toISOString(),
      clearPct: round(latestScene.clear_pct, 0)
    } : null,
    farmMedian: round(farmMedian, 3),
    satellite: statusView(status),
    summary: {
      zones: out.length, mapped: out.filter((z) => z.mapped).length,
      low: out.filter((z) => z.level === "low").length, watch: out.filter((z) => z.level === "watch").length,
      good: out.filter((z) => z.level === "good").length, waiting: out.filter((z) => z.level === "waiting").length,
      water: {
        stress: out.filter((z) => z.water?.level === "stress").length, watch: out.filter((z) => z.water?.level === "watch").length,
        ok: out.filter((z) => z.water?.level === "ok").length, unknown: out.filter((z) => z.mapped && (!z.water || z.water.level === "unknown")).length
      }
    },
    weather: window.length ? { lastDay: window[window.length - 1].day, days: window.length } : null,
    zones: out,
    note: "NDVI crop vigour (10 m) and leaf moisture (20 m) from satellite images, plus a weather water balance. Shows where to look - check on the ground. Never runs the pump."
  };
}

/** A valve's water block: leaf moisture, the 7-day balance, the combined level and short advice. */
function waterView({ z, base, cur, prev, vigour, ageDays, window, waterWindow, peers, now, recentRows = [] }) {
  const leaf = cur ? leafLevel({ valve: z.valve, cur, prev, peers, now }) : null;
  const { kc, basis } = kcFor(z.crop, ageDays, cur ? cur.mean : null);
  const irrigationSec = waterWindow ? (waterWindow.get(z.valve) ?? 0) : null;
  const bal = window.length ? balance({ days: window, kc, irrigationSec, flowLph: base.flowLph, areaM2: base.areaM2 }) : null;
  const st = waterStatus({ vigour, leaf, bal });
  return {
    level: st.level, tooMuch: st.tooMuch,
    leaf,
    balance: bal ? { ...bal, kc, kcBasis: basis, level: st.balanceLevel } : null,
    drySpots: cur && cur.ndmi_usable ? drySpotsView(z.valve, cur, recentRows) : [],
    dryPct: cur && cur.ndmi_usable ? round(Number(cur.dry_pct) || 0, 1) : null,
    advice: st.advice.map((code) => advice(code))
  };
}

export function statusView(s) {
  const iso = (t) => (t ? new Date(toMs(t)).toISOString() : null);
  return {
    lastCheckAt: iso(s?.last_check_at), lastSuccessAt: iso(s?.last_success_at), lastObservationAt: iso(s?.last_obs_at),
    refreshPending: !!s?.refresh_requested, lastError: s?.last_error || null, lastErrorAt: iso(s?.last_error_at)
  };
}

export const LEVEL_COLORS = { good: "#1a9641", watch: "#f9c62b", low: "#d7191c", waiting: "#9e9e9e", not_mapped: "#9e9e9e" };
export const WATER_COLORS = { ok: "#2c7fb8", watch: "#f9c62b", stress: "#a6611a", unknown: "#9e9e9e" };

/** GeoJSON for the map: each zone's polygon (or the valve pin) with its level, plus the heatmap picture. */
export function buildMapGeoJson(report, pointsByValve, map, mapDates = [], layer = "vigour") {
  const features = [];
  for (const z of report.zones) {
    const props = {
      zoneId: z.zoneId, valve: z.valve, level: z.level, color: LEVEL_COLORS[z.level] || "#9e9e9e",
      ndvi: z.latest?.mean ?? null, crop: z.crop, areaAcres: z.areaAcres,
      water: z.water?.level ?? null, waterColor: WATER_COLORS[z.water?.level] || "#9e9e9e", ndmi: z.water?.leaf?.ndmi ?? null
    };
    const zr = z.mapped ? ring(pointsByValve.get(z.valve)) : null;
    if (zr) {
      features.push({ type: "Feature", id: z.zoneId, geometry: { type: "Polygon", coordinates: [zr] }, properties: { kind: "zone", ...props } });
    }
    if (z.location) {
      features.push({ type: "Feature", id: `${z.zoneId}-valve`, geometry: { type: "Point", coordinates: [z.location.lng, z.location.lat] }, properties: { kind: "valve", ...props } });
    }
    for (const sp of z.water?.drySpots || []) {
      features.push({
        type: "Feature", id: `${z.zoneId}-${sp.label}`, geometry: { type: "Point", coordinates: [sp.lng, sp.lat] },
        properties: { kind: "dry_spot", zoneId: z.zoneId, valve: z.valve, label: sp.label, ndmi: sp.ndmi, rest: sp.rest, areaAcres: sp.areaAcres, persistent: sp.persistent }
      });
    }
    for (const sp of z.weakSpots || []) {
      features.push({
        type: "Feature", id: `${z.zoneId}-${sp.label}`, geometry: { type: "Point", coordinates: [sp.lng, sp.lat] },
        properties: { kind: "weak_spot", zoneId: z.zoneId, valve: z.valve, label: sp.label, ndvi: sp.ndvi, rest: sp.rest, areaAcres: sp.areaAcres, persistent: sp.persistent }
      });
    }
  }
  const png = layer === "water" ? map?.png_water : map?.png;
  return {
    type: "FeatureCollection", fieldId: report.fieldId, farmId: report.farmId, features, layer,
    image: map && png ? {
      sceneId: map.scene_id, acquiredAt: new Date(toMs(map.acquired_at)).toISOString(),
      bounds: { west: map.west, south: map.south, east: map.east, north: map.north },
      pngBase64: Buffer.from(png).toString("base64")
    } : null,
    imageDates: mapDates.map((d) => ({ sceneId: d.scene_id, acquiredAt: new Date(toMs(d.acquired_at)).toISOString() })),
    legend: [
      { ndvi: 0.1, color: "#d71c1c", label: "low" }, { ndvi: 0.45, color: "#fee059", label: "moderate" },
      { ndvi: 0.8, color: "#1a9641", label: "high" }
    ]
  };
}

/** A closed GeoJSON ring [[lng, lat], ...] from app points. */
export function ring(points) {
  if (!hasArea(points)) return null;
  const r = points.map((p) => [p.lng, p.lat]);
  r.push(r[0]);
  return r;
}

/** One reading per day (two overlapping tiles can see the same pass), the clearer one. */
export function historyView(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = new Date(toMs(r.acquired_at) + 330 * 60000).toISOString().slice(0, 10);
    const cur = byDay.get(day);
    if (!cur || r.valid_pixels > cur.valid_pixels) byDay.set(day, r);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, r]) => ({ date, ...obsView(r) }));
}
