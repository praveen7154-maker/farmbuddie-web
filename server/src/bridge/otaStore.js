import { pool } from "./postgres.js";

// Postgres storage for web-panel OTA (see ota.js). Firmware images live in
// the bridge's own database (bytea, ~1.2 MB each), so there's no extra disk
// volume to manage on the VPS.

// A status only counts toward a release sent in this window - an old
// release never picks up a later, unrelated update's messages.
const STATUS_MATCH_WINDOW = "2 days";

export async function ensureOtaSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ota_firmware (
      sha256       TEXT PRIMARY KEY,
      version      TEXT NOT NULL,
      size         INTEGER NOT NULL,
      data         BYTEA NOT NULL,
      uploaded_by  TEXT,
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ota_releases (
      id          BIGSERIAL PRIMARY KEY,
      sha256      TEXT NOT NULL,
      version     TEXT NOT NULL,
      url         TEXT NOT NULL,
      signature   TEXT NOT NULL,
      mode        TEXT NOT NULL,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ota_release_targets (
      release_id  BIGINT NOT NULL REFERENCES ota_releases(id) ON DELETE CASCADE,
      farm_id     TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'sent',
      percent     INTEGER,
      error       TEXT,
      transport   TEXT,
      fw_version  TEXT,
      attempts    INTEGER NOT NULL DEFAULT 1,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (release_id, farm_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ota_release_targets_farm_idx ON ota_release_targets (farm_id, sent_at DESC)`);
}

const targetCols = `farm_id AS "farmId", node_id AS "nodeId", state, percent, error, transport,
  fw_version AS "fwVersion", attempts, sent_at AS "sentAt", updated_at AS "updatedAt"`;
const releaseCols = `id, sha256, version, url, signature, mode, created_by AS "createdBy", created_at AS "createdAt"`;

export const pgOtaStore = {
  async saveFirmware({ sha256, version, size, data, uploadedBy }) {
    await pool.query(
      `INSERT INTO ota_firmware (sha256, version, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha256) DO UPDATE SET version = EXCLUDED.version, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [sha256, version, size, data, uploadedBy]
    );
  },

  async getFirmwareMeta(sha256) {
    const { rows } = await pool.query(`SELECT sha256, version, size FROM ota_firmware WHERE sha256 = $1`, [sha256]);
    return rows[0] || null;
  },

  async getFirmwareData(sha256) {
    const { rows } = await pool.query(`SELECT data FROM ota_firmware WHERE sha256 = $1`, [sha256]);
    return rows[0]?.data || null;
  },

  async createRelease(release, targets, at) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO ota_releases (sha256, version, url, signature, mode, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [release.sha256, release.version, release.url, release.signature, release.mode, release.createdBy, at]
      );
      const id = rows[0].id;
      for (const t of targets) {
        await client.query(
          `INSERT INTO ota_release_targets (release_id, farm_id, node_id, sent_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
          [id, t.farmId, t.nodeId, at]
        );
      }
      await client.query("COMMIT");
      return Number(id);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async getRelease(id) {
    if (!Number.isFinite(id)) return null;
    const { rows } = await pool.query(`SELECT ${releaseCols} FROM ota_releases WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    const t = await pool.query(`SELECT ${targetCols} FROM ota_release_targets WHERE release_id = $1 ORDER BY farm_id`, [id]);
    return { release: { ...rows[0], id: Number(rows[0].id) }, targets: t.rows };
  },

  async listReleases(limit) {
    const { rows } = await pool.query(`SELECT ${releaseCols} FROM ota_releases ORDER BY id DESC LIMIT $1`, [limit]);
    const out = [];
    for (const r of rows) {
      const t = await pool.query(`SELECT state, error FROM ota_release_targets WHERE release_id = $1`, [r.id]);
      out.push({ release: { ...r, id: Number(r.id) }, targets: t.rows });
    }
    return out;
  },

  async markSent(releaseId, farmIds, at) {
    await pool.query(
      `UPDATE ota_release_targets SET state = 'sent', percent = NULL, error = NULL, attempts = attempts + 1,
         sent_at = $3, updated_at = $3
       WHERE release_id = $1 AND farm_id = ANY($2)`,
      [releaseId, farmIds, at]
    );
  },

  // The newest recent release this farm was sent that matches the status's
  // version (the hub reports the version it was asked to install; a
  // failure noticed after a reboot carries it too).
  async recordStatus(farmId, payload, at) {
    const version = typeof payload.version === "string" ? payload.version : null;
    await pool.query(
      `UPDATE ota_release_targets t SET state = $3, percent = $4, error = $5, transport = COALESCE($6, t.transport),
         fw_version = $7, updated_at = $8
       WHERE (t.release_id, t.farm_id) = (
         SELECT t2.release_id, t2.farm_id FROM ota_release_targets t2 JOIN ota_releases r ON r.id = t2.release_id
         WHERE t2.farm_id = $1 AND ($2::text IS NULL OR r.version = $2)
           AND t2.sent_at > $8::timestamptz - interval '${STATUS_MATCH_WINDOW}'
         ORDER BY t2.sent_at DESC LIMIT 1)`,
      [farmId, version, payload.state, Number.isFinite(payload.percent) ? payload.percent : null,
        payload.error || null, payload.transport || null, payload.fw_version || null, at]
    );
  }
};
