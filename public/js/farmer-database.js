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
  fullPhoneSync
} from "/js/phone-auth.js";

import {
  startDataStore,
  getFarmers,
  getControllers,
  subscribe
} from "/js/data-store.js";

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

  startDataStore();
  subscribe(onStoreUpdate);
  onStoreUpdate();
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= URL FILTER ================= */
const params = new URLSearchParams(window.location.search);
const filter = params.get("filter");

let allFarmers = [];
let filteredFarmers = [];


/* ================= STORE UPDATE ================= */
function onStoreUpdate() {
  allFarmers = getFarmers().slice().sort((a, b) =>
    (a.farmBuddieId || "").localeCompare(b.farmBuddieId || "", undefined, { numeric: true })
  );
  filteredFarmers = applyFilter(allFarmers);
  renderTable(filteredFarmers);
}
/* ================= APPLY FILTER ================= */
function applyFilter(data) {

  if (!filter) return data;

  if (filter === "active") {
    return data.filter(f => f.status === "active");
  }

  if (filter === "inactive") {
    return data.filter(f => f.status === "inactive");
  }

  if (filter === "sim-expiry") {

    const today = new Date();
    const limit = new Date();
    limit.setDate(today.getDate() + 30);

    return data.filter(f => {

      if (!f.sim?.activationDate) return false;

      const start = new Date(f.sim.activationDate);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);

      return end >= today && end <= limit;
    });
  }

  return data;
}

/* ================= RENDER TABLE ================= */
function renderTable(data) {

  const tbody = document.getElementById("farmerTableBody");
  tbody.innerHTML = "";

  if (!data.length) {

    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:20px;">
          No farmers found
        </td>
      </tr>
    `;

    setTimeout(() => {
      initTablePagination(".fb-table", 10);
    }, 100);

    return;
  }

  const fragment = document.createDocumentFragment();

data.forEach((f, index) => {

  const tr = document.createElement("tr");

  if (f.status === "inactive") {
    tr.classList.add("inactive-row");
  }

  const farmNumber = f.farmNumber?.trim() || "Farm 1";
  const isInactive = f.status === "inactive";

  tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${f.farmBuddieId || "-"}</td>

      <td>${f.name || "-"}</td>
      <td>
      ${f.leadSource?.distributorId || "-"}
      </td>

      <td>
        <span class="farm-badge ${farmNumber.replace(" ", "-").toLowerCase()}">
          ${farmNumber}
        </span>
      </td>

      <td>${f.primaryMobile || "-"}</td>

      <td>${f.status || "-"}</td>

      <td class="action-cell">

        <button class="icon-btn view"
          onclick="viewFarmer('${f.id}')"
          title="View">👁️</button>

        <button class="icon-btn edit"
          onclick="editFarmer('${f.id}')"
          title="Edit"
          ${isInactive ? "disabled" : ""}>✏️</button>

        <button class="icon-btn toggle"
          onclick="toggleStatus('${f.id}', '${f.status}')"
          title="${isInactive ? "Activate" : "Deactivate"}">
          ${isInactive ? "🟢" : "⛔"}
        </button>

       <button class="icon-btn network ${(f.phoneAuth?.enabled ?? false) ? "active" : "blocked"}"
          onclick="openPhoneAuth('${f.id}')"
          title="Phone Authorization">
          📶
          </button>

        <button class="icon-btn delete"
          onclick="deleteFarmer('${f.id}')"
          title="Delete">🗑️</button>

      </td>
  `;

  fragment.appendChild(tr);

});

tbody.appendChild(fragment);

  requestAnimationFrame(() => {
  initTablePagination(".fb-table", 10);
});
}

/* ================= SEARCH ================= */
document.getElementById("searchInput")?.addEventListener("input", (e) => {

  const value = e.target.value.toLowerCase();

  const searched = filteredFarmers.filter(f =>
    f.farmBuddieId?.toLowerCase().includes(value) ||
    f.name?.toLowerCase().includes(value) ||
    f.primaryMobile?.includes(value) ||
    f.controller?.uniqueId?.toLowerCase().includes(value)
  );

  renderTable(searched);
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
Serial Number: ${serial}

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

  /* ===== DELETE FARMER ===== */
  // No manual cache/table update needed - data-store.js's own onSnapshot
  // picks up the deletion and calls onStoreUpdate() automatically.

  await deleteDoc(farmerRef);

};
/* ================= DOWNLOAD ALL FARMERS EXCEL ================= */
window.downloadAllFarmersExcel = async function () {

  try {

    if (!allFarmers.length) {
        alert("No farmers available to export");
        return;
      }

      const data = allFarmers.map(f => {

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

        "24V Valves": f.valveConfig?.valve24Count || "",
        "9V Valves": f.valveConfig?.valve9Count || "",
        "Filter Backwash": f.valveConfig?.filterBackwashCount || "",
        "Water Level Monitoring": f.valveConfig?.waterLevelMonitoring || "",

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
          ? (f.createdAt.toDate
              ? f.createdAt.toDate().toLocaleString()
              : new Date(f.createdAt.seconds * 1000).toLocaleString())
          : "",
        "Created By": "Farm Buddie Admin"

      };

    });

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
    /* update network icon */

  const btn = document.querySelector(
  `button[onclick="openPhoneAuth('${id}')"]`
  );

  if(btn){
    btn.classList.remove("active","blocked");
    btn.classList.add(enable ? "active" : "blocked");
  }

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

if (f.deviceStatus?.lastSeen) {

  const lastSeen =
    f.deviceStatus.lastSeen.toDate?.() ||
    new Date(f.deviceStatus.lastSeen);

  const diffSeconds =
    (Date.now() - lastSeen.getTime()) / 1000;

  isOnline = diffSeconds <= 90;
}

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