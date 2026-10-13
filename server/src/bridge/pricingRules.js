// Module Pricing - the rules, with no database or HTTP in them (see
// pricing.js for the routes, pricingStore.js for storage). Everything the
// web panel and the Irrigo Admin app show as a price comes out of here, so
// a phone or browser can't sell below the floor by sending its own numbers:
// a quote carries only variant + quantity + discount, never a price.
//
// Money is whole paise (integers) throughout - no 999.9999 rounding drift.
// GST is in basis points (18% = 1800). Prices are before GST; MRP includes
// GST (Legal Metrology: the customer never pays more than the MRP).

export const GST_RATES_BP = [0, 25, 300, 500, 1200, 1800, 2800, 4000];
export const DEFAULT_GST_BP = 1800;
export const MAX_QTY = 9999;
export const MAX_PAISE = 10_000_000_00;        // ₹1 crore per unit - well past anything sold
export const MAX_LINES = 100;
export const MAX_VALVES = 64;                   // one hub drives up to 64 valves
export const MAX_MOTORS = 4;                    // the hub's own motor + up to 3 motor nodes
export const HOME_STATE = "Tamil Nadu";
export const DISCLAIMER = "This is an estimate, not an invoice. Final price may vary with site survey, installation and configuration. " +
  "Prices are in Indian Rupees; GST is shown separately.";

export const CATEGORIES = ["controller", "node", "valve", "accessory", "power", "system", "service"];
// What the Quick builder looks for - a product's job in a system. Free text
// would let a typo break the builder, so it's a fixed list.
export const ROLES = ["hub", "motor_node", "valve_node", "valve", "transformer", "antenna", "battery", "backwash",
  "install_site", "install_point", "transport"];
export const VALVE_TYPES = {
  solenoid24: "24V AC Solenoid",
  butterfly230: "230V AC Butterfly",
  latching9: "9V DC Latching Solenoid"
};

const isInt = (v) => Number.isSafeInteger(v);
export const rupees = (p) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- one price row ----

/** The largest discount allowed per unit (paise) - from a % or a ₹ amount. */
export function maxDiscountPaise(item) {
  if (!isInt(item.basePrice)) return 0;
  if (item.maxDiscountType === "pct") return Math.floor(item.basePrice * (item.maxDiscountValue || 0) / 10000);
  if (item.maxDiscountType === "amt") return Math.min(item.basePrice, item.maxDiscountValue || 0);
  return 0;
}

/** Lowest price a unit may be sold at: the higher of the minimum price and base - max discount. */
export function floorPrice(item) {
  return Math.max(item.minPrice ?? 0, item.basePrice - maxDiscountPaise(item));
}

const withGst = (paise, gstBp) => Math.round(paise * (10000 + gstBp) / 10000);

/**
 * Problems with one price row (an empty list = fine). item:
 * { mrp, distributorPrice, basePrice, minPrice, maxPrice, maxDiscountType
 *   ('pct' | 'amt'), maxDiscountValue (pct in basis points: 10% = 1000;
 *   amt in paise), gstBp, kind ('goods' | 'service') }
 * A service (installation, transport) has no MRP.
 */
export function priceProblems(item) {
  const errors = [];
  const money = { mrp: "MRP", distributorPrice: "Distributor price", basePrice: "Selling price", minPrice: "Minimum price", maxPrice: "Maximum price" };
  for (const [k, label] of Object.entries(money)) {
    const v = item[k];
    if (k === "mrp" && item.kind === "service" && (v === null || v === undefined)) continue;
    if (v === null || v === undefined) errors.push(`${label} is missing`);
    else if (!isInt(v) || v < 0) errors.push(`${label} can't be negative`);
    else if (v > MAX_PAISE) errors.push(`${label} is too large`);
  }
  if (!GST_RATES_BP.includes(item.gstBp)) errors.push("GST rate is not a valid GST slab");
  if (!["pct", "amt"].includes(item.maxDiscountType)) errors.push("Choose the discount limit as % or ₹");
  else if (!isInt(item.maxDiscountValue) || item.maxDiscountValue < 0) errors.push("Max discount can't be negative");
  else if (item.maxDiscountType === "pct" && item.maxDiscountValue > 10000) errors.push("Max discount can't be over 100%");
  if (errors.length) return errors;

  const { mrp, distributorPrice: dp, basePrice: base, minPrice: min, maxPrice: max } = item;
  if (base <= 0) errors.push("Selling price must be more than zero");
  if (dp > min) errors.push(`Minimum price (${rupees(min)}) is below the distributor price (${rupees(dp)}) - the distributor would sell at a loss`);
  if (min > base) errors.push(`Minimum price (${rupees(min)}) is above the selling price (${rupees(base)})`);
  if (base > max) errors.push(`Selling price (${rupees(base)}) is above the maximum price (${rupees(max)})`);
  if (item.maxDiscountType === "amt" && item.maxDiscountValue > base) errors.push("Max discount is more than the selling price");
  if (mrp !== null && mrp !== undefined && withGst(max, item.gstBp) > mrp) {
    errors.push(`Maximum price + GST (${rupees(withGst(max, item.gstBp))}) is more than the MRP (${rupees(mrp)})`);
  }
  return errors;
}

/** Things worth a second look that aren't wrong. */
export function priceWarnings(item) {
  const w = [];
  if (priceProblems(item).length) return w;
  if (item.basePrice - maxDiscountPaise(item) < item.minPrice) {
    w.push(`The minimum price limits the discount to ${rupees(item.basePrice - item.minPrice)} per unit`);
  }
  if (item.minPrice === item.distributorPrice) w.push("At the minimum price the distributor earns nothing");
  return w;
}

// ---- quote calculation ----

/**
 * prices: Map variantId -> price row + { sku, productName, variantName, unit,
 *   hsnSac, kind, category }  (only sellable rows - the current list's
 *   active items of active products/variants)
 * lines:  [{ variantId, qty, discountType?: 'pct'|'amt', discountValue?,
 *   unitPrice? }]  discountValue: pct in basis points, amt in paise per unit.
 *   unitPrice (paise) sets the net price directly instead - up to the
 *   maximum price, down to the floor.
 * opts:   { customerState, homeState }
 * Returns { ok, errors: [{ line, error }], lines: [...], totals }.
 * A line that breaks a rule is reported, never silently clamped.
 */
export function calculateQuote(prices, lines, opts = {}) {
  const errors = [];
  const out = [];
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, errors: [{ line: null, error: "Add at least one product" }], lines: [], totals: null };
  if (lines.length > MAX_LINES) return { ok: false, errors: [{ line: null, error: `At most ${MAX_LINES} lines` }], lines: [], totals: null };
  const home = normState(opts.homeState || HOME_STATE);
  const customer = normState(opts.customerState || opts.homeState || HOME_STATE);
  const interState = customer !== home;

  lines.forEach((l, i) => {
    const p = prices.get(Number(l?.variantId));
    if (!p) return errors.push({ line: i, error: "This product isn't in the current price list" });
    const qty = Number(l.qty);
    if (!isInt(qty) || qty < 1 || qty > MAX_QTY) return errors.push({ line: i, error: `Quantity must be a whole number from 1 to ${MAX_QTY}` });
    const base = p.basePrice;
    const floor = floorPrice(p);
    let net = base;
    if (l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== "") {
      const u = Number(l.unitPrice);
      if (!isInt(u) || u < 0) return errors.push({ line: i, error: "Price must be a positive amount" });
      net = u;
    } else if (l.discountType && Number(l.discountValue)) {
      const v = Number(l.discountValue);
      if (!isInt(v) || v < 0) return errors.push({ line: i, error: "Discount can't be negative" });
      if (l.discountType === "pct") {
        if (v > 10000) return errors.push({ line: i, error: "Discount can't be over 100%" });
        net = base - Math.round(base * v / 10000);
      } else if (l.discountType === "amt") {
        net = base - v;
      } else return errors.push({ line: i, error: "Discount must be % or ₹" });
    }
    if (net < floor) {
      return errors.push({ line: i, error: `${p.productName}: lowest allowed price is ${rupees(floor)} per unit (max discount ${rupees(base - floor)})` });
    }
    if (net > p.maxPrice) return errors.push({ line: i, error: `${p.productName}: highest allowed price is ${rupees(p.maxPrice)} per unit` });

    const taxable = net * qty;
    const gst = Math.round(taxable * p.gstBp / 10000);
    out.push({
      variantId: p.variantId,
      sku: p.sku,
      productName: p.productName,
      variantName: p.variantName,
      unit: p.unit,
      hsnSac: p.hsnSac,
      kind: p.kind,
      qty,
      mrp: p.mrp,
      listPrice: base,
      unitPrice: net,
      unitDiscount: base - net,
      discountPct: base > 0 ? Math.round((base - net) * 10000 / base) : 0,
      floorPrice: floor,
      gross: base * qty,
      discount: (base - net) * qty,
      taxable,
      gstBp: p.gstBp,
      gst,
      total: taxable + gst,
      distributorPrice: p.distributorPrice,
      margin: (net - p.distributorPrice) * qty,
      // What was asked for, so a quote can be copied at new prices later.
      discountType: l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== "" ? null : (l.discountType || null),
      discountValue: l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== "" ? null : (Number(l.discountValue) || 0),
      priceOverride: l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== "" ? net : null
    });
  });

  if (errors.length) return { ok: false, errors, lines: out, totals: null };

  const sum = (k) => out.reduce((s, l) => s + l[k], 0);
  const gstTotal = sum("gst");
  const byRate = new Map();
  for (const l of out) {
    const r = byRate.get(l.gstBp) || { gstBp: l.gstBp, taxable: 0, gst: 0 };
    r.taxable += l.taxable;
    r.gst += l.gst;
    byRate.set(l.gstBp, r);
  }
  const gstBreakup = [...byRate.values()].sort((a, b) => a.gstBp - b.gstBp).map((r) => (interState
    ? { ...r, igst: r.gst, cgst: 0, sgst: 0 }
    : { ...r, igst: 0, cgst: Math.floor(r.gst / 2), sgst: r.gst - Math.floor(r.gst / 2) }));
  const beforeRound = sum("taxable") + gstTotal;
  const payable = Math.round(beforeRound / 100) * 100;
  return {
    ok: true,
    errors: [],
    lines: out,
    totals: {
      gross: sum("gross"),
      discount: sum("discount"),
      taxable: sum("taxable"),
      gst: gstTotal,
      interState,
      gstBreakup,
      roundOff: payable - beforeRound,
      payable,
      margin: sum("margin"),
      distributorCost: out.reduce((s, l) => s + l.distributorPrice * l.qty, 0)
    }
  };
}

const normState = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// ---- Quick builder ----

/**
 * "3 motors, 6 solenoid valves" -> the lines for a working system, from the
 * current price list: 1 hub, motor nodes for the other motors, the cheapest
 * mix of valve nodes covering the valves, the valves themselves, required
 * accessories, and installation if asked. The user edits the result freely.
 *
 * sellable: the price rows (as for calculateQuote) with { role, attributes,
 *   productId } - attributes.channels / attributes.valveType on valve nodes
 *   and valves.
 * accessories: [{ productId, accessoryVariantId, mode, qtyPer, perUnits }]
 * input: { motors, valves, valveType, installation, backwash }
 */
export function quickBuild(sellable, accessories, input) {
  const motors = Number(input?.motors);
  const valves = Number(input?.valves ?? 0);
  if (!isInt(motors) || motors < 1 || motors > MAX_MOTORS) return { ok: false, error: `Motors must be 1 to ${MAX_MOTORS}` };
  if (!isInt(valves) || valves < 0 || valves > MAX_VALVES) return { ok: false, error: `Valves must be 0 to ${MAX_VALVES}` };
  const rows = [...sellable.values()];
  const byRole = (role) => rows.filter((r) => r.role === role).sort((a, b) => a.basePrice - b.basePrice);
  const lines = new Map();   // variantId -> qty
  const notes = [];
  const add = (row, qty) => { if (row && qty > 0) lines.set(row.variantId, (lines.get(row.variantId) || 0) + qty); };

  const hub = byRole("hub")[0];
  if (!hub) return { ok: false, error: "The Motor Master Hub has no price in the current list" };
  add(hub, 1);
  if (motors > 1) {
    const mn = byRole("motor_node")[0];
    if (!mn) return { ok: false, error: "The Motor Node has no price in the current list" };
    add(mn, motors - 1);
  }

  if (valves > 0) {
    const type = input.valveType;
    if (!VALVE_TYPES[type]) return { ok: false, error: "Choose the valve type" };
    const nodes = byRole("valve_node").filter((r) => r.attributes?.valveType === type && Number(r.attributes?.channels) > 0);
    const valve = byRole("valve").filter((r) => r.attributes?.valveType === type)[0];
    if (!valve) return { ok: false, error: `No ${VALVE_TYPES[type]} valve in the current price list` };
    if (nodes.length) {
      const mix = cheapestNodeMix(nodes, valves);
      for (const [row, n] of mix) add(row, n);
      const channels = mix.reduce((s, [row, n]) => s + n * Number(row.attributes.channels), 0);
      if (channels > valves) notes.push(`${channels - valves} spare valve channel(s) for future expansion`);
    } else {
      notes.push(`${VALVE_TYPES[type]} valves need no valve node`);
    }
    add(valve, valves);
  }
  if (input.backwash) {
    const bw = byRole("backwash")[0];
    if (bw) add(bw, 1); else notes.push("Auto Filter Backwash has no price in the current list");
  }

  // Accessories of what's in the list so far (one level - an accessory's own
  // accessories aren't followed).
  const byVariant = new Map(rows.map((r) => [r.variantId, r]));
  const qtyOfProduct = new Map();
  for (const [vid, q] of lines) {
    const r = byVariant.get(vid);
    qtyOfProduct.set(r.productId, (qtyOfProduct.get(r.productId) || 0) + q);
  }
  const optional = [];
  for (const a of accessories) {
    const parentQty = qtyOfProduct.get(a.productId);
    if (!parentQty) continue;
    const acc = byVariant.get(a.accessoryVariantId);
    if (!acc) continue;
    const qty = Math.ceil(parentQty / Math.max(1, a.perUnits || 1)) * Math.max(1, a.qtyPer || 1);
    if (a.mode === "required") add(acc, qty);
    else optional.push({ variantId: acc.variantId, qty, productName: acc.productName, variantName: acc.variantName });
  }

  if (input.installation) {
    const site = byRole("install_site")[0];
    const point = byRole("install_point")[0];
    if (site) add(site, 1);
    if (point && valves > 0) add(point, valves);
    if (!site && !point) notes.push("Installation has no price in the current list");
  }

  return {
    ok: true,
    lines: [...lines].map(([variantId, qty]) => ({ variantId, qty })),
    suggestions: optional,
    notes
  };
}

/** Fewest-rupees set of valve nodes with at least `need` channels (small DP). */
export function cheapestNodeMix(nodes, need) {
  const maxCh = Math.max(...nodes.map((n) => Number(n.attributes.channels)));
  const limit = need + maxCh;
  const cost = new Array(limit + 1).fill(Infinity);
  const pick = new Array(limit + 1).fill(null);
  cost[0] = 0;
  for (let c = 1; c <= limit; c++) {
    for (const n of nodes) {
      const ch = Number(n.attributes.channels);
      const prev = Math.max(0, c - ch);
      // Cheaper, or the same price with fewer boxes to install.
      const total = cost[prev] + n.basePrice;
      if (total < cost[c] || (total === cost[c] && pick[c] && ch > Number(pick[c].attributes.channels))) {
        cost[c] = total;
        pick[c] = n;
      }
    }
  }
  // Cheapest total at or above `need` channels.
  let best = need;
  for (let c = need; c <= limit; c++) if (cost[c] < cost[best]) best = c;
  const counts = new Map();
  for (let c = best; c > 0;) {
    const n = pick[c];
    counts.set(n, (counts.get(n) || 0) + 1);
    c = Math.max(0, c - Number(n.attributes.channels));
  }
  return [...counts];
}

// ---- dates ----

/** Status of a published list at `now`: scheduled | active | expired. */
export function liveStatus(list, now = Date.now()) {
  const from = new Date(list.effectiveFrom).getTime();
  const to = list.effectiveTo ? new Date(list.effectiveTo).getTime() : Infinity;
  if (now < from) return "scheduled";
  if (now >= to) return "expired";
  return "active";
}

/** Date ranges [from, to) overlap (to null = open-ended). */
export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const af = new Date(aFrom).getTime(), bf = new Date(bFrom).getTime();
  const at = aTo ? new Date(aTo).getTime() : Infinity;
  const bt = bTo ? new Date(bTo).getTime() : Infinity;
  return af < bt && bf < at;
}
