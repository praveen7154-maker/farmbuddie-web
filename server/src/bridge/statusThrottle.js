// Fewer Firestore writes for device status (see firestoreMirror.js).
//
// A hub reports status every 10 s while someone has the app open, every
// 2 min while running and every 10 min idle, plus health every 5 min.
// Copying every one of those into Firestore cost ~600-1,000 writes per
// farm per day - past Firebase's free 20,000/day at ~25 farms. Nothing
// needs that: the apps get live data from this server (liveGateway.js),
// and the web panel only needs "what's true now, roughly".
//
// So the latest report of each kind is kept here in memory, and written
// to Firestore only when:
//  - something that matters changed (motor on/off, fault, mode, valves -
//    anything except the always-moving readings below), or
//  - HEARTBEAT_MS has passed since the last write (refreshes the readings
//    and lastSeen), or
//  - the farm went quiet for OFFLINE_AFTER_MS (one write: offlineAt), so
//    the web panel shows it offline without waiting for lastSeen to age.

export const HEARTBEAT_MS = 20 * 60 * 1000;
export const OFFLINE_AFTER_MS = 11 * 60 * 1000;

// Readings and counters that change on almost every report - left out
// when deciding whether a report "changed". (They are still written, on
// the next heartbeat or change.)
const MOVING = /^(volt_|curr_|pressure_|delta_psi|signal_pct|node_rssi_pct|rssi|free_heap|max_alloc_heap|battery_mv|mesh_drops|run_total_sec|run_sec|uptime_sec|device_uptime_sec|transport_uptime_sec|phase_elapsed_sec|ts$|time$|v$|i$)|_remaining_sec$/;

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (!MOVING.test(k)) out[k] = strip(value[k]);
    return out;
  }
  return value;
}

/** What a report "means", without its moving readings. */
export const signature = (payload) => JSON.stringify(strip(payload));

export function createStatusThrottle({ heartbeatMs = HEARTBEAT_MS, offlineAfterMs = OFFLINE_AFTER_MS, now = () => Date.now() } = {}) {
  const farms = new Map();   // farmId -> state

  function stateOf(farmId) {
    let s = farms.get(farmId);
    if (!s) {
      s = { nodeId: null, lastMsgAt: null, lastWriteAt: null, offline: false, latest: {}, written: {}, dirty: new Set() };
      farms.set(farmId, s);
    }
    return s;
  }

  return {
    /**
     * A report arrived. field: "motor1".."motor4" | "health" | "valves".
     * Returns { write, fields } - write: send to Firestore now; fields:
     * every field not yet written (with its latest payload).
     */
    note(farmId, nodeId, field, payload) {
      const s = stateOf(farmId);
      const t = now();
      s.nodeId = nodeId;
      s.lastMsgAt = t;
      s.latest[field] = payload;
      s.dirty.add(field);
      const changed = s.written[field] === undefined || s.written[field] !== signature(payload);
      const write = changed || s.offline || s.lastWriteAt === null || t - s.lastWriteAt >= heartbeatMs;
      return { write, fields: write ? this.pending(farmId) : null, wasOffline: s.offline };
    },

    /** Everything not written yet, as { field: payload }. */
    pending(farmId) {
      const s = stateOf(farmId);
      return Object.fromEntries([...s.dirty].map((f) => [f, s.latest[f]]));
    },

    /** The write of `fields` went through. */
    written(farmId, fields) {
      const s = stateOf(farmId);
      for (const [f, p] of Object.entries(fields || {})) {
        s.written[f] = signature(p);
        if (s.latest[f] === p) s.dirty.delete(f);
      }
      s.lastWriteAt = now();
      s.offline = false;
    },

    /** Farms that have gone quiet and aren't marked offline yet. */
    dueOffline() {
      const t = now();
      return [...farms.entries()].filter(([, s]) => s.lastMsgAt !== null && !s.offline && t - s.lastMsgAt > offlineAfterMs).map(([id]) => id);
    },

    markedOffline(farmId) {
      const s = stateOf(farmId);
      s.offline = true;
      s.dirty.clear();
      s.lastWriteAt = now();
    },

    /** Latest in memory: { nodeId, lastMsgAt, latest: {field: payload}, online } or null. */
    snapshot(farmId) {
      const s = farms.get(farmId);
      if (!s || s.lastMsgAt === null) return null;
      return { nodeId: s.nodeId, lastMsgAt: s.lastMsgAt, latest: { ...s.latest }, online: now() - s.lastMsgAt <= offlineAfterMs };
    },

    forget(farmId) { farms.delete(farmId); }
  };
}
