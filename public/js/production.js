// Production (admin panel > Production) - daily entry of new MCU controllers,
// for the production team and admins. The server does the real work and
// every check (server/src/bridge/production.js): same records and same
// "nothing used twice" rules as the MCU / Controller page's Excel upload,
// plus who entered each one. Admins also manage the team's accounts here.
import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import { staffSession, clearStaffSession } from "/js/production-session.js";
import { fmtTime, fmtDate } from "/js/time-format.js";

const shell = window.FBShell;
const icon = shell.icon;
const esc = shell.esc;
const $ = (id) => document.getElementById(id);
const FIELDS = ["serialNumber", "uniqueId", "imeiNumber", "simMsisdn", "simNumber", "simImsi"];
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
  $("pdHello").textContent = admin
    ? "Enter controllers yourself, or manage the production team below."
    : `Hello ${me.name} - scan or type each new controller. Every field is checked as you go.`;
  $("pdListName").textContent = admin ? "Entries" : "My entries";
  $("pd").removeAttribute("aria-busy");
  setupVariants();
  setupForm();
  setupList(admin);
  if (admin) setupTeam();
  await Promise.all([loadSummary(), loadEntries()]);
  focusFirst();
}

// ---------------------------------------------------------------- summary
let nextUniqueId = null;
async function loadSummary() {
  try {
    const s = await api("/production/summary");
    countTo($("pdMine"), s.mineToday);
    countTo($("pdTeamToday"), s.teamToday);
    countTo($("pdMineTotal"), s.mineTotal);
    drawSpark(s.days);
    $("pdVariantsToday").innerHTML = Object.entries(s.byVariant)
      .map(([v, n]) => `<span class="pd-vchip" data-tone="${toneOf(v)}"><i></i>${esc(VARIANT_NAMES[v] || v)} <b>${n}</b></span>`).join("");
    nextUniqueId = s.nextUniqueId;
    const b = $("pdNextId");
    b.hidden = !nextUniqueId;
    b.textContent = nextUniqueId ? `Next free: ${nextUniqueId}` : "";
  } catch (err) {
    console.warn("summary:", err);
  }
}
const toneOf = (v) => ({ IRRIGO: "green", IRRIGO_PLUS: "sky", IRRIGO_SMART_PLUS: "violet" }[v] || "teal");

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
  document.querySelectorAll("#pdVariants [data-variant]").forEach((b) => b.addEventListener("click", () => { pick(b.dataset.variant); focusFirst(); }));
  if (saved && VARIANT_NAMES[saved]) pick(saved);
}

// ---------------------------------------------------------------- the form
const inputs = () => FIELDS.map((f) => $("pdForm").elements[f]);
const values = () => Object.fromEntries([["variant", variant], ...FIELDS.map((f) => [f, $("pdForm").elements[f].value])]);
let touched = new Set();
let lastCheck = null;
let checkTimer = null;
let checkSeq = 0;
let saving = false;

function focusFirst() {
  const first = inputs().find((i) => !i.value) || inputs()[0];
  first.focus();
}

function setupForm() {
  inputs().forEach((input, i) => {
    input.addEventListener("input", () => {
      if (input.name === "uniqueId" || input.inputMode === "numeric") input.value = input.value.replace(/[^\d]/g, "");
      touched.add(input.name);
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
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && document.activeElement?.closest("#pdForm, #pdVariants")) { e.preventDefault(); save(); }
  });
  $("pdSave").addEventListener("click", save);
  $("pdClear").addEventListener("click", () => resetForm(true));
  $("pdNextId").addEventListener("click", (e) => {
    e.preventDefault();
    const u = $("pdForm").elements.uniqueId;
    u.value = nextUniqueId;
    touched.add("uniqueId");
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
  const c = lastCheck || { problems: {}, clashes: [] };
  const clashBy = Object.fromEntries((c.clashes || []).map((x) => [x.field, x]));
  for (const f of FIELDS) {
    const el = document.querySelector(`.pd-field[data-field="${f}"]`);
    const input = $("pdForm").elements[f];
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
    }
    el.dataset.state = state;
    msg.textContent = text;
  }
  if (showAll && !variant) $("pdVariantMsg").textContent = "Choose the variant";
}

async function save() {
  if (saving) return;
  if (!variant) { render(true); $("pdVariants").querySelector("button").focus(); return; }
  saving = true;
  const btn = $("pdSave");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const r = await api("/production/controllers", { method: "POST", body: values() });
    celebrate();
    toast(`Controller ${r.controller.uniqueId} saved`);
    if (currentDay === istToday()) {
      entries.unshift(r.controller);
      renderEntries(r.controller.id);
    }
    resetForm(false);
    loadSummary();
  } catch (err) {
    if (err.data?.problems || err.data?.clashes) {
      lastCheck = { problems: err.data.problems || {}, clashes: err.data.clashes || [], values: lastCheck?.values };
      FIELDS.forEach((f) => touched.add(f));
      render(true);
      const firstBad = FIELDS.find((f) => document.querySelector(`.pd-field[data-field="${f}"]`).dataset.state === "bad" ||
        document.querySelector(`.pd-field[data-field="${f}"]`).dataset.state === "clash");
      if (firstBad) $("pdForm").elements[firstBad].focus();
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
  touched = new Set();
  lastCheck = null;
  render();
  if (keepFocus !== null) $("pdForm").elements.serialNumber.focus();
}

function celebrate() {
  const card = document.querySelector(".pd-entry");
  card.classList.remove("pd-saved"); void card.offsetWidth; card.classList.add("pd-saved");
}

// ---------------------------------------------------------------- entries
let entries = [];
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
  try {
    const q = new URLSearchParams({ day: currentDay, ...(who ? { by: who } : {}) });
    const r = await api(`/production/entries?${q}`);
    entries = r.entries;
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
  return entries.filter((e) => [e.serialNumber, e.uniqueId, e.imeiNumber, e.simMsisdn, e.simNumber, e.simImsi, e.createdBy?.name, e.createdBy?.id]
    .some((v) => String(v || "").toLowerCase().includes(q)));
}

function renderEntries(newId) {
  const list = shown();
  const admin = me.role === "admin";
  const today = currentDay === istToday();
  $("pdCount").textContent = `${fmtDate(currentDay + "T12:00:00+05:30")}${today ? " · today" : ""} · ${entries.length} controller${entries.length === 1 ? "" : "s"}` +
    (list.length !== entries.length ? ` · ${list.length} shown` : "");
  if (!list.length) {
    $("pdEntries").innerHTML = `<div class="pd-empty">${icon("factory")}<p>${entries.length ? "Nothing matches the search." : today ? "No controllers yet today - the first one you add shows up here." : "No controllers on this day."}</p></div>`;
    return;
  }
  $("pdEntries").innerHTML = list.map((e) => {
    const by = e.createdBy ? `${e.createdBy.type === "admin" ? "Admin" : esc(e.createdBy.name || e.createdBy.id)}` : (e.source === "production" ? "-" : "Excel upload");
    return `<article class="pd-entry-row${e.id === newId ? " pd-new" : ""}" data-tone="${toneOf(e.variant)}">
      <div class="pd-entry-id"><b>${esc(e.uniqueId)}</b><span>${esc(VARIANT_NAMES[e.variant] || e.variant || "")}</span></div>
      <div class="pd-entry-main">
        <div><small>Serial</small>${esc(e.serialNumber)}</div>
        <div><small>IMEI</small>${esc(e.imeiNumber)}</div>
        <div><small>SIM</small>${esc(e.simNumber || "-")}${e.simMsisdn ? ` · ${esc(e.simMsisdn)}` : ""}</div>
      </div>
      <div class="pd-entry-meta"><span>${e.createdAtMs ? fmtTime(e.createdAtMs) : ""}</span>${admin ? `<small>${by}</small>` : ""}</div>
    </article>`;
  }).join("");
}

async function exportExcel() {
  const list = shown();
  if (!list.length) { toast("Nothing to export for this day", "bad"); return; }
  try {
    const XLSX = await window.loadXlsx();
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
      showCredentials(body.name, body.username, body.password);
      $("pdNewUser").reset();
      userEdited = false;
      $("nuUserState").textContent = "";
      await loadUsers();
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
      showCredentials(u.name, u.username, pw);
      toast(`New password set for ${u.name}`);
      loadUsers();
    } catch (err) {
      $("pwMsg").textContent = err.message;
    }
  });

  $("pdUsers").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const u = users.find((x) => x.username === b.dataset.user);
    if (!u) return;
    if (b.dataset.act === "password") {
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

function showCredentials(name, username, password) {
  const box = $("pdCredentials");
  box.hidden = false;
  box.innerHTML = `${icon("key-round")}<div><b>Give these to ${esc(name)}</b>
    <p>Sign in at <code>${esc(location.origin)}/login.html</code> with</p>
    <p class="pd-cred"><span>Username <code>${esc(username)}</code></span><span>Password <code>${esc(password)}</code></span></p>
    <small>Shown only now - it isn't stored anywhere readable. You can always set a new one.</small></div>
    <button type="button" class="pd-btn pd-btn-ghost" id="credCopy">${icon("copy")}Copy</button>
    <button type="button" class="pd-icon-btn" id="credClose" aria-label="Close">${icon("x")}</button>`;
  $("credCopy").addEventListener("click", () => copy(`Farm Buddie Production sign-in\n${location.origin}/login.html\nUsername: ${username}\nPassword: ${password}`));
  $("credClose").addEventListener("click", () => { box.hidden = true; box.innerHTML = ""; });
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
  if (!users.length) {
    $("pdUsers").innerHTML = `<p class="pd-empty">No production team accounts yet - create the first one above.</p>`;
    return;
  }
  $("pdUsers").innerHTML = users.map((u) => `
    <article class="pd-user${u.active ? "" : " off"}">
      <span class="pd-avatar">${esc((u.name || u.username).charAt(0).toUpperCase())}</span>
      <div class="pd-user-main"><b>${esc(u.name)}</b><span>@${esc(u.username)}${u.active ? "" : " · switched off"}</span></div>
      <div class="pd-user-stat"><b>${u.entries ?? "–"}</b><small>controllers</small></div>
      <div class="pd-user-meta"><small>Last sign-in</small>${u.lastLoginAt ? `${fmtDate(u.lastLoginAt)}, ${fmtTime(u.lastLoginAt)}` : "never"}</div>
      <div class="pd-user-meta"><small>Created by</small>${esc(u.createdBy || "-")}</div>
      <div class="pd-user-actions">
        <button type="button" class="pd-btn pd-btn-ghost" data-act="password" data-user="${esc(u.username)}">${icon("key-round")}Password</button>
        <button type="button" class="pd-btn ${u.active ? "pd-btn-ghost" : "pd-btn-primary"}" data-act="active" data-user="${esc(u.username)}">${icon("power")}${u.active ? "Switch off" : "Switch on"}</button>
      </div>
    </article>`).join("");
}
