import { db } from "/js/firebase-init.js";
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

const params = new URLSearchParams(window.location.search);
const id = params.get("id");

let existingDocuments = {};
let employeeIdValue = "";

if (!id) {
  alert("Invalid Employee");
  window.location.href = "/admin/hr/employee-list.html";
}

/* ================= LOAD EMPLOYEE ================= */
async function loadEmployee() {

  const snap = await getDoc(doc(db, "employees", id));

  if (!snap.exists()) {
    alert("Employee not found");
    return;
  }

  const e = snap.data();

  employeeIdValue = e.employeeId;
  existingDocuments = e.documents || {};

  // 🔥 BASIC
  empId.value = e.employeeId;
  empName.value = e.name;
  empEmail.value = e.email;
  empMobile.value = e.mobile;
  empRole.value = e.role;
  empDepartment.value = e.department;
  empJoiningDate.value = e.joiningDate;

  // 🔥 BANK
  bankHolder.value = e.bank?.accountHolder || "";
  bankAccountNo.value = e.bank?.accountNumber || "";
  bankIfsc.value = e.bank?.ifsc || "";
  bankNameInput.value = e.bank?.bankName || "";

  // 🔥 DOCUMENT PREVIEW
  showExistingDocuments();
}

loadEmployee();

/* ================= SHOW EXISTING DOCUMENTS ================= */
function showExistingDocuments() {

  const docContainer = document.getElementById("existingDocs");
  if (!docContainer) return;

  docContainer.innerHTML = "";

  Object.keys(existingDocuments).forEach(key => {

    const d = existingDocuments[key];

    docContainer.innerHTML += `
      <div style="margin-bottom:8px;">
        <a href="${d.url}" target="_blank">
          ${key} - View
        </a>
      </div>
    `;
  });
}

/* ================= UPLOAD FILE IF REPLACED ================= */
async function uploadIfNew(fileInput, key) {

  const file = fileInput?.files[0];

  if (!file) return existingDocuments[key] || null;

  const extension = file.name.split(".").pop();

  const storageRef = ref(
    storage,
    `hr-documents/${employeeIdValue}/${key}.${extension}`
  );

  await uploadBytes(storageRef, file);

  const url = await getDownloadURL(storageRef);

  return {
    url,
    fileName: file.name,
    uploadedAt: new Date()
  };
}

/* ================= UPDATE EMPLOYEE ================= */
window.updateEmployee = async function () {

  try {

    const updatedDocuments = { ...existingDocuments };

    // 🔥 Replace if new file uploaded
    updatedDocuments.aadhaar = await uploadIfNew(docAadhaar, "aadhaar");
    updatedDocuments.pan = await uploadIfNew(docPan, "pan");
    updatedDocuments.photo = await uploadIfNew(docPhoto, "photo");
    updatedDocuments.experience = await uploadIfNew(docExperience, "experience");
    updatedDocuments.degree = await uploadIfNew(docDegree, "degree");
    updatedDocuments.payslip = await uploadIfNew(docPayslip, "payslip");
    updatedDocuments.other1 = await uploadIfNew(docOther1, "other1");
    updatedDocuments.other2 = await uploadIfNew(docOther2, "other2");
    updatedDocuments.accountStatement = await uploadIfNew(docAccountStatement, "accountStatement");

    await updateDoc(doc(db, "employees", id), {

      name: empName.value.trim(),
      email: empEmail.value.trim(),
      mobile: empMobile.value.trim(),
      role: empRole.value,
      department: empDepartment.value,
      joiningDate: empJoiningDate.value,

      bank: {
        accountHolder: bankHolder.value.trim(),
        accountNumber: bankAccountNo.value.trim(),
        ifsc: bankIfsc.value.trim(),
        bankName: bankNameInput.value.trim()
      },

      documents: updatedDocuments,

      updatedAt: serverTimestamp()
    });

    alert("✅ Employee updated successfully");

    window.location.href = "/admin/hr/employee-list.html";

  } catch (error) {

    console.error(error);
    alert("Error updating employee");
  }
};