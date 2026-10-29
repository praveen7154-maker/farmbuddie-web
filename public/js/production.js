// Production (admin panel > Production) - daily entry of new MCU controllers
// (Hub controller mode) and field nodes (Node mode: motor, valve, filter
// backwash ... nodes - only the type is chosen, the serial is made), for
// the production team and admins. The server does the real work and
// every check (server/src/bridge/production.js): same records and same
// "nothing used twice" rules as the MCU / Controller page's Excel upload,
// plus who entered each one. Admins also manage the team's accounts here.
import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import { staffSession, clearStaffSession } from "/js/production-session.js";
import { fmtTime, fmtDate } from "/js/time-format.js";
import { printLabels, printNodeLabels } from "/js/labels.js";
import { NODE_TYPES, nodeTypeName } from "/js/node-types.js";
import { qrSvg } from "/js/qr-lib.js";

const shell = window.FBShell;
const icon = shell.icon;
const esc = shell.esc;
const $ = (id) => document.getElementById(id);
// Checked and marked on the form; MSISDN and IMSI aren't typed - they come
// with the SIM chosen from the SIM inventory.
const FIELDS = ["serialNumber", "uniqueId", "imeiNumber", "simNumber"];
const TYPED = ["serialNumber", "uniqueId", "imeiNumber"];
const VARIANT_NAMES = { IRRIGO: "Irrigo", IRRIGO_PLUS: "Irrigo Plus", IRRIGO_SMART_PLUS: "Irrigo Smart Plus" };
const FIELD_NAMES = { serialNumber: "Serial Number", uniqueId: "Unique ID", imeiNumber: "IMEI", simMsisdn: "SIM MSISDN", simNumber: "SIM Number", simImsi: "SIM IMSI" };
const IST_MS = 330 * 60 * 1000;
const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const shiftDay = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

// ---------------------------------------------------------------- who is this
const staff = staffSession();
let getToken;
let me = null;

if (staff) {
  getToken = async () => staff.token;
  start();
} else {
  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.replace("/login.html"); return; }
    getToken = () => user.getIdToken();
    if (!me) start();
  });
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    signOut(auth).then(() => window.location.replace("/login.html"));
  });
}

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(BRIDGE_BASE_URL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && staff) {
    clearStaffSession();
    window.location.replace("/login.html");
    throw new Error("Signed out");
  }
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
  return data;
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("pdToast");
  t.className = `pd-toast show ${kind}`;
  t.innerHTML = icon(kind === "ok" ? "circle-check" : "circle-alert") + `<span>${esc(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}

// ---------------------------------------------------------------- start
async function start() {
  try {
    me = await api("/production/me");
  } catch (err) {
    $("pd").innerHTML = `<div class="pd-card pd-blocked">${icon("circle-alert")}<div><b>Production isn't available</b><p>${esc(err.status === 403 ? "This login has no access to Production." : err.message)}</p></div></div>`;
    return;
  }
  const admin = me.role === "admin";
  $("pdRole").textContent = admin ? "Admin · Production" : "Production team";
  $("pdListName").textContent = admin ? "Entries" : "My entries";
  // No team card for the production team: their entries go beside the form instead.
  if (!admin) $("pdSide").appendChild($("pdListCard"));
  $("pd").removeAttribute("aria-busy");
  setupVariants();
  setupPrint();
  setupForm();
  setupNodes();
  setupList(admin);
  if (admin) setupTeam();
  setupMode();
  await Promise.all([loadSummary(), loadEntries()]);
  focusFirst();
}

// ---------------------------------------------------------------- hub / node
// The entry card's switch (top right): Hub controller - the form with every
// field; Node - the node type and how many, the serial is made. The hero's
// numbers, the side card (SIMs / node stock) and the entries follow it.
let mode = (() => { try { return localStorage.getItem("fb.prodMode") === "node" ? "node" : "hub"; } catch (e) { return "hub"; } })();
const isNode = () => mode === "node";
const kind = () => (isNode() ? "node" : "controller");

function setupMode() {
  document.querySelectorAll("#pdMode [data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    try { localStorage.setItem("fb.prodMode", mode); } catch (e) { /* private mode */ }
    applyMode();
    entries = [];
    loadSummary();
    loadEntries();
    focusFirst();
  }));
  applyMode();
}

function applyMode() {
  const node = isNode();
  const admin = me.role === "admin";
  $("pdEntry").dataset.mode = mode;
  document.querySelectorAll("#pdMode [data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("pdHubPane").hidden = node;
  $("pdNodePane").hidden = !node;
  $("pdEntryName").textContent = node ? "New node" : "New controller";
  $("pdEntryIc").innerHTML = icon(node ? "qr-code" : "scan-line");
  $("pdClear").hidden = node;
  $("pdSimCard").hidden = node;
  $("pdStockCard").hidden = !node;
  $("pdPrintWhat").innerHTML = node ? "2 &times; 1 inch, QR + serial - node box + carton" : "2 &times; 1 inch, serial barcode - module box + carton";
  $("pdSearch").placeholder = node ? "Find serial, node type…" : "Find serial, ID, IMEI, SIM…";
  $("pdSpark").setAttribute("aria-label", `${node ? "Nodes" : "Controllers"} made per day, last 7 days`);
  $("pdHello").textContent = node
    ? (admin ? "Choose the node type - the serial is made and its QR label printed." : `Hello ${me.name} - choose the node type, the serial is made for you.`)
    : (admin ? "Enter controllers yourself, or manage the production team below." : `Hello ${me.name} - scan or type each new controller. Every field is checked as you go.`);
  nodeSaveText();
  if (!node) $("pdSaveText").textContent = "Add controller";
}

// ---------------------------------------------------------------- summary
let nextUniqueId = null;
let lastSerials = {};
async function loadSummary() {
  const want = kind();
  try {
    const s = await api(`/production/summary?kind=${want}`);
    if (want !== kind()) return;            // switched mode meanwhile
    countTo($("pdMine"), s.mineToday);
    countTo($("pdTeamToday"), s.teamToday);
    countTo($("pdMineTotal"), s.mineTotal);
    drawSpark(s.days);
    if (s.kind === "node") {
      $("pdVariantsToday").innerHTML = NODE_TYPES
        .map((t) => `<span class="pd-vchip" data-tone="${nodeTone(t.type)}"><i></i>${esc(t.name)} <b>${s.byType?.[t.type] ?? 0}</b></span>`).join("");
      nextSerials = s.nextSerials || {};
      showStock(s.stock);
      showNode();
      return;
    }
    $("pdVariantsToday").innerHTML = Object.entries(s.byVariant)
      .map(([v, n]) => `<span class="pd-vchip" data-tone="${toneOf(v)}"><i></i>${esc(VARIANT_NAMES[v] || v)} <b>${n}</b></span>`).join("");
    nextUniqueId = s.nextUniqueId;
    lastSerials = s.lastSerials || {};
    const b = $("pdNextId");
    b.hidden = !nextUniqueId;
    b.textContent = nextUniqueId ? `Next free: ${nextUniqueId}` : "";
  } catch (err) {
    console.warn("summary:", err);
  }
}
const toneOf = (v) => ({ IRRIGO: "green", IRRIGO_PLUS: "sky", IRRIGO_SMART_PLUS: "violet" }[v] || "teal");
const nodeTone = (t) => ({ MOTOR: "amber", SOLENOID_VALVE: "sky", BUTTERFLY_VALVE: "violet", FILTER_BACKWASH: "teal", FERTIGATION: "lime", WATER_LEVEL: "green" }[t] || "teal");

function countTo(el, n) {
  const from = Number(el.dataset.n || 0);
  el.dataset.n = n;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === n) { el.textContent = n; return; }
  const t0 = performance.now(), dur = 600;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  el.classList.remove("pd-bump"); void el.offsetWidth; el.classList.add("pd-bump");
}

function drawSpark(days) {
  const svg = $("pdSpark");
  const max = Math.max(1, ...days.map((d) => d.count));
  const w = 140 / days.length;
  svg.innerHTML = days.map((d, i) => {
    const h = Math.max(2, (d.count / max) * 34);
    return `<rect x="${(i * w + 3).toFixed(1)}" y="${(38 - h).toFixed(1)}" width="${(w - 6).toFixed(1)}" height="${h.toFixed(1)}" rx="2"${i === days.length - 1 ? ' class="today"' : ""}><title>${esc(fmtDate(d.day + "T12:00:00+05:30"))}: ${d.count}</title></rect>`;
  }).join("");
}

// ---------------------------------------------------------------- variant
let variant = null;
function setupVariants() {
  const saved = (() => { try { return localStorage.getItem("fb.prodVariant"); } catch (e) { return null; } })();
  const pick = (v) => {
    variant = v;
    document.querySelectorAll("#pdVariants [data-variant]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.variant === v)));
    $("pdVariantMsg").textContent = "";
    try { localStorage.setItem("fb.prodVariant", v); } catch (e) { /* private mode */ }
  };
  document.querySelectorAll("#pdVariants [data-variant]").forEach((b) => b.addEventListener("click", () => { pick(b.dataset.variant); autoSerial(); focusFirst(); }));
  if (saved && VARIANT_NAMES[saved]) pick(saved);
}

// ---------------------------------------------------------------- serial from the Unique ID
// A variant chosen + a 4-digit Unique ID -> the Serial Number in the same
// format as the newest one of that variant, ending in this Unique ID:
// IRRIGO26AA10002 + 0003 -> IRRIGO26AA10003. No serial of that variant yet:
// the Excel template's format (IRRIGO26AA1 + ID, IRRIGOPLUS26PP1 + ID,
// IRRIGOSMART26SS1 + ID, 26 = this year). Typing in Serial stops it;
// emptying Serial lets it fill again.
const SERIAL_START = { IRRIGO: ["IRRIGO", "AA"], IRRIGO_PLUS: ["IRRIGOPLUS", "PP"], IRRIGO_SMART_PLUS: ["IRRIGOSMART", "SS"] };
let lastAutoSerial = "";

export function serialFor(v, uid, last) {
  const m = /^(.*\D)?(\d*?)(\d{4})$/.exec(String(last || ""));
  if (m) return `${m[1] || ""}${m[2] || ""}${uid}`;
  const [name, code] = SERIAL_START[v] || [v, ""];
  return `${name}${new Date(Date.now() + IST_MS).toISOString().slice(2, 4)}${code}1${uid}`;
}

function autoSerial() {
  const serial = $("pdForm").elements.serialNumber;
  const uid = $("pdForm").elements.uniqueId.value;
  if (!variant || !/^\d{4}$/.test(uid)) return;
  if (serial.value && serial.value !== lastAutoSerial) return;      // typed by hand - leave it
  serial.value = lastAutoSerial = serialFor(variant, uid, lastSerials[variant]);
  touched.add("serialNumber");
  scheduleCheck();
}

// ---------------------------------------------------------------- SIMs
// The available SIMs from the SIM inventory (server: /production/sims). The
// SIM field is a search list: type any part of the SIM number, MSISDN or
// IMSI - or scan the SIM card's barcode, which picks it (and saves, as the
// last field). The chosen SIM's MSISDN and IMSI fill the two locked fields.
let sims = [];
let simCounts = { available: 0, assigned: 0, total: 0 };
let simShown = [];
let simActive = -1;
const groupIccid = (n) => String(n).replace(/(\d{4})(?=\d)/g, "$1 ");

async function loadSims() {
  try {
    const r = await api("/production/sims");
    sims = r.available;
    showSimCounts(r.counts);
    if (!$("pdSimList").hidden) filterSims();
  } catch (err) {
    $("pdSimInv").textContent = "Couldn't load the SIM inventory: " + err.message;
  }
}

function showSimCounts(c) {
  simCounts = c;
  countTo($("pdSimAvail"), c.available);
  countTo($("pdSimUsed"), c.assigned);
  countTo($("pdSimTotal"), c.total);
  $("pdSimAvail").classList.toggle("pd-out", !c.available);
  $("pdSimBar").style.width = `${c.total ? Math.round((c.assigned / c.total) * 100) : 0}%`;
  $("pdSimInv").textContent = !c.total ? "No SIMs yet - upload the operator's SIM list (CSV or Excel)."
    : !c.available ? "All SIMs are used - upload the next SIM list."
    : c.available < 10 ? `Only ${c.available} SIM${c.available === 1 ? "" : "s"} left - time to order more.`
    : `${Math.round((c.assigned / c.total) * 100)}% used.`;
  const badge = $("pdSimCount");
  badge.textContent = `${c.available} available`;
  badge.className = `pd-sim-count${c.available ? (c.available < 10 ? " low" : "") : " out"}`;
  $("pdSimSearch").placeholder = c.available ? "Choose - type or scan the SIM number" : "No SIMs available - upload the SIM list";
}

function filterSims() {
  const q = $("pdSimSearch").value.replace(/\D/g, "");
  simShown = (q ? sims.filter((x) => x.iccid.includes(q) || x.msisdn.includes(q) || x.imsi.includes(q)) : sims).slice(0, 60);
  simActive = simShown.length ? 0 : -1;
  const list = $("pdSimList");
  if (!simShown.length) {
    list.innerHTML = `<li class="pd-sim-none">${sims.length ? "No available SIM matches" : "No SIMs available - upload the SIM list"}</li>`;
  } else {
    const mark = (text) => {
      const t = esc(text);
      if (!q) return t;
      const i = text.indexOf(q);
      return i < 0 ? t : `${esc(text.slice(0, i))}<mark>${esc(q)}</mark>${esc(text.slice(i + q.length))}`;
    };
    list.innerHTML = simShown.map((x, i) => `<li role="option" id="pdSim${i}" data-i="${i}" aria-selected="${i === simActive}">
      <b>${mark(x.iccid)}</b><span>MSISDN ${mark(x.msisdn)} &middot; IMSI ${mark(x.imsi)}</span></li>`).join("") +
      (sims.length > simShown.length && !q ? `<li class="pd-sim-none">${sims.length - simShown.length} more - type part of the number</li>` : "");
  }
  openSims(true);
}

function openSims(open) {
  $("pdSimList").hidden = !open;
  $("pdSimSearch").setAttribute("aria-expanded", String(open));
  if (open && simActive >= 0) $("pdSimSearch").setAttribute("aria-activedescendant", `pdSim${simActive}`);
}

function moveSim(d) {
  if (!simShown.length) return;
  simActive = (simActive + d + simShown.length) % simShown.length;
  document.querySelectorAll("#pdSimList [data-i]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.i === simActive)));
  document.getElementById(`pdSim${simActive}`)?.scrollIntoView({ block: "nearest" });
  $("pdSimSearch").setAttribute("aria-activedescendant", `pdSim${simActive}`);
}

function chooseSim(x) {
  const el = $("pdForm").elements;
  el.simNumber.value = x.iccid;
  el.simMsisdn.value = x.msisdn;
  el.simImsi.value = x.imsi;
  $("pdSimSearch").value = x.iccid;
  openSims(false);
  touched.add("simNumber");
  scheduleCheck();
}

function clearSim() {
  const el = $("pdForm").elements;
  el.simNumber.value = el.simMsisdn.value = el.simImsi.value = "";
}

function setupSims() {
  const search = $("pdSimSearch");
  search.addEventListener("focus", filterSims);
  search.addEventListener("input", () => {
    search.value = search.value.replace(/[^\d ]/g, "");
    if ($("pdForm").elements.simNumber.value && search.value !== $("pdForm").elements.simNumber.value) { clearSim(); render(); }
    filterSims();
  });
  search.addEventListener("blur", () => setTimeout(() => openSims(false), 150));
  search.addEventListener("keydown", (e) => {
    const chosen = $("pdForm").elements.simNumber.value;
    if (e.key === "ArrowDown") { e.preventDefault(); if ($("pdSimList").hidden) filterSims(); else moveSim(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSim(-1); }
    else if (e.key === "Escape") { openSims(false); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { save(); return; }
      const q = search.value.replace(/\D/g, "");
      if (chosen && q === chosen) { save(); return; }                  // already chosen: Enter saves
      const exact = sims.find((x) => x.iccid === q || x.msisdn === q || x.imsi === q);
      if (exact) { chooseSim(exact); save(); return; }                  // a scanned SIM: pick it and save
      if (simActive >= 0 && simShown[simActive]) chooseSim(simShown[simActive]);
    }
  });
  $("pdSimList").addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();                                                  // keep the cursor in the field
    chooseSim(simShown[+li.dataset.i]);
  });

  $("pdSimFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) uploadSims(file);
  });
  loadSims();
}

// The operator's SIM list (Airtel's CSV: MOBILE_NUMBER, SIM_NO, SIM_IMSI ...)
// or our own columns (SIM MSISDN, SIM Number, SIM IMSI) - CSV or Excel.
// Only those three are sent; everything else in the file is ignored.
const SIM_COLUMNS = {
  msisdn: ["MOBILENUMBER", "SIMMSISDN", "MSISDN", "MOBILENO"],
  iccid: ["SIMNO", "SIMNUMBER", "ICCID", "SIMICCID"],
  imsi: ["SIMIMSI", "IMSI"]
};
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

async function readSimFile(file) {
  let table;
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await window.loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  } else {
    table = parseCsv(await file.text());
  }
  if (!table.length) throw new Error("The file is empty");
  const head = table[0].map((h) => String(h).toUpperCase().replace(/[^A-Z]/g, ""));
  const col = Object.fromEntries(Object.entries(SIM_COLUMNS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => ({ msisdn: "SIM MSISDN / MOBILE_NUMBER", iccid: "SIM Number / SIM_NO", imsi: "SIM IMSI / SIM_IMSI" }[k]));
  if (missing.length) throw new Error(`Column not found: ${missing.join(", ")}`);
  return table.slice(1).map((r) => ({ msisdn: String(r[col.msisdn] ?? ""), iccid: String(r[col.iccid] ?? ""), imsi: String(r[col.imsi] ?? "") }))
    .filter((r) => (r.msisdn + r.iccid + r.imsi).trim());
}

async function uploadSims(file) {
  const box = $("pdSimResult");
  try {
    const rows = await readSimFile(file);
    if (!rows.length) throw new Error("No SIM rows in the file");
    const r = await api("/production/sims", { method: "POST", body: { rows, fileName: file.name } });
    sims = r.available;
    showSimCounts(r.counts);
    const parts = [`<b>${r.added}</b> new SIM${r.added === 1 ? "" : "s"} added`];
    if (r.existing) parts.push(`${r.existing} already in the list`);
    if (r.alreadyOnController) parts.push(`${r.alreadyOnController} already on a controller (not offered)`);
    if (r.invalidCount) parts.push(`<span class="pd-out">${r.invalidCount} skipped</span>`);
    box.hidden = false;
    box.innerHTML = `${icon("microchip")}<div><b>${esc(file.name)}</b><p>${parts.join(" &middot; ")}</p>` +
      (r.invalid?.length ? `<small>${r.invalid.slice(0, 5).map((x) => `row ${x.row}: ${esc(x.reason)}`).join("; ")}${r.invalidCount > 5 ? " ..." : ""}</small>` : "") +
      `</div><span></span><button type="button" class="pd-icon-btn" id="simResClose" aria-label="Close">${icon("x")}</button>`;
    $("simResClose").addEventListener("click", () => { box.hidden = true; });
    toast(`${r.added} SIMs added - ${r.counts.available} available`);
  } catch (err) {
    toast("SIM list not uploaded: " + err.message, "bad");
  }
}

// ---------------------------------------------------------------- the form
// In Enter order: the typed fields, then the SIM picker.
const inputs = () => [...TYPED.map((f) => $("pdForm").elements[f]), $("pdSimSearch")];
const values = () => {
  const el = $("pdForm").elements;
  return { variant, ...Object.fromEntries(TYPED.map((f) => [f, el[f].value])), simNumber: el.simNumber.value, simMsisdn: el.simMsisdn.value, simImsi: el.simImsi.value };
};
let touched = new Set();
let lastCheck = null;
// What the last refused save said about fields that are still empty (the
// SIM not chosen ...) - kept until they're filled, whatever checks run after.
let saveProblems = {};
let checkTimer = null;
let checkSeq = 0;
let saving = false;

function focusFirst() {
  if (isNode()) {
    ($("pdNodeTypes").querySelector('[aria-checked="true"]') || $("pdNodeTypes").querySelector("button"))?.focus();
    return;
  }
  const first = inputs().find((i) => !i.value) || inputs()[0];
  first.focus();
}

function setupForm() {
  setupSims();
  inputs().slice(0, TYPED.length).forEach((input, i) => {
    input.addEventListener("input", () => {
      if (input.name === "uniqueId" || input.inputMode === "numeric") input.value = input.value.replace(/[^\d]/g, "");
      touched.add(input.name);
      if (input.name === "uniqueId") autoSerial();
      scheduleCheck();
    });
    input.addEventListener("blur", () => { if (input.value) touched.add(input.name); render(); });
    // Barcode scanners type the code and then Enter: go to the next field;
    // on the last one, save.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { save(); return; }
      touched.add(input.name);
      const next = inputs()[i + 1];
      if (next) next.focus(); else save();
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && document.activeElement?.closest("#pdForm, #pdVariants, #pdNodePane")) { e.preventDefault(); save(); }
  });
  $("pdSave").addEventListener("click", save);
  $("pdClear").addEventListener("click", () => resetForm(true));
  $("pdNextId").addEventListener("click", (e) => {
    e.preventDefault();
    const u = $("pdForm").elements.uniqueId;
    u.value = nextUniqueId;
    touched.add("uniqueId");
    autoSerial();
    scheduleCheck();
    ($("pdForm").elements.imeiNumber).focus();
  });
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 300);
}

async function runCheck() {
  const seq = ++checkSeq;
  try {
    const r = await api("/production/check", { method: "POST", body: values() });
    if (seq !== checkSeq) return;           // a newer check is on its way
    lastCheck = r;
    render();
  } catch (err) {
    if (seq === checkSeq) console.warn("check:", err);
  }
}

// Each field: empty / ok / wrong format / already used / (IMEI) check digit hint.
function render(showAll = false) {
  const base = lastCheck || { problems: {}, clashes: [] };
  const el = $("pdForm").elements;
  const still = Object.fromEntries(Object.entries(saveProblems).filter(([f]) => el[f] && !el[f].value));
  const c = { ...base, problems: { ...(base.problems || {}), ...still } };
  if (Object.keys(still).length) showAll = true;
  const clashBy = Object.fromEntries((c.clashes || []).map((x) => [x.field, x]));
  for (const f of FIELDS) {
    const el = document.querySelector(`.pd-field[data-field="${f}"]`);
    const input = $("pdForm").elements[f];   // simNumber: the chosen SIM (hidden field)
    const msg = el.querySelector(".pd-field-msg");
    const show = showAll || touched.has(f);
    let state = "", text = "";
    if (clashBy[f]) {
      state = "clash";
      text = `Already used by controller ${clashBy[f].uniqueId || clashBy[f].controllerId}`;
    } else if (show && c.problems?.[f] && (input.value || showAll)) {
      state = "bad";
      text = c.problems[f];
    } else if (input.value && !c.problems?.[f]) {
      state = "ok";
      if (f === "imeiNumber" && c.imeiCheckDigitOk === false) { state = "warn"; text = "Check digit doesn't match - a typo? (saved anyway if it's right)"; }
      if (f === "uniqueId" && c.values?.uniqueId && c.values.uniqueId !== input.value) text = `Saved as ${c.values.uniqueId}`;
      if (f === "serialNumber" && input.value === lastAutoSerial) text = "Filled in from the variant and Unique ID - change it if this board's differs";
    }
    el.dataset.state = state;
    msg.textContent = text;
  }
  if (showAll && !variant) $("pdVariantMsg").textContent = "Choose the variant";
}

async function save() {
  if (saving) return;
  if (isNode()) return saveNodes();
  if (!variant) { render(true); $("pdVariants").querySelector("button").focus(); return; }
  saving = true;
  const btn = $("pdSave");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const r = await api("/production/controllers", { method: "POST", body: values() });
    celebrate();
    toast(`Controller ${r.controller.uniqueId} saved${printPrefs.auto ? ` - printing ${printPrefs.copies} label${printPrefs.copies > 1 ? "s" : ""}` : ""}`);
    // back to Serial for the next board's scan once the print dialog closes
    if (printPrefs.auto) printLabels(r.controller, printPrefs.copies).then(() => $("pdForm").elements.serialNumber.focus());
    if (currentDay === istToday()) {
      entries.unshift(r.controller);
      renderEntries(r.controller.id);
    }
    sims = sims.filter((x) => x.iccid !== r.controller.simNumber);   // gone from the list at once
    showSimCounts({ ...simCounts, available: sims.length, assigned: simCounts.assigned + 1 });
    resetForm(false);
    loadSummary();
    loadSims();
  } catch (err) {
    if (err.data?.problems || err.data?.clashes) {
      saveProblems = err.data.problems || {};
      lastCheck = { problems: err.data.problems || {}, clashes: err.data.clashes || [], values: lastCheck?.values };
      FIELDS.forEach((f) => touched.add(f));
      render(true);
      const firstBad = FIELDS.find((f) => document.querySelector(`.pd-field[data-field="${f}"]`).dataset.state === "bad" ||
        document.querySelector(`.pd-field[data-field="${f}"]`).dataset.state === "clash");
      if (firstBad) (firstBad === "simNumber" ? $("pdSimSearch") : $("pdForm").elements[firstBad]).focus();
      toast(err.data.clashes?.length ? `${FIELD_NAMES[err.data.clashes[0].field]} is already on another controller` : "Fix the marked fields", "bad");
    } else {
      toast(err.message, "bad");
    }
  } finally {
    saving = false;
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

function resetForm(keepFocus) {
  $("pdForm").reset();
  saveProblems = {};
  clearSim();
  lastAutoSerial = "";
  touched = new Set();
  lastCheck = null;
  render();
  if (keepFocus !== null) $("pdForm").elements.serialNumber.focus();
}

function celebrate() {
  const card = document.querySelector(".pd-entry");
  card.classList.remove("pd-saved"); void card.offsetWidth; card.classList.add("pd-saved");
}

// ---------------------------------------------------------------- nodes
// Nothing to type: the type (a tile), how many (1-50), Generate. The card
// shows the label that prints - QR + serial - with the next serial of that
// type; the server gives out the real ones (the same, unless someone else
// saved one of that type in between).
const MAX_NODES = 50;
let nodeType = null;
let nextSerials = {};
let nodeQty = 1;
let qrShown = "";

function setupNodes() {
  const box = $("pdNodeTypes");
  box.innerHTML = NODE_TYPES.map((t) => `
    <button type="button" role="radio" aria-checked="false" data-type="${t.type}" data-tone="${nodeTone(t.type)}">
      <span class="pd-node-ic">${icon(t.icon)}</span><b>${esc(t.name.replace(/ node$/, ""))}</b><small data-next>${esc(t.prefix)}${t.year ? "··" : ""}</small>
    </button>`).join("");
  const saved = (() => { try { return localStorage.getItem("fb.prodNodeType"); } catch (e) { return null; } })();
  const pick = (t) => {
    nodeType = t;
    box.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === t)));
    $("pdNodeMsg").textContent = "";
    try { localStorage.setItem("fb.prodNodeType", t); } catch (e) { /* private mode */ }
    showNode();
  };
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (b) pick(b.dataset.type);
  });
  // arrow keys move between the tiles (Ctrl+Enter generates, as on the form)
  box.addEventListener("keydown", (e) => {
    const tiles = [...box.querySelectorAll("[data-type]")];
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 3, ArrowLeft: -1, ArrowUp: -3 }[e.key];
    if (step) {
      e.preventDefault();
      const next = tiles[(i + step + tiles.length) % tiles.length];
      next.focus();
      pick(next.dataset.type);
    }
  });
  if (saved && NODE_TYPES.some((t) => t.type === saved)) pick(saved);

  const qty = $("pdNodeQty");
  const setQty = (n) => {
    nodeQty = Math.min(MAX_NODES, Math.max(1, Math.round(Number(n)) || 1));
    qty.value = nodeQty;
    showNode();
  };
  qty.addEventListener("input", () => { qty.value = qty.value.replace(/\D/g, ""); if (qty.value) setQty(qty.value); });
  qty.addEventListener("blur", () => setQty(qty.value));
  qty.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); setQty(qty.value); save(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setQty(nodeQty + 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setQty(nodeQty - 1); }
  });
  $("pdQtyDown").addEventListener("click", () => setQty(nodeQty - 1));
  $("pdQtyUp").addEventListener("click", () => setQty(nodeQty + 1));
}

// "FBMN2610004" + 3 -> "FBMN2610006"
const serialPlus = (sn, n) => {
  const m = /^(.*?)(\d{5})$/.exec(sn || "");
  return m ? m[1] + (Number(m[2]) + n) : "";
};

function nodeSaveText() {
  if (!isNode()) return;
  $("pdSaveText").textContent = `Generate ${nodeQty > 1 ? `${nodeQty} nodes` : "node"}`;
}

function showNode() {
  // each tile: the serial its next node gets
  document.querySelectorAll("#pdNodeTypes [data-type]").forEach((b) => {
    if (nextSerials[b.dataset.type]) b.querySelector("[data-next]").textContent = nextSerials[b.dataset.type];
  });
  const t = NODE_TYPES.find((x) => x.type === nodeType);
  const next = t ? nextSerials[t.type] : null;
  $("pdNodeLabel").dataset.tone = t ? nodeTone(t.type) : "";
  $("pdNodeTypeName").textContent = t ? t.name.toUpperCase() : "Choose the node type";
  $("pdNodeSerial").textContent = next || (t ? "…" : "— — —");
  $("pdNodeSn").textContent = next || (t ? "…" : "—");
  $("pdNodeRange").textContent = next && nodeQty > 1 ? `${nodeQty} nodes: ${next} → ${serialPlus(next, nodeQty - 1)}` : next ? "the next free serial of this type" : "";
  nodeSaveText();
  drawQr(next || "");
}

async function drawQr(text) {
  if (text === qrShown) return;
  qrShown = text;
  const box = $("pdNodeQr");
  if (!text) { box.innerHTML = `<span class="pd-qr-empty">${icon("qr-code")}</span>`; return; }
  try {
    const svg = await qrSvg(text);
    if (qrShown === text) box.innerHTML = svg;
  } catch (err) {
    box.innerHTML = `<span class="pd-qr-empty">${icon("qr-code")}</span>`;
    console.warn("qr:", err);
  }
}

function showStock(stock) {
  if (!stock) return;
  $("pdStock").innerHTML = NODE_TYPES.map((t) => {
    const s = stock[t.type] || { available: 0, total: 0 };
    const pct = s.total ? Math.round((s.available / s.total) * 100) : 0;
    return `<div class="pd-stock-row" data-tone="${nodeTone(t.type)}">
      <span class="pd-node-ic">${icon(t.icon)}</span>
      <span class="pd-stock-name">${esc(t.name)}</span>
      <span class="pd-stock-n"><b>${s.available}</b> / ${s.total}</span>
      <span class="pd-stock-bar" title="${s.available} available of ${s.total} made"><i style="width:${pct}%"></i></span>
    </div>`;
  }).join("");
}

async function saveNodes() {
  if (!nodeType) {
    $("pdNodeMsg").textContent = "Choose the node type";
    $("pdNodeTypes").querySelector("button").focus();
    return;
  }
  saving = true;
  const btn = $("pdSave");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const r = await api("/production/nodes", { method: "POST", body: { type: nodeType, count: nodeQty } });
    celebrate();
    const first = r.nodes[0].serialNumber, last = r.nodes[r.nodes.length - 1].serialNumber;
    toast(`${r.nodes.length > 1 ? `${r.nodes.length} nodes ${first} → ${last}` : `Node ${first}`} saved` +
      (printPrefs.auto ? ` - printing ${r.nodes.length * printPrefs.copies} label${r.nodes.length * printPrefs.copies > 1 ? "s" : ""}` : ""));
    if (printPrefs.auto) printNodeLabels(r.nodes, printPrefs.copies).catch((err) => toast("Labels not printed: " + err.message, "bad"));
    if (currentDay === istToday() && isNode()) {
      entries.unshift(...[...r.nodes].reverse());
      renderEntries(new Set(r.nodes.map((n) => n.id)));
    }
    nextSerials = r.nextSerials || nextSerials;
    showNode();
    loadSummary();
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    saving = false;
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- labels
// Remembered on this computer: print after each save (on unless switched
// off), and how many labels per controller (2: module box + carton).
const printPrefs = (() => {
  try {
    const p = JSON.parse(localStorage.getItem("fb.prodLabels") || "{}");
    return { auto: p.auto !== false, copies: Math.min(10, Math.max(1, Number(p.copies) || 2)) };
  } catch (e) { return { auto: true, copies: 2 }; }
})();
const savePrintPrefs = () => { try { localStorage.setItem("fb.prodLabels", JSON.stringify(printPrefs)); } catch (e) { /* private mode */ } };

function setupPrint() {
  const auto = $("pdAutoPrint"), out = $("pdCopies");
  auto.checked = printPrefs.auto;
  out.textContent = printPrefs.copies;
  auto.addEventListener("change", () => { printPrefs.auto = auto.checked; savePrintPrefs(); });
  const step = (n) => {
    printPrefs.copies = Math.min(10, Math.max(1, printPrefs.copies + n));
    out.textContent = printPrefs.copies;
    savePrintPrefs();
  };
  $("pdCopiesDown").addEventListener("click", () => step(-1));
  $("pdCopiesUp").addEventListener("click", () => step(1));
  const print = (list) => (listKind === "node" ? printNodeLabels(list, printPrefs.copies) : printLabels(list, printPrefs.copies))
    .catch((err) => toast("Labels not printed: " + err.message, "bad"));
  $("pdPrintAll").addEventListener("click", () => {
    const list = shown();
    if (!list.length) { toast("No entries to print", "bad"); return; }
    if (list.length > 1 && !confirm(`Print ${list.length * printPrefs.copies} labels (${list.length} ${listKind === "node" ? "nodes" : "controllers"} x ${printPrefs.copies})?`)) return;
    print(list);
  });
  $("pdEntries").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-print]");
    if (!b) return;
    const c = entries.find((x) => x.id === b.dataset.print);
    if (c) print(c);
  });
}

// ---------------------------------------------------------------- entries
let entries = [];
let listKind = "controller";     // what `entries` holds
let currentDay = istToday();
let who = "";            // admin filter: "" everyone, else a username / email

function setupList(admin) {
  const dayInput = $("pdDayInput");
  dayInput.value = currentDay;
  dayInput.max = istToday();
  const go = (day) => {
    if (!day || day > istToday()) return;
    currentDay = day;
    dayInput.value = day;
    $("pdNextDay").disabled = day >= istToday();
    loadEntries();
  };
  $("pdNextDay").disabled = true;
  dayInput.addEventListener("change", () => go(dayInput.value));
  $("pdPrevDay").addEventListener("click", () => go(shiftDay(currentDay, -1)));
  $("pdNextDay").addEventListener("click", () => go(shiftDay(currentDay, 1)));
  $("pdSearch").addEventListener("input", () => renderEntries());
  $("pdExport").addEventListener("click", exportExcel);
  if (admin) {
    const sel = $("pdWho");
    sel.hidden = false;
    sel.innerHTML = `<option value="">Everyone</option><option value="${esc(me.username)}">Me (${esc(me.username)})</option>`;
    sel.addEventListener("change", () => { who = sel.value; loadEntries(); });
  }
}

async function loadEntries() {
  const box = $("pdEntries");
  box.classList.add("loading");
  const want = kind();
  try {
    const q = new URLSearchParams({ day: currentDay, kind: want, ...(who ? { by: who } : {}) });
    const r = await api(`/production/entries?${q}`);
    if (want !== kind()) return;            // switched mode meanwhile
    entries = r.entries;
    listKind = want;
    renderEntries();
  } catch (err) {
    box.innerHTML = `<p class="pd-empty">${esc(err.message)}</p>`;
  } finally {
    box.classList.remove("loading");
  }
}

function shown() {
  const q = $("pdSearch").value.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => [e.serialNumber, e.uniqueId, e.imeiNumber, e.simMsisdn, e.simNumber, e.simImsi, e.createdBy?.name, e.createdBy?.id,
    e.type && nodeTypeName(e.type), e.status]
    .some((v) => String(v || "").toLowerCase().includes(q)));
}

function renderEntries(newIds) {
  const isNew = (id) => (newIds instanceof Set ? newIds.has(id) : id === newIds);
  const list = shown();
  const admin = me.role === "admin";
  const today = currentDay === istToday();
  const what = listKind === "node" ? "node" : "controller";
  $("pdCount").textContent = `${fmtDate(currentDay + "T12:00:00+05:30")}${today ? " · today" : ""} · ${entries.length} ${what}${entries.length === 1 ? "" : "s"}` +
    (list.length !== entries.length ? ` · ${list.length} shown` : "");
  if (!list.length) {
    $("pdEntries").innerHTML = `<div class="pd-empty">${icon("factory")}<p>${entries.length ? "Nothing matches the search." : today ? `No ${what}s yet today - the first one you add shows up here.` : `No ${what}s on this day.`}</p></div>`;
    return;
  }
  const byOf = (e) => (e.createdBy ? `${e.createdBy.type === "admin" ? "Admin" : esc(e.createdBy.name || e.createdBy.id)}` : (e.source === "production" ? "-" : "Excel upload"));
  if (listKind === "node") {
    $("pdEntries").innerHTML = list.map((e) => `<article class="pd-entry-row pd-node-row${isNew(e.id) ? " pd-new" : ""}" data-tone="${nodeTone(e.type)}">
      <div class="pd-entry-id"><b>${esc(e.serialNumber)}</b><span>${esc(nodeTypeName(e.type))}</span></div>
      <div class="pd-entry-main"><div><small>Status</small><span class="pd-status ${e.status === "assigned" ? "on" : ""}">${e.status === "assigned" ? "On a farm" : "Available"}</span></div></div>
      <div class="pd-entry-meta"><span>${e.createdAtMs ? fmtTime(e.createdAtMs) : ""}</span>${admin ? `<small>${byOf(e)}</small>` : ""}
        <button type="button" class="pd-icon-btn pd-reprint" data-print="${esc(e.id)}" title="Print labels" aria-label="Print labels for ${esc(e.serialNumber)}">${icon("printer")}</button></div>
    </article>`).join("");
    return;
  }
  $("pdEntries").innerHTML = list.map((e) => {
    const by = byOf(e);
    return `<article class="pd-entry-row${isNew(e.id) ? " pd-new" : ""}" data-tone="${toneOf(e.variant)}">
      <div class="pd-entry-id"><b>${esc(e.uniqueId)}</b><span>${esc(VARIANT_NAMES[e.variant] || e.variant || "")}</span></div>
      <div class="pd-entry-main">
        <div><small>Serial</small>${esc(e.serialNumber)}</div>
        <div><small>IMEI</small>${esc(e.imeiNumber)}</div>
        <div><small>SIM</small>${esc(e.simNumber || "-")}${e.simMsisdn ? ` · ${esc(e.simMsisdn)}` : ""}</div>
      </div>
      <div class="pd-entry-meta"><span>${e.createdAtMs ? fmtTime(e.createdAtMs) : ""}</span>${admin ? `<small>${by}</small>` : ""}
        <button type="button" class="pd-icon-btn pd-reprint" data-print="${esc(e.id)}" title="Print labels" aria-label="Print labels for ${esc(e.serialNumber)}">${icon("printer")}</button></div>
    </article>`;
  }).join("");
}

async function exportExcel() {
  const list = shown();
  if (!list.length) { toast("Nothing to export for this day", "bad"); return; }
  try {
    const XLSX = await window.loadXlsx();
    const by = (e) => (e.createdBy ? (e.createdBy.type === "admin" ? `Admin (${e.createdBy.id})` : `${e.createdBy.name} (${e.createdBy.id})`) : "");
    if (listKind === "node") {
      const ws = XLSX.utils.json_to_sheet(list.map((e) => ({
        "Node type": nodeTypeName(e.type), "Serial Number": e.serialNumber, "Status": e.status,
        "Entered by": by(e), "Time": e.createdAtMs ? fmtTime(e.createdAtMs) : ""
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Nodes");
      XLSX.writeFile(wb, `production_nodes_${currentDay}${who ? "_" + who.replace(/[^a-z0-9._-]/gi, "") : ""}.xlsx`);
      return;
    }
    // Same columns as the MCU / Controller upload template, then who and when.
    const rows = list.map((e) => ({
      "Variant": e.variant, "Serial Number": e.serialNumber, "Unique ID": e.uniqueId, "IMEI Number": e.imeiNumber,
      "SIM MSISDN": e.simMsisdn, "SIM Number": e.simNumber, "SIM IMSI": e.simImsi,
      "Entered by": e.createdBy ? (e.createdBy.type === "admin" ? `Admin (${e.createdBy.id})` : `${e.createdBy.name} (${e.createdBy.id})`) : "",
      "Time": e.createdAtMs ? fmtTime(e.createdAtMs) : ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Production");
    XLSX.writeFile(wb, `production_${currentDay}${who ? "_" + who.replace(/[^a-z0-9._-]/gi, "") : ""}.xlsx`);
  } catch (err) {
    toast("Couldn't make the Excel file: " + err.message, "bad");
  }
}

// ---------------------------------------------------------------- team (admins)
let users = [];

function makePassword() {
  // Easy to read out and type: no 0/O/1/l/I.
  const L = "abcdefghjkmnpqrstuvwxyz", U = "ABCDEFGHJKLMNPQRSTUVWXYZ", D = "23456789";
  const r = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  return `${r(U)}${r(L)}${r(L)}${r(L)}-${r(D)}${r(D)}${r(D)}${r(D)}-${r(U)}${r(L)}`;
}
const suggestUsername = (name) => {
  const parts = name.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0] + (parts[1] ? "." + parts[1][0] : "")).slice(0, 32);
};
const USER_RE = /^[a-z][a-z0-9._-]{2,31}$/;

function setupTeam() {
  $("pdTeam").hidden = false;
  const name = $("nuName"), user = $("nuUser"), pass = $("nuPass");
  let userEdited = false;
  name.addEventListener("input", () => { if (!userEdited) { user.value = suggestUsername(name.value); userState(); } });
  user.addEventListener("input", () => { userEdited = true; user.value = user.value.toLowerCase().replace(/\s/g, ""); userState(); });
  $("nuGen").addEventListener("click", () => { pass.value = makePassword(); pass.type = "text"; });
  $("nuShow").addEventListener("click", () => { pass.type = pass.type === "password" ? "text" : "password"; });
  $("pdNewUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("nuMsg");
    msg.textContent = "";
    const body = { name: name.value.trim(), username: user.value.trim(), password: pass.value };
    if (!body.name) { msg.textContent = "Enter the person's name"; name.focus(); return; }
    if (!USER_RE.test(body.username)) { msg.textContent = "Username: 3-32 characters, starting with a letter - letters, digits, . _ -"; user.focus(); return; }
    if (users.some((u) => u.username === body.username)) { msg.textContent = `"${body.username}" is already taken`; user.focus(); return; }
    if (body.password.length < 8) { msg.textContent = "Password: at least 8 characters (the wand makes one)"; pass.focus(); return; }
    const btn = $("nuCreate");
    btn.disabled = true;
    try {
      await api("/production-users", { method: "POST", body });
      $("pdNewUser").reset();
      userEdited = false;
      $("nuUserState").textContent = "";
      await loadUsers();
      showCredentials(body.name, body.username, body.password);   // the popup, on the new person
      toast(`${body.name} can sign in now`);
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function userState() {
    const s = $("nuUserState"), v = user.value;
    if (!v) { s.textContent = ""; s.className = ""; return; }
    if (!USER_RE.test(v)) { s.textContent = "3-32, a-z 0-9 . _ -"; s.className = "bad"; return; }
    const taken = users.some((u) => u.username === v);
    s.textContent = taken ? "taken" : "available";
    s.className = taken ? "bad" : "ok";
  }

  // Team popup
  const team = $("pdTeamModal");
  $("teamOpen").addEventListener("click", () => openTeam());
  $("teamClose").addEventListener("click", () => { team.hidden = true; });
  team.addEventListener("mousedown", (e) => { if (e.target === team) team.hidden = true; });
  $("teamSearch").addEventListener("input", renderUsers);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !team.hidden && $("pdPwModal").hidden) team.hidden = true; });

  // Change password
  let pwFor = null;
  const modal = $("pdPwModal");
  const closeModal = () => { modal.hidden = true; pwFor = null; };
  $("pwCancel").addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
  $("pwGen").addEventListener("click", () => { $("pwInput").value = makePassword(); });
  $("pwCopy").addEventListener("click", () => copy($("pwInput").value));
  $("pwSave").addEventListener("click", async () => {
    const pw = $("pwInput").value;
    if (pw.length < 8) { $("pwMsg").textContent = "At least 8 characters"; return; }
    try {
      await api(`/production-users/${encodeURIComponent(pwFor.username)}/password`, { method: "POST", body: { password: pw } });
      const u = pwFor;
      closeModal();
      await loadUsers();
      showCredentials(u.name, u.username, pw);
      toast(`New password set for ${u.name}`);
    } catch (err) {
      $("pwMsg").textContent = err.message;
    }
  });

  $("pdUsers").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const u = users.find((x) => x.username === b.dataset.user);
    if (!u) return;
    if (b.dataset.act === "copy") {
      const pw = freshCreds.get(u.username);
      navigator.clipboard?.writeText(signInText(u.username, pw)).then(
        () => toast(pw ? `Copied ${u.name}'s sign-in` : "Copied the link and username - the password can't be shown again: use Password to set a new one"),
        () => toast("Couldn't copy - select and copy by hand", "bad"));
    } else if (b.dataset.act === "password") {
      pwFor = u;
      $("pwWho").textContent = u.name;
      $("pwInput").value = makePassword();
      $("pwMsg").textContent = "";
      modal.hidden = false;
      $("pwInput").focus();
      $("pwInput").select();
    } else if (b.dataset.act === "active") {
      const on = !u.active;
      if (!on && !confirm(`Switch off ${u.name}? They are signed out at once and can't sign in until you switch them on again.`)) return;
      try {
        await api(`/production-users/${encodeURIComponent(u.username)}/active`, { method: "POST", body: { active: on } });
        toast(`${u.name} ${on ? "can sign in again" : "is switched off"}`);
        loadUsers();
      } catch (err) {
        toast(err.message, "bad");
      }
    }
  });
  loadUsers();
}

// Sign-in details of people created / given a new password on this page.
// Passwords are kept only as hashes on the server, so this is the only
// place they can be read back - until this page is closed.
const freshCreds = new Map();   // username -> password
const signInText = (u, pw) => `Farm Buddie Production sign-in\n${location.origin}/login.html\nUsername: ${u}` + (pw ? `\nPassword: ${pw}` : "");

function showCredentials(name, username, password) {
  freshCreds.set(username, password);
  openTeam(username);
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Couldn't copy - select and copy by hand", "bad"));
}

async function loadUsers() {
  try {
    users = (await api("/production-users")).users;
  } catch (err) {
    $("pdUsers").innerHTML = `<p class="pd-empty">${esc(err.message)}</p>`;
    return;
  }
  // the entries filter lists them too
  const sel = $("pdWho");
  const keep = sel.value;
  sel.innerHTML = `<option value="">Everyone</option><option value="${esc(me.username)}">Me (${esc(me.username)})</option>` +
    users.map((u) => `<option value="${esc(u.username)}">${esc(u.name)} (${esc(u.username)})</option>`).join("");
  sel.value = keep;
  renderTeamSummary();
  renderUsers();
}

// On the card: who's in the team at a glance + "View team"; the full list
// (with password / switch off) opens in a popup, so the page doesn't grow.
// The card only shows how many there are; the list is in the popup.
function renderTeamSummary() {
  const active = users.filter((u) => u.active).length;
  $("teamBadge").textContent = users.length;
  $("teamOpen").title = users.length ? `${users.length} member${users.length === 1 ? "" : "s"}, ${active} active` : "No team members yet";
}

function openTeam(highlight) {
  $("pdTeamModal").hidden = false;
  $("teamSearch").value = "";
  renderUsers(typeof highlight === "string" ? highlight : null);
  const row = typeof highlight === "string" && document.querySelector(`.pd-user[data-user="${CSS.escape(highlight)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" }); else $("teamSearch").focus();
}

function renderUsers(highlight = null) {
  const q = ($("teamSearch")?.value || "").trim().toLowerCase();
  const list = q ? users.filter((u) => `${u.name} ${u.username}`.toLowerCase().includes(q)) : users;
  $("teamCount").textContent = `${users.length}`;
  if (!list.length) {
    $("pdUsers").innerHTML = `<p class="pd-empty">${users.length ? "Nobody matches." : "No production team accounts yet."}</p>`;
    return;
  }
  $("pdUsers").innerHTML = list.map((u) => `
    <article class="pd-user${u.active ? "" : " off"}${u.username === highlight ? " pd-new" : ""}" data-user="${esc(u.username)}">
      <span class="pd-avatar">${esc((u.name || u.username).charAt(0).toUpperCase())}</span>
      <div class="pd-user-main"><b>${esc(u.name)}</b><span>@${esc(u.username)}${u.active ? "" : " · switched off"}</span></div>
      <div class="pd-user-stat"><b>${u.entries ?? "–"}<i>/</i>${u.nodeEntries ?? "–"}</b><small>controllers / nodes</small></div>
      <div class="pd-user-meta"><small>Last sign-in</small>${u.lastLoginAt ? `${fmtDate(u.lastLoginAt)}, ${fmtTime(u.lastLoginAt)}` : "never"}</div>
      <div class="pd-user-meta"><small>Created by</small>${esc(u.createdBy || "-")}</div>
      ${freshCreds.has(u.username) ? `<div class="pd-user-cred">${icon("key-round")}<span>Username <code>${esc(u.username)}</code></span><span>Password <code>${esc(freshCreds.get(u.username))}</code></span><small>shown until this page is closed</small></div>` : ""}
      <div class="pd-user-actions">
        <button type="button" class="pd-btn pd-btn-ghost" data-act="copy" data-user="${esc(u.username)}" title="Login link, username${freshCreds.has(u.username) ? " and password" : ""}">${icon("copy")}Copy sign-in</button>
        <button type="button" class="pd-btn pd-btn-ghost" data-act="password" data-user="${esc(u.username)}">${icon("key-round")}Password</button>
        <button type="button" class="pd-btn ${u.active ? "pd-btn-ghost" : "pd-btn-primary"}" data-act="active" data-user="${esc(u.username)}">${icon("power")}${u.active ? "Switch off" : "Switch on"}</button>
      </div>
    </article>`).join("");
}
