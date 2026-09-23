import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  addDoc,
  doc,
  runTransaction,
  serverTimestamp,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

const storage = getStorage();
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

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
async function generateDistributorId() {

  const counterRef = doc(db, "counters", "distributorCounter");

  return await runTransaction(db, async (tx) => {

    const snap = await tx.get(counterRef);

    let current = snap.exists() ? snap.data().current || 0 : 0;

    current += 1;

    tx.set(counterRef, { current }, { merge: true });

    return `FB-DIST-${String(current).padStart(4, "0")}`;
  });
}

/* ================= FILE UPLOAD ================= */
async function uploadFile(distributorId, file, fileName) {

  if (!file) return "";

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

/* ================= REQUIRED VALIDATION ONLY ================= */
function validateFields(data) {

  if (!data.name) {
    alert("Individual / Company Name is required");
    return false;
  }

  if (!data.aadhaarNumber) {
    alert("Aadhaar is required");
    return false;
  }

  const phoneRegex = /^[6-9]\d{9}$/;
  if (!phoneRegex.test(data.primaryMobile)) {
    alert("Valid Phone Number required");
    return false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    alert("Valid Gmail required");
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

    /* ===== PREVIEW DISTRIBUTOR ID (NO COUNTER UPDATE YET) ===== */
    const counterRef = doc(db, "counters", "distributorCounter");
    const snap = await getDoc(counterRef);

    let current = snap.exists() ? snap.data().current || 0 : 0;
    const next = current + 1;

    const distributorId = `FB-DIST-${String(next).padStart(4, "0")}`;

    /* ===== FILE UPLOADS ===== */
    const documents = {
      gstUrl: await uploadFile(distributorId, document.getElementById("gstFile").files[0], "gst.pdf"),
      panUrl: await uploadFile(distributorId, document.getElementById("panFile").files[0], "pan.pdf"),
      aadhaarUrl: await uploadFile(distributorId, document.getElementById("aadhaarFile").files[0], "aadhaar.pdf"),
      chequeUrl: await uploadFile(distributorId, document.getElementById("chequeFile").files[0], "cheque.pdf"),
      msmeUrl: await uploadFile(distributorId, document.getElementById("msmeFile").files[0], "msme.pdf"),
      itrUrl: await uploadFile(distributorId, document.getElementById("itrFile").files[0], "itr.pdf"),
      other1: await uploadFile(distributorId, document.getElementById("otherDoc1").files[0], "other1.pdf"),
      other2: await uploadFile(distributorId, document.getElementById("otherDoc2").files[0], "other2.pdf"),
      other3: await uploadFile(distributorId, document.getElementById("otherDoc3").files[0], "other3.pdf")
    };

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
    documents: documents
    });

    /* ===== UPDATE COUNTER ONLY AFTER SUCCESS ===== */
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      let current = snap.exists() ? snap.data().current || 0 : 0;
      tx.set(counterRef, { current: current + 1 }, { merge: true });
    });

   hideLoader();

    const createdTime = new Date().toLocaleString();

    const successMessage =
      `Distributor Created Successfully ✅\n` +
      `Distributor ID: ${distributorId}\n` +
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