import { pool } from "./postgres.js";

// Distributor logins for the Irrigo Admin app - see distributors.js.
// Kept in Postgres on the VPS, not Firestore: the password hashes and
// session tokens never need to be readable by the web panel or any app.
export async function ensureDistributorSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distributor_accounts (
      distributor_id  TEXT PRIMARY KEY,
      password_hash   TEXT NOT NULL,
      must_change     BOOLEAN NOT NULL DEFAULT false,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distributor_sessions (
      token_hash      TEXT PRIMARY KEY,
      distributor_id  TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at      TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS distributor_sessions_id_idx ON distributor_sessions (distributor_id)`);
  // Push tokens of admin-app installs signed in as a distributor (Farm
  // Buddie Official messages - announcements.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distributor_devices (
      token           TEXT PRIMARY KEY,
      distributor_id  TEXT NOT NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export const pgDistributorStore = {
  async getAccount(id) {
    const { rows } = await pool.query(
      `SELECT password_hash AS "passwordHash", must_change AS "mustChange" FROM distributor_accounts WHERE distributor_id = $1`, [id]);
    return rows[0] || null;
  },
  async setPassword(id, passwordHash, mustChange) {
    await pool.query(
      `INSERT INTO distributor_accounts (distributor_id, password_hash, must_change, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (distributor_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = EXCLUDED.must_change, updated_at = now()`,
      [id, passwordHash, mustChange]);
  },
  async deleteAccount(id) {
    await pool.query(`DELETE FROM distributor_accounts WHERE distributor_id = $1`, [id]);
  },
  async createSession(tokenHash, id, expiresAt) {
    await pool.query(`INSERT INTO distributor_sessions (token_hash, distributor_id, expires_at) VALUES ($1, $2, $3)`, [tokenHash, id, expiresAt]);
    // Old expired sessions go as new ones are made - no separate sweep needed.
    await pool.query(`DELETE FROM distributor_sessions WHERE expires_at < now()`);
  },
  async getSession(tokenHash) {
    const { rows } = await pool.query(
      `SELECT distributor_id AS "distributorId", expires_at AS "expiresAt" FROM distributor_sessions WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash]);
    return rows[0] || null;
  },
  async deleteSession(tokenHash) {
    await pool.query(`DELETE FROM distributor_sessions WHERE token_hash = $1`, [tokenHash]);
  },
  // One install = one token; signing in as another distributor moves it.
  async saveDevice(token, id) {
    await pool.query(
      `INSERT INTO distributor_devices (token, distributor_id, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (token) DO UPDATE SET distributor_id = EXCLUDED.distributor_id, updated_at = now()`, [token, id]);
  },
  async removeDevices(tokens) {
    if (tokens.length) await pool.query(`DELETE FROM distributor_devices WHERE token = ANY($1::text[])`, [tokens]);
  },
  async removeDevicesOf(id) {
    await pool.query(`DELETE FROM distributor_devices WHERE distributor_id = $1`, [id]);
  },
  async devices() {
    const { rows } = await pool.query(`SELECT token, distributor_id AS "distributorId" FROM distributor_devices`);
    return rows;
  },

  // Every session of this distributor except the one given (null = all).
  async deleteSessions(id, exceptHash = null) {
    await pool.query(`DELETE FROM distributor_sessions WHERE distributor_id = $1 AND ($2::text IS NULL OR token_hash <> $2)`, [id, exceptHash]);
  }
};
