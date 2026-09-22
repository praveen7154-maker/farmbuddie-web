import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  getDoc,
  setDoc,
  query,
  orderBy,
  where
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";


import { 
  fullPhoneSync 
} from "/js/phone-auth.js";

/* ================= AUTH GUARD ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  sessionStorage.removeItem("farmersCache");

signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= URL FILTER ================= */
const params = new URLSearchParams(window.location.search);
const filter = params.get("filter");

let allFarmers = [];
let filteredFarmers = [];


/* ================= LOAD FARMERS ================= */
async function loadFarmers() {

  /* ===== CHECK SESSION CACHE ===== */

  const cached = sessionStorage.getItem("farmersCache");

  if (cached) {

    const parsed = JSON.parse(cached);

    if (parsed && parsed.length) {

      allFarmers = parsed;

      filteredFarmers = applyFilter(allFarmers);
      renderTable(filteredFarmers);

      return;

    }

  }

  /* ===== FIRESTORE LOAD ===== */

  const q = query(
    collection(db, "farmers"),
    orderBy("farmBuddieId", "asc")
  );

  const snapshot = await getDocs(q);

  allFarmers = snapshot.docs.map(d => ({
    _docId: d.id,
    ...d.data()
  }));

  /* ===== SAVE CACHE ===== */

  sessionStorage.setItem("farmersCache", JSON.stringify(allFarmers));
  filteredFarmers = applyFilter(allFarmers);
  renderTable(filteredFarmers);
}

loadFarmers();
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
          onclick="viewFarmer('${f._docId}')"
          title="View">👁️</button>

        <button class="icon-btn edit"
          onclick="editFarmer('${f._docId}')"
          title="Edit"
          ${isInactive ? "disabled" : ""}>✏️</button>

        <button class="icon-btn toggle"
          onclick="toggleStatus('${f._docId}', '${f.status}')"
          title="${isInactive ? "Activate" : "Deactivate"}">
          ${isInactive ? "🟢" : "⛔"}
        </button>

       <button class="icon-btn network ${(f.phoneAuth?.enabled ?? false) ? "active" : "blocked"}"
          onclick="openPhoneAuth('${f._docId}')"
          title="Phone Authorization">
          📶
          </button>

        <button class="icon-btn delete"
          onclick="deleteFarmer('${f._docId}')"
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
    const snap = await getDoc(ref);
    const farmerData = snap.data();

        await updateDoc(ref, {
        status: newStatus,
        phoneAuth: {
          enabled: newStatus === "active",
          updatedAt: new Date()
        }
      });

   // 🔥 Get latest data after update
      const updatedSnap = await getDoc(ref);
      const updatedData = updatedSnap.data();

      if (updatedData) {
        await fullPhoneSync(
              db,
              auth,
              id,
              updatedData
            );
      }

/* UPDATE CACHE */
      allFarmers = allFarmers.map(f =>
        f._docId === id
          ? {
              ...f,
              status: newStatus,
              phoneAuth: {
                enabled: newStatus === "active"
              }
            }
          : f
      );
sessionStorage.setItem("farmersCache", JSON.stringify(allFarmers));

filteredFarmers = applyFilter(allFarmers);
renderTable(filteredFarmers);
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

const uniqueId = farmer.controller?.uniqueId;

if (uniqueId) {

  const q = query(
    collection(db,"controllers"),
    where("uniqueId","==",uniqueId)
  );

  const snap = await getDocs(q);

  if (!snap.empty) {

    const controllerDoc = snap.docs[0];

    await updateDoc(controllerDoc.ref,{
  status: "available",
  farmerId: null,
  farmerDocId: null,
  assignedAt: null
});

  }

}

  /* ===== DELETE FARMER ===== */

  await deleteDoc(farmerRef);
  sessionStorage.removeItem("controllersCache");
  sessionStorage.removeItem("controllerFarmerMap");
  /* ===== UPDATE CACHE ===== */

  allFarmers = allFarmers.filter(f => f._docId !== id);

  sessionStorage.setItem("farmersCache", JSON.stringify(allFarmers));

  filteredFarmers = applyFilter(allFarmers);
  renderTable(filteredFarmers);

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
  const snap = await getDoc(ref);

  let farmerData = null;

  if(snap.exists()){
    farmerData = snap.data();
  }

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

  sessionStorage.removeItem("farmersCache");
};

/* ======================================================
   PHONE AUTH POPUP
====================================================== */

window.openPhoneAuth = async function(id){

  /* remove old popup if exists */

  const oldModal = document.querySelector(".fb-modal-overlay");
  if(oldModal) oldModal.remove();

  const ref = doc(db,"farmers",id);
  const snap = await getDoc(ref);

  if(!snap.exists()) return;

  const f = snap.data();


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