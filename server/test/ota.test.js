// node --test server/test  (from the repo root) - web OTA, hub and node images.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import {
  createOtaModule, otaManifest, verifyReleaseSignature, nodeOutcomeOf, summarizeNodes, outcomeOf
} from "../src/bridge/ota.js";
import { loadSigningKey, signRelease, otaManifest as browserManifest } from "../../public/js/ota-crypto.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" });

const SHA = "ab".repeat(32);

test("manifests match the firmware byte for byte", () => {
  // Motor repo OtaManager::otaManifest() (hub) and the node repos' NodeOta manifest().
  assert.equal(otaManifest(SHA, 1234, "1.0.2"), `farmbuddie-ota-v1\n${SHA}\n1234\n1.0.2`);
  assert.equal(otaManifest(SHA, 1234, "1.0.2", "valve"), `farmbuddie-ota-v2\nvalve\n${SHA}\n1234\n1.0.2`);
  assert.equal(browserManifest(SHA, 1234, "1.0.2", "motor-node"), otaManifest(SHA, 1234, "1.0.2", "motor-node"));
  assert.equal(browserManifest(SHA, 1234, "1.0.2"), otaManifest(SHA, 1234, "1.0.2"));
});

test("a node image signed in the browser verifies on the server - only for its own product", async () => {
  const key = await loadSigningKey(PRIV_PEM, "");
  const sig = await signRelease(key, PUB_PEM, SHA, 1644112, "1.0.2", "valve");
  assert.ok(verifyReleaseSignature(SHA, 1644112, "1.0.2", sig, PUB_PEM, "valve"));
  assert.ok(!verifyReleaseSignature(SHA, 1644112, "1.0.2", sig, PUB_PEM, "motor-node"));
  assert.ok(!verifyReleaseSignature(SHA, 1644112, "1.0.2", sig, PUB_PEM, "hub"));
});

test("node outcomes", () => {
  assert.equal(nodeOutcomeOf({ state: "receiving" }), "in_progress");
  assert.equal(nodeOutcomeOf({ state: "installed" }), "in_progress");
  assert.equal(nodeOutcomeOf({ state: "validated" }), "updated");
  assert.equal(nodeOutcomeOf({ state: "current" }), "updated");
  assert.equal(nodeOutcomeOf({ state: "rolled_back" }), "failed");
  assert.deepEqual(summarizeNodes([{ state: "validated" }, { state: "receiving" }, { state: "failed" }]),
    { total: 3, updated: 1, in_progress: 1, waiting: 0, busy: 0, failed: 1 });
  assert.equal(outcomeOf({ state: "staged" }), "updated");        // hub has it and is handing it out
  assert.equal(outcomeOf({ state: "downloaded" }), "in_progress");
  assert.equal(outcomeOf({ state: "failed", error: "hub_slot_busy" }), "busy");
});

function fakeStore() {
  const fw = new Map();
  const releases = [];
  const calls = { status: [], nodeStatus: [] };
  return {
    calls, releases,
    async saveFirmware(f) { fw.set(f.sha256, f); },
    async getFirmwareMeta(sha) { const f = fw.get(sha); return f && { sha256: f.sha256, version: f.version, product: f.product, size: f.size }; },
    async getFirmwareData(sha) { return fw.get(sha)?.data || null; },
    async createRelease(release, targets) { releases.push({ release, targets }); return releases.length; },
    async recordStatus(farmId, payload) { calls.status.push({ farmId, payload }); },
    async recordNodeStatus(farmId, payload) { calls.nodeStatus.push({ farmId, payload }); }
  };
}

async function withServer(fn) {
  const store = fakeStore();
  const published = [];
  const ota = createOtaModule({
    store,
    publish: async (topic, payload) => published.push({ topic, payload }),
    listFleet: async () => [{ farmId: "1", nodeId: "MOTOR_1", online: true }, { farmId: "2", nodeId: "MOTOR_1", online: true }],
    publicBaseUrl: "https://example.test",
    publicKeyPem: PUB_PEM
  });
  const app = express();
  app.use((req, _res, next) => { req.decodedToken = { email: "admin@test" }; next(); });
  app.use("/ota", ota.adminRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/ota`;
  try {
    await fn({ base, store, published, ota });
  } finally {
    server.close();
  }
}

function fakeImage(size = 4096) {
  const data = Buffer.alloc(size, 0x11);
  data[0] = 0xe9;
  Buffer.from(PUB_PEM).copy(data, 100);
  return data;
}

test("a valve image goes to the chosen farms' hubs as node_ota_start", async () => {
  await withServer(async ({ base, store, published }) => {
    const data = fakeImage();
    const up = await (await fetch(`${base}/firmware`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.2", "X-Firmware-Product": "valve" },
      body: data
    })).json();
    assert.equal(up.product, "valve");

    const key = await loadSigningKey(PRIV_PEM, "");
    const sig = await signRelease(key, PUB_PEM, up.sha256, up.size, "1.0.2", "valve");
    const post = (body) => fetch(`${base}/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });

    // Never fleet-wide for a node image.
    assert.equal((await post({ sha256: up.sha256, version: "1.0.2", signature: sig, product: "valve", target: "all" })).status, 400);
    // Product must match what was uploaded.
    assert.equal((await post({ sha256: up.sha256, version: "1.0.2", signature: sig, product: "motor-node", target: { farmIds: ["1"] } })).status, 409);
    // A hub-style (v1) signature doesn't pass for a node image.
    const hubSig = await signRelease(key, PUB_PEM, up.sha256, up.size, "1.0.2", "hub");
    assert.equal((await post({ sha256: up.sha256, version: "1.0.2", signature: hubSig, product: "valve", target: { farmIds: ["1"] } })).status, 400);

    const ok = await post({ sha256: up.sha256, version: "1.0.2", signature: sig, product: "valve", target: { farmIds: ["2"] } });
    assert.equal(ok.status, 200);
    assert.equal(published.length, 1);
    assert.equal(published[0].topic, "farm/2/MOTOR_1/ota/cmd");
    assert.equal(published[0].payload.cmd, "node_ota_start");
    assert.equal(published[0].payload.product, "valve");
    assert.equal(published[0].payload.sig, sig);
    assert.equal(store.releases[0].release.product, "valve");
  });
});

test("a hub image still goes out as ota_start", async () => {
  await withServer(async ({ base, published }) => {
    const data = fakeImage();
    const up = await (await fetch(`${base}/firmware`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.3" }, body: data
    })).json();
    const key = await loadSigningKey(PRIV_PEM, "");
    const sig = await signRelease(key, PUB_PEM, up.sha256, up.size, "1.0.3");
    const res = await fetch(`${base}/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: up.sha256, version: "1.0.3", signature: sig, target: { farmIds: ["1"] } })
    });
    assert.equal(res.status, 200);
    assert.equal(published[0].payload.cmd, "ota_start");
    assert.equal(published[0].payload.product, undefined);
  });
});

test("status messages are routed to the hub row or the node rows", async () => {
  await withServer(async ({ store, ota }) => {
    await ota.handleOtaStatus("2", { type: "ota_status", state: "staged", node: "hub", product: "valve", version: "1.0.2" });
    await ota.handleOtaStatus("2", { type: "ota_status", state: "receiving", node: "V1-4", product: "valve", percent: 40 });
    await ota.handleOtaStatus("2", { type: "ota_status", state: "validated", version: "1.0.3" });
    assert.equal(store.calls.status.length, 2);
    assert.equal(store.calls.nodeStatus.length, 1);
    assert.equal(store.calls.nodeStatus[0].payload.node, "V1-4");
  });
});
