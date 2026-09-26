import { db } from "../firebaseAdmin.js";

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

  const motorKey = motorNum === "2" ? "motor2" : "motor1";

  await db
    .collection("farmers")
    .doc(farmerDocId)
    .set(
      {
        deviceStatus: {
          nodeId,
          lastSeen: new Date(),
          [motorKey]: payload
        }
      },
      { merge: true }
    );
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

  await db
    .collection("farmers")
    .doc(farmerDocId)
    .set(
      {
        deviceStatus: {
          nodeId,
          lastSeen: new Date(),
          health: payload
        }
      },
      { merge: true }
    );
}

/**
 * The last health report mirrorHealth() stored for this farm, shaped like the
 * live MQTT message ({topic, payload}) - sent to a phone the moment its live
 * connection opens (liveGateway.js), so the app's Maintenance screen has the
 * hub's diagnostics straight away instead of "unknown" until the next health
 * report (every 5 minutes). Null if the farm has none yet.
 */
export async function loadLastHealthMessage(farmId) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) return null;
  const snap = await db.collection("farmers").doc(farmerDocId).get();
  const deviceStatus = snap.exists ? snap.data().deviceStatus : null;
  if (!deviceStatus?.health || !deviceStatus.nodeId) return null;
  return { topic: `farm/${farmId}/${deviceStatus.nodeId}/health`, payload: deviceStatus.health };
}
