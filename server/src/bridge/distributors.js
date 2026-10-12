import crypto from "node:crypto";
import { promisify } from "node:util";
import express from "express";

// Distributor logins for the Irrigo Admin app.
//
// A distributor signs in with their distributor ID (FB-DIST-0001, made by
// the web panel's Distributor Onboarding) and a password. The first
// password is the ID itself; that login only lets them set a new one -
// nothing else answers until they do. They then see and manage only the
// farmers they onboarded (the farmer record's leadSource.distributorId):
// device monitoring and control, farmer QR codes, and those farmers'
// referrals and bonus redemptions (read only).
//
// Not a Firebase login: a Firebase session would let them read the
// database directly with the app's SDK, past every per-distributor check
// here. The app holds an opaque session token ("fbd_...") instead, which
// only this server understands - see authenticate().

const scrypt = promisify(crypto.scrypt);
export const TOKEN_PREFIX = "fbd_";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;
// A distributor ID typed in the app: FB-DIST-0001 (any case, spaces trimmed).
const ID_RE = /^FB-DIST-\d{1,8}$/;
// Wrong passwords per distributor ID before it's locked for a while (on
// top of the per-address limit server.js puts on /distributor/login).
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;

export const normalizeId = (id) => String(id || "").trim().toUpperCase();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function passwordMatches(password, stored) {
  const [kind, saltB64, keyB64] = String(stored || "").split("$");
  if (kind !== "scrypt" || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, "base64");
  const got = await scrypt(password, Buffer.from(saltB64, "base64"), want.length);
  return crypto.timingSafeEqual(got, want);
}

/**
 * deps:
 *   store            - distributorStore.js (or a fake)
 *   findDistributor  - async (id) => { distributorId, name, status } | null
 *   distributorFarms - async (id) => [{ farmId, farmerName, phones: [10-digit] }]
 *   loadReferrals    - async () => every referral document
 *   loadRedemptions  - async () => every bonus redemption document
 */
export function createDistributorModule({ store, findDistributor, distributorFarms, loadReferrals, loadRedemptions, now = () => Date.now() }) {
  const failures = new Map(); // id -> { count, since }

  function locked(id) {
    const f = failures.get(id);
    if (!f) return false;
    if (now() - f.since > LOCK_MS) { failures.delete(id); return false; }
    return f.count >= MAX_FAILURES;
  }
  function failed(id) {
    const f = failures.get(id);
    if (!f || now() - f.since > LOCK_MS) failures.set(id, { count: 1, since: now() });
    else f.count++;
  }

  // A distributor switched to inactive in the web panel loses access at
  // once - checked on every request, cached for a minute.
  const activeCache = new Map(); // id -> { distributor, at }
  async function activeDistributor(id) {
    const c = activeCache.get(id);
    if (c && now() - c.at < 60 * 1000) return c.distributor;
    const d = await findDistributor(id);
    const distributor = d && d.status !== "inactive" ? d : null;
    activeCache.set(id, { distributor, at: now() });
    return distributor;
  }

  async function newSession(id) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    await store.createSession(sha256(token), id, new Date(now() + SESSION_DAYS * 24 * 3600 * 1000));
    return token;
  }

  /**
   * A bearer token from the app -> the caller, shaped like a decoded
   * Firebase token so the rest of the server needs no special case:
   * { uid, distributorId, distributorName, mustChange, sessionHash }. Null if
   * it isn't a valid distributor session (or the distributor is inactive).
   */
  async function authenticate(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    const sessionHash = sha256(token);
    const session = await store.getSession(sessionHash);
    if (!session) return null;
    const d = await activeDistributor(session.distributorId);
    if (!d) return null;
    const account = await store.getAccount(session.distributorId);
    return {
      uid: `distributor:${session.distributorId}`,
      distributorId: session.distributorId,
      distributorName: d.name || null,
      mustChange: !account || account.mustChange,
      sessionHash
    };
  }

  // ---- public: sign in ----
  const publicRouter = express.Router();
  publicRouter.post("/login", express.json(), async (req, res) => {
    const id = normalizeId(req.body?.distributorId);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!ID_RE.test(id) || !password) return res.status(400).json({ error: "Enter your distributor ID and password" });
    if (locked(id)) return res.status(429).json({ error: "Too many wrong passwords - try again in 15 minutes" });
    try {
      const d = await activeDistributor(id);
      const account = d ? await store.getAccount(id) : null;
      // No password set yet: the first one is the distributor ID itself.
      const ok = d && (account ? await passwordMatches(password, account.passwordHash) : normalizeId(password) === id);
      if (!ok) {
        failed(id);
        console.warn(`[distributor] login refused for ${id} (ip ${req.ip})`);
        return res.status(401).json({ error: "Wrong distributor ID or password" });
      }
      failures.delete(id);
      const mustChange = !account || account.mustChange;
      const token = await newSession(id);
      console.log(`[distributor] ${id} signed in${mustChange ? " (must set a password)" : ""}`);
      return res.json({ token, distributorId: id, name: d.name || null, mustChange });
    } catch (err) {
      console.error("[distributor] login failed:", err);
      return res.status(500).json({ error: "Sign-in failed - try again" });
    }
  });

  // ---- the signed-in distributor (mounted behind the server's caller auth) ----
  const router = express.Router();
  router.use(express.json());
  router.use((req, res, next) => {
    if (!req.decodedToken?.distributorId) return res.status(403).json({ error: "Distributor login required" });
    next();
  });

  router.get("/me", async (req, res) => {
    const { distributorId, distributorName, mustChange } = req.decodedToken;
    res.json({ distributorId, name: distributorName, mustChange });
  });

  router.post("/password", async (req, res) => {
    const { distributorId, sessionHash } = req.decodedToken;
    const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const next = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters` });
    if (normalizeId(next) === distributorId) return res.status(400).json({ error: "New password can't be your distributor ID" });
    try {
      const account = await store.getAccount(distributorId);
      const currentOk = account ? await passwordMatches(current, account.passwordHash) : normalizeId(current) === distributorId;
      if (!currentOk) return res.status(401).json({ error: "Current password is wrong" });
      await store.setPassword(distributorId, await hashPassword(next), false);
      await store.deleteSessions(distributorId, sessionHash);   // other phones signed in with the old password
      console.log(`[distributor] ${distributorId} changed their password`);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[distributor] password change failed:", err);
      return res.status(500).json({ error: "Couldn't change the password" });
    }
  });

  router.post("/logout", async (req, res) => {
    try {
      await store.deleteSession(req.decodedToken.sessionHash);
    } catch (err) {
      console.error("[distributor] logout failed:", err);
    }
    res.json({ ok: true });
  });

  // Their farmers' referrals / bonus redemptions, newest first. The farmer
  // app stamps each with the submitting phone (+91...); a farm's phones are
  // its farmer's primary/secondary numbers and app users.
  async function forMyFarmers(req, load) {
    const farms = await distributorFarms(req.decodedToken.distributorId);
    const phones = new Set(farms.flatMap((f) => f.phones).filter((p) => p.length === 10));
    return (await load())
      .filter((r) => phones.has(last10(r.referrerPhone)))
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  }
  router.get("/referrals", async (req, res) => {
    try {
      res.json({ referrals: await forMyFarmers(req, loadReferrals) });
    } catch (err) {
      console.error("[distributor] referrals failed:", err);
      res.status(500).json({ error: "Couldn't load referrals" });
    }
  });
  router.get("/redemptions", async (req, res) => {
    try {
      res.json({ redemptions: await forMyFarmers(req, loadRedemptions) });
    } catch (err) {
      console.error("[distributor] redemptions failed:", err);
      res.status(500).json({ error: "Couldn't load bonus redemptions" });
    }
  });

  // ---- admin: forgotten password ----
  // Back to "the ID is the password, change it on first login"; signs out
  // every phone of that distributor.
  const adminRouter = express.Router();
  adminRouter.post("/:id/reset-password", async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!ID_RE.test(id)) return res.status(400).json({ error: "Invalid distributor ID" });
    try {
      await store.deleteAccount(id);
      await store.deleteSessions(id);
      failures.delete(id);
      console.log(`[distributor] ${id} password reset by ${req.decodedToken?.email}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[distributor] reset failed:", err);
      res.status(500).json({ error: "Couldn't reset the password" });
    }
  });

  return { publicRouter, router, adminRouter, authenticate };
}

export { last10 };
