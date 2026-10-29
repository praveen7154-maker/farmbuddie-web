import { pool } from "./postgres.js";

// Production team logins - see production.js. In Postgres on the VPS, not
// Firestore: the password hashes and session tokens never need to be
// readable by the web panel or any app.
export async function ensureProductionSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_users (
      username             TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      password_hash        TEXT NOT NULL,
      active               BOOLEAN NOT NULL DEFAULT true,
      created_by           TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      password_changed_at  TIMESTAMPTZ,
      last_login_at        TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_sessions (
      token_hash  TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS production_sessions_user_idx ON production_sessions (username)`);
}

const USER_COLS = `username, name, password_hash AS "passwordHash", active, created_by AS "createdBy",
  created_at AS "createdAt", password_changed_at AS "passwordChangedAt", last_login_at AS "lastLoginAt"`;

export const pgProductionStore = {
  async listUsers() {
    const { rows } = await pool.query(`SELECT ${USER_COLS} FROM production_users ORDER BY created_at`);
    return rows;
  },
  async getUser(username) {
    const { rows } = await pool.query(`SELECT ${USER_COLS} FROM production_users WHERE username = $1`, [username]);
    return rows[0] || null;
  },
  /** false if the username is already taken (the primary key decides - no race). */
  async createUser({ username, name, passwordHash, createdBy }) {
    const { rowCount } = await pool.query(
      `INSERT INTO production_users (username, name, password_hash, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`, [username, name, passwordHash, createdBy]);
    return rowCount === 1;
  },
  async setPassword(username, passwordHash) {
    await pool.query(`UPDATE production_users SET password_hash = $2, password_changed_at = now() WHERE username = $1`, [username, passwordHash]);
  },
  async setActive(username, active) {
    await pool.query(`UPDATE production_users SET active = $2 WHERE username = $1`, [username, active]);
  },
  async touchLogin(username) {
    await pool.query(`UPDATE production_users SET last_login_at = now() WHERE username = $1`, [username]);
  },
  async createSession(tokenHash, username, expiresAt) {
    await pool.query(`INSERT INTO production_sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`, [tokenHash, username, expiresAt]);
    await pool.query(`DELETE FROM production_sessions WHERE expires_at < now()`);
  },
  async getSession(tokenHash) {
    const { rows } = await pool.query(
      `SELECT username, expires_at AS "expiresAt" FROM production_sessions WHERE token_hash = $1 AND expires_at > now()`, [tokenHash]);
    return rows[0] || null;
  },
  async deleteSession(tokenHash) {
    await pool.query(`DELETE FROM production_sessions WHERE token_hash = $1`, [tokenHash]);
  },
  async deleteSessions(username) {
    await pool.query(`DELETE FROM production_sessions WHERE username = $1`, [username]);
  }
};
