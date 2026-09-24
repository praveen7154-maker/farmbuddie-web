import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  addDoc,
  collection,
  serverTimestamp,
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  startDataStore,
  getControllers,
  getFarmers,
  subscribe
} from "/js/data-store.js";

import { provisionDeviceCredentials, renderMqttCredentialReveal } from "/js/provisioning.js";

/* ================= CACHE ================= */

let activeStatus = "ALL";
let activeVariant = "ALL";

let renderScheduled = false;
let lastControllerCount = 0;

/* ================= ADMIN VISIBLE STATUS ================= */
const ADMIN_VISIBLE_STATUSES = ["available", "assigned", "sold"];
const uploadBtn = document.getElementById("uploadExcelBtn");
const fileInput = document.getElementById("controllerExcel");

/* ================= AUTH ================= */

onAuthStateChanged(auth, (user) => {

  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  activateStatusTab("tabTotal");

  /* START REALTIME DATA STORE */
  startDataStore();

  /* SUBSCRIBE TO STORE UPDATES */
  subscribe(scheduleRender);

});


/* ================= SMART RENDER ================= */

function scheduleRender(){

  const controllers = getControllers();

  /* prevent unnecessary re-render */
  if (controllers.length === lastControllerCount) return;

  lastControllerCount = controllers.length;

  if (renderScheduled) return;

  renderScheduled = true;

  requestAnimationFrame(()=>{

    /* preserve pagination page */
    const currentPage =
      document.querySelector(".fb-pagination .active")?.textContent || 1;

    renderControllers();

    setTimeout(()=>{

      const pageBtn = document.querySelector(
        `.fb-pagination button[data-page="${currentPage}"]`
      );

      if(pageBtn) pageBtn.click();

    },200);

    renderScheduled = false;

  });

}

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {

  signOut(auth)
    .then(() => window.location.replace("/login.html"))
    .catch(err => console.error("Logout error:", err));

});

/* ================= REPAIR CONTROLLERS ================= */
// Reads from data-store.js's already-live farmers/controllers arrays
// instead of firing two fresh full-collection queries - this page already
// has both subscribed since load (see startDataStore() above), so a
// second read here would just be re-fetching the same data.
window.repairControllers = async function () {

  const farmerIds = new Set(
    getFarmers()
      .map(f => f.controller?.uniqueId)
      .filter(Boolean)
  );

  for (const c of getControllers()) {
    if (c.status === "assigned" && !farmerIds.has(c.uniqueId)) {
      await updateDoc(doc(db, "controllers", c.id), {
        status: "available",
        farmerId: null,
        farmerDocId: null,
        assignedAt: null
      });
    }
  }
}


/* ================= EXCEL UPLOAD ================= */

uploadBtn.addEventListener("click", async () => {

    if (!fileInput.files.length) {
        alert("Please select an Excel file.");
        return;
    }

    const file = fileInput.files[0];

    const reader = new FileReader();

    reader.onload = function(e){

        const workbook = XLSX.read(e.target.result,{
            type:"binary"
        });

        const sheet =
            workbook.Sheets[workbook.SheetNames[0]];

        // raw: false - without this, SheetJS reads any numeric-looking
        // cell as a JS number instead of the text actually in it. That
        // silently strips leading zeros off a 4-digit Unique ID ("0001"
        // becomes 1) and, worse, loses real digits off anything longer
        // than ~15-16 digits (a 19-digit ICCID can't be represented
        // exactly as a JS number at all) - exactly the "5.75418E+12"-
        // style corruption a pasted MOBILE_NUMBER/SIM_NO/SIM_IMSI column
        // shows when Excel itself already auto-formatted it as a number.
        // raw:false asks SheetJS for the cell's DISPLAYED text instead,
        // which is only a full fix if the source column was formatted as
        // Text in Excel before the data was typed/pasted in - see
        // normalizeControllerRow()'s own doc comment for the row-level
        // corruption check that catches the rest.
        const rows =
            XLSX.utils.sheet_to_json(sheet, { raw: false })
                .filter((row) => !isBlankRow(row));

        previewExcel(rows);

    };

    reader.readAsBinaryString(file);

});

// A controller's Unique ID becomes its device's MQTT farmId verbatim
// (controllers.uniqueId), and the firmware builds every topic it uses as
// farm/<farmId>/... via snprintf(..., "%04u", farmId) - a plain 4-digit
// decimal string, zero-padded. Anything else (the old template's
// "FBIRRIGO26AA10001X"-style example, a typo, a copy-paste from the wrong
// column) silently creates a controller no device can ever actually reach -
// caught here, before it ever reaches Firestore.
function isValidUniqueId(uniqueId) {
    return /^\d{4}$/.test(String(uniqueId ?? "").trim());
}

// True if every one of this row's real columns is empty - the sample
// template ships 200 blank, pre-formatted rows below its examples (see
// downloadControllerSample() in controller-database.html) so an admin
// typing new controllers straight into it still gets Text-formatted ID/
// SIM cells; sheet_to_json() still returns those rows since the cells
// exist (just empty), so without this they'd show up in the preview as
// 200 fake "Invalid Unique ID" rows instead of being silently skipped.
function isBlankRow(row) {
    return ["Variant", "Serial Number", "Unique ID", "IMEI Number", "SIM MSISDN", "SIM Number", "SIM IMSI"]
        .every((field) => !String(row[field] ?? "").trim());
}

// Every column that must be a plain run of digits, never scientific
// notation or a decimal point - a source Excel column left in
// General/Number format instead of Text mangles any of these the exact
// same way it mangles Unique ID (see the sheet_to_json() call's own doc
// comment): "8991940912940333745" becomes "8.99194E+17" and the real
// digits are gone for good, not just hidden.
const NUMERIC_ID_FIELDS = ["Serial Number", "IMEI Number", "SIM Number", "SIM MSISDN", "SIM IMSI"];

// True if `value` still shows the signature of having passed through a
// number conversion at some point - scientific notation or a decimal
// point. raw:false on the sheet_to_json() call (above) already recovers
// the common case (a Text-formatted cell SheetJS would otherwise coerce
// to a number); this catches what that can't: a source cell that was
// ALREADY a lossy float inside the Excel file itself, because the column
// wasn't set to Text before the data was typed or pasted in. No amount
// of parsing on this end can get those digits back - the fix has to be
// upstream, in how the sheet was filled in - so this exists to refuse
// the row loudly instead of silently saving garbage.
function looksCorrupted(value) {
    const s = String(value ?? "").trim();
    if (!s) return false;
    return /[eE][+-]?\d/.test(s) || s.includes(".");
}

// Recovers a zero-padded 4-digit Unique ID from a bare number Excel/
// SheetJS handed back without its leading zeros ("1" -> "0001") - only
// when the digits themselves are still intact (1-4 of them and nothing
// else), never for a value that's wrong in some other way.
function normalizeUniqueId(value) {
    const s = String(value ?? "").trim();
    return /^\d{1,4}$/.test(s) ? s.padStart(4, "0") : s;
}

// Applied identically by previewExcel() and uploadControllers() so what
// the admin sees in the preview modal is exactly what would actually get
// saved - normalizes Unique ID's leading zeros and flags any of
// NUMERIC_ID_FIELDS that still looks corrupted after that.
function normalizeControllerRow(row) {
    const normalized = { ...row, "Unique ID": normalizeUniqueId(row["Unique ID"]) };
    const corruptedFields = NUMERIC_ID_FIELDS.filter((field) => looksCorrupted(row[field]));
    return { row: normalized, corruptedFields };
}

/* ================= Preview Excel ================= */
function previewExcel(rows) {

    const tbody = document.getElementById("previewTable");
    tbody.innerHTML = "";

    rows.forEach((row, index) => {

        const { row: normalized, corruptedFields } = normalizeControllerRow(row);
        const valid = isValidUniqueId(normalized["Unique ID"]) && corruptedFields.length === 0;

        tbody.innerHTML += `
            <tr>
                <td>${index + 1}</td>

                <td>${row["Serial Number"] || "-"}</td>

                <td>${row["Variant"] || "-"}</td>

                <td>
                    ${valid
                        ? `<span class="status-ready">Ready</span>`
                        : corruptedFields.length > 0
                            ? `<span class="status-invalid">${corruptedFields.join(", ")} looks corrupted (scientific notation/decimal) - re-enter that column in Excel as Text before re-uploading</span>`
                            : `<span class="status-invalid">Invalid Unique ID (must be 4 digits, e.g. "0001") - got "${row["Unique ID"] ?? ""}"</span>`
                    }
                </td>
            </tr>
        `;

    });

    document
        .getElementById("uploadPreviewModal")
        .classList.remove("hidden");

    window.previewRows = rows;
}

/* ================= Confirm Upload ================= */
document
.getElementById("confirmUpload")
.onclick = uploadControllers;

/* ================= Upload Controller ================= */

async function uploadControllers(){

    const rows = window.previewRows || [];

    if(!rows.length) return;

    document
    .getElementById("pageLoader")
    .style.display="flex";

    let uploaded=0;
    let failed=0;

    for(const rawRow of rows){

        try{

            // Same normalization previewExcel() already showed the admin -
            // applied again here (not read back from the preview render)
            // so what actually gets saved always matches what "Ready"
            // meant on screen, even if this runs in a later session or
            // window.previewRows was touched by something else in between.
            const { row, corruptedFields } = normalizeControllerRow(rawRow);

            if (corruptedFields.length > 0) {
                console.error(`Skipped row (${corruptedFields.join(", ")} looks corrupted - scientific notation/decimal point): re-enter that column in Excel as Text and re-upload. Unique ID was "${rawRow["Unique ID"] ?? ""}"`);
                failed++;
                continue;
            }

           const serial = row["Serial Number"];
            const uniqueId = row["Unique ID"];
            const imei = row["IMEI Number"];
            const sim = row["SIM Number"];
            const msisdn = row["SIM MSISDN"];
            const imsi = row["SIM IMSI"];

            if (!isValidUniqueId(uniqueId)) {
                console.error(`Skipped row (invalid Unique ID "${uniqueId}"): must be 4 digits, e.g. "0001"`);
                failed++;
                continue;
            }

            const controllers = getControllers();

            const duplicate = controllers.find(c =>
                c.serialNumber === serial ||
                c.uniqueId === uniqueId ||
                c.imeiNumber === imei ||
                (sim && c.simNumber === sim) ||
                (msisdn && c.simMsisdn === msisdn) ||
                (imsi && c.simImsi === imsi)
            );

            if (duplicate) {

                failed++;
                continue;

            }

            await addDoc(collection(db,"controllers"),{

                variant:row["Variant"],

                serialNumber:row["Serial Number"],

                uniqueId:uniqueId,

                imeiNumber:row["IMEI Number"],

                simMsisdn:row["SIM MSISDN"],

                simNumber:row["SIM Number"],

                simImsi:row["SIM IMSI"],

                status:"available",

                farmerId:null,

                createdAt:serverTimestamp()

            });

            uploaded++;

        }

        catch(err){

            console.error(err);

            failed++;

        }

    }

    document
    .getElementById("pageLoader")
    .style.display="none";

    document
    .getElementById("uploadPreviewModal")
    .classList.add("hidden");

    document
    .getElementById("uploadResult")
    .innerHTML=`
        <h3>Upload Completed</h3>

        Uploaded : ${uploaded}<br>

        Failed : ${failed}
    `;

    document
    .getElementById("uploadResultModal")
    .classList.remove("hidden");

    renderControllers();
    fileInput.value="";

}

/* ================= Cancel Preview ================= */

document
.getElementById("cancelPreview")
.onclick = ()=>{

  /* ================= upload preview ================= */
 document
 .getElementById("uploadPreviewModal")
 .classList.add("hidden");

}

/* ================= close preview ================= */
document
.getElementById("closePreview")
.onclick = ()=>{

 document
 .getElementById("uploadPreviewModal")
 .classList.add("hidden");

}

document
.getElementById("closeUploadResult")
.onclick = ()=>{

 document
 .getElementById("uploadResultModal")
 .classList.add("hidden");

}

/* ================= LOAD CONTROLLERS ================= */
async function renderControllers() {

  const tbody = document.getElementById("controllerTable");
  tbody.innerHTML = "";

  // 🔝 OVERALL COUNTS
  let total = 0, available = 0, assigned = 0, unmapped = 0;
  let serialIndex = 1;

  // 📦 VARIANT COUNTS
  let irrigo = { total: 0, available: 0, assigned: 0, unmapped: 0 };
  let plus = { total: 0, available: 0, assigned: 0, unmapped: 0 };
  let smart = { total: 0, available: 0, assigned: 0, unmapped: 0 };

  /* ================= MAP FARMERS ================= */
const farmerList = getFarmers();
const farmerMap = {};

farmerList.forEach(f => {
  if (f.controller?.uniqueId) {
    farmerMap[f.controller.uniqueId] = {
      farmerDocId: f.id,
      farmBuddieId: f.farmBuddieId
    };
  }
});

/* ================= LOAD CONTROLLERS ================= */
const controllerList = getControllers();

for (const c of controllerList) {

  /* HIDE PRODUCTION INTERNAL STATUSES */
  if (!ADMIN_VISIBLE_STATUSES.includes(c.status)) continue;

  const farmer = farmerMap[c.uniqueId];

 total++;
 //if (activeVariant === "ALL") total++;

  /* ================= OVERALL COUNTS ================= */

  if (c.status === "available") available++;
  else if (c.status === "assigned") assigned++;
  else if (c.status === "sold") unmapped++;

  /* ================= VARIANT COUNTS ================= */

  const variant = c.variant;

  if (variant === "IRRIGO") {
    irrigo.total++;

    if (c.status === "available") irrigo.available++;
    else if (c.status === "assigned") irrigo.assigned++;
    else if (c.status === "sold") irrigo.unmapped++;
  }

  if (variant === "IRRIGO_PLUS") {
    plus.total++;

    if (c.status === "available") plus.available++;
    else if (c.status === "assigned") plus.assigned++;
    else if (c.status === "sold") plus.unmapped++;
  }

  if (variant === "IRRIGO_SMART_PLUS") {
    smart.total++;

    if (c.status === "available") smart.available++;
    else if (c.status === "assigned") smart.assigned++;
    else if (c.status === "sold") smart.unmapped++;
  }

    /* ===== VARIANT FILTER ===== */
if (activeVariant !== "ALL" && c.variant !== activeVariant) {
  continue;
}

/* ===== STATUS FILTER ===== */
if (activeStatus !== "ALL" && c.status !== activeStatus) {
  continue;
}

   /* ================= FARMER CELL ================= */

 let farmerCell = "—";

/* AUTO FIX IF FARMER NOT FOUND */
let status = c.status;

if (status === "assigned" && !farmer) {
  status = "available";
}

if (c.status === "assigned" && farmer) {
  farmerCell = `
    <span class="farmer-link"
      onclick="openFarmerPanel('${farmer.farmBuddieId}', '${c.id}')">
      ${farmer.farmBuddieId}
    </span>`;
}

  if (c.status === "sold") {
    farmerCell = `<span class="badge-unmapped">Unmapped</span>`;
  }

  /* ================= TABLE ROW ================= */

  const tr = document.createElement("tr");

 tr.innerHTML = `
<td>${serialIndex++}</td>

<td>${c.variant || "-"}</td>

<td>${c.username || "-"}</td>

<td>${farmerCell}</td>

<td>
    <span class="status ${status}">
        ${
            status === "available"
                ? "Available"
                : status === "assigned"
                ? "Assigned"
                : "Unmapped"
        }
    </span>
</td>

`;

tbody.appendChild(tr);

}

if (serialIndex === 1) {

    const tr = document.createElement("tr");

    tr.innerHTML = `
        <td colspan="5"
            style="
                text-align:center;
                padding:40px;
                color:#7a7a7a;
                font-weight:500;
            ">
            No Controllers Found
        </td>
    `;

    tbody.appendChild(tr);

}

setTimeout(() => {
  initTablePagination(".fb-table", 10);
}, 200);
/* ================= UPDATE OVERALL UI ================= */

document.getElementById("totalCount").textContent = total;
document.getElementById("availableCount").textContent = available;
document.getElementById("assignedCount").textContent = assigned;
document.getElementById("unmappedCount").textContent = unmapped;

/* ================= UPDATE VARIANT UI ================= */

// IRRIGO
document.getElementById("irrigoTotal").textContent = irrigo.total;
document.getElementById("irrigoAvailable").textContent = irrigo.available;
document.getElementById("irrigoAssigned").textContent = irrigo.assigned;
document.getElementById("irrigoUnmapped").textContent = irrigo.unmapped;

// IRRIGO PLUS
document.getElementById("plusTotal").textContent = plus.total;
document.getElementById("plusAvailable").textContent = plus.available;
document.getElementById("plusAssigned").textContent = plus.assigned;
document.getElementById("plusUnmapped").textContent = plus.unmapped;

// IRRIGO SMART PLUS
document.getElementById("smartTotal").textContent = smart.total;
document.getElementById("smartAvailable").textContent = smart.available;
document.getElementById("smartAssigned").textContent = smart.assigned;
document.getElementById("smartUnmapped").textContent = smart.unmapped;

}

/* ================= FARMER SIDE PANEL (1:1 WITH ONBOARDING) ================= */
window.openFarmerPanel = async function (farmBuddieId, controllerDocId) {
  window.__currentControllerDocId = controllerDocId || null;
  window.__currentFarmerMqtt = null;

  let panel = document.getElementById("farmerPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "farmerPanel";
    panel.className = "fb-side-panel hidden";
    panel.innerHTML = `
      <div class="fb-side-header">
        <h3>👨‍🌾 Farmer Details</h3>
        <button onclick="closeFarmerPanel()">✖</button>
      </div>
      <div class="fb-side-body" id="farmerPanelBody">Loading…</div>
    `;
    document.body.appendChild(panel);
  }

  panel.classList.remove("hidden");

  // Looked up from the already-live store instead of a fresh query - this
  // farmer's data is already in getFarmers() via data-store.js's listener.
  const f = getFarmers().find(x => x.farmBuddieId === farmBuddieId);

  if (!f) return;

  const appUsersHtml = (f.appUsers?.length)
    ? f.appUsers.map(u =>
        `<div class="info-item"><b>${u.name}</b>: ${u.mobile}</div>`
      ).join("")
    : `<div class="info-item full">No additional app users</div>`;

  document.getElementById("farmerPanelBody").innerHTML = `

  <!-- FARMER IDENTITY -->
  <div class="section-title">👨‍🌾 Farmer Identity</div>
  <div class="info-grid">
    <div class="info-item"><b>Farm Buddie ID:</b> ${f.farmBuddieId || "-"}</div>
    <div class="info-item"><b>Title:</b> ${f.title || "-"}</div>
    <div class="info-item"><b>Name:</b> ${f.name || "-"}</div>
    <div class="info-item"><b>Status:</b> ${f.status || "-"}</div>
    <div class="info-item"><b>Primary Mobile:</b> ${f.primaryMobile || "-"}</div>
    <div class="info-item"><b>Secondary Mobile:</b> ${f.secondaryMobile || "-"}</div>
    <div class="info-item"><b>Aadhaar Number:</b> ${f.aadhaarNumber || "-"}</div>

      <div class="info-item">
        <b>Lead Source:</b> ${
          f.leadSource?.type === "DISTRIBUTOR"
            ? "Distributor"
            : "Farm Buddie Smart Irrigation"
        }
      </div>

      ${
        f.leadSource?.type === "DISTRIBUTOR"
          ? `
            <div class="info-item">
              <b>Distributor Name:</b> ${f.leadSource?.distributorName || "-"}
            </div>
          `
          : ""
      }

      <div class="info-item full"><b>Address:</b> ${f.address || "-"}</div>
  </div>

  <!-- APP USERS -->
  <div class="section-title">📱 App Access Users</div>
  <div class="info-grid">
    ${
      Array.isArray(f.appUsers) && f.appUsers.length
        ? f.appUsers.map(u => `
            <div class="info-item">
              <b>${u.name || "User"}:</b> ${u.mobile || "-"}
            </div>
          `).join("")
        : `<div class="info-item full">No additional app users</div>`
    }
  </div>

  <!-- FARM & APP USER DETAILS -->
    <div class="section-title">🌾 Farm & App User Details</div>
    <div class="info-grid">
      <div class="info-item full">
        <b>Farm Location:</b> ${f.farmDetails?.location || "-"}
        </div>

        <div class="info-item">
          <b>Farm Latitude:</b> ${f.farmDetails?.latitude || "-"}
        </div>

        <div class="info-item">
          <b>Farm Longitude:</b> ${f.farmDetails?.longitude || "-"}
        </div>


    </div>

  <!-- DOCUMENTS -->
  <div class="section-title">📂 Uploaded Documents</div>
  <div class="info-grid">
    <div class="info-item">
      <b>Aadhaar File:</b>
      ${
        f.documents?.aadhaarUrl
          ? `<a href="${f.documents.aadhaarUrl}" target="_blank">View Document</a>`
          : "-"
      }
    </div>
    <div class="info-item">
      <b>Other Document:</b>
      ${
        f.documents?.otherDocUrl
          ? `<a href="${f.documents.otherDocUrl}" target="_blank">View Document</a>`
          : "-"
      }
    </div>
  </div>

  <!-- NETWORK -->
  <div class="section-title">🌐 Network Management</div>
  <div class="info-grid">
    <div class="info-item"><b>Network Type:</b> ${f.network?.type || "-"}</div>
  </div>

  <!-- SIM DETAILS -->
  <div class="section-title">📶 SIM Management</div>
  <div class="info-grid">
   <div class="info-item"><b>SIM Number (ICCID):</b> ${f.sim?.simNumber || "-"}</div>
    <div class="info-item"><b>MSISDN:</b> ${f.sim?.msisdn || "-"}</div>
    <div class="info-item"><b>IMSI:</b> ${f.sim?.simImsi || "-"}</div>
    <div class="info-item"><b>IMEI:</b> ${f.sim?.imeiNumber || "-"}</div>
    <div class="info-item"><b>SIM Type:</b> ${f.sim?.simType || "-"}</div>
    <div class="info-item"><b>Billing Cycle:</b> ${f.sim?.billingCycle || "-"}</div>
    <div class="info-item"><b>SIM/AMC Activation Date:</b> ${f.sim?.activationDate || "-"}</div>
  </div>

  <!-- CONTROLLER -->
<div class="section-title">🧠 MCU / Device Mapping</div>
<div class="info-grid">
  <div class="info-item"><b>Variant:</b> ${f.controller?.variant || "-"}</div>
  <div class="info-item"><b>Serial Number:</b> ${f.controller?.serialNumber || "-"}</div>
  <div class="info-item full"><b>Unique Device ID:</b> ${f.controller?.uniqueId || "-"}</div>

  <div class="info-item"><b>Warranty Start:</b> ${f.controller?.warranty?.start || "-"}</div>
  <div class="info-item"><b>Warranty End:</b> ${f.controller?.warranty?.end || "-"}</div>
</div>

<!-- MQTT DETAILS -->
<div class="section-title">📡 MQTT Configuration</div>
<div class="info-grid">
  <div class="info-item full"><b>Broker URL:</b> ${f.controller?.mqtt?.brokerUrl || "-"}</div>
  <div class="info-item"><b>Port:</b> ${f.controller?.mqtt?.port || "-"}</div>
  <div class="info-item full"><b>Username:</b> ${f.controller?.mqtt?.username || "-"}</div>
</div>
<div class="mqtt-actions">
  <span class="mqtt-status-pill ${f.controller?.mqtt?.username ? "issued" : "none"}">
    ${f.controller?.mqtt?.username ? "Credentials issued" : "No credentials yet"}
  </span>
  ${
    // A farm's login is always FBIRG<its uniqueId>. Anything else was written
    // here by mistake (old Add Farm bug) - ask the server, which returns and
    // stores the right one.
    f.controller?.mqtt?.username && f.controller.mqtt.username === `FBIRG${f.controller?.uniqueId}`
      ? `<button class="fb-btn-primary small" onclick="fetchMqttCredentials()">📥 Fetch MQTT Credentials</button>`
      : `<button class="fb-btn-primary small" onclick="generateInitialMqttCredentials()">🔑 Generate MQTT Credentials</button>`
  }
</div>
<div id="mqttRevealBox"></div>

  <!-- PAIRED HARDWARE (live BLE-paired nodes, synced from the Irrigo app
       via farmers/{id}.pairedUnits - see PairedUnitsRepository.kt) -
       separate from the static onboarding-time counts right below
       (Motor & TNEB Configuration), which are just what the farmer was
       sold, not what's actually been paired over BLE yet. -->
  <div class="section-title">🔗 Paired Hardware</div>
  <div class="info-grid">
    ${
      (() => {
        const motorNodes = Object.values(f.pairedUnits?.motorNodes || {});
        const valves = Object.values(f.pairedUnits?.valves || {});
        const rows = [
          ...motorNodes.map(u => `
            <div class="info-item">
              <b>${u.nodeLabel}</b> (Motor Node) - ${u.bleDeviceName || "-"}
            </div>
          `),
          ...valves.map(u => `
            <div class="info-item">
              <b>${u.unitLabel}</b> (${u.hasPressureSensors ? "Filter Backwash" : "Valve"}) -
              ${u.channelCount}ch ${u.valveType || ""}, ${u.valveCount} valve(s) - ${u.bleDeviceName || "-"}
            </div>
          `),
        ];
        return rows.length
          ? rows.join("")
          : `<div class="info-item full">No hardware paired yet</div>`;
      })()
    }
  </div>

  <!-- MOTOR & TNEB CONFIG -->
<div class="section-title">⚡ Motor & TNEB Configuration</div>
<div class="info-grid">

  <!-- Motors -->
  <div class="info-item">
    <b>No of Motors:</b> ${f.motorConfig?.motorCount || 0}
  </div>

  ${
    f.motorConfig?.pumpHp?.length
      ? f.motorConfig.pumpHp.map((hp, i) => `
          <div class="info-item">
            <b>Pump ${i+1} HP:</b> ${hp || "-"}
          </div>
        `).join("")
      : `<div class="info-item full">No pump configuration</div>`
  }

  <!-- Services -->
  <div class="info-item">
    <b>No of Services:</b> ${f.tnebServices?.serviceCount || 0}
  </div>

  ${
    f.tnebServices?.services?.length
      ? f.tnebServices.services.map(service => `
          <div class="info-item">
            <b>Service ${service.serviceNumber} HP:</b> ${service.sanctionedHp || "-"}
          </div>
        `).join("")
      : `<div class="info-item full">No service configuration</div>`
  }

</div>

    <!-- PUMP → SERVICE MAPPING -->
    <div class="section-title">🔁 Pump to Service Mapping</div>
    <div class="info-grid">
      ${
        f.pumpServiceMapping?.length
          ? f.pumpServiceMapping.map(map => `
              <div class="info-item">
                <b>Pump ${map.pumpNumber} (${map.hp}) →</b> Service ${map.service}
              </div>
            `).join("")
          : `<div class="info-item full">No mapping data</div>`
      }
    </div>

    <!-- VALVE CONFIG -->
    <div class="section-title">⚙️ Valve Configuration</div>
    <div class="info-grid">
      <div class="info-item">
        <b>24V AC Valves:</b> ${f.valveConfig?.valve24Count ?? 0}
      </div>

       ${
    f.controller?.variant !== "IRRIGO"
      ? `
        <div class="info-item">
          <b>9V DC Valves:</b> ${f.valveConfig?.valve9Count ?? 0}
        </div>

        <div class="info-item">
          <b>Filter Backwash:</b> ${f.valveConfig?.filterBackwashCount ?? 0}
        </div>

        <div class="info-item">
          <b>Water Level Monitoring:</b> ${f.valveConfig?.waterLevelMonitoring ?? 0}
        </div>
      `
      : ""
  }

</div>

  <!-- TIMESTAMPS -->
  <div class="section-title">⏱ Record Info</div>
  <div class="info-grid">
    <div class="info-item">
      <b>Created At:</b>
      ${f.createdAt?.toDate()?.toLocaleString() || "-"}
    </div>
    <div class="info-item">
      <b>Last Updated:</b>
      ${f.updatedAt?.toDate()?.toLocaleString() || "-"}
    </div>
  </div>

`;

  // Shows the durably-stored credential + QR immediately on every panel
  // open once one's been issued - the password is stored in plaintext
  // now (see deviceProvisioning.js's own doc comment on why), so this
  // never needs a fresh Rotate (which actually changes the password)
  // just to look at or re-share the QR again.
  if (f.controller?.mqtt?.password) {
    window.__currentFarmerMqtt = {
      brokerUrl: f.controller.mqtt.brokerUrl,
      port: f.controller.mqtt.port,
      username: f.controller.mqtt.username,
      password: f.controller.mqtt.password,
      farmId: f.controller.uniqueId,
      nodeId: "MOTOR_1",
      farmerName: f.name || "",
      farmBuddieId: f.farmBuddieId || ""
    };
    renderMqttCredentialReveal(document.getElementById("mqttRevealBox"), window.__currentFarmerMqtt);
  }
}

window.closeFarmerPanel = () =>
  document.getElementById("farmerPanel")?.classList.add("hidden");

/* Tab variant Activation */

function activateStatusTab(id){

  document.querySelectorAll(".stat")
    .forEach(c => c.classList.remove("active"));

  document.getElementById(id).classList.add("active");

}
function activateVariantTab(id){

  document.querySelectorAll(".variant-card")
    .forEach(c => c.classList.remove("active"));

  document.getElementById(id).classList.add("active");

}

document.getElementById("tabIrrigo").onclick = ()=>{
  activeVariant="IRRIGO";
  activateVariantTab("tabIrrigo");
   renderControllers();
};

document.getElementById("tabPlus").onclick = ()=>{
  activeVariant="IRRIGO_PLUS";
  activateVariantTab("tabPlus");
  renderControllers();
};

document.getElementById("tabSmart").onclick = ()=>{
  activeVariant="IRRIGO_SMART_PLUS";
  activateVariantTab("tabSmart");
  renderControllers();
};

document.getElementById("tabTotal").onclick = () => {
  activeStatus = "ALL";
  activateStatusTab("tabTotal");
   renderControllers();
};

document.getElementById("tabAvailable").onclick = () => {
  activeStatus = "available";
  activateStatusTab("tabAvailable");
  renderControllers();
};

document.getElementById("tabAssigned").onclick = () => {
  activeStatus = "assigned";
  activateStatusTab("tabAssigned");
 renderControllers();
};

document.getElementById("tabUnmapped").onclick = () => {
  activeStatus = "sold";
  activateStatusTab("tabUnmapped");
  renderControllers();
};

/* ================= MQTT PROVISIONING ================= */

// Read-only - just re-renders the already-loaded, already-stored
// credential/QR (window.__currentFarmerMqtt, set when the panel opened -
// see openFarmerPanel()). No network call, no TBMQ mutation, so it's safe
// to click as often as needed. This is the button admins actually want
// for "show me the QR again" - Rotate (below) is a separate, deliberately
// less prominent action for when credentials need to be invalidated.
window.fetchMqttCredentials = async function () {
  const revealBox = document.getElementById("mqttRevealBox");
  const data = window.__currentFarmerMqtt;

  if (!data) {
    alert("❌ No credentials found for this device yet.");
    return;
  }

  if (revealBox) await renderMqttCredentialReveal(revealBox, data);
};

// Only reachable for a controller that has never had credentials issued
// (e.g. a pre-migration legacy record) - the normal path is onboarding's
// save button issuing them once (see add-farm.js/farmer-onboarding.js),
// after which they're final and this button no longer shows at all
// (fetchMqttCredentials() above takes over instead). Never rotates.
window.generateInitialMqttCredentials = async function () {

  const controllerDocId = window.__currentControllerDocId;
  const revealBox = document.getElementById("mqttRevealBox");

  if (!controllerDocId) {
    alert("❌ Could not determine which controller this is. Reopen the farmer panel and try again.");
    return;
  }

  try {
    if (revealBox) revealBox.innerHTML = `<div class="mqtt-reveal-box">Issuing credentials…</div>`;

    const data = await provisionDeviceCredentials(auth, controllerDocId, { rotate: false });

    // The credential is durably stored server-side now (see
    // deviceProvisioning.js) - no separate persistence step needed here,
    // it's already in Firestore by the time this returns, and the next
    // panel open reads it straight from f.controller.mqtt.password.
    if (revealBox) await renderMqttCredentialReveal(revealBox, data);

  } catch (err) {
    console.error("MQTT provisioning error:", err);
    if (revealBox) revealBox.innerHTML = "";
    alert("❌ " + err.message);
  }
};
