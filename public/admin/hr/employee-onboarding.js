import { auth, db } from "/js/firebase-init.js";
import {
  collection,
  addDoc,
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

const storage = getStorage();
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/* ================= MOBILE VALIDATION ================= */
document.getElementById("empMobile").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
});

/* ================= GENERATE EMPLOYEE ID ================= */
async function generateEmployeeId() {

  const counterRef = doc(db, "counters", "employees");

  return await runTransaction(db, async (tx) => {

    const snap = await tx.get(counterRef);
    let current = snap.exists() ? snap.data().current || 0 : 0;

    current++;

    tx.set(counterRef, { current }, { merge: true });

    return `FB${String(current).padStart(5, "0")}`; // FB00001
  });
}

/* ================= FILE VALIDATION ================= */
function validateFile(file) {

  if (!file) return true;

  const allowed = ["application/pdf", "image/jpeg"];
  if (!allowed.includes(file.type)) {
    alert("Only PDF and JPG allowed");
    return false;
  }

  if (file.size > MAX_FILE_SIZE) {
    alert("File must be under 2MB");
    return false;
  }

  return true;
}

/* ================= UPLOAD DOCUMENT ================= */
async function uploadDocument(file, employeeId, name) {

  if (!file) return null;

  const extension = file.name.split('.').pop();

  const storageRef = ref(
    storage,
    `hr-documents/${employeeId}/${name}.${extension}`
  );

  await uploadBytes(storageRef, file);

  return await getDownloadURL(storageRef);
}

/* ================= SAVE EMPLOYEE ================= */
window.saveEmployee = async function () {

  const name = empName.value.trim();
  const email = empEmail.value.trim();
  const mobile = empMobile.value.trim();
  const role = empRole.value;
  const department = empDepartment.value;
  const joiningDate = empJoiningDate.value;

  const bankAccountHolder = bankHolder.value.trim();
  const bankAccountNumber = bankAccountNo.value.trim();
  const bankIFSC = bankIfsc.value.trim();
  const bankName = bankNameInput.value.trim();

  if (!name || !email || !mobile || !role || !department || !joiningDate) {
    alert("Fill all mandatory fields");
    return;
  }

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    alert("Invalid Indian mobile number");
    return;
  }

  try {

    const employeeId = await generateEmployeeId();

    const files = {
      aadhaar: docAadhaar?.files[0],
      pan: docPan?.files[0],
      photo: docPhoto?.files[0],
      experience: docExperience?.files[0],
      degree: docDegree?.files[0],
      payslip: docPayslip?.files[0],
      other1: docOther1?.files[0],
      other2: docOther2?.files[0],
      accountStatement: docAccountStatement?.files[0]
    };

    const uploadedDocs = {};

    for (let key in files) {

      const file = files[key];
      if (!file) continue;

      if (!validateFile(file)) return;

      try {
        const url = await uploadDocument(file, employeeId, key);

        uploadedDocs[key] = {
          url,
          fileName: file.name,
          uploadedAt: new Date().toISOString()
        };

      } catch (uploadErr) {
        console.error("Upload failed for:", key, uploadErr);
      }
    }

    await addDoc(collection(db, "employees"), {

      employeeId,
      name,
      email,
      mobile,
      role,
      department,
      joiningDate,

      bank: {
        accountHolder: bankAccountHolder || "",
        accountNumber: bankAccountNumber || "",
        ifsc: bankIFSC || "",
        bankName: bankName || ""
      },

      documents: uploadedDocs || {},

      status: "active",

      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.uid || null
    });

    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    alert(`✅ Employee Onboarded successfully\n
      Employee ID: ${employeeId}\n
      Created at: ${time}`);

    window.location.href = "/admin/hr/employee-list.html";

  } catch (error) {

    console.error("Save error:", error);
    alert("Error creating employee. Check console.");
  }
};