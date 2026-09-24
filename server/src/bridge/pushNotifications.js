import { db, messaging } from "../firebaseAdmin.js";
import { config } from "../config.js";

// Which device alerts are worth a push - mirrors the Irrigo app's own
// PumpCodes.isPushWorthy() (and the EVENT_* codes in the Motor firmware's
// config.h). Kept as a plain list so the server doesn't wake phones for
// routine cyclic/valve-sequence chatter; the app makes the final call and
// also collapses repeats (one notification per fault, one per recovery -
// see its NotificationGate), so a code listed here that the app then
// suppresses costs nothing but a silent data message. Update both together.
const PUSH_EVENTS = new Set([
  11, 12,          // power outage / power restored
  16, 29,          // motor started / stopped manually at the panel
  17,              // fault cleared
  22,              // stop not confirmed (unexpected motor state)
  24, 64,          // phase restored / voltage restored
  25, 34, 35,      // dry-run auto-restart, auto-clear limit reached (dry run / overload)
  30, 47,          // cyclic / valve-cyclic paused by a manual stop - needs a decision
  48, 49,          // valve opened / closed (standalone action)
  51, 54, 55, 57,  // valve-gated start failed, no valve responded, two valves open, valve closed mid-run
  65               // controller restarted while the motor was running
]);
const LEGACY_VOLTAGE_RESTORED = 10; // older firmware - same value as FAULT_POWER_OUTAGE, told apart by fault == 0

function isPushWorthy(payload) {
  const { event, fault } = payload;
  if (typeof event !== "number") return false;
  if (typeof fault === "number" && fault !== 0 && event === fault) return true; // a fault tripping
  if (event === LEGACY_VOLTAGE_RESTORED && fault === 0) return true;
  return PUSH_EVENTS.has(event);
}

// Only for notification-style pushes (PUSH_DATA_ONLY off) - what older app
// builds display as-is, straight from the system tray.
function buildNotification(nodeId, motorNum, payload) {
  const motorLabel = motorNum === "2" ? "Motor 2" : "Motor 1";
  const { event, fault } = payload;
  if (typeof fault === "number" && fault !== 0 && event === fault) {
    return { title: motorLabel, body: `Fault detected (code ${fault}) on ${nodeId}` };
  }
  return { title: motorLabel, body: `Alert (code ${event}) on ${nodeId}` };
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

    // Data-only (PUSH_DATA_ONLY=true): the app builds the (localised,
    // detailed) notification itself and de-duplicates it against the same
    // alert arriving over its own MQTT connection - see the app's
    // IrrigoFcmService. Until then, a notification block the system shows
    // by itself, as older app builds expect. High priority so it's delivered
    // promptly to a phone in Doze / an app that's closed.
    const response = await messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      android: { priority: "high" },
      ...(config.pushDataOnly ? {} : { notification: buildNotification(nodeId, motorNum, payload) }),
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
