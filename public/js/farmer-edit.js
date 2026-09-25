import { auth, db } from "/js/firebase-init.js";
import { renderValveConfigSection, readValveConfig, fillValveConfig } from "/js/valve-config.js";

// Valve Configuration + Additional Features fields (IRRIGO and IRRIGO_PLUS alike)
renderValveConfigSection();
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  doc,
  getDoc,
  updateDoc,
  setDoc,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

const storage = getStorage();

import { 
  fullPhoneSync,
  validatePhones
} from "/js/phone-auth.js";
import { provisionDeviceCredentials, showMqttCredentialModal } from "/js/provisioning.js";

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

/* ================= LOADER FUNCTIONS ================= */
function showLoader(message = "Processing...") {
  const loader = document.getElementById("globalLoader");
  const text = document.getElementById("loaderText");
  if (text) text.innerText = message;
  if (loader) loader.style.display = "flex";
}

function hideLoader() {
  const loader = document.getElementById("globalLoader");
  if (loader) loader.style.display = "none";
}

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

if (!docId) {
  alert("Farmer document ID missing");
  throw new Error("Missing farmer document ID");
}

/* ================= STORE FARM BUDDIE ID ================= */
let currentFarmBuddieId = "";
let existingDocuments = {};
let isPrimaryFarmGlobal = false;
let totalFarmsForFarmer = 1;
let currentIdentityId = "";
let originalAadhaar = "";
let aadhaarUrl = "";
let otherDocUrl = "";
let farmerPhotoUrl = "";


/* ================= ELEMENTS ================= */
const farmerRole = document.getElementById("farmerRole");
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
const aadhaarFileInput = document.getElementById("aadhaarFile");
const otherDocInput = document.getElementById("otherDoc");
const farmerPhotoInput = document.getElementById("farmerPhoto");

const appUser2Name = document.getElementById("appUser2Name");
const appUser2Mobile = document.getElementById("appUser2Mobile");
const appUser3Name = document.getElementById("appUser3Name");
const appUser3Mobile = document.getElementById("appUser3Mobile");

const networkTypeElement = document.getElementById("networkType");
const simNumber = document.getElementById("simNumber");
const simMsisdn = document.getElementById("simMsisdn");
const simImsi = document.getElementById("simImsi");
const simImei = document.getElementById("simImei");
const simType = document.getElementById("simType");
const billingCycle = document.getElementById("billingCycle");
const activationDate = document.getElementById("activationDate");

const mcuVariant = document.getElementById("mcuVariant");
const mcuSerial = document.getElementById("mcuSerial");
const serialField = document.getElementById("serialField");
const mcuSerialList = document.getElementById("mcuSerialList");
const warrantyStart = document.getElementById("warrantyStart");
const warrantyEnd = document.getElementById("warrantyEnd");

/* ================= AUTO WARRANTY CALCULATION ================= */

if (warrantyStart) {

  warrantyStart.addEventListener("change", function () {

    if (!this.value) return;

    const startDate = new Date(this.value);
    const endDate = new Date(startDate);

    endDate.setFullYear(endDate.getFullYear() + 1);

    const yyyy = endDate.getFullYear();
    const mm = String(endDate.getMonth() + 1).padStart(2, "0");
    const dd = String(endDate.getDate()).padStart(2, "0");

    warrantyEnd.value = `${yyyy}-${mm}-${dd}`;
  });

}

/* ================= CLEAN FUNCTIONS (MATCH ONBOARDING) ================= */

function cleanPhone(value) {
  return value.replace(/\D/g, "").slice(0, 10);
}

function cleanAadhaar(value) {
  return value.replace(/\D/g, "").slice(0, 12);
}

function isValidIndianMobile(number) {
  return /^[6-9]\d{9}$/.test(number);
}

/* ================= NETWORK TYPE HANDLER ================= */
window.handleNetworkType = function () {

  const type = document.getElementById("networkType")?.value;
  if (!type) return;

  const simNumber = document.getElementById("simNumber");
  const simMsisdn = document.getElementById("simMsisdn");
  const simImsi = document.getElementById("simImsi");
  const simImei = document.getElementById("simImei");
  const simType = document.getElementById("simType");
  const billingCycle = document.getElementById("billingCycle");
  const activationDate = document.getElementById("activationDate");

  if (type === "WIFI_FARMER") {

    // Disable SIM-related fields
    if (simNumber) {
      simNumber.disabled = true;
      simNumber.value = "";
    }

    if (simMsisdn) {
      simMsisdn.disabled = true;
      simMsisdn.value = "";
    }

    if (simImsi) {
      simImsi.disabled = true;
      simImsi.value = "";
    }

    if (simImei) {
      simImei.disabled = true;
      simImei.value = "";
    }

    if (simType) {
      simType.disabled = true;
      simType.value = "";
    }

    if (billingCycle) {
      billingCycle.disabled = true;
      billingCycle.value = "Yearly";
    }

    // Activation Date stays enabled
    if (activationDate) {
      activationDate.disabled = false;
    }
  }

  if (type === "SIM") {

    if (simNumber) simNumber.disabled = false;
    if (simMsisdn) simMsisdn.disabled = false;
    if (simImsi) simImsi.disabled = false;
    if (simImei) simImei.disabled = false;
    if (simType) simType.disabled = false;
    if (billingCycle) billingCycle.disabled = false;
    if (activationDate) activationDate.disabled = false;

  }

};

/* ================= GLOBAL INPUT RESTRICTION ================= */
document.addEventListener("input", function (e) {

  /* ===== PHONE NUMBERS (10 DIGITS ONLY) ===== */
  if (
    e.target.id === "primaryMobile" ||
    e.target.id === "secondaryMobile" ||
    e.target.id === "appUser2Mobile" ||
    e.target.id === "appUser3Mobile"
  ) {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  }

  /* ===== SIM NUMBER / ICCID (19 DIGITS ONLY) ===== */
  if (e.target.id === "simNumber") {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 19);
  }

  /* ===== SIM IMSI (15 DIGITS ONLY) ===== */
  if (e.target.id === "simImsi") {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 15);
  }

  /* ===== AADHAAR (12 DIGITS ONLY) ===== */
  if (e.target.id === "aadhaarNumber") {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 12);
  }

});

/* ================= LOAD FARMER ================= */
async function loadFarmer() {

  const snap = await getDoc(doc(db, "farmers", docId));
  if (!snap.exists()) {
    alert("❌ Farmer not found");
    return;
  }

  const f = snap.data();
  originalAadhaar = f.aadhaarNumber || "";
  currentIdentityId = f.identityId || "";

  /* 🔥 VERY IMPORTANT — SET VARIANT FIRST */
  mcuVariant.value = f.controller?.variant || "";
  handleVariantMotorValve(true); // Edit mode

    /* ================= LOCK RULES ================= */

        const farmNumber = f.farmNumber?.trim() || "Farm 1";
        isPrimaryFarmGlobal = farmNumber === "Farm 1";

        /* 🔎 COUNT TOTAL FARMS FOR THIS AADHAAR */
        const farmQuery = query(
          collection(db, "farmers"),
          where("aadhaarNumber", "==", f.aadhaarNumber)
        );

        const farmSnap = await getDocs(farmQuery);
        totalFarmsForFarmer = farmSnap.size;

        /* ---------- FARM 2–5 ---------- */
        if (!isPrimaryFarmGlobal) {

          // 🔒 LOCK FARMER IDENTITY
          if (farmerRole) farmerRole.disabled = true;
          title.disabled = true;
          farmerName.disabled = true;
          primaryMobile.disabled = true;
          secondaryMobile.disabled = true;
          aadhaarNumber.disabled = true;
          emailId.disabled = true;
          address.disabled = true;

          // 🔒 LOCK DOCUMENT UPLOAD
          document.getElementById("aadhaarFile")?.setAttribute("disabled", true);
          document.getElementById("otherDoc")?.setAttribute("disabled", true);
          document.getElementById("farmerPhoto")?.setAttribute("disabled", true);
        }

/* ---------- MOTOR COUNT ---------- */
const savedMotor = f.motorConfig?.motorCount || 1;
document.getElementById("motorCount").value = savedMotor;
renderPumpHpFields();

/* ---------- RESTORE PUMP HP ---------- */
if (f.motorConfig?.pumpHp?.length) {
  f.motorConfig.pumpHp.forEach((hp, index) => {
    const el = document.getElementById(`pump${index+1}Hp`);
    if (el) el.value = hp;
  });
}

/* ---------- RESTORE SERVICE COUNT ---------- */
document.getElementById("serviceCount").value =
  f.tnebServices?.serviceCount || 1;

renderServiceFields();

/* ---------- RESTORE SERVICE HP ---------- */
if (f.tnebServices?.services?.length) {
  f.tnebServices.services.forEach((service, index) => {
    const el = document.getElementById(`service${index+1}Hp`);
    if (el) el.value = service.sanctionedHp;
  });
}

/* ---------- RESTORE PUMP → SERVICE MAP ---------- */
if (f.pumpServiceMapping?.length) {
  f.pumpServiceMapping.forEach((map, index) => {
    const el = document.getElementById(`pump${index+1}Service`);
    if (el) el.value = map.service;
  });
}

/* ---------- VALVES + ADDITIONAL FEATURES ---------- */
fillValveConfig(f.valveConfig);

  currentFarmBuddieId = f.farmBuddieId || "";
  existingDocuments = f.documents || {};
  aadhaarUrl = f.documents?.aadhaarUrl || "";
  otherDocUrl = f.documents?.otherDocUrl || "";
  farmerPhotoUrl = f.documents?.farmerPhotoUrl || "";

  if (farmerRole) farmerRole.value = f.role || "MAIN";

  title.value = f.title || "Mr";
  farmerName.value = f.name || "";
  primaryMobile.value = f.primaryMobile || "";
  secondaryMobile.value = f.secondaryMobile || "";
  aadhaarNumber.value = f.aadhaarNumber || "";
  emailId.value = f.emailId || "";
  address.value = f.address || "";

  /* ===== LEAD SOURCE LOAD ===== */
    if (f.leadSource?.type?.toUpperCase() === "DISTRIBUTOR") {

  leadSourceType.value = "DISTRIBUTOR";

  const distributorField = document.getElementById("distributorField");
  distributorField.style.display = "block";

  await loadDistributors();

  if (f.leadSource?.distributorId) {
    distributorSelect.value = f.leadSource.distributorId;
  }

} else {
        leadSourceType.value = "DIRECT";
      }

 farmLocation.value = f.farmDetails?.location || "";
 farmLatitude.value = f.farmDetails?.latitude || "";
 farmLongitude.value = f.farmDetails?.longitude || "";


  appUser2Name.value = f.appUsers?.[0]?.name || "";
  appUser2Mobile.value = f.appUsers?.[0]?.mobile || "";
  appUser3Name.value = f.appUsers?.[1]?.name || "";
  appUser3Mobile.value = f.appUsers?.[1]?.mobile || "";

 simNumber.value = f.sim?.simNumber || "";
  simMsisdn.value = f.sim?.msisdn || "";
  simImsi.value = f.sim?.simImsi || "";
  simImei.value = f.sim?.imeiNumber || "";
  simType.value = f.sim?.simType || "";
  billingCycle.value = f.sim?.billingCycle || "";
  activationDate.value = f.sim?.activationDate || "";

  if (networkTypeElement && f.network?.type) {
    networkTypeElement.value = f.network.type;
    handleNetworkType();
  }

  mcuVariant.value = f.controller?.variant || "";
  mcuSerial.value = f.controller?.serialNumber || "";
  warrantyStart.value = f.controller?.warranty?.start || "";
  warrantyEnd.value = f.controller?.warranty?.end || "";

  if (serialField) serialField.style.display = "block";
  
  mcuVariant.disabled = true;
  mcuSerial.disabled = true;
  warrantyStart.disabled = true;
  warrantyEnd.disabled = true;
  
}

loadFarmer();

/* ================= LOAD AVAILABLE SERIALS (FOR UPGRADE) ================= */
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

  handleVariantMotorValve(false); // Upgrade mode
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
function handleVariantMotorValve(isEditMode = false) {

  const variant = document.getElementById("mcuVariant").value;

  const motorSection = document.getElementById("motorConfigSection");
  const valveSection = document.getElementById("valveConfigSection");
  const motorSelect = document.getElementById("motorCount");

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

  }

  /* ===== IRRIGO PLUS ===== */
  if (variant === "IRRIGO_PLUS") {

    ["1 Pump", "2 Pump", "3 Pump"].forEach((label, i) => {
      const opt = document.createElement("option");
      opt.value = i + 1;
      opt.textContent = label;
      motorSelect.appendChild(opt);
    });

  }

// Attach listener
motorSelect.removeEventListener("change", renderPumpHpFields);
motorSelect.addEventListener("change", renderPumpHpFields);

// 🔥 Only auto-build structure in upgrade mode
if (!isEditMode) {

  motorSelect.value = "1";

  const serviceSelect = document.getElementById("serviceCount");
  if (serviceSelect) serviceSelect.value = "1";

  renderPumpHpFields();
  renderServiceFields();
}
  
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

/* ================= VARIANT UPGRADE TOGGLE ================= */

const upgradeToggle = document.getElementById("variantUpgradeToggle");

if (upgradeToggle) {

  upgradeToggle.addEventListener("change", async function () {

    const enable = this.checked;

    mcuVariant.disabled = !enable;
    mcuSerial.disabled = !enable;
    warrantyStart.disabled = !enable;
    warrantyEnd.disabled = !enable;

    if (enable) {

      alert("Variant Upgrade Mode Enabled");

          // 🔥 call same onboarding logic
    await handleMcuVariant();
    }

  });

}
/* If variant changes during upgrade */
mcuVariant.addEventListener("change", async function () {

  if (!upgradeToggle?.checked) return;

  // 🔥 Clear serial when variant changes
  mcuSerial.value = "";

  // 🔥 Reload serial list for new variant
  await handleMcuVariant();

  handleVariantMotorValve(false); // Upgrade mode
});

/* ================= UPDATE FARMER ================= */
window.updateFarmer = async function () {

  const oldSnap = await getDoc(doc(db, "farmers", docId));
  const oldData = oldSnap.data();
  const btn = document.getElementById("updateFarmerBtn");
  if (btn && btn.disabled) return;

  try {

    btn.disabled = true;
    btn.innerText = "Updating...";
    btn.style.opacity = "0.7";
    btn.style.cursor = "not-allowed";

    const networkType = networkTypeElement
      ? networkTypeElement.value
      : "SIM";

    const farmerNameValue = farmerName.value.trim();
    const primaryMobileRaw = primaryMobile.value.trim();
    const secondaryMobileRaw = secondaryMobile.value.trim();
    const aadhaarRaw = aadhaarNumber.value.trim();
    const emailValue = emailId ? emailId.value.trim() : "";
    const cleanedSim = simNumber.value.trim().replace(/\D/g, "").slice(0, 19);
    const cleanedPrimary = cleanPhone(primaryMobileRaw);
    const cleanedSecondary = cleanPhone(secondaryMobileRaw);
    const cleanedAadhaar = cleanAadhaar(aadhaarRaw);
  

    const appUser2MobileRaw = appUser2Mobile.value.trim();
    const appUser3MobileRaw = appUser3Mobile.value.trim();

    const cleanedAppUser2 = cleanPhone(appUser2MobileRaw);
    const cleanedAppUser3 = cleanPhone(appUser3MobileRaw);

    /* ===== Aadhaar Change Warning ===== */
    if (cleanedAadhaar !== originalAadhaar) {
      const confirmChange = confirm(
        "⚠ Aadhaar is the primary identity field.\n\n" +
        "Changing it will update ALL linked farms.\n\n" +
        "Do you want to continue?"
      );
      if (!confirmChange) {
        resetUpdateButton(btn);
        return;
      }
    }

    /* ================= VALIDATIONS ================= */

    if (!farmerNameValue) {
      alert("Farmer Name is mandatory");
      resetUpdateButton(btn);
      return;
    }

    if (!isValidIndianMobile(cleanedPrimary)) {
      alert("Enter valid 10-digit Primary Mobile (starts with 6-9)");
      resetUpdateButton(btn);
      return;
    }

    if (cleanedSecondary &&
        !isValidIndianMobile(cleanedSecondary)) {
      alert("Enter valid 10-digit Secondary Mobile (starts with 6-9)");
      resetUpdateButton(btn);
      return;
    }

     /* ================= UPDATED SIM VALIDATION =================
        SIM Number = ICCID (19 digits), SIM MSISDN = the Airtel M2M
        mobile number (13 digits), SIM IMSI = the network subscriber
        identity (15 digits) - three distinct identifiers, not one
        field wearing three names. Previously validated simNumber
        (the ICCID) against a 13-digit MSISDN-length check, which
        rejected every real ICCID and made this form un-saveable for
        any farmer whose SIM data was actually filled in correctly. */
    const simNumberRaw = document.getElementById("simNumber").value.trim();
    const cleanedSimNumber = simNumberRaw.replace(/\D/g, "").slice(0, 19);
    const simMsisdnRaw = document.getElementById("simMsisdn").value.trim();
    const cleanedSimMsisdn = simMsisdnRaw.replace(/\D/g, "").slice(0, 13);
    const simImsiRaw = document.getElementById("simImsi").value.trim();
    const cleanedSimImsi = simImsiRaw.replace(/\D/g, "").slice(0, 15);

    if (networkType === "SIM") {

        if (!/^\d{19}$/.test(cleanedSimNumber)) {
          alert("SIM Number (ICCID) must be exactly 19 digits");
          hideLoader();
          return resetUpdateButton(btn);
        }

        if (!/^\d{13}$/.test(cleanedSimMsisdn)) {
          alert("SIM MSISDN must be exactly 13 digits");
          hideLoader();
          return resetUpdateButton(btn);
        }

        if (!/^\d{15}$/.test(cleanedSimImsi)) {
          alert("SIM IMSI must be exactly 15 digits");
          hideLoader();
          return resetUpdateButton(btn);
        }
      }

      
    if (secondaryMobileRaw && !isValidIndianMobile(cleanedSecondary)) {
      alert("Enter valid 10-digit Secondary Mobile (starts with 6-9)");
      hideLoader();
      return resetUpdateButton(btn);
    }

     /* ===== AADHAAR (MANDATORY) ===== */
      if (!cleanedAadhaar || cleanedAadhaar.length !== 12) {
        alert("Aadhaar is mandatory and must be exactly 12 digits");
        hideLoader();
        resetUpdateButton(btn);
        return;
      }

      /* ===== LEAD SOURCE VALIDATION ===== */
      if (
        leadSourceType.value === "DISTRIBUTOR" &&
        !distributorSelect.value
      ) {
        alert("Please select a Distributor");
        hideLoader();
        return resetUpdateButton(btn);
      }

    if (!farmLocation.value.trim()) {
      alert("Farm Location is mandatory");
      resetUpdateButton(btn);
      return;
    }

    if (!activationDate.value) {
      alert("Activation Date is mandatory");
      resetUpdateButton(btn);
      return;
    }

    /* ================= APP USERS ================= */

    const appUsers = [];

    if (appUser2Name.value.trim() &&
        isValidIndianMobile(cleanPhone(appUser2Mobile.value.trim()))) {
      appUsers.push({
        name: appUser2Name.value.trim(),
        mobile: cleanPhone(appUser2Mobile.value.trim())
      });
    }

    if (appUser3Name.value.trim() &&
        isValidIndianMobile(cleanPhone(appUser3Mobile.value.trim()))) {
      appUsers.push({
        name: appUser3Name.value.trim(),
        mobile: cleanPhone(appUser3Mobile.value.trim())
      });
    }

    // ===== App User Validation =====//
    if (
      (appUser2Name.value.trim() || appUser2MobileRaw) &&
      (!appUser2Name.value.trim() || !isValidIndianMobile(cleanedAppUser2))
    ) {
      alert("App User 2 must have valid Name and 10-digit Mobile (starts with 6-9)");
      hideLoader();
      return resetUpdateButton(btn);
    }

    if (
      (appUser3Name.value.trim() || appUser3MobileRaw) &&
      (!appUser3Name.value.trim() || !isValidIndianMobile(cleanedAppUser3))
    ) {
      alert("App User 3 must have valid Name and 10-digit Mobile (starts with 6-9)");
      hideLoader();
      return resetUpdateButton(btn);
    }
   
    /* ===== PUMP ↔ SERVICE HP VALIDATION ===== */

const motorCount = parseInt(document.getElementById("motorCount")?.value || 0);
const serviceCount = parseInt(document.getElementById("serviceCount")?.value || 0);

for (let i = 1; i <= motorCount; i++) {

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
    return resetUpdateButton(btn);
  }
}

    /* ================= DOCUMENT LOGIC (UPDATED) ================= */

const MAX_DOC_SIZE = 2 * 1024 * 1024;   // 2MB
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/* ===== AADHAAR ===== */
if (aadhaarFileInput?.files.length > 0) {

  const file = aadhaarFileInput.files[0];
  const type = file.type;

  if (file.size > MAX_DOC_SIZE) {
    alert("Aadhaar file must be under 2MB");
    resetUpdateButton(btn);
    return;
  }

  if (aadhaarUrl && !confirm("Aadhaar file exists. Replace it?")) {
    resetUpdateButton(btn);
    return;
  }

  let fileRef;

  if (type === "application/pdf") {

    fileRef = ref(storage, `farmer-documents/${currentFarmBuddieId}/aadhaar.pdf`);
    await uploadBytes(fileRef, file, { contentType: "application/pdf" });

  } else if (type.startsWith("image/")) {

    const compressed = await compressImage(file);
    fileRef = ref(storage, `farmer-documents/${currentFarmBuddieId}/aadhaar.webp`);
    await uploadBytes(fileRef, compressed, { contentType: "image/webp" });

  } else {
    alert("Aadhaar must be PDF or JPG/JPEG/PNG");
    resetUpdateButton(btn);
    return;
  }

  aadhaarUrl = await getDownloadURL(fileRef);
}


/* ===== OTHER DOC ===== */
if (otherDocInput?.files.length > 0) {

  const file = otherDocInput.files[0];
  const type = file.type;

  if (file.size > MAX_DOC_SIZE) {
    alert("Other document must be under 2MB");
    resetUpdateButton(btn);
    return;
  }

  if (otherDocUrl && !confirm("Other document exists. Replace it?")) {
    resetUpdateButton(btn);
    return;
  }

  let fileRef;

  if (type === "application/pdf") {

    fileRef = ref(storage, `farmer-documents/${currentFarmBuddieId}/other.pdf`);
    await uploadBytes(fileRef, file, { contentType: "application/pdf" });

  } else if (type.startsWith("image/")) {

    const compressed = await compressImage(file);
    fileRef = ref(storage, `farmer-documents/${currentFarmBuddieId}/other.webp`);
    await uploadBytes(fileRef, compressed, { contentType: "image/webp" });

  } else {
    alert("Other document must be PDF or JPG/JPEG/PNG");
    resetUpdateButton(btn);
    return;
  }

  otherDocUrl = await getDownloadURL(fileRef);
}


/* ===== FARMER PHOTO ===== */
if (farmerPhotoInput?.files.length > 0) {

  const file = farmerPhotoInput.files[0];
  const type = file.type;

  if (!type.startsWith("image/")) {
    alert("Photo must be JPG/JPEG/PNG");
    resetUpdateButton(btn);
    return;
  }

  if (file.size > MAX_IMAGE_SIZE) {
    alert("Photo must be under 5MB");
    resetUpdateButton(btn);
    return;
  }

  if (farmerPhotoUrl && !confirm("Photo exists. Replace it?")) {
    resetUpdateButton(btn);
    return;
  }

  const compressed = await compressImage(file);

  const fileRef = ref(
    storage,
    `farmer-documents/${currentFarmBuddieId}/farmer-photo.webp`
  );

  await uploadBytes(fileRef, compressed, {
    contentType: "image/webp"
  });

  farmerPhotoUrl = await getDownloadURL(fileRef);
}

showLoader("Updating Farmer...");

    /* ================= BUILD DATA ================= */

    const { missing: missingValveField } = readValveConfig();
    if (missingValveField) {
      alert(`Please enter ${missingValveField} (0 if none)`);
      hideLoader();
      return resetUpdateButton(btn);
    }

    const updatedData = {
      role: farmerRole ? farmerRole.value : "MAIN",
      title: title.value,
      name: farmerNameValue,
      primaryMobile: cleanedPrimary,
      secondaryMobile: cleanedSecondary,
      aadhaarNumber: cleanedAadhaar,
      emailId: emailValue || "",
      address: address.value.trim(),

      leadSource: {
          type: leadSourceType.value,
          distributorId:
            leadSourceType.value === "DISTRIBUTOR"
              ? distributorSelect.value
              : "",
          distributorName:
            leadSourceType.value === "DISTRIBUTOR"
              ? distributorSelect.selectedOptions[0]?.dataset.companyName || ""
              : "Farm Buddie Smart Irrigation"
        },

      farmDetails: {
        location: farmLocation.value.trim(),
        latitude: farmLatitude.value.trim(),
        longitude: farmLongitude.value.trim()
      },

      network: { type: networkType },

      sim: {
    simNumber: simNumber.value.trim(),
    msisdn: simMsisdn.value.trim(),
    simImsi: simImsi.value.trim(),
    imeiNumber: simImei.value.trim(),
    simType: simType.value,
    billingCycle: billingCycle.value,
    activationDate: activationDate.value
},

      controller: oldData.controller || {},

      appUsers: appUsers,

      documents: {
        aadhaarUrl,
        otherDocUrl,
        farmerPhotoUrl
      },

      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser.uid

    };

        /* ===== MOTOR CONFIG ===== */
    updatedData.motorConfig = {
      motorCount: parseInt(document.getElementById("motorCount")?.value || 0),
      pumpHp: Array.from({
        length: parseInt(document.getElementById("motorCount")?.value || 0)
      }).map((_, i) =>
        document.getElementById(`pump${i+1}Hp`)?.value
      )
    };

    /* ===== VALVE CONFIG ===== */
    updatedData.valveConfig = readValveConfig().config;

    /* ===== TNEB SERVICES ===== */
    updatedData.tnebServices = {
      serviceCount: parseInt(document.getElementById("serviceCount")?.value || 0),
      services: Array.from({
        length: parseInt(document.getElementById("serviceCount")?.value || 0)
      }).map((_, i) => ({
        serviceNumber: i + 1,
        sanctionedHp: document.getElementById(`service${i+1}Hp`)?.value
      }))
    };

    /* ===== PUMP SERVICE MAPPING ===== */
    updatedData.pumpServiceMapping = Array.from({
      length: parseInt(document.getElementById("motorCount")?.value || 0)
    }).map((_, i) => ({
      pumpNumber: i + 1,
      hp: document.getElementById(`pump${i+1}Hp`)?.value,
      service: document.getElementById(`pump${i+1}Service`)?.value
    }));

/* ================= CONTROLLER UPDATE (UPGRADE MODE) ================= */

if (upgradeToggle?.checked) {

  if (!mcuVariant.value || !mcuSerial.value) {
    alert("Please select MCU Variant and Serial Number");
    hideLoader();
    return resetUpdateButton(btn);
  }

  /* ---------- GET CURRENT FARMER CONTROLLER ---------- */

  const farmerSnap = await getDoc(doc(db, "farmers", docId));
  const oldController = farmerSnap.data().controller;

  /* ---------- GET NEW CONTROLLER ---------- */

  const newQuery = query(
    collection(db, "controllers"),
    where("serialNumber", "==", mcuSerial.value)
  );

  const newSnap = await getDocs(newQuery);

  if (newSnap.empty) {
    alert("Selected controller not found");
    hideLoader();
    return resetUpdateButton(btn);
  }

  const controllerDoc = newSnap.docs[0];
  const controllerData = controllerDoc.data();

  if (!controllerData.uniqueId) {
    alert("Controller uniqueId missing");
    hideLoader();
    return resetUpdateButton(btn);
  }

  /* ---------- STEP 1: UPDATE SIM ---------- */

 /* updatedData.sim = {

    simNumber: controllerData.simNumber || "",

    msisdn: controllerData.simMsisdn || "",

    imeiNumber: controllerData.imeiNumber || "",

    simType: simType.value,

    billingCycle: billingCycle.value,

    activationDate: activationDate.value

};*/

updatedData.sim = {
    simNumber: oldData.sim?.simNumber || "",
    msisdn: oldData.sim?.msisdn || "",
    simImsi: oldData.sim?.simImsi || "",
    imeiNumber: controllerData.imeiNumber || "",
    simType: oldData.sim?.simType || simType.value,
    billingCycle: oldData.sim?.billingCycle || billingCycle.value,
    activationDate: oldData.sim?.activationDate || activationDate.value
};

/* ---------- STEP 1: UPDATE SIM ---------- */

 updatedData.controller = {

    variant: controllerData.variant || "",

    serialNumber: controllerData.serialNumber || "",

    uniqueId: controllerData.uniqueId || "",

    farmId: controllerData.farmId || "",

    warranty: {
        start: warrantyStart.value || "",
        end: warrantyEnd.value || ""
    },

    mqtt: {

        brokerUrl: controllerData.mqttUrl || "",

        port: controllerData.mqttPort || 8883,

        username: controllerData.username || "",

        // the controller doc stores it as mqttPasswordPlaintext
        password: controllerData.mqttPasswordPlaintext || ""

    }

};

  // STEP 0: VALIDATE FIRST
   await validatePhones(db, {
  ...oldData,
  ...updatedData,
  identityId: oldData.identityId || oldData.aadhaarNumber
});

// STEP 1: UPDATE FARM
  await updateDoc(doc(db, "farmers", docId), updatedData);

// ✅ ALWAYS FETCH LATEST DATA
const latestSnap = await getDoc(doc(db, "farmers", docId));
const latestData = latestSnap.data();

// ✅ CORRECT SYNC
await fullPhoneSync(db, auth, docId, latestData);

  /* ---------- STEP 2: OLD CONTROLLER → SOLD ---------- */

  if (oldController?.serialNumber) {

    const oldQuery = query(
      collection(db, "controllers"),
      where("serialNumber", "==", oldController.serialNumber)
    );

    const oldSnap = await getDocs(oldQuery);

    for (const d of oldSnap.docs) {
      await updateDoc(doc(db, "controllers", d.id), {
          status: "sold",
          farmerDocId: null,
          farmerId: null,
          assignedAt: null,
          updatedAt: serverTimestamp()
        });
    }
  }

/* ---------- STEP 3: NEW CONTROLLER → ASSIGNED ---------- */

await updateDoc(doc(db, "controllers", controllerDoc.id), {
  status: "assigned",
  farmerDocId: docId,
  farmerId: currentFarmBuddieId,
  assignedAt: serverTimestamp(),
  updatedAt: serverTimestamp()
});

const now = new Date();
const formattedTime = now.toLocaleString();

hideLoader();

alert(`✅ Farmer updated successfully
Farm Buddie ID: ${currentFarmBuddieId}
Variant: ${mcuVariant.value}
Updated at: ${formattedTime}`);

// The new controller needs its own MQTT login (same as Add Farm /
// onboarding) - returns the existing one if it already has it. The farm is
// saved either way; a failure here can be retried from the MCU / Controller
// page's Generate MQTT Credentials button.
try {
  const mqttData = await provisionDeviceCredentials(auth, controllerDoc.id);
  await showMqttCredentialModal(mqttData);
} catch (mqttErr) {
  console.error("MQTT auto-provisioning error:", mqttErr);
  alert(
    "⚠ Farm saved, but MQTT credential generation failed: " + mqttErr.message +
    "\n\nYou can retry from the MCU / Controller page."
  );
}

window.location.href = "/admin/farmer-database.html";
return;
}
   /* ================= STEP 1: UPDATE CURRENT FARM ================= */

   // STEP 0: VALIDATE FIRST
    await validatePhones(db, {
  ...oldData,
  ...updatedData,
  identityId: oldData.identityId || oldData.aadhaarNumber
});

// STEP 1: UPDATE FARM
    await updateDoc(doc(db, "farmers", docId), updatedData);

      // ✅ ALWAYS FETCH LATEST DATA
    const latestSnap = await getDoc(doc(db, "farmers", docId));
    const latestData = latestSnap.data();

    // ✅ CORRECT SYNC
    await fullPhoneSync(db, auth, docId, latestData);
    /* ================= STEP 2: SYNC IDENTITY IF FARM 1 ================= */

    if (isPrimaryFarmGlobal) {

      const farmQuery = query(
        collection(db, "farmers"),
        where("identityId", "==", currentIdentityId)
      );

      const farmSnap = await getDocs(farmQuery);

      for (const farmDoc of farmSnap.docs) {

        if (farmDoc.id === docId) continue;

        await updateDoc(doc(db, "farmers", farmDoc.id), {
          role: updatedData.role,
          title: updatedData.title,
          name: updatedData.name,
          primaryMobile: updatedData.primaryMobile,
          secondaryMobile: updatedData.secondaryMobile,
          aadhaarNumber: updatedData.aadhaarNumber,
          emailId: updatedData.emailId,
          address: updatedData.address,
          documents: updatedData.documents,

           // 🔥 ADD THIS
          leadSource: updatedData.leadSource,

          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser.uid
        });
      }
    }

    hideLoader();
    const now = new Date();
    const formattedTime = now.toLocaleString();


    alert(`✅ Farmer updated successfully
    Farm Buddie ID: ${currentFarmBuddieId}
    Updated at: ${formattedTime}`);

    window.location.href = "/admin/farmer-database.html";

  } catch (error) {

    console.error("Update error:", error);
    alert("❌ Error updating farmer" + error.message);
    hideLoader();
    resetUpdateButton(btn);
  }
};

/* ===== RESET BUTTON ===== */
function resetUpdateButton(btn) 
{
  btn.disabled = false;
  btn.innerText = "Update Farmer";
  btn.style.opacity = "1";
  btn.style.cursor = "pointer";
}

/* ================= LEAD SOURCE TOGGLE ================= */
window.handleLeadSource = async function () {

  const distributorField = document.getElementById("distributorField");

  if (leadSourceType.value === "DISTRIBUTOR") {
    distributorField.style.display = "block";
    await loadDistributors();
  } else {
    distributorField.style.display = "none";
    distributorSelect.value = "";
  }
};

async function loadDistributors() {

  const snap = await getDocs(collection(db, "distributors"));

  distributorSelect.innerHTML =
    `<option value="">Select Distributor</option>`;

  snap.forEach(docSnap => {

    const d = docSnap.data();
    const company = d.companyName || d.name || "Unnamed Distributor";

    const option = document.createElement("option");
    option.value = d.distributorId || docSnap.id;
    option.textContent =
      `${company} (${d.distributorId || docSnap.id})`;

    option.dataset.companyName = company;

    distributorSelect.appendChild(option);
  });
}
