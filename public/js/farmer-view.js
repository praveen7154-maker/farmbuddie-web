import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import { doc, getDoc, collection, query, where, getDocs }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

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

  /* ===== DOCUMENT FALLBACK LOGIC ===== */
  let documentsData = f.documents || {};

  if (!documentsData?.farmerPhotoUrl && f.primaryMobile) {
    const farmQuery = query(
      collection(db, "farmers"),
      where("primaryMobile", "==", f.primaryMobile)
    );

    const farmSnap = await getDocs(farmQuery);

    farmSnap.forEach(docSnap => {
      const farmData = docSnap.data();
      if (farmData.documents?.farmerPhotoUrl) {
        documentsData = farmData.documents;
      }
    });
  }

  /* ===== RENDER VIEW ===== */
  viewBox.innerHTML = `
    <!-- FARMER IDENTITY -->
    <div class="section-title">👨‍🌾 Farmer Identity</div>

    <div style="text-align:center; margin:21px 0;">
      ${
        documentsData?.farmerPhotoUrl
          ? `<img 
              src="${documentsData.farmerPhotoUrl}" 
              crossorigin="anonymous"
              alt="Farmer Photo"
              style="width:160px;height:180px;object-fit:cover;border-radius:18px;border:2px solid #2e7d32;box-shadow:0 8px 22px rgba(0,0,0,0.18);"
            />`
          : `<div style="width:160px;height:180px;border-radius:18px;border:2px dashed #bbb;display:flex;align-items:center;justify-content:center;font-size:14px;color:#777;background:#f5f5f5;">
              No Photo Available
            </div>`
      }
    </div>

    <div class="info-grid">
      <div class="info-item"><b>Farm Buddie ID:</b> ${f.farmBuddieId || "-"}</div>
      <div class="info-item"><b>Farm Number:</b> ${f.farmNumber || "-"}</div>
      <div class="info-item"><b>Title:</b> ${f.title || "-"}</div>
      <div class="info-item"><b>Name:</b> ${f.name || "-"}</div>
      <div class="info-item"><b>Status:</b> ${f.status || "-"}</div>
      <div class="info-item"><b>Primary Mobile:</b> ${f.primaryMobile || "-"}</div>
      <div class="info-item"><b>Secondary Mobile:</b> ${f.secondaryMobile || "-"}</div>
      <div class="info-item"><b>Aadhaar Number:</b> ${f.aadhaarNumber || "-"}</div>
      <div class="info-item"><b>Email ID:</b> ${f.emailId || "-"}</div>

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

    <!-- DOCUMENTS -->
    <div class="section-title">📂 Uploaded Documents</div>
    <div class="info-grid">~
      <div class="info-item">
        <b>Aadhaar File:</b> 
        ${documentsData?.aadhaarUrl
          ? `<a href="${documentsData.aadhaarUrl}" target="_blank">View Document</a>`
          : "-"}
      </div>

      <div class="info-item">
        <b>Other Document:</b> 
        ${documentsData?.otherDocUrl
          ? `<a href="${documentsData.otherDocUrl}" target="_blank">View Document</a>`
          : "-"}
      </div>
    </div>

    <!-- NETWORK -->
    <div class="section-title">🌐 Network Management</div>

    <div class="info-grid">
      <div class="info-item"><b>Network Type:</b> ${f.network?.type || "SIM"}</div>
    </div>
    
   <!-- MCU -->
<div class="section-title">🧠 MCU / Device Mapping</div>
<div class="info-grid">
  <div class="info-item"><b>Variant:</b> ${f.controller?.variant || "-"}</div>
  <div class="info-item"><b>Serial Number:</b> ${f.controller?.serialNumber || "-"}</div>
  <div class="info-item full"><b>Unique Device ID:</b> ${f.controller?.uniqueId || "-"}</div>

  <div class="info-item"><b>Warranty Start:</b> ${f.controller?.warranty?.start || "-"}</div>
  <div class="info-item"><b>Warranty End:</b> ${f.controller?.warranty?.end || "-"}</div>
</div>

<!-- MQTT -->
<div class="section-title">📡 MQTT Configuration</div>
<div class="info-grid">
  <div class="info-item full"><b>Broker URL:</b> ${f.controller?.mqtt?.brokerUrl || "-"}</div>
  <div class="info-item"><b>Port:</b> ${f.controller?.mqtt?.port || "-"}</div>
  <div class="info-item full"><b>Username:</b> ${f.controller?.mqtt?.username || "-"}</div>
  <div class="info-item full muted-note">Password is shown once at issuance (MCU / Controller page) and is never stored — it can't be displayed here.</div>
</div>

 <!-- SIM -->
    <div class="section-title">📶 SIM Management</div>

    <div class="info-grid">
      <div class="info-item"><b>SIM Number (ICCID):</b> ${f.sim?.simNumber || "-"}</div>
       <div class="info-item">
    <b>SIM MSISDN:</b>
    ${f.sim?.msisdn || "-"}
  </div>

  <div class="info-item">
    <b>SIM IMSI:</b>
    ${f.sim?.simImsi || "-"}
  </div>

  <div class="info-item">
    <b>SIM IMEI:</b>
    ${f.sim?.imeiNumber || "-"}
  </div>
      <div class="info-item"><b>SIM Type:</b> ${f.sim?.simType || "-"}</div>
      <div class="info-item"><b>Billing Cycle:</b> ${f.sim?.billingCycle || "-"}</div>
      <div class="info-item"><b>SIM/AMC Activation Date:</b> ${f.sim?.activationDate || "-"}</div>
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

  <!-- Always show 24V -->
  <div class="info-item">
    <b>24V AC Valves:</b> ${f.valveConfig?.valve24Count ?? 0}
  </div>

  ${
    f.controller?.variant === "IRRIGO_PLUS"
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
}

loadFarmer();

/* ================= PRINT ================= */
window.printFarmer = function () {
  window.print();
};

/* ================= PDF ================= */
window.downloadPDF = async function () {

  const element = document.getElementById("viewBox");

  const images = element.querySelectorAll("img");
  await Promise.all(
    Array.from(images).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    })
  );

  const opt = {
    margin: 10,
    filename: `${currentFarmBuddieId || "Farmer_Details"}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save();
};
