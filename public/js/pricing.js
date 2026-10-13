import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import * as R from "/js/pricing-rules.js";

// Admin > Module Pricing. Server side: server/src/bridge/pricing.js; the
// rules (floor, GST, quick builder) are pricing-rules.js - the same file as
// the server's pricingRules.js, so this page shows exactly what the server
// will accept. The server re-checks everything when a quote is saved.

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rs = (p) => (p === null || p === undefined || Number.isNaN(p) ? "–" : R.rupees(p));
const pct = (bp) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const RANK = { viewer: 1, editor: 2, approver: 3, owner: 4 };
const PAGE = 25;
const IST = { timeZone: "Asia/Kolkata" };
const DAY = 24 * 3600 * 1000;
const STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand",
  "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
const CAT_LABEL = { controller: "Controller", node: "Node", valve: "Valve", accessory: "Accessory", power: "Power", system: "System", service: "Service" };
const ROLE_LABEL = {
  hub: "Master hub", motor_node: "Motor node", valve_node: "Valve node", valve: "Valve", transformer: "Transformer", antenna: "Antenna",
  battery: "Battery", backwash: "Filter backwash", install_site: "Installation per site", install_point: "Installation per valve point", transport: "Transport"
};
const WHO = { owner: "Admin · all pricing rights", approver: "Pricing approver", editor: "Pricing editor", viewer: "Pricing viewer" };

// ---------- small helpers ----------

/** "1,500.50" -> 150050 paise; "" -> null; anything else -> NaN. */
function toPaise(s) {
  const t = String(s ?? "").replace(/[,₹\s]/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
const paiseInput = (p) => (p === null || p === undefined ? "" : (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2)));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric" }) : "–");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const istYmd = (t) => new Date(t).toLocaleDateString("en-CA", IST);
const istIsMidnight = (iso) => new Date(iso).toLocaleTimeString("en-GB", { ...IST, hour12: false }).startsWith("00:00");
// An end date is stored as the moment it ends (next midnight) - shown as the last day.
const fmtUntil = (iso) => (!iso ? "No end date" : istIsMidnight(iso) ? fmtDate(new Date(new Date(iso).getTime() - 1).toISOString()) : fmtDateTime(iso));
const fromInputIso = (ymd) => (ymd ? new Date(`${ymd}T00:00:00+05:30`).toISOString() : null);
const toInputIso = (ymd) => (ymd ? new Date(new Date(`${ymd}T00:00:00+05:30`).getTime() + DAY).toISOString() : null);
const isoFromInput = (iso) => (iso ? istYmd(iso) : "");
const isoToInput = (iso) => (iso ? istYmd(new Date(iso).getTime() - 1) : "");

async function api(path, options = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body || {}) });

function showMsg(kind, msg, list) {
  $("pageError").hidden = true;
  $("pageOk").hidden = true;
  if (!msg) return;
  const el = kind === "ok" ? $("pageOk") : $("pageError");
  el.innerHTML = esc(msg) + (list?.length ? `<ul>${list.slice(0, 20).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "");
  el.hidden = false;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
const fail = (err) => showMsg("error", err.message, err.data?.problems);

function pager(el, page, total, onPage) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (total <= PAGE) { el.innerHTML = total ? `<span class="ota-muted">${total} total</span>` : ""; return; }
  const nums = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  el.innerHTML = `<span class="ota-muted">${total} total</span>
    <button data-p="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>
    ${nums.map((p) => `<button data-p="${p}" class="${p === page ? "active" : ""}">${p}</button>`).join("")}
    <button data-p="${page + 1}" ${page >= pages ? "disabled" : ""}>›</button>`;
  el.querySelectorAll("button[data-p]").forEach((b) => b.addEventListener("click", () => onPage(Number(b.dataset.p))));
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- state ----------

let role = null;
let current = null;       // GET /pricing/current
let prices = new Map();   // variantId -> current price row
let catalog = null;       // GET /pricing/admin/catalog
let lists = [];
let settings = null;
const can = (r) => RANK[role] >= RANK[r];

// ---------- init ----------

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.replace("/login.html"); return; }
  try {
    await loadCurrent();
    await Promise.all([loadLists(), loadCatalog()]);
    applyRole();
    renderStatus();
    renderCalcSetup();
    openTab((location.hash || "#calc").slice(1));
  } catch (err) {
    showMsg("error", err.status === 403 ? "Your account has no access to pricing. Ask an admin to give you a pricing role." : err.message);
  }
});
$("logoutBtn")?.addEventListener("click", () => signOut(auth).then(() => window.location.replace("/login.html")));

async function loadCurrent() {
  current = await api("/pricing/current");
  role = current.role;
  prices = new Map(current.items.map((i) => [i.variantId, i]));
}
async function loadLists() {
  const r = await api("/pricing/admin/lists");
  lists = r.lists;
  settings = r.settings;
  renderLists();
}
async function loadCatalog() {
  catalog = await api("/pricing/admin/catalog");
  renderProducts();
}

function applyRole() {
  $("roleBadge").textContent = WHO[role] || role;
  document.querySelectorAll(".pr-edit-only").forEach((el) => { el.hidden = !can("editor"); });
  document.querySelectorAll(".pr-owner-only").forEach((el) => { el.hidden = !can("owner"); });
  showCostCols();
}

function renderStatus() {
  const l = current.list;
  const card = $("curCard");
  card.classList.toggle("bad", !l);
  card.classList.toggle("warn", !!l?.expiresSoon);
  $("curName").textContent = l ? l.name : "None - quotes blocked";
  $("curWhen").textContent = l ? `since ${fmtDate(l.effectiveFrom)} · until ${fmtUntil(l.effectiveTo)}${l.expiresSoon ? " ⚠️ ending soon" : ""}` : "Publish a price list";
  $("nextName").textContent = current.next ? current.next.name : "None scheduled";
  $("nextWhen").textContent = current.next ? `starts ${fmtDateTime(current.next.effectiveFrom)}` : "";
  $("itemCount").textContent = current.items.length;
  const drafts = lists.filter((x) => x.status === "draft").length;
  const waiting = lists.filter((x) => x.status === "submitted" || x.status === "approved").length;
  $("pendingCount").textContent = drafts + waiting;
  $("pendingWhat").textContent = `${drafts} draft · ${waiting} to approve/publish`;
}

// ---------- tabs ----------

const loaded = {};
function openTab(name) {
  if (!document.getElementById(`tab-${name}`)) name = "calc";
  document.querySelectorAll(".pr-tab").forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "quotes" && !loaded.quotes) { loaded.quotes = true; loadQuotes(1); }
  if (name === "audit" && !loaded.audit) { loaded.audit = true; loadAudit(1); }
  if (name === "settings" && !loaded.settings) { loaded.settings = true; loadSettings(); }
}
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));

// =====================================================================
// CALCULATOR
// =====================================================================

let lines = [];          // { variantId, qty, mode: 'pct'|'amt'|'price', value: '' }
let lastCalc = null;

function renderCalcSetup() {
  const blocked = !current.list;
  $("calcBlocked").hidden = !blocked;
  $("calcBody").hidden = blocked;
  if (blocked) return;
  const types = Object.entries(current.valveTypes).filter(([t]) =>
    current.items.some((i) => i.role === "valve" && i.attributes?.valveType === t));
  $("qbType").innerHTML = types.map(([t, label]) => `<option value="${t}">${esc(label)}</option>`).join("");
  $("addList").innerHTML = current.items.map((i) => `<option value="${esc(itemLabel(i))}"></option>`).join("");
  const stateOpts = STATES.map((s) => `<option>${esc(s)}</option>`).join("");
  $("cuState").innerHTML = stateOpts;
  $("cuState").value = current.settings.homeState;
  $("sumDisclaimer").textContent = current.settings.disclaimer;
  renderLines();
}
const itemLabel = (i) => `${i.productName}${i.variantName && i.variantName !== "Standard" ? ` - ${i.variantName}` : ""} (${i.sku})`;

$("qbBuild").addEventListener("click", () => {
  const input = {
    motors: Number($("qbMotors").value), valves: Number($("qbValves").value), valveType: $("qbType").value,
    installation: $("qbInstall").checked, backwash: $("qbBackwash").checked
  };
  const b = R.quickBuild(prices, current.accessories || [], input);
  if (!b.ok) { $("qbNotes").textContent = `⚠️ ${b.error}`; return; }
  lines = b.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, mode: "pct", value: "" }));
  suggestions = b.suggestions;
  $("qbNotes").textContent = b.notes.join(" · ");
  renderLines();
});

let suggestions = [];
function renderSuggestions() {
  const have = new Set(lines.map((l) => l.variantId));
  const s = suggestions.filter((x) => !have.has(x.variantId));
  $("suggestions").innerHTML = s.length ? `<span class="ota-muted">Suggested:</span> ` + s.map((x) =>
    `<button data-v="${x.variantId}" data-q="${x.qty}">+ ${esc(x.productName)}${x.variantName !== "Standard" ? ` (${esc(x.variantName)})` : ""} × ${x.qty}</button>`).join("") : "";
  $("suggestions").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    lines.push({ variantId: Number(b.dataset.v), qty: Number(b.dataset.q), mode: "pct", value: "" });
    renderLines();
  }));
}

function addByText() {
  const t = $("addSearch").value.trim().toLowerCase();
  if (!t) return;
  const hit = current.items.find((i) => itemLabel(i).toLowerCase() === t)
    || current.items.find((i) => i.sku.toLowerCase() === t)
    || current.items.find((i) => itemLabel(i).toLowerCase().includes(t));
  if (!hit) { $("calcStatus").textContent = "No product matches - pick one from the list"; return; }
  const existing = lines.find((l) => l.variantId === hit.variantId);
  if (existing) existing.qty += 1;
  else lines.push({ variantId: hit.variantId, qty: 1, mode: "pct", value: "" });
  $("addSearch").value = "";
  renderLines();
}
$("addBtn").addEventListener("click", addByText);
$("addSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") addByText(); });
$("addSearch").addEventListener("change", addByText);
$("clearLines").addEventListener("click", () => { lines = []; suggestions = []; $("qbNotes").textContent = ""; renderLines(); });
$("allDiscBtn").addEventListener("click", () => {
  const v = $("allDisc").value;
  lines.forEach((l) => { l.mode = "pct"; l.value = v; });
  renderLines();
});

// The rows (structure). Values typed are kept in `lines`; computed cells are
// filled by refreshCalc() without rebuilding, so typing never loses focus.
function renderLines() {
  renderSuggestions();
  const body = $("lineBody");
  if (!lines.length) {
    body.innerHTML = `<tr><td colspan="11" class="ota-muted">Use the Quick builder or add products.</td></tr>`;
    refreshCalc();
    return;
  }
  body.innerHTML = lines.map((l, i) => {
    const p = prices.get(l.variantId);
    return `<tr data-i="${i}">
      <td class="pr-prod"><b>${esc(p?.productName || "Not in the current list")}</b>
        <small>${p && p.variantName !== "Standard" ? `${esc(p.variantName)} · ` : ""}${esc(p?.sku || "")}</small><div class="pr-err" data-c="err"></div></td>
      <td class="num">${p?.mrp ? rs(p.mrp) : "–"}</td>
      <td class="num">${rs(p?.basePrice)}<span class="pr-hint">lowest ${rs(p?.floorPrice)}</span></td>
      <td class="num"><input type="number" class="pr-qty" min="1" max="9999" step="1" value="${l.qty}" data-f="qty"></td>
      <td><span class="pr-disc"><input type="number" min="0" step="0.01" value="${esc(l.value)}" data-f="value" placeholder="0">
        <select data-f="mode"><option value="pct" ${l.mode === "pct" ? "selected" : ""}>% off</option>
          <option value="amt" ${l.mode === "amt" ? "selected" : ""}>₹ off</option>
          <option value="price" ${l.mode === "price" ? "selected" : ""}>₹ price</option></select></span>
        <span class="pr-hint">max ${p ? (p.maxDiscountType === "pct" ? pct(p.maxDiscountValue) : rs(p.maxDiscountValue)) : "–"}</span></td>
      <td class="num" data-c="net"></td>
      <td class="num" data-c="taxable"></td>
      <td class="num" data-c="gst"></td>
      <td class="num" data-c="total"></td>
      <td class="num pr-internal" data-c="margin"></td>
      <td><button class="pr-link danger" data-del="${i}" title="Remove">✕</button></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", (e) => {
    const i = Number(e.target.closest("tr").dataset.i);
    const f = e.target.dataset.f;
    lines[i][f] = f === "qty" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value;
    refreshCalc();
  }));
  body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    lines.splice(Number(b.dataset.del), 1);
    renderLines();
  }));
  refreshCalc();
}

// What the server gets: variant + quantity + discount, never a price list value.
function apiLines() {
  return lines.map((l) => {
    const out = { variantId: l.variantId, qty: l.qty };
    const v = String(l.value ?? "").trim();
    if (v === "") return out;
    if (l.mode === "pct") { out.discountType = "pct"; out.discountValue = Math.round(Number(v) * 100); }
    else if (l.mode === "amt") { out.discountType = "amt"; out.discountValue = toPaise(v); }
    else out.unitPrice = toPaise(v);
    return out;
  });
}

function refreshCalc() {
  const rows = [...$("lineBody").querySelectorAll("tr[data-i]")];
  rows.forEach((tr) => { tr.classList.remove("pr-line-err"); tr.querySelector('[data-c="err"]').textContent = ""; });
  const opts = { customerState: $("cuState").value, homeState: current.settings.homeState };
  const calc = lines.length ? R.calculateQuote(prices, apiLines(), opts) : null;
  lastCalc = calc;
  // Per-line errors (ok lines are still computed in calc.lines, in order)
  const errByLine = new Map((calc?.errors || []).filter((e) => e.line !== null).map((e) => [e.line, e.error]));
  let k = 0;
  rows.forEach((tr, i) => {
    const err = errByLine.get(i);
    const cells = (c) => tr.querySelector(`[data-c="${c}"]`);
    if (err) {
      tr.classList.add("pr-line-err");
      cells("err").textContent = err;
      ["net", "taxable", "gst", "total", "margin"].forEach((c) => { cells(c).textContent = "–"; });
      return;
    }
    const l = calc.lines[k++];
    cells("net").innerHTML = l.unitDiscount !== 0 ? `<span class="pr-strike">${rs(l.listPrice)}</span>${rs(l.unitPrice)}` : rs(l.unitPrice);
    cells("taxable").textContent = rs(l.taxable);
    cells("gst").innerHTML = `${rs(l.gst)}<span class="pr-hint">${pct(l.gstBp)}</span>`;
    cells("total").textContent = rs(l.total);
    cells("margin").textContent = rs(l.margin);
  });
  renderSummary(calc);
}

function renderSummary(calc) {
  const ok = !!calc?.ok;
  ["saveQuote", "printEstimate", "waEstimate"].forEach((id) => { $(id).disabled = !ok; });
  if (!calc) { $("sumBody").innerHTML = `<p class="ota-muted">Nothing added yet.</p>`; $("sumValidity").textContent = ""; return; }
  if (!ok) {
    const general = calc.errors.find((e) => e.line === null);
    $("sumBody").innerHTML = `<p class="pr-err">${esc(general?.error || `Fix ${calc.errors.length} line(s) marked in red`)}</p>`;
    $("sumValidity").textContent = "";
    return;
  }
  $("sumBody").innerHTML = totalsHtml(calc.totals, true);
  // Our own profit if WE sell this directly (admins only - the cost comes only to them).
  const profit = can("editor") ? R.quoteProfit(calc.lines, (v) => prices.get(v)?.costPrice, false) : null;
  if (profit) {
    $("sumBody").insertAdjacentHTML("beforeend", `<div class="row internal"><span>🔒 Our cost</span><span>${rs(profit.ourCost)}</span></div>
      <div class="row internal"><span>🔒 Our profit - direct sale (before GST)</span><span><b>${rs(profit.ourProfit)}</b></span></div>
      <div class="row internal"><span>🔒 Our profit if a distributor sells it</span><span>${rs(R.quoteProfit(calc.lines, (v) => prices.get(v)?.costPrice, true).ourProfit)}</span></div>`);
  } else if (can("editor")) {
    $("sumBody").insertAdjacentHTML("beforeend", `<div class="row internal"><span>🔒 Our profit</span><span class="ota-muted">enter "Our cost" for every product</span></div>`);
  }
  const days = current.settings.quoteValidityDays;
  let until = Date.now() + days * DAY;
  if (current.list.effectiveTo) until = Math.min(until, new Date(current.list.effectiveTo).getTime());
  $("sumValidity").innerHTML = `🗓️ Valid until <b>${fmtDate(new Date(until).toISOString())}</b> · prices of "${esc(current.list.name)}"`;
}

function totalsHtml(t, internal) {
  const row = (a, b, cls = "") => `<div class="row ${cls}"><span>${a}</span><span>${b}</span></div>`;
  let h = row("Products total (list price)", rs(t.gross));
  if (t.discount) h += row("Discount", `− ${rs(t.discount)}`, "disc");
  h += row("<b>Total before GST</b>", `<b>${rs(t.taxable)}</b>`);
  for (const g of t.gstBreakup) {
    if (t.interState) h += row(`IGST ${pct(g.gstBp)} on ${rs(g.taxable)}`, rs(g.igst), "sub");
    else {
      h += row(`CGST ${pct(g.gstBp / 2)} on ${rs(g.taxable)}`, rs(g.cgst), "sub");
      h += row(`SGST ${pct(g.gstBp / 2)} on ${rs(g.taxable)}`, rs(g.sgst), "sub");
    }
  }
  h += row("GST total", rs(t.gst));
  if (t.roundOff) h += row("Round off", `${t.roundOff > 0 ? "+" : "−"} ${rs(Math.abs(t.roundOff))}`, "sub");
  h += row("Estimated total (incl. GST)", rs(t.payable), "total");
  if (internal && t.margin !== undefined) h += row("🔒 Distributor margin (not printed)", rs(t.margin), "internal");
  return h;
}
$("cuState").addEventListener("change", refreshCalc);

$("saveQuote").addEventListener("click", async () => {
  const name = $("cuName").value.trim();
  if (!name) { $("calcStatus").textContent = "Enter the customer's name to save a quote"; $("cuName").focus(); return; }
  $("saveQuote").disabled = true;
  $("calcStatus").textContent = "Saving…";
  try {
    const r = await post("/pricing/quotes", {
      customerName: name, customerPhone: $("cuPhone").value.trim(), customerPlace: $("cuPlace").value.trim(),
      customerState: $("cuState").value, notes: $("cuNotes").value.trim(), lines: apiLines()
    });
    $("calcStatus").textContent = "";
    showMsg("ok", `Quote ${r.quoteNo} saved.`);
    loaded.quotes = false;
    showQuote(r.quote);
  } catch (err) {
    $("calcStatus").textContent = "";
    fail(err);
  } finally {
    $("saveQuote").disabled = !lastCalc?.ok;
  }
});

// An unsaved estimate printed / shared from the calculator.
function draftQuote() {
  const days = current.settings.quoteValidityDays;
  let until = Date.now() + days * DAY;
  if (current.list.effectiveTo) until = Math.min(until, new Date(current.list.effectiveTo).getTime());
  return {
    quoteNo: null, createdAt: new Date().toISOString(), validUntil: new Date(until).toISOString(), status: "open",
    customerName: $("cuName").value.trim(), customerPhone: $("cuPhone").value.trim(), customerPlace: $("cuPlace").value.trim(),
    customerState: $("cuState").value, notes: $("cuNotes").value.trim(), lines: lastCalc.lines, totals: lastCalc.totals
  };
}
$("printEstimate").addEventListener("click", () => printQuote(draftQuote()));
$("waEstimate").addEventListener("click", () => shareWhatsApp(draftQuote()));

// =====================================================================
// QUOTE DOCUMENT (view, print, WhatsApp)
// =====================================================================

function quoteDocHtml(q) {
  const lineRows = q.lines.map((l, i) => `<tr>
    <td>${i + 1}</td>
    <td><b>${esc(l.productName)}</b>${l.variantName && l.variantName !== "Standard" ? ` - ${esc(l.variantName)}` : ""}<br><small>${esc(l.sku)}${l.hsnSac ? ` · HSN/SAC ${esc(l.hsnSac)}` : ""}</small></td>
    <td class="num">${l.qty} ${esc(l.unit || "")}</td>
    <td class="num">${rs(l.listPrice)}</td>
    <td class="num">${l.unitDiscount > 0 ? rs(l.unitDiscount) : "–"}</td>
    <td class="num">${rs(l.unitPrice)}</td>
    <td class="num">${rs(l.taxable)}</td>
    <td class="num">${pct(l.gstBp)}</td>
    <td class="num">${rs(l.total)}</td></tr>`).join("");
  const expired = q.status === "open" && new Date(q.validUntil).getTime() < Date.now();
  return `<div class="pr-doc">
    ${expired ? `<div class="pr-expired-banner">⚠️ This quote has expired - prices may have changed. Make a new quote.</div>` : ""}
    <div class="pr-doc-head">
      <div><img src="/assets/logo.png" alt="Farm Buddie"><h1>${q.quoteNo ? "Quotation" : "Price estimate"}</h1></div>
      <div class="pr-doc-meta">
        ${q.quoteNo ? `<b>${esc(q.quoteNo)}</b><br>` : ""}
        Date: ${fmtDate(q.createdAt)}<br>
        Valid until: <b>${fmtDate(q.validUntil)}</b><br>
        ${q.distributorId ? `Distributor: ${esc(q.distributorId)}<br>` : ""}
      </div>
    </div>
    <div><b>To:</b> ${esc(q.customerName || "–")}${q.customerPhone ? ` · ${esc(q.customerPhone)}` : ""}${q.customerPlace ? ` · ${esc(q.customerPlace)}` : ""}${q.customerState ? `, ${esc(q.customerState)}` : ""}</div>
    <table>
      <thead><tr><th>#</th><th>Product</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Discount / unit</th>
        <th class="num">Net / unit</th><th class="num">Before GST</th><th class="num">GST</th><th class="num">Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="pr-doc-totals pr-sum">${totalsHtml(q.totals, false)}</div>
    ${q.notes ? `<p class="pr-doc-note"><b>Notes:</b> ${esc(q.notes)}</p>` : ""}
    <p class="pr-doc-note">${esc(current?.settings?.disclaimer || R.DISCLAIMER)}<br>Prices before GST unless marked; GST as shown. ${q.totals.interState ? "Inter-state supply - IGST." : "Intra-state supply - CGST + SGST."}</p>
  </div>`;
}

function printQuote(q) {
  const w = window.open("", "_blank");
  if (!w) { showMsg("error", "Allow pop-ups for this site to print"); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(q.quoteNo || "Estimate")} - Farm Buddie</title>
    <link rel="stylesheet" href="/css/pricing.css">
    <style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:24px;color:#111827}
      @media print{body{margin:0}} .pr-sum .row.internal{display:none}</style></head>
    <body>${quoteDocHtml(q)}<script>window.onload=()=>{window.print();}<\/script></body></html>`);
  w.document.close();
}

function shareWhatsApp(q) {
  const t = q.totals;
  const items = q.lines.map((l) => `• ${l.productName}${l.variantName && l.variantName !== "Standard" ? ` (${l.variantName})` : ""} × ${l.qty} = ${rs(l.taxable)}`).join("\n");
  const msg = `*Farm Buddie ${q.quoteNo ? `Quotation ${q.quoteNo}` : "price estimate"}*\n` +
    `${q.customerName ? `For: ${q.customerName}\n` : ""}\n${items}\n\n` +
    `Total before GST: ${rs(t.taxable)}${t.discount ? ` (discount ${rs(t.discount)})` : ""}\nGST: ${rs(t.gst)}\n` +
    `*Estimated total: ${rs(t.payable)}*\nValid until ${fmtDate(q.validUntil)}\n\n_${current?.settings?.disclaimer || R.DISCLAIMER}_`;
  const digits = String(q.customerPhone || "").replace(/\D/g, "");
  const to = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith("91") ? digits : "";
  window.open(`https://wa.me/${to}?text=${encodeURIComponent(msg)}`, "_blank");
}

function showQuote(q) {
  const expired = q.status === "open" && new Date(q.validUntil).getTime() < Date.now();
  $("qmBody").innerHTML = quoteDocHtml(q) +
    (q.profit ? `<p class="pr-hint">🔒 Our cost ${rs(q.profit.ourCost)} · our revenue ${rs(q.profit.ourRevenue)} · <b>our profit ${rs(q.profit.ourProfit)}</b>
      (${q.profit.viaDistributor ? "sold to the distributor at distributor price" : "direct sale"})</p>` : "") +
    `<p class="pr-hint">🔒 Internal: distributor margin ${rs(q.totals.margin)} · distributor buys at ${rs(q.totals.distributorCost)} · status
      <span class="pr-pill ${expired ? "expired" : q.status}">${expired ? "expired" : q.status}</span>${q.statusBy ? ` by ${esc(q.statusBy)}` : ""}</p>`;
  const a = $("qmActions");
  a.innerHTML = `<button class="pr-btn" data-a="print">🖨️ Print / PDF</button><button class="pr-btn" data-a="wa">🟢 WhatsApp</button>
    <button class="pr-btn" data-a="copy">📋 Copy to calculator</button>
    ${q.id && q.status === "open" && !expired ? `<button class="pr-btn go" data-a="accept">✔ Mark accepted</button>` : ""}
    ${q.id && q.status === "open" ? `<button class="pr-btn danger" data-a="cancel">Cancel quote</button>` : ""}`;
  a.querySelector('[data-a="print"]').onclick = () => printQuote(q);
  a.querySelector('[data-a="wa"]').onclick = () => shareWhatsApp(q);
  a.querySelector('[data-a="copy"]').onclick = () => {
    // Same products and discounts, at today's prices.
    lines = q.lines.filter((l) => prices.has(l.variantId)).map((l) => ({
      variantId: l.variantId, qty: l.qty,
      mode: l.priceOverride !== null && l.priceOverride !== undefined ? "price" : (l.discountType || "pct"),
      value: l.priceOverride != null ? paiseInput(l.priceOverride) : !l.discountValue ? "" : l.discountType === "amt" ? paiseInput(l.discountValue) : String(l.discountValue / 100)
    }));
    $("cuName").value = q.customerName || "";
    $("cuPhone").value = q.customerPhone || "";
    $("cuPlace").value = q.customerPlace || "";
    if (q.customerState) $("cuState").value = q.customerState;
    $("cuNotes").value = q.notes || "";
    const dropped = q.lines.length - lines.length;
    closeModal("quoteModal");
    openTab("calc");
    renderLines();
    if (dropped) showMsg("error", `${dropped} product(s) aren't in the current price list and were left out.`);
  };
  for (const s of ["accept", "cancel"]) {
    const b = a.querySelector(`[data-a="${s}"]`);
    if (!b) continue;
    b.onclick = async () => {
      if (s === "cancel" && !confirm(`Cancel quote ${q.quoteNo}?`)) return;
      try {
        await post(`/pricing/quotes/${q.id}/status`, { status: s === "accept" ? "accepted" : "cancelled" });
        const { quote } = await api(`/pricing/quotes/${q.id}`);
        showQuote(quote);
        loadQuotes(quotePage);
      } catch (err) { alert(err.message); }
    };
  }
  openModal("quoteModal");
}

// ---------- modals ----------
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".pr-modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".pr-modal").forEach((m) => { m.hidden = true; }); });

// =====================================================================
// QUOTES
// =====================================================================

let quotePage = 1;
async function loadQuotes(page) {
  quotePage = page;
  const search = $("quoteSearch").value.trim();
  try {
    const r = await api(`/pricing/quotes?page=${page}${search ? `&search=${encodeURIComponent(search)}` : ""}`);
    $("quoteBody").innerHTML = r.quotes.length ? r.quotes.map((q) => {
      const st = q.expired ? "expired" : q.status;
      return `<tr class="pr-click" data-id="${q.id}">
        <td><b>${esc(q.quoteNo)}</b></td><td>${fmtDate(q.createdAt)}</td>
        <td>${esc(q.customerName || "–")}<br><small class="ota-muted">${esc(q.customerPhone || "")} ${esc(q.customerPlace || "")}</small></td>
        <td>${esc(q.distributorId || q.createdBy)}</td><td class="num">${rs(q.totals.payable)}</td>
        <td class="num pr-cost-col">${q.profit ? rs(q.profit.ourProfit) : "–"}</td>
        <td>${fmtDate(q.validUntil)}</td><td><span class="pr-pill ${st}">${st}</span></td><td><button class="pr-link">View</button></td></tr>`;
    }).join("") : `<tr><td colspan="9" class="ota-muted">No quotes${search ? " match" : " yet"}.</td></tr>`;
    showCostCols();
    $("quoteBody").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", async () => {
      try { showQuote((await api(`/pricing/quotes/${tr.dataset.id}`)).quote); } catch (err) { fail(err); }
    }));
    pager($("quotePager"), page, r.total, loadQuotes);
  } catch (err) { fail(err); }
}
$("quoteSearch").addEventListener("input", debounce(() => loadQuotes(1), 350));

// =====================================================================
// PRICE LISTS
// =====================================================================

const listStatus = (l) => (l.status === "published" ? l.liveStatus : l.status);
const STATUS_LABEL = { draft: "Draft", submitted: "Waiting approval", approved: "Approved", scheduled: "Scheduled", active: "Active",
  expired: "Expired", cancelled: "Cancelled" };

function renderLists() {
  $("listsBody").innerHTML = lists.length ? lists.map((l) => {
    const st = listStatus(l);
    return `<tr class="pr-click ${editing?.list.id === l.id ? "pr-selected" : ""}" data-id="${l.id}">
      <td>${l.id}</td><td><b>${esc(l.name)}</b>${l.notes ? `<br><small class="ota-muted">${esc(l.notes)}</small>` : ""}</td>
      <td><span class="pr-pill ${st}">${STATUS_LABEL[st] || st}</span>${l.expiresSoon ? " ⚠️" : ""}</td>
      <td>${l.effectiveFrom ? fmtDate(l.effectiveFrom) : "–"}</td><td>${l.effectiveFrom ? fmtUntil(l.effectiveTo) : "–"}</td>
      <td class="num">${l.itemCount}</td><td>${esc(l.createdBy || "")}<br><small class="ota-muted">${fmtDate(l.createdAt)}</small></td>
      <td>${l.approvedBy ? `${esc(l.approvedBy)}<br><small class="ota-muted">${fmtDate(l.approvedAt)}</small>` : "–"}</td>
      <td><button class="pr-link">Open</button></td></tr>`;
  }).join("") : `<tr><td colspan="9" class="ota-muted">No price lists yet - click <b>+ New version</b> to make the first one.</td></tr>`;
  $("listsBody").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openList(Number(tr.dataset.id))));
}

$("newListBtn").addEventListener("click", async () => {
  const base = current.list;
  const name = prompt(base ? `Name for the new version (copies "${base.name}"):` : "Name for the first price list:", `Prices ${new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`);
  if (!name) return;
  try {
    const { id } = await post("/pricing/admin/lists", { name });
    await loadLists();
    renderStatus();
    openList(id);
  } catch (err) { fail(err); }
});

let editing = null;   // { list, rows, dirty: Map variantId -> row, compareWith }
const isDraft = () => editing?.list.status === "draft" && can("editor");

window.addEventListener("beforeunload", (e) => { if (editing?.dirty.size || editing?.detailsDirty) { e.preventDefault(); e.returnValue = ""; } });

async function openList(id) {
  if ((editing?.dirty.size || editing?.detailsDirty) && editing.list.id !== id && !confirm("You have unsaved price changes. Discard them?")) return;
  try {
    const r = await api(`/pricing/admin/lists/${id}`);
    editing = { list: r.list, rows: r.items, dirty: new Map(), compareWith: r.compareWith, detailsDirty: false };
    renderLists();
    renderEditor();
    $("editor").hidden = false;
    $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) { fail(err); }
}

function renderEditor() {
  const l = editing.list;
  const st = listStatus(l);
  const draft = isDraft();
  $("edTitle").innerHTML = `#${l.id} ${esc(l.name)} <span class="pr-pill ${st}">${STATUS_LABEL[st] || st}</span>
    ${editing.compareWith ? `<small class="ota-muted">compared with "${esc(editing.compareWith.name)}" (in force now)</small>` : ""}`;
  $("edName").value = l.name;
  $("edFrom").value = isoFromInput(l.effectiveFrom);
  $("edTo").value = isoToInput(l.effectiveTo);
  $("edNotes").value = l.notes || "";
  for (const id of ["edName", "edFrom", "edTo", "edNotes"]) $(id).disabled = !draft;
  $("edReject").hidden = !(l.status === "draft" && l.rejectReason);
  $("edReject").className = "ota-alert warn";
  $("edReject").textContent = l.rejectReason ? `Sent back to draft: ${l.rejectReason}` : "";
  $("edProblems").hidden = true;
  document.querySelectorAll(".pr-draft-only").forEach((el) => { el.hidden = !draft; });
  $("edCat").innerHTML = `<option value="">All</option>` + Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  renderEditorActions();
  renderItems();
}

function renderEditorActions() {
  const l = editing.list;
  const st = listStatus(l);
  const b = [];
  if (l.status === "draft" && can("editor")) {
    b.push(`<button class="pr-btn go" data-a="save">💾 Save changes</button>`);
    b.push(`<button class="pr-btn" data-a="submit">📨 Submit for approval</button>`);
    b.push(`<button class="pr-btn danger" data-a="delete">Delete draft</button>`);
  }
  if (l.status === "submitted" && can("approver")) {
    b.push(`<button class="pr-btn go" data-a="approve">✔ Approve</button>`);
    b.push(`<button class="pr-btn danger" data-a="reject">↩ Send back to draft</button>`);
  }
  if (l.status === "approved" && can("approver")) {
    b.push(`<button class="pr-btn go" data-a="publish">🚀 Publish</button>`);
    b.push(`<button class="pr-btn danger" data-a="reject">↩ Send back to draft</button>`);
  }
  if (l.status === "published" && (st === "active" || st === "scheduled") && can("approver")) {
    b.push(`<button class="pr-btn danger" data-a="end">${st === "scheduled" ? "Cancel this scheduled list" : "⛔ End these prices now"}</button>`);
  }
  if (can("editor")) b.push(`<button class="pr-btn" data-a="copy">📄 New version from this list</button>`);
  if (l.status !== "draft" && can("owner")) b.push(`<button class="pr-btn danger" data-a="delete">🗑 Delete this version</button>`);
  if (l.status === "submitted" && !can("approver")) b.push(`<span class="ota-muted">Waiting for an approver.</span>`);
  $("edActions").innerHTML = b.join("");
  $("edActions").querySelectorAll("[data-a]").forEach((btn) => btn.addEventListener("click", () => listAction(btn.dataset.a, btn)));
}

function readDetails() {
  return {
    name: $("edName").value.trim(),
    notes: $("edNotes").value.trim(),
    effectiveFrom: fromInputIso($("edFrom").value),
    effectiveTo: toInputIso($("edTo").value)
  };
}
for (const id of ["edName", "edFrom", "edTo", "edNotes"]) $(id).addEventListener("input", () => { if (editing) editing.detailsDirty = true; });

async function saveDraft() {
  const id = editing.list.id;
  if (editing.detailsDirty) {
    await put(`/pricing/admin/lists/${id}`, readDetails());
    editing.detailsDirty = false;
  }
  if (editing.dirty.size) {
    const bad = [...editing.dirty.values()].filter((r) => [r.mrp, r.distributorPrice, r.basePrice, r.minPrice, r.maxPrice, r.costPrice, r.maxDiscountValue].some((v) => Number.isNaN(v)));
    if (bad.length) throw new Error(`${bad.length} row(s) have an amount that isn't a number - fix the red boxes first`);
    const items = [...editing.dirty.values()].map((r) => ({
      variantId: r.variantId, active: r.active, mrp: r.mrp, distributorPrice: r.distributorPrice, basePrice: r.basePrice,
      ...(can("editor") ? { costPrice: r.costPrice ?? null } : {}),
      minPrice: r.minPrice, maxPrice: r.maxPrice, maxDiscountType: r.maxDiscountType, maxDiscountValue: r.maxDiscountValue ?? 0, gstBp: r.gstBp
    }));
    await put(`/pricing/admin/lists/${id}/items`, { items });
    editing.dirty.clear();
  }
}

async function listAction(a, btn) {
  const l = editing.list;
  btn.disabled = true;
  try {
    if (a === "save") {
      await saveDraft();
      showMsg("ok", "Saved.");
    } else if (a === "submit") {
      await saveDraft();
      await post(`/pricing/admin/lists/${l.id}/submit`);
      showMsg("ok", `"${l.name}" sent for approval.`);
    } else if (a === "delete") {
      const live = listStatus(l);
      const warn = l.status === "draft" ? "" : live === "active"
        ? "\n\n⚠️ These are the prices IN FORCE now. After deleting, no new quotes can be made until another list is published."
        : "\n\nIts price history is lost. Saved quotes keep their own prices.";
      if (!confirm(`Delete "${l.name}" permanently?${warn}`)) return;
      const r = await api(`/pricing/admin/lists/${l.id}`, { method: "DELETE" });
      editing = null;
      $("editor").hidden = true;
      showMsg("ok", `"${l.name}" deleted.${r.quotes ? ` ${r.quotes} saved quote(s) keep their prices.` : ""}`);
      await Promise.all([loadLists(), loadCurrent()]);
      renderStatus();
      renderCalcSetup();
      return;
    } else if (a === "approve") {
      await post(`/pricing/admin/lists/${l.id}/approve`);
      showMsg("ok", `"${l.name}" approved - publish it to put the prices in force.`);
    } else if (a === "reject") {
      const reason = prompt("Why is it going back to draft? (optional)", "");
      if (reason === null) return;
      await post(`/pricing/admin/lists/${l.id}/reject`, { reason });
      showMsg("ok", `"${l.name}" is a draft again.`);
    } else if (a === "publish") {
      const from = new Date(l.effectiveFrom).getTime();
      const when = from <= Date.now() ? "right now" : `on ${fmtDateTime(l.effectiveFrom)}`;
      if (!confirm(`Publish "${l.name}"?\n\nThese prices take effect ${when}${current.list && current.list.id !== l.id ? `, replacing "${current.list.name}" from then` : ""}.\nDistributors see them in the Irrigo Admin app.`)) return;
      const r = await post(`/pricing/admin/lists/${l.id}/publish`);
      showMsg("ok", `"${l.name}" published${r.endedListId ? ` - list #${r.endedListId} ends when it starts` : ""}.`);
    } else if (a === "end") {
      const sched = listStatus(l) === "scheduled";
      if (!confirm(sched ? `Cancel the scheduled list "${l.name}"?` : `End "${l.name}" now?\n\nWith no list in force, NO new quotes can be made until another list is published.`)) return;
      await post(`/pricing/admin/lists/${l.id}/end`);
      showMsg("ok", sched ? "Scheduled list cancelled." : "Prices ended.");
    } else if (a === "copy") {
      const name = prompt(`Name for the new version (copies "${l.name}"):`, `${l.name} (copy)`);
      if (!name) return;
      const { id } = await post("/pricing/admin/lists", { name, basedOnId: l.id });
      await Promise.all([loadLists(), loadCurrent()]);
      renderStatus();
      await openList(id);
      return;
    }
    await Promise.all([loadLists(), loadCurrent()]);
    renderStatus();
    renderCalcSetup();
    await openList(l.id);
  } catch (err) {
    fail(err);
    if (err.data?.problems) {
      $("edProblems").hidden = false;
      $("edProblems").innerHTML = `<b>${esc(err.message)}</b><ul>${err.data.problems.slice(0, 30).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
    }
  } finally {
    btn.disabled = false;
  }
}

// Rows that pass the search/category/show filters.
function shownRows() {
  const q = $("edSearch").value.trim().toLowerCase();
  const cat = $("edCat").value;
  const show = $("edShow").value;
  return editing.rows.filter((r) => (!q || `${r.productName} ${r.variantName} ${r.sku}`.toLowerCase().includes(q))
    && (!cat || r.category === cat)
    && (show !== "problems" || (r.active && R.priceProblems(r).length))
    && (show !== "changed" || changedVsCurrent(r)));
}
const MONEY = ["mrp", "distributorPrice", "basePrice", "minPrice", "maxPrice", "costPrice"];
const changedVsCurrent = (r) => !r.current || MONEY.some((k) => r[k] !== r.current[k]) || r.active !== r.current.active;

function renderItems() {
  const draft = isDraft();
  const rows = shownRows();
  const gstOpts = (sel) => R.GST_RATES_BP.map((g) => `<option value="${g}" ${g === sel ? "selected" : ""}>${pct(g)}</option>`).join("");
  $("itemsBody").innerHTML = rows.length ? rows.map((r) => {
    const was = (k) => {
      if (!r.current || r.current[k] === r[k]) return "";
      const c = r.current[k];
      const dir = c === null || r[k] === null ? "" : r[k] > c ? "up" : "down";
      return `<span class="pr-was ${dir}">now ${rs(c)}</span>`;
    };
    const money = (k) => (draft
      ? `<input class="pr-money" data-k="${k}" value="${esc(paiseInput(r[k]))}" inputmode="decimal" ${k === "mrp" && r.kind === "service" ? 'placeholder="n/a"' : ""}>${was(k)}`
      : `${rs(r[k])}${was(k)}`);
    const disc = `<span data-c="disc"></span>`;
    return `<tr data-v="${r.variantId}" class="${r.active ? "" : "off"}">
      <td><input type="checkbox" data-k="active" ${r.active ? "checked" : ""} ${draft ? "" : "disabled"}></td>
      <td class="pr-prod"><b>${esc(r.productName)}</b><small>${r.variantName !== "Standard" ? `${esc(r.variantName)} · ` : ""}${esc(r.sku)}${r.catalogueActive ? "" : " · ⚠️ inactive in catalogue"}</small></td>
      <td class="num pr-cost-col">${money("costPrice")}</td>
      <td class="num">${money("mrp")}</td><td class="num">${money("distributorPrice")}</td><td class="num">${money("basePrice")}</td>
      <td class="num">${money("minPrice")}</td><td class="num">${money("maxPrice")}</td>
      <td class="num">${disc}</td>
      <td>${draft ? `<select data-k="gstBp">${gstOpts(r.gstBp)}</select>` : pct(r.gstBp)}</td>
      <td class="num" data-c="floor"></td><td class="num" data-c="margin"></td><td class="num pr-cost-col" data-c="profit"></td><td class="pr-checkcell" data-c="check"></td></tr>`;
  }).join("") : `<tr><td colspan="14" class="ota-muted">No rows match.</td></tr>`;
  showCostCols();
  $("itemsBody").querySelectorAll("tr[data-v]").forEach((tr) => {
    refreshRow(tr);
    tr.querySelectorAll("[data-k]").forEach((el) => el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", () => onCell(tr, el)));
  });
}

// Our cost / profit - editors, approvers and admins only (the server leaves it out for anyone else).
function showCostCols() { document.querySelectorAll(".pr-cost-col").forEach((el) => { el.hidden = !can("editor"); }); }
const profitHtml = (p) => {
  if (!p) return `<span class="ota-muted" title="Enter our cost to see our profit">–</span>`;
  const c = (v) => `<span style="color:${v < 0 ? "#b91c1c" : "#15803d"}">${rs(v)}</span>`;
  return `${c(p.direct)}<span class="pr-hint">via dist. ${c(p.viaDistributor)}</span>`;
};

function rowOf(tr) { return editing.rows.find((r) => r.variantId === Number(tr.dataset.v)); }

function onCell(tr, el) {
  const r = rowOf(tr);
  const k = el.dataset.k;
  if (k === "active") { r.active = el.checked; tr.classList.toggle("off", !r.active); }
  else if (k === "gstBp") r.gstBp = Number(el.value);
  else if (k === "maxDiscountType") {
    // Switching % <-> ₹ keeps the box's number but re-reads it in the new unit.
    r.maxDiscountType = el.value;
    const box = tr.querySelector('[data-k="maxDiscountValue"]');
    r.maxDiscountValue = readDiscount(r, box.value);
  } else if (k === "maxDiscountValue") r.maxDiscountValue = readDiscount(r, el.value);
  else {
    r[k] = toPaise(el.value);
    el.classList.toggle("bad", Number.isNaN(r[k]));
    el.classList.toggle("changed", !!r.current && r.current[k] !== r[k]);
  }
  autoFill(tr, r, k);
  syncDiscount(r);
  editing.dirty.set(r.variantId, r);
  refreshRow(tr);
}
// Fills an EMPTY box from the others, so a simple "no discount" row needs
// only MRP, distributor price and selling price:
//   maximum price = MRP without GST (rounded down to the rupee)
//   minimum price = selling price (no discount allowed)
// A box the user typed in is never overwritten.
function autoFill(tr, r, k) {
  const box = (key) => tr.querySelector(`[data-k="${key}"]`);
  if ((k === "mrp" || k === "gstBp") && Number.isInteger(r.mrp) && r.mrp > 0 && (r.maxPrice === null || box("maxPrice")?.dataset.auto)) {
    r.maxPrice = Math.floor(r.mrp * 10000 / (10000 + r.gstBp) / 100) * 100;
    if (box("maxPrice")) { box("maxPrice").value = paiseInput(r.maxPrice); box("maxPrice").dataset.auto = "1"; }
  }
  if (k === "basePrice" && Number.isInteger(r.basePrice) && (r.minPrice === null || box("minPrice")?.dataset.auto)) {
    r.minPrice = r.basePrice;
    if (box("minPrice")) { box("minPrice").value = paiseInput(r.minPrice); box("minPrice").dataset.auto = "1"; }
  }
  // Typing in a box yourself makes it yours.
  if ((k === "maxPrice" || k === "minPrice") && box(k)) delete box(k).dataset.auto;
}

// Max discount = farmer selling price - minimum price, always (the server
// works it out the same way when saving).
function syncDiscount(r) {
  if (Number.isInteger(r.basePrice) && Number.isInteger(r.minPrice)) {
    r.maxDiscountType = "amt";
    r.maxDiscountValue = Math.max(0, r.basePrice - r.minPrice);
  }
}
function discountHtml(r) {
  if (!Number.isInteger(r.basePrice) || !Number.isInteger(r.minPrice)) return "–";
  const d = R.maxDiscountPaise(r);
  if (d <= 0) return `<span class="ota-muted">No discount</span>`;
  return `${rs(d)}<span class="pr-hint">${Math.round(d * 1000 / r.basePrice) / 10}%</span>`;
}

function readDiscount(r, s) {
  const t = String(s ?? "").trim();
  if (t === "") return 0;
  if (r.maxDiscountType === "pct") return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
  return toPaise(t);
}

function refreshRow(tr) {
  const r = rowOf(tr);
  const cell = (c) => tr.querySelector(`[data-c="${c}"]`);
  if (!r.active) { cell("floor").textContent = "–"; cell("margin").textContent = "–"; cell("check").innerHTML = `<span class="ota-muted">Not on sale</span>`; return; }
  const dc = tr.querySelector('[data-c="disc"]');
  if (dc) dc.innerHTML = discountHtml(r);
  const pc = tr.querySelector('[data-c="profit"]');
  if (pc) pc.innerHTML = r.active ? profitHtml(R.ourProfit(r)) : "–";
  if ([r.mrp, r.distributorPrice, r.basePrice, r.minPrice, r.maxPrice].every((v) => v === null)) {
    tr.classList.add("has-err");
    cell("floor").textContent = "–"; cell("margin").textContent = "–";
    cell("check").innerHTML = `<span class="e">Enter the prices, or untick “On” if you don't sell it yet</span>`;
    return;
  }
  const errs = R.priceProblems(r).slice(0, 1);   // one at a time - fix it and the next shows
  const warns = R.priceWarnings(r);
  tr.classList.toggle("has-err", errs.length > 0);
  cell("floor").textContent = errs.length ? "–" : rs(R.floorPrice(r));
  const m = Number.isInteger(r.basePrice) && Number.isInteger(r.distributorPrice) ? r.basePrice - r.distributorPrice : null;
  cell("margin").innerHTML = m === null ? "–" : `${rs(m)}${r.basePrice ? `<span class="pr-hint">${Math.round(m * 1000 / r.basePrice) / 10}%</span>` : ""}`;
  cell("check").innerHTML = errs.length ? errs.map((e) => `<span class="e">✘ ${esc(e)}</span>`).join("")
    : warns.length ? warns.map((w) => `<span class="w">⚠ ${esc(w)}</span>`).join("") : `<span class="ok">✔ OK</span>`;
}

$("edSearch").addEventListener("input", debounce(renderItems, 200));
$("edCat").addEventListener("change", renderItems);
$("edShow").addEventListener("change", renderItems);

$("bkApply").addEventListener("click", () => {
  const k = $("bkField").value;
  const p = Number($("bkPct").value);
  if (!p || !Number.isFinite(p)) { alert("Enter a % like 5 or -3"); return; }
  const step = Number($("bkRound").value);
  const rows = shownRows().filter((r) => r.active && Number.isInteger(r[k]));
  if (!rows.length) { alert("No rows with that price to change"); return; }
  if (!confirm(`Change ${rows.length} row(s): ${$("bkField").selectedOptions[0].text} ${p > 0 ? "+" : ""}${p}%?`)) return;
  for (const r of rows) {
    let v = Math.round(r[k] * (100 + p) / 100);
    if (step) v = Math.round(v / step) * step;
    r[k] = Math.max(0, v);
    syncDiscount(r);
    editing.dirty.set(r.variantId, r);
  }
  renderItems();
  showMsg("ok", `${rows.length} row(s) changed - check the ✘ marks, then Save changes.`);
});

// ---- CSV ----
const CSV_COLS = ["sku", "product", "variant", "on_sale", "mrp", "distributor_price", "selling_price", "min_price", "max_price",
  "max_discount_type", "max_discount", "gst_percent"];
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

$("csvExport").addEventListener("click", () => {
  const rows = editing.rows.map((r) => [r.sku, r.productName, r.variantName, r.active ? "yes" : "no", paiseInput(r.mrp), paiseInput(r.distributorPrice),
    paiseInput(r.basePrice), paiseInput(r.minPrice), paiseInput(r.maxPrice), r.maxDiscountType === "amt" ? "rupees" : "percent",
    r.maxDiscountType === "amt" ? paiseInput(r.maxDiscountValue) : String((r.maxDiscountValue ?? 0) / 100), String(r.gstBp / 100)]);
  // Our cost only for those who may see it.
  const withCost = can("editor");
  const head = withCost ? [...CSV_COLS, "our_cost"] : CSV_COLS;
  if (withCost) editing.rows.forEach((r, i) => rows[i].push(paiseInput(r.costPrice)));
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `price-list-${editing.list.id}-${editing.list.name.replace(/[^\w-]+/g, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

$("csvImport").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const rows = parseCsv(await file.text());
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  if (col("sku") < 0) { showMsg("error", `The CSV needs a header row with: ${CSV_COLS.join(", ")}`); return; }
  const bySku = new Map(editing.rows.map((r) => [r.sku, r]));
  let n = 0;
  const unknown = [], bad = [];
  for (const cells of rows) {
    const get = (name) => (col(name) >= 0 ? (cells[col(name)] ?? "").trim() : undefined);
    const r = bySku.get((get("sku") || "").toUpperCase());
    if (!r) { unknown.push(get("sku")); continue; }
    const upd = { ...r };
    const money = { mrp: "mrp", distributor_price: "distributorPrice", selling_price: "basePrice", min_price: "minPrice", max_price: "maxPrice",
      ...(can("editor") ? { our_cost: "costPrice" } : {}) };
    for (const [c, k] of Object.entries(money)) if (get(c) !== undefined) upd[k] = toPaise(get(c));
    if (get("on_sale") !== undefined) upd.active = !/^(no|n|0|false)$/i.test(get("on_sale"));
    if (get("max_discount_type") !== undefined) upd.maxDiscountType = /^(rupees|amt|₹|inr)$/i.test(get("max_discount_type")) ? "amt" : "pct";
    if (get("max_discount") !== undefined) upd.maxDiscountValue = readDiscount(upd, get("max_discount"));
    if (get("gst_percent") !== undefined) upd.gstBp = Math.round(Number(get("gst_percent")) * 100);
    if ([...MONEY, "maxDiscountValue"].some((k) => Number.isNaN(upd[k])) || !R.GST_RATES_BP.includes(upd.gstBp)) { bad.push(r.sku); continue; }
    Object.assign(r, upd);
    syncDiscount(r);
    editing.dirty.set(r.variantId, r);
    n++;
  }
  renderItems();
  showMsg(bad.length || unknown.length ? "error" : "ok",
    `${n} row(s) updated from the CSV - check them, then Save changes.` +
    (unknown.length ? ` Unknown SKU(s): ${unknown.slice(0, 10).join(", ")}.` : "") +
    (bad.length ? ` Skipped (bad number or GST): ${bad.slice(0, 10).join(", ")}.` : ""));
});

// =====================================================================
// PRODUCTS
// =====================================================================

function renderProducts() {
  if (!catalog) return;
  const sel = (el, opts) => { if (el.options.length <= 1) el.insertAdjacentHTML("beforeend", opts); };
  sel($("prodCat"), Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join(""));
  const q = $("prodSearch").value.trim().toLowerCase();
  const cat = $("prodCat").value;
  const act = $("prodActive").value;
  const variantsOf = (pid) => catalog.variants.filter((v) => v.productId === pid);
  const vById = new Map(catalog.variants.map((v) => [v.id, v]));
  const pById = new Map(catalog.products.map((p) => [p.id, p]));
  const rows = catalog.products.filter((p) => (!q || `${p.name} ${p.sku} ${variantsOf(p.id).map((v) => v.sku).join(" ")}`.toLowerCase().includes(q))
    && (!cat || p.category === cat) && (!act || String(Number(p.active)) === act));
  $("prodBody").innerHTML = rows.length ? rows.map((p) => {
    const acc = catalog.accessories.filter((a) => a.productId === p.id).map((a) => {
      const v = vById.get(a.accessoryVariantId);
      return `<span class="pr-chip">${a.mode === "required" ? "✔ " : "+ "}${esc(v ? pById.get(v.productId)?.name : "?")}</span>`;
    }).join("");
    return `<tr class="pr-click" data-id="${p.id}">
      <td><b>${esc(p.sku)}</b></td><td>${esc(p.name)}${p.description ? `<br><small class="ota-muted">${esc(p.description)}</small>` : ""}</td>
      <td>${CAT_LABEL[p.category] || esc(p.category)}${p.role ? `<br><small class="ota-muted">${esc(ROLE_LABEL[p.role] || p.role)}</small>` : ""}</td>
      <td>${variantsOf(p.id).map((v) => `<span class="pr-chip ${v.active ? "" : "off"}">${esc(v.name)}</span>`).join("")}</td>
      <td>${acc || "–"}</td><td>${esc(p.hsnSac || "–")}</td><td>${pct(p.gstBp)}</td>
      <td><span class="pr-pill ${p.active ? "active" : "expired"}">${p.active ? "Active" : "Inactive"}</span></td>
      <td><button class="pr-link">${can("editor") ? "Edit" : "View"}</button></td></tr>`;
  }).join("") : `<tr><td colspan="9" class="ota-muted">No products match.</td></tr>`;
  $("prodBody").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openProduct(Number(tr.dataset.id))));
}
$("prodSearch").addEventListener("input", debounce(renderProducts, 200));
$("prodCat").addEventListener("change", renderProducts);
$("prodActive").addEventListener("change", renderProducts);
$("newProductBtn").addEventListener("click", () => openProduct(null));

let pmProduct = null;
let pmAccessories = [];

function openProduct(id) {
  pmProduct = id ? catalog.products.find((p) => p.id === id) : null;
  const p = pmProduct || { sku: "", name: "", category: "accessory", role: "", kind: "goods", unit: "pcs", hsnSac: "", gstBp: R.DEFAULT_GST_BP, description: "", active: true, sortOrder: (catalog.products.length + 1) * 10 };
  $("pmTitle").textContent = pmProduct ? `${p.name}` : "New product";
  $("pmCategory").innerHTML = Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("pmRole").innerHTML = `<option value="">- none -</option>` + R.ROLES.map((r) => `<option value="${r}">${ROLE_LABEL[r] || r}</option>`).join("");
  $("pmGst").innerHTML = R.GST_RATES_BP.map((g) => `<option value="${g}">${pct(g)}</option>`).join("");
  $("pmSku").value = p.sku; $("pmName").value = p.name; $("pmCategory").value = p.category; $("pmRole").value = p.role || "";
  $("pmKind").value = p.kind; $("pmUnit").value = p.unit; $("pmHsn").value = p.hsnSac || ""; $("pmGst").value = String(p.gstBp);
  $("pmOrder").value = p.sortOrder; $("pmDesc").value = p.description || ""; $("pmActive").checked = p.active;
  const ro = !can("editor");
  $("prodModal").querySelectorAll("input, select").forEach((el) => { el.disabled = ro; });
  $("pmStatus").textContent = pmProduct ? "" : "Save the product first, then add variants and accessories.";
  $("pmMore").hidden = !pmProduct;
  $("pmDelete").hidden = !pmProduct || !can("owner");
  if (pmProduct) {
    pmAccessories = catalog.accessories.filter((a) => a.productId === pmProduct.id).map((a) => ({ ...a }));
    renderVariants();
    renderAccessories();
  }
  openModal("prodModal");
}

$("pmDelete").addEventListener("click", async () => {
  if (!confirm(`Delete "${pmProduct.name}" and all its variants permanently?\n\nIt is removed from every price list too (saved quotes keep it).\nTo stop selling it for now, untick "Active" instead.`)) return;
  try {
    const r = await api(`/pricing/admin/products/${pmProduct.id}`, { method: "DELETE" });
    closeModal("prodModal");
    showMsg("ok", `"${pmProduct.name}" deleted${r.lists ? ` - removed from ${r.lists} price list(s)` : ""}.`);
    await Promise.all([loadCatalog(), loadLists(), loadCurrent()]);
    renderStatus();
    renderCalcSetup();
  } catch (err) { $("pmStatus").textContent = `✘ ${err.message}`; }
});

$("pmSave").addEventListener("click", async () => {
  const body = {
    sku: $("pmSku").value.trim().toUpperCase(), name: $("pmName").value.trim(), category: $("pmCategory").value, role: $("pmRole").value || null,
    kind: $("pmKind").value, unit: $("pmUnit").value.trim() || "pcs", hsnSac: $("pmHsn").value.trim(), gstBp: Number($("pmGst").value),
    description: $("pmDesc").value.trim(), active: $("pmActive").checked, sortOrder: Number($("pmOrder").value) || 0
  };
  $("pmStatus").textContent = "Saving…";
  try {
    let id = pmProduct?.id;
    if (id) await put(`/pricing/admin/products/${id}`, body);
    else id = (await post("/pricing/admin/products", body)).id;
    await loadCatalog();
    openProduct(id);
    $("pmStatus").textContent = "✔ Saved";
  } catch (err) { $("pmStatus").textContent = `✘ ${err.message}`; }
});

function renderVariants() {
  const vs = catalog.variants.filter((v) => v.productId === pmProduct.id);
  const ro = !can("editor") ? "disabled" : "";
  const typeOpts = (sel) => `<option value="">–</option>` + Object.entries(catalog.valveTypes).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  const row = (v) => `<tr data-id="${v.id || ""}">
    <td><input type="text" class="pr-cell" data-f="sku" value="${esc(v.sku)}" ${ro}></td>
    <td><input type="text" class="pr-cell" data-f="name" value="${esc(v.name)}" ${ro}></td>
    <td><input type="number" class="pr-cell" data-f="channels" min="1" max="64" value="${esc(v.attributes?.channels ?? "")}" ${ro}></td>
    <td><select class="pr-cell" data-f="valveType" ${ro}>${typeOpts(v.attributes?.valveType)}</select></td>
    <td><input type="text" class="pr-cell" data-f="size" value="${esc(v.attributes?.size ?? v.attributes?.length ?? "")}" placeholder="2 inch / 5 m" ${ro}></td>
    <td><input type="checkbox" data-f="active" ${v.active !== false ? "checked" : ""} ${ro}></td>
    <td>${ro ? "" : `<button class="pr-link" data-save>Save</button>`}${can("owner") && v.id && vs.length > 1 ? `<button class="pr-link danger" data-delv="${v.id}">Delete</button>` : ""}<span class="pr-hint" data-st></span></td></tr>`;
  $("pmVariants").innerHTML = vs.map(row).join("");
  wireVariantRows();
}
function wireVariantRows() {
  $("pmVariants").querySelectorAll("[data-delv]").forEach((b) => b.onclick = async () => {
    const tr = b.closest("tr");
    if (!confirm(`Delete the variant "${tr.querySelector('[data-f="name"]').value}" permanently? It is removed from every price list too.`)) return;
    try {
      await api(`/pricing/admin/variants/${b.dataset.delv}`, { method: "DELETE" });
      await loadCatalog();
      renderVariants();
    } catch (err) { tr.querySelector("[data-st]").textContent = `✘ ${err.message}`; }
  });
  $("pmVariants").querySelectorAll("[data-save]").forEach((b) => b.onclick = async () => {
    const tr = b.closest("tr");
    const f = (k) => tr.querySelector(`[data-f="${k}"]`);
    const body = {
      sku: f("sku").value.trim().toUpperCase(), name: f("name").value.trim(), active: f("active").checked,
      attributes: { channels: f("channels").value || null, valveType: f("valveType").value || null, size: f("size").value.trim() || null }
    };
    const st = tr.querySelector("[data-st]");
    st.textContent = "…";
    try {
      if (tr.dataset.id) await put(`/pricing/admin/variants/${tr.dataset.id}`, body);
      else await post(`/pricing/admin/products/${pmProduct.id}/variants`, body);
      await loadCatalog();
      renderVariants();
      renderAccessoryPicker();
    } catch (err) { st.textContent = `✘ ${err.message}`; }
  });
}
$("pmAddVariant").addEventListener("click", () => {
  $("pmVariants").insertAdjacentHTML("beforeend", `<tr data-id="">
    <td><input type="text" class="pr-cell" data-f="sku" placeholder="${esc(pmProduct.sku)}-…"></td><td><input type="text" class="pr-cell" data-f="name" placeholder="e.g. 16 channel"></td>
    <td><input type="number" class="pr-cell" data-f="channels" min="1" max="64"></td>
    <td><select class="pr-cell" data-f="valveType"><option value="">–</option>${Object.entries(catalog.valveTypes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></td>
    <td><input type="text" class="pr-cell" data-f="size"></td><td><input type="checkbox" data-f="active" checked></td>
    <td><button class="pr-link" data-save>Save</button><span class="pr-hint" data-st></span></td></tr>`);
  wireVariantRows();
});

function variantLabel(v) {
  const p = catalog.products.find((x) => x.id === v.productId);
  return `${p?.name || "?"}${v.name !== "Standard" ? ` - ${v.name}` : ""} (${v.sku})`;
}
function renderAccessoryPicker() {
  $("pmAccPick").innerHTML = catalog.variants.filter((v) => v.productId !== pmProduct.id && v.active)
    .map((v) => `<option value="${v.id}">${esc(variantLabel(v))}</option>`).join("");
}
function renderAccessories() {
  renderAccessoryPicker();
  const ro = !can("editor") ? "disabled" : "";
  $("pmAccessories").innerHTML = pmAccessories.length ? pmAccessories.map((a, i) => {
    const v = catalog.variants.find((x) => x.id === a.accessoryVariantId);
    return `<tr data-i="${i}"><td>${esc(v ? variantLabel(v) : "?")}</td>
      <td><select class="pr-cell" data-f="mode" ${ro}><option value="required" ${a.mode === "required" ? "selected" : ""}>Required</option><option value="optional" ${a.mode === "optional" ? "selected" : ""}>Optional</option></select></td>
      <td><input type="number" class="pr-cell" data-f="qtyPer" min="1" max="100" value="${a.qtyPer}" ${ro}></td>
      <td><input type="number" class="pr-cell" data-f="perUnits" min="1" max="100" value="${a.perUnits}" ${ro}> <small>× ${esc(pmProduct.name)}</small></td>
      <td>${ro ? "" : `<button class="pr-link danger" data-del="${i}">Remove</button>`}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="ota-muted">No accessories.</td></tr>`;
  $("pmAccessories").querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => {
    const a = pmAccessories[Number(el.closest("tr").dataset.i)];
    a[el.dataset.f] = el.dataset.f === "mode" ? el.value : Number(el.value);
  }));
  $("pmAccessories").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { pmAccessories.splice(Number(b.dataset.del), 1); renderAccessories(); }));
}
$("pmAccAdd").addEventListener("click", () => {
  const id = Number($("pmAccPick").value);
  if (!id || pmAccessories.some((a) => a.accessoryVariantId === id)) return;
  pmAccessories.push({ productId: pmProduct.id, accessoryVariantId: id, mode: "optional", qtyPer: 1, perUnits: 1 });
  renderAccessories();
});
$("pmAccSave").addEventListener("click", async () => {
  try {
    await put(`/pricing/admin/products/${pmProduct.id}/accessories`, { accessories: pmAccessories });
    await loadCatalog();
    $("pmStatus").textContent = "✔ Accessories saved";
  } catch (err) { $("pmStatus").textContent = `✘ ${err.message}`; }
});

// =====================================================================
// AUDIT
// =====================================================================

let auditEntries = [];
async function loadAudit(page) {
  const search = $("auditSearch").value.trim();
  try {
    const r = await api(`/pricing/admin/audit?page=${page}${search ? `&search=${encodeURIComponent(search)}` : ""}`);
    auditEntries = r.entries;
    const owner = can("owner");
    $("auditBody").innerHTML = r.entries.length ? r.entries.map((e, i) => `<tr>
      ${owner ? `<td><input type="checkbox" data-aid="${e.id}"></td>` : ""}
      <td>${fmtDateTime(e.at)}</td><td>${esc(e.actor)}</td><td><span class="pr-chip">${esc(e.action)}</span></td>
      <td>${esc(e.entity)}${e.entityId ? ` #${esc(e.entityId)}` : ""}</td><td>${esc(e.summary || "")}</td>
      <td>${e.before || e.after ? `<button class="pr-link" data-i="${i}">Details</button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="7" class="ota-muted">Nothing logged${search ? " matches" : " yet"}.</td></tr>`;
    $("auditAll").checked = false;
    $("auditDelSel").disabled = true;
    $("auditBody").querySelectorAll("[data-aid]").forEach((c) => c.addEventListener("change", auditSelChanged));
    $("auditBody").querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
      const e = auditEntries[Number(b.dataset.i)];
      $("amBody").innerHTML = `<h2>${esc(e.action)} ${esc(e.entity)}</h2><p>${esc(e.summary || "")}<br><small class="ota-muted">${fmtDateTime(e.at)} · ${esc(e.actor)} · ${esc(e.ip || "")}</small></p>
        <div class="pr-grid2"><div><h3 class="ota-subhead">Before</h3><pre class="pr-audit-json">${esc(JSON.stringify(e.before, null, 2))}</pre></div>
        <div><h3 class="ota-subhead">After</h3><pre class="pr-audit-json">${esc(JSON.stringify(e.after, null, 2))}</pre></div></div>`;
      openModal("auditModal");
    }));
    pager($("auditPager"), page, r.total, loadAudit);
  } catch (err) { fail(err); }
}
$("auditSearch").addEventListener("input", debounce(() => loadAudit(1), 350));
const auditSelected = () => [...$("auditBody").querySelectorAll("[data-aid]:checked")].map((c) => c.dataset.aid);
function auditSelChanged() { $("auditDelSel").disabled = auditSelected().length === 0; }
$("auditAll").addEventListener("change", (e) => {
  $("auditBody").querySelectorAll("[data-aid]").forEach((c) => { c.checked = e.target.checked; });
  auditSelChanged();
});
async function deleteAudit(body, what) {
  if (!confirm(`Delete ${what} permanently?\n\nA note that you deleted it stays in the log.`)) return;
  try {
    const r = await post("/pricing/admin/audit/delete", body);
    showMsg("ok", `${r.deleted} audit entr${r.deleted === 1 ? "y" : "ies"} deleted.`);
    loadAudit(1);
  } catch (err) { fail(err); }
}
$("auditDelSel").addEventListener("click", () => { const ids = auditSelected(); deleteAudit({ ids }, `${ids.length} selected entr${ids.length === 1 ? "y" : "ies"}`); });
$("auditDelAll").addEventListener("click", () => deleteAudit({ all: true }, "the WHOLE audit log"));

// =====================================================================
// SETTINGS
// =====================================================================

async function loadSettings() {
  try {
    const r = await api("/pricing/admin/settings");
    const s = r.settings;
    $("stHome").innerHTML = STATES.map((x) => `<option>${esc(x)}</option>`).join("");
    $("stValidity").value = s.quoteValidityDays; $("stWarn").value = s.expiryWarningDays; $("stHome").value = s.homeState;
    $("stTwo").checked = !!s.requireSecondApprover; $("stDisclaimer").value = s.disclaimer;
    const ro = !can("owner");
    for (const id of ["stValidity", "stWarn", "stHome", "stTwo", "stDisclaimer"]) $(id).disabled = ro;
    $("staffBody").innerHTML = r.staff.length ? r.staff.map((x) => `<tr><td>${esc(x.email)}</td><td>${esc(x.role)}</td>
      <td>${esc(x.updatedBy || "")}<br><small class="ota-muted">${fmtDate(x.updatedAt)}</small></td>
      <td>${can("owner") ? `<button class="pr-link danger" data-rm="${esc(x.email)}">Remove</button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="4" class="ota-muted">Only full admins for now.</td></tr>`;
    $("staffBody").querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(`Remove ${b.dataset.rm}'s pricing role?`)) return;
      try { await put("/pricing/admin/staff", { email: b.dataset.rm, role: null }); loadSettings(); } catch (err) { fail(err); }
    }));
  } catch (err) { fail(err); }
}
$("stSave").addEventListener("click", async () => {
  try {
    await put("/pricing/admin/settings", {
      quoteValidityDays: Number($("stValidity").value), expiryWarningDays: Number($("stWarn").value), homeState: $("stHome").value,
      requireSecondApprover: $("stTwo").checked, disclaimer: $("stDisclaimer").value.trim()
    });
    showMsg("ok", "Settings saved.");
    await loadCurrent();
    renderCalcSetup();
  } catch (err) { fail(err); }
});
$("staffAdd").addEventListener("click", async () => {
  try {
    await put("/pricing/admin/staff", { email: $("staffEmail").value.trim(), role: $("staffRole").value });
    $("staffEmail").value = "";
    loadSettings();
  } catch (err) { fail(err); }
});
