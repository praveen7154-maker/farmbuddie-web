import crypto from "node:crypto";
import express from "express";
import { OTA_SIGNING_PUBLIC_KEY_PEM } from "./otaSigningKey.js";
import { unitsForProduct } from "./farmUnits.js";
import { isAdmin } from "../adminAuth.js";

// Web-panel OTA (admin panel > OTA). The admin uploads a firmware.bin, signs
// the release IN THE BROWSER with the fleet key (public/js/ota-crypto.js -
// the private key never reaches this server), and this module:
//   - stores the .bin (Postgres) and serves it at a public HTTPS URL the
//     hubs download from (they verify it against the signed SHA-256),
//   - checks the signature, then publishes the same "ota_start" command
//     tools/ota_admin.py sends - per farm, or the fleet broadcast topic,
//   - records every hub's farm/<id>/<node>/ota/status reply against the
//     release, for the page's live progress table and summary.
//
// Node images (motor-node / valve / filter-backwash) go the same way to the
// chosen farms' hubs as "node_ota_start": the hub downloads and stages the
// image, then hands it to its nodes over mesh/LoRa/RS485 (Motor repo's
// node_ota_server.h). Each node's progress comes back on the hub's
// ota/status with a "node" field and is kept per node.
//
// Everything is injected (store, publish, fleet list) so it can be tested
// without Postgres/MQTT/Firestore - see createOtaModule().

export const OTA_BROADCAST_TOPIC = "motor/ota/broadcast";
// ESP32 app slot (min_spiffs partitions: 2 x 1.875 MB). Anything bigger can't
// be flashed. A hub still on the old 2 x 1.25 MB table refuses an image too big
// for it on its own (Update.begin fails) and reports the OTA as failed.
export const MAX_FIRMWARE_BYTES = 1966080;
const ESP_IMAGE_MAGIC = 0xe9;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FARM_RE = /^\d{1,6}$/;
// Hub states from the firmware's OtaManager::publishStatus() - plus, for a
// node image, "downloaded"/"staged" (the hub has it and is handing it out).
const ACTIVE_STATES = new Set(["starting", "downloading", "verifying", "flashing", "downloaded"]);
const BUSY_ERRORS = new Set(["pump_running", "already_in_progress", "hub_slot_busy"]);

export const PRODUCTS = ["hub", "motor-node", "valve", "filter-backwash"];
export const isNodeProduct = (p) => PRODUCTS.includes(p) && p !== "hub";
const PRODUCT_NAMES = { "motor-node": "motor node", valve: "valve unit", "filter-backwash": "filter backwash node" };

// Every image says which device it is for (FW_PRODUCT_MARKER in each repo's
// config.h): "FARMBUDDIE-FW-PRODUCT=<product>;". The signature only proves
// the admin released the file, not that the right file was picked - a
// motor-node image flashed onto a hub would leave the hub running the wrong
// program until someone flashes it by USB. Same parsing as the hub's
// ProductLabelScanner (Motor repo, ota_manager.cpp) and public/js/ota.js.
const LABEL_PREFIX = Buffer.from("FARMBUDDIE-FW-PRODUCT=");
export function productLabels(data) {
  const found = new Set();
  for (let i = data.indexOf(LABEL_PREFIX); i >= 0; i = data.indexOf(LABEL_PREFIX, i + 1)) {
    let j = i + LABEL_PREFIX.length;
    let value = "";
    while (j < data.length && value.length <= 24) {
      const c = data[j];
      if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d) { value += String.fromCharCode(c); j++; }
      else break;
    }
    if (value.length >= 1 && value.length <= 24 && data[j] === 0x3b) found.add(value);
  }
  return [...found];
}

// Must match the firmware byte for byte: v1 = the hub's OtaManager, v2 (node
// images, binds the product) = the node repos' NodeOta.
export function otaManifest(sha256, size, version, product = "hub") {
  if (isNodeProduct(product)) return `farmbuddie-ota-v2\n${product}\n${sha256.toLowerCase()}\n${size}\n${version}`;
  return `farmbuddie-ota-v1\n${sha256.toLowerCase()}\n${size}\n${version}`;
}

export function verifyReleaseSignature(sha256, size, version, signatureB64, publicKeyPem = OTA_SIGNING_PUBLIC_KEY_PEM,
                                       product = "hub") {
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(otaManifest(sha256, size, version, product)),
      { key: publicKeyPem, dsaEncoding: "der" },
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

// A hub gives up on a download after 20 min (Motor firmware,
// OTA_GSM_HARD_TIMEOUT_MS) and restarts, so one still "in progress" with no
// word for this long never got its result through - shown as no reply, so
// it can be resent.
export const NO_REPLY_MS = 30 * 60 * 1000;

// How a target row reads on the page / in the summary.
export function outcomeOf(target, nowMs = Date.now()) {
  const { state, error } = target;
  if (state === "validated" || state === "staged") return "updated";
  if (state === "failed" && BUSY_ERRORS.has(error)) return "busy";
  if (state === "failed" || state === "rolled_back") return "failed";
  if (ACTIVE_STATES.has(state)) {
    const at = target.updatedAt ? new Date(target.updatedAt).getTime() : NaN;
    return Number.isFinite(at) && nowMs - at > NO_REPLY_MS ? "waiting" : "in_progress";
  }
  return "waiting"; // sent, no reply yet - hub offline, or a GSM download in progress
}

export function summarize(targets) {
  const s = { total: targets.length, updated: 0, in_progress: 0, waiting: 0, busy: 0, failed: 0 };
  for (const t of targets) s[outcomeOf(t)]++;
  return s;
}

// A node's row: states from the nodes' NodeOtaLink (via the hub).
//   receiving / installed (waiting for the hub's go-ahead to reboot) -> in progress
//   validated (new firmware confirmed) / current (was already on it)  -> updated
export function nodeOutcomeOf(node) {
  const { state } = node;
  if (state === "validated" || state === "current") return "updated";
  if (state === "failed" || state === "rolled_back") return "failed";
  if (state === "receiving" || state === "installed") return "in_progress";
  return "waiting";
}

export function summarizeNodes(nodes) {
  const s = { total: nodes.length, updated: 0, in_progress: 0, waiting: 0, busy: 0, failed: 0 };
  for (const n of nodes) s[nodeOutcomeOf(n)]++;
  return s;
}

export function createOtaModule({ store, publish, listFleet, publicBaseUrl, publicKeyPem = OTA_SIGNING_PUBLIC_KEY_PEM, now = () => new Date() }) {
  const firmwareUrl = (sha256) => `${publicBaseUrl}/ota/firmware/${sha256}.bin`;

  function startPayload(release, size) {
    const node = isNodeProduct(release.product);
    return {
      cmd: node ? "node_ota_start" : "ota_start",
      ...(node ? { product: release.product } : {}),
      id: Date.now(),
      url: release.url,
      version: release.version,
      sha256: release.sha256,
      size,
      sig: release.signature
    };
  }

  async function sendToFarms(release, size, targets) {
    const payload = startPayload(release, size);
    for (const t of targets) {
      await publish(`farm/${t.farmId}/${t.nodeId}/ota/cmd`, payload);
    }
  }

  // ---- public: hubs download here (no login - the signed SHA-256 is the check) ----
  const publicRouter = express.Router();
  publicRouter.get("/:file", async (req, res) => {
    const m = /^([0-9a-f]{64})\.bin$/.exec(req.params.file);
    if (!m) return res.status(404).end();
    try {
      const data = await store.getFirmwareData(m[1]);
      if (!data) return res.status(404).end();
      // Content-Length, no chunked encoding - the hub's GSM downloader needs it.
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=31536000, immutable"
      });
      return res.end(data);
    } catch (err) {
      console.error("[ota] firmware download failed:", err);
      return res.status(500).end();
    }
  });

  // ---- admin (mounted behind verifyFirebaseToken) ----
  const adminRouter = express.Router();
  adminRouter.use((req, res, next) => {
    if (!isAdmin(req.decodedToken)) return res.status(403).json({ error: "Admin identity required" });
    next();
  });

  adminRouter.get("/config", async (req, res) => {
    try {
      const fleet = await listFleet();
      return res.json({ publicKeyPem, maxFirmwareBytes: MAX_FIRMWARE_BYTES, farms: fleet });
    } catch (err) {
      console.error("[ota] config failed:", err);
      return res.status(500).json({ error: "Failed to load the fleet" });
    }
  });

  adminRouter.post("/firmware", express.raw({ type: "application/octet-stream", limit: "2mb" }), async (req, res) => {
    const version = String(req.get("X-Firmware-Version") || "");
    const product = String(req.get("X-Firmware-Product") || "hub");
    const data = req.body;
    if (!VERSION_RE.test(version)) return res.status(400).json({ error: "Version must be 1-32 letters/digits/._-" });
    if (!PRODUCTS.includes(product)) return res.status(400).json({ error: `Unknown product "${product}"` });
    if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: "Empty upload - send the .bin as application/octet-stream" });
    // A node image is staged in the hub's spare app slot, so the same limit applies.
    if (data.length > MAX_FIRMWARE_BYTES) return res.status(400).json({ error: `Firmware is ${data.length} bytes - more than the hub's ${MAX_FIRMWARE_BYTES}-byte app slot` });
    if (data[0] !== ESP_IMAGE_MAGIC) return res.status(400).json({ error: "Not an ESP32 firmware image - choose .pio/build/esp32dev/firmware.bin" });
    const labels = productLabels(data);
    if (labels.length === 0) {
      return res.status(400).json({ error: "This firmware doesn't say which device it is for - rebuild it from the current repo" });
    }
    if (labels.length > 1 || labels[0] !== product) {
      return res.status(400).json({ error: `This file is ${labels.join(" + ")} firmware, not ${product} - pick the right file or the right type` });
    }
    if (!data.includes(Buffer.from(publicKeyPem))) {
      return res.status(400).json({
        error: "This firmware doesn't contain the fleet's OTA public key (include/ota_signing_key.h). Devices running it would refuse every later update - rebuild from the current repo."
      });
    }
    try {
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      await store.saveFirmware({ sha256, version, product, size: data.length, data, uploadedBy: req.decodedToken.email });
      return res.json({ sha256, size: data.length, version, product, url: firmwareUrl(sha256) });
    } catch (err) {
      console.error("[ota] firmware save failed:", err);
      return res.status(500).json({ error: "Failed to store the firmware" });
    }
  });

  adminRouter.post("/releases", express.json(), async (req, res) => {
    const { sha256, version, signature, target } = req.body || {};
    const product = String(req.body?.product || "hub");
    if (!SHA_RE.test(String(sha256)) || !VERSION_RE.test(String(version)) || typeof signature !== "string") {
      return res.status(400).json({ error: "sha256, version and signature are required" });
    }
    try {
      const fw = await store.getFirmwareMeta(sha256);
      if (!fw) return res.status(404).json({ error: "Upload the firmware first" });
      if (fw.version !== version) return res.status(409).json({ error: `That file was uploaded as version ${fw.version}, not ${version}` });
      if ((fw.product || "hub") !== product) {
        return res.status(409).json({ error: `That file was uploaded as a ${fw.product || "hub"} image, not ${product}` });
      }
      if (!verifyReleaseSignature(sha256, fw.size, version, signature, publicKeyPem, product)) {
        return res.status(400).json({ error: "Signature doesn't verify against the devices' key - wrong .pem?" });
      }

      const fleet = await listFleet();
      const all = target === "all";
      // Each hub downloads, stages and restarts for a node image - only to
      // the farms picked, never the whole fleet at once.
      if (all && isNodeProduct(product)) {
        return res.status(400).json({ error: "Node updates go to selected farms only" });
      }
      let targets;
      if (all) {
        targets = fleet;
      } else {
        const ids = Array.isArray(target?.farmIds) ? [...new Set(target.farmIds.map(String))] : [];
        if (ids.length === 0 || ids.some((id) => !FARM_RE.test(id))) {
          return res.status(400).json({ error: "target must be \"all\" or { farmIds: [...] }" });
        }
        const byId = new Map(fleet.map((f) => [f.farmId, f]));
        const unknown = ids.filter((id) => !byId.has(id));
        if (unknown.length) return res.status(400).json({ error: `Unknown farm(s): ${unknown.join(", ")}` });
        targets = ids.map((id) => byId.get(id));
      }
      if (targets.length === 0) return res.status(400).json({ error: "No farms to update" });
      // A node image only goes to farms that have that kind of unit -
      // otherwise the hub downloads it, restarts and offers it to nobody.
      if (isNodeProduct(product)) {
        const without = targets.filter((t) => t.units && unitsForProduct(t.units, product) === 0).map((t) => t.farmId);
        if (without.length) {
          return res.status(400).json({ error: `Farm(s) ${without.join(", ")} have no ${PRODUCT_NAMES[product]} - untick them` });
        }
      }

      const release = {
        sha256, version, signature, product, url: firmwareUrl(sha256),
        mode: all ? "all" : "farms", createdBy: req.decodedToken.email
      };
      const releaseId = await store.createRelease(release, targets.map((t) => ({ farmId: t.farmId, nodeId: t.nodeId })), now());

      if (all) {
        await publish(OTA_BROADCAST_TOPIC, startPayload(release, fw.size));
      } else {
        await sendToFarms(release, fw.size, targets);
      }
      console.log(`[ota] release ${releaseId}: v${version} -> ${all ? "ALL" : targets.map((t) => t.farmId).join(",")} by ${req.decodedToken.email}`);
      return res.json({ releaseId, targets: targets.length });
    } catch (err) {
      console.error("[ota] release failed:", err);
      return res.status(500).json({ error: "Failed to send the release" });
    }
  });

  adminRouter.get("/releases", async (req, res) => {
    try {
      // ?page=1.. (10 per page), ?product=hub|motor-node|valve|filter-backwash, ?q=search
      const pageSize = 10;
      const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
      const product = PRODUCTS.includes(String(req.query.product)) ? String(req.query.product) : null;
      const q = String(req.query.q || "").trim().slice(0, 64) || null;
      const [releases, total] = await Promise.all([
        store.listReleases(pageSize, (page - 1) * pageSize, product, q),
        store.countReleases ? store.countReleases(product, q) : null
      ]);
      return res.json({
        page, pageSize, total,
        releases: releases.map((r) => ({
          ...r.release,
          summary: summarize(r.targets),
          ...(isNodeProduct(r.release.product) ? { nodeSummary: summarizeNodes(r.nodes || []) } : {})
        }))
      });
    } catch (err) {
      console.error("[ota] list failed:", err);
      return res.status(500).json({ error: "Failed to list releases" });
    }
  });

  adminRouter.get("/releases/:id", async (req, res) => {
    try {
      const r = await store.getRelease(Number(req.params.id));
      if (!r) return res.status(404).json({ error: "No such release" });
      const nodes = r.nodes || [];
      return res.json({
        release: r.release,
        summary: summarize(r.targets),
        targets: r.targets.map((t) => ({ ...t, outcome: outcomeOf(t) })),
        ...(isNodeProduct(r.release.product)
          ? { nodeSummary: summarizeNodes(nodes), nodes: nodes.map((n) => ({ ...n, outcome: nodeOutcomeOf(n) })) }
          : {})
      });
    } catch (err) {
      console.error("[ota] get failed:", err);
      return res.status(500).json({ error: "Failed to load the release" });
    }
  });

  // Deletes history records: { ids: [..] } (up to 500 at a time). A hub
  // still busy with one keeps going; its later reports just have no row to
  // land on, and a download of a .bin no release uses any more fails
  // harmlessly (the hub stays on what it runs).
  adminRouter.post("/releases/delete", express.json(), async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number))] : [];
    if (ids.length === 0 || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ error: "ids must be 1-500 release numbers" });
    }
    try {
      const deleted = await store.deleteReleases(ids);
      console.log(`[ota] ${deleted} release(s) deleted by ${req.decodedToken.email}: ${ids.join(",")}`);
      return res.json({ deleted });
    } catch (err) {
      console.error("[ota] delete failed:", err);
      return res.status(500).json({ error: "Failed to delete" });
    }
  });

  // Stops a node release: each of its hubs is told to stop handing the
  // image out (node_ota_cancel - Motor firmware, NodeOtaServer::cancel()).
  // Units already updated stay updated; ones part-way through keep the
  // firmware they run. A hub offline right now doesn't hear it - pressing
  // Stop again sends it again. Farms sent a newer node release since are
  // skipped: the hub holds one node image at a time, and the stop would
  // end that newer one instead.
  adminRouter.post("/releases/:id/stop", async (req, res) => {
    try {
      const r = await store.getRelease(Number(req.params.id));
      if (!r) return res.status(404).json({ error: "No such release" });
      if (!isNodeProduct(r.release.product)) {
        return res.status(400).json({ error: "A hub update can't be stopped once sent - a bad image is refused or rolled back by the hub itself" });
      }
      const farmIds = [...new Set(r.targets.map((t) => t.farmId))];
      const newer = new Set(await store.farmsWithNewerNodeRelease(r.release.id, farmIds));
      const targets = r.targets.filter((t) => !newer.has(t.farmId));
      for (const t of targets) {
        await publish(`farm/${t.farmId}/${t.nodeId}/ota/cmd`, { cmd: "node_ota_cancel", id: Date.now() });
      }
      await store.markStopped(r.release.id, req.decodedToken.email, now());
      console.log(`[ota] release ${r.release.id} stopped by ${req.decodedToken.email} -> ${targets.map((t) => t.farmId).join(",") || "none"}`);
      return res.json({ stopped: targets.length, skipped: [...newer] });
    } catch (err) {
      console.error("[ota] stop failed:", err);
      return res.status(500).json({ error: "Failed to stop" });
    }
  });

  // Re-sends to every hub of the release that isn't updated yet (or just the
  // farmIds given) - busy (motor was running), failed or no reply.
  adminRouter.post("/releases/:id/retry", express.json(), async (req, res) => {
    try {
      const r = await store.getRelease(Number(req.params.id));
      if (!r) return res.status(404).json({ error: "No such release" });
      if (r.release.stoppedAt) return res.status(409).json({ error: "This release was stopped - send a new one instead" });
      const only = Array.isArray(req.body?.farmIds) ? new Set(req.body.farmIds.map(String)) : null;
      const targets = r.targets.filter((t) =>
        outcomeOf(t) !== "updated" && outcomeOf(t) !== "in_progress" && (!only || only.has(t.farmId)));
      if (targets.length === 0) return res.json({ resent: 0 });
      const fw = await store.getFirmwareMeta(r.release.sha256);
      if (!fw) return res.status(410).json({ error: "That firmware file is no longer stored - upload it again" });
      await store.markSent(r.release.id, targets.map((t) => t.farmId), now());
      await sendToFarms(r.release, fw.size, targets);
      return res.json({ resent: targets.length });
    } catch (err) {
      console.error("[ota] retry failed:", err);
      return res.status(500).json({ error: "Failed to resend" });
    }
  });

  // Called for every farm/<id>/<node>/ota/status message the bridge receives.
  async function handleOtaStatus(farmId, payload) {
    if (!payload || payload.type !== "ota_status" || typeof payload.state !== "string") return;
    try {
      if (typeof payload.node === "string" && payload.node && payload.node !== "hub") {
        await store.recordNodeStatus(farmId, payload, now());   // one node's progress on a node image
      } else {
        await store.recordStatus(farmId, payload, now());       // the hub's own update, or its staging step
      }
    } catch (err) {
      console.error("[ota] status record failed:", err);
    }
  }

  return { publicRouter, adminRouter, handleOtaStatus };
}
