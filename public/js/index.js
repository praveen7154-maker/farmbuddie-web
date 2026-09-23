import { auth } from "/js/firebase-init.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  startDataStore,
  getFarmers,
  getDistributors,
  subscribe
} from "/js/data-store.js";

/* ================= AUTH ================= */
// Dashboard used to run its own one-shot getDocs() over the whole farmers
// and distributors collections every time this page loaded - shares the
// same realtime, cached listeners data-store.js already keeps open for
// analytics.js/controller-database.js instead, so navigating back to the
// Dashboard doesn't re-read either collection from scratch.
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  startDataStore();
  subscribe(renderDashboard);
  renderDashboard();
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GLOBAL STATE ================= */
let allFarmers = [];
let allDistributors = [];
let panelData = [];

/* ================= RENDER DASHBOARD ================= */
// Synchronous now - reads the already-live, already-cached arrays
// data-store.js's onSnapshot listeners maintain, instead of each call
// re-fetching the whole collection. Runs once on load and again on every
// store update (new farmer/distributor added elsewhere, status changed, ...).
function renderDashboard() {

  /* ========= FARMERS ========= */
  let total = 0, active = 0, inactive = 0, simExpiry = 0;

  const today = new Date();
  const limit = new Date();
  limit.setDate(today.getDate() + 30);

  allFarmers = [...getFarmers()].sort((a, b) =>
    (a.farmBuddieId || "").localeCompare(
      b.farmBuddieId || "",
      undefined,
      { numeric: true }
    )
  );

  allFarmers.forEach(f => {
    total++;
    if (f.status === "active") active++;
    if (f.status === "inactive") inactive++;

    if (f.sim?.activationDate) {
      const start = new Date(f.sim.activationDate);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);
      if (end >= today && end <= limit) simExpiry++;
    }
  });

  document.getElementById("totalFarmers").textContent = total;
  document.getElementById("activeCount").textContent = active;
  document.getElementById("inactiveCount").textContent = inactive;
  document.getElementById("simExpiryCount").textContent = simExpiry;

  /* ========= DISTRIBUTORS ========= */
  let totalDist = 0, activeDist = 0, inactiveDist = 0;

  allDistributors = getDistributors();

  allDistributors.forEach(dist => {
    totalDist++;
    if (dist.status === "active") activeDist++;
    if (dist.status === "inactive") inactiveDist++;
  });

  document.getElementById("totalDistributors").textContent = totalDist;
  document.getElementById("activeDistributorCount").textContent = activeDist;
  document.getElementById("inactiveDistributorCount").textContent = inactiveDist;

  attachCardClicks();
}

/* ================= CARD CLICK ================= */
function attachCardClicks() {

  // Farmer cards
  document.querySelectorAll(".fb-stat-card:not(.distributor-card)")
    .forEach(card => {
      card.style.cursor = "pointer";
      card.onclick = () => {
        openFarmerPanel(card.dataset.filter || "all");
      };
    });

  // Distributor cards
  document.querySelectorAll(".distributor-card")
    .forEach(card => {
      card.style.cursor = "pointer";
      card.onclick = () => {
        openDistributorPanel(card.dataset.distFilter || "all");
      };
    });
}

/* ================= FARMER PANEL ================= */
function openFarmerPanel(filter) {

  const panel = document.getElementById("dashboardFarmerPanel");
  panel.classList.remove("hidden");

  document.querySelector(".panel-header h2").textContent =
    "👨‍🌾 Farmer Details";

  document.getElementById("searchInput")
    .setAttribute("placeholder", "Search by Farm Buddie ID");

  setFarmerTableHeader();
  panelData = applyFarmerFilter(filter);
  renderFarmerTable(panelData);
}

function applyFarmerFilter(filter) {

  const today = new Date();
  const limit = new Date();
  limit.setDate(today.getDate() + 30);

  if (filter === "active")
    return allFarmers.filter(f => f.status === "active");

  if (filter === "inactive")
    return allFarmers.filter(f => f.status === "inactive");

  if (filter === "sim-expiry")
    return allFarmers.filter(f => {
      if (!f.sim?.activationDate) return false;
      const d = new Date(f.sim.activationDate);
      d.setFullYear(d.getFullYear() + 1);
      return d >= today && d <= limit;
    });

  return allFarmers;
}

/* ================= DISTRIBUTOR PANEL ================= */
function openDistributorPanel(filter) {

  const panel = document.getElementById("dashboardFarmerPanel");
  panel.classList.remove("hidden");

  document.querySelector(".panel-header h2").textContent =
    "🏢 Distributor Details";

  document.getElementById("searchInput")
    .setAttribute("placeholder", "Search by Distributor ID");

  setDistributorTableHeader(); 
  panelData = applyDistributorFilter(filter);
  renderDistributorTable(panelData);
}

function applyDistributorFilter(filter) {

  if (filter === "active")
    return allDistributors.filter(d => d.status === "active");

  if (filter === "inactive")
    return allDistributors.filter(d => d.status === "inactive");

  return allDistributors;
}


/* ================= TABLE HEADER SWITCH ================= */
function setFarmerTableHeader() {

  const thead = document.querySelector("#dashboardFarmerPanel .fb-table thead");

  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Farm Buddie ID</th>
      <th>Name</th>
      <th>Variant</th>
      <th>Mobile</th>
      <th>Status</th>
    </tr>
  `;
}

function setDistributorTableHeader() {

  const thead = document.querySelector("#dashboardFarmerPanel .fb-table thead");

  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Distributor ID</th>
      <th>Company / Person Name</th>
      <th>Mobile</th>
      <th>Status</th>
    </tr>
  `;
}

/* ================= FARMER TABLE ================= */
function renderFarmerTable(data) {

  const tbody = document.getElementById("panelFarmerTable");
  tbody.innerHTML = "";

  if (!data.length) {
    tbody.innerHTML =
      `<tr><td colspan="6" style="text-align:center">No farmers found</td></tr>`;
    return;
  }

  let index = 1;

  data.forEach(f => {

    const tr = document.createElement("tr");
    if (f.status === "inactive")
      tr.classList.add("inactive-row");

    tr.innerHTML = `
      <td>${index++}</td>
      <td>${f.farmBuddieId || "-"}</td>
      <td>${f.name || "-"}</td>
      <td>${f.controller?.variant || "-"}</td>
      <td>${f.primaryMobile || "-"}</td>
      <td>
        <span class="status ${f.status}">
          ${f.status || "-"}
        </span>
      </td>
    `;

    tbody.appendChild(tr);
  });

  setTimeout(() => {
    initTablePagination("#dashboardFarmerPanel .fb-table", 8);
  }, 100);
}

/* ================= DISTRIBUTOR TABLE ================= */
function renderDistributorTable(data) {

  const tbody = document.getElementById("panelFarmerTable");
  tbody.innerHTML = "";

  if (!data.length) {
    tbody.innerHTML =
      `<tr><td colspan="5" style="text-align:center">No distributors found</td></tr>`;
    return;
  }

  let index = 1;

  data.forEach(d => {

    const tr = document.createElement("tr");
    if (d.status === "inactive")
      tr.classList.add("inactive-row");

    tr.innerHTML = `
      <td>${index++}</td>
      <td>${d.distributorId || "-"}</td>
      <td>${d.name || "-"}</td>
      <td>${d.primaryMobile || "-"}</td>
      <td>
        <span class="status ${d.status}">
          ${d.status || "-"}
        </span>
      </td>
    `;

    tbody.appendChild(tr);
  });

  setTimeout(() => {
    initTablePagination("#dashboardFarmerPanel .fb-table", 8);
  }, 100);
}

/* ================= SEARCH ================= */
document.getElementById("searchInput")?.addEventListener("input", e => {

  const v = e.target.value.toLowerCase();

  const isDistributorMode =
    document.querySelector(".panel-header h2")
      .textContent.includes("Distributor");

  let filtered;

  if (isDistributorMode) {

    filtered = panelData.filter(d =>
      d.distributorId?.toLowerCase().includes(v) ||
      d.name?.toLowerCase().includes(v) ||
      d.primaryMobile?.includes(v)
    );

    renderDistributorTable(filtered);

  } else {

    filtered = panelData.filter(f =>
      f.farmBuddieId?.toLowerCase().includes(v) ||
      f.name?.toLowerCase().includes(v) ||
      f.primaryMobile?.includes(v)
    );

    renderFarmerTable(filtered);
  }
});

/* ================= CLOSE PANEL ================= */
document.getElementById("closePanelBtn")?.addEventListener("click", () => {
  document.getElementById("dashboardFarmerPanel")
    .classList.add("hidden");
});
