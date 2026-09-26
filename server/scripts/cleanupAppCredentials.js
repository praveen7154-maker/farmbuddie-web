// One-time cleanup: one app login per phone. Every reinstall (or "Clear
// storage") of the Irrigo app made a new install id and a new MQTT login
// (appMqttCredentials/<installId>-f<farmId> + a TBMQ credential) and the old
// one was never removed. New requests clean up after themselves now (see
// routes/provisionApp.js removeOtherInstallsCredentials()); this removes
// what was left before that.
//
// Per phone it keeps the install with the newest issuedAt (all of that
// install's farm slots) and, with --apply, deletes every other install's
// TBMQ login and Firestore record.
//
// Usage (inside the provision-api container):
//   node scripts/cleanupAppCredentials.js            # dry run - lists what would go
//   node scripts/cleanupAppCredentials.js --apply    # delete them
import { db } from "../src/firebaseAdmin.js";
import { deleteCredentials } from "../src/tbmqClient.js";

const apply = process.argv.includes("--apply");
const installOf = (instanceId) => String(instanceId).replace(/-f\d+$/, "");

const snap = await db.collection("appMqttCredentials").get();
const byPhone = new Map();
for (const doc of snap.docs) {
  const phone = doc.data().phone || "(no phone)";
  if (!byPhone.has(phone)) byPhone.set(phone, []);
  byPhone.get(phone).push(doc);
}

let kept = 0, removed = 0;
for (const [phone, docs] of byPhone) {
  const newest = docs.reduce((a, b) => (String(b.data().issuedAt) > String(a.data().issuedAt) ? b : a));
  const keepInstall = installOf(newest.id);
  for (const doc of docs) {
    const { username, credentialsId, issuedAt } = doc.data();
    if (installOf(doc.id) === keepInstall) {
      kept++;
      console.log(`keep    ${phone}  ${username}  (issued ${issuedAt})`);
      continue;
    }
    removed++;
    console.log(`${apply ? "delete " : "would delete"}  ${phone}  ${username}  (issued ${issuedAt})`);
    if (!apply) continue;
    try {
      if (credentialsId) await deleteCredentials(credentialsId);
    } catch (err) {
      console.warn(`  TBMQ delete failed (${err.message}) - removing the Firestore record anyway`);
    }
    await doc.ref.delete();
  }
}

console.log(`\n${kept} kept, ${removed} ${apply ? "deleted" : "to delete - run again with --apply"}`);
process.exit(0);
