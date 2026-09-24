import { deviceAuthRules } from "./mqttAuthRules.js";
import { db } from "./firebaseAdmin.js";
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "./tbmqClient.js";
import { generateMqttPassword } from "./password.js";
import { config } from "./config.js";

/**
 * Core of POST /provision/device and POST /provision/bootstrap — issues
 * (or rotates) MQTT credentials for a controller already assigned to a
 * farmer, and writes back credential metadata — INCLUDING the plaintext
 * password — to controllers/{controllerDocId}.mqttPasswordPlaintext and
 * farmers/{farmerDocId}.controller.mqtt.password.
 *
 * Deliberately durable, not write-once: this admin panel is founder-only
 * (no farmer/installer ever sees it), so a stable, always-viewable
 * credential fits the actual workflow better than forcing a new random
 * password every time someone just wants to look at or re-share the QR.
 * The tradeoff is real - anyone who can open this panel (or read the
 * farmers/controllers collections directly) can now see a live device's
 * MQTT password - acceptable only because access to both is already
 * restricted to the founding team, same trust boundary the rest of this
 * panel already assumes.
 *
 * Real topic tree (see irrigo-admin's mqtt/Topics.kt, and verified
 * directly against the Motor firmware's own connectivity.cpp) is
 * farm/{farmId}/{nodeId}/motor/.../..., where farmId is this same short
 * controllers.uniqueId (e.g. "0001") — NOT farmBuddieId's "FARM-2026-xxxx"
 * format. The master hub is the only thing with an MQTT connection and
 * relays for any BLE-linked secondary nodes (motor-node/valve/filter)
 * under the same farmId, so the ACL is scoped to the whole farm subtree
 * rather than just its own "MOTOR_1" segment.
 *
 * Throws a { status, message } object on any failure — callers translate
 * that into their own HTTP response shape.
 */
export async function issueDeviceCredential(controllerDocId, { rotate = false } = {}) {
  const controllerRef = db.collection("controllers").doc(controllerDocId);
  const controllerSnap = await controllerRef.get();

  if (!controllerSnap.exists) {
    throw { status: 404, message: "Controller not found" };
  }

  const controller = controllerSnap.data();

  if (controller.status !== "assigned") {
    throw { status: 409, message: `Controller must be assigned to a farmer first (current status: ${controller.status})` };
  }

  if (!controller.farmerDocId || !controller.uniqueId) {
    throw { status: 409, message: "Controller is missing farmerDocId or uniqueId" };
  }

  const farmId = controller.uniqueId;
  const { farmerRef, farmer } = await resolveFarmDoc(controllerRef, controller);
  const clientId = `FBIRG${farmId}`;
  const topicPrefix = `farm/${farmId}`;
  const existing = await findCredentialsByName(clientId);

  // Already issued and no explicit rotate requested — hand back the
  // SAME durably-stored credential instead of erroring, so the admin
  // panel can call this to just VIEW/redisplay the QR anytime with no
  // TBMQ mutation at all. Falls through to a genuine 404 below (rather
  // than a confusing stale-password response) on the edge case where a
  // credential exists on TBMQ but this controller doc predates plaintext
  // storage being added.
  if (existing && !rotate) {
    if (controller.mqttPasswordPlaintext) {
      // Re-sync the farm doc's copy if it's missing or belongs to another
      // controller (the old Add Farm bug wrote a second farm's login into
      // the first farm's doc).
      const shown = farmer.controller?.mqtt || {};
      if (shown.username !== controller.username || shown.password !== controller.mqttPasswordPlaintext) {
        await farmerRef.update({
          "controller.mqtt": {
            brokerUrl: controller.mqttUrl,
            port: controller.mqttPort,
            username: controller.username,
            credentialsId: controller.mqttCredentialsId,
            issuedAt: controller.mqttIssuedAt,
            password: controller.mqttPasswordPlaintext
          }
        });
      }
      return {
        brokerUrl: controller.mqttUrl,
        port: controller.mqttPort,
        username: controller.username,
        password: controller.mqttPasswordPlaintext,
        credentialsId: controller.mqttCredentialsId,
        issuedAt: controller.mqttIssuedAt,
        clientId,
        topicPrefix,
        farmId,
        nodeId: "MOTOR_1",
        farmerName: farmer.name || "",
        farmBuddieId: farmer.farmBuddieId || ""
      };
    }
    throw {
      status: 409,
      message: "Credentials exist on TBMQ but predate plaintext storage - pass rotate: true to reissue and store it.",
      credentialsId: existing.id?.id || existing.id
    };
  }

  if (existing) {
    await deleteCredentials(existing.id?.id || existing.id);
  }

  const password = generateMqttPassword();

  const created = await createBasicCredentials({
    name: clientId,
    clientId,
    userName: clientId,
    password,
    ...deviceAuthRules(farmId)
  });

  const credentialsId = created.id?.id || created.id;
  const issuedAt = new Date().toISOString();

  const metadata = {
    brokerUrl: config.mqttBrokerHost,
    port: config.mqttBrokerPort,
    username: clientId,
    credentialsId,
    issuedAt
  };

  await controllerRef.update({
    mqttUrl: metadata.brokerUrl,
    mqttPort: metadata.port,
    username: metadata.username,
    mqttCredentialsId: credentialsId,
    mqttIssuedAt: issuedAt,
    mqttPasswordPlaintext: password
  });

  await farmerRef.update({
    "controller.mqtt": { ...metadata, password }
  });

  return {
    ...metadata,
    password,
    clientId,
    topicPrefix,
    farmId,
    nodeId: "MOTOR_1", // the master hub's own fixed NODE_ID (see Motor firmware's config.h) — only it holds an MQTT credential
    farmerName: farmer.name || "",
    farmBuddieId: farmer.farmBuddieId || ""
  };
}

/**
 * The farm doc this controller belongs to: the farmers doc whose
 * controller.uniqueId is this controller's uniqueId - the same lookup the
 * bridge uses (firestoreMirror.js). controllers.farmerDocId is only a hint:
 * Add Farm used to set it to the farmer's FIRST farm, so a second farm's
 * credentials landed in the first farm's doc. A wrong hint is corrected
 * here.
 */
async function resolveFarmDoc(controllerRef, controller) {
  const hintRef = db.collection("farmers").doc(controller.farmerDocId);
  const hintSnap = await hintRef.get();
  if (hintSnap.exists && hintSnap.data().controller?.uniqueId === controller.uniqueId) {
    return { farmerRef: hintRef, farmer: hintSnap.data() };
  }

  const snap = await db
    .collection("farmers")
    .where("controller.uniqueId", "==", controller.uniqueId)
    .get();

  if (snap.size > 1) {
    throw { status: 409, message: `More than one farm has controller ${controller.uniqueId} - fix the farm records first` };
  }
  if (snap.empty) {
    throw { status: 404, message: `No farm record has controller ${controller.uniqueId}` };
  }

  const found = snap.docs[0];
  await controllerRef.update({ farmerDocId: found.id });
  return { farmerRef: found.ref, farmer: found.data() };
}

/**
 * Same as issueDeviceCredential(), but looked up by farmId (controllers.
 * uniqueId) instead of the Firestore doc id — what the device itself
 * knows about itself, used by POST /provision/bootstrap.
 */
export async function issueDeviceCredentialByFarmId(farmId, options = {}) {
  const snap = await db
    .collection("controllers")
    .where("uniqueId", "==", farmId)
    .limit(1)
    .get();

  if (snap.empty) {
    throw { status: 404, message: "No controller found for this farmId" };
  }

  return issueDeviceCredential(snap.docs[0].id, options);
}
