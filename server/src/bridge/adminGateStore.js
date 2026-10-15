import { pool } from "./postgres.js";

// The Irrigo Admin app's admin access code - see adminGate.js. One row.
export async function ensureAdminGateSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_gate (
      id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      code_hash   TEXT NOT NULL,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export const pgAdminGateStore = {
  async get() {
    const { rows } = await pool.query(
      `SELECT code_hash AS "codeHash", updated_by AS "updatedBy", updated_at AS "updatedAt" FROM admin_gate WHERE id = 1`);
    return rows[0] || null;
  },
  async set(codeHash, updatedBy) {
    await pool.query(
      `INSERT INTO admin_gate (id, code_hash, updated_by, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET code_hash = EXCLUDED.code_hash, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [codeHash, updatedBy]);
  }
};
