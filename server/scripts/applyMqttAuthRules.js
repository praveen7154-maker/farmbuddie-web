// Brings every existing TBMQ credential's authorization rules in line with
// src/mqttAuthRules.js - new credentials already get them, this fixes the
// ones issued before:
//   FBIRG<farmId> (Motor hubs)  - may also SUBSCRIBE to motor/ota/broadcast,
//                                 so `ota_admin.py --all` reaches them
//   app-*        (Irrigo app)   - may no longer publish to .../ota/*
//   ota-admin                   - OTA only (create it with createOtaAdminCredential.js)
//   bridge       (VPS bridge)   - publishes motor commands only
// monitor-* logins (read-only) are left alone. Anything else that could
// still publish an OTA topic is listed as REVIEW for you to check by hand.
//
// Passwords are untouched (TBMQ keeps the stored one when a credential is
// updated) - nobody gets logged out. TBMQ reads rules at connect, so a
// client already connected keeps its old rules until it reconnects;
// --disconnect makes the changed ones reconnect now (devices and the app
// reconnect by themselves within seconds - a GSM hub ~15-40s).
//
// Usage (from server/, or inside the provision-api container):
//   node scripts/applyMqttAuthRules.js                        # dry run - shows what would change
//   node scripts/applyMqttAuthRules.js --apply                # update the rules
//   node scripts/applyMqttAuthRules.js --apply --disconnect   # ...and reconnect changed clients now
import { listCredentialsPage, updateCredentialAuthRules, disconnectClient } from "../src/tbmqClient.js";
import {
  OTA_ADMIN_USERNAME,
  OTA_BROADCAST_TOPIC,
  deviceAuthRules,
  appAuthRules,
  otaAdminAuthRules,
  bridgeAuthRules,
  farmIdsFromRules
} from "../src/mqttAuthRules.js";

const apply = process.argv.includes("--apply");
const disconnect = process.argv.includes("--disconnect");
const bridgeUsername = process.env.BRIDGE_MQTT_USERNAME || "bridge";

// Same full-match semantics TBMQ uses (Java Pattern.matcher().matches()).
const anyMatch = (patterns, topic) => (patterns || []).some((p) => {
  try { return new RegExp(`^(?:${p})$`).test(topic); } catch { return false; }
});
const OTA_SAMPLE_TOPICS = ["farm/0001/MOTOR_1/ota/cmd", OTA_BROADCAST_TOPIC];

function desiredRules(name, current) {
  let m;
  if (name === OTA_ADMIN_USERNAME) return otaAdminAuthRules();
  if (name === bridgeUsername) return bridgeAuthRules();
  if ((m = /^FBIRG(\d+)$/.exec(name))) return deviceAuthRules(m[1]);
  if (name.startsWith("app-")) {
    const farmIds = farmIdsFromRules(current);
    return farmIds.length ? appAuthRules(farmIds) : null;
  }
  return null;
}

const sameRules = (a, b) =>
  JSON.stringify([a?.pubAuthRulePatterns || [], a?.subAuthRulePatterns || []]) ===
  JSON.stringify([b?.pubAuthRulePatterns || [], b?.subAuthRulePatterns || []]);

let changed = 0, unchanged = 0, review = 0, skipped = 0;
for (let page = 0; ; page++) {
  const data = await listCredentialsPage(page);
  for (const cred of data.data || []) {
    if (cred.credentialsType !== "MQTT_BASIC") { skipped++; continue; }
    const value = JSON.parse(cred.credentialsValue || "{}");
    const current = value.authRules || {};
    const want = desiredRules(cred.name, current);

    if (!want) {
      const otaTopic = OTA_SAMPLE_TOPICS.find((t) => anyMatch(current.pubAuthRulePatterns, t));
      if (otaTopic) {
        review++;
        console.log(`REVIEW  ${cred.name}: can publish ${otaTopic} - pub=${JSON.stringify(current.pubAuthRulePatterns || [])}`);
      } else {
        skipped++;
      }
      continue;
    }
    if (sameRules(current, want)) { unchanged++; continue; }

    changed++;
    console.log(`${apply ? "UPDATE" : "WOULD UPDATE"}  ${cred.name}`);
    console.log(`    pub ${JSON.stringify(current.pubAuthRulePatterns || [])} -> ${JSON.stringify(want.pubAuthRulePatterns)}`);
    console.log(`    sub ${JSON.stringify(current.subAuthRulePatterns || [])} -> ${JSON.stringify(want.subAuthRulePatterns)}`);
    if (!apply) continue;
    await updateCredentialAuthRules(cred, want);
    if (disconnect) {
      const clientId = value.clientId || cred.name;
      const kicked = await disconnectClient(clientId).catch((err) => {
        console.log(`    (disconnect failed: ${err.message})`);
        return false;
      });
      if (kicked) console.log(`    disconnected ${clientId} - it reconnects with the new rules`);
    }
  }
  if (data.hasNext === false || !data.data || data.data.length === 0) break;
}

console.log(`\n${changed} ${apply ? "updated" : "to update"}, ${unchanged} already correct, ${review} to review, ${skipped} left alone.`);
if (!apply && changed) console.log("Dry run - nothing changed. Re-run with --apply (and --disconnect to make it take effect now).");
if (apply && changed && !disconnect) console.log("Connected clients keep their old rules until they next reconnect (or re-run with --disconnect).");
