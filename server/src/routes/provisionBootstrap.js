import { Router } from "express";
import { issueDeviceCredential } from "../deviceProvisioning.js";
import {
  DEVICE_KEY_RE,
  provisioningSecretMatches,
  findControllerByFarmId,
  claimOrVerifyDeviceKey
} from "../deviceBinding.js";
import { config } from "../config.js";

export const provisionBootstrapRouter = Router();

/**
 * POST /provision/bootstrap
 * body: { farmId: string, provisioningSecret: string, deviceKey?: string }
 *
 * Called by the device itself at first boot (over plain HTTPS, before it
 * has ever touched MQTT) — no Firebase auth, since a device has no
 * Firebase account. Authenticated by:
 *   - the shared provisioningSecret compiled into every unit's firmware, and
 *   - deviceKey: a 64-hex-char key the device generated for itself. The
 *     first bootstrap for a farm binds that farm to it; every later one
 *     must present the same key (see deviceBinding.js). A farm whose device
 *     re-provisions from scratch with a NEW key (hardware swap, NVS wipe)
 *     gets 403 device_mismatch until an admin runs
 *     scripts/resetDeviceBinding.js for it.
 *
 * Requests without deviceKey come from firmware older than device keys.
 * They're refused for an already-bound farm, and entirely once
 * BOOTSTRAP_REQUIRE_DEVICE_KEY=true (turn that on once no unit in stock or
 * in the field still runs such firmware).
 *
 * Only ever succeeds for a controller already assigned to a farmer.
 * Every call ROTATES if a credential already exists (plaintext passwords
 * are only ever handed back to the bound device, never re-fetched by
 * anyone else) — the old credential is invalidated the moment a new one
 * is issued.
 */
provisionBootstrapRouter.post("/", async (req, res) => {
  const { farmId, provisioningSecret, deviceKey } = req.body || {};

  if (!provisioningSecretMatches(provisioningSecret)) {
    return res.status(403).json({ error: "Invalid provisioning secret" });
  }

  if (!farmId || typeof farmId !== "string") {
    return res.status(400).json({ error: "farmId is required" });
  }

  if (deviceKey !== undefined && (typeof deviceKey !== "string" || !DEVICE_KEY_RE.test(deviceKey))) {
    return res.status(400).json({ error: "deviceKey must be 64 lowercase hex characters" });
  }

  try {
    const { ref, data } = await findControllerByFarmId(farmId);

    // Checked here too (issueDeviceCredential() also checks it) so an
    // unassigned controller can't get bound to whoever asks first.
    if (data.status !== "assigned") {
      return res.status(409).json({ error: `Controller must be assigned to a farmer first (current status: ${data.status})` });
    }

    if (deviceKey) {
      const binding = await claimOrVerifyDeviceKey(ref, deviceKey, "bootstrap");
      if (binding === "mismatch") {
        console.warn(`provision/bootstrap: farmId ${farmId} - device key doesn't match the bound device (ip ${req.ip})`);
        return res.status(403).json({ error: "device_mismatch" });
      }
      if (binding === "bound") {
        console.log(`provision/bootstrap: farmId ${farmId} bound to its device key`);
      }
    } else if (data.deviceKeyHash) {
      console.warn(`provision/bootstrap: farmId ${farmId} - keyless request for a bound farm refused (ip ${req.ip})`);
      return res.status(403).json({ error: "device_key_required" });
    } else if (config.bootstrapRequireDeviceKey) {
      return res.status(403).json({ error: "device_key_required" });
    } else {
      console.warn(`provision/bootstrap: farmId ${farmId} - keyless (legacy firmware) request allowed, farm stays unbound`);
    }

    const result = await issueDeviceCredential(ref.id, { rotate: true });
    return res.json(result);
  } catch (err) {
    if (err && err.status) {
      const { status, message, ...rest } = err;
      return res.status(status).json({ error: message, ...rest });
    }
    console.error("provision/bootstrap error:", err);
    return res.status(500).json({ error: "Failed to bootstrap device credentials" });
  }
});
