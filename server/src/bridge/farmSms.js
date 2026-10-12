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

// The main farmer can switch SMS alerts off from the Irrigo Profile screen
// (farmers/<doc>.smsAlertsEnabled === false); the hub then gets an empty
// number, which its firmware treats as "send no SMS".
export function smsAlertsEnabled(doc) {
  return doc?.smsAlertsEnabled !== false;
}

// What the hub's SMS number should be: the main number, "" when the farmer
// switched SMS off, null = no farm record or no main number (leave the hub alone).
export function hubSmsTarget(doc) {
  const number = mainFarmerSmsNumber(doc);
  if (!number) return null;
  return smsAlertsEnabled(doc) ? number : "";
}

export async function loadMainFarmerNumber(db, farmId) {
  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  return snap.empty ? null : hubSmsTarget(snap.docs[0].data());
}

// Only the farm's main farmer (their login phone = primaryMobile) may switch it.
export function isMainFarmer(decodedToken, doc) {
  const caller = String(decodedToken?.phone_number ?? "").replace(/\D/g, "").slice(-10);
  const main = mainFarmerSmsNumber(doc).replace(/\D/g, "").slice(-10);
  return caller.length === 10 && caller === main;
}

// Same shape as farmElectrical.js createTnebSync(): called for every health
// message; firmware without "sms_to" is skipped; one send per farm per
// resendMs until the hub's next health report shows it took.
export function createSmsSync({ loadNumber, publish, now = () => Date.now(), resendMs = 10 * 60 * 1000 }) {
  const lastSent = new Map(); // farmId -> { number, at }
  return async function onHealth(farmId, nodeId, payload) {
    if (typeof payload?.sms_to !== "string") return;
    const want = await loadNumber(farmId);
    if (want === null || want === undefined) return; // no farm record, or no main number on it - keep whatever the hub has
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
