import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  doc,
  getDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

const storage = getStorage();
const MAX_SIZE = 2 * 1024 * 1024;

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

/* ================= GET DOC ID ================= */
const urlParams = new URLSearchParams(window.location.search);
const distributorDocId = urlParams.get("id");

if (!distributorDocId) {
  alert("Invalid Distributor");
  window.location.href = "/admin/distributor-database.html";
}

/* ================= LOAD DISTRIBUTOR ================= */
async function loadDistributor() {

  const docRef = doc(db, "distributors", distributorDocId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) {
    alert("Distributor not found");
    return window.location.href = "/admin/distributor-database.html";
  }

  const d = snap.data();

  // 🔹 Basic
  document.getElementById("distributorId").value = d.distributorId || "";
  document.getElementById("name").value = d.name || "";
  document.getElementById("primaryMobile").value = d.primaryMobile || "";
  document.getElementById("email").value = d.email || "";
  document.getElementById("gstNumber").value = d.gstNumber || "";
  document.getElementById("panNumber").value = d.panNumber || "";
  document.getElementById("aadhaarNumber").value = d.aadhaarNumber || "";
  document.getElementById("msmeNumber").value = d.msmeNumber || "";

  // 🔹 Address
  document.getElementById("addressLine1").value = d.address?.line1 || "";
  document.getElementById("addressLine2").value = d.address?.line2 || "";
  document.getElementById("city").value = d.address?.city || "";
  document.getElementById("district").value = d.address?.district || "";
  document.getElementById("state").value = d.address?.state || "";
  document.getElementById("pincode").value = d.address?.pincode || "";

  // 🔹 Bank
  document.getElementById("accountName").value = d.bankDetails?.accountName || "";
  document.getElementById("accountNumber").value = d.bankDetails?.accountNumber || "";
  document.getElementById("ifsc").value = d.bankDetails?.ifsc || "";
  document.getElementById("branchLocation").value = d.bankDetails?.branchLocation || "";
}

/* ================= VALIDATION ================= */
function validateFields(data) {

  if (!data.name) {
    alert("Individual / Company Name is required");
    return false;
  }

  /* ================= HARD INPUT RESTRICTION ================= */

    // Phone – digits only, max 10
    document.getElementById("primaryMobile")?.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
    });

    // Aadhaar – digits only, max 12
    document.getElementById("aadhaarNumber")?.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 12);
    });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    alert("Valid Gmail required");
    return false;
  }

  /* ================= PAN HARD RESTRICTION ================= */
  document.getElementById("panNumber")?.addEventListener("input", (e) => {
    e.target.value = e.target.value
      .toUpperCase()          // force uppercase
      .replace(/[^A-Z0-9]/g, "")  // remove special characters
      .slice(0, 10);          // limit to 10 chars
  });

  return true;
}

/* ================= FILE UPLOAD ================= */
async function uploadFile(distributorId, file, fileName) {

  if (!file) return null;

  if (file.size > MAX_SIZE) {
    throw new Error(`${fileName} exceeds 2MB`);
  }

  if (!["application/pdf", "image/jpeg"].includes(file.type)) {
    throw new Error(`${fileName} must be PDF or JPG`);
  }

  const fileRef = ref(
    storage,
    `distributor-documents/${distributorId}/${fileName}`
  );

  await uploadBytes(fileRef, file);
  return await getDownloadURL(fileRef);
}

/* ================= UPDATE ================= */
document.getElementById("distributorForm")
.addEventListener("submit", async (e) => {

  e.preventDefault();

  try {

    showLoader();

    const docRef = doc(db, "distributors", distributorDocId);
    const snap = await getDoc(docRef);
    const existingData = snap.data();

    const formData = {
      name: document.getElementById("name").value.trim(),
      primaryMobile: document.getElementById("primaryMobile").value.trim(),
      email: document.getElementById("email").value.trim(),
      gstNumber: document.getElementById("gstNumber").value.trim(),
      panNumber: document.getElementById("panNumber").value.trim(),
      aadhaarNumber: document.getElementById("aadhaarNumber").value.trim(),
      msmeNumber: document.getElementById("msmeNumber").value.trim()
    };

    if (!validateFields(formData)) {
      hideLoader();
      return;
    }

    const distributorId = existingData.distributorId;

    const updatedDocuments = { ...existingData.documents };

    const gstFile = document.getElementById("gstFile").files[0];
    const panFile = document.getElementById("panFile").files[0];
    const aadhaarFile = document.getElementById("aadhaarFile").files[0];
    const chequeFile = document.getElementById("chequeFile").files[0];
    const msmeFile = document.getElementById("msmeFile").files[0];
    const itrFile = document.getElementById("itrFile").files[0];
    const other1 = document.getElementById("otherDoc1").files[0];
    const other2 = document.getElementById("otherDoc2").files[0];
    const other3 = document.getElementById("otherDoc3").files[0];

    if (gstFile) updatedDocuments.gstUrl = await uploadFile(distributorId, gstFile, "gst.pdf");
    if (panFile) updatedDocuments.panUrl = await uploadFile(distributorId, panFile, "pan.pdf");
    if (aadhaarFile) updatedDocuments.aadhaarUrl = await uploadFile(distributorId, aadhaarFile, "aadhaar.pdf");
    if (chequeFile) updatedDocuments.chequeUrl = await uploadFile(distributorId, chequeFile, "cheque.pdf");
    if (msmeFile) updatedDocuments.msmeUrl = await uploadFile(distributorId, msmeFile, "msme.pdf");
    if (itrFile) updatedDocuments.itrUrl = await uploadFile(distributorId, itrFile, "itr.pdf");
    if (other1) updatedDocuments.other1 = await uploadFile(distributorId, other1, "other1.pdf");
    if (other2) updatedDocuments.other2 = await uploadFile(distributorId, other2, "other2.pdf");
    if (other3) updatedDocuments.other3 = await uploadFile(distributorId, other3, "other3.pdf");

    await updateDoc(docRef, {
  ...formData,

  address: {
    line1: document.getElementById("addressLine1").value.trim(),
    line2: document.getElementById("addressLine2").value.trim(),
    city: document.getElementById("city").value.trim(),
    district: document.getElementById("district").value.trim(),
    state: document.getElementById("state").value.trim(),
    pincode: document.getElementById("pincode").value.trim()
  },

  bankDetails: {
    accountName: document.getElementById("accountName").value.trim(),
    accountNumber: document.getElementById("accountNumber").value.trim(),
    ifsc: document.getElementById("ifsc").value.trim(),
    branchLocation: document.getElementById("branchLocation").value.trim()
  },

  documents: updatedDocuments,
  updatedAt: serverTimestamp(),
  updatedBy: auth.currentUser.uid
});
   hideLoader();

    const updatedTime = new Date().toLocaleString();

    alert(
      `Distributor Updated Successfully ✅\n` +
      `Distributor ID: ${existingData.distributorId}\n` +
      `Updated At: ${updatedTime}`
    );

    window.location.href = "/admin/distributor-database.html";
  } catch (error) {
    hideLoader();
    alert(error.message);
  }

});

// 🔥 VERY IMPORTANT
loadDistributor();

/* ================= BACK ================= */
window.goBack = function () {
  window.location.href = "/admin/distributor-database.html";
};

/* ================= HARD INPUT RESTRICTION ================= */

window.addEventListener("DOMContentLoaded", () => {

  const phoneInput = document.getElementById("primaryMobile");
  const aadhaarInput = document.getElementById("aadhaarNumber");

  if (phoneInput) {
    phoneInput.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
    });
  }

  if (aadhaarInput) {
    aadhaarInput.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 12);
    });
  }

  /* ================= GST HARD RESTRICTION ================= */
document.getElementById("gstNumber")?.addEventListener("input", (e) => {
  e.target.value = e.target.value
    .toUpperCase()               // force uppercase
    .replace(/[^A-Z0-9]/g, "")   // remove special characters
    .slice(0, 15);               // limit to 15 characters
});

});