import { auth, db } from "/js/firebase-init.js";
import { valveConfigExportColumns } from "/js/valve-config.js";
import { saveNodeMapping, nodeMappingExportText } from "/js/node-mapping.js";
import { isDeviceOnline } from "/js/device-status-render.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  doc,
  updateDoc,
  deleteDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";


import {
  fullPhoneSync
} from "/js/phone-auth.js";

import {
  startDataStore,
  warmDataStore,
  getFarmers,
  getControllers,
  getDistributors,
  isLive,
  subscribe
} from "/js/data-store.js";
import { icon, esc, renderPager, loadState, saveState, toast, slashToSearch } from "/js/records-ui.js";
import { fmtDateTime } from "/js/time-format.js";

/* ================= AUTH GUARD ================= */
// Used to run its own one-shot getDocs() over the whole farmers collection
// every page load, with a hand-rolled sessionStorage cache on top (and
// several manual "update the cache after this write" blocks scattered
// through the file below, easy to get out of sync). Shares data-store.js's
// realtime listener instead, same as index.js/analytics.js/
// distributor-database.js - it's always live, so none of that manual
// cache-juggling is needed anymore.
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  startDataStore(PAGE_DATA);
  onStoreUpdate();
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= LIST STATE ================= */
// Search, filters, sort and page - kept for this browser tab, so back from
// View / Edit the list is where it was (records-ui.js).
const STATE_KEY = "fb.farmerDb.v1";
const DEFAULTS = { q: "", status: "all", farm: "all", lead: "all", dist: "", device: "all", access: "all", sim: false, sort: "id", size: 20, page: 1, open: false };
const st = loadState(STATE_KEY, DEFAULTS);

// Links from the dashboard (?filter=active|inactive|sim-expiry) and from the
// Distributor Database (?distributor=ID) start from a clean list.
const params = new URLSearchParams(window.location.search);
if (params.has("filter") || params.has("distributor")) {
  Object.assign(st, DEFAULTS);
  const f = params.get("filter");
  if (f === "active" || f === "inactive") st.status = f;
  if (f === "sim-expiry") st.sim = true;
  const d = params.get("distributor");
  if (d) { st.lead = "distributor"; st.dist = d; }
}

let allFarmers = [];
let shownFarmers = [];   // after search + filters + sort (Excel exports these)

const $ = (id) => document.getElementById(id);
const ms = (t) => (t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : (Date.parse(t) || 0));
const farmNo = (f) => parseInt(String(f.farmNumber || "Farm 1").replace(/\D/g, ""), 10) || 1;
const isActive = (f) => f.status !== "inactive";
const deviceOf = (f) => (!f.controller?.uniqueId ? "none" : isDeviceOnline(f.deviceStatus) ? "online" : "offline");
const accessOn = (f) => f.phoneAuth?.enabled ?? false;
function simExpiring(f) {
  if (!f.sim?.activationDate) return false;
  const end = new Date(f.sim.activationDate);
  if (isNaN(end)) return false;
  end.setFullYear(end.getFullYear() + 1);
  const today = new Date();
  const limit = new Date();
  limit.setDate(today.getDate() + 30);
  return end >= today && end <= limit;
}
const distName = (id) => {
  const d = getDistributors().find((x) => (x.distributorId || x.id) === id);
  return d ? (d.companyName || d.name || id) : id;
};

/* ================= STORE UPDATE ================= */
function onStoreUpdate() {
  allFarmers = getFarmers().slice();
  render();
}

/* ================= FILTERS ================= */
const GROUPS = [
  { key: "status", label: "Status", opts: [["all", "All"], ["active", "Active"], ["inactive", "Inactive"]] },
  { key: "farm", label: "Farm", opts: [["all", "All"], ["1", "Farm 1"], ["2", "Farm 2+"]] },
  { key: "lead", label: "Lead source", opts: [["all", "All"], ["direct", "Farm Buddie"], ["distributor", "Distributor"]] },
  { key: "device", label: "Device", opts: [["all", "All"], ["online", "Online"], ["offline", "Offline"], ["none", "No device"]] },
  { key: "access", label: "App access", opts: [["all", "All"], ["on", "Allowed"], ["off", "Blocked"]] }
];

function matches(f, q) {
  if (st.status !== "all" && (st.status === "active") !== isActive(f)) return false;
  if (st.farm === "1" && farmNo(f) !== 1) return false;
  if (st.farm === "2" && farmNo(f) < 2) return false;
  const viaDist = String(f.leadSource?.type || "").toUpperCase() === "DISTRIBUTOR";
  if (st.lead === "direct" && viaDist) return false;
  if (st.lead === "distributor" && !viaDist) return false;
  if (st.lead === "distributor" && st.dist && f.leadSource?.distributorId !== st.dist) return false;
  if (st.device !== "all" && deviceOf(f) !== st.device) return false;
  if (st.access === "on" && !accessOn(f)) return false;
  if (st.access === "off" && accessOn(f)) return false;
  if (st.sim && !simExpiring(f)) return false;
  if (!q) return true;
  return [f.farmBuddieId, f.name, f.primaryMobile, f.secondaryMobile, f.controller?.uniqueId, f.controller?.serialNumber,
    f.leadSource?.distributorId, f.leadSource?.distributorName, f.farmDetails?.location, f.farmNumber,
    ...(Array.isArray(f.appUsers) ? f.appUsers.flatMap((u) => [u?.name, u?.mobile]) : [])]
    .some((v) => String(v || "").toLowerCase().includes(q));
}

const SORTS = {
  id: (a, b) => (a.farmBuddieId || "").localeCompare(b.farmBuddieId || "", undefined, { numeric: true }),
  name: (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }) || SORTS.id(a, b),
  newest: (a, b) => ms(b.createdAt) - ms(a.createdAt) || SORTS.id(a, b),
  oldest: (a, b) => ms(a.createdAt) - ms(b.createdAt) || SORTS.id(a, b)
};

function activeCount() {
  return GROUPS.filter((g) => st[g.key] !== "all").length + (st.sim ? 1 : 0);
}

function renderFilters() {
  const dists = getDistributors().slice().sort((a, b) => (a.distributorId || "").localeCompare(b.distributorId || "", undefined, { numeric: true }));
  $("fdFilters").innerHTML = GROUPS.map((g) => `
    <div class="rx-fgroup"><span>${g.label}</span><div class="rx-chips">
      ${g.opts.map(([v, l]) => `<button type="button" class="rx-chip${st[g.key] === v ? " on" : ""}" data-f="${g.key}" data-v="${v}" aria-pressed="${st[g.key] === v}">${l}</button>`).join("")}
    </div>${g.key === "lead" && st.lead === "distributor" ? `
      <select id="fdDist" aria-label="Which distributor">
        <option value="">Any distributor</option>
        ${dists.map((d) => { const id = d.distributorId || d.id; return `<option value="${esc(id)}"${st.dist === id ? " selected" : ""}>${esc(d.companyName || d.name || id)} (${esc(id)})</option>`; }).join("")}
      </select>` : ""}</div>`).join("") + `
    <div class="rx-fgroup"><span>SIM / AMC</span><div class="rx-chips">
      <button type="button" class="rx-chip${st.sim ? " on" : ""}" data-f="sim" aria-pressed="${st.sim}">Renewal due in 30 days</button>
    </div></div>`;
  $("fdFilters").hidden = !st.open;
  $("fdFilterBtn").classList.toggle("on", st.open);
  $("fdFilterBtn").setAttribute("aria-expanded", String(st.open));
  const n = activeCount();
  $("fdFilterCount").hidden = !n;
  $("fdFilterCount").textContent = n;

  // What's applied, each removable.
  const pills = [];
  GROUPS.forEach((g) => {
    if (st[g.key] === "all") return;
    let text = `${g.label}: ${g.opts.find(([v]) => v === st[g.key])?.[1] || st[g.key]}`;
    if (g.key === "lead" && st.dist) text += ` · ${distName(st.dist)}`;
    pills.push(`<button type="button" class="rx-pill-x" data-clear="${g.key}" title="Remove this filter">${esc(text)}${icon("x")}</button>`);
  });
  if (st.sim) pills.push(`<button type="button" class="rx-pill-x" data-clear="sim">SIM renewal due${icon("x")}</button>`);
  if (st.q) pills.push(`<button type="button" class="rx-pill-x" data-clear="q">“${esc(st.q)}”${icon("x")}</button>`);
  $("fdActive").innerHTML = pills.length ? pills.join("") + `<button type="button" class="rx-clear" data-clear="all">Clear all</button>` : "";
}

function renderStats() {
  const persons = new Set(allFarmers.map((f) => f.identityId || f.aadhaarNumber || f.id)).size;
  const active = allFarmers.filter(isActive).length;
  const online = allFarmers.filter((f) => deviceOf(f) === "online").length;
  const tile = (label, n, tone, set, on) =>
    `<button type="button" class="rx-stat${on ? " on" : ""}" data-tone="${tone}" data-stat='${JSON.stringify(set)}'><small>${label}</small><b>${n}</b></button>`;
  $("fdStats").innerHTML =
    tile("Farms", allFarmers.length, "", { status: "all", device: "all" }, false) +
    tile("Farmers", persons, "blue", { status: "all", device: "all" }, false) +
    tile("Active", active, "green", { status: "active" }, st.status === "active") +
    tile("Inactive", allFarmers.length - active, "red", { status: "inactive" }, st.status === "inactive") +
    tile("Online", online, "green", { device: "online" }, st.device === "online");
}

function row(f, i) {
  const active = isActive(f);
  const n = farmNo(f);
  const dev = deviceOf(f);
  const viaDist = String(f.leadSource?.type || "").toUpperCase() === "DISTRIBUTOR";
  const lead = viaDist
    ? `${esc(f.leadSource?.distributorName || distName(f.leadSource?.distributorId) || "Distributor")}${f.leadSource?.distributorId ? `<span class="rx-sub rx-mono">${esc(f.leadSource.distributorId)}</span>` : ""}`
    : "Farm Buddie";
  const on = accessOn(f);
  const team = !!window.FBShell?.team;
  return `<article class="rx-row" data-tone="${active ? "green" : "grey"}" style="animation-delay:${Math.min(i, 12) * 18}ms">
    <div class="rx-id"><b>${esc(f.farmBuddieId || "-")}</b><span class="rx-tag" data-tone="${n === 1 ? "green" : "blue"}">${esc(f.farmNumber || "Farm 1")}</span></div>
    <div class="rx-main">
      <div class="rx-name">${esc(f.name || "-")}<em>${esc(f.farmDetails?.location || f.address || "")}</em></div>
      <div><small>Mobile</small><span class="rx-mono">${esc(f.primaryMobile || "-")}</span></div>
      <div><small>Device</small>${dev === "none" ? `<span class="rx-dot"></span>No device` : `<span class="rx-dot ${dev === "online" ? "on" : "off"}"></span><span class="rx-mono">${esc(f.controller.uniqueId)}</span> · ${dev === "online" ? "Online" : "Offline"}`}</div>
      <div class="rx-wide-only"><small>Lead source</small>${lead}</div>
    </div>
    <div class="rx-side">
      <span class="rx-tag" data-tone="${active ? "green" : "red"}">${active ? "Active" : "Inactive"}</span>
      <div class="rx-actions">
        <button type="button" class="rx-icon" data-act="view" data-id="${esc(f.id)}" title="View" aria-label="View ${esc(f.farmBuddieId)}">${icon("eye")}</button>
        <button type="button" class="rx-icon" data-act="edit" data-id="${esc(f.id)}" title="${active ? "Edit" : "Activate the farm to edit it"}" aria-label="Edit ${esc(f.farmBuddieId)}"${active ? "" : " disabled"}>${icon("pencil")}</button>
        <button type="button" class="rx-icon ${active ? "" : "ok"}" data-act="toggle" data-id="${esc(f.id)}" data-status="${esc(f.status || "")}" title="${active ? "Deactivate" : "Activate"}" aria-label="${active ? "Deactivate" : "Activate"} ${esc(f.farmBuddieId)}">${icon("power")}</button>
        <button type="button" class="rx-icon ${on ? "ok" : "bad"}" data-act="phone" data-id="${esc(f.id)}" title="App access: ${on ? "allowed" : "blocked"}" aria-label="Phone authorization for ${esc(f.farmBuddieId)}">${icon("phone")}</button>
        ${team ? "" : `<button type="button" class="rx-icon danger" data-act="delete" data-id="${esc(f.id)}" title="Delete" aria-label="Delete ${esc(f.farmBuddieId)}">${icon("trash")}</button>`}
      </div>
    </div>
  </article>`;
}

/* ================= RENDER ================= */
function render() {
  saveState(STATE_KEY, st);
  if (!allFarmers.length && !isLive("farmers")) return;   // still loading - the skeletons stay
  const q = st.q.trim().toLowerCase();
  shownFarmers = allFarmers.filter((f) => matches(f, q)).sort(SORTS[st.sort] || SORTS.id);
  const size = Number(st.size) || 20;
  const pages = Math.max(1, Math.ceil(shownFarmers.length / size));
  if (st.page > pages) st.page = pages;
  if (st.page < 1) st.page = 1;
  const from = (st.page - 1) * size;
  const list = shownFarmers.slice(from, from + size);

  renderStats();
  renderFilters();
  $("fdCount").textContent = !allFarmers.length ? "" :
    `${shownFarmers.length} of ${allFarmers.length} farm${allFarmers.length === 1 ? "" : "s"}` +
    (shownFarmers.length ? ` · showing ${from + 1}-${from + list.length}` : "");
  $("fdList").innerHTML = list.length ? list.map(row).join("") :
    `<div class="rx-empty">${icon("inbox")}<p>${allFarmers.length ? "No farmers match these filters." : "No farmers yet."}</p>${activeCount() || st.q ? `<button type="button" class="rx-btn" data-clear="all">Clear filters</button>` : ""}</div>`;
  renderPager($("fdPager"), st.page, pages);
}

/* ================= CONTROLS ================= */
document.querySelectorAll("[data-rx-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.rxIcon); });
const searchBox = $("searchInput");
searchBox.value = st.q;
$("fdSort").value = st.sort;
$("fdSize").value = String(st.size);
slashToSearch(searchBox);

let typing = 0;
searchBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { st.q = searchBox.value; st.page = 1; render(); }, 120);
});
$("fdSort").addEventListener("change", (e) => { st.sort = e.target.value; st.page = 1; render(); });
$("fdSize").addEventListener("change", (e) => { st.size = Number(e.target.value) || 20; st.page = 1; render(); });
$("fdFilterBtn").addEventListener("click", () => { st.open = !st.open; renderFilters(); saveState(STATE_KEY, st); });
$("fdExcel").addEventListener("click", () => window.downloadAllFarmersExcel());

function clearFilter(key) {
  if (key === "all") { Object.assign(st, { ...DEFAULTS, sort: st.sort, size: st.size, open: st.open }); searchBox.value = ""; }
  else if (key === "q") { st.q = ""; searchBox.value = ""; }
  else if (key === "sim") st.sim = false;
  else { st[key] = "all"; if (key === "lead") st.dist = ""; }
  st.page = 1;
  render();
}

$("fdPage").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-f]");
  if (chip) {
    if (chip.dataset.f === "sim") st.sim = !st.sim;
    else { st[chip.dataset.f] = chip.dataset.v; if (chip.dataset.f === "lead" && chip.dataset.v !== "distributor") st.dist = ""; }
    st.page = 1;
    return render();
  }
  const clr = e.target.closest("[data-clear]");
  if (clr) return clearFilter(clr.dataset.clear);
  const stat = e.target.closest("[data-stat]");
  if (stat) {
    const set = JSON.parse(stat.dataset.stat);
    const already = Object.entries(set).every(([k, v]) => st[k] === v) && stat.classList.contains("on");
    Object.assign(st, already ? Object.fromEntries(Object.keys(set).map((k) => [k, "all"])) : set);
    st.page = 1;
    return render();
  }
  const pg = e.target.closest("button[data-page]");
  if (pg && !pg.disabled) {
    st.page = Number(pg.dataset.page);
    render();
    $("fdCount").scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const act = e.target.closest("button[data-act]");
  if (!act || act.disabled) return;
  const id = act.dataset.id;
  if (act.dataset.act === "view") return window.viewFarmer(id);
  if (act.dataset.act === "edit") return window.editFarmer(id);
  if (act.dataset.act === "phone") return window.openPhoneAuth(id);
  if (act.dataset.act === "delete") return window.deleteFarmer(id);
  if (act.dataset.act === "toggle") {
    const f = allFarmers.find((x) => x.id === id);
    const to = act.dataset.status === "inactive" ? "Activate" : "Deactivate";
    if (!confirm(`${to} ${f?.farmBuddieId || "this farm"}${f?.name ? " (" + f.name + ")" : ""}?`)) return;
    act.disabled = true;
    window.toggleStatus(id, act.dataset.status)
      .then(() => toast(`${f?.farmBuddieId || "Farm"} ${to === "Activate" ? "activated" : "deactivated"}`))
      .catch((err) => { act.disabled = false; toast("Couldn't change the status: " + err.message, true); });
  }
});
$("fdPage").addEventListener("change", (e) => {
  if (e.target.id === "fdDist") { st.dist = e.target.value; st.page = 1; render(); }
});

/* ================= ACTIONS ================= */

window.viewFarmer = (id) => {
  window.location.href = `/admin/farmer-view.html?id=${id}`;
};

window.editFarmer = (id) => {
  window.location.href = `/admin/farmer-edit.html?id=${id}`;
};

window.toggleStatus = async (id, status) => {

  const newStatus = status === "inactive" ? "active" : "inactive";
  const ref = doc(db, "farmers", id);

  await updateDoc(ref, {
    status: newStatus,
    phoneAuth: {
      enabled: newStatus === "active",
      updatedAt: new Date()
    }
  });

  // fullPhoneSync needs the post-update doc (not just the fields we just
  // sent) - a single targeted read tied to this one write action, not a
  // page-load re-fetch, so it's not part of the redundant-reads problem
  // the rest of this file used to have.
  const updatedSnap = await getDoc(ref);
  const updatedData = updatedSnap.data();

  if (updatedData) {
    await fullPhoneSync(db, auth, id, updatedData);
  }

  // No manual cache/table update needed - data-store.js's own onSnapshot
  // picks up this write and calls onStoreUpdate() automatically.
};

/* ================= DELETE WITH DEVICE INFO ================= */
window.deleteFarmer = async (id) => {

  const farmerRef = doc(db, "farmers", id);
  const snap = await getDoc(farmerRef);

  if (!snap.exists()) {
    alert("Farmer not found");
    return;
  }

  const farmer = snap.data();

  const variant = farmer.controller?.variant || "N/A";
  const serial = farmer.controller?.serialNumber || "N/A";

  const message = `
⚠️ This farmer is assigned with device:

Variant: ${variant}
Serial Number: ${serial}${farmer.nodes?.length ? `\nNodes: ${farmer.nodes.map((n) => n.serialNumber).join(", ")}` : ""}

Customer is provided this device.
Are you sure you want to delete this farmer permanently?
`;

  if (!confirm(message)) return;

 /* ===== RESET CONTROLLER STATUS ===== */
// Looked up from data-store.js's already-live controllers cache instead of
// firing a fresh query - the store already has every controller in memory.

const uniqueId = farmer.controller?.uniqueId;

if (uniqueId) {

  const matched = getControllers().find(c => c.uniqueId === uniqueId);

  if (matched) {
    await updateDoc(doc(db, "controllers", matched.id), {
      status: "available",
      farmerId: null,
      farmerDocId: null,
      assignedAt: null
    });
  }

}

  /* ===== FREE ITS NODES ===== */
  // Back to "available", as the controller (node-mapping.js).
  if (farmer.nodes?.length) {
    await saveNodeMapping(db, { farmerDocId: id, farmBuddieId: farmer.farmBuddieId, nodes: [], previous: farmer.nodes });
  }

  /* ===== DELETE FARMER ===== */
  // No manual cache/table update needed - data-store.js's own onSnapshot
  // picks up the deletion and calls onStoreUpdate() automatically.

  await deleteDoc(farmerRef);

};
/* ================= DOWNLOAD ALL FARMERS EXCEL ================= */
window.downloadAllFarmersExcel = async function () {

  try {

    // What the list shows (search + filters + sort) - everything with none.
    if (!shownFarmers.length) {
        alert("No farmers to export - clear the filters first");
        return;
      }

      const data = shownFarmers.map(f => {

      return {

        /* ===== BASIC FARMER ===== */

        "Farm Buddie ID": f.farmBuddieId || "",
        "Farm Badge": f.farmNumber || "",
        //"Identity ID": f.identityId || "",
        //"Main Farmer ID": f.mainFarmerId || "",
        //"Role": f.role || "",

        "Farmer Name": f.name || "",
        "Title": f.title || "",

        "Primary Mobile": f.primaryMobile || "",
        "Secondary Mobile": f.secondaryMobile || "",
        "Email": f.emailId || "",
        "Aadhaar Number": f.aadhaarNumber || "",

        "Address": f.address || "",

       /* ===== LEAD SOURCE ===== */

          "Lead Source Type": f.leadSource?.type || "",
          "Distributor ID": f.leadSource?.distributorId || "",
          "Distributor Name": f.leadSource?.distributorName || "",
        /* ===== FARM LOCATION ===== */

        "Farm Location": f.farmDetails?.location || "",
        "Latitude": f.farmDetails?.latitude || "",
        "Longitude": f.farmDetails?.longitude || "",

        /* ===== APP USERS ===== */

        "App User 2 Name": f.appUsers?.[0]?.name || "",
        "App User 2 Mobile": f.appUsers?.[0]?.mobile || "",
        "App User 3 Name": f.appUsers?.[1]?.name || "",
        "App User 3 Mobile": f.appUsers?.[1]?.mobile || "",

        /* ===== NETWORK ===== */

        "Network Type": f.network?.type || "",

        /* ===== SIM DETAILS ===== */

        "SIM Number": f.sim?.simNumber || "",
        "SIM MSISDN": f.sim?.msisdn || "",
        "SIM IMEI": f.sim?.imeiNumber || "",
        "SIM Type": f.sim?.simType || "",
        "Billing Cycle": f.sim?.billingCycle || "",
        "Activation Date": f.sim?.activationDate || "",

        /* ===== CONTROLLER ===== */

          "MCU Variant": f.controller?.variant || "",
          "Serial Number": f.controller?.serialNumber || "",
          "Device Unique ID": f.controller?.uniqueId || "",
          "Farm ID": f.controller?.farmId || "",
          

          "Warranty Start": f.controller?.warranty?.start || "",
          "Warranty End": f.controller?.warranty?.end || "",

          /* ===== MQTT ===== */

          "MQTT Broker URL": f.controller?.mqtt?.brokerUrl || "",
          "MQTT Port": f.controller?.mqtt?.port || "",
          "MQTT Username": f.controller?.mqtt?.username || "",
          "MQTT Password": f.controller?.mqtt?.password || "",

        /* ===== MOTOR CONFIG ===== */

        "Motor Count": f.motorConfig?.motorCount || "",
        "Pump 1 HP": f.motorConfig?.pumpHp?.[0] || "",
        "Pump 2 HP": f.motorConfig?.pumpHp?.[1] || "",
        "Pump 3 HP": f.motorConfig?.pumpHp?.[2] || "",

        /* ===== VALVE CONFIG ===== */

        ...valveConfigExportColumns(f.valveConfig),
        "Nodes": nodeMappingExportText(f.nodes),

        /* ===== TNEB SERVICE ===== */

        "Service Count": f.tnebServices?.serviceCount || "",
        "Service 1 HP": f.tnebServices?.services?.[0]?.sanctionedHp || "",
        "Service 2 HP": f.tnebServices?.services?.[1]?.sanctionedHp || "",
        "Service 3 HP": f.tnebServices?.services?.[2]?.sanctionedHp || "",

        /* ===== PUMP SERVICE MAPPING ===== */

        "Pump1 → Service": f.pumpServiceMapping?.[0]?.service || "",
        "Pump2 → Service": f.pumpServiceMapping?.[1]?.service || "",
        "Pump3 → Service": f.pumpServiceMapping?.[2]?.service || "",

        /* ===== DOCUMENT LINKS ===== */

        //"Aadhaar Document": f.documents?.aadhaarUrl || "",
        //"Other Document": f.documents?.otherDocUrl || "",
        //"Farmer Photo": f.documents?.farmerPhotoUrl || "",

        /* ===== STATUS ===== */

        "Status": f.status || "",

        /* ===== CREATED ===== */

        "Created At": f.createdAt
          ? fmtDateTime(f.createdAt)
          : "",
        "Created By": "Farm Buddie Admin"

      };

    });

    const XLSX = await window.loadXlsx();
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Farmers");

    XLSX.writeFile(workbook, "Farm_Buddie_Farmers.xlsx");

  } catch (error) {

    console.error("Excel export error:", error);
    alert("Error generating Excel file");

  }

};

/* ======================================================
   ACTIVATE / BLOCK ACCESS
====================================================== */

window.setAccess = async function(id, enable){

  const ref = doc(db,"farmers",id);

  await updateDoc(ref,{
    phoneAuth:{
      enabled:enable,
      updatedAt:new Date(),
      updatedBy:auth.currentUser.uid
    }
  });

 const updatedSnap = await getDoc(ref);
  const updatedData = updatedSnap.data();

  if(updatedData){
    await fullPhoneSync(db, auth, id, updatedData);
  }
  // The row's phone icon follows by itself (the store's listener re-renders).

  /* update popup buttons */

  const activateBtn = document.querySelector(".fb-btn.activate");
const blockBtn = document.querySelector(".fb-btn.block");

if(activateBtn && blockBtn){
  if(enable){
    activateBtn.disabled = true;
    activateBtn.classList.add("disabled");

    blockBtn.disabled = false;
    blockBtn.classList.remove("disabled");
  }else{
    blockBtn.disabled = true;
    blockBtn.classList.add("disabled");

    activateBtn.disabled = false;
    activateBtn.classList.remove("disabled");
  }
}
};

/* ======================================================
   PHONE AUTH POPUP
====================================================== */

window.openPhoneAuth = async function(id){

  /* remove old popup if exists */

  const oldModal = document.querySelector(".fb-modal-overlay");
  if(oldModal) oldModal.remove();

  // Read from the already-live store instead of a fresh getDoc - this
  // popup can be opened repeatedly while browsing the table, and allFarmers
  // is already kept in sync with Firestore via data-store.js's listener.
  const f = allFarmers.find(x => x.id === id);

  if(!f) return;


  /* ---------- farmer list ---------- */

  let farmerHtml = `
  <div class="fb-popup-farmer main">
    ⭐ ${f.name || "Unknown"}
  </div>
  `;

  if(Array.isArray(f.appUsers)){
    f.appUsers.forEach(u=>{
      if(u.name){
        farmerHtml += `
        <div class="fb-popup-farmer sub">
          👤 ${u.name}
        </div>`;
      }
    });
  }


  /* ---------- phone list ---------- */

  let phoneHtml = `
  <div class="fb-popup-phone main">
    ${f.primaryMobile || "-"}
  </div>
  `;

  if(Array.isArray(f.appUsers)){
    f.appUsers.forEach(u=>{
      if(u.mobile){
        phoneHtml += `
        <div class="fb-popup-phone sub">
          ${u.mobile}
        </div>`;
      }
    });
  }


  /* ===== MCU STATUS ===== */

let isOnline = false;

// Same rule as everywhere else - see isDeviceOnline() (device-status-render.js).
isOnline = isDeviceOnline(f.deviceStatus);

/*const mcuStatus = `
<span class="${isOnline ? "status-online" : "status-offline"}">
${isOnline ? "🟢 Online" : "🔴 Offline"}
</span>
`; */

const mcuStatus = `
<div class="mcu-row">
  <span class="${isOnline ? "status-online" : "status-offline"}">
    ${isOnline ? "🟢 Online" : "🔴 Offline"}
  </span>

  <button class="icon-btn view"
    onclick="window.location.href='/admin/device-view.html?id=${id}'"
    title="View Device">
    👁️ View
  </button>
</div>
`;

  /* ---------- popup HTML ---------- */

const farmBadge = f.farmNumber || "Farm 1";

/* phone auth state */
const enabled = f.phoneAuth?.enabled ?? null; // null = not selected yet

const modal = document.createElement("div");

modal.innerHTML = `
<div class="fb-modal-overlay">

  <div class="fb-modal-glass">

    <div class="fb-popup-header">

      <div class="fb-popup-title">
        📱 Phone Authorization
      </div>

      <div class="fb-popup-id">
        ${f.farmBuddieId}
      </div>

      <div class="fb-popup-badge">
        ${farmBadge}
      </div>

    </div>

    <div class="fb-popup-section">

      <div class="fb-popup-col">
        ${farmerHtml}
      </div>

      <div class="fb-popup-col">
        ${phoneHtml}
      </div>

    </div>

    <div class="fb-popup-mcu">
      MCU Status : ${mcuStatus}
    </div>

    <div class="fb-popup-actions">

      <button
        class="fb-btn activate ${enabled === true ? "disabled" : ""}"
        ${enabled === true ? "disabled" : ""}
        onclick="setAccess('${id}',true)">
        Activate
      </button>

      <button
        class="fb-btn block ${enabled === false ? "disabled" : ""}"
        ${enabled === false ? "disabled" : ""}
        onclick="setAccess('${id}',false)">
        Block
      </button>

      <button
        class="fb-btn close"
        onclick="this.closest('.fb-modal-overlay').remove()">
        Close
      </button>

    </div>

  </div>

</div>
`;

document.body.appendChild(modal);
};
/* ================= INSTANT FIRST PAINT ================= */
// The last data this browser saw, shown while the login check and the live
// listener start (see data-store.js warmDataStore()).
const PAGE_DATA = ["farmers", "controllers", "distributors"];
subscribe(onStoreUpdate);
warmDataStore(PAGE_DATA);
