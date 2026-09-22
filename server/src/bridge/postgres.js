import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.bridgePgConnectionString() });

const RETENTION_DAYS = 15;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly — keeps the table close to the 15-day bound without much overhead

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
}

export async function insertEvent({ farmId, nodeId, eventType, payload }) {
  await pool.query(
    `INSERT INTO device_events (farm_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
    [farmId, nodeId, eventType, payload]
  );
}

export async function queryEvents(farmId, since) {
  const { rows } = await pool.query(
    `SELECT id, node_id, event_type, payload, recorded_at
     FROM device_events
     WHERE farm_id = $1 AND recorded_at >= $2
     ORDER BY recorded_at ASC
     LIMIT 5000`,
    [farmId, since]
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
