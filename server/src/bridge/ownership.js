import { db } from "../firebaseAdmin.js";

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/**
 * True if the signed-in caller may act on the given farmId (controllers.
 * uniqueId): any admin (email-authenticated, matches farmbuddie-cloud's
 * own isAdmin() rule), or a farmer/secondary user whose phone has an
 * enabled entry for this exact farmId in phoneIndex/{phone}.farms - see
 * phone-auth.js's fullPhoneSync() for how that map gets populated. A
 * direct field read, not a query - phoneIndex.farms already lists every
 * farmId this phone can reach, keyed by farmId, so no farmers lookup is
 * needed here at all (this used to resolve identityId first, then query
 * farmers for a matching farmId - phoneIndex now has the answer directly).
 */
export async function canAccessFarm(decodedToken, farmId) {
  if (decodedToken.email) return true;

  const phone = normalizePhone(decodedToken.phone_number);
  if (!phone || phone.length !== 10) return false;

  const phoneSnap = await db.collection("phoneIndex").doc(phone).get();
  if (!phoneSnap.exists) return false;

  const farmEntry = phoneSnap.data().farms?.[farmId];
  return !!farmEntry?.enabled;
}
