import express from "express";
import {
  buildFarmReport, buildMapGeoJson, historyView, parseZoneId, statusView, validateCrop, validateZones, zoneId, CROPS, WATER_DAYS
} from "./ndvi.js";

// Crop health endpoints (mounted at /api, behind the bridge's sign-in):
//   GET    /api/farms/:farmId/ndvi                 every zone's level, latest reading and advice
//   GET    /api/fields/:fieldId/ndvi-map[?scene=]  GeoJSON zones + valves, and the heatmap picture
//   GET    /api/zones/:zoneId/ndvi                 one zone (zoneId = "<farmId>-<valve>", e.g. 0003-5)
//   GET    /api/zones/:zoneId/ndvi-history[?days=] one reading per clear day
//   GET    /api/farms/:farmId/satellite-status     last check / update, recent images and why skipped
//   PUT    /api/farms/:farmId/zones                the app's plotted valve lands { zones: [{ valve, points, plottedAtMs }] }
//   PUT    /api/zones/:zoneId/crop                 { crop, sowingDate }
//   DELETE /api/zones/:zoneId                      a valve no longer mapped
//   GET    /api/ndvi/crops                         the crop list and typical ranges
// One field per farm for now, so fieldId = farmId. Same access rule as
// /reports: the farm's own phones, its distributor, admins.
//
// [water]: async (farmId, days) => Map valve -> seconds watered, or null.
export function createNdviRouter({ store, canAccessFarm, water = async () => null, now = () => Date.now(), log = console }) {
  const r = express.Router();
  const who = (req) => req.decodedToken?.phone_number || req.decodedToken?.uid || null;

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      log.error("ndvi route error:", err);
      return res.status(500).json({ error: "Crop health is unavailable right now" });
    }
  };

  async function allowed(req, res, farmId) {
    if (!/^\d{1,6}$/.test(farmId)) {
      res.status(400).json({ error: "Invalid farmId" });
      return false;
    }
    if (!(await canAccessFarm(req.decodedToken, farmId))) {
      res.status(403).json({ error: "Not authorized for this farm" });
      return false;
    }
    return true;
  }

  function zoneParam(req, res) {
    const z = parseZoneId(req.params.zoneId);
    if (!z) res.status(400).json({ error: "Invalid zoneId (expected <farmId>-<valve>, e.g. 0003-5)" });
    return z;
  }

  async function report(farmId) {
    const [zones, { latest, previous, recent }, latestScene, status] = await Promise.all([
      store.zones(farmId), store.latestAndPrevious(farmId), store.latestOkScene(farmId), store.status(farmId)
    ]);
    const [sceneRows, waterMap] = await Promise.all([
      latestScene ? store.sceneRows(farmId, latestScene.scene_id) : [],
      water(farmId, WATER_DAYS).catch((e) => { log.warn?.("ndvi water lookup failed:", e?.message); return null; })
    ]);
    return { zones, rep: buildFarmReport({ farmId, zones, latest, previous, recent, sceneRows, water: waterMap, status, latestScene, now: now() }) };
  }

  r.get("/ndvi/crops", (req, res) => res.json({ crops: Object.entries(CROPS).map(([id, c]) => ({ id, ...c })) }));

  r.get("/farms/:farmId/ndvi", handle(async (req, res) => {
    const { farmId } = req.params;
    if (!(await allowed(req, res, farmId))) return;
    res.json((await report(farmId)).rep);
  }));

  r.get("/fields/:fieldId/ndvi-map", handle(async (req, res) => {
    const farmId = req.params.fieldId;
    if (!(await allowed(req, res, farmId))) return;
    const scene = typeof req.query.scene === "string" && /^[\w.-]{1,120}$/.test(req.query.scene) ? req.query.scene : null;
    const [{ zones, rep }, map, dates] = await Promise.all([report(farmId), store.map(farmId, scene), store.mapDates(farmId)]);
    const points = new Map(zones.map((z) => [z.valve, z.points]));
    res.type("application/geo+json").send(JSON.stringify(buildMapGeoJson(rep, points, map, dates)));
  }));

  r.get("/zones/:zoneId/ndvi", handle(async (req, res) => {
    const z = zoneParam(req, res);
    if (!z || !(await allowed(req, res, z.farmId))) return;
    const { rep } = await report(z.farmId);
    const zone = rep.zones.find((x) => x.valve === z.valve);
    if (!zone) return res.status(404).json({ error: "This valve isn't mapped" });
    res.json({ farmId: z.farmId, latestImage: rep.latestImage, farmMedian: rep.farmMedian, satellite: rep.satellite, note: rep.note, zone });
  }));

  r.get("/zones/:zoneId/ndvi-history", handle(async (req, res) => {
    const z = zoneParam(req, res);
    if (!z || !(await allowed(req, res, z.farmId))) return;
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 365, 7), 3 * 365);
    const rows = await store.history(z.farmId, z.valve, now() - days * 86400000);
    res.json({ zoneId: zoneId(z.farmId, z.valve), farmId: z.farmId, valve: z.valve, days, history: historyView(rows) });
  }));

  r.get("/farms/:farmId/satellite-status", handle(async (req, res) => {
    const { farmId } = req.params;
    if (!(await allowed(req, res, farmId))) return;
    const [status, summary, zones] = await Promise.all([store.status(farmId), store.sceneSummary(farmId), store.zones(farmId)]);
    res.json({
      farmId, ...statusView(status),
      zonesMapped: zones.filter((x) => (x.points || []).length >= 3).length, zonesTotal: zones.length,
      images: summary.counts,
      recent: summary.recent.map((s) => ({
        sceneId: s.scene_id, acquiredAt: new Date(s.acquired_at).toISOString(), status: s.status,
        farmClearPct: s.clear_pct === null ? null : Math.round(s.clear_pct), tileCloudPct: Math.round(s.cloud_cover ?? 0)
      })),
      source: "Copernicus Sentinel-2 Level-2A (10 m), free and open data",
      note: "A new image comes every few days, but only clear ones over the farm count - in cloudy weeks there may be none."
    });
  }));

  r.put("/farms/:farmId/zones", handle(async (req, res) => {
    const { farmId } = req.params;
    if (!(await allowed(req, res, farmId))) return;
    const zones = validateZones(req.body?.zones);
    const { changed } = await store.saveZones(farmId, zones, who(req));
    res.json({ farmId, saved: zones.length, changed });
  }));

  r.put("/zones/:zoneId/crop", handle(async (req, res) => {
    const z = zoneParam(req, res);
    if (!z || !(await allowed(req, res, z.farmId))) return;
    const { crop, sowingDate } = validateCrop(req.body, now());
    const row = await store.setCrop(z.farmId, z.valve, crop, sowingDate, who(req));
    if (!row) return res.status(404).json({ error: "Map this valve's land first" });
    res.json({ zoneId: zoneId(z.farmId, z.valve), crop: row.crop, sowingDate: row.sowing_date });
  }));

  r.delete("/zones/:zoneId", handle(async (req, res) => {
    const z = zoneParam(req, res);
    if (!z || !(await allowed(req, res, z.farmId))) return;
    const ok = await store.deleteZone(z.farmId, z.valve);
    res.status(ok ? 200 : 404).json(ok ? { deleted: zoneId(z.farmId, z.valve) } : { error: "Not mapped" });
  }));

  return r;
}
