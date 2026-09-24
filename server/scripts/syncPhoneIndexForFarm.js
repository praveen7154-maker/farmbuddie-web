// One-off: writes phoneIndex/{phone}.farms.{farmId} for every phone linked
// to ONE specific farm, straight from its farmers doc - exactly what
// phone-auth.js's fullPhoneSync() would write if the admin panel's edit
// form let you re-save that farmer's record. Written as a targeted
// workaround for farmer-edit.js's SIM-number validation blocking a save
// for reasons unrelated to phoneIndex - this bypasses that form entirely.
// Safe to re-run (every write is a merge into a deterministic map key).
//
// Usage (from server/, or inside the provision-api/bridge container):
//   node scripts/syncPhoneIndexForFarm.js <farmId>
//   e.g. node scripts/syncPhoneIndexForFarm.js 0001
import { db } from "../src/firebaseAdmin.js";

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

async function main() {
  const farmId = process.argv[2];
  if (!farmId) {
    console.error("Usage: node scripts/syncPhoneIndexForFarm.js <farmId>");
    process.exit(1);
  }

  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  if (snap.empty) {
    console.error(`No farmer found with controller.uniqueId = ${farmId}`);
    process.exit(1);
  }

  const farmerDoc = snap.docs[0];
  const farmer = farmerDoc.data();
  const identityId = farmer.identityId || farmer.aadhaarNumber;

  const entries = [];
  if (farmer.primaryMobile) {
    entries.push({ phone: normalizePhone(farmer.primaryMobile), role: "main", name: farmer.name || "" });
  }
  if (Array.isArray(farmer.appUsers)) {
    farmer.appUsers.forEach((u) => {
      if (u.mobile) entries.push({ phone: normalizePhone(u.mobile), role: "appUser", name: u.name || "" });
    });
  }

  if (entries.length === 0) {
    console.warn(`Farmer ${farmerDoc.id} (farmId ${farmId}) lists no phone numbers - nothing to sync.`);
    process.exit(0);
  }

  for (const { phone, role, name } of entries) {
    if (!phone || phone.length !== 10) {
      console.warn(`Skipping invalid phone "${phone}" for farmId ${farmId}`);
      continue;
    }

    await db.collection("phoneIndex").doc(phone).set({
      farms: {
        [farmId]: {
          identityId,
          role,
          name,
          farmerDocId: farmerDoc.id,
          enabled: true,
          updatedAt: new Date(),
          updatedBy: "syncPhoneIndexForFarm-script"
        }
      }
    }, { merge: true });

    console.log(`Wrote phoneIndex/${phone}.farms.${farmId} (${role}, farmer=${farmerDoc.id})`);
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
