import { db } from "../firebaseAdmin.js";

// Same "still talking to the broker" threshold as the web admin panel's
// own isDeviceOnline() (public/js/device-status-render.js) - kept in sync
// manually since one's browser JS and the other's this Node module.
const ONLINE_THRESHOLD_MS = 60 * 1000;

function toMillis(lastSeen) {
  if (!lastSeen) return null;
  if (typeof lastSeen.toDate === "function") return lastSeen.toDate().getTime();
  const d = new Date(lastSeen);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Every farm with a controller assigned, plus its live deviceStatus - the
 * same data the web admin panel's Analytics fleet panel already reads via
 * its own Firestore listener, exposed here as a plain authenticated REST
 * call instead. Built for the Irrigo Admin app: it has no reason to hold
 * a Firestore SDK session (or an MQTT one) open just to answer "what's my
 * fleet's status right now" - one HTTPS call to the VPS it already has to
 * trust for commands covers it, at whatever cadence it chooses to poll.
 */
export async function getFleetStatus() {
  const snap = await db.collection("farmers").where("controller.uniqueId", "!=", null).get();

  return snap.docs.map((doc) => {
    const f = doc.data();
    const deviceStatus = f.deviceStatus || null;
    const lastSeenMs = toMillis(deviceStatus?.lastSeen);
    const online = lastSeenMs != null && Date.now() - lastSeenMs < ONLINE_THRESHOLD_MS;

    return {
      farmId: f.controller?.uniqueId || null,
      nodeId: deviceStatus?.nodeId || null,
      farmerName: f.name || null,
      farmBuddieId: f.farmBuddieId || null,
      online,
      lastSeen: lastSeenMs,
      deviceStatus: deviceStatus
        ? {
            motor1: deviceStatus.motor1 || null,
            motor2: deviceStatus.motor2 || null,
            health: deviceStatus.health || null,
          }
        : null,
    };
  });
}
