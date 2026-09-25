import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { canAccessFarm } from "./ownership.js";
import { publishCommand, isBridgeConnected } from "./mqttBridge.js";
import { queryEvents, checkPostgresHealth } from "./postgres.js";
import { getFleetStatus } from "./fleetStatus.js";
import { issueDeviceCredentialByFarmId } from "../deviceProvisioning.js";
import { buildDeviceQrPng } from "./qrPayload.js";
import { createOtaModule } from "./ota.js";
import { pgOtaStore } from "./otaStore.js";
import { publishJson } from "./mqttBridge.js";
import { normalizeFarmElectrical } from "./farmElectrical.js";
import { db } from "../firebaseAdmin.js";

export const app = express();
app.use(express.json());

// Reports the bridge's OWN MQTT session + Postgres reachability, not just
// "this HTTP process is alive" - GET /provision/status (see routes/
// status.js on the provision-api side) fetches this internally over the
// docker network to build the admin panel's "VPS & TBMQ" status page.
app.get("/healthz", async (req, res) => {
  const postgres = await checkPostgresHealth();
  res.json({ ok: true, mqttConnected: isBridgeConnected(), postgres });
});

// Web-panel OTA (admin > OTA) - see ota.js. The firmware download route is
// public (hubs have no login; the signed SHA-256 is what they trust) and so
// sits before the auth middleware below; everything else is admin-only.
export const ota = createOtaModule({
  store: pgOtaStore,
  publish: publishJson,
  listFleet: async () => (await getFleetStatus())
    .filter((f) => f.farmId)
    .map((f) => ({
      farmId: f.farmId,
      nodeId: f.nodeId || "MOTOR_1",
      farmerName: f.farmerName,
      online: f.online,
      fwVersion: f.deviceStatus?.health?.fw_version || null
    })),
  publicBaseUrl: config.otaPublicBaseUrl
});
app.use("/ota/firmware", ota.publicRouter);

// Both the admin panel (browser, has an origin to restrict) and the
// Irrigo app (native, no origin) call these — CORS just narrows what a
// browser will allow; canAccessFarm() is the real gate either way.
const corsOptions = { origin: (origin, cb) => cb(null, true) };
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.use(cors(corsOptions), limiter, verifyFirebaseToken);

app.use("/ota", ota.adminRouter);

/**
 * POST /command/device
 * body: { farmId, nodeId, motorNum: "1"|"2", cmd, ...params }
 * Relays a command to the device's cmd topic. motorNum: "1" is the hub's
 * own directly-wired motor, "2" is a linked Motor_2 over the mesh (motor
 * NUMBER, not a "pumpA/pumpB" letter — verified against the firmware's
 * real topic-building code, not its README). Fire-and-forget at the HTTP
 * layer — QoS1 covers delivery, but this doesn't wait for the device's
 * own ack/nack on its response topic (no request/response correlation in
 * this v1 — the caller watches Firestore/telemetry for the result same as
 * it already does for any other status change).
 */
app.post("/command/device", async (req, res) => {
  const { farmId, nodeId, motorNum, cmd, ...params } = req.body || {};

  if (!farmId || !nodeId || !cmd) {
    return res.status(400).json({ error: "farmId, nodeId, and cmd are required" });
  }

  try {
    const allowed = await canAccessFarm(req.decodedToken, farmId);
    if (!allowed) {
      return res.status(403).json({ error: "Not authorized for this farm" });
    }

    await publishCommand(farmId, nodeId, motorNum, { cmd, ...params });
    return res.json({ ok: true });
  } catch (err) {
    console.error("command/device error:", err);
    return res.status(500).json({ error: "Failed to relay command" });
  }
});

/**
 * GET /fleet/status
 * Every farm with a controller assigned, plus its live deviceStatus/online
 * state - admin-only (email-authenticated), unlike the per-farm endpoints
 * above which a farmer's own phone identity can also reach. Built for the
 * Irrigo Admin app's Fleet Monitoring screen: one REST call against the
 * VPS instead of that app holding its own MQTT session or Firestore
 * listener open just to show who's online right now.
 */
app.get("/fleet/status", async (req, res) => {
  if (!req.decodedToken.email) {
    return res.status(403).json({ error: "Admin identity required" });
  }

  try {
    const farms = await getFleetStatus();
    return res.json({ farms, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("fleet/status error:", err);
    return res.status(500).json({ error: "Failed to fetch fleet status" });
  }
});

/**
 * GET /fleet/device/:farmId/credentials
 * Admin-only. Hands back this farm's already-issued MQTT credentials
 * (broker host/port, client ID/username, plaintext password) so the
 * Irrigo Admin app can open a single, on-demand MQTT connection to the
 * one device a founder is actually viewing - reuses issueDeviceCredentialByFarmId()
 * with rotate:false, the exact same "view, don't mutate" call the web
 * panel's own credential reveal already makes (see deviceProvisioning.js).
 */
app.get("/fleet/device/:farmId/credentials", async (req, res) => {
  if (!req.decodedToken.email) {
    return res.status(403).json({ error: "Admin identity required" });
  }

  try {
    const result = await issueDeviceCredentialByFarmId(req.params.farmId, { rotate: false });
    return res.json(result);
  } catch (err) {
    if (err && err.status) {
      const { status, message, ...rest } = err;
      return res.status(status).json({ error: message, ...rest });
    }
    console.error("fleet/device/credentials error:", err);
    return res.status(500).json({ error: "Failed to fetch device credentials" });
  }
});

/**
 * GET /fleet/device/:farmId/qr
 * Admin-only. Re-renders this farm's already-issued MQTT setup QR as a
 * PNG - the same encrypted payload the web admin panel shows at
 * credential-issue time (see provisioning.js), regenerated on demand so
 * the Irrigo Admin app's Farmer QR screen can pull up and share any
 * already-onboarded farmer's QR without needing the web panel open.
 * rotate:false - viewing/sharing, never mutates the credential.
 */
app.get("/fleet/device/:farmId/qr", async (req, res) => {
  if (!req.decodedToken.email) {
    return res.status(403).json({ error: "Admin identity required" });
  }

  try {
    const creds = await issueDeviceCredentialByFarmId(req.params.farmId, { rotate: false });
    const png = await buildDeviceQrPng({
      farmerName: creds.farmerName,
      brokerUrl: creds.brokerUrl,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      farmId: creds.farmId,
      nodeId: creds.nodeId
    });
    res.set("Content-Type", "image/png");
    return res.send(png);
  } catch (err) {
    if (err && err.status) {
      const { status, message } = err;
      return res.status(status).json({ error: message });
    }
    console.error("fleet/device/qr error:", err);
    return res.status(500).json({ error: "Failed to generate QR" });
  }
});

/**
 * GET /farm/:farmId/electrical
 * The farm's Motor / TNEB configuration (pumps with HP and service, services
 * with sanctioned HP) for the Irrigo app's TNEB load limit - see
 * farmElectrical.js. Same access rule as telemetry: admins, or a phone with
 * an enabled phoneIndex entry for this farm.
 */
app.get("/farm/:farmId/electrical", async (req, res) => {
  const { farmId } = req.params;
  if (!/^\d{1,6}$/.test(farmId)) return res.status(400).json({ error: "Invalid farmId" });
  try {
    if (!(await canAccessFarm(req.decodedToken, farmId))) {
      return res.status(403).json({ error: "Not authorized for this farm" });
    }
    const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "No farm record for this farmId" });
    return res.json(normalizeFarmElectrical(farmId, snap.docs[0].data()));
  } catch (err) {
    console.error("farm electrical error:", err);
    return res.status(500).json({ error: "Failed to load the farm's electrical setup" });
  }
});

/**
 * GET /telemetry/:farmId?since=<ISO timestamp>
 * Returns up to 5000 raw device_events rows (status/response/ota) for
 * charts/reports. `since` defaults to 24h ago; the 15-day retention job
 * is what actually bounds how far back this can ever reach.
 */
app.get("/telemetry/:farmId", async (req, res) => {
  const { farmId } = req.params;
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: "Invalid since timestamp" });
  }

  try {
    const allowed = await canAccessFarm(req.decodedToken, farmId);
    if (!allowed) {
      return res.status(403).json({ error: "Not authorized for this farm" });
    }

    const rows = await queryEvents(farmId, since);
    return res.json({ farmId, since: since.toISOString(), events: rows });
  } catch (err) {
    console.error("telemetry error:", err);
    return res.status(500).json({ error: "Failed to fetch telemetry" });
  }
});
