import { Router } from "express";
import { db } from "../firebaseAdmin.js";
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "../tbmqClient.js";
import { generateMqttPassword } from "../password.js";
import { config } from "../config.js";

export const provisionAppRouter = Router();

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/**
 * POST /provision/app
 * body: { rotate?: boolean }
 *
 * Issues (or rotates) a single MQTT credential for the farmer app instance,
 * scoped to every farm/device the calling phone number owns (via the same
 * phoneIndex -> identityId mapping the app already uses to log in).
 * Called by the Irrigo app itself, not the admin panel.
 */
provisionAppRouter.post("/", async (req, res) => {
  const { rotate } = req.body || {};
  const phone = normalizePhone(req.decodedToken.phone_number);

  if (!phone || phone.length !== 10) {
    return res.status(400).json({ error: "Signed-in account has no valid phone number" });
  }

  try {
    const phoneSnap = await db.collection("phoneIndex").doc(phone).get();

    if (!phoneSnap.exists || !phoneSnap.data().identityId) {
      return res.status(404).json({ error: "No farmer identity linked to this phone number" });
    }

    const identityId = phoneSnap.data().identityId;

    const farmsSnap = await db
      .collection("farmers")
      .where("identityId", "==", identityId)
      .get();

    if (farmsSnap.empty) {
      return res.status(404).json({ error: "No farms found for this identity" });
    }

    const pubAuthRulePatterns = [];
    const subAuthRulePatterns = [];
    const farmIds = [];

    // Real topic tree (see irrigo-admin's mqtt/Topics.kt) is
    // farm/{farmId}/{nodeId}/motor/.../..., where farmId is controllers.uniqueId
    // (NOT farmBuddieId's "FARM-2026-xxxx" format). Pub is scoped to the same
    // whole-farm subtree as sub rather than just .../cmd, since valve/filter
    // command topics live under other node segments within the same farmId
    // that aren't fully enumerable here — tightening this to command-only
    // patterns is a reasonable follow-up once that full topic set is confirmed.
    farmsSnap.forEach((docSnap) => {
      const farm = docSnap.data();
      const farmId = farm.controller?.uniqueId;
      if (!farmId) return;

      farmIds.push(farmId);
      subAuthRulePatterns.push(`farm/${farmId}/.*`);
      pubAuthRulePatterns.push(`farm/${farmId}/.*`);
    });

    if (farmIds.length === 0) {
      return res.status(409).json({ error: "None of this identity's farms have a provisioned device yet" });
    }

    const clientId = `app-${identityId}`;
    const existing = await findCredentialsByName(clientId);

    if (existing && !rotate) {
      return res.status(409).json({
        error: "Credentials already exist for this app account. Pass rotate: true to reissue.",
        credentialsId: existing.id?.id || existing.id
      });
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
      pubAuthRulePatterns,
      subAuthRulePatterns
    });

    const credentialsId = created.id?.id || created.id;
    const issuedAt = new Date().toISOString();

    const metadata = {
      brokerUrl: config.mqttBrokerHost,
      port: config.mqttBrokerPort,
      username: clientId,
      credentialsId,
      issuedAt,
      farmIds
    };

    await db.collection("appMqttCredentials").doc(identityId).set(metadata);

    return res.json({ ...metadata, password, clientId });
  } catch (err) {
    console.error("provision/app error:", err);
    return res.status(500).json({ error: "Failed to provision app credentials" });
  }
});
