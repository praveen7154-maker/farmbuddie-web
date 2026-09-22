import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { issueDeviceCredentialByFarmId } from "../deviceProvisioning.js";
import { config } from "../config.js";

export const provisionBootstrapRouter = Router();

function secretMatches(provided) {
  const expected = config.deviceProvisioningSecret();
  const providedBuf = Buffer.from(String(provided || ""));
  const expectedBuf = Buffer.from(expected);
  // Constant-time compare — a naive === leaks how many leading bytes
  // matched via response timing, letting an attacker brute-force the
  // secret one byte at a time instead of needing the whole thing at once.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * POST /provision/bootstrap
 * body: { farmId: string, provisioningSecret: string, rotate?: boolean }
 *
 * Called by the device itself at first boot (over plain HTTPS, before it
 * has ever touched MQTT) — no Firebase auth, since a device has no
 * Firebase account. Authenticated instead by a shared provisioningSecret
 * compiled into every unit's firmware, combined with farmId only ever
 * succeeding for a controller that's already been assigned to a farmer
 * (see deviceProvisioning.js) — a leaked secret alone doesn't hand out
 * credentials for an arbitrary/unassigned farmId.
 *
 * Every call ROTATES if a credential already exists (no way to "just
 * re-fetch" the same one — plaintext passwords are never stored, by
 * design). A device calling this again after already having valid NVS
 * credentials is a deliberate re-provision (factory reset, NVS wipe), not
 * routine behavior — the old credential is invalidated the moment a new
 * one is issued.
 */
provisionBootstrapRouter.post("/", async (req, res) => {
  const { farmId, provisioningSecret } = req.body || {};

  if (!secretMatches(provisioningSecret)) {
    return res.status(403).json({ error: "Invalid provisioning secret" });
  }

  if (!farmId || typeof farmId !== "string") {
    return res.status(400).json({ error: "farmId is required" });
  }

  try {
    const result = await issueDeviceCredentialByFarmId(farmId, { rotate: true });
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
