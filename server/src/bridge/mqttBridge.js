import mqtt from "mqtt";
import { config } from "../config.js";
import { insertEvent } from "./postgres.js";
import { mirrorStatus, mirrorHealth } from "./firestoreMirror.js";
import { sendAlertPush } from "./pushNotifications.js";
import { broadcastToFarm } from "./liveGateway.js";
import { setCachedConfigFromResponse } from "./farmConfigCache.js";

let client = null;

/**
 * Real topic shape, verified directly against the firmware's own runtime
 * code (Connectivity::buildTopics() in connectivity.cpp — NOT the Motor
 * repo's README, which describes a stale/different design):
 *   farm/<farmId>/<nodeId>/motor/<motorNum>/cmd|status|response
 *   farm/<farmId>/<nodeId>/ota/cmd|status
 *   farm/<farmId>/<nodeId>/health
 * motorNum is "1" (this hub's own directly-wired motor) or "2" (a linked
 * Motor_2 over the mesh) — motor NUMBERING, not the two-pump-changeover
 * "pumpA/pumpB" naming an earlier design used.
 * Returns null for anything that doesn't match, so callers can skip a
 * stray/malformed topic rather than crash on unexpected segments.
 */
function parseTopic(topic) {
  const parts = topic.split("/");
  if (parts[0] !== "farm") return null;

  const [, farmId, nodeId, ...rest] = parts;
  if (!farmId || !nodeId || rest.length === 0) return null;

  if (rest[0] === "motor" && rest.length === 3) {
    return { farmId, nodeId, category: "motor", motorNum: rest[1], leaf: rest[2] };
  }
  if (rest[0] === "ota" && rest.length === 2) {
    return { farmId, nodeId, category: "ota", motorNum: null, leaf: rest[1] };
  }
  if (rest[0] === "health" && rest.length === 1) {
    return { farmId, nodeId, category: "health", motorNum: null, leaf: "health" };
  }
  return null;
}

/** Live MQTT connection state of the bridge's own persistent client - used by GET /healthz (see server.js) for the "VPS & TBMQ" admin status page. */
export function isBridgeConnected() {
  return client !== null && client.connected === true;
}

export function connectBridge() {
  client = mqtt.connect(config.bridgeMqttUrl, {
    clientId: config.bridgeMqttUsername(),
    username: config.bridgeMqttUsername(),
    password: config.bridgeMqttPassword(),
    reconnectPeriod: 5000
  });

  client.on("connect", () => {
    console.log("[bridge] connected to TBMQ");
    client.subscribe("farm/+/#", { qos: 1 }, (err) => {
      if (err) console.error("[bridge] subscribe failed:", err);
      else console.log("[bridge] subscribed to farm/+/#");
    });
  });

  client.on("reconnect", () => console.log("[bridge] reconnecting..."));
  client.on("error", (err) => console.error("[bridge] MQTT error:", err.message));

  client.on("message", async (topic, messageBuf) => {
    const parsed = parseTopic(topic);
    if (!parsed) return;

    const { farmId, nodeId, category, motorNum, leaf } = parsed;

    // The bridge is itself subscribed to farm/+/#, which includes the
    // cmd topics it publishes to via publishCommand() below — MQTT
    // delivers a publisher its own message back when it's also a
    // subscriber to a matching topic. Skip cmd entirely: it's an echo of
    // our own outgoing publish, not a device-originated event worth a
    // history row.
    if (leaf === "cmd") return;

    let payload;
    try {
      payload = JSON.parse(messageBuf.toString());
    } catch {
      console.warn(`[bridge] non-JSON payload on ${topic}, storing raw`);
      payload = { raw: messageBuf.toString() };
    }

    const eventType = motorNum ? `motor${motorNum}_${leaf}` : `${category}_${leaf}`;

    // Fans this message out to every phone with a live WebSocket open on
    // this farm (see liveGateway.js) - the SAME message this bridge
    // already received on its one MQTT session, no new MQTT traffic. Never
    // awaited/guarded like the writes below: broadcastToFarm() is a
    // synchronous in-process Set iteration, not I/O, so there's nothing
    // here that can fail the way a Postgres/Firestore call can.
    broadcastToFarm(farmId, { topic, payload });

    try {
      await insertEvent({ farmId, nodeId, eventType, payload });
    } catch (err) {
      console.error("[bridge] postgres insert failed:", err);
    }

    if (category === "motor" && leaf === "status") {
      try {
        await mirrorStatus(farmId, nodeId, motorNum, payload);
      } catch (err) {
        console.error("[bridge] firestore mirror failed:", err);
      }

      // Alerts share the status topic with plain telemetry (see
      // connectivity.cpp's publishAlert()) - an "event" key is what
      // distinguishes the two, same discriminator PumpRepository.kt uses
      // on the app side.
      if (payload && typeof payload === "object" && payload.event !== undefined) {
        await sendAlertPush(farmId, nodeId, motorNum, payload);
      }
    }

    // Config echoes share the response topic with plain command acks (see
    // PumpRepository.kt's own `type` discriminator) - opportunistically
    // refreshes farm_config_cache so the next WebSocket subscribe doesn't
    // have to wait on a live device round trip (see farmConfigCache.js).
    if (category === "motor" && leaf === "response") {
      try {
        await setCachedConfigFromResponse(farmId, motorNum, payload);
      } catch (err) {
        console.error("[bridge] config cache write failed:", err);
      }
    }

    if (category === "health") {
      try {
        await mirrorHealth(farmId, nodeId, payload);
      } catch (err) {
        console.error("[bridge] firestore health mirror failed:", err);
      }
    }
  });

  return client;
}

/**
 * Publishes a command to a device's cmd topic on the caller's behalf —
 * fire-and-forget from this function's point of view (QoS1 handles
 * delivery at the MQTT level; waiting for the device's own `response`
 * message back would need request/response correlation this v1 doesn't
 * do). Throws if the bridge isn't currently connected.
 */
export function publishCommand(farmId, nodeId, motorNum, commandPayload) {
  if (!client || !client.connected) {
    throw new Error("Bridge is not connected to TBMQ");
  }

  const motor = motorNum === "2" ? "2" : "1";
  const topic = `farm/${farmId}/${nodeId}/motor/${motor}/cmd`;

  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(commandPayload), { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
