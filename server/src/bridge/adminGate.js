import express from "express";
import { hashPassword, passwordMatches } from "./distributors.js";

// Admin access code for the Irrigo Admin app's sign-in screen.
//
// Tapping "Admin" on the app's sign-in screen first asks for a 6-digit
// code; only then does the email/password form appear. An admin sets the
// code once in the app's Settings. It is an extra step in front of the
// real protection - the Firebase email/password login plus ADMIN_EMAILS
// (adminAuth.js) - not a replacement for it: a wrong code only keeps the
// form hidden in the app.
//
// The code is stored scrypt-hashed (one row, adminGateStore.js). Checking
// it is public (the app has no login yet at that point), so server.js puts
// a tight per-address limit on /admin-gate/check, and on top of that every
// address gets MAX_FAILURES wrong codes before it is locked for a while.

export const CODE_RE = /^\d{6}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

/**
 * deps:
 *   store - adminGateStore.js (or a fake): get() -> { codeHash, updatedBy, updatedAt } | null,
 *           set(codeHash, updatedBy)
 */
export function createAdminGateModule({ store, now = () => Date.now() }) {
  const failures = new Map(); // address -> { count, since }

  function locked(key) {
    const f = failures.get(key);
    if (!f) return false;
    if (now() - f.since > LOCK_MS) { failures.delete(key); return false; }
    return f.count >= MAX_FAILURES;
  }
  function failed(key) {
    const f = failures.get(key);
    if (!f || now() - f.since > LOCK_MS) failures.set(key, { count: 1, since: now() });
    else f.count++;
    if (failures.size > 10000) failures.clear();   // never grows without bound
  }

  // ---- public: before sign-in ----
  const publicRouter = express.Router();
  publicRouter.use(express.json());

  publicRouter.get("/status", async (req, res) => {
    try {
      res.json({ set: !!(await store.get()) });
    } catch (err) {
      console.error("[admin-gate] status failed:", err);
      res.status(500).json({ error: "Couldn't check - try again" });
    }
  });

  publicRouter.post("/check", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const key = req.ip || "?";
    if (locked(key)) return res.status(429).json({ error: "Too many wrong codes - try again in 15 minutes" });
    if (!CODE_RE.test(code)) return res.status(400).json({ error: "Enter the 6-digit code" });
    try {
      const gate = await store.get();
      // No code set yet: nothing to pass.
      if (!gate) return res.json({ ok: true, set: false });
      if (!(await passwordMatches(code, gate.codeHash))) {
        failed(key);
        console.warn(`[admin-gate] wrong code (ip ${key})`);
        return res.status(401).json({ error: "Wrong code" });
      }
      failures.delete(key);
      return res.json({ ok: true, set: true });
    } catch (err) {
      console.error("[admin-gate] check failed:", err);
      return res.status(500).json({ error: "Couldn't check - try again" });
    }
  });

  // ---- admins (mounted behind the server's caller auth + requireAdmin) ----
  const adminRouter = express.Router();
  adminRouter.use(express.json());

  // Set or change the code. Changing it needs the current one.
  adminRouter.put("/", async (req, res) => {
    const current = typeof req.body?.currentCode === "string" ? req.body.currentCode.trim() : "";
    const next = typeof req.body?.newCode === "string" ? req.body.newCode.trim() : "";
    const who = req.decodedToken?.email || req.decodedToken?.uid || "admin";
    const key = `admin:${who}`;
    if (!CODE_RE.test(next)) return res.status(400).json({ error: "The new code must be exactly 6 digits" });
    if (/^(\d)\1{5}$/.test(next) || "0123456789".includes(next) || "9876543210".includes(next)) {
      return res.status(400).json({ error: "Too easy to guess - avoid 111111 or 123456 style codes" });
    }
    if (locked(key)) return res.status(429).json({ error: "Too many wrong codes - try again in 15 minutes" });
    try {
      const gate = await store.get();
      if (gate && !(await passwordMatches(current, gate.codeHash))) {
        failed(key);
        return res.status(401).json({ error: "Current code is wrong" });
      }
      failures.delete(key);
      await store.set(await hashPassword(next), who);
      console.log(`[admin-gate] access code ${gate ? "changed" : "set"} by ${who}`);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[admin-gate] set failed:", err);
      return res.status(500).json({ error: "Couldn't save the code" });
    }
  });

  // When it was last changed, and by whom (Settings shows it).
  adminRouter.get("/", async (req, res) => {
    try {
      const gate = await store.get();
      res.json({ set: !!gate, updatedBy: gate?.updatedBy || null, updatedAt: gate?.updatedAt || null });
    } catch (err) {
      console.error("[admin-gate] read failed:", err);
      res.status(500).json({ error: "Couldn't load" });
    }
  });

  return { publicRouter, adminRouter };
}
