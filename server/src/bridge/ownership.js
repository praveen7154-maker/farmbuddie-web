import { db } from "../firebaseAdmin.js";

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/**
 * True if the signed-in caller may act on the given farmId (controllers.
 * uniqueId): any admin (email-authenticated, matches farmbuddie-cloud's
 * own isAdmin() rule), or a farmer/secondary user whose phone maps
 * (via phoneIndex -> identityId) to a farmers doc with that farmId.
 */
export async function canAccessFarm(decodedToken, farmId) {
  if (decodedToken.email) return true;

  const phone = normalizePhone(decodedToken.phone_number);
  if (!phone || phone.length !== 10) return false;

  const phoneSnap = await db.collection("phoneIndex").doc(phone).get();
  if (!phoneSnap.exists || !phoneSnap.data().identityId) return false;

  const identityId = phoneSnap.data().identityId;

  const farmsSnap = await db
    .collection("farmers")
    .where("identityId", "==", identityId)
    .where("controller.uniqueId", "==", farmId)
    .limit(1)
    .get();

  return !farmsSnap.empty;
}
