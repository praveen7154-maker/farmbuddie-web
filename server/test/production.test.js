import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createProductionModule, checkFields, imeiCheckDigitOk, istDayRange, istDay, PROD_TOKEN_PREFIX, UNIQUE_FIELDS,
  NODE_TYPES, nodeStem
} from "../src/bridge/production.js";
import { NODE_TYPES as WEB_NODE_TYPES } from "../../public/js/node-types.js";

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
  const sims = new Map();
  return {
    docs,
    sims,
    clashes,
    async create(doc) {
      let sim = null;
      if (doc.simNumber) {
        sim = sims.get(doc.simNumber);
        if (!sim) throw Object.assign(new Error("sim"), { simError: "This SIM isn't in the SIM inventory - upload it first" });
        if (sim.status === "assigned") throw Object.assign(new Error("sim"), { simError: `This SIM is already on controller ${sim.uniqueId}` });
        doc = { ...doc, simMsisdn: sim.msisdn, simImsi: sim.imsi };
      }
      const c = await clashes(doc);
      await new Promise((r) => setTimeout(r, 20));
      if (c.length) throw Object.assign(new Error("clash"), { clashes: c });
      const id = `c${++n}`;
      docs.push({ ...doc, id, createdAtMs: clock() });
      if (sim) Object.assign(sim, { status: "assigned", controllerId: id, uniqueId: doc.uniqueId });
      return { id, doc };
    },
    async simInventory() { return [...sims.values()].map((x) => ({ ...x })); },
    async usedSimNumbers() { return new Map(docs.filter((d) => d.simNumber).map((d) => [d.simNumber, { controllerId: d.id, uniqueId: d.uniqueId }])); },
    async markSimAssigned(iccid, u) { Object.assign(sims.get(iccid), { status: "assigned", ...u }); },
    async addSims(rows) {
      const added = [], existing = [];
      for (const r of rows) {
        if (sims.has(r.iccid)) { existing.push(r.iccid); continue; }
        sims.set(r.iccid, { iccid: r.iccid, msisdn: r.msisdn, imsi: r.imsi, status: r.usedBy ? "assigned" : "available", uniqueId: r.usedBy?.uniqueId || null });
        added.push(r.iccid);
      }
      return { added, existing };
    },
    async list({ from, to, createdById = null }) {
      return docs.filter((d) => d.createdAtMs >= from && d.createdAtMs < to && (!createdById || d.createdBy?.id === createdById));
    },
    async countBy(id) { return docs.filter((d) => d.createdBy?.id === id).length; },
    async lastSerials() {
      const out = {};
      for (const d of [...docs].reverse()) if (!out[d.variant]) out[d.variant] = d.serialNumber;
      return out;
    },
    async nextUniqueId() {
      const ids = docs.map((d) => Number(d.uniqueId)).filter(Number.isFinite);
      return String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
    }
  };
}

// The nodes collection; createMany() reads the last number, waits, then
// writes - NOT atomic on its own, like fakeControllers().
function fakeNodes(clock) {
  const docs = [];
  return {
    docs,
    async createMany({ stem, count, doc }) {
      const used = docs.filter((d) => d.serialNumber.startsWith(stem)).map((d) => Number(d.serialNumber.slice(stem.length)));
      const last = used.length ? Math.max(...used) : 10000;
      await new Promise((r) => setTimeout(r, 20));
      if (last + count > 99999) throw Object.assign(new Error("full"), { full: true });
      const out = [];
      for (let i = 1; i <= count; i++) {
        const serialNumber = stem + (last + i);
        if (docs.some((d) => d.id === serialNumber)) throw new Error("ALREADY_EXISTS " + serialNumber);
        docs.push({ ...doc, id: serialNumber, serialNumber, createdAtMs: clock() });
        out.push({ ...doc, id: serialNumber, serialNumber });
      }
      return out;
    },
    async nextNumbers(stems) {
      return Object.fromEntries(stems.map((stem) => {
        const used = docs.filter((d) => d.serialNumber.startsWith(stem)).map((d) => Number(d.serialNumber.slice(stem.length)));
        return [stem, (used.length ? Math.max(...used) : 10000) + 1];
      }));
    },
    async list({ from, to, createdById = null }) {
      return docs.filter((d) => d.createdAtMs >= from && d.createdAtMs < to && (!createdById || d.createdBy?.id === createdById));
    },
    async countBy(id) { return docs.filter((d) => d.createdBy?.id === id).length; },
    async stock() {
      return Object.fromEntries(NODE_TYPES.map(({ type }) => {
        const all = docs.filter((d) => d.type === type);
        const available = all.filter((d) => d.status === "available").length;
        return [type, { available, assigned: all.length - available, total: all.length }];
      }));
    }
  };
}

const NOW = Date.UTC(2026, 9, 29, 6, 30);   // 29 Oct 2026, 12:00 IST

async function withServer(fn) {
  let t = NOW;
  const clock = () => t;
  const store = fakeStore();
  const controllers = fakeControllers(clock);
  const nodes = fakeNodes(clock);
  const mod = createProductionModule({ store, controllers, nodes, now: clock });
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
    await fn({ call, store, controllers, nodes, advance: (ms) => { t += ms; } });
  } finally {
    server.close();
  }
}

const ADMIN = "admin:owner@farmbuddie.com";
// As in the operator's CSV: ICCID / IMSI with a leading ' (Excel guard).
const SIMS = Array.from({ length: 6 }, (_, i) => ({ msisdn: `57541826998${40 + i}`, iccid: `'89919409129403337${60 + i}`, imsi: `'4049409403337${60 + i}` }));
const ICCID = (i) => `89919409129403337${60 + i}`;
const uploadSims = (call, token = ADMIN) => call("/production/sims", { method: "POST", token, body: { rows: SIMS, fileName: "sims.csv" } });
const GOOD = { variant: "IRRIGO", serialNumber: "irrigo26aa10001", uniqueId: "7", imeiNumber: "490154203237518", simMsisdn: "", simNumber: "8991940912940333760", simImsi: "" };

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
    assert.equal((await uploadSims(call, ravi)).status, 200, "staff can upload the SIM list too");

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
      body: { ...GOOD, serialNumber: "IRRIGO26AA10002", uniqueId: "0008", imeiNumber: "356938035643809", simNumber: ICCID(1) } });
    assert.equal(r.status, 201);
    r = await call("/production/controllers", { method: "POST", token: ADMIN,
      body: { ...GOOD, variant: "IRRIGO_PLUS", serialNumber: "IRRIGOPLUS26PP1", uniqueId: "0009", imeiNumber: "353918052512345", simNumber: ICCID(2) } });
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
    assert.deepEqual(r.body.lastSerials, { IRRIGO: "IRRIGO26AA10002", IRRIGO_PLUS: "IRRIGOPLUS26PP1" }, "newest serial per variant");
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
    await uploadSims(call);
    assert.equal((await call("/production/controllers", { method: "POST", token: tok, body: GOOD })).status, 201);
    const other = { variant: "IRRIGO", serialNumber: "NEWSERIAL01", uniqueId: "0100", imeiNumber: "356938035643809", simNumber: ICCID(3) };
    for (const [field, value] of [["serialNumber", GOOD.serialNumber], ["uniqueId", "0007"], ["imeiNumber", GOOD.imeiNumber]]) {
      const r = await call("/production/controllers", { method: "POST", token: tok, body: { ...other, [field]: value } });
      assert.equal(r.status, 409, `${field} reused: refused`);
      assert.equal(r.body.clashes[0].field, field);
    }
    let s = await call("/production/controllers", { method: "POST", token: tok, body: { ...other, simNumber: GOOD.simNumber } });
    assert.equal(s.status, 409, "SIM already on a controller: refused");
    assert.match(s.body.error, /already on controller 0007/);
    let r = await call("/production/check", { method: "POST", token: tok, body: { ...other, imeiNumber: GOOD.imeiNumber } });
    assert.deepEqual(r.body.clashes.map((c) => c.field), ["imeiNumber"], "live check names the clash");
    assert.equal(r.body.clashes[0].uniqueId, "0007");
    r = await call("/production/check", { method: "POST", token: tok, body: { ...other, uniqueId: "12" } });
    assert.deepEqual(r.body.clashes, []);
    assert.equal(r.body.values.uniqueId, "0012");
    r = await call("/production/controllers", { method: "POST", token: tok, body: { ...other, imeiNumber: "123" } });
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.imeiNumber);

    const same = { ...other, serialNumber: "RACE0001", uniqueId: "0200", imeiNumber: "353918052599999", simNumber: ICCID(4) };
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

test("SIM inventory: upload, the dropdown list, SIM details only from the inventory", async () => {
  await withServer(async ({ call, controllers }) => {
    let r = await call("/production/sims", { method: "POST", token: ADMIN, body: { fileName: "x.csv", rows: [
      ...SIMS,
      { msisdn: "123", iccid: "'8991940912940333799", imsi: "'404940940333799" },          // bad MSISDN
      { msisdn: "5754182699999", iccid: "12345", imsi: "'404940940333798" },                  // bad ICCID
      { msisdn: SIMS[0].msisdn, iccid: SIMS[0].iccid, imsi: SIMS[0].imsi }                    // twice in the file
    ] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 6);
    assert.equal(r.body.invalidCount, 3);
    assert.equal(r.body.counts.available, 6);
    assert.equal(controllers.sims.get(ICCID(0)).iccid, ICCID(0), "the ' from the CSV is dropped");
    r = await call("/production/sims", { method: "POST", token: ADMIN, body: { rows: SIMS } });
    assert.deepEqual([r.body.added, r.body.existing], [0, 6], "uploading the same list again adds nothing");

    // the page sends a typed MSISDN / IMSI: ignored - the inventory's are stored
    r = await call("/production/controllers", { method: "POST", token: ADMIN, body: { ...GOOD, simNumber: ICCID(0), simMsisdn: "99999999", simImsi: "111111111111111" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.controller.simMsisdn, "5754182699840");
    assert.equal(r.body.controller.simImsi, "404940940333760");
    r = await call("/production/sims", { token: ADMIN });
    assert.equal(r.body.counts.available, 5, "used SIM left the list");
    assert.equal(r.body.counts.assigned, 1);
    assert.ok(!r.body.available.some((x) => x.iccid === ICCID(0)));

    r = await call("/production/controllers", { method: "POST", token: ADMIN, body: { ...GOOD, serialNumber: "S2", uniqueId: "0011", imeiNumber: "356938035643809", simNumber: "" } });
    assert.equal(r.status, 400, "no SIM chosen: refused");
    assert.ok(r.body.problems.simNumber);
    r = await call("/production/controllers", { method: "POST", token: ADMIN, body: { ...GOOD, serialNumber: "SERIAL0003", uniqueId: "0012", imeiNumber: "353918052512345", simNumber: "8991940912940339999" } });
    assert.equal(r.status, 409, "a SIM not in the inventory: refused");
    assert.match(r.body.error, /isn't in the SIM inventory/);

    // a controller made by the Excel upload with an inventory SIM: that SIM leaves the list too
    controllers.docs.push({ id: "x1", uniqueId: "0500", simNumber: ICCID(5), createdAtMs: 0 });
    r = await call("/production/sims", { token: ADMIN });
    assert.ok(!r.body.available.some((x) => x.iccid === ICCID(5)));
    assert.equal(r.body.counts.available, 4);
    assert.equal(controllers.sims.get(ICCID(5)).status, "assigned", "and is marked assigned");
  });
});

test("node serials: prefix, year where the type has one, running number from 10001", () => {
  assert.equal(nodeStem("MOTOR", NOW), "FBMN26");
  assert.equal(nodeStem("SOLENOID_VALVE", NOW), "FBSVN");
  assert.equal(nodeStem("BUTTERFLY_VALVE", NOW), "FBBVN");
  assert.equal(nodeStem("WATER_LEVEL", NOW), "FBWL26");
  assert.equal(nodeStem("MOTOR", Date.UTC(2026, 11, 31, 19, 0)), "FBMN27", "1 Jan 2027 00:30 IST is 2027");
  assert.equal(nodeStem("NOPE", NOW), null);
  assert.deepEqual(WEB_NODE_TYPES.map(({ type, name, prefix, year }) => ({ type, name, prefix, year })), NODE_TYPES,
    "public/js/node-types.js has the same table");
});

test("nodes: made in a batch, next serial shown, no serial twice, own entries for staff", async () => {
  await withServer(async ({ call, nodes, advance }) => {
    await call("/production-users", { method: "POST", token: ADMIN, body: { username: "ravi", name: "Ravi", password: "line1-pass" } });
    const ravi = (await call("/production/login", { method: "POST", body: { username: "ravi", password: "line1-pass" } })).body.token;

    let r = await call("/production/me", { token: ravi });
    assert.deepEqual(r.body.nodeTypes.map((t) => t.type), NODE_TYPES.map((t) => t.type));
    r = await call("/production/summary?kind=node", { token: ravi });
    assert.equal(r.body.nextSerials.MOTOR, "FBMN2610001");
    assert.equal(r.body.nextSerials.SOLENOID_VALVE, "FBSVN10001");
    assert.equal(r.body.stock.MOTOR.total, 0);

    r = await call("/production/nodes", { method: "POST", token: ravi, body: { type: "MOTOR" } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.nodes.map((n) => n.serialNumber), ["FBMN2610001"]);
    assert.deepEqual(r.body.nodes[0].createdBy, { type: "staff", id: "ravi", name: "Ravi" });
    assert.equal(r.body.nodes[0].status, "available");
    assert.equal(r.body.nextSerials.MOTOR, "FBMN2610002", "the next one, for the form");
    r = await call("/production/nodes", { method: "POST", token: ADMIN, body: { type: "solenoid_valve", count: 3 } });
    assert.deepEqual(r.body.nodes.map((n) => n.serialNumber), ["FBSVN10001", "FBSVN10002", "FBSVN10003"]);

    for (const body of [{ type: "PUMP" }, { type: "MOTOR", count: 0 }, { type: "MOTOR", count: 51 }, { type: "MOTOR", count: 2.5 }]) {
      r = await call("/production/nodes", { method: "POST", token: ravi, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }

    // two people saving at the same moment: different serials
    const both = await Promise.all([
      call("/production/nodes", { method: "POST", token: ravi, body: { type: "MOTOR", count: 2 } }),
      call("/production/nodes", { method: "POST", token: ADMIN, body: { type: "MOTOR", count: 2 } })
    ]);
    assert.deepEqual(both.map((x) => x.status), [201, 201]);
    const serials = both.flatMap((x) => x.body.nodes.map((n) => n.serialNumber));
    assert.equal(new Set(serials).size, 4, "no serial given twice");
    assert.deepEqual(serials.sort(), ["FBMN2610002", "FBMN2610003", "FBMN2610004", "FBMN2610005"]);

    r = await call("/production/entries?kind=node", { token: ravi });
    assert.equal(r.body.kind, "node");
    assert.equal(r.body.entries.length, 3, "staff: own nodes only");
    assert.ok(r.body.entries.every((e) => e.createdBy.id === "ravi"));
    r = await call("/production/entries?kind=node", { token: ADMIN });
    assert.equal(r.body.entries.length, 8);
    r = await call("/production/entries", { token: ADMIN });
    assert.equal(r.body.entries.length, 0, "controllers' entries don't list nodes");

    nodes.docs.find((d) => d.id === "FBSVN10002").status = "assigned";
    r = await call("/production/summary?kind=node", { token: ravi });
    assert.equal(r.body.mineToday, 3);
    assert.equal(r.body.teamToday, 8);
    assert.equal(r.body.byType.MOTOR, 5);
    assert.equal(r.body.byType.SOLENOID_VALVE, 3);
    assert.equal(r.body.days[6].count, 8);
    assert.deepEqual(r.body.stock.SOLENOID_VALVE, { available: 2, assigned: 1, total: 3 });
    assert.deepEqual((await call("/production/nodes/stock", { token: ravi })).body.stock.MOTOR, { available: 5, assigned: 0, total: 5 });
    r = await call("/production-users", { token: ADMIN });
    assert.deepEqual(r.body.users.map((u) => [u.username, u.entries, u.nodeEntries]), [["ravi", 0, 3]]);

    // a new year: the types with a year start again at 10001, valves go on
    advance(70 * 24 * 3600 * 1000);
    r = await call("/production/nodes", { method: "POST", token: ravi, body: { type: "MOTOR" } });
    assert.equal(r.body.nodes[0].serialNumber, "FBMN2710001");
    r = await call("/production/nodes", { method: "POST", token: ravi, body: { type: "SOLENOID_VALVE" } });
    assert.equal(r.body.nodes[0].serialNumber, "FBSVN10004");
  });
});
