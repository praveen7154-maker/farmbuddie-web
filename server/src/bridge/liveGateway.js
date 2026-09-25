import { WebSocketServer } from "ws";
import { auth } from "../firebaseAdmin.js";
import { canAccessFarm } from "./ownership.js";
import { getCachedConfigsForFarm } from "./farmConfigCache.js";

// How long the app must wait between two commands landing on the SAME
// farm's device - was per-phone client-side spacing (PumpRepository.kt's
// COMMAND_SEND_SPACING_MS, tuned against real GSM-link failures, see that
// constant's own comment). Centralized here instead: it now protects the
// device from every phone on this farm AND Irrigo Admin's on-demand
// connections at once, not just one phone's own bursts - see the design
// doc's "Proposed architecture" section for why this moved server-side.
const COMMAND_SPACING_MS = 1000;

// farmId -> Set<WebSocket> - every phone currently watching this farm live.
const subscribers = new Map();

// farmId -> a promise chain tail, so this farm's outgoing commands are
// serialized with COMMAND_SPACING_MS between them regardless of which
// WebSocket (which phone) they came from.
const commandQueues = new Map();

function subscribe(farmId, ws) {
  let set = subscribers.get(farmId);
  if (!set) {
    set = new Set();
    subscribers.set(farmId, set);
  }
  set.add(ws);
}

function unsubscribe(farmId, ws) {
  const set = subscribers.get(farmId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribers.delete(farmId);
}

/**
 * Fans out one device-originated message to every phone currently
 * subscribed to this farm - called from mqttBridge.js's own message
 * handler, right alongside its existing Postgres insert/Firestore mirror/
 * FCM push, using the SAME single MQTT session (no new MQTT traffic, no
 * new MQTT identity - see the design doc). `message` carries the raw MQTT
 * topic + parsed payload so the app can reuse its existing Topics.kt-based
 * parsing almost unchanged, just fed from this WebSocket instead of its
 * own IrrigoMqttClient.
 */
export function broadcastToFarm(farmId, message) {
  const set = subscribers.get(farmId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function queueCommand(farmId, task) {
  const prev = commandQueues.get(farmId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => task())
    .then(
      (result) => new Promise((resolve) => setTimeout(() => resolve(result), COMMAND_SPACING_MS)),
      (err) => new Promise((_, reject) => setTimeout(() => reject(err), COMMAND_SPACING_MS))
    );
  commandQueues.set(farmId, next);
  return next;
}

/**
 * Attaches the app-facing live channel to the bridge's existing HTTP
 * server at /live (reachable externally as wss://api.farmbuddie.com/
 * bridge/live, same nginx prefix-stripping every other bridge route
 * already gets) - purely additive, doesn't touch mqttBridge.js's own MQTT
 * session or any existing REST endpoint. `publishCommand` is passed in
 * (not imported from mqttBridge.js) to avoid a circular import, since
 * mqttBridge.js itself imports broadcastToFarm from this file.
 *
 * Auth via query params (?farmId=...&token=<Firebase ID token>) rather
 * than a header - the simplest thing every WebSocket client (including a
 * plain OkHttp handshake) can reliably send on the upgrade request, and
 * matches the one-shot nature of this handshake (no per-message auth story
 * needed once the connection is open and already scoped to one farmId).
 */
export function attachLiveGateway(httpServer, { publishCommand }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/live") {
      return; // not ours - let any other upgrade handler on this server see it
    }

    const farmId = url.searchParams.get("farmId");
    const token = url.searchParams.get("token");

    if (!farmId || !token) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const allowed = await canAccessFarm(decodedToken, farmId).catch(() => false);
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      subscribe(farmId, ws);

      // Lets the app render cached safety/cyclic/valve config instantly on
      // open instead of waiting on a live get_config round trip - see
      // farmConfigCache.js.
      getCachedConfigsForFarm(farmId)
        .then((rows) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ kind: "config_cache", farmId, configs: rows }));
          }
        })
        .catch((err) => console.error(`[bridge] live config-cache send failed for farm ${farmId}:`, err.message));

      ws.on("close", () => unsubscribe(farmId, ws));
      ws.on("error", () => unsubscribe(farmId, ws));

      ws.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // malformed - drop, same tolerance mqttBridge.js's own JSON.parse fallback has
        }

        const { nodeId, motorNum, cmd, ...params } = msg || {};
        if (!nodeId || !cmd) return;

        try {
          await queueCommand(farmId, () => publishCommand(farmId, nodeId, motorNum, { cmd, ...params }));
          console.log(`[live] farm ${farmId}: ${cmd} -> ${nodeId}/motor/${motorNum === "2" ? "2" : "1"}`);
        } catch (err) {
          console.error(`[bridge] live command failed for farm ${farmId}:`, err.message);
        }
      });
    });
  });

  console.log("[bridge] live WebSocket gateway attached at /live");
}
