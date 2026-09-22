import { Router } from "express";
import { db } from "../firebaseAdmin.js";
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "../tbmqClient.js";
import { generateMqttPassword } from "../password.js";
import { config } from "../config.js";

export const provisionDeviceRouter = Router();

/**
 * POST /provision/device
 * body: { controllerDocId: string, rotate?: boolean }
 *
 * Issues (or rotates) MQTT credentials for a controller that has already
 * been assigned to a farmer in the admin panel. Called from
 * controller-view.html by a signed-in farmbuddie-web admin.
 *
 * Writes credential METADATA (never the plaintext password) to:
 *   - controllers/{controllerDocId}: mqttUrl, mqttPort, username, mqttCredentialsId, mqttIssuedAt
 *   - farmers/{farmerDocId}.controller.mqtt: { brokerUrl, port, username, credentialsId, issuedAt }
 * (These are the exact fields add-farm.js already reads from `controllers` docs —
 * they were always present in schema, just never populated until now.)
 *
 * The plaintext password is returned ONCE in the response and must be copied
 * by the admin (e.g. into the BLE-provisioning tool) — it is not retrievable again.
 */
provisionDeviceRouter.post("/", async (req, res) => {
  const { controllerDocId, rotate } = req.body || {};

  if (!controllerDocId || typeof controllerDocId !== "string") {
    return res.status(400).json({ error: "controllerDocId is required" });
  }

  try {
    const controllerRef = db.collection("controllers").doc(controllerDocId);
    const controllerSnap = await controllerRef.get();

    if (!controllerSnap.exists) {
      return res.status(404).json({ error: "Controller not found" });
    }

    const controller = controllerSnap.data();

    if (controller.status !== "assigned") {
      return res.status(409).json({
        error: `Controller must be assigned to a farmer first (current status: ${controller.status})`
      });
    }

    if (!controller.farmerDocId || !controller.uniqueId) {
      return res.status(409).json({ error: "Controller is missing farmerDocId or uniqueId" });
    }

    const farmerRef = db.collection("farmers").doc(controller.farmerDocId);
    const farmerSnap = await farmerRef.get();

    if (!farmerSnap.exists) {
      return res.status(404).json({ error: "Assigned farmer not found" });
    }

    const farmer = farmerSnap.data();
    const farmBuddieId = farmer.farmBuddieId;

    if (!farmBuddieId) {
      return res.status(409).json({ error: "Farmer is missing farmBuddieId" });
    }

    // Real topic tree (see irrigo-admin's mqtt/Topics.kt) is
    // farm/{farmId}/{nodeId}/motor/.../..., where farmId is this same short
    // controllers.uniqueId (e.g. "0001") — NOT farmBuddieId's "FARM-2026-xxxx"
    // format. The master hub is the only thing with an MQTT connection and
    // relays for any BLE-linked secondary nodes (motor-node/valve/filter)
    // under the same farmId, so the ACL is scoped to the whole farm subtree
    // rather than just its own "MOTOR_1" segment.
    const farmId = controller.uniqueId;
    const clientId = `FBIRG${farmId}`;
    const existing = await findCredentialsByName(clientId);

    if (existing && !rotate) {
      return res.status(409).json({
        error: "Credentials already exist for this device. Pass rotate: true to reissue.",
        credentialsId: existing.id?.id || existing.id
      });
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

    return res.json({
      ...metadata,
      password, // returned once — not stored anywhere in plaintext
      clientId,
      topicPrefix,
      farmId,
      nodeId: "MOTOR_1", // the master hub's own fixed NODE_ID (see Motor firmware's config.h) — only it holds an MQTT credential
      farmerName: farmer.name || ""
    });
  } catch (err) {
    console.error("provision/device error:", err);
    return res.status(500).json({ error: "Failed to provision device credentials" });
  }
});
