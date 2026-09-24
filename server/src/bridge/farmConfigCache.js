import { pool } from "./postgres.js";

/**
 * Last-known safety-limit/cyclic/valve config per (farm, device), so the
 * app can render instantly instead of waiting on a GSM round-trip to the
 * device - see the "VPS Gateway Design" doc's Data Model section. The
 * device's own NVS stays the authoritative copy; this is a cache only,
 * refreshed opportunistically whenever a get_config response passes
 * through the bridge (see mqttBridge.js).
 *
 * Keyed by (farm_id, device_type, device_id, config_type) rather than
 * farm_id alone - a farm can have more than one motor (each with its own
 * safety/cyclic config) or more than one valve unit, so farm_id alone
 * would silently overwrite one motor's config with another's. device_type
 * is "motor"/"valve"/"filter"; device_id is the motorId ("1", "2", ...)
 * or unit label ("VALVE_1", ...) it belongs to; config_type is whatever
 * the device's own response payload calls it (its `type` field, e.g.
 * "safety"/"cyclic"/"valve" - see setCachedConfigFromResponse()) so a
 * future config type needs no schema change here.
 */
export async function ensureFarmConfigCacheSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS farm_config_cache (
      farm_id      TEXT NOT NULL,
      device_type  TEXT NOT NULL,
      device_id    TEXT NOT NULL,
      config_type  TEXT NOT NULL,
      config       JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (farm_id, device_type, device_id, config_type)
    )
  `);
}

export async function getCachedConfig(farmId, deviceType, deviceId, configType) {
  const { rows } = await pool.query(
    `SELECT config, updated_at FROM farm_config_cache
     WHERE farm_id = $1 AND device_type = $2 AND device_id = $3 AND config_type = $4`,
    [farmId, deviceType, deviceId, configType]
  );
  return rows[0] || null;
}

/** Every cached config type for a farm - used to answer "what do I already know about this farm" in one round trip on WebSocket subscribe. */
export async function getCachedConfigsForFarm(farmId) {
  const { rows } = await pool.query(
    `SELECT device_type, device_id, config_type, config, updated_at
     FROM farm_config_cache WHERE farm_id = $1`,
    [farmId]
  );
  return rows;
}

export async function setCachedConfig(farmId, deviceType, deviceId, configType, config) {
  await pool.query(
    `INSERT INTO farm_config_cache (farm_id, device_type, device_id, config_type, config, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (farm_id, device_type, device_id, config_type)
     DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [farmId, deviceType, deviceId, configType, config]
  );
}

/**
 * Called from mqttBridge.js for every motor response payload - a no-op
 * unless the payload is actually a config echo (payload.type starting
 * with "config_", matching the Irrigo app's own PumpRepository.kt
 * discriminator). deviceType is always "motor" here: today's firmware
 * scopes safety/cyclic/valve config to a motor/pump context, not a
 * separate valve-unit identity yet (see the design doc's "not yet wired
 * up anywhere, firmware included" note) - this still keys by config_type
 * generically, so a future config_* payload shape needs no bridge change.
 */
export async function setCachedConfigFromResponse(farmId, motorNum, payload) {
  const type = payload && typeof payload === "object" ? payload.type : null;
  if (typeof type !== "string" || !type.startsWith("config_")) return;

  const configType = type.slice("config_".length);
  await setCachedConfig(farmId, "motor", motorNum || "1", configType, payload);
}
