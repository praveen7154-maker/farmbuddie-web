import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.bridgePgConnectionString() });

const RETENTION_DAYS = 15;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly — keeps the table close to the 15-day bound without much overhead

/** Real connectivity check, not just "the pool object exists" - used by GET /healthz (see server.js) for the "VPS & TBMQ" admin status page. Never throws. */
export async function checkPostgresHealth() {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
  }
}

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_events (
      id           BIGSERIAL PRIMARY KEY,
      farm_id      TEXT NOT NULL,
      node_id      TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload      JSONB NOT NULL,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS device_events_farm_recorded_idx
    ON device_events (farm_id, recorded_at DESC)
  `);
  // For the hourly retention DELETE, which filters on recorded_at alone -
  // without it that query scans the whole table as the fleet grows.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS device_events_recorded_idx
    ON device_events (recorded_at)
  `);
}

export async function insertEvent({ farmId, nodeId, eventType, payload }) {
  await pool.query(
    `INSERT INTO device_events (farm_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
    [farmId, nodeId, eventType, payload]
  );
}

// Newest 5000 in the window, returned oldest-first. Taking the first 5000
// in ascending order cut off the most recent events whenever a window held
// more than that (a busy day of 15s status reports does).
export async function queryEvents(farmId, since) {
  const { rows } = await pool.query(
    `SELECT id, node_id, event_type, payload, recorded_at
     FROM device_events
     WHERE farm_id = $1 AND recorded_at >= $2
     ORDER BY recorded_at DESC
     LIMIT 5000`,
    [farmId, since]
  );
  return rows.reverse();
}

// A farm's motor alerts (status-topic messages carrying "event" - see
// mqttBridge.js) recorded after `since`, oldest first, at most `limit`.
export async function queryAlerts(farmId, since, limit) {
  const { rows } = await pool.query(
    `SELECT event_type, payload, recorded_at
     FROM device_events
     WHERE farm_id = $1 AND recorded_at > $2
       AND event_type LIKE 'motor%\\_status' AND payload ? 'event'
     ORDER BY recorded_at ASC
     LIMIT $3`,
    [farmId, since, limit]
  );
  return rows;
}

async function cleanupOldEvents() {
  try {
    const result = await pool.query(
      `DELETE FROM device_events WHERE recorded_at < now() - interval '${RETENTION_DAYS} days'`
    );
    if (result.rowCount > 0) {
      console.log(`[bridge] cleanup: deleted ${result.rowCount} events older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error("[bridge] cleanup failed:", err);
  }
}

export function startRetentionCleanup() {
  cleanupOldEvents();
  setInterval(cleanupOldEvents, CLEANUP_INTERVAL_MS);
}
