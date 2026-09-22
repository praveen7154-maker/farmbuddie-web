import mqtt from "mqtt";
import { config } from "../config.js";
import { insertEvent } from "./postgres.js";
import { mirrorStatus } from "./firestoreMirror.js";

let client = null;

/**
 * farm/<farmId>/motor/<nodeId>/pumpA|pumpB/status|response, or
 * farm/<farmId>/motor/<nodeId>/ota/status — see the Motor firmware's own
 * README for the authoritative topic shape. Returns null for anything
 * that doesn't match (e.g. a stray/malformed topic), so callers can skip
 * it rather than crash on unexpected segments.
 */
function parseTopic(topic) {
  const parts = topic.split("/");
  if (parts.length !== 6 || parts[0] !== "farm" || parts[2] !== "motor") return null;

  const [, farmId, , nodeId, subDevice, leaf] = parts;
  return { farmId, nodeId, subDevice, leaf };
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

    const { farmId, nodeId, subDevice, leaf } = parsed;

    let payload;
    try {
      payload = JSON.parse(messageBuf.toString());
    } catch {
      console.warn(`[bridge] non-JSON payload on ${topic}, storing raw`);
      payload = { raw: messageBuf.toString() };
    }

    const eventType = `${subDevice}_${leaf}`; // e.g. "pumpA_status", "ota_status"

    try {
      await insertEvent({ farmId, nodeId, eventType, payload });
    } catch (err) {
      console.error("[bridge] postgres insert failed:", err);
    }

    if ((subDevice === "pumpA" || subDevice === "pumpB") && leaf === "status") {
      const pump = subDevice === "pumpB" ? "B" : "A";
      try {
        await mirrorStatus(farmId, nodeId, pump, payload);
      } catch (err) {
        console.error("[bridge] firestore mirror failed:", err);
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
export function publishCommand(farmId, nodeId, pump, commandPayload) {
  if (!client || !client.connected) {
    throw new Error("Bridge is not connected to TBMQ");
  }

  const pumpSegment = pump === "B" ? "pumpB" : "pumpA";
  const topic = `farm/${farmId}/motor/${nodeId}/${pumpSegment}/cmd`;

  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(commandPayload), { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
