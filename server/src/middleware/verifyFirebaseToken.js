import { auth } from "../firebaseAdmin.js";

/**
 * Verifies the Firebase ID token on every request. Matches the trust model
 * the rest of farmbuddie-web already uses (any signed-in Firebase user is
 * treated as authorized) — no separate role system exists in Firestore today.
 */
export async function verifyFirebaseToken(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <idToken>" });
  }

  try {
    req.decodedToken = await auth.verifyIdToken(match[1]);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
