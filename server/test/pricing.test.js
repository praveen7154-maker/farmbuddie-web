import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.ADMIN_EMAILS = "owner@farmbuddie.com";
const R = await import("../src/bridge/pricingRules.js");

// ₹ -> paise
const P = (r) => Math.round(r * 100);
const row = (o = {}) => ({
  mrp: P(2000), distributorPrice: P(1000), basePrice: P(1500), minPrice: P(1200), maxPrice: P(1600),
  maxDiscountType: "pct", maxDiscountValue: 1000, gstBp: 1800, kind: "goods", ...o
});

test("price row rules", () => {
  assert.deepEqual(R.priceProblems(row()), []);
  assert.match(R.priceProblems(row({ mrp: -1 }))[0], /negative/);
  assert.match(R.priceProblems(row({ basePrice: null }))[0], /missing/);
  assert.match(R.priceProblems(row({ basePrice: 10.5 }))[0], /negative/);   // not whole paise
  assert.match(R.priceProblems(row({ minPrice: P(900) })).join(), /loss/);   // floor below distributor price
  assert.match(R.priceProblems(row({ minPrice: P(1550) })).join(), /above the farmer selling price/);
  assert.match(R.priceProblems(row({ maxPrice: P(1400) })).join(), /above the maximum/);
  // ₹1,700 + 18% = ₹2,006 > MRP ₹2,000
  assert.match(R.priceProblems(row({ maxPrice: P(1700) })).join(), /more than the MRP/);
  assert.match(R.priceProblems(row({ gstBp: 1500 })).join(), /GST slab/);
  assert.match(R.priceProblems(row({ maxDiscountValue: 10001 })).join(), /over 100%/);
  assert.match(R.priceProblems(row({ maxDiscountType: "amt", maxDiscountValue: P(1600) })).join(), /more than the farmer selling price/);
  // A service has no MRP.
  assert.deepEqual(R.priceProblems(row({ kind: "service", mrp: null })), []);
  assert.match(R.priceProblems(row({ kind: "goods", mrp: null })).join(), /MRP is missing/);
});

test("floor = the higher of the minimum price and base - max discount", () => {
  // The example: base ₹1,500, 10% max discount (₹150), minimum ₹1,400 -> ₹1,400
  assert.equal(R.floorPrice(row({ minPrice: P(1400) })), P(1400));
  // Minimum lower than the discount allows -> discount decides: ₹1,350
  assert.equal(R.floorPrice(row({ minPrice: P(1100) })), P(1350));
  assert.equal(R.floorPrice(row({ maxDiscountType: "amt", maxDiscountValue: P(50), minPrice: P(1100) })), P(1450));
  assert.match(R.priceWarnings(row({ minPrice: P(1400) }))[0], /limits the discount/);
});

function prices() {
  const items = [
    { variantId: 1, productId: 1, sku: "FB-HUB", productName: "Motor Master Hub", variantName: "Standard", role: "hub", attributes: {}, unit: "pcs", kind: "goods",
      ...row({ mrp: P(2000), distributorPrice: P(1000), basePrice: P(1500), minPrice: P(1200), maxPrice: P(1600) }) },
    { variantId: 2, productId: 2, sku: "FB-MN", productName: "Motor Node", variantName: "Standard", role: "motor_node", attributes: {}, unit: "pcs", kind: "goods",
      ...row({ mrp: P(1200), distributorPrice: P(600), basePrice: P(900), minPrice: P(700), maxPrice: P(1000) }) },
    { variantId: 3, productId: 3, sku: "FB-VNS-4", productName: "Valve Node - 24V AC Solenoid", variantName: "4 channel", role: "valve_node",
      attributes: { channels: 4, valveType: "solenoid24" }, unit: "pcs", kind: "goods",
      ...row({ mrp: P(1200), distributorPrice: P(500), basePrice: P(800), minPrice: P(600), maxPrice: P(1000) }) },
    { variantId: 4, productId: 3, sku: "FB-VNS-8", productName: "Valve Node - 24V AC Solenoid", variantName: "8 channel", role: "valve_node",
      attributes: { channels: 8, valveType: "solenoid24" }, unit: "pcs", kind: "goods",
      ...row({ mrp: P(1800), distributorPrice: P(800), basePrice: P(1300), minPrice: P(1000), maxPrice: P(1500) }) },
    { variantId: 5, productId: 4, sku: "FB-SV24", productName: "24V AC Solenoid Valve", variantName: "Standard", role: "valve",
      attributes: { valveType: "solenoid24" }, unit: "pcs", kind: "goods",
      ...row({ mrp: P(600), distributorPrice: P(250), basePrice: P(400), minPrice: P(300), maxPrice: P(500) }) },
    { variantId: 6, productId: 5, sku: "FB-TR2A", productName: "Transformer", variantName: "Standard", role: "transformer", attributes: {}, unit: "pcs", kind: "goods",
      ...row({ mrp: P(500), distributorPrice: P(200), basePrice: P(300), minPrice: P(250), maxPrice: P(400) }) },
    { variantId: 7, productId: 6, sku: "FB-INST-SITE", productName: "Installation - per site", variantName: "Standard", role: "install_site", attributes: {},
      unit: "site", kind: "service",
      ...row({ mrp: null, kind: "service", distributorPrice: P(0), basePrice: P(1000), minPrice: P(500), maxPrice: P(2000), maxDiscountValue: 5000 }) },
    { variantId: 8, productId: 7, sku: "FB-ANT", productName: "Antenna", variantName: "Standard", role: "antenna", attributes: {}, unit: "pcs", kind: "goods",
      ...row({ mrp: P(300), distributorPrice: P(100), basePrice: P(200), minPrice: P(150), maxPrice: P(250), gstBp: 1200 }) }
  ];
  return new Map(items.map((i) => [i.variantId, i]));
}

test("quote: per-line prices, discount, GST split, round-off", () => {
  const q = R.calculateQuote(prices(), [
    { variantId: 1, qty: 1, discountType: "pct", discountValue: 500 },   // 5% of ₹1,500 = ₹75
    { variantId: 2, qty: 2, discountType: "amt", discountValue: P(50) },
    { variantId: 8, qty: 1 }
  ], { customerState: "tamil nadu" });
  assert.equal(q.ok, true);
  assert.equal(q.lines[0].unitPrice, P(1425));
  assert.equal(q.lines[1].taxable, P(1700));
  assert.equal(q.totals.gross, P(1500 + 1800 + 200));
  assert.equal(q.totals.discount, P(75 + 100));
  assert.equal(q.totals.taxable, P(1425 + 1700 + 200));
  // 18% of 3125 = 562.50, 12% of 200 = 24
  assert.equal(q.totals.gst, P(562.5) + P(24));
  assert.equal(q.totals.interState, false);
  const g18 = q.totals.gstBreakup.find((g) => g.gstBp === 1800);
  assert.equal(g18.cgst + g18.sgst, P(562.5));
  assert.equal(g18.igst, 0);
  // 3325 + 586.50 = 3911.50 -> 3912 (round-off +0.50)
  assert.equal(q.totals.payable, P(3912));
  assert.equal(q.totals.roundOff, 50);
  assert.equal(q.totals.margin, P(425 + 2 * 250 + 100));
  // Another state -> IGST
  const k = R.calculateQuote(prices(), [{ variantId: 1, qty: 1 }], { customerState: "Karnataka" });
  assert.equal(k.totals.interState, true);
  assert.equal(k.totals.gstBreakup[0].igst, P(270));
});

test("quote: discount past the floor, bad quantities and unknown products are refused", () => {
  const p = prices();
  const over = R.calculateQuote(p, [{ variantId: 1, qty: 1, discountType: "pct", discountValue: 2000 }]);
  assert.equal(over.ok, false);
  assert.match(over.errors[0].error, /lowest allowed price is ₹1,350.00/);
  assert.equal(R.calculateQuote(p, [{ variantId: 1, qty: 1, unitPrice: P(1349) }]).ok, false);
  assert.equal(R.calculateQuote(p, [{ variantId: 1, qty: 1, unitPrice: P(1350) }]).ok, true);
  assert.match(R.calculateQuote(p, [{ variantId: 1, qty: 1, unitPrice: P(1601) }]).errors[0].error, /highest allowed/);
  for (const qty of [0, -1, 1.5, "x", 10000]) assert.equal(R.calculateQuote(p, [{ variantId: 1, qty }]).ok, false, `qty ${qty}`);
  assert.match(R.calculateQuote(p, [{ variantId: 99, qty: 1 }]).errors[0].error, /isn't in the current price list/);
  assert.equal(R.calculateQuote(p, [{ variantId: 1, qty: 1, discountType: "pct", discountValue: -5 }]).ok, false);
  assert.equal(R.calculateQuote(p, []).ok, false);
});

test("quick builder: 3 motors + 6 solenoid valves", () => {
  const acc = [{ productId: 3, accessoryVariantId: 6, mode: "required", qtyPer: 1, perUnits: 1 },
    { productId: 1, accessoryVariantId: 8, mode: "optional", qtyPer: 1, perUnits: 1 }];
  const b = R.quickBuild(prices(), acc, { motors: 3, valves: 6, valveType: "solenoid24", installation: true });
  assert.equal(b.ok, true);
  const q = Object.fromEntries(b.lines.map((l) => [l.variantId, l.qty]));
  // 1 hub, 2 motor nodes, 8-ch node (₹1,300) beats 2 x 4-ch (₹1,600), 6 valves,
  // 1 transformer for the 1 valve node, installation per site.
  assert.deepEqual(q, { 1: 1, 2: 2, 4: 1, 5: 6, 6: 1, 7: 1 });
  assert.deepEqual(b.suggestions.map((s) => s.variantId), [8]);
  assert.match(b.notes.join(), /2 spare valve channel/);
  // 4 valves -> one 4-channel node
  const four = R.quickBuild(prices(), acc, { motors: 1, valves: 4, valveType: "solenoid24" });
  assert.deepEqual(Object.fromEntries(four.lines.map((l) => [l.variantId, l.qty])), { 1: 1, 3: 1, 5: 4, 6: 1 });
  assert.equal(R.quickBuild(prices(), acc, { motors: 5, valves: 0 }).ok, false);
  assert.equal(R.quickBuild(prices(), acc, { motors: 1, valves: 65, valveType: "solenoid24" }).ok, false);
  assert.match(R.quickBuild(prices(), acc, { motors: 1, valves: 2, valveType: "butterfly230" }).error, /No 230V AC Butterfly valve/);
});

test("cheapest valve-node mix", () => {
  const n4 = { basePrice: 800, attributes: { channels: 4 } };
  const n8 = { basePrice: 1300, attributes: { channels: 8 } };
  const mix = (need) => R.cheapestNodeMix([n4, n8], need).map(([n, c]) => `${n.attributes.channels}x${c}`).sort().join(",");
  assert.equal(mix(3), "4x1");
  assert.equal(mix(6), "8x1");
  assert.equal(mix(12), "4x1,8x1");
  assert.equal(mix(16), "8x2");
});

test("live status and overlaps", () => {
  const t = Date.parse("2026-10-13T00:00:00Z");
  assert.equal(R.liveStatus({ effectiveFrom: "2026-10-14T00:00:00Z" }, t), "scheduled");
  assert.equal(R.liveStatus({ effectiveFrom: "2026-10-01T00:00:00Z" }, t), "active");
  assert.equal(R.liveStatus({ effectiveFrom: "2026-10-01T00:00:00Z", effectiveTo: "2026-10-13T00:00:00Z" }, t), "expired");
  assert.equal(R.rangesOverlap("2026-01-01", "2026-02-01", "2026-02-01", null), false);   // end is exclusive
  assert.equal(R.rangesOverlap("2026-01-01", null, "2027-01-01", null), true);
});

// ---------- the routes, against a real database ----------

const url = process.env.PG_TEST_URL;

test("pricing workflow against a real database", { skip: url ? false : "set PG_TEST_URL to run" }, async () => {
  process.env.BRIDGE_PG_CONNECTION_STRING = url;
  const { pool } = await import("../src/bridge/postgres.js");
  const { ensurePricingSchema, pgPricingStore } = await import("../src/bridge/pricingStore.js");
  const { createPricingModule } = await import("../src/bridge/pricing.js");
  await pool.query(`DROP TABLE IF EXISTS pricing_quotes, price_list_items, price_lists, pricing_accessories, pricing_variants,
    pricing_products, pricing_counters, pricing_audit, pricing_staff, pricing_settings CASCADE`);
  await ensurePricingSchema();
  await ensurePricingSchema();   // re-runs safely, seeds once

  let clock = Date.parse("2026-10-13T06:00:00Z");
  const mod = createPricingModule({
    store: pgPricingStore,
    findDistributor: async (id) => (id === "D26FBA0001" ? { state: "Karnataka" } : null),
    now: () => clock
  });
  const app = express();
  app.use((req, res, next) => {
    const who = req.headers["x-who"] || "";
    req.decodedToken = who.startsWith("dist:") ? { distributorId: who.slice(5) } : who.startsWith("phone:") ? { phone_number: who.slice(6) } : { email: who };
    next();
  });
  app.use("/pricing", mod.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (who, path, method = "GET", body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-who": who }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const OWNER = "owner@farmbuddie.com", DIST = "dist:D26FBA0001";
  try {
    // Access
    assert.equal((await call("phone:+919000000001", "/pricing/current")).status, 403);
    assert.equal((await call("someone@gmail.com", "/pricing/current")).status, 403);
    assert.equal((await call(DIST, "/pricing/admin/catalog")).status, 403);

    // Seeded catalogue
    const cat = (await call(OWNER, "/pricing/admin/catalog")).body;
    assert.equal(cat.products.length, 14);
    assert.equal(cat.variants.length, 16);   // two 4/8-channel valve nodes
    assert.equal(cat.accessories.length, 2);
    const vid = (sku) => cat.variants.find((v) => v.sku === sku).id;

    // No list yet: calculator blocked
    assert.equal((await call(DIST, "/pricing/current")).body.list, null);
    assert.equal((await call(DIST, "/pricing/quote/preview", "POST", { lines: [{ variantId: vid("FB-HUB"), qty: 1 }] })).status, 409);

    // Draft
    const { id: listId } = (await call(OWNER, "/pricing/admin/lists", "POST", { name: "Launch prices" })).body;
    let detail = (await call(OWNER, `/pricing/admin/lists/${listId}`)).body;
    assert.equal(detail.items.length, 16);
    assert.equal(detail.list.status, "draft");
    // Submitting with missing prices is refused, listing the rows
    let r = await call(OWNER, `/pricing/admin/lists/${listId}/submit`, "POST");
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.length >= 16);

    const priced = {
      "FB-HUB": [2000, 1000, 1500, 1350, 1600], "FB-MN": [1200, 600, 900, 700, 1000],
      "FB-VNS-4": [1200, 500, 800, 600, 1000], "FB-VNS-8": [1800, 800, 1300, 1000, 1500],
      "FB-SV24": [600, 250, 400, 300, 500], "FB-TR2A": [500, 200, 300, 250, 400], "FB-ANT": [300, 100, 200, 150, 250]
    };
    const items = detail.items.map((i) => {
      const p = priced[i.sku];
      if (!p) return { variantId: i.variantId, active: false, gstBp: i.gstBp };
      const [mrp, dp, b, mn, mx] = p.map(P);
      return { variantId: i.variantId, active: true, mrp, distributorPrice: dp, basePrice: b, minPrice: mn, maxPrice: mx,
        maxDiscountType: "pct", maxDiscountValue: 1000, gstBp: 1800, costPrice: Math.round(dp * 0.6) };   // our cost = 60% of the distributor price
    });
    // Negative and fractional values are refused outright
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/items`, "PUT", { items: [{ ...items[0], mrp: -5 }] })).status, 400);
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/items`, "PUT", { items: [{ ...items[0], mrp: 1.5 }] })).status, 400);
    r = await call(OWNER, `/pricing/admin/lists/${listId}/items`, "PUT", { items });
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 16);
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/items`, "PUT", { items })).body.changed, 0);   // nothing new

    r = await call(OWNER, `/pricing/admin/lists/${listId}/submit`, "POST");
    assert.match(r.body.problems.join(), /Effective from/);
    await call(OWNER, `/pricing/admin/lists/${listId}`, "PUT", { name: "Launch prices", effectiveFrom: "2026-10-01T00:00:00+05:30" });
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/submit`, "POST")).status, 200);
    // Locked once submitted
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/items`, "PUT", { items })).status, 409);
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/publish`, "POST")).status, 409);   // not approved yet
    assert.equal((await call(OWNER, `/pricing/admin/lists/${listId}/approve`, "POST")).status, 200);
    r = await call(OWNER, `/pricing/admin/lists/${listId}/publish`, "POST");
    assert.equal(r.status, 200);
    assert.equal(new Date(r.body.effectiveFrom).getTime(), clock);   // a past start date means now

    // Distributor view: read-only, sees buying price
    let cur = (await call(DIST, "/pricing/current")).body;
    assert.equal(cur.list.id, listId);
    assert.equal(cur.items.length, 7);
    const hub = cur.items.find((i) => i.sku === "FB-HUB");
    assert.equal(hub.distributorPrice, P(1000));
    // Max discount is worked out by the server: selling - minimum
    assert.equal(hub.maxDiscountType, "amt");
    assert.equal(hub.maxDiscountValue, P(150));
    // Our cost never reaches a distributor; the owner sees it with our profit
    assert.equal(hub.costPrice, undefined);
    assert.ok(!JSON.stringify(cur).includes("costPrice"));
    const ownerHub = (await call(OWNER, "/pricing/current")).body.items.find((i) => i.sku === "FB-HUB");
    assert.equal(ownerHub.costPrice, P(600));
    assert.deepEqual(ownerHub.ourProfit, { direct: P(900), viaDistributor: P(400) });
    assert.equal(hub.floorPrice, P(1350));
    assert.equal(cur.myState, "Karnataka");
    assert.equal((await call(DIST, `/pricing/admin/lists/${listId}/items`, "PUT", { items })).status, 403);

    // Quick build + preview: Karnataka distributor -> IGST
    const built = (await call(DIST, "/pricing/quote/build", "POST", { motors: 3, valves: 6, valveType: "solenoid24" })).body;
    assert.equal(built.ok, true);
    let pv = (await call(DIST, "/pricing/quote/preview", "POST", { lines: built.lines })).body;
    assert.equal(pv.ok, true);
    assert.equal(pv.totals.interState, true);
    // Discount past the floor -> refused on save too
    r = await call(DIST, "/pricing/quotes", "POST", { customerName: "Murugan", lines: [{ variantId: vid("FB-HUB"), qty: 1, discountType: "pct", discountValue: 2500 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /lowest allowed/);
    // A client-sent price field is ignored - only discount/unitPrice count, both checked
    r = await call(DIST, "/pricing/quotes", "POST", {
      customerName: "Murugan", customerPhone: "9000000001", customerState: "Tamil Nadu",
      lines: [{ variantId: vid("FB-HUB"), qty: 1, basePrice: 1, listPrice: 1 }, { variantId: vid("FB-MN"), qty: 2, discountType: "pct", discountValue: 1000 }]
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.quoteNo, "FBQ26-000001");
    const quote = r.body.quote;
    assert.equal(quote.lines[0].unitPrice, P(1500));
    assert.equal(quote.totals.interState, false);
    assert.equal(quote.distributorId, "D26FBA0001");
    assert.equal(quote.profit, undefined);                      // not for the distributor
    assert.ok(!JSON.stringify(quote).includes("costPrice"));
    // The owner sees our profit on the distributor's quote: they buy at the distributor price
    // hub 1000 - 600 + 2 x (600 - 360) = 880
    assert.equal((await call(OWNER, `/pricing/quotes/${quote.id}`)).body.quote.profit.ourProfit, P(880));
    // and on a direct preview: hub sold at 1500 -> 900 profit
    assert.equal((await call(OWNER, "/pricing/quote/preview", "POST", { lines: [{ variantId: vid("FB-HUB"), qty: 1 }] })).body.profit.ourProfit, P(900));
    // 15-day validity
    assert.equal(new Date(quote.validUntil).getTime(), clock + 15 * 24 * 3600 * 1000);
    // Another distributor can't see it; the owner can
    assert.equal((await call("dist:D26FBA0002", `/pricing/quotes/${quote.id}`)).status, 404);
    assert.equal((await call("dist:D26FBA0002", "/pricing/quotes")).body.total, 0);
    assert.equal((await call(OWNER, "/pricing/quotes?search=murugan")).body.total, 1);
    assert.equal((await call(DIST, "/pricing/quotes")).body.quotes[0].quoteNo, "FBQ26-000001");

    // New version: copy, raise the hub, schedule for later
    const { id: v2 } = (await call(OWNER, "/pricing/admin/lists", "POST", { name: "Diwali prices" })).body;
    detail = (await call(OWNER, `/pricing/admin/lists/${v2}`)).body;
    assert.equal(detail.compareWith.id, listId);
    const hubRow = detail.items.find((i) => i.sku === "FB-HUB");
    assert.equal(hubRow.current.basePrice, P(1500));
    await call(OWNER, `/pricing/admin/lists/${v2}/items`, "PUT", { items: [{ ...hubRow, basePrice: P(1550) }] });
    await call(OWNER, `/pricing/admin/lists/${v2}`, "PUT", { name: "Diwali prices", effectiveFrom: "2026-10-20T00:00:00+05:30" });
    await call(OWNER, `/pricing/admin/lists/${v2}/submit`, "POST");
    // Reject sends it back to draft with a reason
    await call(OWNER, `/pricing/admin/lists/${v2}/reject`, "POST", { reason: "check MN price" });
    assert.equal((await call(OWNER, `/pricing/admin/lists/${v2}`)).body.list.rejectReason, "check MN price");
    await call(OWNER, `/pricing/admin/lists/${v2}/submit`, "POST");
    await call(OWNER, `/pricing/admin/lists/${v2}/approve`, "POST");
    r = await call(OWNER, `/pricing/admin/lists/${v2}/publish`, "POST");
    assert.equal(r.status, 200);
    assert.equal(r.body.endedListId, listId);   // the launch list ends when Diwali starts
    cur = (await call(DIST, "/pricing/current")).body;
    assert.equal(cur.list.id, listId);          // still launch prices today
    assert.equal(cur.list.expiresSoon, true);   // ends in 7 days
    assert.equal(cur.next.id, v2);
    clock = Date.parse("2026-10-20T00:00:00+05:30");
    cur = (await call(DIST, "/pricing/current")).body;
    assert.equal(cur.list.id, v2);
    assert.equal(cur.items.find((i) => i.sku === "FB-HUB").basePrice, P(1550));
    // The old quote kept its prices, and is now past its validity? (15 days not yet)
    assert.equal((await call(DIST, `/pricing/quotes/${quote.id}`)).body.quote.lines[0].unitPrice, P(1500));

    // An overlapping third list is refused
    const { id: v3 } = (await call(OWNER, "/pricing/admin/lists", "POST", { name: "Clash", basedOnId: v2 })).body;
    await call(OWNER, `/pricing/admin/lists/${v3}`, "PUT", { name: "Clash", effectiveFrom: "2026-10-15T00:00:00+05:30" });
    await call(OWNER, `/pricing/admin/lists/${v3}/submit`, "POST");
    await call(OWNER, `/pricing/admin/lists/${v3}/approve`, "POST");
    // its start (15th) is before now, so it publishes "from now" and replaces Diwali
    clock = Date.parse("2026-10-21T00:00:00+05:30");
    r = await call(OWNER, `/pricing/admin/lists/${v3}/publish`, "POST");
    assert.equal(r.status, 200);
    assert.equal(r.body.endedListId, v2);

    // Ending the live list blocks quotes
    await call(OWNER, `/pricing/admin/lists/${v3}/end`, "POST");
    assert.equal((await call(DIST, "/pricing/current")).body.list, null);
    assert.equal((await call(DIST, "/pricing/quote/preview", "POST", { lines: [{ variantId: vid("FB-HUB"), qty: 1 }] })).status, 409);

    // Quote expiry: accepting an expired quote is refused
    clock = Date.parse("2026-11-30T00:00:00+05:30");
    assert.equal((await call(DIST, `/pricing/quotes/${quote.id}`)).body.quote.expired, true);
    assert.equal((await call(DIST, `/pricing/quotes/${quote.id}/status`, "POST", { status: "accepted" })).status, 400);
    assert.equal((await call(DIST, `/pricing/quotes/${quote.id}/status`, "POST", { status: "cancelled" })).status, 200);

    // Roles: a viewer can look, not edit; an editor can't approve
    await call(OWNER, "/pricing/admin/staff", "PUT", { email: "viewer@farmbuddie.com", role: "viewer" });
    await call(OWNER, "/pricing/admin/staff", "PUT", { email: "editor@farmbuddie.com", role: "editor" });
    assert.equal((await call("viewer@farmbuddie.com", "/pricing/admin/lists")).status, 200);
    // A viewer sees prices but not our cost - not in the list, not in the audit log
    assert.ok(!JSON.stringify((await call("viewer@farmbuddie.com", `/pricing/admin/lists/${listId}`)).body).includes("costPrice"));
    assert.ok(!JSON.stringify((await call("viewer@farmbuddie.com", "/pricing/admin/audit")).body).includes("costPrice"));
    assert.ok(JSON.stringify((await call(OWNER, "/pricing/admin/audit")).body).includes("costPrice"));
    assert.ok(!JSON.stringify((await call("viewer@farmbuddie.com", "/pricing/current")).body).includes("costPrice"));
    assert.equal((await call("viewer@farmbuddie.com", "/pricing/admin/lists", "POST", { name: "x" })).status, 403);
    const { id: v4 } = (await call("editor@farmbuddie.com", "/pricing/admin/lists", "POST", { name: "Editor draft", basedOnId: v2 })).body;
    await call("editor@farmbuddie.com", `/pricing/admin/lists/${v4}`, "PUT", { name: "Editor draft", effectiveFrom: "2027-01-01T00:00:00+05:30" });
    assert.equal((await call("editor@farmbuddie.com", `/pricing/admin/lists/${v4}/submit`, "POST")).status, 200);
    assert.equal((await call("editor@farmbuddie.com", `/pricing/admin/lists/${v4}/approve`, "POST")).status, 403);
    assert.equal((await call("editor@farmbuddie.com", "/pricing/admin/settings", "PUT", { quoteValidityDays: 30 })).status, 403);
    // Two-person rule when switched on
    await call(OWNER, "/pricing/admin/settings", "PUT", { requireSecondApprover: true });
    await call(OWNER, "/pricing/admin/staff", "PUT", { email: "approver@farmbuddie.com", role: "approver" });
    const { id: v5 } = (await call("approver@farmbuddie.com", "/pricing/admin/lists", "POST", { name: "Own", basedOnId: v2 })).body;
    await call("approver@farmbuddie.com", `/pricing/admin/lists/${v5}`, "PUT", { name: "Own", effectiveFrom: "2027-02-01T00:00:00+05:30" });
    await call("approver@farmbuddie.com", `/pricing/admin/lists/${v5}/submit`, "POST");
    assert.equal((await call("approver@farmbuddie.com", `/pricing/admin/lists/${v5}/approve`, "POST")).status, 403);
    assert.equal((await call(OWNER, `/pricing/admin/lists/${v5}/approve`, "POST")).status, 200);
    await call(OWNER, "/pricing/admin/settings", "PUT", { requireSecondApprover: false });
    assert.equal((await call(OWNER, `/pricing/admin/lists/${v5}/publish`, "POST")).status, 200);   // scheduled for Feb
    // A list starting before that scheduled one and running into it is refused
    const { id: v6 } = (await call(OWNER, "/pricing/admin/lists", "POST", { name: "Clash 2", basedOnId: v2 })).body;
    await call(OWNER, `/pricing/admin/lists/${v6}`, "PUT", { name: "Clash 2", effectiveFrom: "2027-01-15T00:00:00+05:30" });
    await call(OWNER, `/pricing/admin/lists/${v6}/submit`, "POST");
    await call(OWNER, `/pricing/admin/lists/${v6}/approve`, "POST");
    r = await call(OWNER, `/pricing/admin/lists/${v6}/publish`, "POST");
    assert.equal(r.status, 409);
    assert.match(r.body.error, /overlap "Own"/);

    // Catalogue edits
    r = await call(OWNER, "/pricing/admin/products", "POST", { sku: "fb-hub", name: "Dup", category: "controller" });
    assert.equal(r.status, 409);
    r = await call(OWNER, "/pricing/admin/products", "POST", { sku: "FB-SV24-2IN", name: "Solenoid 2in", category: "valve", gstBp: 1200 });
    assert.equal(r.status, 200);
    assert.equal((await call(OWNER, "/pricing/admin/products", "POST", { sku: "FB-X", name: "x", category: "valve", gstBp: 1500 })).status, 400);
    r = await call(OWNER, `/pricing/admin/products/${cat.products.find((p) => p.sku === "FB-VNS").id}/variants`, "POST",
      { sku: "FB-VNS-16", name: "16 channel", attributes: { channels: 16, valveType: "solenoid24" } });
    assert.equal(r.status, 200);
    assert.equal((await call(OWNER, `/pricing/admin/variants/${r.body.id}`, "PUT", { sku: "FB-VNS-8", name: "x" })).status, 409);

    // Deleting: a product (admin only) leaves every list; quotes keep their copy
    const sv = cat.products.find((p) => p.sku === "FB-SV24");
    assert.equal((await call("editor@farmbuddie.com", `/pricing/admin/products/${sv.id}`, "DELETE")).status, 403);
    r = await call(OWNER, `/pricing/admin/products/${sv.id}`, "DELETE");
    assert.equal(r.status, 200);
    assert.ok(r.body.lists >= 1);
    assert.ok(!(await call(OWNER, "/pricing/admin/catalog")).body.products.some((p) => p.sku === "FB-SV24"));
    // the only variant can't go alone
    const mnVariant = cat.variants.find((v) => v.sku === "FB-MN");
    assert.equal((await call(OWNER, `/pricing/admin/variants/${mnVariant.id}`, "DELETE")).status, 409);
    // A whole published list (admin only); its quote stays, without the link
    assert.equal((await call("editor@farmbuddie.com", `/pricing/admin/lists/${listId}`, "DELETE")).status, 403);
    r = await call(OWNER, `/pricing/admin/lists/${listId}`, "DELETE");
    assert.equal(r.status, 200);
    assert.equal(r.body.quotes, 1);
    const kept = (await call(OWNER, `/pricing/quotes/${quote.id}`)).body.quote;
    assert.equal(kept.listId, null);
    assert.equal(kept.lines[0].unitPrice, P(1500));

    // Audit log: every step recorded, and the database refuses edits
    const log = (await call(OWNER, "/pricing/admin/audit?search=publish")).body;
    assert.ok(log.total >= 3);
    await assert.rejects(pool.query(`UPDATE pricing_audit SET actor = 'x'`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM pricing_audit`), /append-only/);
    // ...except an admin's delete, which is itself logged
    const someIds = log.entries.slice(0, 2).map((e) => e.id);
    assert.equal((await call("approver@farmbuddie.com", "/pricing/admin/audit/delete", "POST", { ids: someIds })).status, 403);
    assert.equal((await call(OWNER, "/pricing/admin/audit/delete", "POST", { ids: someIds })).body.deleted, 2);
    r = await call(OWNER, "/pricing/admin/audit/delete", "POST", { all: true });
    assert.ok(r.body.deleted > 10);
    const left = (await call(OWNER, "/pricing/admin/audit")).body;
    assert.equal(left.total, 1);
    assert.match(left.entries[0].summary, /Whole audit log deleted/);
  } finally {
    server.close();
    await pool.end();
  }
});

test("the web panel's copy of the rules is the same file", async () => {
  const { readFile } = await import("node:fs/promises");
  const a = await readFile(new URL("../src/bridge/pricingRules.js", import.meta.url), "utf8");
  const b = await readFile(new URL("../../public/js/pricing-rules.js", import.meta.url), "utf8");
  assert.equal(b, a, "copy server/src/bridge/pricingRules.js to public/js/pricing-rules.js");
});
