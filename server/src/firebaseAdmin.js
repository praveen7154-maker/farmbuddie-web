import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Uses GOOGLE_APPLICATION_CREDENTIALS (path to the service account JSON),
// same as any other Admin SDK deployment. No credentials are hardcoded here.
if (!getApps().length) {
  initializeApp({ credential: applicationDefault() });
}

export const auth = getAuth();
export const db = getFirestore();
