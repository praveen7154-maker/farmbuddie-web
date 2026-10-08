import { pool } from "./postgres.js";

// Postgres storage for Message Broadcast (see announcements.js).
//
// A row is visible to farmers once sent_at is set (immediately, or by the
// scheduler at send_at), until it expires or is recalled (deleted_at).
// audience 'all' reaches every farm, including ones added later; 'farms'
// only the farm_ids listed.

export async function ensureAnnouncementSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id              BIGSERIAL PRIMARY KEY,
      category        TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      title_ta        TEXT,
      body_ta         TEXT,
      important       BOOLEAN NOT NULL DEFAULT false,
      audience        TEXT NOT NULL,
      farm_ids        TEXT[],
      send_at         TIMESTAMPTZ,
      sent_at         TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ,
      deleted_at      TIMESTAMPTZ,
      deleted_by      TEXT,
      target_farms    INTEGER,
      target_phones   INTEGER,
      target_devices  INTEGER,
      push_ok         INTEGER,
      push_failed     INTEGER,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS announcements_sent_idx ON announcements (sent_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id  BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      phone            TEXT NOT NULL,
      read_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (announcement_id, phone)
    )
  `);
}

const status = `CASE WHEN deleted_at IS NOT NULL THEN 'recalled' WHEN sent_at IS NULL THEN 'scheduled' ELSE 'sent' END`;
const adminCols = `id, category, title, body, title_ta AS "titleTa", body_ta AS "bodyTa", important, audience,
  farm_ids AS "farmIds", send_at AS "sendAt", sent_at AS "sentAt", expires_at AS "expiresAt",
  deleted_at AS "deletedAt", deleted_by AS "deletedBy", target_farms AS "targetFarms",
  target_phones AS "targetPhones", target_devices AS "targetDevices", push_ok AS "pushOk",
  push_failed AS "pushFailed", created_by AS "createdBy", created_at AS "createdAt", ${status} AS status,
  (SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS "readCount"`;
// What a farmer's phone gets - no admin bookkeeping.
const feedCols = `id, category, title, body, title_ta AS "titleTa", body_ta AS "bodyTa", important,
  sent_at AS "sentAt", expires_at AS "expiresAt"`;
const statusWhere = {
  sent: "deleted_at IS NULL AND sent_at IS NOT NULL",
  scheduled: "deleted_at IS NULL AND sent_at IS NULL",
  recalled: "deleted_at IS NOT NULL"
};
// Visible in a feed: sent, not recalled, not expired, and for this farm list
// ($1 text[]) - or everything when $1 is NULL (an admin).
const visibleWhere = `deleted_at IS NULL AND sent_at IS NOT NULL AND (expires_at IS NULL OR expires_at > now())
  AND ($1::text[] IS NULL OR audience = 'all' OR farm_ids && $1::text[])`;

const toId = (id) => (/^\d{1,18}$/.test(String(id)) ? String(id) : null);

export const pgAnnouncementStore = {
  async create(a) {
    const { rows } = await pool.query(
      `INSERT INTO announcements (category, title, body, title_ta, body_ta, important, audience, farm_ids, send_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [a.category, a.title, a.body, a.titleTa, a.bodyTa, a.important, a.audience, a.farmIds, a.sendAt, a.expiresAt, a.createdBy]
    );
    return Number(rows[0].id);
  },

  // Marks it sent - atomically, so the scheduler and a request can't both send it.
  async claim(id) {
    const { rows } = await pool.query(
      `UPDATE announcements SET sent_at = now() WHERE id = $1 AND sent_at IS NULL AND deleted_at IS NULL
       RETURNING id, category, title, body, important, audience, farm_ids AS "farmIds"`,
      [id]
    );
    return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
  },

  async recordDelivery(id, s) {
    await pool.query(
      `UPDATE announcements SET target_farms = $2, target_phones = $3, target_devices = $4, push_ok = $5, push_failed = $6
       WHERE id = $1`,
      [id, s.targetFarms, s.targetPhones, s.targetDevices, s.pushOk, s.pushFailed]
    );
  },

  async dueIds() {
    const { rows } = await pool.query(
      `SELECT id FROM announcements WHERE sent_at IS NULL AND deleted_at IS NULL AND send_at <= now() ORDER BY send_at LIMIT 20`
    );
    return rows.map((r) => Number(r.id));
  },

  async list(limit, offset, st) {
    const where = st ? `WHERE ${statusWhere[st]}` : "";
    const { rows } = await pool.query(
      `SELECT ${adminCols} FROM announcements a ${where}
       ORDER BY COALESCE(sent_at, send_at, created_at) DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  },

  async count(st) {
    const where = st ? `WHERE ${statusWhere[st]}` : "";
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM announcements ${where}`);
    return rows[0].n;
  },

  async get(id) {
    if (!toId(id)) return null;
    const { rows } = await pool.query(`SELECT ${adminCols} FROM announcements a WHERE id = $1`, [toId(id)]);
    return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
  },

  async reads(id) {
    const { rows } = await pool.query(
      `SELECT phone, read_at AS "readAt" FROM announcement_reads WHERE announcement_id = $1 ORDER BY read_at DESC LIMIT 1000`,
      [id]
    );
    return rows;
  },

  async recall(id, by) {
    if (!toId(id)) return false;
    const { rowCount } = await pool.query(
      `UPDATE announcements SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`,
      [toId(id), by]
    );
    return rowCount > 0;
  },

  // farmIds null = admin (everything). phone = '' for an admin (nothing read).
  async feed(farmIds, phone, limit, maxAgeDays) {
    const { rows } = await pool.query(
      `SELECT ${feedCols}, EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.phone = $2) AS read
       FROM announcements a
       WHERE ${visibleWhere} AND sent_at > now() - make_interval(days => $4)
       ORDER BY sent_at DESC, id DESC LIMIT $3`,
      [farmIds, phone || "", limit, maxAgeDays]
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  },

  async visibleIds(ids, farmIds) {
    const { rows } = await pool.query(`SELECT id FROM announcements WHERE ${visibleWhere} AND id = ANY($2::bigint[])`, [farmIds, ids]);
    return rows.map((r) => Number(r.id));
  },

  async markRead(ids, phone) {
    await pool.query(
      `INSERT INTO announcement_reads (announcement_id, phone) SELECT unnest($1::bigint[]), $2 ON CONFLICT DO NOTHING`,
      [ids, phone]
    );
  }
};
