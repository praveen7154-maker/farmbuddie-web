// One-off migration: converts phoneIndex/{phone} from the old flat shape
// ({identityId, enabled, updatedAt, updatedBy}) to the new per-farm map
// ({farms: {farmId: {identityId, role, name, enabled, ...}}}) - see
// phone-auth.js's fullPhoneSync()/validatePhones() rewrite and
// PhoneIndexRepository.kt (Irrigo repo) for why: the old shape only let a
// phone belong to ONE identity ever, which broke for a phone that's an
// app-user on two unrelated farmers' systems.
//
// For each old-shape doc, finds every farmers doc with that identityId,
// works out whether this phone was that farm's primaryMobile ("main") or
// one of its appUsers ("appUser"), and writes the corresponding
// farms.{farmId} entry - carrying over the original enabled/updatedAt/
// updatedBy rather than resetting them.
//
// Usage (from server/, or inside the provision-api container):
//   node scripts/migratePhoneIndex.js                        # dry run
//   node scripts/migratePhoneIndex.js --apply                 # writes farms.*, keeps old top-level fields
//   node scripts/migratePhoneIndex.js --apply --delete-old-fields   # also removes the old identityId/enabled/updatedAt/updatedBy fields
//
// Safe to re-run - every write is a merge into a deterministic map key.
import { db } from "../src/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

const apply = process.argv.includes("--apply");
const deleteOldFields = process.argv.includes("--delete-old-fields");

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

async function main() {
  console.log(apply ? "Running migration (writes will happen)..." : "DRY RUN - pass --apply to actually write");

  const phoneSnap = await db.collection("phoneIndex").get();
  console.log(`\nphoneIndex: ${phoneSnap.size} document(s) found`);

  for (const phoneDoc of phoneSnap.docs) {
    const phone = phoneDoc.id;
    const data = phoneDoc.data();

    if (data.farms) {
      console.log(`  SKIP ${phone}: already migrated (has farms map)`);
      continue;
    }

    const identityId = data.identityId;
    if (!identityId) {
      console.warn(`  SKIP ${phone}: no identityId on old record`);
      continue;
    }

    const farmersSnap = await db.collection("farmers").where("identityId", "==", identityId).get();

    if (farmersSnap.empty) {
      console.warn(`  SKIP ${phone}: no farmers found for identityId=${identityId}`);
      continue;
    }

    const farmsUpdate = {};

    farmersSnap.forEach((farmerDoc) => {
      const farmer = farmerDoc.data();
      const farmId = farmer.controller?.uniqueId;
      if (!farmId) return;

      let role = null;
      let name = farmer.name || "";

      if (normalizePhone(farmer.primaryMobile) === phone) {
        role = "main";
      } else if (Array.isArray(farmer.appUsers)) {
        const match = farmer.appUsers.find((u) => normalizePhone(u.mobile) === phone);
        if (match) {
          role = "appUser";
          name = match.name || "";
        }
      }

      if (!role) return; // this identity's farm doesn't actually list this phone - skip

      farmsUpdate[farmId] = {
        identityId,
        role,
        name,
        farmerDocId: farmerDoc.id,
        enabled: data.enabled !== false,
        updatedAt: data.updatedAt || new Date().toISOString(),
        updatedBy: data.updatedBy || "migration"
      };

      console.log(`  ${phone} -> farms.${farmId} (${role}, farmer=${farmerDoc.id})`);
    });

    if (Object.keys(farmsUpdate).length === 0) {
      console.warn(`  SKIP ${phone}: identityId=${identityId} matched farmers, but none actually list this phone`);
      continue;
    }

    if (apply) {
      await db.collection("phoneIndex").doc(phone).set({ farms: farmsUpdate }, { merge: true });
      if (deleteOldFields) {
        await db.collection("phoneIndex").doc(phone).update({
          identityId: FieldValue.delete(),
          enabled: FieldValue.delete(),
          updatedAt: FieldValue.delete(),
          updatedBy: FieldValue.delete()
        });
        console.log(`    removed old top-level fields on ${phone}`);
      }
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
