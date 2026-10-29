import { db } from "./firebaseAdmin.js";

// The onboarding team (web panel > User Roles; bridge/production.js): a
// Firebase sign-in with the claim team: "onboarding" and no email. Live as
// long as teamAccess/<uid> says active - the same check the Firestore rules
// make, so switching a person off works here at once too.
export async function isActiveOnboarding(decodedToken) {
  if (decodedToken?.team !== "onboarding" || !decodedToken.uid) return false;
  const snap = await db.collection("teamAccess").doc(decodedToken.uid).get();
  return snap.exists && snap.get("active") === true;
}
