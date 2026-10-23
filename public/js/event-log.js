import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import { decodeRecord } from "/js/eventlog-decode.js";

// Admin > Event Log: a hub's EEPROM "black box" (Motor repo, event_log.h),
// read on request through the bridge (server/src/bridge/eventLog.js). The
// hub sends nothing on its own; the log is never cleared from here.

const PAGE_SIZE = 50;
const READ_PAGE = 40;

let fleet = [];
let current = null;     // { farmId, nodeId, farmerName }
let info = null;        // the hub's eventlog_info
let records = [];       // decoded, oldest first
let logPage = 1;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const istDate = (unix) => (unix ? new Date(unix * 1000 + 19800000).toISOString().slice(0, 10) : "-");
const istDateTime = (unix) => (unix ? new Date(unix * 1000 + 19800000).toISOString().slice(0, 16).replace("T", " ") : "-");
const hours = (sec) => Math.floor((sec || 0) / 3600).toLocaleString("en-IN");

async function api(path, options = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showPageError(msg) {
  $("pageError").textContent = msg || "";
  $("pageError").hidden = !msg;
}

// ---------------- hub picker ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }
  try {
    const d = await api("/fleet/status");
    fleet = (d.farms || []).filter((f) => f.farmId).map((f) => ({
      farmId: String(f.farmId),
      nodeId: f.nodeId || "MOTOR_1",
      farmerName: f.farmerName || "",
      online: !!f.online,
      serial: f.deviceStatus?.health?.serial || "",
      board: f.deviceStatus?.health?.board || "",
      fw: f.deviceStatus?.health?.fw_version || ""
    })).sort((a, b) => Number(a.farmId) - Number(b.farmId));
    renderFarmSelect();
    const want = new URLSearchParams(location.search).get("farm");
    if (want && fleet.some((f) => f.farmId === want)) {
      $("farmSelect").value = want;
      onFarmChosen();
    }
  } catch (e) {
    showPageError(`Couldn't load the farm list: ${e.message}`);
  }
});

$("logoutBtn")?.addEventListener("click", () => signOut(auth).then(() => window.location.replace("/login.html")));

function renderFarmSelect() {
  const q = $("farmSearch").value.trim().toLowerCase();
  const shown = fleet.filter((f) => !q || f.farmId.includes(q) || f.farmerName.toLowerCase().includes(q) ||
    f.serial.toLowerCase().includes(q));
  const keep = $("farmSelect").value;
  $("farmSelect").innerHTML = `<option value="">${shown.length ? "Choose a farm" : "No farm matches"}</option>` +
    shown.map((f) => `<option value="${esc(f.farmId)}">${esc(f.farmId)} - ${esc(f.farmerName || "?")}` +
      `${f.serial ? ` - ${esc(f.serial)}` : ""} ${f.online ? "● online" : "○ offline"}${f.board && f.board !== "v2-s3" ? " (V1 - no log)" : ""}</option>`).join("");
  if (shown.some((f) => f.farmId === keep)) $("farmSelect").value = keep;
  $("readCardBtn").disabled = !$("farmSelect").value;
}

function onFarmChosen() {
  const id = $("farmSelect").value;
  current = fleet.find((f) => f.farmId === id) || null;
  $("readCardBtn").disabled = !current;
  info = null;
  records = [];
  $("cardSection").hidden = true;
  $("logSection").hidden = true;
  showPageError("");
  if (current) history.replaceState(null, "", `?farm=${encodeURIComponent(current.farmId)}`);
}

$("farmSearch").addEventListener("input", renderFarmSelect);
$("farmSelect").addEventListener("change", onFarmChosen);
$("readCardBtn").addEventListener("click", readCard);

// ---------------- warranty card ----------------
const q = () => `node=${encodeURIComponent(current.nodeId)}`;

async function readCard() {
  if (!current) return;
  const btn = $("readCardBtn");
  btn.disabled = true;
  btn.textContent = "Asking the hub…";
  showPageError("");
  try {
    const d = await api(`/event-log/${current.farmId}/info?${q()}`);
    info = d.info || {};
    renderCard();
    $("cardSection").hidden = false;
    $("logSection").hidden = false;
    $("logMeta").textContent = info.log ? `${info.log.records} of ${info.log.capacity} held on the hub` : "";
  } catch (e) {
    showPageError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Read warranty card";
  }
}

function field(label, value, cls = "") {
  return `<div class="ev-field ${cls}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function renderCard() {
  const i = info;
  const c = i.counters || {};
  const days = i.install_date ? Math.max(0, Math.floor((Date.now() / 1000 - i.install_date) / 86400)) : null;
  const inService = days === null ? "-" : days < 60 ? `${days} day${days === 1 ? "" : "s"}`
    : `${Math.floor(days / 30.44)} months`;
  $("cardMeta").textContent = `farm ${current.farmId} - ${current.farmerName || ""}`;
  const fw = (i.fw || []).map((f, k) => `${esc(f.v)}${f.since ? ` <small>(${istDate(f.since)})</small>` : ""}${k === 0 ? " <small>now</small>" : ""}`).join("<br>");
  $("cardGrid").innerHTML = [
    field("Serial number", i.serial ? esc(i.serial) : `<em class="ev-warn">not set</em>`),
    field("Board", esc(i.board || "-")),
    field("Produced", istDate(i.mfg_date)),
    field("Factory test", i.mfg_test === "pass" ? "✔ Pass" : i.mfg_test === "fail" ? `<em class="ev-bad">✘ Fail</em>` : "-"),
    field("Installed", i.install_date ? `${istDate(i.install_date)} <small>(farm ${esc(i.install_farm)})</small>` : `<em class="ev-muted">not yet</em>`),
    field("In service", inService),
    field("Farm now", esc(i.farm || current.farmId) + (i.install_farm && i.farm && i.install_farm !== i.farm ? ` <em class="ev-warn">(moved)</em>` : "")),
    field("Firmware history", fw || "-"),
    field("VI calibration backup", i.cal_backup ? "✔ kept on the hub" : "-"),
    field("Counting since", istDate(c.first_seen))
  ].join("");
  $("serialForm").hidden = !!i.serial;

  const tile = (label, value, sub = "", cls = "") =>
    `<div class="ev-tile ${cls}"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
  $("counterTiles").innerHTML = [
    tile("Motor run", `${hours(c.run_sec)} h`, `${(c.starts || 0).toLocaleString("en-IN")} starts`),
    tile("Power cuts", (c.power_cuts || 0).toLocaleString("en-IN")),
    tile("Highest voltage", c.max_volt ? `${c.max_volt} V` : "-", "seen at any time", c.max_volt >= 480 ? "bad" : ""),
    tile("Lowest voltage", c.min_volt_run ? `${c.min_volt_run} V` : "-", "while running", c.min_volt_run && c.min_volt_run < 330 ? "warn" : ""),
    tile("Highest current", c.max_current ? `${Number(c.max_current).toFixed(1)} A` : "-", "while running"),
    tile("Hub restarts", (c.boots || 0).toLocaleString("en-IN"),
      `${c.watchdog_resets || 0} watchdog · ${c.brownouts || 0} brownout · ${c.crashes || 0} crash`,
      (c.watchdog_resets || 0) + (c.crashes || 0) > 10 ? "warn" : ""),
    tile("Updates", `${c.ota_ok || 0} ok`, `${c.ota_fail || 0} failed`, c.ota_fail ? "warn" : ""),
    tile("Cloud", `${c.net_outages || 0} drops`, `${hours(c.offline_sec)} h offline in total`),
    tile("Node offline", (c.node_offline || 0).toLocaleString("en-IN"), "events")
  ].join("");
  const f = c.faults || {};
  const faultTile = (label, n) => tile(label, (n || 0).toLocaleString("en-IN"), "", n ? "bad" : "ok");
  $("faultTiles").innerHTML = [
    faultTile("Dry run", f.dry_run), faultTile("Overload", f.overload), faultTile("Low voltage", f.low_voltage),
    faultTile("High voltage", f.high_voltage), faultTile("Phase loss", f.phase_loss),
    faultTile("Phase imbalance", f.phase_imbalance), faultTile("Stop not confirmed", f.stuck_contactor),
    faultTile("Restarted while running", f.restarted_while_running)
  ].join("");
}

$("serialSaveBtn").addEventListener("click", async () => {
  const serial = $("serialInput").value.trim().toUpperCase();
  if (!/^IRRIGO\d{2}[A-Z]{2}\d{5}$/.test(serial)) {
    showPageError("Serial format: IRRIGO + year (2 digits) + series (2 letters) + unit (5 digits), e.g. IRRIGO26AA10001");
    return;
  }
  if (!confirm(`Write serial ${serial} to farm ${current.farmId}'s hub?\n\nIt can't be changed from the web panel afterwards.`)) return;
  const btn = $("serialSaveBtn");
  btn.disabled = true;
  try {
    const d = await api(`/event-log/${current.farmId}/serial`, {
      method: "POST",
      body: JSON.stringify({ node: current.nodeId, serial, test: $("serialTest").value })
    });
    info = d.info || info;
    renderCard();
    showPageError("");
  } catch (e) {
    showPageError(e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- events ----------------
$("readLogBtn").addEventListener("click", readLog);

async function readLog() {
  if (!current) return;
  const btn = $("readLogBtn");
  btn.disabled = true;
  showPageError("");
  records = [];
  let from = 1;
  let total = info?.log?.records || 0;
  let retries = 0;
  try {
    for (let guard = 0; guard < 40; guard++) {
      $("logProgress").textContent = `Reading… ${records.length}${total ? ` of ${total}` : ""}`;
      let d;
      try {
        d = await api(`/event-log/${current.farmId}/records?${q()}&from=${from}&max=${READ_PAGE}`);
      } catch (e) {
        // Still loading after a restart, or one lost reply over GSM: retry a little.
        if ((e.status === 503 || e.status === 504) && retries < 3) { retries++; continue; }
        throw e;
      }
      retries = 0;
      total = d.records || total;
      for (const hex of d.rec || []) {
        const r = decodeRecord(hex);
        if (r) records.push(r);
      }
      if (!d.more || !d.next || d.next <= from) break;
      from = d.next;
    }
    records.sort((a, b) => a.seq - b.seq);
    $("logProgress").textContent = `${records.length} events read ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    showPageError(`${e.message}${records.length ? ` - showing the ${records.length} read so far` : ""}`);
    $("logProgress").textContent = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "Read again";
  }
  fillUnitFilter();
  logPage = 1;
  $("logFilters").hidden = records.length === 0;
  $("logTableWrap").hidden = records.length === 0;
  renderLog();
}

function fillUnitFilter() {
  const units = [...new Set(records.map((r) => r.unit))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  $("unitFilter").innerHTML = `<option value="">All units</option>` + units.map((u) => `<option>${esc(u)}</option>`).join("");
}

function filtered() {
  const kind = $("kindFilter").value;
  const unit = $("unitFilter").value;
  const s = $("logSearch").value.trim().toLowerCase();
  const list = records.filter((r) =>
    (!kind || (kind === "fault" ? r.fault : r.kind === kind)) &&
    (!unit || r.unit === unit) &&
    (!s || r.event.toLowerCase().includes(s) || r.details.toLowerCase().includes(s)));
  return $("newestFirst").checked ? list.slice().reverse() : list;
}

function renderLog() {
  const list = filtered();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (logPage > totalPages) logPage = totalPages;
  const rows = list.slice((logPage - 1) * PAGE_SIZE, logPage * PAGE_SIZE);
  $("logBody").innerHTML = rows.length ? rows.map((r) => `
    <tr class="${r.fault ? "ev-row-fault" : r.kind === "critical" ? "ev-row-critical" : ""}">
      <td>${r.seq}</td>
      <td class="ev-nowrap">${esc(r.time)}</td>
      <td class="ev-nowrap">${esc(r.unit)}</td>
      <td>${esc(r.event)}</td>
      <td>${esc(r.details)}</td>
      <td class="ev-nowrap ev-state">${[r.motorRunning ? "▶ running" : "", r.cloudOnline ? "" : "☁̸ offline"].filter(Boolean).join(" · ")}</td>
    </tr>`).join("") : `<tr><td colspan="6">No events match</td></tr>`;
  renderPager($("logPager"), logPage, totalPages, list.length, (p) => { logPage = p; renderLog(); });
}

function renderPager(el, page, totalPages, totalItems, onGo) {
  if (totalItems === 0) { el.innerHTML = ""; return; }
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalItems);
  el.innerHTML = `<span class="ota-muted">${from}-${to} of ${totalItems} events</span>
    <button data-go="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>
    ${pages.map((p) => p === "…" ? `<span class="ota-muted">…</span>`
      : `<button data-go="${p}" class="${p === page ? "active" : ""}">${p}</button>`).join("")}
    <button data-go="${page + 1}" ${page >= totalPages ? "disabled" : ""}>›</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("button[data-go]");
    if (b && !b.disabled) onGo(Number(b.dataset.go));
  };
}

for (const id of ["kindFilter", "unitFilter", "newestFirst"]) $(id).addEventListener("change", () => { logPage = 1; renderLog(); });
$("logSearch").addEventListener("input", () => { logPage = 1; renderLog(); });

// ---------------- export ----------------
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileStem = () => `${info?.serial || `farm${current.farmId}`}_${new Date().toISOString().slice(0, 10)}`;

$("csvBtn").addEventListener("click", () => {
  const cols = ["seq", "time", "unit", "event", "details", "kind", "motorRunning", "cloudOnline", "code", "value", "aux", "unix", "raw"];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [`# Farm ${current.farmId} - ${current.farmerName}; serial ${info?.serial || "-"}; times are IST`, cols.join(",")];
  for (const r of filtered()) lines.push(cols.map((c) => cell(r[c])).join(","));
  download(`${fileStem()}_events.csv`, "text/csv", lines.join("\r\n") + "\r\n");
});

$("jsonBtn").addEventListener("click", () => {
  download(`${fileStem()}_events.json`, "application/json",
    JSON.stringify({ farmId: current.farmId, farmer: current.farmerName, readAt: new Date().toISOString(), info, records }, null, 2));
});
