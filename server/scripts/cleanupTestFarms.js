// One-off: removes test data for a fixed set of farmIds and one test
// phone number - farmers/controllers docs, their TBMQ credentials,
// phoneIndex entries, appMqttCredentials, fcmTokens, and Postgres event/
// config-cache rows. Scoped ONLY to what's listed below - nothing else on
// the fleet is touched.
//
// Usage (from server/, or inside the bridge/provision-api container):
//   node scripts/cleanupTestFarms.js                # dry run - prints what would happen
//   node scripts/cleanupTestFarms.js --apply         # actually deletes
import { db } from "../src/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { findCredentialsByName, deleteCredentials } from "../src/tbmqClient.js";
import { pool } from "../src/bridge/postgres.js";

const FARM_IDS = ["0001", "0006"];
const TEST_PHONE = "9944639988";

const apply = process.argv.includes("--apply");

async function deleteTbmqCredentialByName(name) {
  const existing = await findCredentialsByName(name);
  if (!existing) {
    console.log(`  TBMQ: no credential named "${name}" - nothing to delete`);
    return;
  }
  const id = existing.id?.id || existing.id;
  console.log(`  TBMQ: ${apply ? "deleting" : "would delete"} credential "${name}" (id=${id})`);
  if (apply) await deleteCredentials(id);
}

async function deleteTbmqCredentialById(id, label) {
  console.log(`  TBMQ: ${apply ? "deleting" : "would delete"} credential id=${id} (${label})`);
  if (apply) await deleteCredentials(id);
}

async function cleanupFarm(farmId) {
  console.log(`\n=== farmId ${farmId} ===`);

  const farmersSnap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).get();
  for (const doc of farmersSnap.docs) {
    console.log(`  Firestore: ${apply ? "deleting" : "would delete"} farmers/${doc.id}`);
    if (apply) await doc.ref.delete();
  }

  const controllersSnap = await db.collection("controllers").where("uniqueId", "==", farmId).get();
  for (const doc of controllersSnap.docs) {
    console.log(`  Firestore: ${apply ? "deleting" : "would delete"} controllers/${doc.id}`);
    if (apply) await doc.ref.delete();
  }

  // Device's own credential - name/clientId is always FBIRG<farmId> (see deviceProvisioning.js).
  await deleteTbmqCredentialByName(`FBIRG${farmId}`);

  const eventsResult = await pool.query(
    apply ? `DELETE FROM device_events WHERE farm_id = $1` : `SELECT count(*) FROM device_events WHERE farm_id = $1`,
    [farmId]
  );
  console.log(`  Postgres device_events: ${apply ? `deleted ${eventsResult.rowCount} row(s)` : `${eventsResult.rows[0].count} row(s) would be deleted`}`);

  const cacheResult = await pool.query(
    apply ? `DELETE FROM farm_config_cache WHERE farm_id = $1` : `SELECT count(*) FROM farm_config_cache WHERE farm_id = $1`,
    [farmId]
  );
  console.log(`  Postgres farm_config_cache: ${apply ? `deleted ${cacheResult.rowCount} row(s)` : `${cacheResult.rows[0].count} row(s) would be deleted`}`);
}

async function cleanupPhone(phone) {
  console.log(`\n=== phone ${phone} ===`);

  const phoneRef = db.collection("phoneIndex").doc(phone);
  const phoneSnap = await phoneRef.get();
  if (phoneSnap.exists && phoneSnap.data().farms) {
    const toRemove = FARM_IDS.filter((id) => id in phoneSnap.data().farms);
    if (toRemove.length > 0) {
      console.log(`  Firestore: ${apply ? "removing" : "would remove"} phoneIndex/${phone}.farms.[${toRemove.join(", ")}]`);
      if (apply) {
        const update = {};
        toRemove.forEach((id) => { update[`farms.${id}`] = FieldValue.delete(); });
        await phoneRef.update(update);
      }
    } else {
      console.log(`  Firestore: phoneIndex/${phone} has no entries for ${FARM_IDS.join("/")} - nothing to remove`);
    }
  } else {
    console.log(`  Firestore: phoneIndex/${phone} doesn't exist or has no farms map - nothing to remove`);
  }

  const credsSnap = await db.collection("appMqttCredentials").where("phone", "==", phone).get();
  for (const doc of credsSnap.docs) {
    const data = doc.data();
    const farmIds = Array.isArray(data.farmIds) ? data.farmIds : [];
    const touchesScope = farmIds.some((id) => FARM_IDS.includes(id));
    if (!touchesScope) continue;

    // The credential's TBMQ ACL is baked in for its WHOLE farmIds list at
    // issuance time - there's no way to remove just one farm from it
    // short of rotating the whole credential. Only safe to delete outright
    // when every farm it grants access to is inside our cleanup scope; if
    // it also covers a farm we were NOT asked to touch, deleting it would
    // silently revoke this phone's real access to that other farm too -
    // skip and flag it for a human instead of guessing.
    const allInScope = farmIds.every((id) => FARM_IDS.includes(id));
    if (!allInScope) {
      console.warn(`  Firestore: SKIPPING appMqttCredentials/${doc.id} - farmIds=${JSON.stringify(farmIds)} includes farms outside cleanup scope (${FARM_IDS.join("/")}); deleting it would revoke this phone's access to those too. Handle manually if it needs to change.`);
      continue;
    }

    if (data.credentialsId) {
      await deleteTbmqCredentialById(data.credentialsId, `appMqttCredentials/${doc.id}`);
    }
    console.log(`  Firestore: ${apply ? "deleting" : "would delete"} appMqttCredentials/${doc.id} (farmIds=${JSON.stringify(farmIds)})`);
    if (apply) await doc.ref.delete();
  }

  for (const farmId of FARM_IDS) {
    const tokensSnap = await db.collection("fcmTokens").where("farmIds", "array-contains", farmId).get();
    for (const doc of tokensSnap.docs) {
      const remaining = (doc.data().farmIds || []).filter((id) => !FARM_IDS.includes(id));
      if (remaining.length === 0) {
        console.log(`  Firestore: ${apply ? "deleting" : "would delete"} fcmTokens/${doc.id} (only listed ${FARM_IDS.join("/")})`);
        if (apply) await doc.ref.delete();
      } else {
        console.log(`  Firestore: ${apply ? "updating" : "would update"} fcmTokens/${doc.id} - removing ${farmId}, keeping ${JSON.stringify(remaining)}`);
        if (apply) await doc.ref.update({ farmIds: remaining });
      }
    }
  }
}

async function main() {
  console.log(apply ? "APPLYING cleanup (writes will happen)..." : "DRY RUN - pass --apply to actually delete/modify anything");
  console.log(`Scope: farmIds ${JSON.stringify(FARM_IDS)}, phone ${TEST_PHONE}`);

  for (const farmId of FARM_IDS) {
    await cleanupFarm(farmId);
  }
  await cleanupPhone(TEST_PHONE);

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
