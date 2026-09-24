import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  setDoc,
  query,
  where,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ✅ ADD STORAGE IMPORT */
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

import {
  fullPhoneSync,
  validatePhones
 } from "/js/phone-auth.js";

import { provisionDeviceCredentials, showMqttCredentialModal } from "/js/provisioning.js";

/* ✅ INITIALIZE STORAGE */
const storage = getStorage();

/* ================= IMAGE COMPRESSION ================= */
async function compressImage(file) {

  const bitmap = await createImageBitmap(file);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const maxWidth = 800;
  const scale = maxWidth / bitmap.width;

  canvas.width = maxWidth;
  canvas.height = bitmap.height * scale;

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return new Promise(resolve => {
    canvas.toBlob(
      blob => resolve(blob),
      "image/webp",
      0.7
    );
  });
}

/* ================= AUTH ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= NETWORK TYPE HANDLER (NEW - SAFE ADD) ================= */
window.handleNetworkType = function () {

  const type = document.getElementById("networkType")?.value;
  if (!type) return;

  const fields = document.querySelectorAll(".network-field input, .network-field select");

  if (type === "WIFI_FARMER") {
    fields.forEach(field => {
      if (field.id !== "activationDate") {
        field.disabled = true;
        field.value = "";
      }
    });
  }

  if (type === "SIM") {
    fields.forEach(field => {
      field.disabled = false;
    });
  }
};


/* ================= ELEMENTS ================= */
const title = document.getElementById("title");
const farmerName = document.getElementById("farmerName");
const primaryMobile = document.getElementById("primaryMobile");
const secondaryMobile = document.getElementById("secondaryMobile");
const aadhaarNumber = document.getElementById("aadhaarNumber");
const emailId = document.getElementById("emailId");
const leadSourceType = document.getElementById("leadSourceType");
const distributorSelect = document.getElementById("distributorSelect");
const address = document.getElementById("address");

const farmLocation = document.getElementById("farmLocation");
const farmLatitude = document.getElementById("farmLatitude");
const farmLongitude = document.getElementById("farmLongitude");
const farmerPhotoInput = document.getElementById("farmerPhoto");

const appUser2Name = document.getElementById("appUser2Name");
const appUser2Mobile = document.getElementById("appUser2Mobile");
const appUser3Name = document.getElementById("appUser3Name");
const appUser3Mobile = document.getElementById("appUser3Mobile");

const networktype = document.getElementById("networkType");
const simType = document.getElementById("simType");
const simNumberInput = document.getElementById("simNumber");
const simMsisdnInput = document.getElementById("simMsisdn");
const simImsiInput = document.getElementById("simImsi");
const simImeiInput = document.getElementById("simImei");
const billingCycle = document.getElementById("billingCycle");
const activationDate = document.getElementById("activationDate");

const mcuVariant = document.getElementById("mcuVariant");
const serialField = document.getElementById("serialField");
const mcuSerial = document.getElementById("mcuSerial");
const mcuSerialList = document.getElementById("mcuSerialList");
const warrantyStart = document.getElementById("warrantyStart");
const warrantyEnd = document.getElementById("warrantyEnd");

/* ================= LOADER FUNCTIONS ================= */
function showLoader() {
  const loader = document.getElementById("globalLoader");
  if (loader) loader.style.display = "flex";
}

function hideLoader() {
  const loader = document.getElementById("globalLoader");
  if (loader) loader.style.display = "none";
}

/* ================= WARRANTY ================= */
window.calculateWarrantyEnd = function () {
  if (!warrantyStart.value) {
    warrantyEnd.value = "";
    return;
  }
  const d = new Date(warrantyStart.value);
  d.setFullYear(d.getFullYear() + 1);
  warrantyEnd.value = d.toISOString().split("T")[0];
};

/* =================GENERATE FARM BUDDIE ID ================= */
async function previewNextFarmBuddieId() {

  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", "farmers");

  const snap = await getDoc(counterRef);

  let current = snap.exists()
    ? snap.data().current || 0
    : 0;

  const next = current + 1;

  return {
    farmBuddieId: `FARM-${year}-${String(next).padStart(4, "0")}`,
    nextCounter: next
  };
}

async function commitFarmCounter(nextValue) {

  const counterRef = doc(db, "counters", "farmers");

  await setDoc(counterRef, {
    current: nextValue
  }, { merge: true });
}
/* ================= MCU VARIANT → SERIAL ================= */
window.handleMcuVariant = async function () {
  const variant = mcuVariant.value;

  mcuSerial.value = "";
  mcuSerialList.innerHTML = "";
  serialField.style.display = "none";
  if (!variant) return;

  serialField.style.display = "block";

  try {
    const q = query(
      collection(db, "controllers"),
      where("variant", "==", variant),
      where("status", "==", "available")
    );

    const snap = await getDocs(q);
    const serials = [];

    snap.forEach(d => {
      const c = d.data();

      if (
        c.serialNumber &&
        c.status &&
        c.status.toLowerCase() === "available"
      ) {
        serials.push(c.serialNumber);
      }
    });

    [...new Set(serials)]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach(sn => {
        const opt = document.createElement("option");
        opt.value = sn;
        mcuSerialList.appendChild(opt);
      });

  } catch (err) {
    console.error("MCU load error:", err);
    alert("❌ Failed to load MCU serial numbers");
  }
  handleVariantMotorValve();
};

/* ================= HP OPTIONS ================= */
const hpOptions = [
  "3 HP",
  "5 HP",
  "7.5 HP",
  "10 HP",
  "12.5 HP",
  "15 HP",
  "20 HP",
  "25 HP",
  "30 HP",
  "40 HP",
  "50 HP"
];

/************************************************************
 * EXTENDED VARIANT LOGIC - MOTOR & VALVE CONFIG
 ************************************************************/
function handleVariantMotorValve() {

  const variant = document.getElementById("mcuVariant").value;

  const motorSection = document.getElementById("motorConfigSection");
  const valveSection = document.getElementById("valveConfigSection");
  const motorSelect = document.getElementById("motorCount");
  const valve9Field = document.getElementById("valve9Field");
  const irrigoPlusExtras = document.getElementById("irrigoPlusExtras");
  if (irrigoPlusExtras) irrigoPlusExtras.style.display = "none";

  if (!motorSection || !valveSection) return;

  motorSection.style.display = "none";
  valveSection.style.display = "none";

  motorSelect.innerHTML = "";

  if (!variant) return;

 if (variant === "IRRIGO" || variant === "IRRIGO_PLUS") {
  motorSection.style.display = "block";
  valveSection.style.display = "block";
}
  /* ===== IRRIGO ===== */
  if (variant === "IRRIGO") {

    ["1 Pump", "2 Pump"].forEach((label, i) => {
      const opt = document.createElement("option");
      opt.value = i + 1;
      opt.textContent = label;
      motorSelect.appendChild(opt);
    });

    valve9Field.style.display = "none";
  }

  /* ===== IRRIGO PLUS ===== */
  if (variant === "IRRIGO_PLUS") {

    ["1 Pump", "2 Pump", "3 Pump"].forEach((label, i) => {
      const opt = document.createElement("option");
      opt.value = i + 1;
      opt.textContent = label;
      motorSelect.appendChild(opt);
    });

    valve9Field.style.display = "block";
    if (irrigoPlusExtras) irrigoPlusExtras.style.display = "block";
  }

 motorSelect.value = "1";

// Default Service = 1
const serviceSelect = document.getElementById("serviceCount");
if (serviceSelect) {
  serviceSelect.value = "1";
}

// Remove old listener
motorSelect.removeEventListener("change", renderPumpHpFields);
motorSelect.addEventListener("change", renderPumpHpFields);

// Render pumps
renderPumpHpFields();

// 🔥 Render service automatically
renderServiceFields();
  
}

/* ================= TNEB SERVICE LOGIC ================= */

const serviceSelect = document.getElementById("serviceCount");

if (serviceSelect) {
  serviceSelect.addEventListener("change", renderServiceFields);
}

function renderServiceFields() {

  const count = parseInt(document.getElementById("serviceCount")?.value || 0);
  const container = document.getElementById("serviceHpContainer");

  if (!container) return;

  container.innerHTML = "";

  for (let i = 1; i <= count; i++) {

    const card = document.createElement("div");
    card.className = "service-card";

    const title = document.createElement("div");
    title.className = "service-title";
    title.textContent = `Service ${i}`;

    const grid = document.createElement("div");
    grid.className = "fb-grid";

    const hpField = document.createElement("div");
    hpField.className = "fb-field";

    const label = document.createElement("label");
    label.textContent = "TNEB Sanctioned HP *";

    const select = document.createElement("select");
    select.id = `service${i}Hp`;

    hpOptions.forEach(hp => {
      const opt = document.createElement("option");
      opt.value = hp;
      opt.textContent = hp;
      select.appendChild(opt);
    });

    hpField.appendChild(label);
    hpField.appendChild(select);

    grid.appendChild(hpField);
    card.appendChild(title);
    card.appendChild(grid);

    container.appendChild(card);
  }

  renderPumpServiceMapping();
}
/* ================= DYNAMIC PUMP HP FIELDS ================= */
function renderPumpHpFields() {

  const motorSelect = document.getElementById("motorCount");
  const container = document.getElementById("pumpHpContainer");

  if (!motorSelect || !container) return;

  const motorCount = parseInt(motorSelect.value || 0);

  container.innerHTML = "";

  for (let i = 1; i <= motorCount; i++) {

    const wrapper = document.createElement("div");
    wrapper.className = "fb-field";

    const label = document.createElement("label");
    label.textContent = `Pump ${i} HP *`;

    const select = document.createElement("select");
    select.id = `pump${i}Hp`;

    hpOptions.forEach(hp => {
      const opt = document.createElement("option");
      opt.value = hp;
      opt.textContent = hp;
      select.appendChild(opt);
    });

    wrapper.appendChild(label);
    wrapper.appendChild(select);
    container.appendChild(wrapper);
  }

  renderPumpServiceMapping();
}
function renderPumpServiceMapping() {

  const motorCount = parseInt(document.getElementById("motorCount")?.value || 0);
  const serviceCount = parseInt(document.getElementById("serviceCount")?.value || 0);

  for (let i = 1; i <= motorCount; i++) {

    const pumpSelect = document.getElementById(`pump${i}Hp`);
    if (!pumpSelect) continue;

    let existing = document.getElementById(`pump${i}ServiceMap`);
    if (existing) existing.remove();

    if (!serviceCount) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "fb-field pump-service-map";
    wrapper.id = `pump${i}ServiceMap`;

    const label = document.createElement("label");
    label.textContent = `Pump ${i} → Service *`;

    const select = document.createElement("select");
    select.id = `pump${i}Service`;

    for (let s = 1; s <= serviceCount; s++) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = `Service ${s}`;
      select.appendChild(opt);
    }

    wrapper.appendChild(label);
    wrapper.appendChild(select);

    pumpSelect.parentElement.appendChild(wrapper);
  }
} 
/* ================= SERIAL VALIDATION ================= */
window.validateMcuSerial = async function () {

  const enteredSerial = mcuSerial.value?.trim();
  const variant = mcuVariant.value;

  if (!enteredSerial || !variant) return;

  try {

    const q = query(
      collection(db, "controllers"),
      where("serialNumber", "==", enteredSerial),
      where("variant", "==", variant)
    );

    const snap = await getDocs(q);

    if (snap.empty) {
      alert("❌ Invalid serial number for selected variant");
      mcuSerial.value = "";
      return;
    }

    const controller = snap.docs[0].data();

    if (controller.status?.toLowerCase() === "assigned") {
      alert("⚠ This device is already assigned to another customer");
      mcuSerial.value = "";
      return;
    }

    if (controller.status?.toLowerCase() !== "available") {
      alert("❌ Device is not available");
      mcuSerial.value = "";
      return;
    }

    /* ================= AUTO FILL CONTROLLER DETAILS ================= */


// SIM
document.getElementById("simNumber").value =
    controller.simNumber || "";

document.getElementById("simMsisdn").value =
    controller.simMsisdn || "";

document.getElementById("simImsi").value =
    controller.simImsi || "";

document.getElementById("simImei").value =
    controller.imeiNumber || "";

    // ✅ If reached here → serial is valid and available
    console.log("Serial valid and available");

  } catch (err) {
    console.error("Serial validation error:", err);
    alert("❌ Error validating serial number");
  }
};

/* ================= SAVE FARMER ================= */
window.saveFarmer = async function () {

  const btn = document.getElementById("saveFarmerBtn");
  if (btn && btn.disabled) return;

  try {

    if (btn) {
      btn.disabled = true;
      btn.innerText = "Saving...";
      btn.style.opacity = "0.7";
      btn.style.cursor = "not-allowed";
    }
    
    showLoader();
    
    function cleanPhone(value) {
      return value.replace(/\D/g, "").slice(0, 10);
    }

    function cleanAadhaar(value) {
      return value.replace(/\D/g, "").slice(0, 12);
    }

    function isValidIndianMobile(number) {
      return /^[6-9]\d{9}$/.test(number);
    }

   /* function isValidSim(number) {
      return /^\d{13}$/.test(number);
    }*/

    /* ================= NETWORK TYPE CHECK (NEW) ================= */
    const networkType = document.getElementById("networkType")?.value || "SIM";
  
    const primaryMobileRaw = document.getElementById("primaryMobile").value.trim();
    const secondaryMobileRaw = document.getElementById("secondaryMobile").value.trim();
    const aadhaarRaw = document.getElementById("aadhaarNumber").value.trim();
    const emailValue = document.getElementById("emailId")?.value.trim() || "";

    const cleanedPrimary = cleanPhone(primaryMobileRaw);
    const cleanedSecondary = cleanPhone(secondaryMobileRaw);
    const cleanedAadhaar = cleanAadhaar(aadhaarRaw);

    const appUser2MobileRaw = appUser2Mobile.value.trim();
    const appUser3MobileRaw = appUser3Mobile.value.trim();

    const cleanedAppUser2 = cleanPhone(appUser2MobileRaw);
    const cleanedAppUser3 = cleanPhone(appUser3MobileRaw);

    const farmerNameValue = document.getElementById("farmerName").value.trim();
    if (!farmerNameValue) {
      alert("Farmer Name is mandatory");
      hideLoader();
      return resetButton(btn);
    }

    if (!isValidIndianMobile(cleanedPrimary)) {
      alert("Enter valid 10-digit Primary Mobile (starts with 6-9)");
      hideLoader();
      return resetButton(btn);
    }
    
    const variant = mcuVariant.value;
    const serial = mcuSerial.value.trim();

    if (!variant || !serial) {
      alert("Please select MCU Variant and Serial Number");
      hideLoader();
      return resetButton(btn);
    }

   /* ===== MOTOR & VALVE VALIDATION ===== */
      if (variant === "IRRIGO" || variant === "IRRIGO_PLUS") {

        const motorCount = document.getElementById("motorCount")?.value;

        if (!motorCount) {
          alert("Please select number of motors");
          hideLoader();
          return resetButton(btn);
        }

        for (let i = 1; i <= parseInt(motorCount); i++) {
          const hp = document.getElementById(`pump${i}Hp`)?.value;
          if (!hp) {
            alert(`Please select HP for Pump ${i}`);
            hideLoader();
            return resetButton(btn);
          }
        }

        /* ===== PUMP ↔ SERVICE HP VALIDATION ===== */

              const serviceCount = parseInt(document.getElementById("serviceCount")?.value || 0);

              for (let i = 1; i <= parseInt(motorCount); i++) {

                const pumpHpText = document.getElementById(`pump${i}Hp`)?.value;
                const mappedServiceNumber = document.getElementById(`pump${i}Service`)?.value;

                if (!mappedServiceNumber) continue;

                const serviceHpText = document.getElementById(`service${mappedServiceNumber}Hp`)?.value;

                // Convert "10 HP" → 10
                const pumpHp = parseFloat(pumpHpText);
                const serviceHp = parseFloat(serviceHpText);

                if (pumpHp > serviceHp) {
                  alert(
                    `❌ Pump ${i} (${pumpHp} HP) cannot be connected to Service ${mappedServiceNumber} (${serviceHp} HP).\n\n` +
                    `Pump HP must be less than or equal to Service HP.`
                  );
                  hideLoader();
                  return resetButton(btn);
                }
              }
 // End of pump-service validation

        const valve24 = document.getElementById("valve24Count")?.value.trim();
        const valve9 = document.getElementById("valve9Count")?.value.trim();

        if (valve24 === "") {
          alert("Please enter number of 24V AC valves");
          hideLoader();
          return resetButton(btn);
        }

        if (variant === "IRRIGO_PLUS" && valve9 === "") {
          alert("Please enter number of 9V DC valves");
          hideLoader();
          return resetButton(btn);
        }

      }

    /* ===== FARM LOCATION VALIDATION ===== */

    if (!farmLocation.value.trim()) {
      alert("Farm Location is mandatory");
      hideLoader();
      resetButton(btn);
      return;
    }

      /* ================= UPDATED SIM VALIDATION ================= */
   /* const simNumberRaw = document.getElementById("simNumber").value.trim();
    const cleanedSimNumber = simNumberRaw.replace(/\D/g, "").slice(0, 13);

   if (networkType === "SIM") {
    if (!isValidSim(simNumberRaw)) {
      alert("SIM Number must be exactly 13 digits");
      hideLoader();
      return resetButton(btn);
    }
  }*/

   
    if (secondaryMobileRaw && !isValidIndianMobile(cleanedSecondary)) {
      alert("Enter valid 10-digit Secondary Mobile (starts with 6-9)");
      hideLoader();
      return resetButton(btn);
    }

    /* ===== AADHAAR (MANDATORY) ===== */
      if (!cleanedAadhaar || cleanedAadhaar.length !== 12) {
        alert("Aadhaar is mandatory and must be exactly 12 digits");
        hideLoader();
        resetButton(btn);
        return;
      }

      /* ===== LEAD SOURCE VALIDATION ===== */
      if (leadSourceType.value === "DISTRIBUTOR" && !distributorSelect.value) {
        alert("Please select a Distributor");
        hideLoader();
        resetButton(btn);
        return;
      }
      // ===== Activation Date Mandatory =====//
        if (!activationDate.value) {
          alert("Activation Date is mandatory");
          hideLoader();
          resetButton(btn);
          return;
        }
 // ===== App User Validation =====//
    if (
      (appUser2Name.value.trim() || appUser2MobileRaw) &&
      (!appUser2Name.value.trim() || !isValidIndianMobile(cleanedAppUser2))
    ) {
      alert("App User 2 must have valid Name and 10-digit Mobile (starts with 6-9)");
      hideLoader();
      return resetButton(btn);
    }

    if (
      (appUser3Name.value.trim() || appUser3MobileRaw) &&
      (!appUser3Name.value.trim() || !isValidIndianMobile(cleanedAppUser3))
    ) {
      alert("App User 3 must have valid Name and 10-digit Mobile (starts with 6-9)");
      hideLoader();
      return resetButton(btn);
    }

     // ===== MCU VALIDATION =====//
    const controllerQuery = query(
      collection(db, "controllers"),
      where("variant", "==", variant),
      where("serialNumber", "==", serial),
      where("status", "==", "available")
    );

    const controllerSnap = await getDocs(controllerQuery);
    if (controllerSnap.empty) {
      alert("❌ Selected MCU not available");
      hideLoader();
      return resetButton(btn);
    }

const controllerDoc = controllerSnap.docs[0];
const controller = controllerDoc.data();

if (networkType === "SIM") {

    if (!controller.simNumber) {
        alert("Selected controller does not have a SIM Number.");
        hideLoader();
        return resetButton(btn);
    }

    if (!controller.simMsisdn) {
        alert("Selected controller does not have a SIM MSISDN.");
        hideLoader();
        return resetButton(btn);
    }

    if (!controller.simImsi) {
        alert("Selected controller does not have a SIM IMSI.");
        hideLoader();
        return resetButton(btn);
    }

    if (!controller.imeiNumber) {
        alert("Selected controller does not have an IMEI Number.");
        hideLoader();
        return resetButton(btn);
    }

}

/* ===== GET FARM NUMBER FIRST ===== */
const selectedFarmNumber =
  document.getElementById("farmNumber")?.value || "Farm 1";

/* ===== PREVENT DUPLICATE FARM 1 ===== */
if (selectedFarmNumber === "Farm 1") {

  const existingFarmQuery = query(
    collection(db, "farmers"),
    where("aadhaarNumber", "==", cleanedAadhaar),
    where("farmNumber", "==", selectedFarmNumber)
  );

  const existingSnap = await getDocs(existingFarmQuery);

  if (!existingSnap.empty) {

    const existingFarmer = existingSnap.docs[0].data();
    const existingFarmId = existingFarmer.farmBuddieId || "Unknown";
     alert(
    `❌ Aadhaar number already registered.\n\n` +
    `It is linked to Farm Buddie ID: ${existingFarmId}\n\n` +
    `Please use a different Aadhaar number to onboard a new farmer.`
  );
    hideLoader();
    resetButton(btn);
    return;
  }
}

/* ===== NOW GENERATE ID ===== */
const { farmBuddieId, nextCounter } =
  await previewNextFarmBuddieId();

// 🔐 Create identityId (per person, not per farm)
let identityId;
let mainFarmerId = null;

// Check if Aadhaar already exists
const identityQuery = query(
  collection(db, "farmers"),
  where("aadhaarNumber", "==", cleanedAadhaar)
);

const identitySnap = await getDocs(identityQuery);

if (!identitySnap.empty) {
  // Existing person → reuse identity
  const existingFarmer = identitySnap.docs[0];

  identityId = existingFarmer.data().identityId;
  mainFarmerId = existingFarmer.id;

} else {
  // New person → create identity
  identityId = crypto.randomUUID();
}

    /* ================= DOCUMENT UPLOAD (OPTIMIZED - NEW VERSION) ================= */

const aadhaarFileInput = document.getElementById("aadhaarFile");
const otherDocInput = document.getElementById("otherDoc");
const farmerPhotoInput = document.getElementById("farmerPhoto");

let aadhaarUrl = "";
let otherDocUrl = "";
let farmerPhotoUrl = "";

const MAX_DOC_SIZE = 2 * 1024 * 1024;   // 2MB
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/* ===== AADHAAR (PDF OR IMAGE) ===== */
if (aadhaarFileInput?.files.length > 0) {

  const file = aadhaarFileInput.files[0];
  const type = file.type;

  if (file.size > MAX_DOC_SIZE) {
    alert("Aadhaar file must be under 2MB");
    hideLoader();
    return resetButton(btn);
  }

  let fileRef;

  if (type === "application/pdf") {

    fileRef = ref(storage, `farmer-documents/${farmBuddieId}/aadhaar.pdf`);
    await uploadBytes(fileRef, file, { contentType: "application/pdf" });

  } else if (type.startsWith("image/")) {

    const compressed = await compressImage(file);
    fileRef = ref(storage, `farmer-documents/${farmBuddieId}/aadhaar.webp`);
    await uploadBytes(fileRef, compressed, { contentType: "image/webp" });

  } else {
    alert("Aadhaar must be PDF or JPG/JPEG/PNG");
    hideLoader();
    return resetButton(btn);
  }

  aadhaarUrl = await getDownloadURL(fileRef);
}


/* ===== OTHER DOCUMENT (PDF OR IMAGE) ===== */
if (otherDocInput?.files.length > 0) {

  const file = otherDocInput.files[0];
  const type = file.type;

  if (file.size > MAX_DOC_SIZE) {
    alert("Other Document must be under 2MB");
    hideLoader();
    return resetButton(btn);
  }

  let fileRef;

  if (type === "application/pdf") {

    fileRef = ref(storage, `farmer-documents/${farmBuddieId}/other.pdf`);
    await uploadBytes(fileRef, file, { contentType: "application/pdf" });

  } else if (type.startsWith("image/")) {

    const compressed = await compressImage(file);
    fileRef = ref(storage, `farmer-documents/${farmBuddieId}/other.webp`);
    await uploadBytes(fileRef, compressed, { contentType: "image/webp" });

  } else {
    alert("Other Document must be PDF or JPG/JPEG/PNG");
    hideLoader();
    return resetButton(btn);
  }

  otherDocUrl = await getDownloadURL(fileRef);
}


/* ===== FARMER PHOTO (JPG/JPEG/PNG ONLY → COMPRESSED) ===== */
if (farmerPhotoInput?.files.length > 0) {

  const file = farmerPhotoInput.files[0];
  const type = file.type;

  if (!type.startsWith("image/")) {
    alert("Farmer photo must be JPG, JPEG or PNG");
    hideLoader();
    return resetButton(btn);
  }

  if (file.size > MAX_IMAGE_SIZE) {
    alert("Photo must be under 5MB");
    hideLoader();
    return resetButton(btn);
  }

  const compressed = await compressImage(file);

  const fileRef = ref(
    storage,
    `farmer-documents/${farmBuddieId}/farmer-photo.webp`
  );

  await uploadBytes(fileRef, compressed, {
    contentType: "image/webp"
  });

  farmerPhotoUrl = await getDownloadURL(fileRef);
}


// Motor and valve counts (with safe fallback)
    const motorCount = document.getElementById("motorCount")?.value || 0;
    const valve24 = document.getElementById("valve24Count")?.value || 0;
    const valve9 = document.getElementById("valve9Count")?.value || 0;
    
  const farmerData = {
      farmBuddieId,
      farmNumber: selectedFarmNumber,

      // 🔐 Identity linking
  identityId: identityId,
  mainFarmerId: mainFarmerId, // Farm 1 is main
  
  /* SAFE FARMER ROLE (NO ERROR IF HTML REMOVED) */
  role: document.getElementById("farmerRole")?.value || "MAIN",

  title: title.value,
  name: farmerNameValue,
  primaryMobile: cleanedPrimary,
  secondaryMobile: cleanedSecondary,
  aadhaarNumber: cleanedAadhaar,
  emailId: emailValue,
  address: address.value.trim(),

  leadSource: {
  type: leadSourceType.value || "DIRECT",
  distributorId: leadSourceType.value === "DISTRIBUTOR"
    ? distributorSelect.value
    : null,
  distributorName: leadSourceType.value === "DISTRIBUTOR"
    ? distributorSelect.options[distributorSelect.selectedIndex]?.dataset.companyName || ""
    : "Farm Buddie Smart Irrigation"
},

  /* 🆕 FARM LOCATION DETAILS */
  farmDetails: {
    location: farmLocation.value.trim() || "",
    latitude: farmLatitude.value.trim() || "",
    longitude: farmLongitude.value.trim() || ""
  },

  network: {
    type: networkType
  },

  documents: {
    aadhaarUrl,
    otherDocUrl,
    farmerPhotoUrl
  },
  
  appUsers: [
    { name: appUser2Name.value.trim(), mobile: cleanedAppUser2 },
    { name: appUser3Name.value.trim(), mobile: cleanedAppUser3 }
  ].filter(u => u.name && u.mobile),

 sim: {

    simNumber: controller.simNumber || "",

    msisdn: controller.simMsisdn || "",

    simImsi: controller.simImsi || "",

    imeiNumber: controller.imeiNumber || "",

    simType: simType.value,

    billingCycle: billingCycle.value,

    activationDate: activationDate.value

},

 controller: {

    variant: controller.variant || "",

    serialNumber: controller.serialNumber || "",

    uniqueId: controller.uniqueId || "",

    //farmId: controller.farmId || "",

   
    warranty: {
        start: warrantyStart.value || "",
        end: warrantyEnd.value || ""
    },

    mqtt: {

        brokerUrl: controller.mqttUrl || "",

        port: controller.mqttPort || 8883,

        username: controller.username || "",

        password: controller.password || ""

    }

},

  /* ===== MOTOR CONFIG ===== */
  motorConfig: {
    motorCount: parseInt(motorCount || 0),
    pumpHp: Array.from({ length: parseInt(motorCount || 0) })
      .map((_, i) => document.getElementById(`pump${i+1}Hp`)?.value)
  },

  /* ===== VALVE CONFIG ===== */
  valveConfig: {
  valve24Count: parseInt(valve24 || 0),
  valve9Count: variant === "IRRIGO_PLUS"
    ? parseInt(valve9 || 0)
    : 0,
  filterBackwashCount: variant === "IRRIGO_PLUS"
    ? parseInt(document.getElementById("filterBackwashCount")?.value || 0)
    : 0,
  waterLevelMonitoring: variant === "IRRIGO_PLUS"
    ? parseInt(document.getElementById("waterLevelMonitoring")?.value || 0)
    : 0
},
  /* ===== TNEB SERVICE CONFIG ===== */
tnebServices: {
  serviceCount: parseInt(document.getElementById("serviceCount")?.value || 0),
  services: Array.from({ length: parseInt(document.getElementById("serviceCount")?.value || 0) })
    .map((_, i) => ({
      serviceNumber: i + 1,
      sanctionedHp: document.getElementById(`service${i+1}Hp`)?.value
    }))
},

pumpServiceMapping: Array.from({ length: parseInt(motorCount || 0) })
  .map((_, i) => ({
    pumpNumber: i + 1,
    hp: document.getElementById(`pump${i+1}Hp`)?.value,
    service: document.getElementById(`pump${i+1}Service`)?.value
  })),

    status: "active",
    // ✅ ADD THIS BLOCK
      phoneAuth: {
        enabled: true
      },
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser.uid
  };


/* ===== SAVE FARMER ===== */

// 🔥 STEP 1: VALIDATE PHONES FIRST (NO SAVE YET)
    await validatePhones(db, farmerData);

// 🔥 STEP 2: SAVE ONLY IF VALIDATION PASSED
    const farmerRef = await addDoc(collection(db, "farmers"), farmerData);


// 🔥 STEP 3: SYNC PHONE INDEX
    await fullPhoneSync(db, auth, farmerRef.id, farmerData);

    await updateDoc(doc(db, "controllers", controllerDoc.id), {
      status: "assigned",
      assignedAt: serverTimestamp(),
      farmerDocId: farmerRef.id,
      farmerId: farmBuddieId,
      networkType: networkType,
      updatedAt: serverTimestamp()
    });

       const now = new Date();
    const formattedTime = now.toLocaleString();

    hideLoader();
    alert(
      `✅ Farmer onboarded successfully\n\n` +
      `Farm Buddie ID: ${farmBuddieId}\n` +
      `Created At: ${formattedTime}`
    );

    // 🔥 AUTO-PROVISION MQTT CREDENTIALS — the farmer itself is already
    // saved at this point regardless of what happens here, so a failure
    // here is a warning, not a save error (retry later via the controller
    // panel's Generate MQTT Credentials button).
    try {
      const mqttData = await provisionDeviceCredentials(auth, controllerDoc.id);
      await showMqttCredentialModal(mqttData);
    } catch (mqttErr) {
      console.error("MQTT auto-provisioning error:", mqttErr);
      alert(
        "⚠ Farmer saved, but MQTT credential generation failed: " + mqttErr.message +
        "\n\nYou can retry from the MCU / Controller page."
      );
    }

    await commitFarmCounter(nextCounter);

    window.location.href = "/admin/farmer-database.html";

  } catch (error) {
    console.error("Save error:", error);
    alert("❌ Error saving new farmer");
    hideLoader();
    resetButton(btn);
  }
};

/* ================= GLOBAL INPUT RESTRICTION ================= */
document.addEventListener("input", function (e) {

  if (
    e.target.id === "primaryMobile" ||
    e.target.id === "secondaryMobile" ||
    e.target.id === "appUser2Mobile" ||
    e.target.id === "appUser3Mobile"
  ) {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  }

  if (e.target.id === "simNumber") {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 13);
  }

  if (e.target.id === "aadhaarNumber") {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 12);
  }

   /* ===== VALVE STRICT NUMERIC (ADD HERE) ===== */
 if (e.target.id === "valve24Count" || e.target.id === "valve9Count") {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3);
  }

  if (e.target.id === "filterBackwashCount") {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3);
  }

  });

function resetButton(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerText = "Save Farmer";
  btn.style.opacity = "1";
  btn.style.cursor = "pointer";
}
/************************************************************
 * AUTO LOAD MOTOR & VALVE SECTION ON PAGE LOAD
 ************************************************************/
document.addEventListener("DOMContentLoaded", () => {

  const variantSelect = document.getElementById("mcuVariant");
  const serviceSelect = document.getElementById("serviceCount");

  if (variantSelect && variantSelect.value) {
    handleVariantMotorValve();
  }

  if (serviceSelect) {
    serviceSelect.addEventListener("change", renderServiceFields);
  }

});


/************************************************************
 * Load Distributors Automatically
 ************************************************************/
async function loadDistributors() {

  if (!distributorSelect) return;

  distributorSelect.innerHTML = `<option value="">Select Distributor</option>`;

  try {
    const q = query(
      collection(db, "distributors"),
      where("status", "==", "active")
    );

    const snap = await getDocs(q);

    snap.forEach(docSnap => {
      const d = docSnap.data();

      const option = document.createElement("option");
      option.value = d.distributorId;
      option.textContent = `${d.name} (${d.distributorId || docSnap.id})`;
      option.dataset.companyName = d.name;

      distributorSelect.appendChild(option);
    });

  } catch (error) {
    console.error("Distributor load error:", error);
  }
}

/************************************************************
 * LEAD SOURCE TOGGLE
 ************************************************************/
window.handleLeadSource = function () {

  const distributorField = document.getElementById("distributorField");

  if (!leadSourceType || !distributorField) return;

  if (leadSourceType.value === "DISTRIBUTOR") {
    distributorField.style.display = "block";
    loadDistributors();
  } else {
    distributorField.style.display = "none";
    if (distributorSelect) distributorSelect.value = "";
  }
};