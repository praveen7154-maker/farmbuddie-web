// The hub's SMS alert number = the farm's MAIN farmer number, set from the
// admin panel's farm record (farmers/<doc>.primaryMobile) - nothing else.
// Phones used to push their own profile number on every connect, so with
// two or three app users the hub's number flipped to whichever phone
// connected last, often one not whitelisted on that farm's Airtel M2M SIM
// (SMS then failed as "+CMS ERROR: Network timeout"). App users 2/3 get app
// access only, no SMS.
//
// The hub reports its current number in health ("sms_to"); when it differs
// from the farm record the bridge sends set_sms_number - first setup, and
// again after the main number is edited in the admin panel.

export function mainFarmerSmsNumber(doc) {
  const digits = String(doc?.primaryMobile ?? "").replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `+91${digits}` : "";
}

// null = no farm record for this farmId (leave the hub alone).
export async function loadMainFarmerNumber(db, farmId) {
  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  return snap.empty ? null : mainFarmerSmsNumber(snap.docs[0].data());
}

// Same shape as farmElectrical.js createTnebSync(): called for every health
// message; firmware without "sms_to" is skipped; one send per farm per
// resendMs until the hub's next health report shows it took.
export function createSmsSync({ loadNumber, publish, now = () => Date.now(), resendMs = 10 * 60 * 1000 }) {
  const lastSent = new Map(); // farmId -> { number, at }
  return async function onHealth(farmId, nodeId, payload) {
    if (typeof payload?.sms_to !== "string") return;
    const want = await loadNumber(farmId);
    if (!want) return; // no farm record, or no main number on it - keep whatever the hub has
    if (payload.sms_to === want) {
      lastSent.delete(farmId);
      return;
    }
    const prev = lastSent.get(farmId);
    if (prev && prev.number === want && now() - prev.at < resendMs) return;
    lastSent.set(farmId, { number: want, at: now() });
    await publish(`farm/${farmId}/${nodeId}/motor/1/cmd`, { cmd: "set_sms_number", id: now(), number: want });
    console.log(`[sms] farm ${farmId}: hub had "${payload.sms_to}", set main farmer number`);
  };
}
