import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { canAccessFarm } from "./ownership.js";
import { publishCommand, isBridgeConnected } from "./mqttBridge.js";
import { queryEvents, checkPostgresHealth } from "./postgres.js";
import { getFleetStatus } from "./fleetStatus.js";

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

// Both the admin panel (browser, has an origin to restrict) and the
// Irrigo app (native, no origin) call these — CORS just narrows what a
// browser will allow; canAccessFarm() is the real gate either way.
const corsOptions = { origin: (origin, cb) => cb(null, true) };
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.use(cors(corsOptions), limiter, verifyFirebaseToken);

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
