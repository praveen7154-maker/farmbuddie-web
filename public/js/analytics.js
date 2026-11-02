import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  startDataStore,
  warmDataStore,
  getFarmers,
  isLive,
  subscribe
} from "/js/data-store.js";

import { isDeviceOnline } from "/js/device-status-render.js";
import { fmtDateTime } from "/js/time-format.js";
import { icon, esc, renderPager, loadState, saveState, slashToSearch } from "/js/records-ui.js";

/* ================= AUTH ================= */
// Shares data-store.js's farmers listener (no listener of its own).
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }
  startDataStore(PAGE_DATA);
  render();
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= STATE ================= */
// Search, filters, sort and page are kept for this browser tab.
const STATE_KEY = "fb.analytics.v1";
const DEFAULTS = { q: "", device: "all", variant: "all", farm: "all", sort: "id", size: 20, page: 1, open: false };
const st = loadState(STATE_KEY, DEFAULTS);

const $ = (id) => document.getElementById(id);
const toDate = (v) => v?.toDate?.() || (v?.seconds ? new Date(v.seconds * 1000) : v ? new Date(v) : null);
const seenMs = (f) => toDate(f.deviceStatus?.lastSeen)?.getTime() || 0;
const hasDevice = (f) => !!f.controller?.uniqueId;
const deviceOf = (f) => (!hasDevice(f) ? "none" : isDeviceOnline(f.deviceStatus) ? "online" : "offline");
const farmNo = (f) => parseInt(String(f.farmNumber || "Farm 1").replace(/\D/g, ""), 10) || 1;
const VARIANT_NAMES = { IRRIGO: "Irrigo", IRRIGO_PLUS: "Irrigo Plus", IRRIGO_SMART_PLUS: "Irrigo Smart Plus" };
const placeOf = (f) => String(f.farmDetails?.location || f.address?.village || f.address?.district || "").trim();

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const GROUPS = [
  { key: "device", label: "Device", opts: [["all", "All"], ["online", "Online"], ["offline", "Offline"], ["none", "No device"]] },
  { key: "variant", label: "Variant", opts: [["all", "All"], ["IRRIGO", "Irrigo"], ["IRRIGO_PLUS", "Irrigo Plus"], ["IRRIGO_SMART_PLUS", "Irrigo Smart Plus"]] },
  { key: "farm", label: "Farm", opts: [["all", "All"], ["1", "Farm 1"], ["2+", "Farm 2 and more"]] }
];
const activeCount = () => GROUPS.filter((g) => st[g.key] !== "all").length;

const SORTS = {
  id: (a, b) => (a.farmBuddieId || "").localeCompare(b.farmBuddieId || "", undefined, { numeric: true }),
  seen: (a, b) => seenMs(b) - seenMs(a),
  quiet: (a, b) => (hasDevice(b) - hasDevice(a)) || seenMs(a) - seenMs(b),
  name: (a, b) => (a.name || "").localeCompare(b.name || "")
};

function matches(f, q) {
  if (st.device !== "all" && deviceOf(f) !== st.device) return false;
  if (st.variant !== "all" && f.controller?.variant !== st.variant) return false;
  if (st.farm === "1" && farmNo(f) !== 1) return false;
  if (st.farm === "2+" && farmNo(f) < 2) return false;
  if (!q) return true;
  return [f.farmBuddieId, f.controller?.uniqueId, f.controller?.serialNumber, f.name, f.primaryMobile, placeOf(f), f.farmNumber]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
}

/* ================= RENDER ================= */
let all = [];

function renderFilters() {
  $("anFilters").innerHTML = GROUPS.map((g) => `
    <div class="rx-fgroup"><span>${g.label}</span><div class="rx-chips">
      ${g.opts.map(([v, l]) => `<button type="button" class="rx-chip${st[g.key] === v ? " on" : ""}" data-f="${g.key}" data-v="${v}" aria-pressed="${st[g.key] === v}">${l}</button>`).join("")}
    </div></div>`).join("");
  $("anFilters").hidden = !st.open;
  $("anFilterBtn").classList.toggle("on", st.open);
  $("anFilterBtn").setAttribute("aria-expanded", String(st.open));
  const n = activeCount();
  $("anFilterCount").hidden = !n;
  $("anFilterCount").textContent = n;
  const pills = GROUPS.filter((g) => st[g.key] !== "all").map((g) =>
    `<button type="button" class="rx-pill-x" data-clear="${g.key}" title="Remove this filter">${esc(g.label)}: ${esc(g.opts.find(([v]) => v === st[g.key])?.[1] || "")}${icon("x")}</button>`);
  if (st.q) pills.push(`<button type="button" class="rx-pill-x" data-clear="q">“${esc(st.q)}”${icon("x")}</button>`);
  $("anActive").innerHTML = pills.length ? pills.join("") + `<button type="button" class="rx-clear" data-clear="all">Clear all</button>` : "";
}

function renderStats() {
  const n = (d) => all.filter((f) => deviceOf(f) === d).length;
  const withDev = all.filter(hasDevice).length;
  const on = n("online");
  const tile = (label, v, tone, set, active) =>
    `<button type="button" class="rx-stat${active ? " on" : ""}" data-tone="${tone}" data-stat='${JSON.stringify(set)}'><small>${label}</small><b>${v}</b></button>`;
  $("anStats").innerHTML =
    tile("Farms", all.length, "", { device: "all" }, false) +
    tile("Online", on, "green", { device: "online" }, st.device === "online") +
    tile("Offline", n("offline"), "red", { device: "offline" }, st.device === "offline") +
    tile("No device", n("none"), "", { device: "none" }, st.device === "none") +
    tile("Online now", withDev ? `${Math.round((on / withDev) * 100)}%` : "-", "blue", { device: "online" }, false);
}

function row(f, i) {
  const d = deviceOf(f);
  const tone = d === "online" ? "green" : d === "offline" ? "red" : "grey";
  const seen = seenMs(f);
  return `<article class="rx-row" data-tone="${d === "online" ? "green" : "grey"}" style="animation-delay:${Math.min(i, 12) * 18}ms">
    <div class="rx-id"><b>${esc(f.farmBuddieId || "-")}</b><span class="rx-tag">${esc(f.farmNumber || "Farm 1")}</span></div>
    <div class="rx-main">
      <div class="rx-name">${esc(f.name || "-")}<em>${esc(placeOf(f))}</em></div>
      <div><small>Device</small>${hasDevice(f)
        ? `<span class="rx-mono">${esc(f.controller.uniqueId)}</span> <span style="color:var(--fbx-faint)">${esc(VARIANT_NAMES[f.controller.variant] || f.controller.variant || "")}</span>`
        : `<span style="color:var(--fbx-faint)">No device</span>`}</div>
      <div><small>Status</small>${d === "none" ? `<span style="color:var(--fbx-faint)">-</span>` : `<span class="rx-dot ${d === "online" ? "on" : "off"}"></span> <span class="rx-tag" data-tone="${tone}">${d === "online" ? "Online" : "Offline"}</span>`}</div>
      <div class="rx-wide-only"><small>Last seen</small>${hasDevice(f) ? `${esc(ago(seen))}${seen ? `<br><span style="color:var(--fbx-faint)">${esc(fmtDateTime(new Date(seen)))}</span>` : ""}` : "-"}</div>
    </div>
    <div class="rx-side"><div class="rx-actions">
      <a class="rx-icon" href="/admin/device-view.html?id=${encodeURIComponent(f.id)}" title="Open device" aria-label="Open device of ${esc(f.farmBuddieId || "")}">${icon("eye")}</a>
    </div></div>
  </article>`;
}

function render() {
  saveState(STATE_KEY, st);
  all = getFarmers();
  if (!all.length && !isLive("farmers")) return;      // still loading - the skeletons stay
  const q = st.q.trim().toLowerCase();
  const shown = all.filter((f) => matches(f, q)).sort(SORTS[st.sort] || SORTS.id);
  const size = Number(st.size) || 20;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  st.page = Math.min(Math.max(1, st.page), pages);
  const from = (st.page - 1) * size;
  const list = shown.slice(from, from + size);

  renderStats();
  renderFilters();
  $("anCount").textContent = !all.length ? "" :
    `${shown.length} of ${all.length} farm${all.length === 1 ? "" : "s"}` + (shown.length ? ` · showing ${from + 1}-${from + list.length}` : "");
  $("anList").innerHTML = list.length ? list.map(row).join("") :
    `<div class="rx-empty">${icon("inbox")}<p>${all.length ? "No devices match these filters." : "No farms yet."}</p>${activeCount() || st.q ? `<button type="button" class="rx-btn" data-clear="all">Clear filters</button>` : ""}</div>`;
  renderPager($("anPager"), st.page, pages);
}

/* ================= CONTROLS ================= */
document.querySelectorAll("[data-rx-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.rxIcon); });
const searchBox = $("searchInput");
searchBox.value = st.q;
$("anSort").value = st.sort;
$("anSize").value = String(st.size);
slashToSearch(searchBox);
let typing = 0;
searchBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { st.q = searchBox.value; st.page = 1; render(); }, 120);
});
$("anSort").addEventListener("change", (e) => { st.sort = e.target.value; st.page = 1; render(); });
$("anSize").addEventListener("change", (e) => { st.size = Number(e.target.value) || 20; st.page = 1; render(); });
$("anFilterBtn").addEventListener("click", () => { st.open = !st.open; renderFilters(); saveState(STATE_KEY, st); });

function clearFilter(key) {
  if (key === "all") { Object.assign(st, { ...DEFAULTS, sort: st.sort, size: st.size, open: st.open }); searchBox.value = ""; }
  else if (key === "q") { st.q = ""; searchBox.value = ""; }
  else st[key] = "all";
  st.page = 1;
  render();
}

$("anPage").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-f]");
  if (chip) { st[chip.dataset.f] = chip.dataset.v; st.page = 1; return render(); }
  const clr = e.target.closest("[data-clear]");
  if (clr) return clearFilter(clr.dataset.clear);
  const stat = e.target.closest("[data-stat]");
  if (stat) {
    const set = JSON.parse(stat.dataset.stat);
    const already = stat.classList.contains("on");
    Object.assign(st, already ? Object.fromEntries(Object.keys(set).map((k) => [k, "all"])) : set);
    st.page = 1;
    return render();
  }
  const pg = e.target.closest("button[data-page]");
  if (pg && !pg.disabled) {
    st.page = Number(pg.dataset.page);
    render();
    $("anCount").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

// "Online" goes stale on its own (no report for 25 min) - recheck each minute.
setInterval(render, 60000);

/* ================= INSTANT FIRST PAINT ================= */
const PAGE_DATA = ["farmers"];
subscribe(render);
warmDataStore(PAGE_DATA);
