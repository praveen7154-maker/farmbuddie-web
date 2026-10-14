import { db } from "../firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { MOTOR_NUMBERS, normalizeMotorNum } from "./motorNumbers.js";
import { createStatusThrottle } from "./statusThrottle.js";

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

  // Remembered too (until the 5-min clear below): a hub not assigned to a
  // farmer yet otherwise cost a Firestore query on every message it sent.
  if (snap.empty) {
    farmIdToFarmerDoc.set(farmId, null);
    return null;
  }

  const docId = snap.docs[0].id;
  farmIdToFarmerDoc.set(farmId, docId);
  return docId;
}

export function startFarmerDocCacheRefresh() {
  setInterval(() => farmIdToFarmerDoc.clear(), 5 * 60 * 1000);
}

// The latest report of each kind per farm, and when Firestore last got it -
// see statusThrottle.js for when a report is (and isn't) written.
const throttle = createStatusThrottle();
// One Firestore write at a time per farm, in order.
const writeChain = new Map();   // farmId -> Promise

function serialized(farmId, fn) {
  const prev = writeChain.get(farmId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeChain.set(farmId, next);
  next.finally(() => { if (writeChain.get(farmId) === next) writeChain.delete(farmId); });
  return next;
}

/** The farm's latest reports as this server last heard them (null if none since it started). */
export function liveSnapshot(farmId) {
  return throttle.snapshot(farmId);
}

// deviceStatus field updates for the given { field: payload } reports.
function fieldUpdates(fields) {
  const update = {};
  for (const [field, payload] of Object.entries(fields)) {
    if (field === "valves") {
      update["deviceStatus.valves"] = payload === null ? FieldValue.delete() : payload;
      continue;
    }
    // update() with field paths REPLACES each field as a whole. set(...,
    // { merge: true }) deep-merged it instead, so a field the hub stopped
    // sending stayed in Firestore forever with its last value.
    update[`deviceStatus.${field}`] = payload;
    // The hub's own status lists every paired motor node (motor_nodes,
    // omitted when there are none). A node removed from the farm otherwise
    // kept its last relayed status here forever, and the web panel kept
    // showing it as a live motor.
    if (field === "motor1" && payload && typeof payload === "object" && "state" in payload) {
      const paired = payload.motor_nodes && typeof payload.motor_nodes === "object" ? payload.motor_nodes : {};
      for (const n of MOTOR_NUMBERS) {
        if (n === "1" || n in paired) continue;
        if (n === "2" && typeof payload.motor2_online === "boolean") continue;   // hub firmware from before motor_nodes
        // A motor node's own report in this same write wins.
        if (!(`motor${n}` in fields)) update[`deviceStatus.motor${n}`] = FieldValue.delete();
      }
    }
  }
  return update;
}

// A report came in: kept in memory, written to farmers/{docId}.deviceStatus
// when it matters (see statusThrottle.js).
async function mirror(farmId, nodeId, field, payload, label) {
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) {
    console.warn(`[bridge] ${label} for unknown farmId=${farmId}, no matching controller — dropped`);
    return;
  }
  const { write } = throttle.note(farmId, nodeId, field, payload);
  if (!write) return;
  await serialized(farmId, async () => {
    const fields = throttle.pending(farmId);
    if (!Object.keys(fields).length) return;   // an earlier queued write already sent these
    const snap = throttle.snapshot(farmId);
    await db.collection("farmers").doc(farmerDocId).update({
      "deviceStatus.nodeId": snap.nodeId,
      "deviceStatus.lastSeen": new Date(snap.lastMsgAt),
      "deviceStatus.offlineAt": FieldValue.delete(),
      ...fieldUpdates(fields)
    });
    throttle.written(farmId, fields);
  });
}

/**
 * Mirrors a device's live status into farmers/{docId}.deviceStatus.motorN —
 * the "what's true right now" copy the web panel reads via Firestore
 * listeners (the firmware's payload as-is; motor NUMBER, not a letter).
 */
export async function mirrorStatus(farmId, nodeId, motorNum, payload) {
  await mirror(farmId, nodeId, `motor${normalizeMotorNum(motorNum)}`, payload, "status");
}

/**
 * The device's separate `health` topic (uptime/transport/signal/
 * reset_reason/fw_version) under deviceStatus.health.
 */
export async function mirrorHealth(farmId, nodeId, payload) {
  await mirror(farmId, nodeId, "health", payload, "health");
}

/**
 * The hub's valve mesh snapshot (valves topic) under deviceStatus.valves;
 * null removes it (valve mode turned off).
 */
export async function mirrorValves(farmId, nodeId, payload) {
  await mirror(farmId, nodeId, "valves", payload, "valves");
}

/**
 * Once a minute: a farm that has gone quiet gets one write - offlineAt,
 * the real lastSeen and anything not written yet - so the web panel shows
 * it offline straight away (see device-status-render.js isDeviceOnline()).
 */
export function startOfflineSweep() {
  setInterval(async () => {
    for (const farmId of throttle.dueOffline()) {
      try {
        const farmerDocId = await resolveFarmerDocId(farmId);
        if (!farmerDocId) { throttle.forget(farmId); continue; }
        await serialized(farmId, async () => {
          const fields = throttle.pending(farmId);
          const snap = throttle.snapshot(farmId);
          await db.collection("farmers").doc(farmerDocId).update({
            "deviceStatus.lastSeen": new Date(snap.lastMsgAt),
            "deviceStatus.offlineAt": new Date(),
            ...fieldUpdates(fields)
          });
          throttle.markedOffline(farmId);
        });
      } catch (err) {
        console.error(`[bridge] offline mark failed for ${farmId}:`, err.message);
      }
    }
  }, 60 * 1000);
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
  // Fresher than Firestore (written only now and then) and no Firestore read.
  const live = throttle.snapshot(farmId);
  if (live?.nodeId) {
    const ageSec = Math.max(0, Math.round((Date.now() - live.lastMsgAt) / 1000));
    return ["1", "2", "3", "4"].filter((n) => live.latest[`motor${n}`] && typeof live.latest[`motor${n}`] === "object")
      .map((n) => ({ topic: `farm/${farmId}/${live.nodeId}/motor/${n}/status`, payload: live.latest[`motor${n}`], ageSec }));
  }
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
  const live = throttle.snapshot(farmId);
  if (live?.nodeId && live.latest.health) return { topic: `farm/${farmId}/${live.nodeId}/health`, payload: live.latest.health };
  const farmerDocId = await resolveFarmerDocId(farmId);
  if (!farmerDocId) return null;
  const snap = await db.collection("farmers").doc(farmerDocId).get();
  const deviceStatus = snap.exists ? snap.data().deviceStatus : null;
  if (!deviceStatus?.health || !deviceStatus.nodeId) return null;
  return { topic: `farm/${farmId}/${deviceStatus.nodeId}/health`, payload: deviceStatus.health };
}
