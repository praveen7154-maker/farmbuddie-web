// Creates the one MQTT login allowed to send OTA commands - what
// tools/ota_admin.py (Motor repo) connects with. See src/mqttAuthRules.js:
// it may publish farm/<id>/<node>/ota/cmd and motor/ota/broadcast and read
// ota/status, nothing else. Farmers' app logins can't publish OTA at all.
//
// The password is printed ONCE and not stored anywhere - keep it with the
// OTA signing key (password manager). Lost it? Run again with --rotate.
//
// Usage (from server/, or inside the provision-api container):
//   node scripts/createOtaAdminCredential.js            # create (refuses if it exists)
//   node scripts/createOtaAdminCredential.js --rotate   # replace it with a new password
import { createBasicCredentials, deleteCredentials, findCredentialsByName } from "../src/tbmqClient.js";
import { generateMqttPassword } from "../src/password.js";
import { OTA_ADMIN_USERNAME, otaAdminAuthRules } from "../src/mqttAuthRules.js";

const rotate = process.argv.includes("--rotate");

const existing = await findCredentialsByName(OTA_ADMIN_USERNAME);
if (existing && !rotate) {
  console.error(`"${OTA_ADMIN_USERNAME}" already exists. Pass --rotate to replace it with a new password.`);
  process.exit(1);
}
if (existing) {
  await deleteCredentials(existing.id?.id || existing.id);
}

const password = generateMqttPassword();
await createBasicCredentials({
  name: OTA_ADMIN_USERNAME,
  clientId: null,   // ota_admin.py uses a fresh client id every run
  userName: OTA_ADMIN_USERNAME,
  password,
  ...otaAdminAuthRules()
});

console.log(`${rotate && existing ? "Rotated" : "Created"} the OTA admin MQTT login:\n`);
console.log(`  --host mqtt.farmbuddie.com --username ${OTA_ADMIN_USERNAME} --password ${password}\n`);
console.log("Shown once - store it now (password manager, next to the OTA signing key).");
