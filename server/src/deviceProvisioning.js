import { db } from "./firebaseAdmin.js";
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "./tbmqClient.js";
import { generateMqttPassword } from "./password.js";
import { config } from "./config.js";

/**
 * Core of POST /provision/device and POST /provision/bootstrap — issues
 * (or rotates) MQTT credentials for a controller already assigned to a
 * farmer, and writes back credential METADATA (never the plaintext
 * password) to controllers/{controllerDocId} and
 * farmers/{farmerDocId}.controller.mqtt.
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

  const farmerRef = db.collection("farmers").doc(controller.farmerDocId);
  const farmerSnap = await farmerRef.get();

  if (!farmerSnap.exists) {
    throw { status: 404, message: "Assigned farmer not found" };
  }

  const farmer = farmerSnap.data();
  const farmId = controller.uniqueId;
  const clientId = `FBIRG${farmId}`;
  const existing = await findCredentialsByName(clientId);

  if (existing && !rotate) {
    throw {
      status: 409,
      message: "Credentials already exist for this device. Pass rotate: true to reissue.",
      credentialsId: existing.id?.id || existing.id
    };
  }

  if (existing) {
    await deleteCredentials(existing.id?.id || existing.id);
  }

  const password = generateMqttPassword();
  const topicPrefix = `farm/${farmId}`;

  const created = await createBasicCredentials({
    name: clientId,
    clientId,
    userName: clientId,
    password,
    pubAuthRulePatterns: [`${topicPrefix}/.*`],
    subAuthRulePatterns: [`${topicPrefix}/.*`]
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
    mqttIssuedAt: issuedAt
  });

  await farmerRef.update({
    "controller.mqtt": metadata
  });

  return {
    ...metadata,
    password, // returned once — not stored anywhere in plaintext
    clientId,
    topicPrefix,
    farmId,
    nodeId: "MOTOR_1", // the master hub's own fixed NODE_ID (see Motor firmware's config.h) — only it holds an MQTT credential
    farmerName: farmer.name || ""
  };
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
