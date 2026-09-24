import { createHash, timingSafeEqual } from "crypto";
import { db } from "./firebaseAdmin.js";
import { config } from "./config.js";

/**
 * Per-device key binding for POST /provision/bootstrap and /provision/bind.
 *
 * Every Motor hub generates a random 256-bit key on its first boot and
 * keeps it only in its own flash (see the firmware's
 * Connectivity::loadOrCreateDeviceKey()). A controller doc stores just
 * its SHA-256 (controllers/{id}.deviceKeyHash). Once a farm is bound,
 * bootstrap only hands that farm's MQTT credential to a caller presenting
 * the same key.
 *
 * Why: the only other proof a bootstrap carries is the fleet-wide
 * DEVICE_PROVISIONING_SECRET, which is in every unit's flash - extract it
 * from one device and every sequential farmId (0001-9999) would bootstrap,
 * handing over (and rotating, so knocking offline) every assigned farm's
 * credential. With binding, a leaked secret only works against a farm
 * whose device has never bound yet.
 */

export const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;

function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  // Length check first (timingSafeEqual throws on mismatch) - leaks only
  // the length, never how many leading bytes matched.
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function provisioningSecretMatches(provided) {
  return constantTimeEqual(provided, config.deviceProvisioningSecret());
}

export function mqttPasswordMatches(provided, stored) {
  return !!stored && constantTimeEqual(provided, stored);
}

export function hashDeviceKey(deviceKey) {
  return createHash("sha256").update(deviceKey, "utf8").digest("hex");
}

export function deviceKeyMatches(deviceKey, storedHash) {
  return !!storedHash && constantTimeEqual(hashDeviceKey(deviceKey), storedHash);
}

/** { ref, data } for the controller whose uniqueId is farmId, or throws 404. */
export async function findControllerByFarmId(farmId) {
  const snap = await db.collection("controllers").where("uniqueId", "==", farmId).limit(1).get();
  if (snap.empty) {
    throw { status: 404, message: "No controller found for this farmId" };
  }
  const doc = snap.docs[0];
  return { ref: doc.ref, data: doc.data() };
}

/**
 * Binds deviceKey to the controller if it isn't bound yet, else checks it
 * against the bound one - atomically, so two racing first bootstraps can't
 * both win. Returns "bound" | "verified" | "mismatch".
 */
export async function claimOrVerifyDeviceKey(controllerRef, deviceKey, via) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(controllerRef);
    const data = snap.data() || {};
    if (data.deviceKeyHash) {
      return deviceKeyMatches(deviceKey, data.deviceKeyHash) ? "verified" : "mismatch";
    }
    tx.update(controllerRef, {
      deviceKeyHash: hashDeviceKey(deviceKey),
      deviceBoundAt: new Date().toISOString(),
      deviceBoundVia: via
    });
    return "bound";
  });
}
