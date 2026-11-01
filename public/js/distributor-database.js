import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  doc,
  updateDoc,
  deleteDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  startDataStore,
  warmDataStore,
  getDistributors,
  getFarmers,
  isLive,
  subscribe
} from "/js/data-store.js";
import { icon, esc, renderPager, loadState, saveState, toast, slashToSearch } from "/js/records-ui.js";
import { fmtDateTime } from "/js/time-format.js";

/* ================= AUTH GUARD ================= */
// Used to run its own one-shot getDocs() over the whole distributors
// collection every page load - shares data-store.js's realtime listener
// instead, same as index.js/analytics.js. Writes below (toggleStatus,
// deleteDistributor) no longer need to manually reload afterward either -
// the store's own onSnapshot picks up the change and re-renders on its own.
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

/* ================= SUCCESS MESSAGE ================= */
const msg = sessionStorage.getItem("distSuccess");
if (msg) {
  const successBox = document.createElement("div");
  successBox.style.background = "var(--fbx-accent-soft, #e6f9f0)";
  successBox.style.color = "var(--fbx-accent, #065f46)";
  successBox.style.padding = "12px 18px";
  successBox.style.borderRadius = "12px";
  successBox.style.marginBottom = "20px";
  successBox.style.fontSize = "13px";
  successBox.style.fontWeight = "600";
  successBox.innerText = msg;

  document.querySelector(".fb-main")?.prepend(successBox);

  setTimeout(() => successBox.remove(), 6000);
  sessionStorage.removeItem("distSuccess");
}

/* ================= LIST STATE ================= */
// Kept for this browser tab, so back from View / Edit the list is where it was.
const STATE_KEY = "fb.distributorDb.v1";
const DEFAULTS = { q: "", status: "all", farms: "all", state: "", sort: "id", size: 20, page: 1, open: false };
const st = loadState(STATE_KEY, DEFAULTS);

let allDistributors = [];
let shown = [];
let farmCount = new Map();      // distributorId -> farms onboarded through them
let farmerCount = new Map();    // distributorId -> farmers (people) onboarded

const $ = (id) => document.getElementById(id);
const ms = (t) => (t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : (Date.parse(t) || 0));
const idOf = (d) => d.distributorId || d.id;
const isActive = (d) => d.status !== "inactive";
const stateOf = (d) => String(d.address?.state || "").trim();
const placeOf = (d) => [d.address?.city, d.address?.district, d.address?.state].map((v) => String(v || "").trim()).filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i).join(", ");

/* ================= STORE UPDATE ================= */
function onStoreUpdate() {
  allDistributors = getDistributors().slice();
  farmCount = new Map();
  const people = new Map();
  for (const f of getFarmers()) {
    const id = String(f.leadSource?.type || "").toUpperCase() === "DISTRIBUTOR" ? f.leadSource?.distributorId : "";
    if (!id) continue;
    farmCount.set(id, (farmCount.get(id) || 0) + 1);
    if (!people.has(id)) people.set(id, new Set());
    people.get(id).add(f.identityId || f.aadhaarNumber || f.id);
  }
  farmerCount = new Map([...people].map(([id, set]) => [id, set.size]));
  render();
}

/* ================= FILTERS ================= */
const GROUPS = [
  { key: "status", label: "Status", opts: [["all", "All"], ["active", "Active"], ["inactive", "Inactive"]] },
  { key: "farms", label: "Farmers", opts: [["all", "All"], ["with", "With farmers"], ["none", "No farmers yet"]] }
];

function matches(d, q) {
  if (st.status !== "all" && (st.status === "active") !== isActive(d)) return false;
  const n = farmCount.get(idOf(d)) || 0;
  if (st.farms === "with" && !n) return false;
  if (st.farms === "none" && n) return false;
  if (st.state && stateOf(d).toLowerCase() !== st.state.toLowerCase()) return false;
  if (!q) return true;
  const idNumeric = String(d.distributorId || "").match(/(\d+)$/)?.[1] || "";   // "0001" of D26FBA0001
  return [d.distributorId, idNumeric, d.name, d.companyName, d.primaryMobile, d.email, d.gstNumber,
    d.address?.city, d.address?.district, d.address?.state]
    .some((v) => String(v || "").toLowerCase().includes(q));
}

const SORTS = {
  id: (a, b) => (a.distributorId || "").localeCompare(b.distributorId || "", undefined, { numeric: true }),
  name: (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }) || SORTS.id(a, b),
  farms: (a, b) => (farmCount.get(idOf(b)) || 0) - (farmCount.get(idOf(a)) || 0) || SORTS.id(a, b),
  newest: (a, b) => ms(b.createdAt) - ms(a.createdAt) || SORTS.id(a, b)
};

const activeCount = () => GROUPS.filter((g) => st[g.key] !== "all").length + (st.state ? 1 : 0);

function renderFilters() {
  const states = [...new Set(allDistributors.map(stateOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("ddFilters").innerHTML = GROUPS.map((g) => `
    <div class="rx-fgroup"><span>${g.label}</span><div class="rx-chips">
      ${g.opts.map(([v, l]) => `<button type="button" class="rx-chip${st[g.key] === v ? " on" : ""}" data-f="${g.key}" data-v="${v}" aria-pressed="${st[g.key] === v}">${l}</button>`).join("")}
    </div></div>`).join("") + `
    <div class="rx-fgroup"><span>State</span>
      <select id="ddState" aria-label="State">
        <option value="">Any state</option>
        ${states.map((x) => `<option${st.state.toLowerCase() === x.toLowerCase() ? " selected" : ""}>${esc(x)}</option>`).join("")}
      </select></div>`;
  $("ddFilters").hidden = !st.open;
  $("ddFilterBtn").classList.toggle("on", st.open);
  $("ddFilterBtn").setAttribute("aria-expanded", String(st.open));
  const n = activeCount();
  $("ddFilterCount").hidden = !n;
  $("ddFilterCount").textContent = n;

  const pills = [];
  GROUPS.forEach((g) => {
    if (st[g.key] === "all") return;
    pills.push(`<button type="button" class="rx-pill-x" data-clear="${g.key}" title="Remove this filter">${esc(g.label)}: ${esc(g.opts.find(([v]) => v === st[g.key])?.[1] || "")}${icon("x")}</button>`);
  });
  if (st.state) pills.push(`<button type="button" class="rx-pill-x" data-clear="state">State: ${esc(st.state)}${icon("x")}</button>`);
  if (st.q) pills.push(`<button type="button" class="rx-pill-x" data-clear="q">“${esc(st.q)}”${icon("x")}</button>`);
  $("ddActive").innerHTML = pills.length ? pills.join("") + `<button type="button" class="rx-clear" data-clear="all">Clear all</button>` : "";
}

function renderStats() {
  const active = allDistributors.filter(isActive).length;
  const farms = allDistributors.reduce((t, d) => t + (farmCount.get(idOf(d)) || 0), 0);
  const withFarms = allDistributors.filter((d) => farmCount.get(idOf(d))).length;
  const tile = (label, n, tone, set, on) =>
    `<button type="button" class="rx-stat${on ? " on" : ""}" data-tone="${tone}" data-stat='${JSON.stringify(set)}'><small>${label}</small><b>${n}</b></button>`;
  $("ddStats").innerHTML =
    tile("Distributors", allDistributors.length, "", { status: "all", farms: "all" }, false) +
    tile("Active", active, "green", { status: "active" }, st.status === "active") +
    tile("Inactive", allDistributors.length - active, "red", { status: "inactive" }, st.status === "inactive") +
    tile("With farmers", withFarms, "blue", { farms: "with" }, st.farms === "with") +
    tile("Farms brought", farms, "green", { farms: "with" }, false);
}

function row(d, i) {
  const active = isActive(d);
  const id = idOf(d);
  const farms = farmCount.get(id) || 0;
  const people = farmerCount.get(id) || 0;
  return `<article class="rx-row" data-tone="${active ? "green" : "grey"}" style="animation-delay:${Math.min(i, 12) * 18}ms">
    <div class="rx-id"><b>${esc(id || "-")}</b><span class="rx-tag" data-tone="${active ? "green" : "red"}">${active ? "Active" : "Inactive"}</span></div>
    <div class="rx-main">
      <div class="rx-name">${esc(d.name || d.companyName || "-")}<em>${esc(placeOf(d) || d.email || "")}</em></div>
      <div><small>Mobile</small><span class="rx-mono">${esc(d.primaryMobile || "-")}</span></div>
      <div><small>Farmers</small>${farms
        ? `<a class="rx-link" href="/admin/farmer-database.html?distributor=${encodeURIComponent(id)}" title="Open these farmers in the Farmer Database">${people} farmer${people === 1 ? "" : "s"} · ${farms} farm${farms === 1 ? "" : "s"}</a>`
        : `<span style="color:var(--fbx-faint)">None yet</span>`}</div>
      <div class="rx-wide-only"><small>Email</small>${esc(d.email || "-")}</div>
    </div>
    <div class="rx-side">
      <div class="rx-actions">
        <button type="button" class="rx-icon" data-act="view" data-id="${esc(d.id)}" title="View" aria-label="View ${esc(id)}">${icon("eye")}</button>
        <button type="button" class="rx-icon" data-act="edit" data-id="${esc(d.id)}" title="${active ? "Edit" : "Activate to edit"}" aria-label="Edit ${esc(id)}"${active ? "" : " disabled"}>${icon("pencil")}</button>
        <button type="button" class="rx-icon ${active ? "" : "ok"}" data-act="toggle" data-id="${esc(d.id)}" data-status="${esc(d.status || "")}" title="${active ? "Deactivate" : "Activate"}" aria-label="${active ? "Deactivate" : "Activate"} ${esc(id)}">${icon("power")}</button>
        <button type="button" class="rx-icon danger" data-act="delete" data-id="${esc(d.id)}" title="Delete" aria-label="Delete ${esc(id)}">${icon("trash")}</button>
      </div>
    </div>
  </article>`;
}

/* ================= RENDER ================= */
function render() {
  saveState(STATE_KEY, st);
  if (!allDistributors.length && !isLive("distributors")) return;   // still loading - the skeletons stay
  const q = st.q.trim().toLowerCase();
  shown = allDistributors.filter((d) => matches(d, q)).sort(SORTS[st.sort] || SORTS.id);
  const size = Number(st.size) || 20;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  if (st.page > pages) st.page = pages;
  if (st.page < 1) st.page = 1;
  const from = (st.page - 1) * size;
  const list = shown.slice(from, from + size);

  renderStats();
  renderFilters();
  $("ddCount").textContent = !allDistributors.length ? "" :
    `${shown.length} of ${allDistributors.length} distributor${allDistributors.length === 1 ? "" : "s"}` +
    (shown.length ? ` · showing ${from + 1}-${from + list.length}` : "");
  $("ddList").innerHTML = list.length ? list.map(row).join("") :
    `<div class="rx-empty">${icon("building")}<p>${allDistributors.length ? "No distributors match these filters." : "No distributors yet - add the first one."}</p>${activeCount() || st.q ? `<button type="button" class="rx-btn" data-clear="all">Clear filters</button>` : ""}</div>`;
  renderPager($("ddPager"), st.page, pages);
}

/* ================= CONTROLS ================= */
document.querySelectorAll("[data-rx-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.rxIcon); });
const searchBox = $("searchInput");
searchBox.value = st.q;
$("ddSort").value = st.sort;
$("ddSize").value = String(st.size);
slashToSearch(searchBox);

let typing = 0;
searchBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { st.q = searchBox.value; st.page = 1; render(); }, 120);
});
$("ddSort").addEventListener("change", (e) => { st.sort = e.target.value; st.page = 1; render(); });
$("ddSize").addEventListener("change", (e) => { st.size = Number(e.target.value) || 20; st.page = 1; render(); });
$("ddFilterBtn").addEventListener("click", () => { st.open = !st.open; renderFilters(); saveState(STATE_KEY, st); });
$("ddExcel").addEventListener("click", exportExcel);

function clearFilter(key) {
  if (key === "all") { Object.assign(st, { ...DEFAULTS, sort: st.sort, size: st.size, open: st.open }); searchBox.value = ""; }
  else if (key === "q") { st.q = ""; searchBox.value = ""; }
  else if (key === "state") st.state = "";
  else st[key] = "all";
  st.page = 1;
  render();
}

$("ddPage").addEventListener("click", (e) => {
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
    $("ddCount").scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const act = e.target.closest("button[data-act]");
  if (!act || act.disabled) return;
  const id = act.dataset.id;
  if (act.dataset.act === "view") return window.viewDistributor(id);
  if (act.dataset.act === "edit") return window.editDistributor(id);
  if (act.dataset.act === "delete") return window.deleteDistributor(id);
  if (act.dataset.act === "toggle") {
    const d = allDistributors.find((x) => x.id === id);
    const to = act.dataset.status === "inactive" ? "Activate" : "Deactivate";
    if (!confirm(`${to} ${idOf(d || {}) || "this distributor"}${d?.name ? " (" + d.name + ")" : ""}?`)) return;
    act.disabled = true;
    window.toggleStatus(id, act.dataset.status)
      .then(() => toast(`${idOf(d || {}) || "Distributor"} ${to === "Activate" ? "activated" : "deactivated"}`))
      .catch((err) => { act.disabled = false; toast("Couldn't change the status: " + err.message, true); });
  }
});
$("ddPage").addEventListener("change", (e) => {
  if (e.target.id === "ddState") { st.state = e.target.value; st.page = 1; render(); }
});

/* ================= EXCEL ================= */
async function exportExcel() {
  if (!shown.length) { toast("Nothing to export - clear the filters first", true); return; }
  try {
    const XLSX = await window.loadXlsx();
    const rows = shown.map((d) => ({
      "Distributor ID": d.distributorId || "",
      "Name": d.name || "",
      "Mobile": d.primaryMobile || "",
      "Email": d.email || "",
      "GST": d.gstNumber || "",
      "PAN": d.panNumber || "",
      "City": d.address?.city || "",
      "District": d.address?.district || "",
      "State": d.address?.state || "",
      "Pincode": d.address?.pincode || "",
      "Farmers": farmerCount.get(idOf(d)) || 0,
      "Farms": farmCount.get(idOf(d)) || 0,
      "Status": d.status || "",
      "Created At": d.createdAt ? fmtDateTime(d.createdAt) : ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Distributors");
    XLSX.writeFile(wb, "Farm_Buddie_Distributors.xlsx");
  } catch (err) {
    toast("Couldn't make the Excel file: " + err.message, true);
  }
}

/* ================= ACTIONS ================= */

window.viewDistributor = (id) => {
  window.location.href = `/admin/distributor-view.html?id=${id}`;
};

window.editDistributor = (id) => {
  window.location.href = `/admin/distributor-edit.html?id=${id}`;
};

window.toggleStatus = async (id, status) => {

  const newStatus = status === "inactive" ? "active" : "inactive";

  await updateDoc(doc(db, "distributors", id), {
    status: newStatus
  });
};

window.deleteDistributor = async (id) => {

  const snap = await getDoc(doc(db, "distributors", id));

  if (!snap.exists()) {
    alert("Distributor not found");
    return;
  }

  const distributor = snap.data();

  const message = `
⚠️ Distributor: ${distributor.name}

Are you sure you want to delete this distributor permanently?
`;

  if (!confirm(message)) return;

  await deleteDoc(doc(db, "distributors", id));
};

/* ================= GO TO ONBOARDING ================= */
window.goToDistributorOnboarding = function () {
  window.location.href = "/admin/distributor-onboarding.html";
};
/* ================= INSTANT FIRST PAINT ================= */
// The last data this browser saw, shown while the login check and the live
// listener start (see data-store.js warmDataStore()).
const PAGE_DATA = ["distributors", "farmers"];
subscribe(onStoreUpdate);
warmDataStore(PAGE_DATA);
