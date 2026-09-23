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
 * body: { instanceId: string, rotate?: boolean }
 *
 * Issues (or rotates) an MQTT credential scoped to every farm this phone
 * number has enabled access to (phoneIndex/{phone}.farms - see
 * phone-auth.js's fullPhoneSync()). Called by the Irrigo app itself, not
 * the admin panel.
 *
 * Reads farmIds straight from phoneIndex now instead of resolving an
 * identityId and querying farmers for it - phoneIndex.farms is keyed by
 * farmId directly and can legitimately span more than one identity (the
 * same phone can be an app-user on two unrelated farmers' systems), so
 * there's no longer a single identityId to resolve.
 *
 * Keyed by instanceId (a random id the app generates once and caches
 * locally), NOT by phone alone — the app connects to TBMQ directly (see
 * FarmConnectionManager/IrrigoMqttClient), and MQTT only allows one
 * active connection per client ID. A main farmer and any secondary users
 * (appUser2/appUser3) each running the app on their own phone need their
 * own distinct login, or each new connection would silently kick the
 * previous phone's session offline.
 */
provisionAppRouter.post("/", async (req, res) => {
  const { instanceId, rotate } = req.body || {};

  if (!instanceId || typeof instanceId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(instanceId)) {
    return res.status(400).json({ error: "instanceId is required (8-64 chars, alphanumeric/_/-)" });
  }

  const phone = normalizePhone(req.decodedToken.phone_number);

  if (!phone || phone.length !== 10) {
    return res.status(400).json({ error: "Signed-in account has no valid phone number" });
  }

  try {
    const phoneSnap = await db.collection("phoneIndex").doc(phone).get();

    if (!phoneSnap.exists || !phoneSnap.data().farms) {
      return res.status(404).json({ error: "No farms linked to this phone number" });
    }

    const farmIds = Object.entries(phoneSnap.data().farms)
      .filter(([, entry]) => entry.enabled)
      .map(([farmId]) => farmId);

    if (farmIds.length === 0) {
      return res.status(404).json({ error: "No enabled farms linked to this phone number" });
    }

    // Real topic tree (see irrigo-admin's mqtt/Topics.kt) is
    // farm/{farmId}/{nodeId}/motor/.../..., where farmId is controllers.uniqueId
    // (NOT farmBuddieId's "FARM-2026-xxxx" format). Pub is scoped to the same
    // whole-farm subtree as sub rather than just .../cmd, since valve/filter
    // command topics live under other node segments within the same farmId
    // that aren't fully enumerable here — tightening this to command-only
    // patterns is a reasonable follow-up once that full topic set is confirmed.
    const pubAuthRulePatterns = farmIds.map((farmId) => `farm/${farmId}/.*`);
    const subAuthRulePatterns = farmIds.map((farmId) => `farm/${farmId}/.*`);

    const clientId = `app-${phone}-${instanceId}`;
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
      farmIds,
      phone
    };

    // Auditability only, keyed by instanceId like fcmTokens/monitorCredentials
    // — one document per phone/install, not per farm.
    await db.collection("appMqttCredentials").doc(instanceId).set(metadata);

    return res.json({ ...metadata, password, clientId });
  } catch (err) {
    console.error("provision/app error:", err);
    return res.status(500).json({ error: "Failed to provision app credentials" });
  }
});
