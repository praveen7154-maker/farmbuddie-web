import { db, messaging } from "../firebaseAdmin.js";

// Firestore / FCM side of Message Broadcast (announcements.js): who the
// farmers are, which phones reach which farms, and the push itself. Kept
// apart so announcements.js can be tested without Firebase.

// Same "online" rule as fleetStatus.js (11 min - rides out one lost health report).
const ONLINE_THRESHOLD_MS = 660 * 1000;
const AUDIENCE_CACHE_MS = 30 * 1000;
const FCM_BATCH = 500;   // sendEachForMulticast's limit
const DEAD_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

function toMillis(t) {
  if (!t) return null;
  if (typeof t.toDate === "function") return t.toDate().getTime();
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

const enabledFarms = (farms) => Object.entries(farms || {}).filter(([, e]) => e?.enabled).map(([id]) => id);

let cache = null;
let cachedAt = 0;

/**
 * farms   - every farm with a controller (farmers/{doc}.controller.uniqueId)
 * phones  - phoneIndex/{phone}: the numbers that can sign in, with their enabled farms
 * devices - fcmTokens/{instanceId}: app installs that can get a push
 */
export async function loadAudience() {
  if (cache && Date.now() - cachedAt < AUDIENCE_CACHE_MS) return cache;
  const [farmerSnap, phoneSnap, tokenSnap] = await Promise.all([
    db.collection("farmers").where("controller.uniqueId", "!=", null).get(),
    db.collection("phoneIndex").get(),
    db.collection("fcmTokens").get()
  ]);
  const farms = farmerSnap.docs.map((doc) => {
    const f = doc.data();
    const lastSeen = toMillis(f.deviceStatus?.lastSeen);
    return {
      farmId: f.controller.uniqueId,
      farmerName: f.name || null,
      farmBuddieId: f.farmBuddieId || null,
      location: f.farmDetails?.location || null,
      active: f.status !== "inactive",
      online: lastSeen != null && Date.now() - lastSeen < ONLINE_THRESHOLD_MS
    };
  }).sort((a, b) => a.farmId.localeCompare(b.farmId, undefined, { numeric: true }));
  const phones = phoneSnap.docs
    .map((doc) => ({ phone: doc.id, farmIds: enabledFarms(doc.data().farms) }))
    .filter((p) => p.farmIds.length > 0);
  const devices = tokenSnap.docs
    .map((doc) => ({ instanceId: doc.id, token: doc.data().token, farmIds: doc.data().farmIds || [] }))
    .filter((d) => d.token);
  cache = { farms, phones, devices };
  cachedAt = Date.now();
  return cache;
}

export async function phoneFarmIds(phone) {
  const snap = await db.collection("phoneIndex").doc(phone).get();
  return snap.exists ? enabledFarms(snap.data().farms) : [];
}

export async function sendPush(tokens, message) {
  let ok = 0;
  let failed = 0;
  const deadTokens = [];
  for (let i = 0; i < tokens.length; i += FCM_BATCH) {
    const batch = tokens.slice(i, i + FCM_BATCH);
    const r = await messaging.sendEachForMulticast({ ...message, tokens: batch });
    ok += r.successCount;
    failed += r.failureCount;
    r.responses.forEach((res, j) => {
      if (!res.success && DEAD_TOKEN_CODES.has(res.error?.code)) deadTokens.push(batch[j]);
    });
  }
  return { ok, failed, deadTokens };
}

// Same housekeeping as pushNotifications.js - an uninstalled app's token
// would otherwise fail on every future message.
export async function removeDevices(tokens) {
  const dead = new Set(tokens);
  const all = cache?.devices || (await loadAudience()).devices;
  await Promise.all(all.filter((d) => dead.has(d.token)).map((d) => db.collection("fcmTokens").doc(d.instanceId).delete()));
  cache = null;
}
