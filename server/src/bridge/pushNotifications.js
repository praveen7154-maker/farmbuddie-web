import { db, messaging } from "../firebaseAdmin.js";

// Power events worth interrupting a farmer for even with the app closed -
// mirrors (a deliberately small, non-drifting subset of) the Irrigo app's
// own PumpCodes.isPushWorthy()/EVENT_* constants. The app's real filter is
// much richer (valve-sequence edge cases, DOL start/stop, ...) but fully
// porting that here would duplicate logic that only the app's Kotlin source
// should own and would silently drift out of sync with it over time. This
// picks the two unambiguous, high-value cases instead: a real fault
// (fault != 0) or a power transition - the same reasoning the firmware's
// own SMS-critical-alert path already uses.
const POWER_EVENTS = new Set([10, 11, 12, 13, 24]); // voltage/power restored, power outage, 3rd phase available, phase restored

function isPushWorthy(payload) {
  if (typeof payload.fault === "number" && payload.fault !== 0) return true;
  if (typeof payload.event === "number" && POWER_EVENTS.has(payload.event)) return true;
  return false;
}

function buildNotification(nodeId, motorNum, payload) {
  const motorLabel = motorNum === "2" ? "Motor 2" : "Motor 1";
  if (typeof payload.fault === "number" && payload.fault !== 0) {
    return { title: motorLabel, body: `Fault detected (code ${payload.fault}) on ${nodeId}` };
  }
  return { title: motorLabel, body: `Power event (code ${payload.event}) on ${nodeId}` };
}

async function tokensForFarmId(farmId) {
  // fcmTokens/{instanceId} - one doc per (phone, app install), same
  // instanceId concept as appMqttCredentials/{instanceId} (see
  // routes/provisionApp.js) and routes/fcmToken.js, which is what writes
  // these, storing every farmId that phone has enabled access to
  // (phoneIndex/{phone}.farms - see phone-auth.js's fullPhoneSync()).
  // Every phone linked to this farm (main farmer + whatever extra
  // numbers were added via appUsers, regardless of which identity owns
  // which farm) gets its own token here, so all of them get notified.
  const snap = await db.collection("fcmTokens").where("farmIds", "array-contains", farmId).get();
  return snap.docs.map((d) => ({ instanceId: d.id, token: d.data().token }));
}

/**
 * Fire-and-forget FCM push for a device-originated alert - called from
 * mqttBridge.js whenever an incoming motor/status payload turns out to be
 * an alert (shares the status topic with plain telemetry - see
 * mqttBridge.js's own comment - distinguished by payload.event being
 * present, same discriminator the app's own PumpRepository uses).
 * Deliberately never throws into its caller - a notification failing to
 * send must never affect the Postgres/Firestore write path it runs
 * alongside.
 */
export async function sendAlertPush(farmId, nodeId, motorNum, payload) {
  try {
    if (!isPushWorthy(payload)) return;

    const tokens = await tokensForFarmId(farmId);
    if (tokens.length === 0) return;

    const notification = buildNotification(nodeId, motorNum, payload);

    const response = await messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      notification,
      data: {
        farmId,
        nodeId,
        motorNum: motorNum || "",
        payload: JSON.stringify(payload)
      }
    });

    // Standard FCM housekeeping - a token that's been uninstalled/expired
    // comes back as registration-token-not-registered on every future send
    // otherwise, silently wasting a lookup forever.
    response.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
        db.collection("fcmTokens").doc(tokens[i].instanceId).delete().catch(() => {});
      }
    });
  } catch (err) {
    console.error("[bridge] push notification failed:", err);
  }
}
