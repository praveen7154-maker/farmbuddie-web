// Full test-data reset of the VPS side, for starting end-to-end testing
// from zero. Firebase (Firestore/Storage/Auth) is cleared by hand in the
// Firebase console - this script does NOT touch it.
//
// TBMQ - deletes every device, app and monitor login (and disconnects any
// that are connected right now):
//   FBIRG<farmId>   hub logins
//   app-...         Irrigo app logins
//   monitor-...     monitoring logins
// Kept: the bridge's login, ota-admin, TBMQ's own locked WebSocket login and
// anything else not matching the above (listed as "kept").
//
// Postgres (bridge database) - empties: device_events, farm_config_cache,
// ota_release_targets, ota_releases, ota_firmware.
//
// Usage (inside the provision-api container):
//   node scripts/resetTestData.js                       # dry run - lists everything
//   node scripts/resetTestData.js --apply --confirm     # deletes it
// Restart the bridge afterwards (it caches farm lookups in memory).
import { listCredentialsPage, deleteCredentials, disconnectClient } from "../src/tbmqClient.js";

const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--confirm")) {
  console.error("This deletes every device/app login and all device history. Re-run with --apply --confirm.");
  process.exit(1);
}

const RESET_NAME = /^(FBIRG\d+|app-.+|monitor-.+)$/;
const PG_TABLES = ["device_events", "farm_config_cache", "ota_release_targets", "ota_releases", "ota_firmware"];

// ---- TBMQ ----
// Collect first, delete after - deleting while paging would shift pages.
const toDelete = [];
const kept = [];
for (let page = 0; ; page++) {
  const data = await listCredentialsPage(page);
  for (const c of data.data || []) {
    (RESET_NAME.test(c.name) ? toDelete : kept).push(c);
  }
  if (!data.hasNext) break;
}

console.log(`TBMQ: ${toDelete.length} login(s) to ${apply ? "delete" : "delete (dry run)"}`);
for (const c of toDelete) console.log(`  - ${c.name}`);
console.log(`TBMQ: ${kept.length} login(s) kept`);
for (const c of kept) console.log(`  = ${c.name}`);

if (apply) {
  for (const c of toDelete) {
    await deleteCredentials(c.id?.id || c.id);
    // A deleted login's live session keeps running until it reconnects.
    try { await disconnectClient(c.name); } catch { /* not connected */ }
  }
  console.log(`TBMQ: deleted ${toDelete.length}.`);
}

// ---- Postgres ----
console.log("");
let pool;
try {
  ({ pool } = await import("../src/bridge/postgres.js"));
} catch (err) {
  console.log(`Postgres: not reachable from this container (${err.message}) - run this script in the bridge container for the database part.`);
  process.exit(0);
}
for (const t of PG_TABLES) {
  const exists = await pool.query("SELECT to_regclass($1) AS r", [t]);
  if (!exists.rows[0].r) { console.log(`Postgres: ${t} - no such table, skipped`); continue; }
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
  console.log(`Postgres: ${t} - ${rows[0].n} row(s)${apply ? " deleted" : " to delete"}`);
}
if (apply) {
  const present = [];
  for (const t of PG_TABLES) if ((await pool.query("SELECT to_regclass($1) AS r", [t])).rows[0].r) present.push(t);
  if (present.length) await pool.query(`TRUNCATE ${present.join(", ")}`);
}

console.log(apply ? "\nDone. Now restart the bridge: docker compose restart bridge" : "\nDry run - nothing changed. Re-run with --apply --confirm.");
await pool.end();
process.exit(0);
