// Full test reset - empties every farm, device, app login and history so
// testing can start again from nothing (first real board, first farmer).
// Dry run by default: it only counts and lists.
//
// DELETES
//   Firestore  farmers (with sub-collections), controllers, phoneIndex,
//              fcmTokens, appMqttCredentials, monitorCredentials,
//              farmValveSequences, farmCyclicPresets, distributors,
//              referrals, bonusRedemptions, counters (farm / distributor
//              numbers start again from 1)
//   TBMQ       every hub login (FBIRG<farm>), app login (app-...) and
//              monitor login (monitor-...) - and drops their sessions
//   Postgres   device events, config cache, reports, OTA releases and
//              history, broadcast messages, distributor accounts, pricing
//              quotes and their audit / numbering, crop health (valve
//              lands, satellite readings and pictures, weather), production
//              staff sign-in sessions
//   Firebase Auth  every login WITHOUT an email address (farmers' phone
//              logins, anonymous app logins)
// KEEPS
//   - admin logins (every Firebase Auth user with an email address)
//   - the bridge's and the OTA admin's own broker logins (any TBMQ login
//     not named like a hub / app / monitor one)
//   - the admin access code, the table structure itself
//   - the pricing catalog (products, variants, accessories, price lists,
//     staff, costing, company / bank details) - add --with-pricing to empty it too
//   - production and onboarding staff logins (production_users, teamAccess)
//   - node stock (nodes): each board's serial is on its printed QR label,
//     so the records stay (a wipe would hand out the same serials again) -
//     only released: every node "assigned" to a farm is "available" again.
//     --with-nodes empties it instead, and the serials start again from the
//     first (the counters always go) - reprint every node's label then
//   - SIM stock (simInventory): released the same way - or --with-sims
//     empties it (upload the operator's SIM list again on Production)
//   - any Firestore collection this script doesn't know (listed, untouched)
//
// Before --apply: switch off every old test hub (or it reconnects and writes
// again). Afterwards: docker compose restart bridge provision-api ndvi, and
// log out / clear data of the Irrigo and Irrigo Admin apps on every phone.
//
// Usage (inside the bridge container - it has Firebase, TBMQ and Postgres):
//   cd /root && docker compose exec bridge node scripts/resetAllTestData.js
//   cd /root && docker compose exec bridge node scripts/resetAllTestData.js --apply --confirm=RESET-ALL
import { db, auth } from "../src/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { listCredentialsPage, deleteCredentials, disconnectClient } from "../src/tbmqClient.js";
import { pool } from "../src/bridge/postgres.js";

const apply = process.argv.includes("--apply");
const withPricing = process.argv.includes("--with-pricing");
const withSims = process.argv.includes("--with-sims");
const withNodes = process.argv.includes("--with-nodes");
const confirmed = process.argv.includes("--confirm=RESET-ALL");

const FIRESTORE_COLLECTIONS = [
  "farmers", "controllers", "phoneIndex", "fcmTokens", "appMqttCredentials", "monitorCredentials",
  "farmValveSequences", "farmCyclicPresets", "distributors", "referrals", "bonusRedemptions", "counters",
  ...(withSims ? ["simInventory"] : []),
  ...(withNodes ? ["nodes"] : [])
];
const PG_TABLES = [
  "device_events", "farm_config_cache", "report_days",
  "ota_node_status", "ota_release_targets", "ota_releases", "ota_firmware",
  "announcement_reads", "announcements",
  "distributor_sessions", "distributor_devices", "distributor_accounts",
  "pricing_quotes", "pricing_audit", "pricing_counters",
  // Crop health: valve lands, every satellite reading / picture, weather. The
  // worker reads the images again for whatever lands are mapped afresh.
  "ndvi_zones", "ndvi_history", "ndvi_maps", "ndvi_farm_scenes", "ndvi_scenes", "ndvi_status", "ndvi_weather",
  "production_sessions"
];
const PG_PRICING_CATALOG = [
  "price_list_items", "price_lists", "pricing_variants", "pricing_accessories", "pricing_products",
  "pricing_staff", "pricing_settings", "pricing_costing"
];
const PG_ALWAYS_KEPT = ["admin_gate", "production_users"];
// Hub, app and monitor logins - see deviceProvisioning.js, routes/provisionApp.js, routes/provisionMonitor.js.
const TEST_LOGIN = /^(FBIRG\d+|app-.+|monitor-.+)$/;

const say = (s) => console.log(s);

async function firestore() {
  say("\n=== Firestore ===");
  const known = new Set(FIRESTORE_COLLECTIONS);
  for (const col of await db.listCollections()) {
    if (!known.has(col.id)) say(`  keep     ${col.id} (not a known test collection - left alone)`);
  }
  for (const name of FIRESTORE_COLLECTIONS) {
    const ref = db.collection(name);
    const n = (await ref.count().get()).data().count;
    if (n === 0) { say(`  empty    ${name}`); continue; }
    if (apply) {
      await db.recursiveDelete(ref);   // also each document's sub-collections
      say(`  deleted  ${name} (${n} documents)`);
    } else {
      say(`  delete   ${name} (${n} documents)`);
    }
  }
}

// Stock that stays: every record given to a (now deleted) farm / controller
// goes back to "available".
async function releaseStock() {
  say("\n=== Stock (kept, released) ===");
  const groups = [
    ...(withNodes ? [] : [{ name: "nodes", clear: { farmerDocId: FieldValue.delete(), farmerId: FieldValue.delete(), assignedAt: FieldValue.delete() } }]),
    ...(withSims ? [] : [{ name: "simInventory", clear: { controllerId: null, uniqueId: null, assignedAt: FieldValue.delete() } }])
  ];
  for (const g of groups) {
    const snap = await db.collection(g.name).where("status", "==", "assigned").get();
    say(`  ${apply ? "released" : "release "} ${g.name}: ${snap.size} assigned -> available`);
    if (!apply) continue;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      for (const d of snap.docs.slice(i, i + 400)) batch.update(d.ref, { status: "available", ...g.clear, updatedAt: FieldValue.serverTimestamp() });
      await batch.commit();
    }
  }
}

async function tbmq() {
  say("\n=== TBMQ broker logins ===");
  const all = [];
  for (let page = 0; ; page++) {
    const res = await listCredentialsPage(page, 100);
    all.push(...(res.data || []));
    if (res.hasNext === false || !res.data || res.data.length < 100) break;
  }
  const kept = all.filter((c) => !TEST_LOGIN.test(c.name || ""));
  const gone = all.filter((c) => TEST_LOGIN.test(c.name || ""));
  for (const c of kept) say(`  keep     ${c.name}`);
  const counts = { hub: 0, app: 0, monitor: 0 };
  for (const c of gone) counts[c.name.startsWith("FBIRG") ? "hub" : c.name.startsWith("app-") ? "app" : "monitor"]++;
  say(`  ${apply ? "deleting" : "delete  "} ${counts.hub} hub, ${counts.app} app and ${counts.monitor} monitor login(s)`);
  if (!apply) return;
  for (const c of gone) {
    const id = c.id?.id || c.id;
    try {
      await deleteCredentials(id);
    } catch (err) {
      say(`  ! could not delete ${c.name}: ${err.message}`);
      continue;
    }
    // Its session, if it's still connected (name = clientId for these).
    try { await disconnectClient(c.name); } catch { /* not connected */ }
  }
  say(`  deleted  ${gone.length} login(s)`);
}

async function postgres() {
  say("\n=== Postgres (bridge database) ===");
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const existing = new Set(rows.map((r) => r.table_name));
  const wipe = [...PG_TABLES, ...(withPricing ? PG_PRICING_CATALOG : [])].filter((t) => existing.has(t));
  const keepList = [...PG_ALWAYS_KEPT, ...(withPricing ? [] : PG_PRICING_CATALOG)].filter((t) => existing.has(t));
  for (const t of keepList) say(`  keep     ${t}`);
  for (const t of [...existing].filter((t) => !wipe.includes(t) && !keepList.includes(t)).sort()) {
    say(`  keep     ${t} (not a known test table - left alone)`);
  }
  for (const t of wipe) {
    const n = (await pool.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
    say(`  ${apply ? "emptied " : "empty   "} ${t} (${n} rows)`);
  }
  if (apply && wipe.length) {
    // No CASCADE: if some kept table ever points at one of these, this stops
    // with an error instead of quietly emptying the kept table too.
    await pool.query(`TRUNCATE ${wipe.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY`);
  }
}

async function firebaseAuth() {
  say("\n=== Firebase Auth logins ===");
  const remove = [];
  let admins = 0;
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) {
      if (u.email) { admins++; say(`  keep     ${u.email}`); } else remove.push(u.uid);
    }
    token = page.pageToken;
  } while (token);
  say(`  ${apply ? "deleting" : "delete  "} ${remove.length} phone / anonymous login(s) (kept ${admins} email login(s))`);
  if (!apply) return;
  for (let i = 0; i < remove.length; i += 1000) {
    const r = await auth.deleteUsers(remove.slice(i, i + 1000));
    if (r.failureCount) say(`  ! ${r.failureCount} could not be deleted`);
  }
}

async function main() {
  if (apply && !confirmed) {
    console.error("This deletes ALL farms, devices, app logins and history. Re-run with --apply --confirm=RESET-ALL");
    process.exit(1);
  }
  say(apply ? "APPLYING the full test reset..." : "DRY RUN - nothing is changed. Add --apply --confirm=RESET-ALL to delete.");
  if (withPricing) say("(--with-pricing: the pricing catalog and company details go too)");
  if (withNodes) say("(--with-nodes: node stock goes too - serials start again from the first; reprint the labels)");
  if (withSims) say("(--with-sims: SIM stock goes too - upload the SIM list again on Production)");
  await firestore();
  await releaseStock();
  await tbmq();
  await postgres();
  await firebaseAuth();
  say(apply
    ? "\nDone. Now: docker compose restart bridge provision-api ndvi - and clear the apps on every phone."
    : "\nDry run done - check the lists above.");
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
