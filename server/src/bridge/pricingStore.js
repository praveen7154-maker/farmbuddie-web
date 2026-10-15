import { pool } from "./postgres.js";

// Postgres storage for Module Pricing (see pricing.js / pricingRules.js).
//
// Catalogue: products -> variants (a product always has at least one) and
// accessory links. Prices live in versioned price lists: a list is edited
// only while it's a draft; once approved its rows never change - that's the
// price history. A published list is scheduled / active / expired by its
// dates (pricingRules.liveStatus); only one published list per segment may
// cover any moment. Quotes keep a full copy of the lines they were priced
// with. pricing_audit is append-only.

export async function ensurePricingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_products (
      id           SERIAL PRIMARY KEY,
      sku          TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL,
      role         TEXT,
      kind         TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'service')),
      unit         TEXT NOT NULL DEFAULT 'pcs',
      hsn_sac      TEXT,
      gst_bp       INTEGER NOT NULL DEFAULT 1800 CHECK (gst_bp BETWEEN 0 AND 4000),
      description  TEXT,
      active       BOOLEAN NOT NULL DEFAULT true,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      updated_by   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_variants (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER NOT NULL REFERENCES pricing_products(id),
      sku          TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      attributes   JSONB NOT NULL DEFAULT '{}',
      active       BOOLEAN NOT NULL DEFAULT true,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      updated_by   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_accessories (
      product_id            INTEGER NOT NULL REFERENCES pricing_products(id),
      accessory_variant_id  INTEGER NOT NULL REFERENCES pricing_variants(id),
      mode                  TEXT NOT NULL CHECK (mode IN ('required', 'optional')),
      qty_per               INTEGER NOT NULL DEFAULT 1 CHECK (qty_per >= 1),
      per_units             INTEGER NOT NULL DEFAULT 1 CHECK (per_units >= 1),
      PRIMARY KEY (product_id, accessory_variant_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_lists (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      segment         TEXT NOT NULL DEFAULT 'standard',
      status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'published', 'cancelled')),
      effective_from  TIMESTAMPTZ,
      effective_to    TIMESTAMPTZ,
      notes           TEXT,
      based_on_id     INTEGER REFERENCES price_lists(id),
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_by    TEXT,
      submitted_at    TIMESTAMPTZ,
      approved_by     TEXT,
      approved_at     TIMESTAMPTZ,
      published_by    TEXT,
      published_at    TIMESTAMPTZ,
      reject_reason   TEXT,
      CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_list_items (
      list_id            INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
      variant_id         INTEGER NOT NULL REFERENCES pricing_variants(id),
      active             BOOLEAN NOT NULL DEFAULT true,
      mrp                BIGINT CHECK (mrp >= 0),
      distributor_price  BIGINT CHECK (distributor_price >= 0),
      base_price         BIGINT CHECK (base_price >= 0),
      min_price          BIGINT CHECK (min_price >= 0),
      max_price          BIGINT CHECK (max_price >= 0),
      max_discount_type  TEXT NOT NULL DEFAULT 'pct' CHECK (max_discount_type IN ('pct', 'amt')),
      max_discount_value BIGINT NOT NULL DEFAULT 0 CHECK (max_discount_value >= 0),
      gst_bp             INTEGER NOT NULL DEFAULT 1800 CHECK (gst_bp BETWEEN 0 AND 4000),
      PRIMARY KEY (list_id, variant_id)
    )
  `);
  // Farm Buddie's own purchase cost per unit (before GST) - for our profit
  // figures; never sent to distributors (see pricing.js).
  await pool.query(`ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS cost_price BIGINT CHECK (cost_price >= 0)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_quotes (
      id              SERIAL PRIMARY KEY,
      quote_no        TEXT NOT NULL UNIQUE,
      list_id         INTEGER NOT NULL REFERENCES price_lists(id),
      segment         TEXT NOT NULL DEFAULT 'standard',
      created_by      TEXT NOT NULL,
      distributor_id  TEXT,
      customer_name   TEXT,
      customer_phone  TEXT,
      customer_place  TEXT,
      customer_state  TEXT,
      notes           TEXT,
      lines           JSONB NOT NULL,
      totals          JSONB NOT NULL,
      valid_until     TIMESTAMPTZ NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled')),
      status_by       TEXT,
      status_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pricing_quotes_dist_idx ON pricing_quotes (distributor_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_audit (
      id          BIGSERIAL PRIMARY KEY,
      at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      entity      TEXT NOT NULL,
      entity_id   TEXT,
      summary     TEXT,
      before      JSONB,
      after       JSONB,
      ip          TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pricing_audit_at_idx ON pricing_audit (at DESC)`);
  // The database refuses to edit the log, and to delete from it except
  // through deleteAudit() (an admin's explicit "delete", which itself is
  // logged) - it sets pricing.audit_purge for its own transaction only.
  await pool.query(`
    CREATE OR REPLACE FUNCTION pricing_audit_readonly() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('pricing.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'pricing_audit is append-only';
    END $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS pricing_audit_readonly ON pricing_audit`);
  await pool.query(`
    CREATE TRIGGER pricing_audit_readonly BEFORE UPDATE OR DELETE ON pricing_audit
    FOR EACH ROW EXECUTE FUNCTION pricing_audit_readonly()
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_staff (
      email       TEXT PRIMARY KEY,
      role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'approver')),
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_settings (
      id        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      settings  JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`INSERT INTO pricing_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  // A price list can be deleted outright: quotes keep their own copy of the
  // prices (list_id becomes NULL), lists copied from it just lose the link.
  await pool.query(`ALTER TABLE pricing_quotes ALTER COLUMN list_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE pricing_quotes DROP CONSTRAINT IF EXISTS pricing_quotes_list_id_fkey`);
  await pool.query(`ALTER TABLE pricing_quotes ADD CONSTRAINT pricing_quotes_list_id_fkey
    FOREIGN KEY (list_id) REFERENCES price_lists(id) ON DELETE SET NULL`);
  // The number people see (v1, v2...): the next after the highest one left,
  // so deleting old versions doesn't leave the count running on (the
  // internal id still does).
  await pool.query(`ALTER TABLE price_lists ADD COLUMN IF NOT EXISTS version_no INTEGER`);
  await pool.query(`
    UPDATE price_lists p SET version_no = r.n + (SELECT COALESCE(MAX(version_no), 0) FROM price_lists)
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM price_lists WHERE version_no IS NULL) r
    WHERE p.id = r.id
  `);
  await pool.query(`ALTER TABLE price_lists DROP CONSTRAINT IF EXISTS price_lists_based_on_id_fkey`);
  await pool.query(`ALTER TABLE price_lists ADD CONSTRAINT price_lists_based_on_id_fkey
    FOREIGN KEY (based_on_id) REFERENCES price_lists(id) ON DELETE SET NULL`);
  await seedCatalogue();
}

// The starting catalogue - only on an empty table. Everything here can be
// edited in the web panel; no prices are set (the first price list does that).
const SEED = [
  { sku: "FB-HUB", name: "Motor Master Hub", category: "controller", role: "hub",
    description: "Main controller - runs the farm's motor and valves, WiFi/GSM to the cloud" },
  { sku: "FB-MN", name: "Motor Node", category: "node", role: "motor_node", description: "Controls one more motor (Motor 2, 3 or 4)" },
  { sku: "FB-VNS", name: "Valve Node - 24V AC Solenoid", category: "node", role: "valve_node",
    description: "Drives 24V AC solenoid valves",
    variants: [{ sku: "FB-VNS-4", name: "4 channel", attributes: { channels: 4, valveType: "solenoid24" } },
      { sku: "FB-VNS-8", name: "8 channel", attributes: { channels: 8, valveType: "solenoid24" } }] },
  { sku: "FB-VNB", name: "Valve Node - 230V AC Butterfly", category: "node", role: "valve_node",
    description: "Drives 230V AC motorised butterfly valves",
    variants: [{ sku: "FB-VNB-4", name: "4 channel", attributes: { channels: 4, valveType: "butterfly230" } },
      { sku: "FB-VNB-8", name: "8 channel", attributes: { channels: 8, valveType: "butterfly230" } }] },
  { sku: "FB-AFB", name: "Auto Filter Backwash System", category: "system", role: "backwash", description: "Automatic filter flushing" },
  { sku: "FB-SV24", name: "24V AC Solenoid Valve", category: "valve", role: "valve", attributes: { valveType: "solenoid24" } },
  { sku: "FB-BV230", name: "230V AC Butterfly Valve", category: "valve", role: "valve", attributes: { valveType: "butterfly230" } },
  { sku: "FB-TR2A", name: "230V-24V AC 2A Transformer", category: "power", role: "transformer", description: "Powers a solenoid valve node" },
  { sku: "FB-ANT", name: "Antenna Extension Cable", category: "accessory", role: "antenna" },
  { sku: "FB-BAT", name: "Lithium Battery", category: "power", role: "battery" },
  { sku: "FB-LSV9", name: "9V DC Latching Solenoid Valve", category: "valve", role: "valve", attributes: { valveType: "latching9" } },
  { sku: "FB-INST-SITE", name: "Installation - per site", category: "service", role: "install_site", kind: "service", unit: "site" },
  { sku: "FB-INST-POINT", name: "Installation - per valve point", category: "service", role: "install_point", kind: "service", unit: "point" },
  { sku: "FB-TRANSPORT", name: "Transport", category: "service", role: "transport", kind: "service", unit: "trip" }
];

async function seedCatalogue() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pricing_products`);
  if (rows[0].n > 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let order = 0;
    for (const p of SEED) {
      order += 10;
      const r = await client.query(
        `INSERT INTO pricing_products (sku, name, category, role, kind, unit, description, sort_order, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'setup') RETURNING id`,
        [p.sku, p.name, p.category, p.role, p.kind || "goods", p.unit || "pcs", p.description || null, order]
      );
      const variants = p.variants || [{ sku: p.sku, name: "Standard", attributes: p.attributes || {} }];
      let vo = 0;
      for (const v of variants) {
        vo += 10;
        await client.query(
          `INSERT INTO pricing_variants (product_id, sku, name, attributes, sort_order, updated_by) VALUES ($1, $2, $3, $4, $5, 'setup')`,
          [r.rows[0].id, v.sku, v.name, v.attributes, vo]
        );
      }
    }
    // A solenoid valve node needs its own transformer; the hub can take an
    // antenna extension. Editable in Products.
    await client.query(`
      INSERT INTO pricing_accessories (product_id, accessory_variant_id, mode)
      SELECT p.id, v.id, 'required' FROM pricing_products p, pricing_variants v WHERE p.sku = 'FB-VNS' AND v.sku = 'FB-TR2A'
      UNION ALL
      SELECT p.id, v.id, 'optional' FROM pricing_products p, pricing_variants v WHERE p.sku = 'FB-HUB' AND v.sku = 'FB-ANT'
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---- row shapes ----

const num = (v) => (v === null || v === undefined ? null : Number(v));
const productCols = `id, sku, name, category, role, kind, unit, hsn_sac AS "hsnSac", gst_bp AS "gstBp", description, active,
  sort_order AS "sortOrder", updated_by AS "updatedBy", updated_at AS "updatedAt"`;
const variantCols = `id, product_id AS "productId", sku, name, attributes, active, sort_order AS "sortOrder"`;
const listCols = `id, version_no AS "versionNo", name, segment, status, effective_from AS "effectiveFrom", effective_to AS "effectiveTo", notes,
  based_on_id AS "basedOnId", created_by AS "createdBy", created_at AS "createdAt", submitted_by AS "submittedBy",
  submitted_at AS "submittedAt", approved_by AS "approvedBy", approved_at AS "approvedAt", published_by AS "publishedBy",
  published_at AS "publishedAt", reject_reason AS "rejectReason"`;
const toItem = (r) => ({
  listId: r.list_id,
  variantId: r.variant_id,
  active: r.active,
  mrp: num(r.mrp),
  distributorPrice: num(r.distributor_price),
  costPrice: num(r.cost_price),
  basePrice: num(r.base_price),
  minPrice: num(r.min_price),
  maxPrice: num(r.max_price),
  maxDiscountType: r.max_discount_type,
  maxDiscountValue: num(r.max_discount_value),
  gstBp: r.gst_bp
});
const quoteCols = `id, quote_no AS "quoteNo", list_id AS "listId", segment, created_by AS "createdBy", distributor_id AS "distributorId",
  customer_name AS "customerName", customer_phone AS "customerPhone", customer_place AS "customerPlace",
  customer_state AS "customerState", notes, lines, totals, valid_until AS "validUntil", status, status_by AS "statusBy",
  status_at AS "statusAt", created_at AS "createdAt"`;

// Runs fn(client) in one transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const pgPricingStore = {
  // ---- catalogue ----
  async catalogue() {
    const [p, v, a] = await Promise.all([
      pool.query(`SELECT ${productCols} FROM pricing_products ORDER BY sort_order, id`),
      pool.query(`SELECT ${variantCols} FROM pricing_variants ORDER BY sort_order, id`),
      pool.query(`SELECT product_id AS "productId", accessory_variant_id AS "accessoryVariantId", mode, qty_per AS "qtyPer",
        per_units AS "perUnits" FROM pricing_accessories`)
    ]);
    return { products: p.rows, variants: v.rows, accessories: a.rows };
  },

  async getProduct(id) {
    const { rows } = await pool.query(`SELECT ${productCols} FROM pricing_products WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  async getVariant(id) {
    const { rows } = await pool.query(`SELECT ${variantCols} FROM pricing_variants WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  // A SKU names one thing: another product, or a variant of another
  // product (a product's own variants share its SKU space - the database's
  // UNIQUE on variants catches two variants with one SKU).
  async skuTaken(sku, productId = null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pricing_products WHERE sku = $1 AND id IS DISTINCT FROM $2
       UNION ALL SELECT 1 FROM pricing_variants WHERE sku = $1 AND product_id IS DISTINCT FROM $2 LIMIT 1`,
      [sku, productId]
    );
    return rows.length > 0;
  },

  // A new product comes with its first variant (same SKU) unless variants are given.
  async createProduct(p, variants, by) {
    return tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO pricing_products (sku, name, category, role, kind, unit, hsn_sac, gst_bp, description, active, sort_order, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [p.sku, p.name, p.category, p.role, p.kind, p.unit, p.hsnSac, p.gstBp, p.description, p.active, p.sortOrder, by]
      );
      const id = rows[0].id;
      for (const v of variants) {
        await c.query(
          `INSERT INTO pricing_variants (product_id, sku, name, attributes, active, sort_order, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, v.sku, v.name, v.attributes, v.active, v.sortOrder, by]
        );
      }
      return id;
    });
  },

  async updateProduct(id, p, by) {
    await pool.query(
      `UPDATE pricing_products SET sku = $2, name = $3, category = $4, role = $5, kind = $6, unit = $7, hsn_sac = $8, gst_bp = $9,
         description = $10, active = $11, sort_order = $12, updated_by = $13, updated_at = now() WHERE id = $1`,
      [id, p.sku, p.name, p.category, p.role, p.kind, p.unit, p.hsnSac, p.gstBp, p.description, p.active, p.sortOrder, by]
    );
  },

  async createVariant(productId, v, by) {
    const { rows } = await pool.query(
      `INSERT INTO pricing_variants (product_id, sku, name, attributes, active, sort_order, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [productId, v.sku, v.name, v.attributes, v.active, v.sortOrder, by]
    );
    return rows[0].id;
  },

  async updateVariant(id, v, by) {
    await pool.query(
      `UPDATE pricing_variants SET sku = $2, name = $3, attributes = $4, active = $5, sort_order = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
      [id, v.sku, v.name, v.attributes, v.active, v.sortOrder, by]
    );
  },

  async setAccessories(productId, links) {
    await tx(async (c) => {
      await c.query(`DELETE FROM pricing_accessories WHERE product_id = $1`, [productId]);
      for (const a of links) {
        await c.query(
          `INSERT INTO pricing_accessories (product_id, accessory_variant_id, mode, qty_per, per_units) VALUES ($1, $2, $3, $4, $5)`,
          [productId, a.accessoryVariantId, a.mode, a.qtyPer, a.perUnits]
        );
      }
    });
  },

  // ---- price lists ----
  async lists() {
    const { rows } = await pool.query(
      `SELECT ${listCols}, (SELECT count(*)::int FROM price_list_items i WHERE i.list_id = l.id AND i.active) AS "itemCount"
       FROM price_lists l ORDER BY id DESC`
    );
    return rows;
  },

  async getList(id) {
    const { rows } = await pool.query(`SELECT ${listCols} FROM price_lists WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  async items(listId) {
    const { rows } = await pool.query(`SELECT * FROM price_list_items WHERE list_id = $1`, [listId]);
    return rows.map(toItem);
  },

  /**
   * A new draft: a copy of basedOnId's rows (if given), plus an empty row for
   * every active variant the copy doesn't have, GST from the product.
   */
  async createDraft({ name, segment, notes, basedOnId }, by) {
    return tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('price_lists_version'))`);
      const { rows } = await c.query(
        `INSERT INTO price_lists (name, segment, notes, based_on_id, created_by, version_no)
         VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(version_no), 0) + 1 FROM price_lists)) RETURNING id`,
        [name, segment, notes, basedOnId, by]
      );
      const id = rows[0].id;
      if (basedOnId) {
        await c.query(
          `INSERT INTO price_list_items (list_id, variant_id, active, mrp, distributor_price, base_price, min_price, max_price,
             max_discount_type, max_discount_value, gst_bp, cost_price)
           SELECT $1, variant_id, active, mrp, distributor_price, base_price, min_price, max_price, max_discount_type, max_discount_value, gst_bp, cost_price
           FROM price_list_items WHERE list_id = $2`,
          [id, basedOnId]
        );
      }
      await c.query(
        `INSERT INTO price_list_items (list_id, variant_id, gst_bp)
         SELECT $1, v.id, p.gst_bp FROM pricing_variants v JOIN pricing_products p ON p.id = v.product_id
         WHERE v.active AND p.active ON CONFLICT DO NOTHING`,
        [id]
      );
      return id;
    });
  },

  /** Max discount = farmer selling price - minimum price, on every priced row of a draft. */
  async normalizeDiscounts(listId) {
    await pool.query(
      `UPDATE price_list_items i SET max_discount_type = 'amt', max_discount_value = GREATEST(0, base_price - min_price)
       FROM price_lists l WHERE l.id = i.list_id AND l.id = $1 AND l.status = 'draft'
         AND base_price IS NOT NULL AND min_price IS NOT NULL`,
      [listId]
    );
  },

  // Draft-only edits: the WHERE status = 'draft' is the lock.
  async updateDraft(id, { name, notes, effectiveFrom, effectiveTo }) {
    const { rowCount } = await pool.query(
      `UPDATE price_lists SET name = $2, notes = $3, effective_from = $4, effective_to = $5 WHERE id = $1 AND status = 'draft'`,
      [id, name, notes, effectiveFrom, effectiveTo]
    );
    return rowCount === 1;
  },

  async saveDraftItems(id, items) {
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT status FROM price_lists WHERE id = $1 FOR UPDATE`, [id]);
      if (rows[0]?.status !== "draft") return false;
      for (const i of items) {
        await c.query(
          `INSERT INTO price_list_items (list_id, variant_id, active, mrp, distributor_price, base_price, min_price, max_price,
             max_discount_type, max_discount_value, gst_bp, cost_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (list_id, variant_id) DO UPDATE SET active = $3, mrp = $4, distributor_price = $5, base_price = $6,
             min_price = $7, max_price = $8, max_discount_type = $9, max_discount_value = $10, gst_bp = $11, cost_price = $12`,
          [id, i.variantId, i.active, i.mrp, i.distributorPrice, i.basePrice, i.minPrice, i.maxPrice, i.maxDiscountType, i.maxDiscountValue, i.gstBp,
            i.costPrice ?? null]
        );
      }
      return true;
    });
  },

  /** Any list, any status. Returns its quote count (they keep their prices). */
  async deleteList(id) {
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM pricing_quotes WHERE list_id = $1`, [id]);
      const del = await c.query(`DELETE FROM price_lists WHERE id = $1`, [id]);
      return del.rowCount === 1 ? { quotes: rows[0].n } : null;
    });
  },

  /** A product with all its variants - out of the catalogue and every price list. */
  async deleteProduct(id) {
    return tx(async (c) => {
      const { rows: vs } = await c.query(`SELECT id FROM pricing_variants WHERE product_id = $1`, [id]);
      const ids = vs.map((v) => v.id);
      const lists = await c.query(`SELECT count(DISTINCT list_id)::int AS n FROM price_list_items WHERE variant_id = ANY($1::int[])`, [ids]);
      await c.query(`DELETE FROM pricing_accessories WHERE product_id = $1 OR accessory_variant_id = ANY($2::int[])`, [id, ids]);
      await c.query(`DELETE FROM price_list_items WHERE variant_id = ANY($1::int[])`, [ids]);
      await c.query(`DELETE FROM pricing_variants WHERE product_id = $1`, [id]);
      const del = await c.query(`DELETE FROM pricing_products WHERE id = $1`, [id]);
      return del.rowCount === 1 ? { lists: lists.rows[0].n } : null;
    });
  },

  async deleteVariant(id) {
    return tx(async (c) => {
      const lists = await c.query(`SELECT count(DISTINCT list_id)::int AS n FROM price_list_items WHERE variant_id = $1`, [id]);
      await c.query(`DELETE FROM pricing_accessories WHERE accessory_variant_id = $1`, [id]);
      await c.query(`DELETE FROM price_list_items WHERE variant_id = $1`, [id]);
      const del = await c.query(`DELETE FROM pricing_variants WHERE id = $1`, [id]);
      return del.rowCount === 1 ? { lists: lists.rows[0].n } : null;
    });
  },

  /** ids: the entries to delete, or null for the whole log. Returns how many went. */
  async deleteAudit(ids) {
    return tx(async (c) => {
      await c.query(`SELECT set_config('pricing.audit_purge', 'on', true)`);
      const r = ids ? await c.query(`DELETE FROM pricing_audit WHERE id = ANY($1::bigint[])`, [ids]) : await c.query(`DELETE FROM pricing_audit`);
      return r.rowCount;
    });
  },

  async deleteDraft(id) {
    const { rowCount } = await pool.query(`DELETE FROM price_lists WHERE id = $1 AND status = 'draft'`, [id]);
    return rowCount === 1;
  },

  /** Moves a list from one status to another (fails if it isn't in `from`). */
  async setStatus(id, from, to, by, extra = {}) {
    const stamp = { submitted: "submitted", approved: "approved", published: "published" }[to];
    const sets = ["status = $3"];
    const vals = [id, from, to];
    if (stamp) { vals.push(by); sets.push(`${stamp}_by = $${vals.length}`, `${stamp}_at = now()`); }
    if ("rejectReason" in extra) { vals.push(extra.rejectReason); sets.push(`reject_reason = $${vals.length}`); }
    const { rowCount } = await pool.query(`UPDATE price_lists SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2::text[])`,
      [vals[0], Array.isArray(from) ? from : [from], ...vals.slice(2)]);
    return rowCount === 1;
  },

  /**
   * Publishes an approved list, in one locked transaction:
   * - a currently active open-ended list of the same segment that starts
   *   earlier is ended where this one starts (it's being replaced);
   * - any other overlap with a published list is refused.
   * Returns { ok, error?, endedListId? }.
   */
  async publish(id, by, effectiveFrom, effectiveTo, overlaps) {
    return tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('price_lists_publish'))`);
      const { rows: [list] } = await c.query(`SELECT ${listCols} FROM price_lists WHERE id = $1 FOR UPDATE`, [id]);
      if (!list || list.status !== "approved") return { ok: false, error: "Only an approved list can be published" };
      const { rows: others } = await c.query(
        `SELECT ${listCols} FROM price_lists WHERE status = 'published' AND segment = $1 AND id <> $2`, [list.segment, id]);
      let ended = null;
      const replaced = [];
      for (const o of others) {
        if (!overlaps(effectiveFrom, effectiveTo, o.effectiveFrom, o.effectiveTo)) continue;
        // "Edit prices" on a list that hasn't started yet: the new version
        // made from it takes its place (the old one is cancelled).
        if (o.id === list.basedOnId && new Date(o.effectiveFrom) >= new Date(effectiveFrom)) { replaced.push(o); continue; }
        // A list that started earlier is replaced from the new start date.
        const replaceable = new Date(o.effectiveFrom) < new Date(effectiveFrom);
        if (!replaceable || ended) {
          return { ok: false, error: `Dates overlap "${o.name}" (v${o.versionNo}) - change the dates or cancel that list first` };
        }
        ended = o;
      }
      if (ended) await c.query(`UPDATE price_lists SET effective_to = $2 WHERE id = $1`, [ended.id, effectiveFrom]);
      for (const o of replaced) await c.query(`UPDATE price_lists SET status = 'cancelled' WHERE id = $1`, [o.id]);
      await c.query(
        `UPDATE price_lists SET status = 'published', effective_from = $2, effective_to = $3, published_by = $4, published_at = now() WHERE id = $1`,
        [id, effectiveFrom, effectiveTo, by]
      );
      return { ok: true, endedListId: ended?.id ?? replaced[0]?.id ?? null, endedVersion: ended?.versionNo ?? replaced[0]?.versionNo ?? null };
    });
  },

  /** Ends a published list now (or cancels it before it starts). */
  async endList(id, at) {
    const { rows } = await pool.query(
      `UPDATE price_lists SET
         status = CASE WHEN effective_from >= $2 THEN 'cancelled' ELSE status END,
         effective_to = CASE WHEN effective_from >= $2 THEN effective_to ELSE $2 END
       WHERE id = $1 AND status = 'published' AND (effective_to IS NULL OR effective_to > $2) RETURNING status`,
      [id, at]
    );
    return rows[0]?.status || null;
  },

  /** Published lists of a segment covering `at` or starting after it. */
  async publishedLists(segment) {
    const { rows } = await pool.query(
      `SELECT ${listCols} FROM price_lists WHERE status = 'published' AND segment = $1 ORDER BY effective_from`, [segment]);
    return rows;
  },

  /**
   * The rows people can sell from: active items of active products and
   * variants, joined with the catalogue.
   */
  async sellableItems(listId) {
    const { rows } = await pool.query(
      `SELECT i.*, v.sku, v.name AS variant_name, v.attributes, v.product_id, p.name AS product_name, p.unit, p.hsn_sac,
         p.kind, p.category, p.role, p.sort_order AS p_order, v.sort_order AS v_order
       FROM price_list_items i
       JOIN pricing_variants v ON v.id = i.variant_id
       JOIN pricing_products p ON p.id = v.product_id
       WHERE i.list_id = $1 AND i.active AND v.active AND p.active
       ORDER BY p.sort_order, p.id, v.sort_order, v.id`,
      [listId]
    );
    return rows.map((r) => ({
      ...toItem(r),
      sku: r.sku,
      variantName: r.variant_name,
      attributes: r.attributes || {},
      productId: r.product_id,
      productName: r.product_name,
      unit: r.unit,
      hsnSac: r.hsn_sac,
      kind: r.kind,
      category: r.category,
      role: r.role
    }));
  },

  // ---- quotes ----
  async nextQuoteNo(year2) {
    const { rows } = await pool.query(
      `INSERT INTO pricing_counters (name, value) VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET value = pricing_counters.value + 1 RETURNING value`,
      [`quote-${year2}`]
    );
    return `FBQ${year2}-${String(rows[0].value).padStart(6, "0")}`;
  },

  async createQuote(q) {
    const { rows } = await pool.query(
      `INSERT INTO pricing_quotes (quote_no, list_id, segment, created_by, distributor_id, customer_name, customer_phone, customer_place,
         customer_state, notes, lines, totals, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [q.quoteNo, q.listId, q.segment, q.createdBy, q.distributorId, q.customerName, q.customerPhone, q.customerPlace,
        q.customerState, q.notes, JSON.stringify(q.lines), JSON.stringify(q.totals), q.validUntil]
    );
    return rows[0].id;
  },

  async getQuote(id) {
    const { rows } = await pool.query(`SELECT ${quoteCols} FROM pricing_quotes WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  /** distributorId null = every quote (admin). search matches number / customer. */
  async listQuotes(distributorId, search, limit, offset) {
    const q = search ? `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%` : null;
    const where = `($1::text IS NULL OR distributor_id = $1)
      AND ($2::text IS NULL OR quote_no ILIKE $2 OR customer_name ILIKE $2 OR customer_phone ILIKE $2 OR distributor_id ILIKE $2)`;
    const [list, count] = await Promise.all([
      pool.query(`SELECT ${quoteCols} FROM pricing_quotes WHERE ${where} ORDER BY id DESC LIMIT $3 OFFSET $4`, [distributorId, q, limit, offset]),
      pool.query(`SELECT count(*)::int AS n FROM pricing_quotes WHERE ${where}`, [distributorId, q])
    ]);
    return { quotes: list.rows, total: count.rows[0].n };
  },

  async deleteQuote(id) {
    const { rowCount } = await pool.query(`DELETE FROM pricing_quotes WHERE id = $1`, [id]);
    return rowCount === 1;
  },

  async setQuoteStatus(id, status, by) {
    const { rowCount } = await pool.query(
      `UPDATE pricing_quotes SET status = $2, status_by = $3, status_at = now() WHERE id = $1 AND status = 'open'`, [id, status, by]);
    return rowCount === 1;
  },

  // ---- audit, roles, settings ----
  async audit(e) {
    await pool.query(
      `INSERT INTO pricing_audit (actor, action, entity, entity_id, summary, before, after, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.actor, e.action, e.entity, e.entityId == null ? null : String(e.entityId), e.summary || null,
        e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.ip || null]
    );
  },

  async auditLog(search, limit, offset) {
    const q = search ? `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%` : null;
    const where = `($1::text IS NULL OR actor ILIKE $1 OR action ILIKE $1 OR entity ILIKE $1 OR entity_id ILIKE $1 OR summary ILIKE $1)`;
    const [list, count] = await Promise.all([
      pool.query(`SELECT id, at, actor, action, entity, entity_id AS "entityId", summary, before, after, ip FROM pricing_audit
        WHERE ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`, [q, limit, offset]),
      pool.query(`SELECT count(*)::int AS n FROM pricing_audit WHERE ${where}`, [q])
    ]);
    return { entries: list.rows, total: count.rows[0].n };
  },

  async staffRole(email) {
    const { rows } = await pool.query(`SELECT role FROM pricing_staff WHERE email = $1`, [email]);
    return rows[0]?.role || null;
  },

  async staff() {
    const { rows } = await pool.query(`SELECT email, role, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM pricing_staff ORDER BY email`);
    return rows;
  },

  async setStaff(email, role, by) {
    if (!role) await pool.query(`DELETE FROM pricing_staff WHERE email = $1`, [email]);
    else {
      await pool.query(
        `INSERT INTO pricing_staff (email, role, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET role = $2, updated_by = $3, updated_at = now()`, [email, role, by]);
    }
  },

  async settings() {
    const { rows } = await pool.query(`SELECT settings FROM pricing_settings WHERE id = 1`);
    return rows[0]?.settings || {};
  },

  async saveSettings(s) {
    await pool.query(`UPDATE pricing_settings SET settings = $1 WHERE id = 1`, [s]);
  }
};
