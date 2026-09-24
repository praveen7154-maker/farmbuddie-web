// Clears a farm's device-key binding (controllers/{id}.deviceKeyHash - see
// src/deviceBinding.js) so the NEXT device to bootstrap for that farm binds
// itself. Needed when a farm's Motor hub is replaced, or its flash/NVS was
// wiped: the device then has a new key, and bootstrap refuses it with
// 403 device_mismatch until the old binding is cleared.
//
// Only clear a binding when you know the farm's genuine hardware changed -
// until the new device bootstraps, that farm is claimable by anyone holding
// the fleet provisioning secret, same as before binding existed.
//
// Usage (from server/, or inside the provision-api container):
//   node scripts/resetDeviceBinding.js 0005            # dry run - shows the current binding
//   node scripts/resetDeviceBinding.js 0005 --apply    # clears it
import { FieldValue } from "firebase-admin/firestore";
import { findControllerByFarmId } from "../src/deviceBinding.js";

const farmId = process.argv[2];
const apply = process.argv.includes("--apply");

if (!farmId || farmId.startsWith("--")) {
  console.error("Usage: node scripts/resetDeviceBinding.js <farmId> [--apply]");
  process.exit(1);
}

const { ref, data } = await findControllerByFarmId(farmId).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

if (!data.deviceKeyHash) {
  console.log(`farmId ${farmId}: not bound - nothing to reset`);
  process.exit(0);
}

console.log(`farmId ${farmId}: bound ${data.deviceBoundAt || "?"} via ${data.deviceBoundVia || "?"} (key hash ${data.deviceKeyHash.slice(0, 12)}...)`);
if (!apply) {
  console.log("Dry run - re-run with --apply to clear it.");
  process.exit(0);
}

await ref.update({
  deviceKeyHash: FieldValue.delete(),
  deviceBoundAt: FieldValue.delete(),
  deviceBoundVia: FieldValue.delete()
});
console.log(`farmId ${farmId}: binding cleared - the next device to bootstrap for this farm binds itself.`);
process.exit(0);
