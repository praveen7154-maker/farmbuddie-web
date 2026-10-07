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
  // Node images (motor-node / valve / filter-backwash) - see ota.js.
  await pool.query(`ALTER TABLE ota_firmware ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'hub'`);
  await pool.query(`ALTER TABLE ota_releases ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'hub'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ota_node_status (
      release_id  BIGINT NOT NULL REFERENCES ota_releases(id) ON DELETE CASCADE,
      farm_id     TEXT NOT NULL,
      node        TEXT NOT NULL,
      product     TEXT NOT NULL,
      state       TEXT NOT NULL,
      percent     INTEGER,
      error       TEXT,
      version     TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (release_id, farm_id, node)
    )
  `);
}

const targetCols = `farm_id AS "farmId", node_id AS "nodeId", state, percent, error, transport,
  fw_version AS "fwVersion", attempts, sent_at AS "sentAt", updated_at AS "updatedAt"`;
const releaseCols = `id, sha256, version, product, url, signature, mode, created_by AS "createdBy", created_at AS "createdAt"`;
const nodeCols = `farm_id AS "farmId", node, product, state, percent, error, version, updated_at AS "updatedAt"`;

export const pgOtaStore = {
  async saveFirmware({ sha256, version, product = "hub", size, data, uploadedBy }) {
    await pool.query(
      `INSERT INTO ota_firmware (sha256, version, product, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sha256) DO UPDATE SET version = EXCLUDED.version, product = EXCLUDED.product,
         uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [sha256, version, product, size, data, uploadedBy]
    );
  },

  async getFirmwareMeta(sha256) {
    const { rows } = await pool.query(`SELECT sha256, version, product, size FROM ota_firmware WHERE sha256 = $1`, [sha256]);
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
        `INSERT INTO ota_releases (sha256, version, product, url, signature, mode, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [release.sha256, release.version, release.product || "hub", release.url, release.signature, release.mode,
          release.createdBy, at]
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
    const n = await pool.query(`SELECT ${nodeCols} FROM ota_node_status WHERE release_id = $1 ORDER BY farm_id, node`, [id]);
    return { release: { ...rows[0], id: Number(rows[0].id) }, targets: t.rows, nodes: n.rows };
  },

  // Newest first, one page at a time; product = null for every kind.
  async listReleases(limit, offset = 0, product = null) {
    const { rows } = await pool.query(
      `SELECT ${releaseCols} FROM ota_releases WHERE ($3::text IS NULL OR product = $3)
       ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset, product]
    );
    const out = [];
    for (const r of rows) {
      const t = await pool.query(`SELECT state, error FROM ota_release_targets WHERE release_id = $1`, [r.id]);
      const n = r.product && r.product !== "hub"
        ? (await pool.query(`SELECT state FROM ota_node_status WHERE release_id = $1`, [r.id])).rows
        : [];
      out.push({ release: { ...r, id: Number(r.id) }, targets: t.rows, nodes: n });
    }
    return out;
  },

  async countReleases(product = null) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ota_releases WHERE ($1::text IS NULL OR product = $1)`, [product]);
    return rows[0].n;
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
    // A hub's own update vs. its staging step for a node image (that one
    // carries "product") - never mixed up even at the same version number.
    const product = typeof payload.product === "string" && payload.product ? payload.product : "hub";
    await pool.query(
      `UPDATE ota_release_targets t SET state = $3, percent = $4, error = $5, transport = COALESCE($6, t.transport),
         fw_version = $7, updated_at = $8
       WHERE (t.release_id, t.farm_id) = (
         SELECT t2.release_id, t2.farm_id FROM ota_release_targets t2 JOIN ota_releases r ON r.id = t2.release_id
         WHERE t2.farm_id = $1 AND ($2::text IS NULL OR r.version = $2) AND r.product = $9
           AND t2.sent_at > $8::timestamptz - interval '${STATUS_MATCH_WINDOW}'
         ORDER BY t2.sent_at DESC LIMIT 1)`,
      [farmId, version, payload.state, Number.isFinite(payload.percent) ? payload.percent : null,
        payload.error || null, payload.transport || null, payload.fw_version || null, at, product]
    );
  },

  // One node's progress, against the newest recent release of that product
  // sent to this farm. Matched on product only: a node that rolled back
  // reports its old version, not the release's.
  async recordNodeStatus(farmId, payload, at) {
    const product = typeof payload.product === "string" ? payload.product : "";
    if (!product || product === "hub") return;
    await pool.query(
      `INSERT INTO ota_node_status (release_id, farm_id, node, product, state, percent, error, version, updated_at)
       SELECT t.release_id, $1, $2, $3, $4, $5, $6, $7, $8
         FROM ota_release_targets t JOIN ota_releases r ON r.id = t.release_id
        WHERE t.farm_id = $1 AND r.product = $3
          AND t.sent_at > $8::timestamptz - interval '${STATUS_MATCH_WINDOW}'
        ORDER BY t.sent_at DESC LIMIT 1
       ON CONFLICT (release_id, farm_id, node) DO UPDATE SET state = EXCLUDED.state, percent = EXCLUDED.percent,
         error = EXCLUDED.error, version = COALESCE(EXCLUDED.version, ota_node_status.version), updated_at = EXCLUDED.updated_at`,
      [farmId, String(payload.node).slice(0, 32), product, payload.state,
        Number.isFinite(payload.percent) ? payload.percent : null, payload.error || null,
        typeof payload.version === "string" ? payload.version : null, at]
    );
  }
};
