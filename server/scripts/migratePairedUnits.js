// One-off migration: moves motor_node_units/valve_units documents into
// their farm's farmers/{farmerDocId}.pairedUnits.motorNodes/.valves
// (see PairedUnitsRepository.kt's rewrite - Irrigo repo). Uses the Admin
// SDK, so it bypasses Firestore security rules entirely (this doesn't
// need the app's own read/write access to work).
//
// Usage (from server/):
//   node scripts/migratePairedUnits.js            # dry run - prints what it WOULD do
//   node scripts/migratePairedUnits.js --apply     # actually writes, does NOT delete old docs
//   node scripts/migratePairedUnits.js --apply --delete-old   # writes AND deletes the migrated old docs
//
// Safe to re-run - every write is a merge into a deterministic map key, so
// running it twice just overwrites the same entries with the same data.
import { db } from "../src/firebaseAdmin.js";

const apply = process.argv.includes("--apply");
const deleteOld = process.argv.includes("--delete-old");

// farmId (controllers.uniqueId) -> farmers/{docId}, cached per run.
const farmerDocIdCache = new Map();

async function resolveFarmerDocId(farmId) {
  if (farmerDocIdCache.has(farmId)) return farmerDocIdCache.get(farmId);
  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  const docId = snap.empty ? null : snap.docs[0].id;
  farmerDocIdCache.set(farmId, docId);
  return docId;
}

async function migrateCollection(collectionName, mapField, keyField) {
  const snap = await db.collection(collectionName).get();
  console.log(`\n${collectionName}: ${snap.size} document(s) found`);

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const farmId = data.farmId;
    const key = data[keyField];

    if (!farmId || !key) {
      console.warn(`  SKIP ${docSnap.id}: missing farmId/${keyField}`);
      continue;
    }

    const farmerDocId = await resolveFarmerDocId(farmId);
    if (!farmerDocId) {
      console.warn(`  SKIP ${docSnap.id}: no farmer found for farmId=${farmId}`);
      continue;
    }

    console.log(`  ${docSnap.id} -> farmers/${farmerDocId}.pairedUnits.${mapField}.${key}`);

    if (apply) {
      await db.collection("farmers").doc(farmerDocId).set(
        { pairedUnits: { [mapField]: { [key]: data } } },
        { merge: true }
      );
      if (deleteOld) {
        await db.collection(collectionName).doc(docSnap.id).delete();
        console.log(`    deleted old ${collectionName}/${docSnap.id}`);
      }
    }
  }
}

async function main() {
  console.log(apply ? "Running migration (writes will happen)..." : "DRY RUN - pass --apply to actually write");
  await migrateCollection("motor_node_units", "motorNodes", "nodeLabel");
  await migrateCollection("valve_units", "valves", "unitLabel");
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
