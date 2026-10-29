import crypto from "node:crypto";
import express from "express";
import { isAdmin } from "../adminAuth.js";
import { hashPassword, passwordMatches } from "./distributors.js";

// Production module (web panel > Production): the daily entry of new MCU
// controllers by the production team - the same controller records the
// MCU / Controller page's Excel upload makes, one at a time, with the same
// checks (4-digit Unique ID, nothing already used by another controller),
// and with who made each one.
//
// Who:
//   admin  - an ADMIN_EMAILS (Firebase) login: enters controllers too, and
//            manages the production team's accounts (create, reset a
//            password, switch off) - /production-users.
//   staff  - a production team member: a username + password made by an
//            admin, signed in on the same login page. Sees only this
//            module, and only their own entries (team totals as numbers).
//
// Staff logins are NOT Firebase logins - a Firebase session would let them
// read the whole database with the web SDK, past every check here. Like
// the distributors' (distributors.js), the browser holds an opaque session
// token ("fbp_...") only this server understands, and the server's caller
// check (server.js) lets it reach /production and nothing else. Only an
// admin sets or changes their passwords.

export const PROD_TOKEN_PREFIX = "fbp_";
export const VARIANTS = ["IRRIGO", "IRRIGO_PLUS", "IRRIGO_SMART_PLUS"];
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;
const SESSION_HOURS = 12;            // one working day; then sign in again
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;
const IST_MS = 330 * 60 * 1000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const normalizeUsername = (u) => String(u || "").trim().toLowerCase();

// ---------------------------------------------------------------- controller fields
// What a controller record holds (the Excel columns), as typed or scanned.
export const FIELDS = [
  { key: "serialNumber", label: "Serial Number", required: true },
  { key: "uniqueId", label: "Unique ID", required: true },
  { key: "imeiNumber", label: "IMEI Number", required: true },
  { key: "simMsisdn", label: "SIM MSISDN", required: false },
  { key: "simNumber", label: "SIM Number", required: false },
  { key: "simImsi", label: "SIM IMSI", required: false }
];
// The ones no two controllers may share (as the Excel upload checks).
export const UNIQUE_FIELDS = FIELDS.map((f) => f.key);

const clean = (v) => String(v ?? "").replace(/\s+/g, "").trim();

/** Normalizes what was typed; returns { values, problems: { field: message } }. */
export function checkFields(input) {
  const v = {
    variant: String(input?.variant || "").trim().toUpperCase(),
    serialNumber: clean(input?.serialNumber).toUpperCase(),
    uniqueId: clean(input?.uniqueId),
    imeiNumber: clean(input?.imeiNumber),
    simMsisdn: clean(input?.simMsisdn),
    simNumber: clean(input?.simNumber).toUpperCase(),
    simImsi: clean(input?.simImsi)
  };
  // "1" -> "0001", as the Excel upload recovers a number Excel shortened.
  if (/^\d{1,4}$/.test(v.uniqueId)) v.uniqueId = v.uniqueId.padStart(4, "0");
  const p = {};
  if (!VARIANTS.includes(v.variant)) p.variant = "Choose the variant";
  if (!v.serialNumber) p.serialNumber = "Serial Number is required";
  else if (!/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(v.serialNumber)) p.serialNumber = "Letters, digits and - only (4-32)";
  if (!v.uniqueId) p.uniqueId = "Unique ID is required";
  else if (!/^\d{4}$/.test(v.uniqueId)) p.uniqueId = "4 digits, e.g. 0001 - it becomes the device's farm ID";
  else if (v.uniqueId === "0000") p.uniqueId = "0000 is not a valid Unique ID";
  if (!v.imeiNumber) p.imeiNumber = "IMEI is required";
  else if (!/^\d{15}$/.test(v.imeiNumber)) p.imeiNumber = "15 digits";
  if (v.simMsisdn && !/^\d{8,15}$/.test(v.simMsisdn)) p.simMsisdn = "8-15 digits";
  if (v.simNumber && !/^\d{18,22}F?$/.test(v.simNumber)) p.simNumber = "18-22 digits (the ICCID printed on the SIM)";
  if (v.simImsi && !/^\d{14,15}$/.test(v.simImsi)) p.simImsi = "15 digits";
  return { values: v, problems: p };
}

/** True if the IMEI's last digit is its Luhn check digit - a typo check, not a rule. */
export function imeiCheckDigitOk(imei) {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(imei[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** "2026-10-29" -> [start, end) in ms, as an IST calendar day. */
export function istDayRange(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return null;
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_MS;
  return [start, start + 24 * 3600 * 1000];
}
export const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/**
 * deps:
 *   store        - productionStore.js (or a fake): staff accounts + sessions
 *   controllers  - productionFirebase.js (or a fake):
 *                    clashes(values) -> [{ field, value, controllerId, uniqueId }]
 *                    create(doc) -> { id } | throws { clashes } (checked atomically)
 *                    list({ from, to, createdById }) -> [{ id, ...doc, createdAtMs }]
 *                    countBy(createdById) -> number
 *                    nextUniqueId() -> "0042"
 *                    lastSerials() -> { IRRIGO: "IRRIGO26AA10041", ... } (newest per variant)
 *   now          - () => ms
 */
export function createProductionModule({ store, controllers, now = () => Date.now() }) {
  const failures = new Map();
  const locked = (u) => {
    const f = failures.get(u);
    if (!f) return false;
    if (now() - f.since > LOCK_MS) { failures.delete(u); return false; }
    return f.count >= MAX_FAILURES;
  };
  const failed = (u) => {
    const f = failures.get(u);
    if (!f || now() - f.since > LOCK_MS) failures.set(u, { count: 1, since: now() });
    else f.count++;
  };

  // One controller save at a time on this server, on top of the database
  // transaction - two people scanning the same SIM a second apart can't
  // both get it.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** A bearer token -> the caller (shaped like a decoded token), or null. */
  async function authenticate(token) {
    if (typeof token !== "string" || !token.startsWith(PROD_TOKEN_PREFIX)) return null;
    const sessionHash = sha256(token);
    const session = await store.getSession(sessionHash);
    if (!session) return null;
    const user = await store.getUser(session.username);
    if (!user || !user.active) return null;
    return { uid: `production:${user.username}`, productionUser: user.username, name: user.name, sessionHash };
  }

  // ---------------- public: sign in ----------------
  const publicRouter = express.Router();
  publicRouter.post("/login", express.json(), async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!USERNAME_RE.test(username) || !password) return res.status(400).json({ error: "Enter your username and password" });
    if (locked(username)) return res.status(429).json({ error: "Too many wrong passwords - try again in 15 minutes" });
    try {
      const user = await store.getUser(username);
      const ok = user && user.active && await passwordMatches(password, user.passwordHash);
      if (!ok) {
        failed(username);
        console.warn(`[production] login refused for ${username} (ip ${req.ip})`);
        return res.status(401).json({ error: user && !user.active ? "This account is switched off - ask the admin" : "Wrong username or password" });
      }
      failures.delete(username);
      const token = PROD_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
      await store.createSession(sha256(token), username, new Date(now() + SESSION_HOURS * 3600 * 1000));
      await store.touchLogin(username);
      console.log(`[production] ${username} signed in`);
      return res.json({ token, username, name: user.name, expiresInHours: SESSION_HOURS });
    } catch (err) {
      console.error("[production] login failed:", err);
      return res.status(500).json({ error: "Sign-in failed - try again" });
    }
  });

  // ---------------- the module: admin or staff ----------------
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  router.use((req, res, next) => {
    const t = req.decodedToken;
    if (t?.productionUser) {
      req.who = { type: "staff", id: t.productionUser, name: t.name || t.productionUser };
    } else if (isAdmin(t)) {
      req.who = { type: "admin", id: String(t.email).toLowerCase(), name: t.name || t.email };
    } else {
      return res.status(403).json({ error: "Production access required" });
    }
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[production] ${req.method} ${req.path} failed:`, err);
      res.status(500).json({ error: "Something went wrong - try again" });
    }
  };
  const view = (c) => ({
    id: c.id, variant: c.variant, serialNumber: c.serialNumber, uniqueId: c.uniqueId, imeiNumber: c.imeiNumber,
    simMsisdn: c.simMsisdn || "", simNumber: c.simNumber || "", simImsi: c.simImsi || "", status: c.status || "available",
    createdAtMs: c.createdAtMs || null, createdBy: c.createdBy || null, source: c.source || null
  });

  router.get("/me", (req, res) => res.json({ role: req.who.type, username: req.who.id, name: req.who.name, variants: VARIANTS }));

  // Today's (or a day's) numbers for the dashboard: mine, the whole team's,
  // per variant, the last 7 days, and the next free Unique ID.
  router.get("/summary", wrap(async (req, res) => {
    const today = istDay(now());
    const [, end] = istDayRange(today);
    const weekStart = end - 7 * 24 * 3600 * 1000;
    const week = await controllers.list({ from: weekStart, to: end });
    const days = [];
    for (let t = weekStart; t < end; t += 24 * 3600 * 1000) {
      const d = istDay(t);
      days.push({ day: d, count: week.filter((c) => istDay(c.createdAtMs) === d).length });
    }
    const todays = week.filter((c) => istDay(c.createdAtMs) === today);
    const byVariant = Object.fromEntries(VARIANTS.map((v) => [v, todays.filter((c) => c.variant === v).length]));
    res.json({
      today,
      mineToday: todays.filter((c) => c.createdBy?.id === req.who.id).length,
      teamToday: todays.length,
      byVariant,
      days,
      mineTotal: await controllers.countBy(req.who.id),
      nextUniqueId: await controllers.nextUniqueId(),
      // the page fills a new serial in the same format, ending in the Unique ID
      lastSerials: await controllers.lastSerials()
    });
  }));

  // A day's entries. Staff: their own only. Admin: everyone's, or one person's.
  router.get("/entries", wrap(async (req, res) => {
    const day = req.query.day ? String(req.query.day) : istDay(now());
    const range = istDayRange(day);
    if (!range) return res.status(400).json({ error: "day must be YYYY-MM-DD" });
    let createdById = null;
    if (req.who.type === "staff") createdById = req.who.id;
    else if (req.query.by) createdById = String(req.query.by).toLowerCase();
    const list = await controllers.list({ from: range[0], to: range[1], createdById });
    res.json({ day, entries: list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)).map(view) });
  }));

  // While typing: what's wrong, and what's already used by another controller.
  router.post("/check", wrap(async (req, res) => {
    const { values, problems } = checkFields(req.body);
    const present = Object.fromEntries(UNIQUE_FIELDS.filter((k) => values[k] && !problems[k]).map((k) => [k, values[k]]));
    const clashes = Object.keys(present).length ? await controllers.clashes(present) : [];
    res.json({ values, problems, clashes, imeiCheckDigitOk: values.imeiNumber ? imeiCheckDigitOk(values.imeiNumber) : null });
  }));

  router.post("/controllers", wrap(async (req, res) => {
    const { values, problems } = checkFields(req.body);
    if (Object.keys(problems).length) return res.status(400).json({ error: "Fix the marked fields", problems });
    const doc = {
      variant: values.variant,
      serialNumber: values.serialNumber,
      uniqueId: values.uniqueId,
      imeiNumber: values.imeiNumber,
      simMsisdn: values.simMsisdn,
      simNumber: values.simNumber,
      simImsi: values.simImsi,
      status: "available",
      farmerId: null,
      source: "production",
      createdBy: { type: req.who.type, id: req.who.id, name: req.who.name }
    };
    try {
      const saved = await serial(() => controllers.create(doc));
      console.log(`[production] controller ${doc.uniqueId} (${doc.serialNumber}) added by ${req.who.type} ${req.who.id}`);
      res.status(201).json({ ok: true, id: saved.id, controller: view({ ...doc, id: saved.id, createdAtMs: now() }) });
    } catch (err) {
      if (err?.clashes) return res.status(409).json({ error: "Already used by another controller", clashes: err.clashes });
      throw err;
    }
  }));

  router.post("/logout", wrap(async (req, res) => {
    if (req.decodedToken?.sessionHash) await store.deleteSession(req.decodedToken.sessionHash);
    res.json({ ok: true });
  }));

  // ---------------- admin: the production team's accounts ----------------
  const adminRouter = express.Router();
  adminRouter.use(express.json({ limit: "16kb" }));
  const actor = (req) => String(req.decodedToken?.email || "admin").toLowerCase();
  const userView = (u, entries) => ({
    username: u.username, name: u.name, active: u.active, createdBy: u.createdBy, createdAt: u.createdAt,
    passwordChangedAt: u.passwordChangedAt || null, lastLoginAt: u.lastLoginAt || null, ...(entries !== undefined ? { entries } : {})
  });

  adminRouter.get("/", wrap(async (req, res) => {
    const users = await store.listUsers();
    const counts = await Promise.all(users.map((u) => controllers.countBy(u.username).catch(() => null)));
    res.json({ users: users.map((u, i) => userView(u, counts[i])) });
  }));

  adminRouter.post("/", wrap(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "Username: 3-32 characters, starting with a letter - letters, digits, . _ - (no spaces, no @)" });
    }
    if (!name) return res.status(400).json({ error: "Enter the person's name" });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    if (normalizeUsername(password) === username) return res.status(400).json({ error: "Password can't be the username" });
    const created = await store.createUser({ username, name, passwordHash: await hashPassword(password), createdBy: actor(req) });
    if (!created) return res.status(409).json({ error: `Username "${username}" is already taken` });
    console.log(`[production] user ${username} created by ${actor(req)}`);
    res.status(201).json({ user: userView(await store.getUser(username), 0) });
  }));

  adminRouter.post("/:username/password", wrap(async (req, res) => {
    const username = normalizeUsername(req.params.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    if (normalizeUsername(password) === username) return res.status(400).json({ error: "Password can't be the username" });
    if (!await store.getUser(username)) return res.status(404).json({ error: "No such user" });
    await store.setPassword(username, await hashPassword(password));
    await store.deleteSessions(username);      // signed out everywhere - the new password from now on
    failures.delete(username);
    console.log(`[production] password of ${username} changed by ${actor(req)}`);
    res.json({ ok: true });
  }));

  adminRouter.post("/:username/active", wrap(async (req, res) => {
    const username = normalizeUsername(req.params.username);
    const active = req.body?.active === true;
    if (!await store.getUser(username)) return res.status(404).json({ error: "No such user" });
    await store.setActive(username, active);
    if (!active) await store.deleteSessions(username);
    console.log(`[production] ${username} ${active ? "switched on" : "switched off"} by ${actor(req)}`);
    res.json({ ok: true });
  }));

  return { publicRouter, router, adminRouter, authenticate };
}
