import crypto from "node:crypto";
import express from "express";
import { OTA_SIGNING_PUBLIC_KEY_PEM } from "./otaSigningKey.js";

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
// Everything is injected (store, publish, fleet list) so it can be tested
// without Postgres/MQTT/Firestore - see createOtaModule().

export const OTA_BROADCAST_TOPIC = "motor/ota/broadcast";
// ESP32 app slot (partitions: 2 x 1.25 MB). Anything bigger can't be flashed.
export const MAX_FIRMWARE_BYTES = 1310720;
const ESP_IMAGE_MAGIC = 0xe9;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FARM_RE = /^\d{1,6}$/;
// Hub states from the firmware's OtaManager::publishStatus().
const ACTIVE_STATES = new Set(["starting", "downloading", "verifying", "flashing"]);
const BUSY_ERRORS = new Set(["pump_running", "already_in_progress"]);

export function otaManifest(sha256, size, version) {
  return `farmbuddie-ota-v1\n${sha256.toLowerCase()}\n${size}\n${version}`;
}

export function verifyReleaseSignature(sha256, size, version, signatureB64, publicKeyPem = OTA_SIGNING_PUBLIC_KEY_PEM) {
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(otaManifest(sha256, size, version)),
      { key: publicKeyPem, dsaEncoding: "der" },
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

// How a target row reads on the page / in the summary.
export function outcomeOf(target) {
  const { state, error } = target;
  if (state === "validated") return "updated";
  if (state === "failed" && BUSY_ERRORS.has(error)) return "busy";
  if (state === "failed" || state === "rolled_back") return "failed";
  if (ACTIVE_STATES.has(state)) return "in_progress";
  return "waiting"; // sent, no reply yet - hub offline, or a GSM download in progress
}

export function summarize(targets) {
  const s = { total: targets.length, updated: 0, in_progress: 0, waiting: 0, busy: 0, failed: 0 };
  for (const t of targets) s[outcomeOf(t)]++;
  return s;
}

export function createOtaModule({ store, publish, listFleet, publicBaseUrl, publicKeyPem = OTA_SIGNING_PUBLIC_KEY_PEM, now = () => new Date() }) {
  const firmwareUrl = (sha256) => `${publicBaseUrl}/ota/firmware/${sha256}.bin`;

  function startPayload(release, size) {
    return {
      cmd: "ota_start",
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
    if (!req.decodedToken?.email) return res.status(403).json({ error: "Admin identity required" });
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
    const data = req.body;
    if (!VERSION_RE.test(version)) return res.status(400).json({ error: "Version must be 1-32 letters/digits/._-" });
    if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: "Empty upload - send the .bin as application/octet-stream" });
    if (data.length > MAX_FIRMWARE_BYTES) return res.status(400).json({ error: `Firmware is ${data.length} bytes - more than the hub's ${MAX_FIRMWARE_BYTES}-byte app slot` });
    if (data[0] !== ESP_IMAGE_MAGIC) return res.status(400).json({ error: "Not an ESP32 firmware image - choose .pio/build/esp32dev/firmware.bin" });
    if (!data.includes(Buffer.from(publicKeyPem))) {
      return res.status(400).json({
        error: "This firmware doesn't contain the fleet's OTA public key (include/ota_signing_key.h). Hubs running it would refuse every later update - rebuild from the current Motor repo."
      });
    }
    try {
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      await store.saveFirmware({ sha256, version, size: data.length, data, uploadedBy: req.decodedToken.email });
      return res.json({ sha256, size: data.length, version, url: firmwareUrl(sha256) });
    } catch (err) {
      console.error("[ota] firmware save failed:", err);
      return res.status(500).json({ error: "Failed to store the firmware" });
    }
  });

  adminRouter.post("/releases", express.json(), async (req, res) => {
    const { sha256, version, signature, target } = req.body || {};
    if (!SHA_RE.test(String(sha256)) || !VERSION_RE.test(String(version)) || typeof signature !== "string") {
      return res.status(400).json({ error: "sha256, version and signature are required" });
    }
    try {
      const fw = await store.getFirmwareMeta(sha256);
      if (!fw) return res.status(404).json({ error: "Upload the firmware first" });
      if (fw.version !== version) return res.status(409).json({ error: `That file was uploaded as version ${fw.version}, not ${version}` });
      if (!verifyReleaseSignature(sha256, fw.size, version, signature, publicKeyPem)) {
        return res.status(400).json({ error: "Signature doesn't verify against the hubs' key - wrong .pem?" });
      }

      const fleet = await listFleet();
      const all = target === "all";
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

      const release = {
        sha256, version, signature, url: firmwareUrl(sha256),
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
      const releases = await store.listReleases(30);
      return res.json({
        releases: releases.map((r) => ({ ...r.release, summary: summarize(r.targets) }))
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
      return res.json({
        release: r.release,
        summary: summarize(r.targets),
        targets: r.targets.map((t) => ({ ...t, outcome: outcomeOf(t) }))
      });
    } catch (err) {
      console.error("[ota] get failed:", err);
      return res.status(500).json({ error: "Failed to load the release" });
    }
  });

  // Re-sends to every hub of the release that isn't updated yet (or just the
  // farmIds given) - busy (motor was running), failed or no reply.
  adminRouter.post("/releases/:id/retry", express.json(), async (req, res) => {
    try {
      const r = await store.getRelease(Number(req.params.id));
      if (!r) return res.status(404).json({ error: "No such release" });
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
      await store.recordStatus(farmId, payload, now());
    } catch (err) {
      console.error("[ota] status record failed:", err);
    }
  }

  return { publicRouter, adminRouter, handleOtaStatus };
}
