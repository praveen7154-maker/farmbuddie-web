import { doc, setDoc, getDoc }
from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ================= NORMALIZE ================= */
export function normalizePhone(phone){
  return String(phone || "").replace(/\D/g,"").slice(-10);
}

/* ================= EXTRACT =================
   Returns [{phone, role, name}] - role is "main" (primaryMobile) or
   "appUser" (appUsers[].mobile). De-duped by phone (first occurrence
   wins - primaryMobile is always processed first, so a farmer who
   accidentally lists their own number again as an app user keeps the
   "main" role, not "appUser"). */
export function extractPhoneEntries(data){

  const entries = [];

  if (data.primaryMobile) {
    entries.push({ phone: normalizePhone(data.primaryMobile), role: "main", name: data.name || "" });
  }

  if (Array.isArray(data.appUsers)) {
    data.appUsers.forEach(u => {
      if (u.mobile) {
        entries.push({ phone: normalizePhone(u.mobile), role: "appUser", name: u.name || "" });
      }
    });
  }

  const seen = new Set();
  return entries.filter(e => {
    if (!e.phone || e.phone.length !== 10 || seen.has(e.phone)) return false;
    seen.add(e.phone);
    return true;
  });
}

/* Bare phone list, for anything that only needs that much. */
export function extractPhones(data){
  return extractPhoneEntries(data).map(e => e.phone);
}


/* ================= VALIDATE ONLY (NO SAVE) =================
   phoneIndex/{phone}.farms is a MAP keyed by farmId (controllers.
   uniqueId), not a single flat identityId - the same phone number
   legitimately having access to two DIFFERENT farms/identities (e.g. a
   relative who's an app-user on two unrelated farmers' systems) is no
   longer a conflict, it's exactly what this shape is for. The one real
   conflict left to catch: THIS SPECIFIC farmId already has a phoneIndex
   entry for this phone recorded under a different identityId than the
   one being saved now - would mean this farm's own ownership somehow
   disagrees with itself, which should never happen from this flow but
   is worth catching if it ever did. */
export async function validatePhones(db, farmerData){

  const farmId = farmerData.controller?.uniqueId;
  const identityId = farmerData.identityId || farmerData.aadhaarNumber;
  const entries = extractPhoneEntries(farmerData);

  if (!farmId) return; // nothing to check against yet (no controller assigned)

  for (const { phone } of entries) {

    const snap = await getDoc(doc(db, "phoneIndex", phone));
    if (!snap.exists()) continue;

    const existingFarmEntry = snap.data().farms?.[farmId];

    if (existingFarmEntry?.identityId && existingFarmEntry.identityId !== identityId) {
      throw new Error(`Phone ${phone} is already linked to farm ${farmId} under a different identity - contact support before continuing.`);
    }
  }
}


/* ================= FULL SYNC =================
   Writes phoneIndex/{phone}.farms.{farmId} for every phone this farmer
   record lists (main + app users). See validatePhones' own doc comment
   for why this is nested under farmId now instead of one flat
   identityId per phone - the same phone can legitimately be linked to
   more than one farm/identity. Each farm entry carries its own `enabled`
   flag, so disabling access to one farm doesn't touch this phone's
   access to any other farm it's linked to. */
export async function fullPhoneSync(db, auth, farmerId, farmerData){

  const farmId = farmerData.controller?.uniqueId;
  const identityId = farmerData.identityId || farmerData.aadhaarNumber;
  const entries = extractPhoneEntries(farmerData);

  if (!farmId) {
    console.warn("fullPhoneSync: no controller.uniqueId on this farmer record - phoneIndex not updated");
    return;
  }

  // Follows the admin panel's Phone Authorization Activate/Block choice
  // (farmers/<id>.phoneAuth.enabled) - this used to always write true, so
  // Block never reached phoneIndex and a blocked number could still log in.
  // Not chosen yet (no phoneAuth) = enabled, as before.
  const enabled = farmerData.phoneAuth?.enabled !== false;

  for (const { phone, role, name } of entries) {

    const phoneRef = doc(db, "phoneIndex", phone);

    await setDoc(phoneRef, {
      farms: {
        [farmId]: {
          identityId,
          role,
          name,
          farmerDocId: farmerId,
          enabled,
          updatedAt: new Date(),
          updatedBy: auth.currentUser.uid
        }
      }
    }, { merge: true });

  }
}
