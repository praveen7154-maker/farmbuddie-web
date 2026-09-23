import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  startDataStore,
  getFarmers,
  subscribe
} from "/js/data-store.js";


/* ================= AUTH ================= */
// This page used to keep its own separate onSnapshot listener on the whole
// farmers collection, duplicating the one data-store.js already runs for
// controller-database.js - shares that one instead now, same pattern as
// index.js.
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  startDataStore();
  subscribe(onStoreUpdate);
  onStoreUpdate();
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GLOBAL STATE ================= */

let allFarmers = [];
let currentSearchValue = "";
let paginationInitialized = false;

/* ================= SEARCH ================= */

document.getElementById("searchInput")?.addEventListener("input", (e) => {
  currentSearchValue = e.target.value.toLowerCase();
  applyFilter();
});

/* ================= APPLY FILTER ================= */

function applyFilter() {

  if (!currentSearchValue) {
    renderTable(allFarmers);
    return;
  }

  const filtered = allFarmers.filter(f =>
    (f.farmBuddieId || "").toLowerCase().includes(currentSearchValue) ||
    (f.controller?.uniqueId || "").toLowerCase().includes(currentSearchValue)
  );

  renderTable(filtered);
}

/* ================= STORE UPDATE ================= */
// Fires once on load and again on every data-store.js update - store
// already skips re-notifying when nothing actually changed, so no need to
// hash/compare snapshots here ourselves.
function onStoreUpdate() {
  allFarmers = getFarmers().slice().sort((a, b) =>
    (a.farmBuddieId || "").localeCompare(b.farmBuddieId || "", undefined, { numeric: true })
  );
  applyFilter();
}

/* ================= RENDER TABLE ================= */

function renderTable(data) {

  const tbody = document.getElementById("farmerTableBody");
  tbody.innerHTML = "";

  /* ===== NO DATA MESSAGE ===== */

  if (!data.length) {

    const message = currentSearchValue
      ? "No matching records found for filter"
      : "No records available";

    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:24px; font-weight:500;">
          ${message}
        </td>
      </tr>
    `;

    // Reset pagination display
    if (document.getElementById("fbStart")) {
      document.getElementById("fbStart").innerText = 0;
      document.getElementById("fbEnd").innerText = 0;
      document.getElementById("fbTotal").innerText = 0;
      document.getElementById("fbPagination").innerHTML = "";
    }

    paginationInitialized = false;
    return;
  }

  /* ===== BUILD TABLE ROWS ===== */

  let index = 1;
  const fragment = document.createDocumentFragment();
  for (const f of data) {

    const farmBuddieId = f.farmBuddieId || "-";
    const variant = f.controller?.variant || "-";
    const uniqueId = f.controller?.uniqueId || "-";

    let isOnline = false;

    if (f.deviceStatus?.lastSeen) {

      const lastSeen =
        f.deviceStatus.lastSeen.toDate?.() ||
        new Date(f.deviceStatus.lastSeen);

      const diffSeconds =
        (Date.now() - lastSeen.getTime()) / 1000;

      isOnline = diffSeconds <= 60;
    }

    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${index++}</td>
      <td>${farmBuddieId}</td>
      <td>${variant}</td>
      <td>${uniqueId}</td>
      <td>
        <span class="${isOnline ? "status-online" : "status-offline"}">
          ${isOnline ? "Online" : "Offline"}
        </span>
      </td>
      <td class="action-cell">
        <button class="icon-btn view"
          onclick="window.location.href='/admin/device-view.html?id=${f.id}'"
          title="View">
          👁️View
        </button>
      </td>
    `;

    fragment.appendChild(tr);
  }
  tbody.appendChild(fragment);
  /* ===== INIT PAGINATION ONLY ONCE PER RENDER ===== */

 setTimeout(() => {

  if (typeof initTablePagination === "function") {

    if (!paginationInitialized) {
      initTablePagination(".fb-table", 10);
      paginationInitialized = true;
    } else {
      initTablePagination(".fb-table", 10);
    }

  }

}, 0);

};