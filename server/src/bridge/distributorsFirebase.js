import { db } from "../firebaseAdmin.js";
import { last10 } from "./distributors.js";

// Firestore side of distributors.js.

export async function findDistributor(id) {
  const snap = await db.collection("distributors").where("distributorId", "==", id).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return { distributorId: id, name: d.name || null, status: d.status || "active", state: d.state || null };
}

const farmPhones = (f) => [f.primaryMobile, f.secondaryMobile, ...(Array.isArray(f.appUsers) ? f.appUsers.map((u) => u?.mobile) : [])]
  .map(last10)
  .filter((p) => p.length === 10);

// The farmers this distributor onboarded (Farmer Onboarding's Lead Source).
export async function distributorFarms(id) {
  const snap = await db.collection("farmers").where("leadSource.distributorId", "==", id).get();
  return snap.docs.map((doc) => {
    const f = doc.data();
    return { farmId: f.controller?.uniqueId || null, farmerName: f.name || null, phones: farmPhones(f) };
  });
}

export async function loadReferrals() {
  return (await db.collection("referrals").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function loadRedemptions() {
  return (await db.collection("bonusRedemptions").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Which distributor onboarded the farmer on this farm ("" = none) - the
// per-farm access check for distributors (ownership.js). A minute's cache:
// every live command and REST call asks.
const farmDistributor = new Map(); // farmId -> { id, at }
export async function distributorOfFarm(farmId) {
  const c = farmDistributor.get(farmId);
  if (c && Date.now() - c.at < 60 * 1000) return c.id;
  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  const id = snap.empty ? "" : (snap.docs[0].data().leadSource?.distributorId || "");
  farmDistributor.set(farmId, { id, at: Date.now() });
  return id;
}
