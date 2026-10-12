import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createDistributorModule, hashPassword, passwordMatches, TOKEN_PREFIX } from "../src/bridge/distributors.js";

function fakeStore() {
  const accounts = new Map();
  const sessions = new Map();
  return {
    accounts, sessions,
    async getAccount(id) { return accounts.get(id) || null; },
    async setPassword(id, passwordHash, mustChange) { accounts.set(id, { passwordHash, mustChange }); },
    async deleteAccount(id) { accounts.delete(id); },
    async createSession(h, id, expiresAt) { sessions.set(h, { distributorId: id, expiresAt }); },
    async getSession(h) { return sessions.get(h) || null; },
    async deleteSession(h) { sessions.delete(h); },
    async deleteSessions(id, except = null) { for (const [h, s] of sessions) if (s.distributorId === id && h !== except) sessions.delete(h); }
  };
}

const DISTRIBUTORS = { "FB-DIST-0001": { name: "Ravi Agencies", status: "active" }, "FB-DIST-0002": { name: "Old Co", status: "inactive" } };

async function withServer(fn) {
  const store = fakeStore();
  const mod = createDistributorModule({
    store,
    findDistributor: async (id) => (DISTRIBUTORS[id] ? { distributorId: id, ...DISTRIBUTORS[id] } : null),
    distributorFarms: async (id) => (id === "FB-DIST-0001" ? [{ farmId: "0001", farmerName: "A", phones: ["9000000001"] }] : []),
    loadReferrals: async () => [
      { id: "r1", referrerPhone: "+919000000001", createdAtMs: 1 },
      { id: "r2", referrerPhone: "+919999999999", createdAtMs: 2 }
    ],
    loadRedemptions: async () => [{ id: "b1", referrerPhone: "+919000000001", amountInr: 500 }]
  });
  const app = express();
  app.use("/distributor", mod.publicRouter);
  // The server's verifyCaller, reduced to the distributor case.
  app.use(async (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const who = await mod.authenticate(token);
    if (!who) return res.status(401).json({ error: "signed out" });
    if (who.mustChange && !["/distributor/me", "/distributor/password", "/distributor/logout"].includes(req.path)) {
      return res.status(403).json({ code: "password_change_required" });
    }
    req.decodedToken = who;
    next();
  });
  app.use("/distributor", mod.router);
  app.get("/anything", (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, token } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    await fn({ call, store });
  } finally {
    server.close();
  }
}

test("passwords hash and verify", async () => {
  const h = await hashPassword("secret-123");
  assert.ok(await passwordMatches("secret-123", h));
  assert.ok(!(await passwordMatches("secret-124", h)));
  assert.ok(!(await passwordMatches("x", "garbage")));
});

test("first login with the ID, must set a password before anything else", async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "nope" } })).status, 401);
    const first = await call("/distributor/login", { method: "POST", body: { distributorId: " fb-dist-0001 ", password: "FB-DIST-0001" } });
    assert.equal(first.status, 200);
    assert.equal(first.body.mustChange, true);
    assert.ok(first.body.token.startsWith(TOKEN_PREFIX));
    const t = first.body.token;
    assert.equal((await call("/anything", { token: t })).status, 403);              // locked until changed
    assert.equal((await call("/distributor/me", { token: t })).body.mustChange, true);
    // Rules for the new password.
    const pw = (newPassword, currentPassword = "FB-DIST-0001") => call("/distributor/password", { method: "POST", token: t, body: { currentPassword, newPassword } });
    assert.equal((await pw("short")).status, 400);
    assert.equal((await pw("fb-dist-0001")).status, 400);
    assert.equal((await pw("goodpass123", "wrong")).status, 401);
    assert.equal((await pw("goodpass123")).status, 200);
    assert.equal((await call("/anything", { token: t })).status, 200);              // same session goes on
    // The ID no longer works as a password; the new one does.
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "FB-DIST-0001" } })).status, 401);
    const again = await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "goodpass123" } });
    assert.equal(again.body.mustChange, false);
  });
});

test("unknown or inactive distributors can't sign in; logout ends the session", async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0002", password: "FB-DIST-0002" } })).status, 401);
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0009", password: "FB-DIST-0009" } })).status, 401);
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "admin", password: "x" } })).status, 400);
    const t = (await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "FB-DIST-0001" } })).body.token;
    assert.equal((await call("/distributor/logout", { method: "POST", token: t })).status, 200);
    assert.equal((await call("/distributor/me", { token: t })).status, 401);
    assert.equal((await call("/distributor/me", { token: "fbd_made-up" })).status, 401);
  });
});

test("too many wrong passwords lock that ID for a while", async () => {
  await withServer(async ({ call }) => {
    for (let i = 0; i < 10; i++) {
      await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "wrong" } });
    }
    assert.equal((await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "FB-DIST-0001" } })).status, 429);
  });
});

test("referrals and redemptions: only this distributor's farmers'", async () => {
  await withServer(async ({ call, store }) => {
    const t = (await call("/distributor/login", { method: "POST", body: { distributorId: "FB-DIST-0001", password: "FB-DIST-0001" } })).body.token;
    await call("/distributor/password", { method: "POST", token: t, body: { currentPassword: "FB-DIST-0001", newPassword: "goodpass123" } });
    assert.deepEqual((await call("/distributor/referrals", { token: t })).body.referrals.map((r) => r.id), ["r1"]);
    assert.deepEqual((await call("/distributor/redemptions", { token: t })).body.redemptions.map((r) => r.id), ["b1"]);
    assert.equal(store.accounts.get("FB-DIST-0001").mustChange, false);
  });
});
