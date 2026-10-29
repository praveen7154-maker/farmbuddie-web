import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createProductionModule, checkFields, imeiCheckDigitOk, istDayRange, istDay, PROD_TOKEN_PREFIX, UNIQUE_FIELDS
} from "../src/bridge/production.js";

function fakeStore() {
  const users = new Map();
  const sessions = new Map();
  return {
    users, sessions,
    async listUsers() { return [...users.values()]; },
    async getUser(u) { return users.get(u) || null; },
    async createUser({ username, name, passwordHash, createdBy }) {
      if (users.has(username)) return false;
      users.set(username, { username, name, passwordHash, createdBy, active: true, createdAt: new Date() });
      return true;
    },
    async setPassword(u, h) { users.get(u).passwordHash = h; },
    async setActive(u, a) { users.get(u).active = a; },
    async touchLogin(u) { users.get(u).lastLoginAt = new Date(); },
    async createSession(h, u, expiresAt) { sessions.set(h, { username: u, expiresAt }); },
    async getSession(h) { return sessions.get(h) || null; },
    async deleteSession(h) { sessions.delete(h); },
    async deleteSessions(u) { for (const [h, s] of sessions) if (s.username === u) sessions.delete(h); }
  };
}

// The controllers collection; create() is deliberately slow and NOT atomic on
// its own, so only the module's own one-at-a-time saving keeps duplicates out.
function fakeControllers(clock) {
  const docs = [];
  let n = 0;
  const clashes = async (values) => {
    const out = [];
    for (const field of UNIQUE_FIELDS) {
      if (!values[field]) continue;
      const hit = docs.find((d) => d[field] === values[field]);
      if (hit) out.push({ field, value: values[field], controllerId: hit.id, uniqueId: hit.uniqueId });
    }
    return out;
  };
  return {
    docs,
    clashes,
    async create(doc) {
      const c = await clashes(doc);
      await new Promise((r) => setTimeout(r, 20));
      if (c.length) throw Object.assign(new Error("clash"), { clashes: c });
      const id = `c${++n}`;
      docs.push({ ...doc, id, createdAtMs: clock() });
      return { id };
    },
    async list({ from, to, createdById = null }) {
      return docs.filter((d) => d.createdAtMs >= from && d.createdAtMs < to && (!createdById || d.createdBy?.id === createdById));
    },
    async countBy(id) { return docs.filter((d) => d.createdBy?.id === id).length; },
    async nextUniqueId() {
      const ids = docs.map((d) => Number(d.uniqueId)).filter(Number.isFinite);
      return String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
    }
  };
}

const NOW = Date.UTC(2026, 9, 29, 6, 30);   // 29 Oct 2026, 12:00 IST

async function withServer(fn) {
  let t = NOW;
  const clock = () => t;
  const store = fakeStore();
  const controllers = fakeControllers(clock);
  const mod = createProductionModule({ store, controllers, now: clock });
  const app = express();
  app.use("/production", mod.publicRouter);
  // server.js's verifyCaller, reduced: "admin:<email>" stands for a Firebase admin login.
  app.use(async (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (token.startsWith(PROD_TOKEN_PREFIX)) {
      if (req.path !== "/production" && !req.path.startsWith("/production/")) return res.status(403).json({ error: "Production access only" });
      const who = await mod.authenticate(token);
      if (!who) return res.status(401).json({ code: "signed_out" });
      req.decodedToken = who;
      return next();
    }
    if (token.startsWith("admin:")) { req.decodedToken = { email: token.slice(6) }; return next(); }
    if (token.startsWith("farmer")) { req.decodedToken = { uid: "f1", phone_number: "+919000000000" }; return next(); }
    return res.status(401).json({ error: "no token" });
  });
  app.use("/production", mod.router);
  app.use("/production-users", (req, res, next) => (req.decodedToken?.email ? next() : res.status(403).json({ error: "admin only" })), mod.adminRouter);
  app.get("/farmers", (req, res) => res.json({ secret: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, token } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    await fn({ call, store, controllers, advance: (ms) => { t += ms; } });
  } finally {
    server.close();
  }
}

const ADMIN = "admin:owner@farmbuddie.com";
const GOOD = { variant: "IRRIGO", serialNumber: "irrigo26aa10001", uniqueId: "7", imeiNumber: "490154203237518", simMsisdn: "5754000000001", simNumber: "8991940912940333745", simImsi: "404000000000001" };

test("fields are normalized and checked like the Excel upload", () => {
  const { values, problems } = checkFields(GOOD);
  assert.deepEqual(problems, {});
  assert.equal(values.uniqueId, "0007");
  assert.equal(values.serialNumber, "IRRIGO26AA10001");
  const bad = checkFields({ variant: "x", serialNumber: "", uniqueId: "12345", imeiNumber: "8.6E+14", simNumber: "123", simImsi: "1", simMsisdn: "12" }).problems;
  for (const k of ["variant", "serialNumber", "uniqueId", "imeiNumber", "simNumber", "simImsi", "simMsisdn"]) assert.ok(bad[k], k);
  assert.ok(checkFields({ ...GOOD, uniqueId: "0000" }).problems.uniqueId);
  assert.deepEqual(checkFields({ ...GOOD, simMsisdn: "", simNumber: "", simImsi: "" }).problems, {}, "SIM fields optional");
  assert.equal(checkFields({ ...GOOD, imeiNumber: "4901 5420 3237 518" }).values.imeiNumber, "490154203237518", "spaces from a scanner dropped");
});

test("IMEI check digit (typo hint)", () => {
  assert.equal(imeiCheckDigitOk("490154203237518"), true);
  assert.equal(imeiCheckDigitOk("490154203237519"), false);
});

test("IST day ranges", () => {
  const [a, b] = istDayRange("2026-10-29");
  assert.equal(istDay(a), "2026-10-29");
  assert.equal(istDay(b - 1), "2026-10-29");
  assert.equal(istDay(b), "2026-10-30");
  assert.equal(istDayRange("29-10-2026"), null);
});

test("admin creates staff; usernames are unique and checked", async () => {
  await withServer(async ({ call, store }) => {
    let r = await call("/production-users", { method: "POST", token: ADMIN, body: { username: "Ravi.K", name: "Ravi Kumar", password: "line1-pass" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, "ravi.k", "lower-cased");
    assert.equal(r.body.user.createdBy, "owner@farmbuddie.com");
    assert.ok(!store.users.get("ravi.k").passwordHash.includes("line1-pass"), "password stored hashed");
    r = await call("/production-users", { method: "POST", token: ADMIN, body: { username: "RAVI.K", name: "Other", password: "something1" } });
    assert.equal(r.status, 409, "same username in other case: taken");
    for (const username of ["ab", "1abc", "a b c", "x@y.com", ""]) {
      r = await call("/production-users", { method: "POST", token: ADMIN, body: { username, name: "N", password: "longenough" } });
      assert.equal(r.status, 400, `username "${username}" refused`);
    }
    r = await call("/production-users", { method: "POST", token: ADMIN, body: { username: "meena", name: "Meena", password: "short" } });
    assert.equal(r.status, 400, "short password refused");
    r = await call("/production-users", { method: "POST", token: ADMIN, body: { username: "meena", name: "", password: "longenough" } });
    assert.equal(r.status, 400, "name required");
    r = await call("/production-users", { token: ADMIN });
    assert.equal(r.body.users.length, 1);
  });
});

test("staff sign in, reach only /production, and only see their own entries", async () => {
  await withServer(async ({ call }) => {
    await call("/production-users", { method: "POST", token: ADMIN, body: { username: "ravi", name: "Ravi", password: "line1-pass" } });
    await call("/production-users", { method: "POST", token: ADMIN, body: { username: "meena", name: "Meena", password: "line2-pass" } });
    let r = await call("/production/login", { method: "POST", body: { username: "ravi", password: "wrong-pass" } });
    assert.equal(r.status, 401);
    r = await call("/production/login", { method: "POST", body: { username: " RAVI ", password: "line1-pass" } });
    assert.equal(r.status, 200);
    const ravi = r.body.token;
    assert.ok(ravi.startsWith(PROD_TOKEN_PREFIX));
    const meena = (await call("/production/login", { method: "POST", body: { username: "meena", password: "line2-pass" } })).body.token;

    r = await call("/production/me", { token: ravi });
    assert.equal(r.body.role, "staff");
    assert.equal(r.body.username, "ravi");

    assert.equal((await call("/farmers", { token: ravi })).status, 403, "staff token can't reach other routes");
    assert.equal((await call("/production-users", { token: ravi })).status, 403, "staff can't manage users");
    assert.equal((await call("/production/me", { token: "farmer" })).status, 403, "a farmer login can't use production");

    r = await call("/production/controllers", { method: "POST", token: ravi, body: GOOD });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.controller.createdBy, { type: "staff", id: "ravi", name: "Ravi" });
    assert.equal(r.body.controller.uniqueId, "0007");
    r = await call("/production/controllers", { method: "POST", token: meena,
      body: { ...GOOD, serialNumber: "IRRIGO26AA10002", uniqueId: "0008", imeiNumber: "356938035643809", simMsisdn: "", simNumber: "", simImsi: "" } });
    assert.equal(r.status, 201);
    r = await call("/production/controllers", { method: "POST", token: ADMIN,
      body: { ...GOOD, variant: "IRRIGO_PLUS", serialNumber: "IRRIGOPLUS26PP1", uniqueId: "0009", imeiNumber: "353918052512345", simMsisdn: "", simNumber: "", simImsi: "" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.controller.createdBy.type, "admin");
    assert.equal(r.body.controller.createdBy.id, "owner@farmbuddie.com");

    r = await call("/production/entries", { token: ravi });
    assert.deepEqual(r.body.entries.map((e) => e.uniqueId), ["0007"], "staff: own entries only");
    r = await call("/production/entries?by=meena", { token: ravi });
    assert.deepEqual(r.body.entries.map((e) => e.uniqueId), ["0007"], "staff can't look at someone else's");
    r = await call("/production/entries", { token: ADMIN });
    assert.equal(r.body.entries.length, 3, "admin: everyone's");
    r = await call("/production/entries?by=meena", { token: ADMIN });
    assert.deepEqual(r.body.entries.map((e) => e.uniqueId), ["0008"]);
    r = await call("/production/entries?day=2026-10-28", { token: ADMIN });
    assert.equal(r.body.entries.length, 0, "another day");

    r = await call("/production/summary", { token: ravi });
    assert.equal(r.body.mineToday, 1);
    assert.equal(r.body.teamToday, 3);
    assert.equal(r.body.byVariant.IRRIGO, 2);
    assert.equal(r.body.byVariant.IRRIGO_PLUS, 1);
    assert.equal(r.body.nextUniqueId, "0010");
    assert.equal(r.body.days.length, 7);
    assert.equal(r.body.days[6].count, 3);

    r = await call("/production-users", { token: ADMIN });
    assert.deepEqual(r.body.users.map((u) => [u.username, u.entries]), [["ravi", 1], ["meena", 1]]);

    r = await call("/production/logout", { method: "POST", token: ravi });
    assert.equal((await call("/production/me", { token: ravi })).status, 401, "signed out");
  });
});

test("nothing duplicated: every unique field, and two saves at the same moment", async () => {
  await withServer(async ({ call }) => {
    await call("/production-users", { method: "POST", token: ADMIN, body: { username: "ravi", name: "Ravi", password: "line1-pass" } });
    const tok = (await call("/production/login", { method: "POST", body: { username: "ravi", password: "line1-pass" } })).body.token;
    assert.equal((await call("/production/controllers", { method: "POST", token: tok, body: GOOD })).status, 201);
    const other = { variant: "IRRIGO", serialNumber: "NEWSERIAL01", uniqueId: "0100", imeiNumber: "356938035643809", simMsisdn: "5754000000099", simNumber: "8991940912940339999", simImsi: "404000000000099" };
    for (const [field, value] of [["serialNumber", GOOD.serialNumber], ["uniqueId", "0007"], ["imeiNumber", GOOD.imeiNumber],
      ["simMsisdn", GOOD.simMsisdn], ["simNumber", GOOD.simNumber], ["simImsi", GOOD.simImsi]]) {
      const r = await call("/production/controllers", { method: "POST", token: tok, body: { ...other, [field]: value } });
      assert.equal(r.status, 409, `${field} reused: refused`);
      assert.equal(r.body.clashes[0].field, field);
    }
    let r = await call("/production/check", { method: "POST", token: tok, body: { ...other, imeiNumber: GOOD.imeiNumber } });
    assert.deepEqual(r.body.clashes.map((c) => c.field), ["imeiNumber"], "live check names the clash");
    assert.equal(r.body.clashes[0].uniqueId, "0007");
    r = await call("/production/check", { method: "POST", token: tok, body: { ...other, uniqueId: "12" } });
    assert.deepEqual(r.body.clashes, []);
    assert.equal(r.body.values.uniqueId, "0012");
    r = await call("/production/controllers", { method: "POST", token: tok, body: { ...other, imeiNumber: "123" } });
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.imeiNumber);

    const same = { ...other, serialNumber: "RACE0001", uniqueId: "0200", imeiNumber: "353918052599999", simMsisdn: "", simNumber: "", simImsi: "" };
    const both = await Promise.all([
      call("/production/controllers", { method: "POST", token: tok, body: same }),
      call("/production/controllers", { method: "POST", token: ADMIN, body: same })
    ]);
    assert.deepEqual(both.map((x) => x.status).sort(), [201, 409], "the same controller saved twice at once: one wins");
  });
});

test("admin changes a password; switches a user off; lockout after wrong passwords", async () => {
  await withServer(async ({ call, advance }) => {
    await call("/production-users", { method: "POST", token: ADMIN, body: { username: "ravi", name: "Ravi", password: "line1-pass" } });
    const old = (await call("/production/login", { method: "POST", body: { username: "ravi", password: "line1-pass" } })).body.token;
    let r = await call("/production-users/ravi/password", { method: "POST", token: ADMIN, body: { password: "new-pass-22" } });
    assert.equal(r.status, 200);
    assert.equal((await call("/production/me", { token: old })).status, 401, "old session ended");
    assert.equal((await call("/production/login", { method: "POST", body: { username: "ravi", password: "line1-pass" } })).status, 401);
    const tok = (await call("/production/login", { method: "POST", body: { username: "ravi", password: "new-pass-22" } })).body.token;
    assert.ok(tok);
    assert.equal((await call("/production-users/nobody/password", { method: "POST", token: ADMIN, body: { password: "whatever12" } })).status, 404);

    await call("/production-users/ravi/active", { method: "POST", token: ADMIN, body: { active: false } });
    assert.equal((await call("/production/me", { token: tok })).status, 401, "switched off: signed out");
    r = await call("/production/login", { method: "POST", body: { username: "ravi", password: "new-pass-22" } });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /switched off/);
    await call("/production-users/ravi/active", { method: "POST", token: ADMIN, body: { active: true } });

    for (let i = 0; i < 8; i++) await call("/production/login", { method: "POST", body: { username: "ravi", password: "guess-" + i } });
    r = await call("/production/login", { method: "POST", body: { username: "ravi", password: "new-pass-22" } });
    assert.equal(r.status, 429, "locked after 8 wrong passwords");
    advance(16 * 60 * 1000);
    assert.equal((await call("/production/login", { method: "POST", body: { username: "ravi", password: "new-pass-22" } })).status, 200, "unlocked after 15 min");
  });
});
