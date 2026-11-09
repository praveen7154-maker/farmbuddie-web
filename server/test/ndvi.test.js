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
  assert.ok(z[3].advice.some((a) => a.code === "check_soil_moisture"));
  assert.equal(z[4].level, "watch");
  assert.equal(z[4].advice[0].code, "inspect_pest_nutrient");
  assert.deepEqual(z[1].advice, []);
  assert.deepEqual(r.summary, { zones: 4, mapped: 4, low: 1, watch: 1, good: 2, waiting: 0 });
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
  assert.match(z.weakSpots[1].advice.text, /Weak spot 1B .*0\.5 against 0\.68/);
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

// ------------------------------------------------------------------ Postgres (opt-in)

const url = process.env.PG_TEST_URL;
test("ndvi store against a real database", { skip: url ? false : "set PG_TEST_URL to run" }, async () => {
  process.env.BRIDGE_PG_CONNECTION_STRING = url;
  const { pool } = await import("../src/bridge/postgres.js");
  const { ensureNdviSchema, createNdviStore } = await import("../src/bridge/ndviStore.js");
  try {
    await pool.query("DROP TABLE IF EXISTS ndvi_maps, ndvi_history, ndvi_farm_scenes, ndvi_scenes, ndvi_zones, ndvi_status CASCADE");
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
    assert.equal(await st.deleteZone("0003", 2), true);
    assert.deepEqual((await st.zones("0003")).map((z) => z.valve), [1]);
  } finally {
    await pool.end();
  }
});
