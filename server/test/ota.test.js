// node --test server/test  (from the repo root) - web OTA, hub and node images.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import {
  createOtaModule, productLabels, otaManifest, verifyReleaseSignature, nodeOutcomeOf, summarizeNodes, outcomeOf,
  imageChip, boardChip, maxFirmwareBytes, CHIP_ESP32, CHIP_ESP32S3, MAX_FIRMWARE_BYTES, MAX_FIRMWARE_BYTES_S3,
  OTA_BROADCAST_TOPIC, parseByteRange
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
  // A GSM download with no word for over 30 min: the hub gave up long ago.
  const now = Date.parse("2026-10-12T12:00:00Z");
  assert.equal(outcomeOf({ state: "starting", updatedAt: "2026-10-12T11:40:00Z" }, now), "in_progress");
  assert.equal(outcomeOf({ state: "starting", updatedAt: "2026-10-12T11:00:00Z" }, now), "waiting");
});

test("history records can be deleted, and searched", async () => {
  const seen = [];
  const ota = createOtaModule({
    store: {
      async deleteReleases(ids) { seen.push(ids); return ids.filter((id) => id < 10).length; },
      async listReleases(limit, offset, product, q) { seen.push({ product, q }); return []; },
      async countReleases() { return 0; }
    },
    publish: async () => {}, listFleet: async () => [], publicBaseUrl: "https://example.test", publicKeyPem: PUB_PEM
  });
  const app = express();
  app.use((req, _res, next) => { req.decodedToken = { email: "admin@test" }; next(); });
  app.use("/ota", ota.adminRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/ota`;
    const del = (body) => fetch(`${base}/releases/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal((await del({ ids: [] })).status, 400);
    assert.equal((await del({ ids: [0] })).status, 400);
    const ok = await del({ ids: [3, 3, 12] });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).deleted, 1);
    assert.deepEqual(seen[0], [3, 12]);
    await fetch(`${base}/releases?q=%200001%20&product=hub`);
    assert.deepEqual(seen[1], { product: "hub", q: "0001" });
  } finally {
    server.close();
  }
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

const DEFAULT_FLEET = [
  { farmId: "1", nodeId: "MOTOR_1", online: true, units: { motorNodes: 2, valves: 0, backwash: 0 } },
  { farmId: "2", nodeId: "MOTOR_1", online: true, units: { motorNodes: 0, valves: 3, backwash: 0 } }
];

async function withServer(fn, fleet = DEFAULT_FLEET) {
  const store = fakeStore();
  const published = [];
  const ota = createOtaModule({
    store,
    publish: async (topic, payload) => published.push({ topic, payload }),
    listFleet: async () => fleet,
    publicBaseUrl: "https://example.test",
    publicKeyPem: PUB_PEM
  });
  const app = express();
  app.use("/ota/firmware", ota.publicRouter);   // no login - as in server.js
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

function fakeImage(product = "hub", size = 4096, chip = CHIP_ESP32) {
  const data = Buffer.alloc(size, 0x11);
  data[0] = 0xe9;
  data.writeUInt16LE(chip, 12);   // esp_image_header_t chip id
  Buffer.from(PUB_PEM).copy(data, 100);
  if (product) Buffer.from(`FARMBUDDIE-FW-PRODUCT=${product};`).copy(data, 3000);
  return data;
}

test("productLabels reads the image's device label", () => {
  // A hub image also holds the bare prefix its own scanner searches for.
  const hub = Buffer.concat([Buffer.from("xxFARMBUDDIE-FW-PRODUCT=\0yyFARMBUDDIE-FW-PRODUCT=hub;\0")]);
  assert.deepEqual(productLabels(hub), ["hub"]);
  assert.deepEqual(productLabels(Buffer.from("FARMBUDDIE-FW-PRODUCT=motor-node;")), ["motor-node"]);
  assert.deepEqual(productLabels(Buffer.from("FARMBUDDIE-FW-PRODUCT=Hub;")), []);
  assert.deepEqual(productLabels(Buffer.from("nothing here")), []);
});

test("an image labelled for another device, or not labelled, is refused", async () => {
  await withServer(async ({ base, store }) => {
    const upload = (data, product) => fetch(`${base}/firmware`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.4", ...(product ? { "X-Firmware-Product": product } : {}) },
      body: data
    });
    const wrong = await upload(fakeImage("motor-node"));           // sent as a hub image
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /motor-node firmware, not hub/);
    assert.equal((await upload(fakeImage("hub"), "valve")).status, 400);
    assert.equal((await upload(fakeImage(null))).status, 400);
    assert.equal((await upload(fakeImage("motor-node"), "motor-node")).status, 200);
  });
});

test("a valve image goes to the chosen farms' hubs as node_ota_start", async () => {
  await withServer(async ({ base, store, published }) => {
    const data = fakeImage("valve");
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

    // Not to a farm without a valve unit - its hub would fetch it for nobody.
    const none = await post({ sha256: up.sha256, version: "1.0.2", signature: sig, product: "valve", target: { farmIds: ["1", "2"] } });
    assert.equal(none.status, 400);
    assert.match((await none.json()).error, /Farm\(s\) 1 have no valve unit/);
    assert.equal(published.length, 0);

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

test("history is paged 10 at a time and filtered by product", async () => {
  const seen = [];
  const ota = createOtaModule({
    store: {
      async listReleases(limit, offset, product) { seen.push({ limit, offset, product }); return []; },
      async countReleases(product) { return product ? 3 : 25; }
    },
    publish: async () => {}, listFleet: async () => [], publicBaseUrl: "https://example.test", publicKeyPem: PUB_PEM
  });
  const app = express();
  app.use((req, _res, next) => { req.decodedToken = { email: "admin@test" }; next(); });
  app.use("/ota", ota.adminRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/ota`;
    const a = await (await fetch(`${base}/releases?page=3`)).json();
    assert.deepEqual({ page: a.page, pageSize: a.pageSize, total: a.total }, { page: 3, pageSize: 10, total: 25 });
    const b = await (await fetch(`${base}/releases?product=valve`)).json();
    assert.equal(b.total, 3);
    await fetch(`${base}/releases?product=bogus`);
    assert.deepEqual(seen, [
      { limit: 10, offset: 20, product: null },
      { limit: 10, offset: 0, product: "valve" },
      { limit: 10, offset: 0, product: null }
    ]);
  } finally {
    server.close();
  }
});

test("stop: a node release's hubs are told to stop handing it out, except farms with a newer one", async () => {
  const published = [];
  const stopped = [];
  const rel = (id, product) => ({
    release: { id, product, version: "1.0.2", sha256: "a".repeat(64) },
    targets: [{ farmId: "0001", nodeId: "MOTOR_1", state: "staged" }, { farmId: "0002", nodeId: "MOTOR_1", state: "staged" }]
  });
  const ota = createOtaModule({
    store: {
      async getRelease(id) { return id === 8 ? rel(8, "motor-node") : id === 9 ? rel(9, "hub") : null; },
      async farmsWithNewerNodeRelease() { return ["0002"]; },
      async markStopped(id, by) { stopped.push({ id, by }); },
      async getFirmwareMeta() { return { size: 1 }; }
    },
    publish: async (topic, payload) => published.push({ topic, payload }),
    listFleet: async () => [], publicBaseUrl: "https://example.test", publicKeyPem: PUB_PEM
  });
  const app = express();
  app.use((req, _res, next) => { req.decodedToken = { email: "admin@test" }; next(); });
  app.use("/ota", ota.adminRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/ota`;
    const post = (path) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await post("/releases/9/stop")).status, 400);    // a hub update can't be stopped
    assert.equal((await post("/releases/7/stop")).status, 404);
    const r = await post("/releases/8/stop");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { stopped: 1, skipped: ["0002"] });
    assert.deepEqual(published.map((p) => [p.topic, p.payload.cmd]), [["farm/0001/MOTOR_1/ota/cmd", "node_ota_cancel"]]);
    assert.deepEqual(stopped, [{ id: 8, by: "admin@test" }]);
  } finally {
    server.close();
  }
});

test("chip of an image, chip of a hub's board, and the slot size for each", () => {
  assert.equal(imageChip(fakeImage("hub", 4096, CHIP_ESP32S3)), CHIP_ESP32S3);
  assert.equal(imageChip(fakeImage("hub")), CHIP_ESP32);
  assert.equal(imageChip(Buffer.alloc(4)), -1);
  assert.equal(boardChip("v2-s3"), CHIP_ESP32S3);
  assert.equal(boardChip("v1"), CHIP_ESP32);
  assert.equal(boardChip(null), null);
  assert.equal(boardChip("constructor"), null);
  assert.equal(maxFirmwareBytes("hub", CHIP_ESP32S3), MAX_FIRMWARE_BYTES_S3);
  assert.equal(maxFirmwareBytes("hub", CHIP_ESP32), MAX_FIRMWARE_BYTES);
  assert.equal(maxFirmwareBytes("valve", CHIP_ESP32S3), MAX_FIRMWARE_BYTES);   // staged in a V1 hub's slot too
});

test("upload: a hub image's chip and size are checked against the board it is for", async () => {
  await withServer(async ({ base }) => {
    const upload = (data, product = "hub") => fetch(`${base}/firmware`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.5", "X-Firmware-Product": product },
      body: data
    });
    const big = 2500000;   // over a V1 slot, under a V2 slot
    const s3 = await upload(fakeImage("hub", big, CHIP_ESP32S3));
    assert.equal(s3.status, 200);
    assert.equal((await s3.json()).chip, CHIP_ESP32S3);
    assert.equal((await upload(fakeImage("hub", big, CHIP_ESP32))).status, 400);
    assert.equal((await upload(fakeImage("valve", big), "valve")).status, 400);
    const odd = await upload(fakeImage("hub", 4096, 5));
    assert.equal(odd.status, 400);
    assert.match((await odd.json()).error, /chip no hub has/);
  });
});

test("a hub image goes only to hubs with its board", async () => {
  const fleet = [
    { farmId: "1", nodeId: "MOTOR_1", online: true, board: "v1" },
    { farmId: "2", nodeId: "MOTOR_1", online: true, board: "v2-s3" },
    { farmId: "3", nodeId: "MOTOR_1", online: true, board: null }   // older firmware - board unknown
  ];
  await withServer(async ({ base, published, store }) => {
    const up = await (await fetch(`${base}/firmware`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.6" },
      body: fakeImage("hub", 4096, CHIP_ESP32S3)
    })).json();
    const key = await loadSigningKey(PRIV_PEM, "");
    const sig = await signRelease(key, PUB_PEM, up.sha256, up.size, "1.0.6");
    const post = (target) => fetch(`${base}/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: up.sha256, version: "1.0.6", signature: sig, target })
    });

    // Picking a V1 hub for a V2 image is an error, before anything is sent.
    const bad = await post({ farmIds: ["1", "2"] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Farm\(s\) 1 have a V1 board \(ESP32\) hub - this image is for the V2 board/);
    assert.equal(published.length, 0);

    // "All": the V1 hub is skipped, so it goes farm by farm, not on the broadcast every hub hears.
    const all = await post("all");
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { releaseId: 1, targets: 2, skipped: ["1"] });
    assert.deepEqual(published.map((p) => p.topic), ["farm/2/MOTOR_1/ota/cmd", "farm/3/MOTOR_1/ota/cmd"]);
    assert.deepEqual(store.releases[0].targets.map((t) => t.farmId), ["2", "3"]);
  }, fleet);
});

test("\"all\" still uses the broadcast when every hub can run the image", async () => {
  const fleet = [
    { farmId: "2", nodeId: "MOTOR_1", online: true, board: "v2-s3" },
    { farmId: "3", nodeId: "MOTOR_1", online: true, board: null }
  ];
  await withServer(async ({ base, published }) => {
    const up = await (await fetch(`${base}/firmware`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.7" },
      body: fakeImage("hub", 4096, CHIP_ESP32S3)
    })).json();
    const key = await loadSigningKey(PRIV_PEM, "");
    const sig = await signRelease(key, PUB_PEM, up.sha256, up.size, "1.0.7");
    const res = await fetch(`${base}/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: up.sha256, version: "1.0.7", signature: sig, target: "all" })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(published.map((p) => p.topic), [OTA_BROADCAST_TOPIC]);
  }, fleet);
});

test("parseByteRange reads one byte range", () => {
  assert.equal(parseByteRange(undefined, 100), null);
  assert.deepEqual(parseByteRange("bytes=40-", 100), { start: 40, end: 99 });
  assert.deepEqual(parseByteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 100), "unsatisfiable");
  // can't be parsed, or more than one range: the whole file
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseByteRange("bytes=9-3", 100), null);
  assert.equal(parseByteRange("items=0-5", 100), null);
  assert.equal(parseByteRange("bytes=-", 100), null);
});

test("a hub resuming a cut-off download gets just the rest of the image", async () => {
  await withServer(async ({ base }) => {
    const data = fakeImage("hub", 4096);
    for (let i = 400; i < 2900; i++) data[i] = i & 0xff;   // varied bytes, clear of the key and the label
    const up = await (await fetch(`${base}/firmware`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": "1.0.8" },
      body: data
    })).json();
    const url = `${base}/firmware/${up.sha256}.bin`;

    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("content-length"), "4096");
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), data);

    const rest = await fetch(url, { headers: { Range: "bytes=1000-" } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get("content-range"), "bytes 1000-4095/4096");
    assert.equal(rest.headers.get("content-length"), "3096");
    assert.deepEqual(Buffer.from(await rest.arrayBuffer()), data.subarray(1000));

    const past = await fetch(url, { headers: { Range: "bytes=4096-" } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), "bytes */4096");
    await past.arrayBuffer();

    const many = await fetch(url, { headers: { Range: "bytes=0-1,5-6" } });
    assert.equal(many.status, 200);
    assert.deepEqual(Buffer.from(await many.arrayBuffer()), data);

    const missing = await fetch(`${base}/firmware/${"cd".repeat(32)}.bin`, { headers: { Range: "bytes=10-" } });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });
});
