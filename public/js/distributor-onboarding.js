import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  addDoc,
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import { formatDistributorId, claimNextNumber } from "/js/id-format.js";
import { prepareUpload, applyDocumentUploadSetting, DISTRIBUTOR_DOCS } from "/js/upload-prep.js";
import { DOCUMENT_UPLOADS, DOCUMENTS_REQUIRED } from "/js/config.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";
import { fmtDateTime } from "/js/time-format.js";

const storage = getStorage();

/* ================= AUTH ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= LOADER ================= */
function showLoader() {
  document.getElementById("globalLoader")?.style.setProperty("display", "flex");
}

function hideLoader() {
  document.getElementById("globalLoader")?.style.setProperty("display", "none");
}

/* ================= DOM Contnet Loader ================= */
window.addEventListener("DOMContentLoaded", () => {

  ["gstNumber", "panNumber"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase();
    });
  });

  document.getElementById("primaryMobile")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  });

  document.getElementById("aadhaarNumber")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 12);
  });

  document.getElementById("panNumber")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().slice(0, 10);
  });

  document.getElementById("gstNumber")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().slice(0, 15);
  });

});

/* ================= SAFE COUNTER ================= */
// D26FBA0001 - see id-format.js. Also the distributor's Irrigo Admin app
// login (the bridge's distributors.js checks this shape).
async function generateDistributorId() {
  const n = await claimNextNumber(db, runTransaction, doc(db, "counters", "distributorCounter"));
  return formatDistributorId(n);
}

/* ================= FILE UPLOAD ================= */
// The documents, checked and shrunk (photos -> small WebP, PDFs under 2 MB -
// see upload-prep.js). Done before the distributor ID is taken, so a wrong
// file doesn't use up a number.
const DOC_FIELDS = [
  ["gstUrl", "gstFile", "gst", "GST certificate"],
  ["panUrl", "panFile", "pan", "PAN"],
  ["aadhaarUrl", "aadhaarFile", "aadhaar", "Aadhaar"],
  ["chequeUrl", "chequeFile", "cheque", "Cancelled cheque"],
  ["msmeUrl", "msmeFile", "msme", "MSME certificate"],
  ["itrUrl", "itrFile", "itr", "ITR"],
  ["other1", "otherDoc1", "other1", "Other document 1"],
  ["other2", "otherDoc2", "other2", "Other document 2"],
  ["other3", "otherDoc3", "other3", "Other document 3"]
];

// Must be attached when DOCUMENTS_REQUIRED (config.js) - the ✱ ones.
const REQUIRED_DOCS = ["panFile", "aadhaarFile", "chequeFile"];

// Uploads off: a "hard copy collected?" checklist instead (upload-prep.js).
const docSetting = applyDocumentUploadSetting(DOCUMENT_UPLOADS, DOC_FIELDS.map((d) => d[1]), {
  card: document.getElementById("gstFile")?.closest(".fb-card"),
  checklist: DISTRIBUTOR_DOCS
});
const uploadsOn = docSetting.uploadsOn;
if (uploadsOn && DOCUMENTS_REQUIRED) document.querySelectorAll(".doc-req").forEach((el) => { el.hidden = false; });

async function prepareDocuments() {
  const out = [];
  if (!uploadsOn) return out;
  for (const [key, inputId, name, label] of DOC_FIELDS) {
    if (DOCUMENTS_REQUIRED && REQUIRED_DOCS.includes(inputId) && !document.getElementById(inputId).files[0]) {
      throw new Error(`${label} is required`);
    }
    const prepared = await prepareUpload(document.getElementById(inputId).files[0], label);
    out.push([key, name, prepared]);
  }
  return out;
}

async function uploadDocuments(distributorId, prepared) {
  const urls = {};
  for (const [key, name, p] of prepared) {
    if (!p) { urls[key] = ""; continue; }
    const fileRef = ref(storage, `distributor-documents/${distributorId}/${name}.${p.ext}`);
    await uploadBytes(fileRef, p.blob, { contentType: p.contentType });
    urls[key] = await getDownloadURL(fileRef);
  }
  return urls;
}

/* ================= REQUIRED VALIDATION ONLY ================= */
function validateFields(data) {

  if (!data.name) {
    alert("Individual / Company Name is required");
    return false;
  }

  if (!/^\d{12}$/.test(data.aadhaarNumber)) {
    alert("Aadhaar must be 12 digits");
    return false;
  }

  const phoneRegex = /^[6-9]\d{9}$/;
  if (!phoneRegex.test(data.primaryMobile)) {
    alert("Valid Phone Number required");
    return false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    alert("Valid email ID required");
    return false;
  }

  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  if (!panRegex.test(data.panNumber)) {
    alert("Valid PAN required");
    return false;
  }

 
  return true;
}

/* ================= SAVE ================= */
document.getElementById("distributorForm")
.addEventListener("submit", async (e) => {

  e.preventDefault();

  try {

    showLoader();

   const formData = {
        name: document.getElementById("name").value.trim(),
        primaryMobile: document.getElementById("primaryMobile").value.trim(),
        email: document.getElementById("email").value.trim(),
        gstNumber: document.getElementById("gstNumber").value.trim(),
        panNumber: document.getElementById("panNumber").value.trim(),
        aadhaarNumber: document.getElementById("aadhaarNumber").value.trim(),
        msmeNumber: document.getElementById("msmeNumber").value.trim(),

        // ✅ Address
        address: {
            line1: document.getElementById("addressLine1").value.trim(),
            line2: document.getElementById("addressLine2").value.trim(),
            city: document.getElementById("city").value.trim(),
            district: document.getElementById("district").value.trim(),
            state: document.getElementById("state").value.trim(),
            pincode: document.getElementById("pincode").value.trim()
        },

        // ✅ Bank
        bankDetails: {
            accountName: document.getElementById("accountName").value.trim(),
            accountNumber: document.getElementById("accountNumber").value.trim(),
            ifsc: document.getElementById("ifsc").value.trim(),
            branchLocation: document.getElementById("branchLocation").value.trim()
        }
        };

    if (!validateFields(formData)) {
      hideLoader();
      return;
    }

    let preparedDocs;
    try {
      preparedDocs = await prepareDocuments();
    } catch (fileErr) {
      hideLoader();
      alert(fileErr.message);
      return;
    }

    /* ===== DISTRIBUTOR ID ===== */
    // Taken in a transaction up front: it used to be read here and the
    // counter bumped only after the save, so two admins onboarding at once
    // could get the same ID.
    const distributorId = await generateDistributorId();

    /* ===== FILE UPLOADS ===== */
    const documents = await uploadDocuments(distributorId, preparedDocs);

    /* ===== SAVE DISTRIBUTOR ===== */
   await addDoc(collection(db, "distributors"), {
    distributorId: distributorId,
    name: formData.name,
    primaryMobile: formData.primaryMobile,
    email: formData.email,
    gstNumber: formData.gstNumber,
    panNumber: formData.panNumber,
    aadhaarNumber: formData.aadhaarNumber,
    msmeNumber: formData.msmeNumber,

    address: formData.address,
    bankDetails: formData.bankDetails,

    status: "active",
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser.uid,
    documents: documents,
    ...(uploadsOn ? {} : { hardcopies: docSetting.readHardcopies(), hardcopiesUpdatedAt: serverTimestamp() })
    });

   hideLoader();

    const createdTime = fmtDateTime(new Date());

    const successMessage =
      `Distributor Created Successfully ✅\n` +
      `Distributor ID: ${distributorId}\n` +
      `Irrigo Admin app: sign in with ${distributorId} as both ID and password (they set a new password on first login)\n` +
      `Created At: ${createdTime}`;

    sessionStorage.setItem("distSuccess", successMessage);
    window.location.href = "/admin/distributor-database.html";

  } catch (error) {

    hideLoader();
    alert(error.message);
  }

});

/* ================= BACK ================= */
window.goBack = function () {
  window.location.href = "/admin/distributor-database.html";
};