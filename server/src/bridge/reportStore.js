import { pool } from "./postgres.js";

// Storage for Reports (see reports.js): raw samples come from device_events
// (kept 15 days - postgres.js), and each finished day's computed report is
// kept for good in report_days, so 30-day (and older) reports still work
// after the raw rows are gone - and past days don't need recomputing.

export async function ensureReportSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_days (
      farm_id      TEXT NOT NULL,
      motor        TEXT NOT NULL,
      day          DATE NOT NULL,
      data         JSONB NOT NULL,
      computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (farm_id, motor, day)
    )
  `);
}

// Only the fields reports.js reads - not whole payloads.
const sampleCols = `event_type, recorded_at,
  payload->>'state' AS state, payload->>'fault' AS fault, payload->'v' AS v, payload->'i' AS i,
  payload->>'run_total_sec' AS run_total_sec, payload->>'run_mode' AS run_mode,
  payload->>'manual_stop' AS manual_stop, payload->>'open' AS open`;

export const pgReportStore = {
  async samples(farmId, eventTypes, fromMs, toMs) {
    const { rows } = await pool.query(
      `SELECT ${sampleCols} FROM device_events
       WHERE farm_id = $1 AND event_type = ANY($2) AND recorded_at >= $3 AND recorded_at < $4
       ORDER BY recorded_at, id`,
      [farmId, eventTypes, new Date(fromMs), new Date(toMs)]
    );
    return rows;
  },

  async savedDays(farmId, motor, dayKeys) {
    if (dayKeys.length === 0) return new Map();
    const { rows } = await pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, data FROM report_days WHERE farm_id = $1 AND motor = $2 AND day = ANY($3::date[])`,
      [farmId, motor, dayKeys]
    );
    return new Map(rows.map((r) => [r.day, r.data]));
  },

  async saveDays(farmId, motor, days) {
    for (const d of days) {
      await pool.query(
        `INSERT INTO report_days (farm_id, motor, day, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (farm_id, motor, day) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`,
        [farmId, motor, d.day, d]
      );
    }
  },

  // Farm / motor pairs with any status in [fromMs, toMs) - for the nightly roll-up.
  async activeMotors(fromMs, toMs) {
    const { rows } = await pool.query(
      `SELECT DISTINCT farm_id, event_type FROM device_events
       WHERE recorded_at >= $1 AND recorded_at < $2 AND event_type LIKE 'motor%\\_status'`,
      [new Date(fromMs), new Date(toMs)]
    );
    return rows
      .map((r) => ({ farmId: r.farm_id, motor: (r.event_type.match(/^motor(\d+)_status$/) || [])[1] }))
      .filter((r) => r.motor);
  }
};
