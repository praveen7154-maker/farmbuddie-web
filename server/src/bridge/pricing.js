import express from "express";
import { isAdmin } from "../adminAuth.js";
import {
  CATEGORIES, ROLES, VALVE_TYPES, GST_RATES_BP, DEFAULT_GST_BP, HOME_STATE, DISCLAIMER, MAX_PAISE,
  priceProblems, priceWarnings, floorPrice, maxDiscountPaise, calculateQuote, quickBuild, liveStatus, rangesOverlap,
  ourProfit, quoteProfit
} from "./pricingRules.js";

// Module Pricing - web panel "Module Pricing" and the Irrigo Admin app's
// Price List / Price Calculator. The rules are in pricingRules.js.
//
// Who may do what:
//   owner       - an ADMIN_EMAILS login: everything, plus settings and roles
//   approver    - pricing_staff role: approve / publish / end lists, + editor
//   editor      - edit the catalogue and draft lists, submit for approval
//   viewer      - see the catalogue, every list and the audit log
//   distributor - the current prices (incl. their buying price), the
//                 calculator and their own quotes; never edits a price
// Our purchase cost (cost_price) and our profit are seen by editors,
// approvers and owners only - never by a viewer or a distributor.
// A farmer's login gets nothing here.
//
// Prices are never edited in place: a new version is a draft copy, then
// submitted -> approved -> published with an effective date.

const RANK = { viewer: 1, editor: 2, approver: 3, owner: 4 };
const PAGE = 25;
const SEGMENT = "standard";
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const HSN_RE = /^\d{4,8}$/;
const ATTR_KEYS = { channels: "int", valveType: "valveType", size: "text", length: "text", voltage: "text", note: "text" };
export const DEFAULT_SETTINGS = {
  quoteValidityDays: 15,
  expiryWarningDays: 7,
  homeState: HOME_STATE,
  requireSecondApprover: false,
  // Quotations show each product at its MRP (without GST) and the gap to
  // the selling price as "Company discount" - see pricingRules.js mrpView().
  showMrpDiscount: true,
  disclaimer: DISCLAIMER,
  // Printed on price list PDFs and quotes.
  companyName: "Farm Buddie",
  companyAddress: "14/218/1, Sankaragoundanpalayam\nVarathanallur Post, Bhavani Taluk\nErode, Tamil Nadu 638311",
  // Printed on every customer quotation (one term per line).
  quoteTerms: [
    "For any service or maintenance, customers must contact Farm Buddie directly. Unauthorised opening, modification or servicing of the controller, panel, valves or wiring will void the warranty, and Farm Buddie is not responsible for any resulting damage.",
    "Scope includes supply, installation and commissioning of the smart irrigation system. System performance depends on site conditions, water source and electrical setup.",
    "A 1-year warranty is provided on the controller and valves. The warranty excludes minor fittings, consumables, and damage due to lightning, natural causes, rodents, insects, poor maintenance, improper usage or use of chemicals.",
    "Installation will be carried out as per TNEB and government norms and standard safety guidelines.",
    "Installation timeline depends on site conditions and system complexity. The customer must ensure availability of water and electricity and follow proper operating instructions.",
    "A SIM card will be provided by Farm Buddie with yearly recharge. System performance depends on network availability, and Farm Buddie is not responsible for network-related issues.",
    "Any modification, rewiring or third-party integration without approval, improper power supply, lack of earthing, or poor water quality (salinity, mud, debris) may affect system performance and will void the warranty.",
    "After installation, equipment safety, handling and protection from theft or physical damage is the responsibility of the customer.",
    "Payment terms: 90% advance at the time of product supply and 10% upon completion of installation."
  ].join("\n"),
  companyGstin: "",
  companyPhone: "",
  companyEmail: "",
  companyWebsite: ""
};
const companyOf = (s) => ({
  name: s.companyName, address: s.companyAddress, gstin: s.companyGstin,
  phone: s.companyPhone, email: s.companyEmail, website: s.companyWebsite
});

class Bad extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const text = (v, label, max, { required = false } = {}) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : null;
  if (s === null) throw new Bad(`${label} must be text`);
  if (required && !s) throw new Bad(`${label} is required`);
  if (s.length > max) throw new Bad(`${label} is too long (max ${max})`);
  return s || null;
};
const int = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Bad(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};
const money = (v, label) => (v === null || v === undefined || v === "" ? null : int(v, label, 0, MAX_PAISE));
const bool = (v, dflt) => (v === undefined ? dflt : v === true);
const dateOrNull = (v, label) => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Bad(`${label} is not a valid date`);
  return d;
};
const year2 = (d) => String(d.getFullYear() % 100).padStart(2, "0");

/**
 * deps:
 *   store           - pricingStore.js (or a fake)
 *   findDistributor - async (id) => { state, ... } | null (their state decides CGST+SGST vs IGST)
 *   now             - () => ms
 */
export function createPricingModule({ store, findDistributor = async () => null, now = () => Date.now() }) {
  const router = express.Router();
  router.use(express.json({ limit: "512kb" }));

  // ---- who's calling ----
  async function roleOf(req) {
    const t = req.decodedToken;
    if (t?.distributorId) return "distributor";
    if (isAdmin(t)) return "owner";
    const email = typeof t?.email === "string" ? t.email.toLowerCase() : "";
    return email ? await store.staffRole(email) : null;
  }
  const actorOf = (req) => (req.decodedToken?.distributorId ? `dist:${req.decodedToken.distributorId}` : (req.decodedToken?.email || "unknown"));
  router.use(async (req, res, next) => {
    try {
      req.pricingRole = await roleOf(req);
    } catch (err) {
      console.error("[pricing] role check failed:", err);
      return res.status(500).json({ error: "Couldn't check your access" });
    }
    if (!req.pricingRole) return res.status(403).json({ error: "No access to pricing" });
    next();
  });
  const need = (role) => (req, res, next) => (RANK[req.pricingRole] >= RANK[role] ? next()
    : res.status(403).json({ error: req.pricingRole === "distributor" ? "Prices can only be changed by Farm Buddie" : "Your pricing role can't do this" }));
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ error: err.message });
      if (err?.code === "23505") return res.status(409).json({ error: "That SKU is already used" });
      console.error(`[pricing] ${req.method} ${req.path} failed:`, err);
      res.status(500).json({ error: "Something went wrong - try again" });
    }
  };
  const seesCost = (req) => RANK[req.pricingRole] >= RANK.editor;
  // Removes costPrice anywhere in a value (rows, audit before/after).
  const noCost = (v) => (Array.isArray(v) ? v.map(noCost)
    : v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "costPrice").map(([k, x]) => [k, noCost(x)])) : v);
  // Our cost and profit on a quote, from the cost in the quote's own price list.
  const costCache = new Map();   // listId -> { at, map }
  async function costsOf(listId) {
    const c = costCache.get(listId);
    if (c && now() - c.at < 60 * 1000) return c.map;
    const map = new Map((await store.items(listId)).map((i) => [i.variantId, i.costPrice]));
    costCache.set(listId, { at: now(), map });
    return map;
  }
  async function withProfit(req, q) {
    if (!q || !seesCost(req) || !q.listId) return q;
    const costs = await costsOf(q.listId);
    return { ...q, profit: quoteProfit(q.lines, (v) => costs.get(v), !!q.distributorId) };
  }
  const audit = (req, action, entity, entityId, summary, before, after) => store.audit({
    actor: actorOf(req), action, entity, entityId, summary, before, after, ip: req.ip
  });

  async function settings() {
    const s = { ...DEFAULT_SETTINGS, ...(await store.settings()) };
    // Left empty in Settings = the standard text.
    for (const k of ["companyAddress", "quoteTerms"]) if (!s[k]) s[k] = DEFAULT_SETTINGS[k];
    return s;
  }

  // The published list in force now, and the next scheduled one.
  async function currentLists(segment = SEGMENT) {
    const lists = await store.publishedLists(segment);
    const t = now();
    const active = lists.filter((l) => liveStatus(l, t) === "active")
      .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0] || null;
    const next = lists.filter((l) => liveStatus(l, t) === "scheduled")
      .sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom))[0] || null;
    return { active, next };
  }

  async function sellableMap(listId) {
    const rows = await store.sellableItems(listId);
    // A row only sells if its prices pass the rules (an approved list's always do).
    return new Map(rows.filter((r) => priceProblems(r).length === 0).map((r) => [r.variantId, r]));
  }

  const stateCache = new Map(); // distributorId -> { state, at }
  async function distributorState(id) {
    const c = stateCache.get(id);
    if (c && now() - c.at < 5 * 60 * 1000) return c.state;
    const d = await findDistributor(id).catch(() => null);
    stateCache.set(id, { state: d?.state || null, at: now() });
    return d?.state || null;
  }

  function listView(l, t = now(), warnDays = DEFAULT_SETTINGS.expiryWarningDays) {
    if (!l) return null;
    const live = l.status === "published" ? liveStatus(l, t) : null;
    const endsIn = l.effectiveTo ? new Date(l.effectiveTo).getTime() - t : null;
    return {
      ...l,
      liveStatus: live,
      expiresSoon: live === "active" && endsIn !== null && endsIn < warnDays * 24 * 3600 * 1000
    };
  }

  // ---------- everyone with access: current prices ----------

  router.get("/current", wrap(async (req, res) => {
    const s = await settings();
    const { active, next } = await currentLists();
    const t = now();
    let items = [];
    if (active) {
      items = [...(await sellableMap(active.id)).values()].map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        sku: r.sku,
        productName: r.productName,
        variantName: r.variantName,
        category: r.category,
        role: r.role,
        kind: r.kind,
        unit: r.unit,
        hsnSac: r.hsnSac,
        attributes: r.attributes,
        gstBp: r.gstBp,
        mrp: r.mrp,
        distributorPrice: r.distributorPrice,
        basePrice: r.basePrice,
        minPrice: r.minPrice,
        maxPrice: r.maxPrice,
        maxDiscountType: r.maxDiscountType,
        maxDiscountValue: r.maxDiscountValue,
        maxDiscount: maxDiscountPaise(r),
        floorPrice: floorPrice(r),
        margin: r.basePrice - r.distributorPrice,
        ...(seesCost(req) ? { costPrice: r.costPrice, ourProfit: ourProfit(r) } : {})
      }));
    }
    const homeState = s.homeState;
    // Accessory links between sellable rows - for the Quick builder.
    const sellableProducts = new Set(items.map((i) => i.productId));
    const sellableVariants = new Set(items.map((i) => i.variantId));
    const accessories = active ? (await store.catalogue()).accessories
      .filter((a) => sellableProducts.has(a.productId) && sellableVariants.has(a.accessoryVariantId)) : [];
    const myState = req.decodedToken?.distributorId ? await distributorState(req.decodedToken.distributorId) : null;
    res.json({
      list: listView(active, t, s.expiryWarningDays),
      next: next ? { id: next.id, name: next.name, effectiveFrom: next.effectiveFrom } : null,
      items,
      accessories,
      settings: { quoteValidityDays: s.quoteValidityDays, homeState, disclaimer: s.disclaimer, company: companyOf(s), quoteTerms: s.quoteTerms, showMrpDiscount: s.showMrpDiscount !== false },
      valveTypes: VALVE_TYPES,
      myState,
      role: req.pricingRole,
      serverTime: new Date(t).toISOString()
    });
  }));

  async function priceQuote(req, body) {
    const { active } = await currentLists();
    if (!active) throw new Bad("Prices have expired or aren't published yet - contact Farm Buddie", 409);
    const s = await settings();
    const prices = await sellableMap(active.id);
    const customerState = text(body?.customerState, "Customer state", 40)
      || (req.decodedToken?.distributorId ? await distributorState(req.decodedToken.distributorId) : null)
      || s.homeState;
    const result = calculateQuote(prices, body?.lines, { customerState, homeState: s.homeState });
    return { active, settings: s, customerState, result };
  }

  router.post("/quote/preview", wrap(async (req, res) => {
    const { active, settings: s, customerState, result } = await priceQuote(req, req.body);
    let profit;
    if (result.ok && seesCost(req)) {
      const costs = await costsOf(active.id);
      profit = quoteProfit(result.lines, (v) => costs.get(v), false);
    }
    res.json({ ...result, listId: active.id, listName: active.name, customerState, homeState: s.homeState, ...(profit !== undefined ? { profit } : {}) });
  }));

  router.post("/quote/build", wrap(async (req, res) => {
    const { active } = await currentLists();
    if (!active) throw new Bad("Prices have expired or aren't published yet - contact Farm Buddie", 409);
    const prices = await sellableMap(active.id);
    const { accessories } = await store.catalogue();
    const built = quickBuild(prices, accessories, req.body || {});
    if (!built.ok) throw new Bad(built.error);
    res.json(built);
  }));

  // ---------- quotes ----------

  router.post("/quotes", wrap(async (req, res) => {
    const b = req.body || {};
    const customerName = text(b.customerName, "Customer name", 80, { required: true });
    const customerPhone = text(b.customerPhone, "Phone", 20);
    if (customerPhone && !/^\+?[\d\s-]{7,20}$/.test(customerPhone)) throw new Bad("Phone number looks wrong");
    const customerPlace = text(b.customerPlace, "Place", 80);
    const notes = text(b.notes, "Notes", 500);
    const { active, settings: s, customerState, result } = await priceQuote(req, b);
    if (!result.ok) return res.status(400).json({ error: result.errors[0].error, errors: result.errors });
    const t = now();
    let validUntil = t + s.quoteValidityDays * 24 * 3600 * 1000;
    if (active.effectiveTo) validUntil = Math.min(validUntil, new Date(active.effectiveTo).getTime());
    const quoteNo = await store.nextQuoteNo(year2(new Date(t)));
    const id = await store.createQuote({
      quoteNo, listId: active.id, segment: active.segment, createdBy: actorOf(req),
      distributorId: req.decodedToken?.distributorId || null,
      customerName, customerPhone, customerPlace, customerState, notes,
      lines: result.lines, totals: result.totals, validUntil: new Date(validUntil)
    });
    await audit(req, "create", "quote", id, `${quoteNo} for ${customerName}: ${result.totals.payable / 100} INR`);
    res.json({ id, quoteNo, quote: await withProfit(req, quoteView(await store.getQuote(id), t)) });
  }));

  function quoteView(q, t = now()) {
    if (!q) return null;
    return { ...q, expired: q.status === "open" && new Date(q.validUntil).getTime() < t };
  }
  const myQuoteScope = (req) => req.decodedToken?.distributorId || null;   // null = all (staff)

  router.get("/quotes", wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 60) || null : null;
    const t = now();
    const { quotes, total } = await store.listQuotes(myQuoteScope(req), search, PAGE, (page - 1) * PAGE);
    res.json({ quotes: await Promise.all(quotes.map((q) => withProfit(req, quoteView(q, t)))), total, page, pageSize: PAGE });
  }));

  async function ownQuote(req) {
    const id = int(req.params.id, "Quote", 1, 2_000_000_000);
    const q = await store.getQuote(id);
    const scope = myQuoteScope(req);
    if (!q || (scope && q.distributorId !== scope)) throw new Bad("Quote not found", 404);
    return q;
  }

  router.get("/quotes/:id", wrap(async (req, res) => {
    res.json({ quote: await withProfit(req, quoteView(await ownQuote(req))) });
  }));

  router.post("/quotes/:id/status", wrap(async (req, res) => {
    const q = await ownQuote(req);
    const status = req.body?.status;
    if (!["accepted", "cancelled"].includes(status)) throw new Bad("Status must be accepted or cancelled");
    if (status === "accepted" && quoteView(q).expired) throw new Bad("This quote has expired - make a new one at current prices");
    if (!(await store.setQuoteStatus(q.id, status, actorOf(req)))) throw new Bad("Only an open quote can be changed", 409);
    await audit(req, status === "accepted" ? "accept" : "cancel", "quote", q.id, q.quoteNo);
    res.json({ ok: true });
  }));

  // ---------- staff: catalogue ----------

  const staff = express.Router();
  router.use("/admin", (req, res, next) => (req.pricingRole === "distributor"
    ? res.status(403).json({ error: "Prices can only be changed by Farm Buddie" }) : next()), staff);

  staff.get("/catalog", wrap(async (req, res) => {
    res.json({ ...(await store.catalogue()), categories: CATEGORIES, roles: ROLES, valveTypes: VALVE_TYPES, gstRates: GST_RATES_BP, role: req.pricingRole });
  }));

  function productInput(b) {
    const sku = text(b?.sku, "SKU", 32, { required: true }).toUpperCase();
    if (!SKU_RE.test(sku)) throw new Bad("SKU: capital letters, numbers and - only (e.g. FB-HUB)");
    const category = b.category;
    if (!CATEGORIES.includes(category)) throw new Bad("Choose a category");
    const role = b.role || null;
    if (role && !ROLES.includes(role)) throw new Bad("Unknown product role");
    const kind = b.kind === "service" ? "service" : "goods";
    const hsnSac = text(b.hsnSac, "HSN/SAC", 8);
    if (hsnSac && !HSN_RE.test(hsnSac)) throw new Bad("HSN/SAC code must be 4 to 8 digits");
    const gstBp = b.gstBp === undefined ? DEFAULT_GST_BP : Number(b.gstBp);
    if (!GST_RATES_BP.includes(gstBp)) throw new Bad("GST rate must be a GST slab (0, 0.25, 3, 5, 12, 18, 28 or 40%)");
    return {
      sku,
      name: text(b.name, "Name", 80, { required: true }),
      category,
      role,
      kind,
      unit: text(b.unit, "Unit", 12) || "pcs",
      hsnSac,
      gstBp,
      description: text(b.description, "Description", 500),
      active: bool(b.active, true),
      sortOrder: b.sortOrder === undefined ? 0 : int(b.sortOrder, "Order", 0, 100000)
    };
  }

  function variantInput(b, fallbackSku) {
    const sku = (text(b?.sku, "Variant SKU", 32) || fallbackSku || "").toUpperCase();
    if (!SKU_RE.test(sku)) throw new Bad("Variant SKU: capital letters, numbers and - only");
    const attributes = {};
    for (const [k, v] of Object.entries(b?.attributes || {})) {
      if (v === null || v === undefined || v === "") continue;
      const type = ATTR_KEYS[k];
      if (!type) throw new Bad(`Unknown variant detail "${k}"`);
      if (type === "int") attributes[k] = int(v, "Channels", 1, 64);
      else if (type === "valveType") {
        if (!VALVE_TYPES[v]) throw new Bad("Unknown valve type");
        attributes[k] = v;
      } else attributes[k] = text(v, k, 40);
    }
    return {
      sku,
      name: text(b?.name, "Variant name", 60) || "Standard",
      attributes,
      active: bool(b?.active, true),
      sortOrder: b?.sortOrder === undefined ? 0 : int(b.sortOrder, "Order", 0, 100000)
    };
  }

  staff.post("/products", need("editor"), wrap(async (req, res) => {
    const p = productInput(req.body);
    const variants = Array.isArray(req.body.variants) && req.body.variants.length
      ? req.body.variants.slice(0, 50).map((v) => variantInput(v))
      : [variantInput({ sku: p.sku, name: "Standard", attributes: req.body.attributes }, p.sku)];
    if (await store.skuTaken(p.sku, null)) throw new Bad("That SKU is already used", 409);
    for (const v of variants) if (v.sku !== p.sku && (await store.skuTaken(v.sku, null))) throw new Bad(`SKU ${v.sku} is already used`, 409);
    if (new Set(variants.map((v) => v.sku)).size !== variants.length) throw new Bad("Two variants have the same SKU");
    const id = await store.createProduct(p, variants, actorOf(req));
    await audit(req, "create", "product", id, `${p.sku} ${p.name}`, null, { ...p, variants });
    res.json({ id });
  }));

  staff.put("/products/:id", need("editor"), wrap(async (req, res) => {
    const id = int(req.params.id, "Product", 1, 2_000_000_000);
    const before = await store.getProduct(id);
    if (!before) throw new Bad("Product not found", 404);
    const p = productInput(req.body);
    if (await store.skuTaken(p.sku, id)) throw new Bad("That SKU is already used", 409);
    await store.updateProduct(id, p, actorOf(req));
    // A product with one variant: its Active switch is the variant's too
    // (there's no separate variant switch on screen for it).
    const own = (await store.catalogue()).variants.filter((v) => v.productId === id);
    if (own.length === 1 && own[0].active !== p.active) {
      await store.updateVariant(own[0].id, { ...own[0], active: p.active }, actorOf(req));
    }
    await audit(req, "update", "product", id, `${p.sku} ${p.name}${before.active !== p.active ? (p.active ? " - made active" : " - made inactive") : ""}`, before, p);
    res.json({ ok: true });
  }));

  staff.post("/products/:id/variants", need("editor"), wrap(async (req, res) => {
    const productId = int(req.params.id, "Product", 1, 2_000_000_000);
    if (!(await store.getProduct(productId))) throw new Bad("Product not found", 404);
    const v = variantInput(req.body);
    if (await store.skuTaken(v.sku, productId)) throw new Bad("That SKU is already used", 409);
    const id = await store.createVariant(productId, v, actorOf(req));
    await audit(req, "create", "variant", id, `${v.sku} ${v.name}`, null, v);
    res.json({ id });
  }));

  staff.put("/variants/:id", need("editor"), wrap(async (req, res) => {
    const id = int(req.params.id, "Variant", 1, 2_000_000_000);
    const before = await store.getVariant(id);
    if (!before) throw new Bad("Variant not found", 404);
    const v = variantInput(req.body);
    if (await store.skuTaken(v.sku, before.productId)) throw new Bad("That SKU is already used", 409);
    await store.updateVariant(id, v, actorOf(req));
    await audit(req, "update", "variant", id, `${v.sku} ${v.name}`, before, v);
    res.json({ ok: true });
  }));

  // Deleting: admins only. Gone from the catalogue and from every price list;
  // saved quotes keep their own copy. To stop selling for now, use Inactive.
  staff.delete("/products/:id", need("owner"), wrap(async (req, res) => {
    const id = int(req.params.id, "Product", 1, 2_000_000_000);
    const before = await store.getProduct(id);
    if (!before) throw new Bad("Product not found", 404);
    const r = await store.deleteProduct(id);
    await audit(req, "delete", "product", id, `${before.sku} ${before.name} deleted (was in ${r.lists} price list(s))`, before);
    res.json({ ok: true, lists: r.lists });
  }));

  staff.delete("/variants/:id", need("owner"), wrap(async (req, res) => {
    const id = int(req.params.id, "Variant", 1, 2_000_000_000);
    const before = await store.getVariant(id);
    if (!before) throw new Bad("Variant not found", 404);
    const { variants } = await store.catalogue();
    if (variants.filter((v) => v.productId === before.productId).length <= 1) throw new Bad("This is the product's only variant - delete the product instead", 409);
    const r = await store.deleteVariant(id);
    await audit(req, "delete", "variant", id, `${before.sku} ${before.name} deleted (was in ${r.lists} price list(s))`, before);
    res.json({ ok: true, lists: r.lists });
  }));

  staff.put("/products/:id/accessories", need("editor"), wrap(async (req, res) => {
    const productId = int(req.params.id, "Product", 1, 2_000_000_000);
    if (!(await store.getProduct(productId))) throw new Bad("Product not found", 404);
    const raw = Array.isArray(req.body?.accessories) ? req.body.accessories.slice(0, 30) : [];
    const links = [];
    for (const a of raw) {
      const accessoryVariantId = int(a.accessoryVariantId, "Accessory", 1, 2_000_000_000);
      const v = await store.getVariant(accessoryVariantId);
      if (!v) throw new Bad("Accessory not found");
      if (v.productId === productId) throw new Bad("A product can't be its own accessory");
      if (links.some((l) => l.accessoryVariantId === accessoryVariantId)) continue;
      links.push({
        accessoryVariantId,
        mode: a.mode === "required" ? "required" : "optional",
        qtyPer: int(a.qtyPer ?? 1, "Quantity", 1, 100),
        perUnits: int(a.perUnits ?? 1, "Per units", 1, 100)
      });
    }
    const before = (await store.catalogue()).accessories.filter((a) => a.productId === productId);
    await store.setAccessories(productId, links);
    await audit(req, "update", "accessories", productId, `${links.length} accessory link(s)`, before, links);
    res.json({ ok: true });
  }));

  // ---------- staff: price lists ----------

  staff.get("/lists", wrap(async (req, res) => {
    const s = await settings();
    const t = now();
    res.json({ lists: (await store.lists()).map((l) => listView(l, t, s.expiryWarningDays)), role: req.pricingRole, settings: s });
  }));

  async function loadList(req) {
    const id = int(req.params.id, "Price list", 1, 2_000_000_000);
    const list = await store.getList(id);
    if (!list) throw new Bad("Price list not found", 404);
    return list;
  }

  // Rows of a list with the catalogue, each row's problems and warnings, and
  // the price in force now for comparison.
  staff.get("/lists/:id", wrap(async (req, res) => {
    const list = await loadList(req);
    const s = await settings();
    const [items, cat, { active }] = await Promise.all([store.items(list.id), store.catalogue(), currentLists(list.segment)]);
    const compare = active && active.id !== list.id ? new Map((await store.items(active.id)).map((i) => [i.variantId, i])) : new Map();
    const variants = new Map(cat.variants.map((v) => [v.id, v]));
    const products = new Map(cat.products.map((p) => [p.id, p]));
    const rows = items.map((i) => {
      const v = variants.get(i.variantId);
      const p = v && products.get(v.productId);
      const full = { ...i, kind: p?.kind };
      return {
        ...i,
        sku: v?.sku,
        variantName: v?.name,
        productId: p?.id,
        productName: p?.name,
        category: p?.category,
        kind: p?.kind,
        catalogueActive: !!(v?.active && p?.active),
        errors: i.active ? priceProblems(full) : [],
        warnings: i.active ? priceWarnings(full) : [],
        floorPrice: i.active && priceProblems(full).length === 0 ? floorPrice(full) : null,
        current: compare.get(i.variantId) || null,
        sort: (p?.sortOrder ?? 0) * 100000 + (v?.sortOrder ?? 0)
      };
    }).sort((a, b) => a.sort - b.sort || a.variantId - b.variantId);
    res.json({ list: listView(list, now(), s.expiryWarningDays), items: seesCost(req) ? rows : noCost(rows), compareWith: active && active.id !== list.id ? { id: active.id, name: active.name } : null });
  }));

  staff.post("/lists", need("editor"), wrap(async (req, res) => {
    const name = text(req.body?.name, "Name", 80, { required: true });
    const notes = text(req.body?.notes, "Notes", 1000);
    let basedOnId = req.body?.basedOnId ? int(req.body.basedOnId, "Copy from", 1, 2_000_000_000) : null;
    if (basedOnId && !(await store.getList(basedOnId))) throw new Bad("The list to copy wasn't found");
    if (req.body?.basedOnId === undefined) basedOnId = (await currentLists()).active?.id || null;
    const id = await store.createDraft({ name, segment: SEGMENT, notes, basedOnId }, actorOf(req));
    await store.normalizeDiscounts(id);   // a copy of an older list may have a % discount
    await audit(req, "create", "price_list", id, `Draft "${name}"${basedOnId ? ` copied from #${basedOnId}` : ""}`);
    res.json({ id });
  }));

  staff.put("/lists/:id", need("editor"), wrap(async (req, res) => {
    const list = await loadList(req);
    const b = req.body || {};
    const next = {
      name: text(b.name, "Name", 80, { required: true }),
      notes: text(b.notes, "Notes", 1000),
      effectiveFrom: dateOrNull(b.effectiveFrom, "Effective from"),
      effectiveTo: dateOrNull(b.effectiveTo, "Effective to")
    };
    if (next.effectiveFrom && next.effectiveTo && next.effectiveTo <= next.effectiveFrom) throw new Bad("'Effective to' must be after 'Effective from'");
    if (!(await store.updateDraft(list.id, next))) throw new Bad("Only a draft can be changed - reject it back to draft first", 409);
    await audit(req, "update", "price_list", list.id, `Details of "${next.name}"`,
      { name: list.name, notes: list.notes, effectiveFrom: list.effectiveFrom, effectiveTo: list.effectiveTo }, next);
    res.json({ ok: true });
  }));

  staff.put("/lists/:id/items", need("editor"), wrap(async (req, res) => {
    const list = await loadList(req);
    if (list.status !== "draft") throw new Bad("Only a draft can be changed - reject it back to draft first", 409);
    const raw = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!raw || raw.length === 0) throw new Bad("Nothing to save");
    if (raw.length > 1000) throw new Bad("Too many rows at once");
    const cat = await store.catalogue();
    const variantIds = new Set(cat.variants.map((v) => v.id));
    const before = new Map((await store.items(list.id)).map((i) => [i.variantId, i]));
    const items = raw.map((i) => {
      const variantId = int(i.variantId, "Variant", 1, 2_000_000_000);
      if (!variantIds.has(variantId)) throw new Bad(`Variant ${variantId} doesn't exist`);
      const type = i.maxDiscountType === "amt" ? "amt" : "pct";
      const gstBp = Number(i.gstBp);
      if (!GST_RATES_BP.includes(gstBp)) throw new Bad("GST rate must be a GST slab");
      return {
        variantId,
        active: bool(i.active, true),
        mrp: money(i.mrp, "MRP"),
        distributorPrice: money(i.distributorPrice, "Distributor price"),
        // Left out (an older client) = keep what's saved.
        costPrice: i.costPrice === undefined ? (before.get(variantId)?.costPrice ?? null) : money(i.costPrice, "Our cost"),
        basePrice: money(i.basePrice, "Farmer selling price"),
        minPrice: money(i.minPrice, "Minimum price"),
        maxPrice: money(i.maxPrice, "Maximum price"),
        maxDiscountType: type,
        maxDiscountValue: type === "pct" ? int(i.maxDiscountValue ?? 0, "Max discount %", 0, 10000) : (money(i.maxDiscountValue, "Max discount") ?? 0),
        gstBp
      };
    });
    // Max discount is always worked out: farmer selling price - minimum price.
    for (const i of items) {
      if (Number.isSafeInteger(i.basePrice) && Number.isSafeInteger(i.minPrice)) {
        i.maxDiscountType = "amt";
        i.maxDiscountValue = Math.max(0, i.basePrice - i.minPrice);
      }
    }
    const changed = items.filter((i) => {
      const b = before.get(i.variantId);
      return !b || Object.keys(i).some((k) => i[k] !== b[k]);
    });
    if (!changed.length) return res.json({ ok: true, changed: 0 });
    if (!(await store.saveDraftItems(list.id, changed))) throw new Bad("Only a draft can be changed", 409);
    await audit(req, "update", "price_items", list.id, `${changed.length} price row(s) in "${list.name}"`,
      changed.map((i) => before.get(i.variantId) || null), changed);
    res.json({ ok: true, changed: changed.length });
  }));

  // A draft: any editor. Any other version (even the one in force): an
  // admin only - with no list in force, new quotes stop until one is published.
  staff.delete("/lists/:id", need("editor"), wrap(async (req, res) => {
    const list = await loadList(req);
    if (list.status !== "draft" && req.pricingRole !== "owner") throw new Bad("Only an admin can delete a list that isn't a draft", 403);
    const r = await store.deleteList(list.id);
    if (!r) throw new Bad("Price list not found", 404);
    await audit(req, "delete", "price_list", list.id, `"${list.name}" (${list.status}) deleted${r.quotes ? ` - ${r.quotes} quote(s) keep their prices` : ""}`, list);
    res.json({ ok: true, quotes: r.quotes });
  }));

  // Everything that must hold before a list goes for approval / live.
  async function readinessProblems(list) {
    const problems = [];
    if (!list.effectiveFrom) problems.push("Set the 'Effective from' date");
    const items = (await store.items(list.id)).filter((i) => i.active);
    if (!items.length) problems.push("The list has no active products");
    const cat = await store.catalogue();
    const variants = new Map(cat.variants.map((v) => [v.id, v]));
    const products = new Map(cat.products.map((p) => [p.id, p]));
    for (const i of items) {
      const v = variants.get(i.variantId);
      const p = v && products.get(v.productId);
      const errs = priceProblems({ ...i, kind: p?.kind });
      if (errs.length) problems.push(`${p?.name || "?"} ${v?.name && v.name !== "Standard" ? `(${v.name}) ` : ""}- ${errs[0]}`);
    }
    return problems;
  }

  staff.post("/lists/:id/submit", need("editor"), wrap(async (req, res) => {
    const list = await loadList(req);
    if (list.status !== "draft") throw new Bad("Only a draft can be submitted", 409);
    await store.normalizeDiscounts(list.id);
    const problems = await readinessProblems(list);
    if (problems.length) return res.status(400).json({ error: `Fix ${problems.length} problem(s) first`, problems });
    if (!(await store.setStatus(list.id, "draft", "submitted", actorOf(req), { rejectReason: null }))) throw new Bad("Only a draft can be submitted", 409);
    await audit(req, "submit", "price_list", list.id, `"${list.name}" sent for approval`);
    res.json({ ok: true });
  }));

  staff.post("/lists/:id/approve", need("approver"), wrap(async (req, res) => {
    const list = await loadList(req);
    if (list.status !== "submitted") throw new Bad("Only a submitted list can be approved", 409);
    const s = await settings();
    if (s.requireSecondApprover && list.submittedBy === actorOf(req)) throw new Bad("Another approver must approve a list you submitted", 403);
    const problems = await readinessProblems(list);
    if (problems.length) return res.status(400).json({ error: `Fix ${problems.length} problem(s) first`, problems });
    if (!(await store.setStatus(list.id, "submitted", "approved", actorOf(req)))) throw new Bad("Only a submitted list can be approved", 409);
    await audit(req, "approve", "price_list", list.id, `"${list.name}" approved`);
    res.json({ ok: true });
  }));

  staff.post("/lists/:id/reject", need("approver"), wrap(async (req, res) => {
    const list = await loadList(req);
    const reason = text(req.body?.reason, "Reason", 500);
    if (!(await store.setStatus(list.id, ["submitted", "approved"], "draft", actorOf(req), { rejectReason: reason }))) {
      throw new Bad("Only a submitted or approved list can go back to draft", 409);
    }
    await audit(req, "reject", "price_list", list.id, `"${list.name}" back to draft${reason ? `: ${reason}` : ""}`);
    res.json({ ok: true });
  }));

  staff.post("/lists/:id/publish", need("approver"), wrap(async (req, res) => {
    const list = await loadList(req);
    if (list.status !== "approved") throw new Bad("Approve the list before publishing", 409);
    const t = now();
    // A start date already passed means "from now".
    const from = new Date(Math.max(new Date(list.effectiveFrom).getTime(), t));
    const to = list.effectiveTo ? new Date(list.effectiveTo) : null;
    if (to && to <= from) throw new Bad("This list's end date has already passed - change the dates (reject to draft)", 409);
    const r = await store.publish(list.id, actorOf(req), from, to, rangesOverlap);
    if (!r.ok) throw new Bad(r.error, 409);
    await audit(req, "publish", "price_list", list.id,
      `"${list.name}" published from ${from.toISOString()}${r.endedListId ? `, replacing v${r.endedVersion}` : ""}`);
    res.json({ ok: true, effectiveFrom: from, endedListId: r.endedListId, endedVersion: r.endedVersion });
  }));

  // Ends a live list now, or cancels one not started yet. With no list in
  // force, new quotes are blocked until another is published.
  staff.post("/lists/:id/end", need("approver"), wrap(async (req, res) => {
    const list = await loadList(req);
    const status = await store.endList(list.id, new Date(now()));
    if (!status) throw new Bad("Only a published list that hasn't ended can be ended", 409);
    await audit(req, status === "cancelled" ? "cancel" : "end", "price_list", list.id, `"${list.name}" ${status === "cancelled" ? "cancelled" : "ended now"}`);
    res.json({ ok: true, status });
  }));

  // ---------- staff: audit, roles, settings ----------

  staff.get("/audit", wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 60) || null : null;
    const { entries, total } = await store.auditLog(search, PAGE, (page - 1) * PAGE);
    res.json({ entries: seesCost(req) ? entries : noCost(entries), total, page, pageSize: PAGE });
  }));

  // body: { ids: [..] } or { all: true }. Admins only; the deletion itself
  // is logged as the first entry of what's left.
  staff.post("/audit/delete", need("owner"), wrap(async (req, res) => {
    const all = req.body?.all === true;
    const ids = all ? null : (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((x) => String(x)).filter((x) => /^\d{1,18}$/.test(x)).slice(0, 500);
    if (!all && !ids.length) throw new Bad("Choose the entries to delete");
    const n = await store.deleteAudit(ids);
    await audit(req, "delete", "audit_log", null, all ? `Whole audit log deleted (${n} entries)` : `${n} audit entr${n === 1 ? "y" : "ies"} deleted`);
    res.json({ ok: true, deleted: n });
  }));

  staff.get("/settings", wrap(async (req, res) => {
    res.json({ settings: await settings(), staff: await store.staff(), role: req.pricingRole });
  }));

  staff.put("/settings", need("owner"), wrap(async (req, res) => {
    const b = req.body || {};
    const before = await settings();
    const next = {
      quoteValidityDays: int(b.quoteValidityDays ?? before.quoteValidityDays, "Quote validity (days)", 1, 365),
      expiryWarningDays: int(b.expiryWarningDays ?? before.expiryWarningDays, "Expiry warning (days)", 1, 90),
      homeState: text(b.homeState ?? before.homeState, "Home state", 40, { required: true }),
      requireSecondApprover: bool(b.requireSecondApprover, before.requireSecondApprover),
      showMrpDiscount: bool(b.showMrpDiscount, before.showMrpDiscount),
      disclaimer: text(b.disclaimer ?? before.disclaimer, "Disclaimer", 1000, { required: true }),
      companyName: text(b.companyName ?? before.companyName, "Company name", 80, { required: true }),
      companyAddress: text(b.companyAddress ?? before.companyAddress, "Address", 300) || "",
      companyGstin: (text(b.companyGstin ?? before.companyGstin, "GSTIN", 15) || "").toUpperCase(),
      companyPhone: text(b.companyPhone ?? before.companyPhone, "Phone", 40) || "",
      companyEmail: text(b.companyEmail ?? before.companyEmail, "Email", 120) || "",
      companyWebsite: text(b.companyWebsite ?? before.companyWebsite, "Website", 120) || "",
      quoteTerms: text(b.quoteTerms ?? before.quoteTerms, "Terms & conditions", 5000) || ""
    };
    if (next.companyGstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(next.companyGstin)) throw new Bad("GSTIN should be 15 characters, like 33ABCDE1234F1Z5");
    await store.saveSettings(next);
    await audit(req, "update", "settings", null, "Pricing settings", before, next);
    res.json({ ok: true, settings: next });
  }));

  staff.put("/staff", need("owner"), wrap(async (req, res) => {
    const email = text(req.body?.email, "Email", 120, { required: true }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Bad("Email looks wrong");
    const role = req.body?.role || null;
    if (role && !["viewer", "editor", "approver"].includes(role)) throw new Bad("Role must be viewer, editor or approver");
    const before = await store.staffRole(email);
    await store.setStaff(email, role, actorOf(req));
    await audit(req, role ? "grant" : "revoke", "staff", email, `${email}: ${before || "none"} -> ${role || "none"}`);
    res.json({ ok: true });
  }));

  return { router };
}
