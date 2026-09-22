import { Router } from "express";
import { db } from "../firebaseAdmin.js";

export const fcmTokenRouter = Router();

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/**
 * POST /provision/fcm-token
 * body: { instanceId: string, token: string }
 *
 * Called by the Irrigo app on every FCM token issue/refresh (see
 * IrrigoFcmService.onNewToken() and the startup upload in
 * IrrigoApplication) - lets the bridge (pushNotifications.js) push an
 * alert notification to every phone sharing a farm's identityId, even
 * while the app itself is fully closed.
 *
 * instanceId reuses AppPreferences.deviceInstallId - the exact same
 * stable per-install id already used for /provision/app's clientId and for
 * distinguishing two phones sharing one farm's MQTT login (see
 * FarmConnectionManager.mqttClientId()'s own doc comment). identityId is
 * looked up fresh from phoneIndex on every call (not trusted from the
 * client) so a phone can't register a token against a farm it doesn't
 * actually have access to.
 */
fcmTokenRouter.post("/", async (req, res) => {
  const { instanceId, token } = req.body || {};

  if (!instanceId || typeof instanceId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(instanceId)) {
    return res.status(400).json({ error: "instanceId is required (8-64 chars, alphanumeric/_/-)" });
  }
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token is required" });
  }

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

    await db.collection("fcmTokens").doc(instanceId).set(
      { identityId, token, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("provision/fcm-token error:", err);
    return res.status(500).json({ error: "Failed to register push token" });
  }
});
