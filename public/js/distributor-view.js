import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ================= AUTH ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GET DOC ID ================= */
const params = new URLSearchParams(window.location.search);
const docId = params.get("id");

const viewBox = document.getElementById("viewBox");

let currentDistributorId = "";

if (!docId) {
  viewBox.innerHTML = "<p>❌ Distributor record not found.</p>";
  throw new Error("Missing document ID");
}

/* ================= LOAD DISTRIBUTOR ================= */
async function loadDistributor() {

  const ref = doc(db, "distributors", docId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    viewBox.innerHTML = "<p>❌ Distributor record not found.</p>";
    return;
  }

  const d = snap.data();
  currentDistributorId = d.distributorId || docId;

  viewBox.innerHTML = `

    <div class="section-title">🏢 Basic Distributor Details</div>
    <div class="info-grid">
      <div class="info-item"><b>Distributor ID:</b> ${d.distributorId || "-"}</div>
      <div class="info-item"><b>Status:</b> ${d.status || "-"}</div>
      <div class="info-item"><b>Name:</b> ${d.name || "-"}</div>
      <div class="info-item"><b>Phone:</b> ${d.primaryMobile || "-"}</div>
      <div class="info-item"><b>Email:</b> ${d.email || "-"}</div>
      <div class="info-item"><b>GST:</b> ${d.gstNumber || "-"}</div>
      <div class="info-item"><b>PAN:</b> ${d.panNumber || "-"}</div>
      <div class="info-item"><b>Aadhaar:</b> ${d.aadhaarNumber || "-"}</div>
      <div class="info-item"><b>MSME:</b> ${d.msmeNumber || "-"}</div>
    </div>

    <div class="section-title">📍 Company Address</div>
  <div class="info-grid">
  <div class="info-item full">
    <b>Address:</b> 
    ${
      [
        d.address?.line1,
        d.address?.line2,
        d.address?.city,
        d.address?.district,
        d.address?.state
      ]
        .filter(Boolean)
        .join(", ")
    }
    ${d.address?.pincode ? " - " + d.address.pincode : ""}
  </div>
</div>

      <div class="section-title">🏦 Bank Details</div>
      <div class="info-grid">
        <div class="info-item"><b>Account Holder:</b> ${d.bankDetails?.accountName || "-"}</div>
        <div class="info-item"><b>Account Number:</b> ${d.bankDetails?.accountNumber || "-"}</div>
        <div class="info-item"><b>IFSC:</b> ${d.bankDetails?.ifsc || "-"}</div>
        <div class="info-item"><b>Branch:</b> ${d.bankDetails?.branchLocation || "-"}</div>
      </div>

    <div class="section-title">📂 Uploaded Documents</div>
    <div class="info-grid">

      ${renderDoc("GST Certificate", d.documents?.gstUrl)}
      ${renderDoc("PAN Card", d.documents?.panUrl)}
      ${renderDoc("Aadhaar", d.documents?.aadhaarUrl)}
      ${renderDoc("Cancelled Cheque", d.documents?.chequeUrl)}
      ${renderDoc("MSME Certificate", d.documents?.msmeUrl)}
      ${renderDoc("ITR", d.documents?.itrUrl)}
      ${renderDoc("Other Document 1", d.documents?.other1)}
      ${renderDoc("Other Document 2", d.documents?.other2)}
      ${renderDoc("Other Document 3", d.documents?.other3)}

    </div>

    <div class="section-title">⏱ Record Info</div>
    <div class="info-grid">
      <div class="info-item">
        <b>Created At:</b>
        ${d.createdAt?.toDate()?.toLocaleString() || "-"}
      </div>
    </div>

  `;
}

function renderDoc(label, url) {
  return `
    <div class="info-item">
      <b>${label}:</b>
      ${url ? `<a href="${url}" target="_blank">View Document</a>` : "-"}
    </div>
  `;
}

loadDistributor();

/* ================= PRINT ================= */
window.printDistributor = function () {
  window.print();
};

/* ================= PDF ================= */
window.downloadPDF = async function () {

  const element = document.getElementById("viewBox");

  const opt = {
    margin: 10,
    filename: `${currentDistributorId || "Distributor_Details"}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save();
};