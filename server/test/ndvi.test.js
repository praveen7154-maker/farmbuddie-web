// Crop health (NDVI): levels and advice, the endpoints, and (opt-in,
// PG_TEST_URL) the Postgres store with the worker's tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  areaM2, buildFarmReport, buildMapGeoJson, historyView, parseZoneId, validateCrop, validateZones, samePoints, valvePoint
} from "../src/bridge/ndvi.js";
import { createNdviRouter } from "../src/bridge/ndviRoutes.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-09T06:00:00Z");
const sq = (lat, lng, d = 0.00055) => [{ lat, lng }, { lat, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng }];
const obs = (valve, mean, daysAgo, scene = `S${daysAgo}`, extra = {}) => ({
  farm_id: "0003", valve, scene_id: scene, acquired_at: new Date(NOW - daysAgo * DAY), mean, min: mean - 0.05, max: mean + 0.05,
  p10: mean - 0.04, p90: mean + 0.04, std: 0.02, pixels: 25, valid_pixels: 25, valid_pct: 100, usable: true, ...extra
});
const zone = (valve, extra = {}) => ({ farm_id: "0003", valve, points: sq(11.45, 77.68 + valve * 0.001), area_m2: 3656, crop: null, sowing_date: null, ...extra });

test("zone input is validated", () => {
  assert.deepEqual(validateZones([{ valve: 2, points: sq(11.45, 77.68), plottedAtMs: 1 }])[0].points.length, 4);
  assert.throws(() => validateZones([{ valve: 0, points: sq(1, 1) }]), (e) => /invalid valve/.test(e.message));
  assert.throws(() => validateZones([{ valve: 1, points: [] }]), (e) => /points required/.test(e.message));
  assert.throws(() => validateZones([{ valve: 1, points: [{ lat: 95, lng: 1 }] }]), (e) => /not a valid location/.test(e.message));
  assert.throws(() => validateZones([{ valve: 1, points: sq(1, 1) }, { valve: 1, points: sq(1, 1) }]), (e) => /twice/.test(e.message));
  assert.throws(() => validateZones("x"), (e) => /array/.test(e.message));
  assert.equal(validateZones([{ valve: 3, points: [{ lat: 11.45, lng: 77.68 }] }])[0].points.length, 1); // a pin is kept
});

test("crop input is validated", () => {
  assert.deepEqual(validateCrop({ crop: "Sugarcane", sowingDate: "2026-06-01" }, NOW), { crop: "sugarcane", sowingDate: "2026-06-01" });
  assert.deepEqual(validateCrop({ crop: "", sowingDate: "" }, NOW), { crop: null, sowingDate: null });
  assert.throws(() => validateCrop({ crop: "rice2" }, NOW), (e) => /Unknown crop/.test(e.message));
  assert.throws(() => validateCrop({ crop: "paddy", sowingDate: "2026-12-30" }, NOW), (e) => /future/.test(e.message));
  assert.throws(() => validateCrop({ crop: "paddy", sowingDate: "1/2/2026" }, NOW), (e) => /YYYY-MM-DD/.test(e.message));
});

test("zone ids, area, location", () => {
  assert.deepEqual(parseZoneId("0003-5"), { farmId: "0003", valve: 5 });
  assert.equal(parseZoneId("0003-0"), null);
  assert.equal(parseZoneId("0003-65"), null);
  assert.equal(parseZoneId("abc"), null);
  const a = areaM2(sq(11.45, 77.68));
  assert.ok(a > 3600 && a < 3720, String(a));       // same as the worker's 3656 m^2 within 1 %
  assert.equal(areaM2(sq(11.45, 77.68).slice(0, 2)), 0);
  assert.ok(samePoints(sq(1, 2), sq(1, 2)) && !samePoints(sq(1, 2), sq(1, 2.0001)));
  assert.deepEqual(valvePoint([{ lat: 1, lng: 2 }]), { lat: 1, lng: 2 });
});

function rep({ zones, latest = [], previous = [], scene = latest, water = null }) {
  return buildFarmReport({
    farmId: "0003", zones, latest: new Map(latest.map((o) => [o.valve, o])),
    previous: new Map(previous.map((o) => [o.valve, o])), sceneRows: scene, water,
    latestScene: { scene_id: "S2", acquired_at: new Date(NOW - 2 * DAY), clear_pct: 100 }, now: NOW
  });
}
const byValve = (r) => Object.fromEntries(r.zones.map((z) => [z.valve, z]));

test("a zone well below the farm's others is low; water decides the advice", () => {
  const latest = [obs(1, 0.72, 2, "S2"), obs(2, 0.7, 2, "S2"), obs(3, 0.55, 2, "S2"), obs(4, 0.64, 2, "S2")];
  // valve 3 got much less water -> uniformity; valve 4 (watch) got the same -> pests / nutrients
  const r = rep({ zones: [zone(1), zone(2), zone(3), zone(4)], latest, water: new Map([[1, 7200], [2, 7000], [3, 3000], [4, 7100]]) });
  const z = byValve(r);
  assert.equal(r.farmMedian, 0.67);
  assert.equal(z[1].level, "good");
  assert.equal(z[3].level, "low");
  assert.equal(z[3].advice[0].code, "check_uniformity");
  assert.equal(z[3].advice[0].params.lessPct, 58);    // 3000 s vs the others' median 7100 s
  assert.equal(z[3].waterSec, 3000);
  assert.equal(z[3].waterOthersSec, 7100);
  for (const zz of r.zones) for (const a of zz.advice) assert.doesNotMatch(a.text, /dripper|lateral|drip line|valve,/i);
  assert.ok(z[3].advice.some((a) => a.code === "check_soil_moisture"));
  assert.equal(z[4].level, "watch");
  assert.equal(z[4].advice[0].code, "inspect_pest_nutrient");
  assert.deepEqual(z[1].advice, []);
  assert.deepEqual(r.summary, { zones: 4, mapped: 4, low: 1, watch: 1, good: 2, waiting: 0, water: { stress: 0, watch: 0, ok: 0, unknown: 4 } });
});

test("water isn't compared when the other valves barely ran", () => {
  const latest = [obs(1, 0.7, 2, "S2"), obs(2, 0.5, 2, "S2")];
  const z = byValve(rep({ zones: [zone(1), zone(2)], latest, water: new Map([[1, 600], [2, 12600]]) }));
  assert.equal(z[2].level, "low");
  assert.equal(z[2].advice[0].code, "inspect_zone");       // valve 1 ran 10 min - nothing to compare with
  assert.equal(z[2].waterSec, 12600);
});

test("without water data the advice is to inspect; never a pump action", () => {
  const latest = [obs(1, 0.7, 2, "S2"), obs(2, 0.5, 2, "S2")];
  const z = byValve(rep({ zones: [zone(1), zone(2)], latest }));
  assert.equal(z[2].level, "low");
  assert.equal(z[2].advice[0].code, "inspect_zone");
  for (const a of z[2].advice) assert.doesNotMatch(a.text, /turn on|start the (pump|motor)/i);
});

test("a fast drop against its own history is flagged even when the farm agrees", () => {
  const latest = [obs(1, 0.5, 2, "S2")];
  const previous = [obs(1, 0.68, 12, "S12")];
  const z = byValve(rep({ zones: [zone(1)], latest, previous }));
  assert.equal(z[1].level, "watch");
  assert.equal(z[1].change, -0.18);
  assert.equal(z[1].advice.find((a) => a.code === "dropping").params.days, 10);
});

test("crop guide: below typical only for a grown crop; young crop note", () => {
  const grown = byValve(rep({ zones: [zone(1, { crop: "sugarcane", sowing_date: "2026-03-01" })], latest: [obs(1, 0.45, 2, "S2")] }));
  assert.equal(grown[1].level, "watch");
  assert.ok(grown[1].advice.some((a) => a.code === "below_typical"));
  const young = byValve(rep({ zones: [zone(1, { crop: "sugarcane", sowing_date: "2026-10-20" })], latest: [obs(1, 0.25, 2, "S2")] }));
  assert.equal(young[1].level, "good");
  assert.ok(young[1].advice.some((a) => a.code === "young_crop"));
});

test("pins and lines aren't measured; zones without a clear image are waiting", () => {
  const z = byValve(rep({ zones: [zone(1), zone(2, { points: [{ lat: 11.45, lng: 77.68 }] })], latest: [] }));
  assert.equal(z[1].level, "waiting");
  assert.equal(z[2].level, "not_mapped");
  assert.deepEqual(z[2].location, { lat: 11.45, lng: 77.68 });
  assert.equal(z[1].points.length, 4);                     // the app draws the zone from these
  assert.deepEqual(z[2].points, []);
});

test("valves are compared only with valves of the same crop", () => {
  const zones = [zone(1, { crop: "coconut" }), zone(2, { crop: "coconut" }), zone(3, { crop: "watermelon", sowing_date: "2026-11-01" }),
    zone(4), zone(5)];
  const latest = [obs(1, 0.7, 2, "S2"), obs(2, 0.56, 2, "S2"), obs(3, 0.25, 2, "S2"), obs(4, 0.6, 2, "S2"), obs(5, 0.3, 2, "S2")];
  const z = byValve(rep({ zones, latest }));
  assert.equal(z[2].vsFarm, -0.14);          // coconut vs coconut
  assert.equal(z[2].level, "low");
  assert.equal(z[3].vsFarm, null);           // the only watermelon: no comparison with the coconut
  assert.equal(z[3].level, "good");
  assert.ok(z[3].advice.some((a) => a.code === "young_crop"));
  assert.equal(z[5].vsFarm, -0.3);           // no crop set: compared with the other unset valve
  assert.equal(z[5].level, "low");
});

test("an old reading says so", () => {
  const z = byValve(rep({ zones: [zone(1)], latest: [obs(1, 0.7, 30, "S30")], scene: [] }));
  assert.equal(z[1].advice.find((a) => a.code === "old_observation").params.days, 30);
});

test("weak spots inside a valve: labelled, new vs seen again, valve goes to watch", () => {
  const spotA = { pixels: 30, area_m2: 3000, mean: 0.38, min: 0.3, drop: 0.3, lat: 11.4501, lng: 77.6801 };
  const spotB = { pixels: 5, area_m2: 500, mean: 0.5, min: 0.45, drop: 0.18, lat: 11.4504, lng: 77.6806 };
  const cur = obs(1, 0.66, 2, "S2", { median: 0.68, weak_spots: [spotA, spotB], weak_pct: 12.5 });
  // spot A (moved 10 m) was there on the two earlier images; B is new
  const near = { ...spotA, lat: spotA.lat + 0.00009 };
  const recent = [cur, obs(1, 0.7, 12, "S12", { weak_spots: [near] }), obs(1, 0.7, 22, "S22", { weak_spots: [near] }), obs(1, 0.7, 32, "S32", { weak_spots: [] })];
  const r = buildFarmReport({
    farmId: "0003", zones: [zone(1)], latest: new Map([[1, cur]]), previous: new Map(), recent: new Map([[1, recent]]),
    sceneRows: [cur], now: NOW
  });
  const z = r.zones[0];
  assert.equal(z.level, "watch");                          // 12.5 % of the land is weak
  assert.equal(z.uniformPct, 88);
  assert.deepEqual(z.weakSpots.map((w) => [w.label, w.seenTimes, w.outOf, w.persistent]), [["1A", 3, 4, true], ["1B", 1, 4, false]]);
  assert.equal(z.weakSpots[0].advice.code, "spot_persistent");
  assert.equal(z.weakSpots[1].advice.code, "spot_new");
  assert.equal(z.weakSpots[0].areaAcres, 0.74);
  assert.match(z.weakSpots[1].advice.text, /New weak spot 1B\./);
  for (const zz of r.zones) for (const a of zz.advice) assert.ok(a.text.length <= 60, a.text);   // short and crisp
  const g = buildMapGeoJson(r, new Map([[1, zone(1).points]]), null, []);
  assert.deepEqual(g.features.filter((f) => f.properties.kind === "weak_spot").map((f) => f.properties.label), ["1A", "1B"]);
});

test("a valve with small weak spots stays good; one without any says 100 % even", () => {
  const cur = obs(1, 0.7, 2, "S2", { median: 0.7, weak_spots: [{ pixels: 3, area_m2: 300, mean: 0.5, min: 0.5, drop: 0.2, lat: 11.45, lng: 77.68 }], weak_pct: 2 });
  const r = buildFarmReport({ farmId: "0003", zones: [zone(1), zone(2)], latest: new Map([[1, cur], [2, obs(2, 0.7, 2, "S2")]]), previous: new Map(), sceneRows: [cur, obs(2, 0.7, 2, "S2")], now: NOW });
  assert.equal(r.zones[0].level, "good");
  assert.equal(r.zones[0].weakSpots.length, 1);
  assert.equal(r.zones[1].uniformPct, 100);
});

test("history keeps one reading per day, the clearer tile", () => {
  const h = historyView([obs(1, 0.6, 5, "A", { valid_pixels: 10 }), obs(1, 0.62, 5, "B", { valid_pixels: 25 }), obs(1, 0.5, 15, "C")]);
  assert.equal(h.length, 2);
  assert.equal(h[1].sceneId, "B");
  assert.ok(h[0].date < h[1].date);
});

test("map GeoJSON: zone polygons, valve points, picture", () => {
  const zones = [zone(1), zone(2, { points: [{ lat: 11.45, lng: 77.69 }] })];
  const r = rep({ zones, latest: [obs(1, 0.7, 2, "S2")] });
  const map = { scene_id: "S2", acquired_at: new Date(NOW - 2 * DAY), west: 77.68, south: 11.45, east: 77.69, north: 11.46, png: Buffer.from([137, 80, 78, 71]) };
  const g = buildMapGeoJson(r, new Map(zones.map((z) => [z.valve, z.points])), map, [map]);
  assert.equal(g.type, "FeatureCollection");
  const poly = g.features.find((f) => f.geometry.type === "Polygon");
  assert.equal(poly.properties.zoneId, "0003-1");
  const ring = poly.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring[0][0], zones[0].points[0].lng);           // GeoJSON order: lng, lat
  assert.equal(g.features.filter((f) => f.properties.kind === "valve").length, 2);
  assert.equal(g.image.pngBase64, "iVBORw==");
  assert.equal(g.image.bounds.north, 11.46);
});

// ------------------------------------------------------------------ routes

function fakeStore() {
  const zones = new Map();
  const calls = [];
  return {
    calls,
    async zones(farmId) { return [...zones.values()].filter((z) => z.farm_id === farmId); },
    async saveZones(farmId, zs, who) { calls.push(["save", farmId, zs.length, who]); for (const z of zs) zones.set(`${farmId}-${z.valve}`, { farm_id: farmId, valve: z.valve, points: z.points, crop: null }); return { changed: zs.length }; },
    async setCrop(farmId, valve, crop, sowingDate) { const z = zones.get(`${farmId}-${valve}`); if (!z) return null; Object.assign(z, { crop, sowing_date: sowingDate }); return { valve, crop, sowing_date: sowingDate }; },
    async deleteZone(farmId, valve) { return zones.delete(`${farmId}-${valve}`); },
    async latestAndPrevious() { return { latest: new Map([[1, obs(1, 0.7, 2, "S2")], [2, obs(2, 0.52, 2, "S2")]]), previous: new Map() }; },
    async latestOkScene() { return { scene_id: "S2", acquired_at: new Date(NOW - 2 * DAY), clear_pct: 100 }; },
    async sceneRows() { return [obs(1, 0.7, 2, "S2"), obs(2, 0.52, 2, "S2")]; },
    async history() { return [obs(1, 0.6, 20, "S20"), obs(1, 0.7, 2, "S2")]; },
    async map() { return null; },
    async mapDates() { return []; },
    async status() { return { last_check_at: new Date(NOW - 3600000), last_obs_at: new Date(NOW - 2 * DAY) }; },
    async sceneSummary() { return { counts: { ok: 1, cloudy: 3 }, recent: [{ scene_id: "S2", acquired_at: new Date(NOW - 2 * DAY), cloud_cover: 40.4, status: "ok", clear_pct: 100 }] }; }
  };
}

async function serve(store, { phone = "+919999999999", farms = ["0003"] } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.decodedToken = { phone_number: phone }; next(); });
  app.use("/api", createNdviRouter({
    store, canAccessFarm: async (_t, farmId) => farms.includes(farmId),
    water: async () => new Map([[1, 7200], [2, 2000]]), now: () => NOW, log: { error() {}, warn() {} }
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("endpoints: save zones, set crop, read report / map / history / status", async () => {
  const store = fakeStore();
  const s = await serve(store);
  try {
    let r = await s.call("PUT", "/farms/0003/zones", { zones: [{ valve: 1, points: sq(11.45, 77.68) }, { valve: 2, points: sq(11.45, 77.681) }] });
    assert.equal(r.status, 200);
    assert.deepEqual(store.calls[0], ["save", "0003", 2, "+919999999999"]);
    r = await s.call("PUT", "/zones/0003-1/crop", { crop: "turmeric", sowingDate: "2026-07-01" });
    assert.deepEqual(r.body, { zoneId: "0003-1", crop: "turmeric", sowingDate: "2026-07-01" });
    assert.equal((await s.call("PUT", "/zones/0003-2/crop", { crop: "turmeric" })).status, 200);   // same crop: compared
    assert.equal((await s.call("PUT", "/zones/0003-9/crop", { crop: "paddy" })).status, 404);
    assert.equal((await s.call("PUT", "/zones/0003-1/crop", { crop: "x" })).status, 400);

    r = await s.call("GET", "/farms/0003/ndvi");
    assert.equal(r.status, 200);
    const z2 = r.body.zones.find((z) => z.valve === 2);
    assert.equal(z2.level, "low");
    assert.equal(z2.advice[0].code, "check_uniformity");     // 2000 s vs 7200 s
    assert.equal(r.body.zones[0].crop, "turmeric");

    r = await s.call("GET", "/fields/0003/ndvi-map");
    assert.match(r.type, /application\/geo\+json/);
    assert.equal(r.body.type, "FeatureCollection");
    assert.equal(r.body.image, null);

    r = await s.call("GET", "/zones/0003-2/ndvi");
    assert.equal(r.body.zone.zoneId, "0003-2");
    assert.equal((await s.call("GET", "/zones/0003-7/ndvi")).status, 404);

    r = await s.call("GET", "/zones/0003-1/ndvi-history?days=90");
    assert.equal(r.body.history.length, 2);
    assert.equal(r.body.days, 90);

    r = await s.call("GET", "/farms/0003/satellite-status");
    assert.equal(r.body.images.cloudy, 3);
    assert.equal(r.body.recent[0].tileCloudPct, 40);
    assert.equal(r.body.zonesMapped, 2);

    assert.equal((await s.call("DELETE", "/zones/0003-2")).status, 200);
    assert.equal((await s.call("DELETE", "/zones/0003-2")).status, 404);
  } finally {
    await s.close();
  }
});

test("endpoints: other farms are refused, bad ids rejected", async () => {
  const s = await serve(fakeStore(), { farms: ["0002"] });
  try {
    assert.equal((await s.call("GET", "/farms/0003/ndvi")).status, 403);
    assert.equal((await s.call("GET", "/zones/0003-1/ndvi-history")).status, 403);
    assert.equal((await s.call("PUT", "/farms/0003/zones", { zones: [] })).status, 403);
    assert.equal((await s.call("GET", "/farms/abc/ndvi")).status, 400);
    assert.equal((await s.call("GET", "/zones/0003/ndvi")).status, 400);
    assert.equal((await s.call("PUT", "/farms/0002/zones", { zones: [{ valve: 99, points: [] }] })).status, 400);
  } finally {
    await s.close();
  }
});

test("endpoints: valve flow, water layer, irrigation over the weather window", async () => {
  const store = fakeStore();
  const days = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ day: `2026-11-0${i + 1}`, rain_mm: 0, et0_mm: 4 }));
  store.weather = async () => days;
  store.setFlow = async (farmId, valve, flowLph) => {
    const z = (await store.zones(farmId)).find((x) => x.valve === valve);
    if (!z) return null;
    z.flow_lph = flowLph;
    return { valve, flow_lph: flowLph };
  };
  store.map = async () => ({ scene_id: "S2", acquired_at: new Date(NOW), west: 0, south: 0, east: 1, north: 1, png: Buffer.from("V"), png_water: Buffer.from("W") });
  const waterCalls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.decodedToken = { phone_number: "+91" }; next(); });
  app.use("/api", createNdviRouter({
    store, canAccessFarm: async () => true, now: () => NOW, log: { error() {}, warn() {} },
    water: async (farmId, n, endMs) => { waterCalls.push([n, endMs ? new Date(endMs).toISOString().slice(0, 10) : null]); return new Map([[1, 30 * 3600]]); }
  }));
  const server = await new Promise((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    await call("PUT", "/farms/0003/zones", { zones: [{ valve: 1, points: sq(11.45, 77.68) }] });
    let r = await call("PUT", "/zones/0003-1/flow", { flowLph: 2500 });
    assert.deepEqual(r.body, { zoneId: "0003-1", flowLph: 2500 });
    assert.equal((await call("PUT", "/zones/0003-1/flow", { flowLph: -1 })).status, 400);
    assert.equal((await call("PUT", "/zones/0003-7/flow", { flowLph: 100 })).status, 404);
    r = await call("GET", "/farms/0003/ndvi");
    const z1 = r.body.zones.find((z) => z.valve === 1);
    assert.equal(z1.flowLph, 2500);
    assert.equal(z1.water.balance.days, 7);
    assert.equal(z1.water.balance.toDay, "2026-11-09");
    assert.ok(z1.water.balance.irrigationMm > 0);
    assert.deepEqual(waterCalls.find((c) => c[1] !== null), [7, "2026-11-09"]);   // same 7 days as the weather
    assert.ok(r.body.summary.water);
    r = await call("GET", "/fields/0003/ndvi-map?layer=water");
    assert.equal(Buffer.from(r.body.image.pngBase64, "base64").toString(), "W");
    r = await call("GET", "/fields/0003/ndvi-map");
    assert.equal(Buffer.from(r.body.image.pngBase64, "base64").toString(), "V");
    // the weather lookup failing must not break the report
    store.weather = async () => { throw new Error("db down"); };
    assert.equal((await call("GET", "/farms/0003/ndvi")).status, 200);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

// ------------------------------------------------------------------ Postgres (opt-in)

const url = process.env.PG_TEST_URL;
test("ndvi store against a real database", { skip: url ? false : "set PG_TEST_URL to run" }, async () => {
  process.env.BRIDGE_PG_CONNECTION_STRING = url;
  const { pool } = await import("../src/bridge/postgres.js");
  const { ensureNdviSchema, createNdviStore } = await import("../src/bridge/ndviStore.js");
  try {
    await pool.query("DROP TABLE IF EXISTS ndvi_maps, ndvi_history, ndvi_farm_scenes, ndvi_scenes, ndvi_zones, ndvi_status, ndvi_weather CASCADE");
    await ensureNdviSchema();
    await ensureNdviSchema();
    const st = createNdviStore(pool);
    assert.deepEqual(await st.saveZones("0003", validateZones([{ valve: 1, points: sq(11.45, 77.68) }, { valve: 2, points: sq(11.45, 77.681) }]), "t"), { changed: 2 });
    assert.equal((await st.status("0003")).refresh_requested !== null, true);
    assert.ok((await st.setCrop("0003", 1, "paddy", "2026-08-01", "t")));
    assert.equal(await st.setCrop("0003", 9, "paddy", null, "t"), null);

    // what the worker writes
    const scene = async (id, daysAgo) => {
      await pool.query("INSERT INTO ndvi_scenes (scene_id, tile, acquired_at, cloud_cover) VALUES ($1, 'T', $2, 30)", [id, new Date(Date.now() - daysAgo * DAY)]);
      await pool.query("INSERT INTO ndvi_farm_scenes (farm_id, scene_id, status, clear_pct) VALUES ('0003', $1, 'ok', 100)", [id]);
      for (const [v, m] of [[1, 0.7], [2, 0.5]]) {
        await pool.query(`INSERT INTO ndvi_history (farm_id, valve, scene_id, acquired_at, mean, min, max, p10, p90, std, pixels, valid_pixels, valid_pct, usable)
          VALUES ('0003', $1, $2, $3, $4, 0, 1, 0, 1, 0, 25, 25, 100, true)`, [v, id, new Date(Date.now() - daysAgo * DAY), m - daysAgo / 100]);
      }
      await pool.query("INSERT INTO ndvi_maps (farm_id, scene_id, acquired_at, west, south, east, north, png) VALUES ('0003', $1, $2, 1, 2, 3, 4, $3)",
        [id, new Date(Date.now() - daysAgo * DAY), Buffer.from([1, 2, 3])]);
    };
    await scene("A", 12);
    await scene("B", 2);
    const { latest, previous } = await st.latestAndPrevious("0003");
    assert.equal(latest.get(1).scene_id, "B");
    assert.equal(previous.get(1).scene_id, "A");
    assert.equal((await st.latestOkScene("0003")).scene_id, "B");
    assert.equal((await st.sceneRows("0003", "B")).length, 2);
    assert.equal((await st.history("0003", 1, Date.now() - 30 * DAY)).length, 2);
    assert.deepEqual([...(await st.map("0003")).png], [1, 2, 3]);
    assert.equal((await st.mapDates("0003")).length, 2);
    assert.equal((await st.sceneSummary("0003")).counts.ok, 2);

    // saving the same shape again changes nothing; a reshape drops that zone's readings and queues the farm
    assert.deepEqual(await st.saveZones("0003", validateZones([{ valve: 1, points: sq(11.45, 77.68) }]), "t"), { changed: 0 });
    assert.equal((await st.history("0003", 1, 0)).length, 2);
    await pool.query("UPDATE ndvi_status SET refresh_requested = NULL");
    assert.deepEqual(await st.saveZones("0003", validateZones([{ valve: 1, points: sq(11.45, 77.6802) }]), "t"), { changed: 1 });
    assert.equal((await st.history("0003", 1, 0)).length, 0);
    assert.equal((await st.history("0003", 2, 0)).length, 2);              // the other zone's history stays
    assert.equal((await st.sceneSummary("0003")).recent.length, 0);         // re-read by the worker
    assert.equal(await st.map("0003"), null);
    assert.ok((await st.status("0003")).refresh_requested);
    assert.equal((await st.zones("0003"))[0].crop, "paddy");                // crop kept
    // water: flow, weather days (as text dates), water picture column
    assert.deepEqual(await st.setFlow("0003", 1, 1800, "t"), { valve: 1, flow_lph: 1800 });
    assert.equal(await st.setFlow("0003", 9, 100, "t"), null);
    assert.equal((await st.zones("0003"))[0].flow_lph, 1800);
    for (let i = 0; i < 20; i++) {
      await pool.query("INSERT INTO ndvi_weather (farm_id, day, rain_mm, et0_mm) VALUES ('0003', $1, $2, $3)",
        [`2026-10-${String(i + 1).padStart(2, "0")}`, i === 19 ? 12 : 0, i === 18 ? null : 4]);
    }
    const wx = await st.weather("0003", 14);
    assert.equal(wx.length, 14);
    assert.equal(wx[13].day, "2026-10-20");
    assert.ok(!wx.some((d) => d.day === "2026-10-19"));                   // no ET0 that day
    assert.equal(wx[13].rain_mm, 12);
    await pool.query("INSERT INTO ndvi_scenes (scene_id, tile, acquired_at) VALUES ('W', 'T', now())");
    await pool.query("INSERT INTO ndvi_maps (farm_id, scene_id, acquired_at, west, south, east, north, png, png_water) VALUES ('0003', 'W', now(), 1, 2, 3, 4, $1, $2)",
      [Buffer.from([1]), Buffer.from([9, 9])]);
    assert.deepEqual([...(await st.map("0003")).png_water], [9, 9]);
    assert.equal(await st.deleteZone("0003", 2), true);
    assert.deepEqual((await st.zones("0003")).map((z) => z.valve), [1]);
  } finally {
    await pool.end();
  }
});

// ------------------------------------------------------------------ water status
import {
  balance, balanceLevel, kcFor, leafLevel, waterStatus, windowDays, effectiveRain, KC
} from "../src/bridge/ndviWater.js";
import { CROPS, adviceText, validateFlow } from "../src/bridge/ndvi.js";

const wday = (i, rain, et0 = 4) => ({ day: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10), rain_mm: rain, et0_mm: et0 });

test("crop factor: FAO-56 curve by stage, perennials, canopy fallback", () => {
  for (const id of Object.keys(CROPS)) if (id !== "other") assert.ok(KC[id], `no Kc for ${id}`);
  assert.deepEqual(kcFor("maize", 10, null), { kc: 0.3, basis: "stage" });         // initial
  assert.deepEqual(kcFor("maize", 45, null), { kc: 0.75, basis: "stage" });        // half way up
  assert.deepEqual(kcFor("maize", 80, null), { kc: 1.2, basis: "stage" });         // mid season
  assert.deepEqual(kcFor("maize", 400, null), { kc: 0.6, basis: "stage" });        // after harvest stage
  assert.deepEqual(kcFor("coconut", null, 0.7), { kc: 1.0, basis: "crop" });
  assert.equal(kcFor("maize", null, 0.7).basis, "canopy");                          // no sowing date
  assert.equal(kcFor(null, null, 0.7).kc, 1.02);
  assert.deepEqual(kcFor(null, null, null), { kc: 1.0, basis: "default" });
  assert.equal(kcFor(null, null, 0.05).kc, 0.3);                                   // clamped
});

test("water balance: need vs effective rain + irrigation in mm", () => {
  assert.equal(effectiveRain(2), 0);
  assert.equal(effectiveRain(10), 8);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => wday(i, 0, 5));                    // 35 mm ET0
  // 1 acre-ish 4000 m^2, 2000 L/h for 10 h = 20000 L = 5 mm
  const b = balance({ days, kc: 1.0, irrigationSec: 36000, flowLph: 2000, areaM2: 4000 });
  assert.equal(b.needMm, 35);
  assert.equal(b.irrigationMm, 5);
  assert.equal(b.coverPct, 14);
  assert.equal(balanceLevel(b), "stress");
  const enough = balance({ days, kc: 1.0, irrigationSec: 36000 * 6, flowLph: 2000, areaM2: 4000 });
  assert.equal(balanceLevel(enough), "ok");
  const flood = balance({ days, kc: 1.0, irrigationSec: 36000 * 12, flowLph: 2000, areaM2: 4000 });
  assert.equal(balanceLevel(flood), "too_much");
  // flow not set: only rain is known - no verdict unless rain alone covered it
  const noFlow = balance({ days, kc: 1.0, irrigationSec: 36000 });
  assert.equal(noFlow.irrigationMm, null);
  assert.equal(balanceLevel(noFlow), null);
  const wet = balance({ days: days.map((d) => ({ ...d, rain_mm: 12 })), kc: 1.0 });
  assert.equal(balanceLevel(wet), "ok");
  // cool rainy week: too little need to judge
  assert.equal(balanceLevel(balance({ days: days.map((d) => ({ ...d, et0_mm: 0.5 })), kc: 1, irrigationSec: 0, flowLph: 1000, areaM2: 4000 })), null);
  assert.equal(balance({ days: [], kc: 1 }), null);
});

test("weather window: last 7 days with data, tolerant of gaps and Dates", () => {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => wday(i, 1));
  const w = windowDays(rows);
  assert.equal(w.length, 7);
  assert.equal(w[0].day, "2026-11-04");
  assert.equal(w[6].day, "2026-11-10");
  assert.equal(windowDays([{ day: new Date(Date.UTC(2026, 10, 3)), rain_mm: 0, et0_mm: 3 }])[0].day, "2026-11-03");
  assert.deepEqual(windowDays([]), []);
  assert.deepEqual(windowDays([{ day: "2026-11-01", rain_mm: 1, et0_mm: null }]), []);
});

test("leaf moisture: vs same-crop valves, own drop, full canopy dry, stale not judged", () => {
  const cur = (ndmi, extra = {}) => obs(1, 0.7, 2, "S2", { ndmi_usable: true, ndmi_median: ndmi, ...extra });
  const peers = (mine, others) => new Map([[1, mine], ...others.map((x, i) => [i + 2, x])]);
  assert.equal(leafLevel({ valve: 1, cur: cur(0.15), prev: null, peers: peers(0.15, [0.25, 0.26]), now: NOW }).level, "stress");
  assert.equal(leafLevel({ valve: 1, cur: cur(0.20), prev: null, peers: peers(0.20, [0.25, 0.26]), now: NOW }).level, "watch");
  assert.equal(leafLevel({ valve: 1, cur: cur(0.25), prev: null, peers: peers(0.25, [0.25, 0.26]), now: NOW }).level, "ok");
  // own drop 0.13 in 10 days
  const prev = obs(1, 0.7, 12, "S12", { ndmi_usable: true, ndmi_median: 0.38 });
  const l = leafLevel({ valve: 1, cur: cur(0.25), prev, peers: null, now: NOW });
  assert.equal(l.level, "stress");
  assert.equal(l.change, -0.13);
  // full canopy but dry leaves, nothing to compare with
  assert.equal(leafLevel({ valve: 1, cur: cur(-0.08), prev: null, peers: null, now: NOW }).level, "stress");
  assert.equal(leafLevel({ valve: 1, cur: cur(0.02), prev: null, peers: null, now: NOW }).level, "watch");
  // 20-day-old reading: shown, not judged
  const old = leafLevel({ valve: 1, cur: obs(1, 0.7, 20, "S20", { ndmi_usable: true, ndmi_median: -0.1 }), prev: null, peers: null, now: NOW });
  assert.equal(old.level, null);
  assert.equal(old.fresh, false);
  assert.equal(old.meaning, "dry");
  assert.equal(leafLevel({ valve: 1, cur: obs(1, 0.2, 2, "S2", { ndmi_usable: false }), prev: null, peers: null, now: NOW }), null);
});

test("combined advice: early warning, too little water, not water", () => {
  const leaf = (level) => ({ level, fresh: true });
  assert.deepEqual(waterStatus({ vigour: "good", leaf: leaf("stress"), bal: null }).advice, ["water_early"]);
  assert.deepEqual(waterStatus({ vigour: "low", leaf: leaf("watch"), bal: null }).advice, ["water_short"]);
  assert.deepEqual(waterStatus({ vigour: "low", leaf: leaf("ok"), bal: null }).advice, ["not_water"]);
  assert.deepEqual(waterStatus({ vigour: "good", leaf: leaf("ok"), bal: null }), { level: "ok", balanceLevel: null, tooMuch: false, advice: [] });
  assert.equal(waterStatus({ vigour: "good", leaf: null, bal: null }).level, "unknown");
  // balance says stress even when the leaves still look fine (worst wins)
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => wday(i, 0, 5));
  const short = balance({ days, kc: 1, irrigationSec: 3600, flowLph: 1000, areaM2: 4000 });
  assert.equal(waterStatus({ vigour: "good", leaf: leaf("ok"), bal: short }).level, "stress");
  const noFlow = balance({ days, kc: 1, irrigationSec: 3600 });
  assert.ok(waterStatus({ vigour: "good", leaf: leaf("ok"), bal: noFlow }).advice.includes("set_flow"));
  for (const code of ["water_early", "water_short", "not_water", "too_much_water", "rain_covered", "set_flow", "leaf_old"]) {
    const t = adviceText(code);
    assert.ok(t && t.length <= 60, `${code}: ${t}`);
  }
});

test("flow input is validated", () => {
  assert.equal(validateFlow({ flowLph: 1500 }), 1500);
  assert.equal(validateFlow({ flowLph: "800.25" }), 800.3);
  assert.equal(validateFlow({ flowLph: null }), null);
  assert.equal(validateFlow({ flowLph: 0 }), null);
  assert.throws(() => validateFlow({ flowLph: -5 }), (e) => /litres per hour/.test(e.message));
  assert.throws(() => validateFlow({ flowLph: "abc" }), (e) => /litres per hour/.test(e.message));
});

test("farm report carries water status, dry spots and water counts", () => {
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => wday(i, 0, 5));
  const dry = [{ pixels: 16, area_m2: 1600, mean: 0.1, min: 0.05, drop: 0.15, lat: 11.4501, lng: 77.6811 }];
  const latest = [
    obs(1, 0.72, 2, "S2", { ndmi_usable: true, ndmi_median: 0.25 }),
    obs(2, 0.70, 2, "S2", { ndmi_usable: true, ndmi_median: 0.14, dry_spots: dry, dry_pct: 18 }),
    obs(3, 0.71, 2, "S2", { ndmi_usable: true, ndmi_median: 0.26 })
  ];
  const r = buildFarmReport({
    farmId: "0003", zones: [zone(1, { flow_lph: 2000 }), zone(2, { flow_lph: 2000 }), zone(3)],
    latest: new Map(latest.map((o) => [o.valve, o])), previous: new Map(), sceneRows: latest,
    latestScene: { scene_id: "S2", acquired_at: new Date(NOW - 2 * DAY), clear_pct: 100 }, now: NOW,
    weather: days, waterWindow: new Map([[1, 70 * 3600], [2, 3600], [3, 3600]])
  });
  const z = byValve(r);
  assert.equal(z[1].water.level, "ok");
  assert.equal(z[1].water.balance.irrigationMm, 38.3);          // 140000 L on 3656 m^2
  assert.equal(z[2].level, "good");
  assert.equal(z[2].water.level, "stress");                      // drier leaves + 0.5 mm of 35 mm need
  assert.deepEqual(z[2].water.advice.map((a) => a.code), ["water_early"]);
  assert.deepEqual(z[2].water.drySpots.map((d) => d.label), ["2D1"]);
  assert.equal(z[2].water.dryPct, 18);
  assert.ok(z[3].water.advice.some((a) => a.code === "set_flow"));
  assert.equal(z[3].flowLph, null);
  assert.equal(r.summary.water.stress, 1);
  assert.equal(r.weather.lastDay, "2026-11-07");
  const g = buildMapGeoJson(r, new Map(r.zones.map((x) => [x.valve, x.points])), { scene_id: "S2", acquired_at: new Date(NOW), west: 0, south: 0, east: 1, north: 1, png: Buffer.from("V"), png_water: Buffer.from("W") }, [], "water");
  assert.equal(Buffer.from(g.image.pngBase64, "base64").toString(), "W");
  assert.equal(g.layer, "water");
  assert.ok(g.features.some((f) => f.properties.kind === "dry_spot" && f.properties.label === "2D1"));
  // older image without a water picture: no image on the water layer, never a crash
  const g2 = buildMapGeoJson(r, new Map(), { scene_id: "S2", acquired_at: new Date(NOW), west: 0, south: 0, east: 1, north: 1, png: Buffer.from("V"), png_water: null }, [], "water");
  assert.equal(g2.image, null);
  // waiting valve (no image yet) still gets the weather balance
  const w = buildFarmReport({ farmId: "0003", zones: [zone(5, { flow_lph: 1000 })], latest: new Map(), previous: new Map(), now: NOW, weather: days, waterWindow: new Map() });
  assert.equal(w.zones[0].level, "waiting");
  assert.equal(w.zones[0].water.level, "stress");
});
