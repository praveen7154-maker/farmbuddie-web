import { Router } from "express";
import { db } from "../firebaseAdmin.js";
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "../tbmqClient.js";
import { generateMqttPassword } from "../password.js";
import { config } from "../config.js";

export const provisionMonitorRouter = Router();

/**
 * POST /provision/monitor
 * body: { instanceId: string, rotate?: boolean }
 *
 * Issues a broad, READ-ONLY credential covering every farm's topics, for
 * internal fleet-monitoring tools (irrigo-admin) rather than any one
 * device or farmer. instanceId is a random id generated and cached once
 * per app install (NOT a Firestore doc id or a stable staff identity) —
 * each install gets its own MQTT client ID so two staff phones watching
 * the fleet at once don't collide/kick each other off (MQTT requires a
 * unique client ID per connection; a single shared monitoring login can't
 * be used from more than one phone at a time).
 *
 * subAuthRulePatterns covers farm/+/.* (every farm); pubAuthRulePatterns
 * is empty — this credential can never publish anything, only observe.
 */
provisionMonitorRouter.post("/", async (req, res) => {
  // Unlike /provision/device (browser-only, CORS-restricted to the admin
  // panel's own origin), this is called from a native app with no CORS
  // protection at all — any caller with a valid Firebase token could reach
  // it otherwise. Mirrors farmbuddie-cloud's own isAdmin() rule
  // (request.auth.token.email != null): a farmer's phone-auth token has no
  // email claim and is rejected here, same as it would be by Firestore.
  if (!req.decodedToken.email) {
    return res.status(403).json({ error: "Fleet monitoring credentials require an admin (email-authenticated) account" });
  }

  const { instanceId, rotate } = req.body || {};

  if (!instanceId || typeof instanceId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(instanceId)) {
    return res.status(400).json({ error: "instanceId is required (8-64 chars, alphanumeric/_/-)" });
  }

  try {
    const clientId = `monitor-${instanceId}`;
    const existing = await findCredentialsByName(clientId);

    if (existing && !rotate) {
      return res.status(409).json({
        error: "Credentials already exist for this install. Pass rotate: true to reissue.",
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
      pubAuthRulePatterns: [],
      subAuthRulePatterns: ["farm/+/.*"]
    });

    const credentialsId = created.id?.id || created.id;
    const issuedAt = new Date().toISOString();

    const metadata = {
      brokerUrl: config.mqttBrokerHost,
      port: config.mqttBrokerPort,
      username: clientId,
      credentialsId,
      issuedAt,
      issuedBy: req.decodedToken.email || req.decodedToken.uid
    };

    // Auditability only (so stale/lost-phone credentials can be found and
    // revoked later) — not read back by anything today.
    await db.collection("monitorCredentials").doc(instanceId).set(metadata);

    return res.json({ ...metadata, password, clientId });
  } catch (err) {
    console.error("provision/monitor error:", err);
    return res.status(500).json({ error: "Failed to provision monitoring credentials" });
  }
});
