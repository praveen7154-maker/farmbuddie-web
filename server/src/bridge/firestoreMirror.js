import { db } from "../firebaseAdmin.js";

// farmId (controllers.uniqueId, e.g. "0003") -> farmers/{docId} — resolved
// once per farmId and cached, since every incoming MQTT message would
// otherwise trigger a Firestore query. Refreshed lazily on a cache miss
// (new device) and periodically in case a controller gets reassigned.
const farmIdToFarmerDoc = new Map();

async function resolveFarmerDocId(farmId) {
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
 * listeners. This writes the NEW firmware's actual payload shape
 * (pump: "A"|"B", active, state, fault, ...) under deviceStatus.pumpA/
 * pumpB — device-view.js still reads an OLDER shape (m1/m2/m3,
 * lora.packets_*) from a superseded architecture and needs updating
 * separately to match; not done here to keep this change scoped to the
 * bridge itself.
 */
export async function mirrorStatus(farmId, nodeId, pump, payload) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) {
    console.warn(`[bridge] status for unknown farmId=${farmId}, no matching controller — dropped`);
    return;
  }

  const pumpKey = pump === "B" ? "pumpB" : "pumpA";

  await db
    .collection("farmers")
    .doc(farmerDocId)
    .set(
      {
        deviceStatus: {
          nodeId,
          lastSeen: new Date(),
          [pumpKey]: payload
        }
      },
      { merge: true }
    );
}
