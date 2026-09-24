import { Router } from "express";
import {
  DEVICE_KEY_RE,
  provisioningSecretMatches,
  mqttPasswordMatches,
  findControllerByFarmId,
  claimOrVerifyDeviceKey
} from "../deviceBinding.js";

export const provisionBindRouter = Router();

/**
 * POST /provision/bind
 * body: { farmId, provisioningSecret, username, password, deviceKey }
 *
 * Enrolment for devices that were bootstrapped BEFORE device keys existed
 * (see deviceBinding.js): they hold a working MQTT credential but their
 * farm has no deviceKeyHash yet, so it's still claimable by a first-come
 * bootstrap. The device proves it's the genuine holder by presenting that
 * credential's CURRENT username + password (checked against the
 * controller's stored plaintext) and binds its own key. Called once by the
 * firmware at boot, until it succeeds (Connectivity::enrollDeviceKeyIfNeeded()).
 *
 * 200 { bound: true }  - bound now, or already bound to this same key
 * 403 credential_mismatch - username/password isn't the farm's current one
 * 409 already_bound    - the farm is bound to a different device key
 */
provisionBindRouter.post("/", async (req, res) => {
  const { farmId, provisioningSecret, username, password, deviceKey } = req.body || {};

  if (!provisioningSecretMatches(provisioningSecret)) {
    return res.status(403).json({ error: "Invalid provisioning secret" });
  }
  if (!farmId || typeof farmId !== "string") {
    return res.status(400).json({ error: "farmId is required" });
  }
  if (typeof deviceKey !== "string" || !DEVICE_KEY_RE.test(deviceKey)) {
    return res.status(400).json({ error: "deviceKey must be 64 lowercase hex characters" });
  }
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const { ref, data } = await findControllerByFarmId(farmId);

    if (data.username !== username || !mqttPasswordMatches(password, data.mqttPasswordPlaintext)) {
      console.warn(`provision/bind: farmId ${farmId} - credential doesn't match the farm's current one (ip ${req.ip})`);
      return res.status(403).json({ error: "credential_mismatch" });
    }

    const binding = await claimOrVerifyDeviceKey(ref, deviceKey, "enrolment");
    if (binding === "mismatch") {
      console.warn(`provision/bind: farmId ${farmId} - already bound to a different device key (ip ${req.ip})`);
      return res.status(409).json({ error: "already_bound" });
    }
    if (binding === "bound") {
      console.log(`provision/bind: farmId ${farmId} enrolled its device key`);
    }
    return res.json({ bound: true });
  } catch (err) {
    if (err && err.status) {
      const { status, message, ...rest } = err;
      return res.status(status).json({ error: message, ...rest });
    }
    console.error("provision/bind error:", err);
    return res.status(500).json({ error: "Failed to bind device key" });
  }
});
