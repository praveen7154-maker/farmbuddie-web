// The failure detector - pure (no I/O), so it can be tested; see
// failureLog.js for what each kind means and where it is stored.

export const HUB_SILENCE_MS = 15 * 60 * 1000;   // idle hubs send status every 10 min, health every 5
const FRESH_BOOT_SEC = 15 * 60;
const LOOP_STALL_MS = 30 * 1000;
const LOW_BLOCK_BYTES = 30 * 1024;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The detector itself - pure, no I/O, so it can be tested. onMessage()
 * returns the failures a message reveals: [{ farmId, unit, kind, detail }].
 */
export function createFailureDetector() {
  const farms = new Map();   // farmId -> { lastMsgAt, hub: {...}, nodes: Map<label, {...}>, online: {} }

  function farmState(farmId) {
    let f = farms.get(farmId);
    if (!f) {
      f = { lastMsgAt: null, hub: null, nodes: new Map(), online: null };
      farms.set(farmId, f);
    }
    return f;
  }

  function onHealth(farmId, f, p, out) {
    const up = num(p.device_uptime_sec);
    const prev = f.hub;
    const fw = p.fw_version || null;
    if (up !== null) {
      const rebooted = prev ? up < prev.up : up < FRESH_BOOT_SEC;
      if (rebooted) {
        out.push({ farmId, unit: "hub", kind: "hub_reboot", detail: {
          reset_reason: p.reset_reason || null, restart_cause: p.restart_cause || null, fw,
          uptime_before_s: prev ? prev.up : null, uptime_s: up } });
      }
    }
    const sameBoot = prev && up !== null && up >= prev.up;
    const connects = num(p.mqtt_connects);
    if (sameBoot && connects !== null && prev.connects !== null && connects > prev.connects) {
      out.push({ farmId, unit: "hub", kind: "hub_reconnect", detail: { times: connects - prev.connects, signal_pct: num(p.signal_pct) } });
    }
    const block = num(p.max_alloc_heap);
    let lowMemNoted = sameBoot ? prev.lowMemNoted : false;
    if (block !== null && block < LOW_BLOCK_BYTES && !lowMemNoted) {
      out.push({ farmId, unit: "hub", kind: "hub_low_memory", detail: { max_alloc_heap: block, free_heap: num(p.free_heap) } });
      lowMemNoted = true;
    }
    const mesh = p.mesh && typeof p.mesh === "object" ? p.mesh : null;
    if (mesh) {
      const busy = num(mesh.loop_busy_max_ms);
      if (busy !== null && busy >= LOOP_STALL_MS) {
        out.push({ farmId, unit: "hub", kind: "hub_loop_stall", detail: { ms: busy } });
      }
      const drops = num(mesh.drops), inboxDropped = num(mesh.inbox_dropped);
      if (sameBoot && drops !== null && prev.drops !== null && drops > prev.drops) {
        out.push({ farmId, unit: "hub", kind: "mesh_link_drops", detail: { drops: drops - prev.drops } });
      }
      if (sameBoot && inboxDropped !== null && prev.inboxDropped !== null && inboxDropped > prev.inboxDropped) {
        out.push({ farmId, unit: "hub", kind: "mesh_inbox_dropped", detail: { messages: inboxDropped - prev.inboxDropped } });
      }
    }
    f.hub = { up: up ?? (prev ? prev.up : 0), connects, lowMemNoted,
      drops: mesh ? num(mesh.drops) : null, inboxDropped: mesh ? num(mesh.inbox_dropped) : null };
  }

  function onMotorNodesFlags(farmId, f, flags, atMs, out) {
    if (!flags || typeof flags !== "object") return;
    const prev = f.online;
    const next = {};
    for (const [k, v] of Object.entries(flags)) {
      if (!/^\d+$/.test(k) || typeof v !== "boolean") continue;
      next[k] = { on: v, since: prev && prev[k] && prev[k].on === v ? prev[k].since : atMs };
      if (!prev || !prev[k] || prev[k].on === v) continue;
      const unit = `MOTOR_${k}`;
      if (v) out.push({ farmId, unit, kind: "node_online", detail: { offline_s: Math.round((atMs - prev[k].since) / 1000) } });
      else out.push({ farmId, unit, kind: "node_offline", detail: { online_s: Math.round((atMs - prev[k].since) / 1000) } });
    }
    f.online = next;
  }

  function onNodeStatus(farmId, f, unit, p, out) {
    const up = num(p.device_uptime_sec);
    const prev = f.nodes.get(unit);
    const fw = p.fw_version || null;
    if (up !== null) {
      const rebooted = prev ? up < prev.up : up < FRESH_BOOT_SEC;
      if (rebooted) {
        out.push({ farmId, unit, kind: "node_reboot", detail: {
          reset_reason: p.reset_reason || null, restart_cause: p.restart_cause || null, fw,
          uptime_before_s: prev ? prev.up : null, uptime_s: up } });
      }
    }
    const crash = typeof p.crash === "string" && p.crash ? p.crash : null;
    if (crash && (!prev || prev.crash !== crash)) {
      out.push({ farmId, unit, kind: "node_crash", detail: { crash, fw, reset_reason: p.reset_reason || null } });
    }
    const restarts = num(p.mesh_restarts);
    const sameBoot = prev && up !== null && up >= prev.up;
    if (sameBoot && restarts !== null && prev.restarts !== null && restarts > prev.restarts) {
      out.push({ farmId, unit, kind: "node_mesh_restart", detail: {
        times: restarts - prev.restarts, hub_silent_sec: num(p.hub_silent_sec), peers: num(p.mesh_peers) } });
    }
    f.nodes.set(unit, { up: up ?? (prev ? prev.up : 0), crash: crash || (prev ? prev.crash : null), restarts });
  }

  return {
    onMessage(farmId, eventType, payload, atMs = Date.now()) {
      const out = [];
      const f = farmState(farmId);
      if (f.lastMsgAt !== null && atMs - f.lastMsgAt >= HUB_SILENCE_MS) {
        out.push({ farmId, unit: "hub", kind: "hub_silent", detail: {
          from: new Date(f.lastMsgAt).toISOString(), minutes: Math.round((atMs - f.lastMsgAt) / 60000) } });
      }
      f.lastMsgAt = atMs;
      const p = payload && typeof payload === "object" ? payload : null;
      if (!p) return out;
      if (eventType === "health_health") onHealth(farmId, f, p, out);
      const m = /^motor(\d+)_status$/.exec(eventType || "");
      if (m && p.event === undefined) {
        if (m[1] === "1") onMotorNodesFlags(farmId, f, p.motor_nodes, atMs, out);
        else onNodeStatus(farmId, f, `MOTOR_${m[1]}`, p, out);
      }
      return out;
    }
  };
}

