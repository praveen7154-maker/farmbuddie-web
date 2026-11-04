import { auth, db } from "/js/firebase-init.js";
import { valveConfigViewHtml } from "/js/valve-config.js";
import { nodeMappingViewHtml } from "/js/node-mapping.js";
import { hardcopyRows, FARMER_DOCS } from "/js/upload-prep.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import { doc, getDoc, collection, query, where, getDocs }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { fmtDateTime } from "/js/time-format.js";
import { loadCompany, sectionsFromView, recordDocHtml, printRecord, pdfRecord } from "/js/record-doc.js";

/* ================= AUTH GUARD ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GET FARMER DOC ID ================= */
const params = new URLSearchParams(window.location.search);
const docId = params.get("id");

const viewBox = document.getElementById("viewBox");

let currentFarmBuddieId = "";
let currentFarmer = null;      // the record, for the printed document
let currentPhoto = "";

if (!docId) {
  viewBox.innerHTML = "<p>❌ Farmer record not found.</p>";
  throw new Error("Missing document ID");
}

/* ================= LOAD FARMER ================= */
async function loadFarmer() {

  const ref = doc(db, "farmers", docId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    viewBox.innerHTML = "<p>❌ Farmer record not found.</p>";
    return;
  }

  const f = snap.data();
  currentFarmBuddieId = f.farmBuddieId || docId;
  currentFarmer = f;

  /* ===== DOCUMENT FALLBACK LOGIC ===== */
  let documentsData = f.documents || {};
  // Hard copies belong to the person: a farm made with Add Farm shows the
  // ones recorded on the farmer's other farm.
  let hardcopies = f.hardcopies || null;

  if ((!documentsData?.farmerPhotoUrl || !hardcopies) && f.primaryMobile) {
    const farmQuery = query(
      collection(db, "farmers"),
      where("primaryMobile", "==", f.primaryMobile)
    );

    const farmSnap = await getDocs(farmQuery);

    farmSnap.forEach(docSnap => {
      const farmData = docSnap.data();
      if (!documentsData?.farmerPhotoUrl && farmData.documents?.farmerPhotoUrl) {
        documentsData = farmData.documents;
      }
      if (!hardcopies && farmData.hardcopies) hardcopies = farmData.hardcopies;
    });
  }

  currentPhoto = safeUrl(documentsData?.farmerPhotoUrl);

  /* ===== RENDER VIEW ===== */
  viewBox.innerHTML = `
    <!-- FARMER IDENTITY -->
    <div class="section-title">👨‍🌾 Farmer Identity</div>

    <div style="text-align:center; margin:21px 0;">
      ${
        documentsData?.farmerPhotoUrl
          ? `<img 
              src="${esc(safeUrl(documentsData.farmerPhotoUrl))}" 
              crossorigin="anonymous"
              alt="Farmer Photo"
              style="width:160px;height:180px;object-fit:cover;border-radius:18px;border:2px solid #2e7d32;box-shadow:0 8px 22px rgba(0,0,0,0.18);"
            />`
          : `<img
              src="/assets/farmer-default.png"
              alt="Farm Buddie"
              title="No farmer photo - photo uploads are off for now"
              style="width:160px;height:180px;object-fit:contain;padding:18px;box-sizing:border-box;background:#fff;border-radius:18px;border:2px solid #2e7d32;box-shadow:0 8px 22px rgba(0,0,0,0.18);"
            />`
      }
    </div>

    <div class="info-grid">
      <div class="info-item"><b>Farm Buddie ID:</b> ${esc(f.farmBuddieId || "-")}</div>
      <div class="info-item"><b>Farm Number:</b> ${esc(f.farmNumber || "-")}</div>
      <div class="info-item"><b>Title:</b> ${esc(f.title || "-")}</div>
      <div class="info-item"><b>Name:</b> ${esc(f.name || "-")}</div>
      <div class="info-item"><b>Status:</b> ${esc(f.status || "-")}</div>
      <div class="info-item"><b>Primary Mobile:</b> ${esc(f.primaryMobile || "-")}</div>
      <div class="info-item"><b>Secondary Mobile:</b> ${esc(f.secondaryMobile || "-")}</div>
      <div class="info-item"><b>Aadhaar Number:</b> ${esc(f.aadhaarNumber || "-")}</div>
      <div class="info-item"><b>Email ID:</b> ${esc(f.emailId || "-")}</div>

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
                <b>Distributor Name:</b> ${esc(f.leadSource?.distributorName || "-")}
              </div>
            `
            : ""
        }

      <div class="info-item full"><b>Address:</b> ${esc(f.address || "-")}</div>
    </div>

<!-- FARM & APP USER DETAILS -->
    <div class="section-title">🌾 Farm & App User Details</div>
    <div class="info-grid">
      <div class="info-item full">
        <b>Farm Location:</b> ${esc(f.farmDetails?.location || "-")}
        </div>

        <div class="info-item">
          <b>Farm Latitude:</b> ${esc(f.farmDetails?.latitude || "-")}
        </div>

        <div class="info-item">
          <b>Farm Longitude:</b> ${esc(f.farmDetails?.longitude || "-")}
        </div>


    </div>

    <!-- APP USERS -->
    <div class="section-title">📱 App Access Users</div>
    <div class="info-grid">
      ${
        Array.isArray(f.appUsers) && f.appUsers.length
          ? f.appUsers.map(u => `
              <div class="info-item">
                <b>${esc(u.name || "User")}:</b> ${esc(u.mobile || "-")}
              </div>
            `).join("")
          : `<div class="info-item full">No additional app users</div>`
      }
    </div>

    <!-- DOCUMENTS -->
    ${hardcopies ? `
    <div class="section-title">📄 Hard Copy Documents</div>
    <div class="info-grid">${hardcopyRows(FARMER_DOCS, hardcopies)}</div>` : ""}

    <div class="section-title">📂 Uploaded Documents</div>
    <div class="info-grid">
      <div class="info-item">
        <b>Aadhaar File:</b> 
        ${documentsData?.aadhaarUrl
          ? `<a href="${esc(safeUrl(documentsData.aadhaarUrl))}" target="_blank" rel="noopener">View Document</a>`
          : "-"}
      </div>

      <div class="info-item">
        <b>Other Document:</b> 
        ${documentsData?.otherDocUrl
          ? `<a href="${esc(safeUrl(documentsData.otherDocUrl))}" target="_blank" rel="noopener">View Document</a>`
          : "-"}
      </div>
    </div>

    <!-- NETWORK -->
    <div class="section-title">🌐 Network Management</div>

    <div class="info-grid">
      <div class="info-item"><b>Network Type:</b> ${esc(f.network?.type || "SIM")}</div>
    </div>
    
   <!-- MCU -->
<div class="section-title">🧠 MCU / Device Mapping</div>
<div class="info-grid">
  <div class="info-item"><b>Variant:</b> ${esc(f.controller?.variant || "-")}</div>
  <div class="info-item"><b>Serial Number:</b> ${esc(f.controller?.serialNumber || "-")}</div>
  <div class="info-item full"><b>Unique Device ID:</b> ${esc(f.controller?.uniqueId || "-")}</div>

  <div class="info-item"><b>Warranty Start:</b> ${esc(f.controller?.warranty?.start || "-")}</div>
  <div class="info-item"><b>Warranty End:</b> ${esc(f.controller?.warranty?.end || "-")}</div>
</div>

<!-- MQTT -->
<div class="section-title">📡 MQTT Configuration</div>
<div class="info-grid">
  <div class="info-item full"><b>Broker URL:</b> ${esc(f.controller?.mqtt?.brokerUrl || "-")}</div>
  <div class="info-item"><b>Port:</b> ${esc(f.controller?.mqtt?.port || "-")}</div>
  <div class="info-item full"><b>Username:</b> ${esc(f.controller?.mqtt?.username || "-")}</div>
  <div class="info-item full muted-note">Password is shown once at issuance (MCU / Controller page) and is never stored — it can't be displayed here.</div>
</div>

 <!-- SIM -->
    <div class="section-title">📶 SIM Management</div>

    <div class="info-grid">
      <div class="info-item"><b>SIM Number (ICCID):</b> ${esc(f.sim?.simNumber || "-")}</div>
       <div class="info-item">
    <b>SIM MSISDN:</b>
    ${esc(f.sim?.msisdn || "-")}
  </div>

  <div class="info-item">
    <b>SIM IMSI:</b>
    ${esc(f.sim?.simImsi || "-")}
  </div>

  <div class="info-item">
    <b>SIM IMEI:</b>
    ${esc(f.sim?.imeiNumber || "-")}
  </div>
      <div class="info-item"><b>SIM Type:</b> ${esc(f.sim?.simType || "-")}</div>
      <div class="info-item"><b>Billing Cycle:</b> ${esc(f.sim?.billingCycle || "-")}</div>
      <div class="info-item"><b>SIM/AMC Activation Date:</b> ${esc(f.sim?.activationDate || "-")}</div>
    </div>

    <!-- MOTOR & TNEB CONFIG -->
<div class="section-title">⚡ Motor & TNEB Configuration</div>
<div class="info-grid">

  <!-- Motors -->
  <div class="info-item">
    <b>No of Motors:</b> ${esc(f.motorConfig?.motorCount || 0)}
  </div>

  ${
    f.motorConfig?.pumpHp?.length
      ? f.motorConfig.pumpHp.map((hp, i) => `
          <div class="info-item">
            <b>Pump ${i+1} HP:</b> ${esc(hp || "-")}
          </div>
        `).join("")
      : `<div class="info-item full">No pump configuration</div>`
  }

  <!-- Services -->
  <div class="info-item">
    <b>No of Services:</b> ${esc(f.tnebServices?.serviceCount || 0)}
  </div>

  ${
    f.tnebServices?.services?.length
      ? f.tnebServices.services.map(service => `
          <div class="info-item">
            <b>Service ${esc(service.serviceNumber)} HP:</b> ${esc(service.sanctionedHp || "-")}
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
                <b>Pump ${esc(map.pumpNumber)} (${esc(map.hp)}) →</b> Service ${esc(map.service)}
              </div>
            `).join("")
          : `<div class="info-item full">No mapping data</div>`
      }
    </div>

    <!-- VALVE CONFIG + ADDITIONAL FEATURES (see valve-config.js) -->
    ${valveConfigViewHtml(f.valveConfig)}
    ${nodeMappingViewHtml(f.nodes)}

    <!-- TIMESTAMPS -->
    <div class="section-title">⏱ Record Info</div>
    <div class="info-grid">
      <div class="info-item">
        <b>Created At:</b>
        ${fmtDateTime(f.createdAt)}
      </div>
      <div class="info-item">
        <b>Last Updated:</b>
        ${fmtDateTime(f.updatedAt)}
      </div>
    </div>
  `;
}

loadFarmer();

/* ================= PRINT / PDF ================= */
// A proper A4 farmer record (letterhead, reference, tables) - the same
// document for both. See record-doc.js.
async function farmerDoc() {
  const f = currentFarmer;
  if (!f) return null;
  const company = await loadCompany();
  return recordDocHtml({
    title: "FARMER RECORD",
    refLabel: "Farm Buddie ID",
    ref: f.farmBuddieId || docId,
    meta: [
      ["Farmer", [f.title, f.name].filter(Boolean).join(" ")],
      ["Farm number", f.farmNumber],
      ["Device ID", f.controller?.uniqueId],
      ["Status", f.status]
    ],
    photoUrl: currentPhoto,
    sections: sectionsFromView(viewBox),
    company,
    signLeft: "Farmer's signature"
  });
}
const fileName = () => `Farmer_${String(currentFarmBuddieId || "record").replace(/[^\w-]+/g, "_")}`;
window.printFarmer = async function () {
  const html = await farmerDoc();
  if (html) printRecord(html, fileName());
};
window.downloadPDF = async function () {
  const html = await farmerDoc();
  if (html) await pdfRecord(html, `${fileName()}.pdf`);
};

// Record fields (typed in by whoever onboarded the farm / distributor) are
// never inserted as HTML; links only as http(s). Declarations, so usable
// from anywhere in this file.
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function safeUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : ""; }
