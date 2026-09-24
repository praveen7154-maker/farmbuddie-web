// One-time repair for the old Add Farm bug: adding a second farm for an
// existing farmer linked the new controller to the farmer's FIRST farm doc,
// so the new farm's MQTT login was written into the first farm's record and
// the new farm showed none.
//
// For every assigned controller this finds its real farm doc (the farmers
// doc whose controller.uniqueId matches - the same lookup the bridge uses)
// and, with --apply:
//   - points controllers/<id>.farmerDocId at that doc,
//   - copies the controller's own stored login into that doc's
//     controller.mqtt when it's missing or belongs to another controller,
//   - fills an empty sim.simImsi from the controller (Add Farm didn't save
//     the IMSI before).
// Nothing on the broker (TBMQ) changes - no login is created or rotated.
//
// Usage (inside the provision-api container):
//   node scripts/repairFarmMqttLinks.js            # dry run - shows what's wrong
//   node scripts/repairFarmMqttLinks.js --apply    # fix it
import { db } from "../src/firebaseAdmin.js";

const apply = process.argv.includes("--apply");

const farmsSnap = await db.collection("farmers").get();
const farmsByUnit = new Map();
for (const d of farmsSnap.docs) {
  const unit = d.data().controller?.uniqueId;
  if (!unit) continue;
  if (!farmsByUnit.has(unit)) farmsByUnit.set(unit, []);
  farmsByUnit.get(unit).push(d);
}

const ctrlSnap = await db.collection("controllers").where("status", "==", "assigned").get();
let fixed = 0, ok = 0, problems = 0;

for (const c of ctrlSnap.docs) {
  const ctrl = c.data();
  const unit = ctrl.uniqueId;
  const farms = farmsByUnit.get(unit) || [];
  if (farms.length !== 1) {
    problems++;
    console.log(`CHECK   controller ${unit}: ${farms.length === 0 ? "no farm record has it" : `${farms.length} farm records have it (${farms.map((f) => f.data().farmBuddieId || f.id).join(", ")})`} - fix by hand`);
    continue;
  }

  const farm = farms[0];
  const shown = farm.data().controller?.mqtt || {};
  const linkWrong = ctrl.farmerDocId !== farm.id;
  const hasLogin = !!ctrl.mqttPasswordPlaintext;
  const loginWrong = hasLogin && (shown.username !== ctrl.username || shown.password !== ctrl.mqttPasswordPlaintext);
  // No login of its own, but the farm doc shows another controller's.
  const foreignLogin = !hasLogin && !!shown.username && shown.username !== `FBIRG${unit}`;
  const label = `controller ${unit} (${farm.data().farmBuddieId || farm.id})`;
  const imsiMissing = farm.data().network?.type === "SIM" && !farm.data().sim?.simImsi && !!ctrl.simImsi;

  if (!linkWrong && !loginWrong && !foreignLogin && !imsiMissing) {
    ok++;
    if (!hasLogin) console.log(`NOTE    ${label}: no MQTT login issued yet - use Generate MQTT Credentials on the MCU / Controller page`);
    continue;
  }

  fixed++;
  console.log(`${apply ? "FIX" : "WOULD FIX"}  ${label}:`);
  if (linkWrong) console.log(`    link  farmerDocId ${ctrl.farmerDocId} -> ${farm.id}`);
  if (loginWrong) console.log(`    login shown "${shown.username || "-"}" -> "${ctrl.username}"`);
  if (foreignLogin) console.log(`    login shown "${shown.username}" is another controller's -> cleared`);
  if (imsiMissing) console.log(`    SIM IMSI  - -> ${ctrl.simImsi}`);
  if (!hasLogin) console.log("    (no MQTT login issued yet - use Generate MQTT Credentials after this)");

  if (!apply) continue;
  if (linkWrong) await c.ref.update({ farmerDocId: farm.id });
  if (imsiMissing) await farm.ref.update({ "sim.simImsi": ctrl.simImsi });
  if (foreignLogin) {
    await farm.ref.update({
      "controller.mqtt": { brokerUrl: "", port: shown.port || 8883, username: "", password: "" }
    });
  }
  if (loginWrong) {
    await farm.ref.update({
      "controller.mqtt": {
        brokerUrl: ctrl.mqttUrl,
        port: ctrl.mqttPort,
        username: ctrl.username,
        credentialsId: ctrl.mqttCredentialsId,
        issuedAt: ctrl.mqttIssuedAt,
        password: ctrl.mqttPasswordPlaintext
      }
    });
  }
}

console.log(`\n${fixed} ${apply ? "fixed" : "to fix"}, ${ok} already correct, ${problems} to check by hand.`);
if (!apply && fixed) console.log("Dry run - nothing changed. Re-run with --apply.");
process.exit(0);
