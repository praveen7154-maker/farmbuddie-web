// Failure log - every reboot, crash, link drop and silence of a farm's hub
// and motor nodes, detected from the messages this bridge already receives
// and kept for a year (raw device_events only 15 days), so a field problem
// can be traced from the VPS alone, without a USB cable:
//
//   docker compose exec bridge node scripts/farmReport.js 0002
//
// What is detected (unit "hub" or "MOTOR_<n>"):
//   hub_reboot        the hub's device_uptime_sec went back (or a fresh boot
//                     was first seen) - with reset_reason / restart_cause
//                     (wdt_loop = main loop froze, mqtt_stuck, heap_low...)
//   hub_silent        no message at all from the farm for over 15 min -
//                     recorded when it reports again, with how long
//   hub_reconnect     the hub's server link dropped and came back without a
//                     reboot (health mqtt_connects went up)
//   hub_loop_stall    the hub's main loop stalled over 30 s (health mesh)
//   hub_modem_reset   the hub reset its GSM modem (health modem_resets went up) -
//                     the SIM dropped out, or the server stayed unreachable over GSM
//   hub_low_memory    largest free heap block under 30 KB (once per boot)
//   hub_crash         the hub's last crash (core dump summary, as node_crash)
//   mesh_link_drops   painlessMesh links dropped since the last health report
//   mesh_inbox_dropped node messages the hub dropped, its main loop too far behind
//   node_offline / node_online   the hub's online flag for a motor node
//   node_reboot       a motor node's uptime went back - reset_reason, restart_cause
//   node_crash        a motor node's last crash (core dump summary - decode
//                     the addresses with addr2line against that build)
//   node_mesh_restart a motor node rebuilt its mesh link (hub lost / one-way link)
//   lora_module       the hub's LoRa module doesn't answer, isn't plugged in
//                     ("absent"), or its settings couldn't be set (e22.h)
//   lora_speed_reverted a LoRa speed change the hub undid: a unit wasn't
//                     heard at the new speed (too far for it)
//
// Detection is in memory: after a bridge restart the first message of each
// unit only seeds the state (a boot seen within 15 min is still recorded).

import { pool } from "./postgres.js";

import { createFailureDetector } from "./failureDetect.js";
export { createFailureDetector, HUB_SILENCE_MS } from "./failureDetect.js";

const RETENTION_DAYS = 365;

// ---- storage ----

export async function ensureFailureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_failures (
      id       BIGSERIAL PRIMARY KEY,
      farm_id  TEXT NOT NULL,
      unit     TEXT NOT NULL,
      kind     TEXT NOT NULL,
      detail   JSONB NOT NULL DEFAULT '{}'::jsonb,
      at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS device_failures_farm_at_idx ON device_failures (farm_id, at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS device_failures_at_idx ON device_failures (at)`);
}

const detector = createFailureDetector();

/** Called by mqttBridge.js for every device message; never throws. */
export async function noteDeviceMessage(farmId, eventType, payload) {
  let found = [];
  try {
    found = detector.onMessage(farmId, eventType, payload);
  } catch (err) {
    console.error("[failures] detect failed:", err.message);
    return;
  }
  for (const x of found) {
    try {
      if (await alreadyLogged(x)) continue;
      await pool.query(
        `INSERT INTO device_failures (farm_id, unit, kind, detail) VALUES ($1, $2, $3, $4)`,
        [x.farmId, x.unit, x.kind, x.detail || {}]
      );
      console.log(`[failures] ${x.farmId} ${x.unit} ${x.kind} ${JSON.stringify(x.detail || {})}`);
    } catch (err) {
      console.error("[failures] insert failed:", err.message);
    }
  }
}

// A restart or crash the detector sees on the FIRST message from a unit
// after this bridge restarted (it has nothing earlier to compare with): it
// is counted on a fresh boot, so if the bridge itself restarted within that
// window, the previous bridge may already have logged this same boot.
// Skipped when a row for the same boot is already there.
async function alreadyLogged(x) {
  const d = x.detail || {};
  let windowS = null;
  let sameCrash = null;
  if ((x.kind === "hub_reboot" || x.kind === "node_reboot") && d.uptime_before_s == null) {
    windowS = (typeof d.uptime_s === "number" ? d.uptime_s : 900) + 120;   // since this boot, plus slack
  } else if (x.kind === "hub_crash" || x.kind === "node_crash") {
    windowS = 900 + 120;
    sameCrash = typeof d.crash === "string" ? d.crash : null;
  }
  if (windowS == null) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM device_failures
      WHERE farm_id = $1 AND unit = $2 AND kind = $3 AND at > now() - make_interval(secs => $4::double precision)
        AND ($5::text IS NULL OR detail->>'crash' = $5)
      LIMIT 1`,
    [x.farmId, x.unit, x.kind, windowS, sameCrash]
  );
  return rows.length > 0;
}

export async function cleanupOldFailures() {
  try {
    await pool.query(`DELETE FROM device_failures WHERE at < now() - interval '${RETENTION_DAYS} days'`);
  } catch (err) {
    console.error("[failures] cleanup failed:", err.message);
  }
}
