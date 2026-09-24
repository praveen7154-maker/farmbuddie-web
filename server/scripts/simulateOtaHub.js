// A pretend hub for testing the admin panel's Firmware OTA page without real
// hardware. It does what a hub's OtaManager does up to the flash write:
//   - waits for an "ota_start" on farm/<id>/<node>/ota/cmd (or the broadcast),
//   - checks the release signature against the fleet's public key,
//   - downloads the .bin from the public URL (needs Content-Length, like the
//     hub's GSM downloader) and checks size + SHA-256,
//   - publishes the same farm/<id>/<node>/ota/status messages a hub sends
//     (starting -> downloading % -> verifying -> flashing -> validated), so
//     the page's progress table fills in exactly as it would for a hub.
// Nothing is flashed anywhere. It logs in with a temporary MQTT login that
// may only read that farm's ota/cmd and write its ota/status, and deletes
// it again on exit.
//
// Usage (inside the provision-api container):
//   node scripts/simulateOtaHub.js --farm 0001            # behave like a healthy hub
//   node scripts/simulateOtaHub.js --farm 0001 --busy     # answer like a hub whose motor is on
//   options: --minutes N (how long to wait for a release, default 20)
//
// Pick a farm that has NO real hub - a real one would also get the update.
import crypto from "node:crypto";
import mqtt from "mqtt";
import { config } from "../src/config.js";
import { createBasicCredentials, deleteCredentials } from "../src/tbmqClient.js";
import { generateMqttPassword } from "../src/password.js";
import { OTA_BROADCAST_TOPIC, verifyReleaseSignature } from "../src/bridge/ota.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const farmId = arg("farm");
const busy = process.argv.includes("--busy");
const minutes = Number(arg("minutes", "20"));
if (!/^\d{1,6}$/.test(farmId || "")) {
  console.error("Usage: node scripts/simulateOtaHub.js --farm <farmId> [--busy] [--minutes N]");
  process.exit(1);
}

const clientId = `ota-sim-${farmId}-${crypto.randomBytes(3).toString("hex")}`;
const password = generateMqttPassword();
const cmdFilter = `farm/${farmId}/+/ota/cmd`;
const created = await createBasicCredentials({
  name: clientId,
  clientId,
  userName: clientId,
  password,
  pubAuthRulePatterns: [`farm/${farmId}/[^/]+/ota/status`],
  subAuthRulePatterns: [`farm/${farmId}/\\+/ota/cmd`, OTA_BROADCAST_TOPIC]
});
const credentialsId = created.id?.id || created.id;

let client = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try { await client?.endAsync(); } catch { /* already gone */ }
  try {
    await deleteCredentials(credentialsId);
    console.log("[sim] temporary MQTT login deleted");
  } catch (err) {
    console.error(`[sim] could not delete temporary login "${clientId}" - delete it in TBMQ:`, err.message);
  }
  process.exit(code);
}
process.on("SIGINT", () => finish(130));
process.on("SIGTERM", () => finish(143));
setTimeout(() => {
  console.log(`[sim] no release arrived in ${minutes} min - giving up`);
  finish(2);
}, minutes * 60 * 1000).unref();

client = mqtt.connect(config.bridgeMqttUrl, { clientId, username: clientId, password, clean: true, reconnectPeriod: 0 });
client.on("error", (err) => {
  console.error("[sim] MQTT error:", err.message);
  finish(1);
});

let busyWith = null;

client.on("connect", async () => {
  await client.subscribeAsync([cmdFilter, OTA_BROADCAST_TOPIC], { qos: 1 });
  console.log(`[sim] pretend hub for farm ${farmId} is listening${busy ? " (motor ON - will answer busy)" : ""}.`);
  console.log("[sim] Now click Release in Admin > Firmware OTA with this farm ticked. Ctrl+C to stop.");
});

client.on("message", async (topic, buf) => {
  let cmd;
  try { cmd = JSON.parse(buf.toString()); } catch { return; }
  if (cmd?.cmd !== "ota_start") return;
  // The broadcast has no node in its topic - answer as the fleet's default hub.
  const nodeId = topic === OTA_BROADCAST_TOPIC ? "MOTOR_1" : topic.split("/")[2];
  const statusTopic = `farm/${farmId}/${nodeId}/ota/status`;
  const version = String(cmd.version || "");
  const send = (state, extra = {}) => {
    const msg = { type: "ota_status", state, version, fw_version: "sim", transport: "sim", ...extra };
    console.log(`[sim] -> ${state}${extra.percent != null ? ` ${extra.percent}%` : ""}${extra.error ? ` (${extra.error})` : ""}`);
    return client.publishAsync(statusTopic, JSON.stringify(msg), { qos: 1 });
  };
  console.log(`[sim] got ota_start v${version} on ${topic}`);
  console.log(`[sim]    url  ${cmd.url}`);

  if (busyWith) return send("failed", { error: "already_in_progress" });
  if (busy) return send("failed", { error: "pump_running" });
  if (!cmd.sig) return send("failed", { error: "missing_signature" });
  if (!verifyReleaseSignature(String(cmd.sha256), cmd.size, version, cmd.sig)) {
    return send("failed", { error: "invalid_signature" });
  }
  if (!/^https:\/\//.test(String(cmd.url))) return send("failed", { error: "bad_url" });

  busyWith = version;
  try {
    await send("starting");
    const res = await fetch(cmd.url);
    if (!res.ok) return await send("failed", { error: `http_${res.status}` });
    const length = Number(res.headers.get("content-length"));
    if (!length) return await send("failed", { error: "no_content_length" });
    if (length !== cmd.size) return await send("failed", { error: "size_mismatch" });

    const hash = crypto.createHash("sha256");
    let got = 0;
    let lastReported = -1;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      const pct = Math.floor((got * 100) / length);
      if (pct >= lastReported + 10) {
        lastReported = pct - (pct % 10);
        await send("downloading", { percent: lastReported });
        await new Promise((r) => setTimeout(r, 400)); // let the page show it moving
      }
    }
    if (got !== length) return await send("failed", { error: "incomplete_download" });

    await send("verifying", { percent: 100 });
    if (hash.digest("hex") !== String(cmd.sha256).toLowerCase()) {
      return await send("failed", { error: "checksum_mismatch" });
    }
    await send("flashing", { percent: 100 });
    await new Promise((r) => setTimeout(r, 3000)); // the real hub reboots here
    await client.publishAsync(statusTopic, JSON.stringify({
      type: "ota_status", state: "validated", version, fw_version: version, transport: "sim"
    }), { qos: 1 });
    console.log(`[sim] -> validated (now "running" v${version})`);
    console.log("[sim] PASS - download, size, SHA-256 and signature all good. Nothing was flashed.");
    await finish(0);
  } catch (err) {
    console.error("[sim] download failed:", err.message);
    await send("failed", { error: "download_error" });
  } finally {
    busyWith = null;
  }
});
