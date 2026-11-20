// A farm's health on one screen, from the VPS alone - the hub and each
// motor node right now, and every failure in the last N days (failure log,
// see src/bridge/failureLog.js - kept a year).
//
//   docker compose exec bridge node scripts/farmReport.js 0002
//   docker compose exec bridge node scripts/farmReport.js 0002 --days 30
//   docker compose exec bridge node scripts/farmReport.js 0002 --all     (every failure row, not just the last 40)
//   docker compose exec bridge node scripts/farmReport.js 0002 --backfill
//       once, for a farm with no failure rows yet: replays its stored device
//       data (up to 15 days) through the same detector, so its history is
//       there at once instead of starting from today.
//
// Reads only. Times are IST.

import { pool } from "../src/bridge/postgres.js";
import { createFailureDetector, ensureFailureSchema } from "../src/bridge/failureLog.js";

const args = process.argv.slice(2);
const farmId = args.find((a) => /^\d{1,6}$/.test(a));
const daysArg = args.indexOf("--days");
const days = daysArg >= 0 ? Math.max(1, Number(args[daysArg + 1]) || 7) : 7;
const all = args.includes("--all");
const backfill = args.includes("--backfill");

if (!farmId) {
  console.log("Usage: node scripts/farmReport.js <farmId> [--days N] [--all] [--backfill]");
  process.exit(1);
}

const ist = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "-");
const ago = (d) => {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const dur = (sec) => {
  if (sec == null || !Number.isFinite(Number(sec))) return "-";
  const s = Number(sec);
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
};

async function latest(eventType, extraWhere = "") {
  const { rows } = await pool.query(
    `SELECT payload, recorded_at FROM device_events
      WHERE farm_id = $1 AND event_type = $2 ${extraWhere}
      ORDER BY recorded_at DESC LIMIT 1`, [farmId, eventType]);
  return rows[0] || null;
}

async function runBackfill() {
  await ensureFailureSchema();
  const have = (await pool.query(`SELECT count(*)::int AS n FROM device_failures WHERE farm_id = $1`, [farmId])).rows[0].n;
  if (have > 0) {
    console.log(`Farm ${farmId} already has ${have} failure rows - backfill skipped (it is only for a farm with none).`);
    return;
  }
  const detector = createFailureDetector();
  let lastId = 0, seen = 0, found = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, event_type, payload, recorded_at FROM device_events
        WHERE farm_id = $1 AND id > $2 ORDER BY id LIMIT 5000`, [farmId, lastId]);
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = r.id;
      seen++;
      for (const x of detector.onMessage(farmId, r.event_type, r.payload, new Date(r.recorded_at).getTime())) {
        await pool.query(`INSERT INTO device_failures (farm_id, unit, kind, detail, at) VALUES ($1, $2, $3, $4, $5)`,
          [farmId, x.unit, x.kind, x.detail || {}, r.recorded_at]);
        found++;
      }
    }
  }
  console.log(`Backfill: ${seen} stored messages replayed, ${found} failures recorded for farm ${farmId}.`);
}

async function main() {
  if (backfill) await runBackfill();
  console.log(`\n=== Farm ${farmId} - ${ist(new Date())} IST - last ${days} day(s) ===\n`);

  // ---- hub ----
  const health = await latest("health_health");
  const status = await latest("motor1_status", "AND NOT (payload ? 'event')");
  const lastAny = (await pool.query(
    `SELECT max(recorded_at) AS at FROM device_events WHERE farm_id = $1 AND recorded_at > now() - interval '15 days'`, [farmId])).rows[0]?.at;
  console.log("HUB");
  console.log(`  last message      ${ist(lastAny)} (${ago(lastAny)})${lastAny && Date.now() - new Date(lastAny) > 15 * 60000 ? "   <-- OFFLINE" : ""}`);
  if (health) {
    const h = health.payload;
    console.log(`  firmware          ${h.fw_version || "-"} (board ${h.board || "-"})`);
    console.log(`  up since boot     ${dur(h.device_uptime_sec)} - last reset: ${h.reset_reason || "-"}${h.restart_cause ? ` / ${h.restart_cause}` : ""}`);
    console.log(`  link              ${h.transport || "-"}, signal ${h.signal_pct ?? "-"}%, server connects since boot ${h.mqtt_connects ?? "-"}, modem resets ${h.modem_resets ?? "-"}`);
    if (h.crash) console.log(`  last crash        ${h.crash}`);
    console.log(`  memory            free ${h.free_heap ?? "-"} B, largest block ${h.max_alloc_heap ?? "-"} B` +
      `${h.min_free_heap != null ? `, lowest since boot ${h.min_free_heap} B` : ""}`);
    if (h.stack_free) console.log(`  task stack free   ${Object.entries(h.stack_free).map(([k, v]) => `${k} ${v} B`).join(", ")}`);
    if (h.mesh) {
      const m = h.mesh;
      console.log(`  mesh              link drops ${m.drops ?? "-"}, joins ${m.joins ?? "-"}, dropped msgs ${m.inbox_dropped ?? "-"}, ` +
        `longest wait ${m.wait_max_ms ?? "-"} ms, longest loop stall ${m.loop_busy_max_ms ?? "-"} ms (last 5 min)`);
      // Which device linked / dropped last: painlessMesh's node id is the
      // last 4 bytes of its WiFi MAC - matched to a unit that reported that
      // MAC (its station MAC, or the AP one, +1), else shown as the MAC end.
      for (const [what, id] of [["linked", m.last_join], ["dropped", m.last_drop]]) {
        if (!id) continue;
        const hex = (Number(id) >>> 0).toString(16).padStart(8, "0").toUpperCase();
        const near = [hex, ((Number(id) - 1) >>> 0).toString(16).padStart(8, "0").toUpperCase()];
        const { rows: who } = await pool.query(
          `SELECT DISTINCT ON (event_type) event_type, upper(payload->>'mac') AS mac FROM device_events
            WHERE farm_id = $1 AND recorded_at > now() - interval '60 days'
              AND (upper(payload->>'mac') LIKE '%' || $2 OR upper(payload->>'mac') LIKE '%' || $3)
            ORDER BY event_type, recorded_at DESC`, [farmId, near[0], near[1]]);
        const name = who.length ? who.map((w) => w.event_type.replace(/_status$/, "").replace(/^motor(\d+)/, "MOTOR_$1")).join(", ") : "not a unit that has reported here";
        console.log(`  last device ${what.padEnd(7)} id ${id} (MAC ..:${hex.match(/../g).join(":")}) - ${name}`);
      }
      for (const [k, n] of Object.entries(m.motor_nodes || {})) {
        console.log(`  motor ${k} (hub)    ${n.online ? "online" : "OFFLINE"}, heard ${Number.isFinite(n.seen_s) && n.seen_s >= 0 && n.seen_s < 4000000000 ? `${n.seen_s} s ago` : "never (since hub boot)"}, ` +
          `went offline ${n.offline_n} time(s) since hub boot, rssi ${n.rssi}, ${n.link}`);
      }
    } else {
      console.log("  mesh              (no mesh counters - hub firmware older than this report)");
    }
    if (h.lora) {
      const l = h.lora;
      console.log(`  lora              ${l.kbps ?? "-"} kbps, channel ${l.ch ?? "-"}, module ${l.cfg ?? "-"}${l.changing ? ", SPEED CHANGE UNDER WAY" : ""}${l.change ? ` - last change: ${l.change}` : ""}`);
      for (const u of l.units || []) {
        console.log(`  lora ${String(u.u).padEnd(12)} ${u.dbm != null ? `${u.dbm} dBm` : "signal -"}, heard ${u.seen_s ?? "-"} s ago${u.lr === false ? ", OLD FIRMWARE (can't follow a speed change)" : ""}`);
      }
    }
  } else {
    console.log("  no health report in the last 15 days");
  }
  if (status?.payload?.motor_nodes) console.log(`  node flags        ${JSON.stringify(status.payload.motor_nodes)}`);

  // ---- valve units (the hub's valves topic snapshot) ----
  {
    const { rows: vs } = await pool.query(
      `SELECT payload, recorded_at FROM device_events WHERE farm_id = $1 AND event_type = 'valves_status'
         AND recorded_at > now() - make_interval(days => $2) ORDER BY recorded_at`, [farmId, days]);
    const last = vs.length ? vs[vs.length - 1] : await latest("valves_status");
    const units = Array.isArray(last?.payload?.units) ? last.payload.units : [];
    if (units.length) {
      // Online / offline changes per unit across the window's snapshots.
      const flips = {}, prevOn = {};
      for (const r of vs) for (const u of r.payload?.units || []) {
        if (prevOn[u.u] !== undefined && prevOn[u.u] !== !!u.on) {
          flips[u.u] = flips[u.u] || { off: 0, on: 0, lastOff: null };
          if (u.on) flips[u.u].on++; else { flips[u.u].off++; flips[u.u].lastOff = r.recorded_at; }
        }
        prevOn[u.u] = !!u.on;
      }
      console.log("\nVALVE UNITS");
      console.log(`  last snapshot     ${ist(last.recorded_at)} (${ago(last.recorded_at)})`);
      for (const u of units) {
        const f = flips[u.u];
        console.log(`  ${String(u.u).padEnd(17)} ${u.on ? "online " : "OFFLINE"}, valves ${u.o + 1}-${u.o + u.n}, signal ${u.sig ?? "-"}%, ` +
          `${u.lk || "-"}, fw ${u.fw || "-"}` +
          (f ? ` - went offline ${f.off}x, back ${f.on}x in the window${f.lastOff ? ` (last off ${ist(f.lastOff)})` : ""}` : ""));
      }
    }
  }

  // ---- motor nodes ----
  const { rows: nodeTypes } = await pool.query(
    `SELECT DISTINCT event_type FROM device_events
      WHERE farm_id = $1 AND event_type ~ '^motor([2-9]|[1-9][0-9])_status$' AND recorded_at > now() - interval '15 days'
      ORDER BY event_type`, [farmId]);
  for (const { event_type: et } of nodeTypes) {
    const n = await latest(et, "AND NOT (payload ? 'event')");
    const label = `MOTOR_${et.match(/^motor(\d+)/)[1]}`;
    console.log(`\n${label}`);
    if (!n) { console.log("  no status in the last 15 days"); continue; }
    const p = n.payload;
    console.log(`  last status       ${ist(n.recorded_at)} (${ago(n.recorded_at)})`);
    console.log(`  firmware          ${p.fw_version || "-"}${p.board ? ` (board ${p.board})` : ""}`);
    console.log(`  up since boot     ${dur(p.device_uptime_sec)} - last reset: ${p.reset_reason || "-"}${p.restart_cause ? ` / ${p.restart_cause}` : ""}`);
    if (p.crash) console.log(`  last crash        ${p.crash}`);
    if (p.free_heap !== undefined) console.log(`  memory            free ${p.free_heap} B, largest block ${p.max_alloc_heap ?? "-"} B` +
      `${p.min_free_heap != null ? `, lowest since boot ${p.min_free_heap} B` : ""}${p.stack_free != null ? `, loop stack free ${p.stack_free} B` : ""}`);
    if (p.mesh_restarts !== undefined) {
      console.log(`  mesh              ${p.mesh_secure === true ? "secure" : p.mesh_secure === false ? "legacy" : "-"}, peers ${p.mesh_peers}, hub last heard ${p.hub_silent_sec} s ago, ` +
        `mesh rebuilt ${p.mesh_restarts} time(s) since boot`);
    }
    if (p.node_rssi_pct !== undefined) console.log(`  signal at hub     ${p.node_rssi_pct}%`);
    if (p.lora) console.log(`  lora              ${p.lora.kbps ?? "-"} kbps, channel ${p.lora.ch ?? "-"}, module ${p.lora.cfg ?? "-"}, hub heard at ${p.lora.hub_dbm != null ? `${p.lora.hub_dbm} dBm` : "-"}${p.lora.scan ? ", LOOKING FOR THE HUB (other speed)" : ""}`);
    console.log(`  clock             ${p.ts ? ist(p.ts * 1000) : "-"}${p.time_synced === false ? " (not synced)" : ""}`);
  }

  // ---- failures ----
  const { rows: summary } = await pool.query(
    `SELECT unit, kind, count(*)::int AS n, max(at) AS last FROM device_failures
      WHERE farm_id = $1 AND at > now() - make_interval(days => $2)
      GROUP BY unit, kind ORDER BY unit, n DESC`, [farmId, days]);
  console.log(`\nFAILURES - last ${days} day(s)`);
  if (summary.length === 0) console.log("  none recorded");
  for (const r of summary) {
    console.log(`  ${r.unit.padEnd(9)} ${r.kind.padEnd(20)} ${String(r.n).padStart(5)}x   last ${ist(r.last)}`);
  }

  const { rows: list } = await pool.query(
    `SELECT unit, kind, detail, at FROM device_failures
      WHERE farm_id = $1 AND at > now() - make_interval(days => $2)
      ORDER BY at DESC ${all ? "" : "LIMIT 40"}`, [farmId, days]);
  if (list.length) {
    console.log(`\n${all ? "ALL" : "LATEST 40"} (newest first)`);
    for (const r of list) {
      console.log(`  ${ist(r.at).padEnd(22)} ${r.unit.padEnd(9)} ${r.kind.padEnd(20)} ${JSON.stringify(r.detail)}`);
    }
  }
  console.log("");
}

main()
  .catch((err) => { console.error("Report failed:", err.message); process.exitCode = 1; })
  .finally(() => pool.end());
