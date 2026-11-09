import { readFileSync } from "node:fs";
import { pool } from "./postgres.js";
import { areaM2, hasArea, samePoints } from "./ndvi.js";

// Storage for crop health (see ndvi.js). The tables are in ndviSchema.sql,
// shared with the NDVI worker (farmbuddie-web/ndvi), which fills
// ndvi_scenes / ndvi_farm_scenes / ndvi_history / ndvi_maps.

const SCHEMA = readFileSync(new URL("./ndviSchema.sql", import.meta.url), "utf8");

export async function ensureNdviSchema(db = pool) {
  await db.query(SCHEMA);
}

export function createNdviStore(db = pool) {
  return {
    async zones(farmId) {
      const { rows } = await db.query(
        `SELECT farm_id, valve, points, area_m2, crop, to_char(sowing_date, 'YYYY-MM-DD') AS sowing_date, plotted_at, updated_at
           FROM ndvi_zones WHERE farm_id = $1 ORDER BY valve`, [farmId]);
      return rows;
    },

    /**
     * Saves the app's plotted valve lands (only the valves sent; others are
     * kept - another phone may have plotted them). A new or reshaped zone
     * has its old readings dropped and the farm is queued for the worker,
     * which then re-reads past images for the new shapes. The crop stays.
     */
    async saveZones(farmId, zones, who) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { rows: existing } = await client.query("SELECT valve, points FROM ndvi_zones WHERE farm_id = $1 FOR UPDATE", [farmId]);
        const old = new Map(existing.map((r) => [r.valve, r.points]));
        let changed = 0;
        for (const z of zones) {
          if (old.has(z.valve) && samePoints(old.get(z.valve), z.points)) continue;
          changed++;
          await client.query(
            `INSERT INTO ndvi_zones (farm_id, valve, points, area_m2, plotted_at, updated_at, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6)
             ON CONFLICT (farm_id, valve) DO UPDATE SET points = EXCLUDED.points, area_m2 = EXCLUDED.area_m2,
               plotted_at = EXCLUDED.plotted_at, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [farmId, z.valve, JSON.stringify(z.points), hasArea(z.points) ? areaM2(z.points) : 0, z.plottedAt, who]);
          await client.query("DELETE FROM ndvi_history WHERE farm_id = $1 AND valve = $2", [farmId, z.valve]);
        }
        if (changed) await this._reprocess(client, farmId);
        await client.query("COMMIT");
        return { changed };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async _reprocess(client, farmId) {
      await client.query("DELETE FROM ndvi_farm_scenes WHERE farm_id = $1", [farmId]);
      await client.query("DELETE FROM ndvi_maps WHERE farm_id = $1", [farmId]);
      await client.query(
        `INSERT INTO ndvi_status (farm_id, refresh_requested) VALUES ($1, now())
         ON CONFLICT (farm_id) DO UPDATE SET refresh_requested = now(), last_obs_at = NULL, last_success_at = NULL`, [farmId]);
    },

    async deleteZone(farmId, valve) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query("DELETE FROM ndvi_zones WHERE farm_id = $1 AND valve = $2", [farmId, valve]);
        await client.query("DELETE FROM ndvi_history WHERE farm_id = $1 AND valve = $2", [farmId, valve]);
        if (r.rowCount) await this._reprocess(client, farmId);   // heatmaps drew it
        await client.query("COMMIT");
        return r.rowCount > 0;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async setCrop(farmId, valve, crop, sowingDate, who) {
      const { rows } = await db.query(
        `UPDATE ndvi_zones SET crop = $3, sowing_date = $4, updated_at = now(), updated_by = $5
          WHERE farm_id = $1 AND valve = $2
          RETURNING valve, crop, to_char(sowing_date, 'YYYY-MM-DD') AS sowing_date`,
        [farmId, valve, crop, sowingDate, who]);
      return rows[0] || null;
    },

    /** Newest usable reading per valve, and the usable one before it (at least 4 days older). */
    async latestAndPrevious(farmId) {
      const { rows } = await db.query(
        `SELECT * FROM (
           SELECT h.*, row_number() OVER (PARTITION BY valve ORDER BY acquired_at DESC, valid_pixels DESC) AS rn
             FROM ndvi_history h WHERE farm_id = $1 AND usable) t
          WHERE rn <= 12 ORDER BY valve, acquired_at DESC`, [farmId]);
      const latest = new Map();
      const previous = new Map();
      const recent = new Map();     // valve -> its usable rows, newest first (for weak spots seen again)
      for (const r of rows) {
        if (!recent.has(r.valve)) recent.set(r.valve, []);
        recent.get(r.valve).push(r);
        const cur = latest.get(r.valve);
        if (!cur) { latest.set(r.valve, r); continue; }
        if (!previous.has(r.valve) && cur.acquired_at - r.acquired_at >= 4 * 86400000) previous.set(r.valve, r);
      }
      return { latest, previous, recent };
    },

    async latestOkScene(farmId) {
      const { rows } = await db.query(
        `SELECT fs.scene_id, sc.acquired_at, fs.clear_pct FROM ndvi_farm_scenes fs JOIN ndvi_scenes sc USING (scene_id)
          WHERE fs.farm_id = $1 AND fs.status = 'ok' ORDER BY sc.acquired_at DESC LIMIT 1`, [farmId]);
      return rows[0] || null;
    },

    async sceneRows(farmId, sceneId) {
      const { rows } = await db.query(
        "SELECT * FROM ndvi_history WHERE farm_id = $1 AND scene_id = $2 AND usable ORDER BY valve", [farmId, sceneId]);
      return rows;
    },

    async history(farmId, valve, sinceMs) {
      const { rows } = await db.query(
        `SELECT * FROM ndvi_history WHERE farm_id = $1 AND valve = $2 AND usable AND acquired_at >= $3
          ORDER BY acquired_at`, [farmId, valve, new Date(sinceMs)]);
      return rows;
    },

    async map(farmId, sceneId = null) {
      const { rows } = sceneId
        ? await db.query("SELECT * FROM ndvi_maps WHERE farm_id = $1 AND scene_id = $2", [farmId, sceneId])
        : await db.query("SELECT * FROM ndvi_maps WHERE farm_id = $1 ORDER BY acquired_at DESC LIMIT 1", [farmId]);
      return rows[0] || null;
    },

    async mapDates(farmId) {
      const { rows } = await db.query(
        "SELECT scene_id, acquired_at FROM ndvi_maps WHERE farm_id = $1 ORDER BY acquired_at DESC", [farmId]);
      return rows;
    },

    async status(farmId) {
      const { rows } = await db.query("SELECT * FROM ndvi_status WHERE farm_id = $1", [farmId]);
      return rows[0] || null;
    },

    async sceneSummary(farmId, limit = 15) {
      const { rows: counts } = await db.query(
        "SELECT status, count(*)::int AS n FROM ndvi_farm_scenes WHERE farm_id = $1 GROUP BY status", [farmId]);
      const { rows: recent } = await db.query(
        `SELECT fs.scene_id, sc.acquired_at, sc.cloud_cover, fs.status, fs.clear_pct
           FROM ndvi_farm_scenes fs JOIN ndvi_scenes sc USING (scene_id)
          WHERE fs.farm_id = $1 ORDER BY sc.acquired_at DESC LIMIT $2`, [farmId, limit]);
      return { counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), recent };
    },

    async requestRefresh(farmId) {
      await db.query(
        `INSERT INTO ndvi_status (farm_id, refresh_requested) VALUES ($1, now())
         ON CONFLICT (farm_id) DO UPDATE SET refresh_requested = now()`, [farmId]);
    }
  };
}
