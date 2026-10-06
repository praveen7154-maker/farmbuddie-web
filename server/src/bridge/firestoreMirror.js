import { db } from "../firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { MOTOR_NUMBERS, normalizeMotorNum } from "./motorNumbers.js";

// farmId (controllers.uniqueId, e.g. "0003") -> farmers/{docId} — resolved
// once per farmId and cached, since every incoming MQTT message would
// otherwise trigger a Firestore query. Refreshed lazily on a cache miss
// (new device) and periodically in case a controller gets reassigned.
const farmIdToFarmerDoc = new Map();

export async function resolveFarmerDocId(farmId) {
  if (farmIdToFarmerDoc.has(farmId)) return farmIdToFarmerDoc.get(farmId);

  const snap = await db
    .collection("farmers")
    .where("controller.uniqueId", "==", farmId)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const docId = snap.docs[0].id;
  farmIdToFarmerDoc.set(farmId, docId);
  return docId;
}

export function startFarmerDocCacheRefresh() {
  setInterval(() => farmIdToFarmerDoc.clear(), 5 * 60 * 1000);
}

/**
 * Mirrors a device's live status into farmers/{docId}.deviceStatus — the
 * "what's true right now" copy the web panel/app read via Firestore
 * listeners. This writes the firmware's actual payload as-is under
 * deviceStatus.motor1/motor2 (motor NUMBER, not a "pumpA/pumpB" letter —
 * verified directly against connectivity.cpp's real topic-building code,
 * not the Motor repo's README, which describes a stale/different design).
 * See mirrorHealth() below for the separate `health` topic's own payload
 * (deviceStatus.health) - device-view.js reads both.
 */
export async function mirrorStatus(farmId, nodeId, motorNum, payload) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) {
    console.warn(`[bridge] status for unknown farmId=${farmId}, no matching controller — dropped`);
    return;
  }

  const motorKey = `motor${normalizeMotorNum(motorNum)}`;

  // update() with field paths REPLACES deviceStatus.motor1/motor2 as a
  // whole. set(..., { merge: true }) deep-merged it instead, so a field the
  // hub stopped sending (the per-valve lists moved to the valves topic)
  // stayed in Firestore forever with its last value.
  const update = {
    "deviceStatus.nodeId": nodeId,
    "deviceStatus.lastSeen": new Date(),
    [`deviceStatus.${motorKey}`]: payload
  };
  // The hub's own status lists every paired motor node (motor_nodes,
  // omitted when there are none). A node removed from the farm otherwise
  // kept its last relayed status here forever, and the web panel kept
  // showing it as a live motor.
  if (motorKey === "motor1" && payload && typeof payload === "object" && "state" in payload) {
    const paired = payload.motor_nodes && typeof payload.motor_nodes === "object" ? payload.motor_nodes : {};
    for (const n of MOTOR_NUMBERS) {
      if (n === "1" || n in paired) continue;
      if (n === "2" && typeof payload.motor2_online === "boolean") continue;   // hub firmware from before motor_nodes
      update[`deviceStatus.motor${n}`] = FieldValue.delete();
    }
  }
  await db.collection("farmers").doc(farmerDocId).update(update);
}

/**
 * Same idea as mirrorStatus() above, for the device's separate `health`
 * topic (uptime/transport/signal/reset_reason/fw_version - see Irrigo
 * app's model/PumpModels.kt HealthStatus) — a different cadence and
 * payload shape from motor status, so it gets its own field
 * (deviceStatus.health) rather than being merged into motor1/motor2.
 * Also bumps lastSeen, same as mirrorStatus() - either message type is
 * equally valid proof the device is alive right now.
 */
export async function mirrorHealth(farmId, nodeId, payload) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) {
    console.warn(`[bridge] health for unknown farmId=${farmId}, no matching controller — dropped`);
    return;
  }

  // Whole-field replace - see mirrorStatus().
  await db.collection("farmers").doc(farmerDocId).update({
    "deviceStatus.nodeId": nodeId,
    "deviceStatus.lastSeen": new Date(),
    "deviceStatus.health": payload
  });
}

/**
 * The hub's valve mesh snapshot (valves topic - see the Motor firmware's
 * sendValves()) under deviceStatus.valves; null removes it (valve mode
 * turned off). Also bumps lastSeen, like the other two.
 */
export async function mirrorValves(farmId, nodeId, payload) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) return;
  // Whole-field replace - see mirrorStatus().
  await db.collection("farmers").doc(farmerDocId).update({
    "deviceStatus.nodeId": nodeId,
    "deviceStatus.lastSeen": new Date(),
    "deviceStatus.valves": payload === null ? FieldValue.delete() : payload
  });
}

/**
 * The last health report mirrorHealth() stored for this farm, shaped like the
 * live MQTT message ({topic, payload}) - sent to a phone the moment its live
 * connection opens (liveGateway.js), so the app's Maintenance screen has the
 * hub's diagnostics straight away instead of "unknown" until the next health
 * report (every 5 minutes). Null if the farm has none yet.
 */
/**
 * Each motor's last mirrored status (deviceStatus.motor1..motor4) as
 * { topic, payload, ageSec } - sent to a phone the moment its live channel
 * opens (see liveGateway.js), so Home can show the last known readings
 * straight away instead of waiting on a get_status round trip over GSM.
 * ageSec is from the hub's lastSeen; the phone treats these as cached, not
 * live (see the app's PumpRepository).
 */
export async function loadLastStatusMessages(farmId) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) return [];
  const snap = await db.collection("farmers").doc(farmerDocId).get();
  const deviceStatus = snap.exists ? snap.data().deviceStatus : null;
  if (!deviceStatus?.nodeId) return [];
  const lastSeen = deviceStatus.lastSeen?.toDate?.();
  const ageSec = lastSeen ? Math.max(0, Math.round((Date.now() - lastSeen.getTime()) / 1000)) : null;
  const out = [];
  for (const n of ["1", "2", "3", "4"]) {
    const payload = deviceStatus[`motor${n}`];
    if (payload && typeof payload === "object") {
      out.push({ topic: `farm/${farmId}/${deviceStatus.nodeId}/motor/${n}/status`, payload, ageSec });
    }
  }
  return out;
}

export async function loadLastHealthMessage(farmId) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) return null;
  const snap = await db.collection("farmers").doc(farmerDocId).get();
  const deviceStatus = snap.exists ? snap.data().deviceStatus : null;
  if (!deviceStatus?.health || !deviceStatus.nodeId) return null;
  return { topic: `farm/${farmId}/${deviceStatus.nodeId}/health`, payload: deviceStatus.health };
}
