import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAdminGateModule } from "../src/bridge/adminGate.js";

async function withServer(fn) {
  let row = null;
  const store = {
    async get() { return row; },
    async set(codeHash, updatedBy) { row = { codeHash, updatedBy, updatedAt: new Date() }; }
  };
  let t = 1_000_000;
  const mod = createAdminGateModule({ store, now: () => t });
  const app = express();
  app.use("/admin-gate", mod.publicRouter);
  app.use((req, res, next) => {
    if (req.headers.authorization !== "Bearer admin") return res.status(403).json({ error: "no" });
    req.decodedToken = { email: "boss@farmbuddie.in" };
    next();
  });
  app.use("/admin-gate", mod.adminRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, admin } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer admin" } : {}) },
      body: body && JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ call, store, tick: (ms) => { t += ms; }, row: () => row }); } finally { server.close(); }
}

test("no code set: status false, check passes", async () => {
  await withServer(async ({ call }) => {
    assert.deepEqual((await call("/admin-gate/status")).body, { set: false });
    const r = await call("/admin-gate/check", { method: "POST", body: { code: "482915" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.set, false);
  });
});

test("only admins set the code; weak and malformed codes refused", async () => {
  await withServer(async ({ call, row }) => {
    assert.equal((await call("/admin-gate", { method: "PUT", body: { newCode: "482915" } })).status, 403);
    for (const bad of ["12345", "1234567", "abcdef", "111111", "123456", "654321"]) {
      assert.equal((await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: bad } })).status, 400, bad);
    }
    assert.equal((await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: "482915" } })).status, 200);
    assert.ok(row().codeHash.startsWith("scrypt$"));
    assert.ok(!row().codeHash.includes("482915"));
    const info = (await call("/admin-gate", { admin: true })).body;
    assert.equal(info.set, true);
    assert.equal(info.updatedBy, "boss@farmbuddie.in");
  });
});

test("check accepts the right code, refuses a wrong one", async () => {
  await withServer(async ({ call }) => {
    await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: "482915" } });
    assert.deepEqual((await call("/admin-gate/status")).body, { set: true });
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "000001" } })).status, 401);
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "4829" } })).status, 400);
    const ok = await call("/admin-gate/check", { method: "POST", body: { code: "482915" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.set, true);
  });
});

test("changing the code needs the current one", async () => {
  await withServer(async ({ call }) => {
    await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: "482915" } });
    assert.equal((await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: "730264" } })).status, 401);
    assert.equal((await call("/admin-gate", { method: "PUT", admin: true, body: { currentCode: "000001", newCode: "730264" } })).status, 401);
    assert.equal((await call("/admin-gate", { method: "PUT", admin: true, body: { currentCode: "482915", newCode: "730264" } })).status, 200);
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "482915" } })).status, 401);
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "730264" } })).status, 200);
  });
});

test("five wrong codes lock the address for 15 minutes", async () => {
  await withServer(async ({ call, tick }) => {
    await call("/admin-gate", { method: "PUT", admin: true, body: { newCode: "482915" } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "000001" } })).status, 401);
    }
    // Locked - even the right code waits.
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "482915" } })).status, 429);
    tick(15 * 60 * 1000 + 1);
    assert.equal((await call("/admin-gate/check", { method: "POST", body: { code: "482915" } })).status, 200);
  });
});
