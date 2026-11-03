// Web simulation server: the admin panel's own files (public/), the real
// bridge/provisioning server modules on in-memory stores, and the endpoints
// the fake Firebase modules talk to. See run.js.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SERVER = path.join(ROOT, "server");
const PUBLIC = path.join(ROOT, "public");
const GEN = path.join(process.env.WEB_SIM_OUT || path.join(HERE, ".gen"), "gen");
const requireServer = createRequire(path.join(SERVER, "package.json"));

export const ADMIN = { email: "admin@farmbuddie.test", password: "admin-test-pass", uid: "admin-uid-1" };
process.env.ADMIN_EMAILS = ADMIN.email;
process.env.OTA_PUBLIC_BASE_URL = process.env.OTA_PUBLIC_BASE_URL || "https://api.farmbuddie.com/bridge";

// A server file, with some of its imports pointed elsewhere (the Firebase
// Admin SDK -> the in-memory database), written under .gen and imported.
function gen(rel, replace) {
  const src = path.join(SERVER, rel);
  let text = fs.readFileSync(src, "utf8");
  text = text.replace(/(from\s+|import\s*\(\s*)"([^"]+)"/g, (m, pre, spec) => {
    let to;
    if (replace[spec]) to = replace[spec];
    else if (spec.startsWith(".")) to = pathToFileURL(path.resolve(path.dirname(src), spec)).href;
    else if (spec.startsWith("node:")) to = spec;
    else to = pathToFileURL(requireServer.resolve(spec)).href;
    return `${pre}"${to}"`;
  });
  fs.mkdirSync(GEN, { recursive: true });
  const out = path.join(GEN, rel.replace(/[\/]/g, "__"));
  fs.writeFileSync(out, text);
  return pathToFileURL(out).href;
}
const here = (f) => pathToFileURL(path.join(HERE, f)).href;
const server = (f) => pathToFileURL(path.join(SERVER, f)).href;

export async function startHarness({ port = 0 } = {}) {
  const express = requireServer("express");
  const { mem, db } = await import(here("harness-admin.js"));
  const stores = await import(here("stores.js"));
  const { createProductionModule, PROD_TOKEN_PREFIX } = await import(server("src/bridge/production.js"));
  const { createDistributorModule, TOKEN_PREFIX } = await import(server("src/bridge/distributors.js"));
  const { createOtaModule } = await import(server("src/bridge/ota.js"));
  const { createEventLogModule } = await import(server("src/bridge/eventLog.js"));
  const { createAnnouncementsModule } = await import(server("src/bridge/announcements.js"));
  const { createPricingModule } = await import(server("src/bridge/pricing.js"));
  const { requireAdmin, isAdmin, requireAdminOrOnboarding } = await import(server("src/adminAuth.js"));
  const { farmUnitCounts } = await import(server("src/bridge/farmUnits.js"));
  const { MOTOR_NUMBERS } = await import(server("src/bridge/motorNumbers.js"));
  const ADMIN_FB = here("harness-admin.js");
  const pf = await import(gen("src/bridge/productionFirebase.js", { "firebase-admin/firestore": ADMIN_FB, "../firebaseAdmin.js": ADMIN_FB }));
  const tbmq = here("fake-tbmq.js");
  gen("src/deviceProvisioning.js", { "./firebaseAdmin.js": ADMIN_FB, "./tbmqClient.js": tbmq });
  const { provisionDeviceRouter } = await import(gen("src/routes/provisionDevice.js", {
    "../deviceProvisioning.js": pathToFileURL(path.join(GEN, "src__deviceProvisioning.js")).href
  }));
  const { isActiveOnboarding } = await import(gen("src/teamAccess.js", { "./firebaseAdmin.js": ADMIN_FB }));
  const noMirror = here("fake-mirror.js");
  const af = await import(gen("src/bridge/announcementsFirebase.js", { "../firebaseAdmin.js": ADMIN_FB, "./firestoreMirror.js": noMirror }));
  const df = await import(gen("src/bridge/distributorsFirebase.js", { "../firebaseAdmin.js": ADMIN_FB }));

  const log = { published: [], commands: [], pushes: [], serverErrors: [] };

  // ---------------- server modules ----------------
  const prodStore = stores.productionUserStore();
  const production = createProductionModule({
    store: prodStore, controllers: pf.firestoreControllers, nodes: pf.firestoreNodes, teamAuth: pf.firebaseTeamAuth
  });
  const findDistributor = df.findDistributor;
  const distStore = stores.distributorAccountStore();
  const distributors = createDistributorModule({
    store: distStore, findDistributor,
    distributorFarms: df.distributorFarms, loadReferrals: df.loadReferrals, loadRedemptions: df.loadRedemptions
  });
  const TIMESTAMP_MS = (t) => (t && typeof t.__ts === "number" ? t.__ts : null);
  async function fleet() {
    return mem.list("farmers").filter((r) => r.data.controller?.uniqueId).map(({ data: f }) => {
      const ds = f.deviceStatus || null;
      const lastSeen = TIMESTAMP_MS(ds?.lastSeen);
      return {
        farmId: f.controller.uniqueId, nodeId: ds?.nodeId || "MOTOR_1", farmerName: f.name || null, farmBuddieId: f.farmBuddieId || null,
        distributorId: f.leadSource?.distributorId || null, online: lastSeen != null && Date.now() - lastSeen < 25 * 60 * 1000, lastSeen,
        units: farmUnitCounts(f),
        deviceStatus: ds ? { ...Object.fromEntries(MOTOR_NUMBERS.map((n) => [`motor${n}`, ds[`motor${n}`] || null])), health: ds.health || null } : null
      };
    });
  }
  const otaStore = stores.otaStore();
  const ota = createOtaModule({
    store: otaStore,
    publish: async (topic, payload) => { log.published.push({ topic, payload }); },
    listFleet: async () => (await fleet()).map((f) => ({
      farmId: f.farmId, nodeId: f.nodeId, farmerName: f.farmerName, online: f.online,
      fwVersion: f.deviceStatus?.health?.fw_version || null, board: f.deviceStatus?.health?.board || null, units: f.units
    })),
    publicBaseUrl: process.env.OTA_PUBLIC_BASE_URL,
    publicKeyPem: process.env.WEB_SIM_OTA_PUBLIC_PEM || undefined
  });
  // A hub answering the Event Log page over MQTT (see fake-hub.js).
  const { hubReply } = await import(here("fake-hub.js"));
  let eventLog;
  eventLog = createEventLogModule({
    timeoutMs: 3000,
    publishCommand: async (farmId, nodeId, motorNum, payload) => {
      log.commands.push({ farmId, nodeId, motorNum, payload });
      const reply = hubReply(farmId, payload);
      if (reply) setTimeout(() => eventLog.handleResponse(farmId, nodeId, { cmd: payload.cmd, id: payload.id, ...reply }), 40);
    }
  });
  const broadcast = createAnnouncementsModule({
    store: stores.announcementStore(),
    loadAudience: af.loadAudience, phoneFarmIds: af.phoneFarmIds, sendPush: af.sendPush, removeDevices: af.removeDevices,
    distributorFarms: df.distributorFarms, distributorDevices: () => distStore.devices(), removeDistributorDevices: async () => {}
  });
  const pricing = createPricingModule({ store: stores.emptyPricingStore(), findDistributor });

  // ---------------- the bridge (server.js, minus MQTT/Postgres) ----------------
  const bridge = express();
  bridge.use(express.json({ limit: "8mb" }));
  bridge.use("/ota/firmware", ota.publicRouter);
  bridge.use("/distributor", distributors.publicRouter);
  bridge.use("/production", production.publicRouter);
  async function verifyCaller(req, res, next) {
    const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
    if (m && m[1].startsWith(PROD_TOKEN_PREFIX)) {
      if (req.path !== "/production" && !req.path.startsWith("/production/")) return res.status(403).json({ error: "Production access only" });
      const who = await production.authenticate(m[1]).catch(() => null);
      if (!who) return res.status(401).json({ error: "Signed out - please sign in again", code: "signed_out" });
      req.decodedToken = who;
      return next();
    }
    if (m && m[1].startsWith(TOKEN_PREFIX)) {
      const who = await distributors.authenticate(m[1]).catch(() => null);
      if (!who) return res.status(401).json({ error: "Signed out - please sign in again", code: "signed_out" });
      req.decodedToken = who;
      return next();
    }
    const tok = decodeIdToken(m?.[1]);
    if (!tok) return res.status(401).json({ error: "Missing or invalid Authorization header" });
    req.decodedToken = tok;
    next();
  }
  bridge.use(verifyCaller);
  bridge.use("/distributors", requireAdmin, distributors.adminRouter);
  bridge.use("/production", production.router);
  bridge.use("/production-users", requireAdmin, production.adminRouter);
  bridge.use("/team-users", requireAdmin, production.adminRouter);
  bridge.use("/pricing", pricing.router);
  bridge.use("/ota", ota.adminRouter);
  bridge.use("/event-log", requireAdmin, eventLog.adminRouter);
  bridge.use("/broadcast", broadcast.adminRouter);
  bridge.get("/fleet/status", async (req, res) => {
    if (!isAdmin(req.decodedToken)) return res.status(403).json({ error: "Admin identity required" });
    res.json({ farms: await fleet() });
  });
  bridge.post("/command/device", (req, res) => {
    if (!isAdmin(req.decodedToken)) return res.status(403).json({ error: "Admin identity required" });
    log.commands.push({ ...req.body, via: "command/device" });
    res.json({ ok: true, topic: `farm/${req.body.farmId}/${req.body.nodeId}/motor/${req.body.motorNum}/cmd` });
  });
  bridge.get("/firmware/latest", async (_req, res) => res.json(await otaStore.latestReleaseVersions()));
  // Postgres event history for a farm (device view charts): none recorded here.
  bridge.get("/telemetry/:farmId", (req, res) => res.json({ farmId: req.params.farmId, since: req.query.since || null, events: [] }));
  bridge.use((req, res) => { log.serverErrors.push(`404 bridge ${req.method} ${req.path}`); res.status(404).json({ error: "Not found (not simulated)" }); });
  bridge.use((err, req, res, _next) => { log.serverErrors.push(`500 bridge ${req.method} ${req.path}: ${err.message}`); res.status(500).json({ error: err.message }); });

  // ---------------- provisioning API (app.js) ----------------
  const api = express();
  api.use(express.json());
  api.use("/provision/device", (req, res, next) => {
    const tok = decodeIdToken((req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!tok) return res.status(401).json({ error: "Missing or invalid Authorization header" });
    req.decodedToken = tok;
    next();
  }, requireAdminOrOnboarding(isActiveOnboarding), provisionDeviceRouter);
  api.get("/provision/status", (req, res) => {
    if (!isAdmin(decodeIdToken((req.headers.authorization || "").replace(/^Bearer /, "")))) return res.status(403).json({ error: "Admin identity required" });
    res.json({
      checkedAt: new Date().toISOString(),
      tbmqRest: { ok: true, latencyMs: 4 },
      connectedClients: { ok: true, total: 2, farmDevices: 1, infrastructure: 1, clients: [{ clientId: "FBIRG0001", connected: true }, { clientId: "bridge", connected: true }] },
      bridgeMqtt: { ok: true }, bridgeService: { ok: true, latencyMs: 2 }, postgres: { ok: true, latencyMs: 1 }
    });
  });
  api.use((req, res) => { log.serverErrors.push(`404 api ${req.method} ${req.path}`); res.status(404).json({ error: "Not found (not simulated)" }); });

  // ---------------- the site + fake Firebase endpoints ----------------
  const users = new Map([[ADMIN.email, { uid: ADMIN.uid, email: ADMIN.email, password: ADMIN.password, displayName: "Sim Admin" }]]);
  function decodeIdToken(t) {
    if (!t || !t.startsWith("fake.")) return null;
    try { return JSON.parse(Buffer.from(t.slice(5), "base64").toString("utf8")); } catch { return null; }
  }
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.post("/__fs", (req, res) => {
    try { res.json(mem.handle(req.body)); }
    catch (e) { res.status(400).json({ code: e.clientCode || "invalid-argument", message: e.message }); }
  });
  app.post("/__auth/login", (req, res) => {
    const u = users.get(String(req.body.email || "").toLowerCase());
    if (!u || u.password !== req.body.password) return res.status(400).json({ code: "auth/invalid-credential", message: "Firebase: Error (auth/invalid-credential)." });
    res.json({ user: { uid: u.uid, email: u.email, displayName: u.displayName } });
  });
  app.post("/__auth/custom", (req, res) => {
    const t = String(req.body.token || "");
    if (!t.startsWith("custom.")) return res.status(400).json({ code: "auth/invalid-custom-token", message: "bad token" });
    const { uid, claims } = JSON.parse(Buffer.from(t.slice(7), "base64").toString("utf8"));
    res.json({ user: { uid, email: null, displayName: claims?.name || null, claims } });
  });
  app.use("/__api/bridge", bridge);
  app.use("/__api", api);
  app.use(express.static(PUBLIC, { extensions: ["html"], index: "index.html" }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, "404.html")));

  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    url, mem, db, log, prodStore, otaStore, ota, production, users,
    close: () => new Promise((r) => httpServer.close(r))
  };
}
