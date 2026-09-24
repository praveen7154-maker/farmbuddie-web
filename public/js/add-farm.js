import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  addDoc,
  updateDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  fullPhoneSync,
  validatePhones
} from "/js/phone-auth.js";

import { provisionDeviceCredentials, showMqttCredentialModal } from "/js/provisioning.js";

/* ================= AUTH ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GLOBAL STATE ================= */
let selectedFarmerData = null;

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
  const start = document.getElementById("warrantyStart").value;
  const endInput = document.getElementById("warrantyEnd");

  if (!start) {
    endInput.value = "";
    return;
  }

  const d = new Date(start);
  d.setFullYear(d.getFullYear() + 1);
  endInput.value = d.toISOString().split("T")[0];
};

/* ================= NETWORK TYPE HANDLER (NEW - SAFE ADD) ================= */
window.handleNetworkType = function () {

  const type = document.getElementById("networkType")?.value;
  if (!type) return;

  const simNumber = document.getElementById("simNumber");
  const simMsisdn = document.getElementById("simMsisdn");
  const simImei = document.getElementById("simImei");
  const simType = document.getElementById("simType");
  const billingCycle = document.getElementById("billingCycle");

  if (type === "WIFI_FARMER") {

    [simNumber, simMsisdn, simImei, simType, billingCycle].forEach(field => {
      if (!field) return;
      field.disabled = true;
      field.value = "";
    });

    // Optional: keep yearly default
    billingCycle.value = "Yearly";
  }

  if (type === "SIM") {

    [simNumber, simMsisdn, simImei, simType, billingCycle].forEach(field => {
      if (!field) return;
      field.disabled = false;
    });

  }
};
/* ================= FARM ID GENERATOR ================= */
async function generateFarmBuddieId() {

  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", "farmers");

  return await runTransaction(db, async (tx) => {

    const snap = await tx.get(counterRef);
    let current = snap.exists() ? snap.data().current || 0 : 0;

    current += 1;
    tx.set(counterRef, { current }, { merge: true });

    return `FARM-${year}-${String(current).padStart(4, "0")}`;
  });
}


/* ================= SEARCH FARMER ================= */
const searchInput = document.getElementById("farmerSearchInput");
const resultsBox = document.getElementById("farmerSearchResults");

searchInput?.addEventListener("input", async () => {

  const value = searchInput.value.trim();
  resultsBox.innerHTML = "";
  selectedFarmerData = null;

  if (value.length < 5) return;

  let q;

 // Always search only by Farm Buddie ID (Farm 1 only)
q = query(
  collection(db, "farmers"),
  where("farmBuddieId", "==", value),
  where("farmNumber", "==", "Farm 1")
);

 const snap = await getDocs(q);

resultsBox.innerHTML = ""; // always clear previous results

if (snap.empty) {

  resultsBox.innerHTML = `
    <div class="search-item no-result">
      ❌ No farmers found
    </div>
  `;
  
} else {

  snap.forEach(docSnap => {

    const data = docSnap.data();

    const div = document.createElement("div");
    div.className = "search-item";
    div.dataset.id = docSnap.id;

    const farmLabel = data.farmNumber || "Farm 1";
    const isPrimary = farmLabel === "Farm 1";

    div.innerHTML = `
      <div class="search-card-header">
        <strong>${data.name}</strong>
        <span class="farm-badge ${isPrimary ? 'primary-farm' : ''}">
          ${farmLabel}
        </span>
      </div>
      <div>Mobile: ${data.primaryMobile}</div>
      <div>Farm ID: ${data.farmBuddieId}</div>
    `;

    div.onclick = async () => {

      document.querySelectorAll(".search-item").forEach(item =>
        item.classList.remove("selected")
      );

      div.classList.add("selected");

      await selectFarmer(docSnap.id, data);
    };

    resultsBox.appendChild(div);

  });

}
  
});
async function selectFarmer(docId, data) {

  selectedFarmerData = data;

  /* ===== SAFETY CHECK ===== */
  if (!data.identityId) {
    alert("❌ Farmer identity missing. Cannot calculate farms.");
    selectedFarmerData = null;
    return;
  }

  document.getElementById("selectedFarmerDocId").value = docId;

  /* Load Identity */
  document.getElementById("title").value = data.title || "Mr";
  document.getElementById("farmerName").value = data.name;
  document.getElementById("primaryMobile").value = data.primaryMobile;
  document.getElementById("secondaryMobile").value = data.secondaryMobile || "";
  document.getElementById("aadhaarNumber").value = data.aadhaarNumber || "";
  document.getElementById("emailId").value = data.emailId || "";
  document.getElementById("address").value = data.address || "";

  // ===== DISPLAY LEAD SOURCE (READ ONLY) =====
    const leadSourceDisplay = document.getElementById("leadSourceDisplay");

        if (data.leadSource?.type === "DISTRIBUTOR") {
        leadSourceDisplay.value =
          "Distributor - " + (data.leadSource.distributorName || "");
      } else {
        leadSourceDisplay.value = "Direct - Farm Buddie Smart Irrigation";
      }

  /* Count existing farms */
      const farmQuery = query(
      collection(db, "farmers"),
      where("identityId", "==", data.identityId)
    );

  const farmSnap = await getDocs(farmQuery);
  const farmCount = farmSnap.size;

  if (farmCount >= 5) {
    alert("Maximum 5 farms allowed per farmer");
    selectedFarmerData = null;
    return;
  }

  const nextFarmNumber = farmCount + 1;

  document.getElementById("farmNumber").value = `Farm ${nextFarmNumber}`;
}

/* ===== LOCK FARMER IDENTITY + FARM NUMBER ===== */
[
  "title",
  "farmerName",
  "primaryMobile",
  "secondaryMobile",
  "aadhaarNumber",
  "emailId", 
  "address",
  "farmNumber"
].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.disabled = true;
    el.style.backgroundColor = "#f3f3f3"; // optional visual cue
  }
});

/* ================= MCU VARIANT → SERIAL ================= */
window.handleMcuVariant = async function () {

  const variant = document.getElementById("mcuVariant").value;
  const serialField = document.getElementById("serialField");
  const mcuSerialList = document.getElementById("mcuSerialList");
  const mcuSerial = document.getElementById("mcuSerial");

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

    snap.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.data().serialNumber;
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

    // Remove old mapping if exists
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

    // 🔥 THIS LINE MAKES IT MATCH ONBOARDING
    pumpSelect.parentElement.appendChild(wrapper);
  }
}

/* ================= SERIAL VALIDATION ================= */
window.validateMcuSerial = async function () {

 
  const mcuVariant = document.getElementById("mcuVariant");
   const variant = mcuVariant.value;
  const mcuSerial = document.getElementById("mcuSerial");
   
  const enteredSerial = mcuSerial.value?.trim();
 

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

document.getElementById("simImei").value =
    controller.imeiNumber || "";

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

   /* ================= SAFETY CHECK ================= */
    if (!selectedFarmerData) {
      alert("Please search and select a farmer first.");
      resetButton(btn);
      return;
    }


   /* ================= DOM REFERENCES ================= */
      const farmerName = document.getElementById("farmerName");
      const primaryMobile = document.getElementById("primaryMobile");
      const secondaryMobile = document.getElementById("secondaryMobile");
      const aadhaarNumber = document.getElementById("aadhaarNumber");

      const farmLocation = document.getElementById("farmLocation");
      const farmLatitude = document.getElementById("farmLatitude");
      const farmLongitude = document.getElementById("farmLongitude");

      const appUser2Name = document.getElementById("appUser2Name");
      const appUser2Mobile = document.getElementById("appUser2Mobile");
      const appUser3Name = document.getElementById("appUser3Name");
      const appUser3Mobile = document.getElementById("appUser3Mobile");

      const networktype = document.getElementById("networkType");
      const simNumber = document.getElementById("simNumber");
      const simMsisdn = document.getElementById("simMsisdn");
      const simImei = document.getElementById("simImei");
      const simType = document.getElementById("simType");
      const billingCycle = document.getElementById("billingCycle");
      const activationDate = document.getElementById("activationDate");

      const mcuVariant = document.getElementById("mcuVariant");
      const variant = mcuVariant.value;   // 🔥 MOVE HERE
      const mcuSerial = document.getElementById("mcuSerial");

      const warrantyStart = document.getElementById("warrantyStart");
      const warrantyEnd = document.getElementById("warrantyEnd");

      const title = document.getElementById("title");
      const address = document.getElementById("address");


    /* ================= BASIC VALUES ================= */
    const selectedFarmNumber = document.getElementById("farmNumber")?.value || "Farm 1";

    const farmerNameValue = farmerName.value.trim();
    const cleanedPrimary = selectedFarmerData.primaryMobile;
    const cleanedSecondary = selectedFarmerData.secondaryMobile || "";
    const cleanedAadhaar = selectedFarmerData.aadhaarNumber;


    const cleanedAppUser2 = cleanPhone(appUser2Mobile.value.trim());
    const cleanedAppUser3 = cleanPhone(appUser3Mobile.value.trim());
    const networkType = networktype.value;

   /* ================= VALIDATIONS ================= */

      if (!farmLocation.value.trim()) {
        alert("Farm Location is mandatory");
        resetButton(btn);
        return;
      }

  /* ================= UPDATED SIM VALIDATION ================= */
    /*const simNumberRaw = document.getElementById("simNumber").value.trim();
    const cleanedSimNumber = simNumberRaw.replace(/\D/g, "").slice(0, 13);
     if (networkType === "SIM") {

        if (!cleanedSimNumber) {
          alert("SIM Number is mandatory");
          return resetButton(btn);
        }

        if (!isValidSim(cleanedSimNumber)) {
          alert("SIM Number must be exactly 13 digits");
          return resetButton(btn);
        }
      }

      if (networkType === "SIM") {
          if (!simIccid.value.trim()) {
            alert("SIM ICCID is mandatory");
            return resetButton(btn);
          }
        }*/

          // ===== App User 2 Validation =====
      if (appUser2Name.value.trim() || cleanedAppUser2) {

        if (!appUser2Name.value.trim()) {
          alert("App User 2 Name is required if Mobile is entered");
          return resetButton(btn);
        }

        if (!isValidIndianMobile(cleanedAppUser2)) {
          alert("App User 2 Mobile must be valid 10-digit (starts with 6-9)");
          return resetButton(btn);
        }
      }

      // ===== App User 3 Validation =====
      if (appUser3Name.value.trim() || cleanedAppUser3) {

        if (!appUser3Name.value.trim()) {
          alert("App User 3 Name is required if Mobile is entered");
          return resetButton(btn);
        }

        if (!isValidIndianMobile(cleanedAppUser3)) {
          alert("App User 3 Mobile must be valid 10-digit (starts with 6-9)");
          return resetButton(btn);
        }
      }

      // ===== Activation Date Mandatory =====
          if (!activationDate.value) {
            alert("Activation Date is mandatory");
            resetButton(btn);
            return;
          }

    /* ===== MOTOR & VALVE VALIDATION ===== */
      if (variant === "IRRIGO" || variant === "IRRIGO_PLUS") {

        const motorCount = document.getElementById("motorCount")?.value;

        if (!motorCount) {
          alert("Please select number of motors");
          return resetButton(btn);
        }

        for (let i = 1; i <= parseInt(motorCount); i++) {
          const hp = document.getElementById(`pump${i}Hp`)?.value;
          if (!hp) {
            alert(`Please select HP for Pump ${i}`);
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

      //End Pump-Service Validation

        const valve24 = document.getElementById("valve24Count")?.value.trim();
        const valve9 = document.getElementById("valve9Count")?.value.trim();

        if (valve24 === "") {
          alert("Please enter number of 24V AC valves");
          return resetButton(btn);
        }

        if (variant === "IRRIGO_PLUS" && valve9 === "") {
          alert("Please enter number of 9V DC valves");
           return resetButton(btn);
        }

      }


    /* ================= CONTROLLER VALIDATION ================= */

    const serial = mcuSerial.value.trim();

    if (!variant || !serial) {
      alert("Select MCU Variant & Serial");
      return resetButton(btn), hideLoader();
    }

    const controllerQuery = query(
      collection(db, "controllers"),
      where("variant", "==", variant),
      where("serialNumber", "==", serial),
      where("status", "==", "available")
    );

    const controllerSnap = await getDocs(controllerQuery);

    if (controllerSnap.empty) {
      alert("Selected MCU not available");
      return resetButton(btn), hideLoader();
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

    if (!controller.imeiNumber) {
        alert("Selected controller does not have an IMEI Number.");
        hideLoader();
        return resetButton(btn);
    }

}

   showLoader();

   // Use existing identity
    const selectedFarmerDocId = document.getElementById("selectedFarmerDocId").value;

    const identityId = selectedFarmerData.identityId || selectedFarmerData.aadhaarNumber;

    const mainFarmerId = selectedFarmerData.mainFarmerId || selectedFarmerDocId;


    /* ================= GENERATE FARM ID ================= */
    const farmBuddieId = await generateFarmBuddieId();

    /* ================= BUILD MOTOR CONFIG ================= */

const motorCount = parseInt(document.getElementById("motorCount")?.value || 0);

const motorConfig = {
  motorCount: motorCount,
  pumpHp: Array.from({ length: motorCount }).map((_, i) =>
    document.getElementById(`pump${i+1}Hp`)?.value
  )
};

/* ================= BUILD TNEB SERVICES ================= */

const serviceCount = parseInt(document.getElementById("serviceCount")?.value || 0);

const tnebServices = {
  serviceCount: serviceCount,
  services: []
};

for (let i = 1; i <= serviceCount; i++) {
  tnebServices.services.push({
  serviceNumber: i,
  sanctionedHp: document.getElementById(`service${i}Hp`)?.value || ""
});
}

/* ================= BUILD PUMP SERVICE MAPPING ================= */

const pumpServiceMapping = Array.from({ length: motorCount }).map((_, i) => ({
  pumpNumber: i + 1,
  hp: document.getElementById(`pump${i+1}Hp`)?.value,
  service: document.getElementById(`pump${i+1}Service`)?.value
}));

/* ================= BUILD VALVE CONFIG ================= */

const valveConfig = {
  valve24Count: parseInt(document.getElementById("valve24Count")?.value || 0),
  valve9Count: parseInt(document.getElementById("valve9Count")?.value || 0),
  filterBackwashCount: parseInt(document.getElementById("filterBackwashCount")?.value || 0),
  waterLevelMonitoring: parseInt(document.getElementById("waterLevelMonitoring")?.value || 0)
};
    /* ================= BUILD APP USERS ================= */

    const appUsers = [];

    if (appUser2Name.value.trim() && isValidIndianMobile(cleanedAppUser2)) {
      appUsers.push({ name: appUser2Name.value.trim(), mobile: cleanedAppUser2 });
    }

    if (appUser3Name.value.trim() && isValidIndianMobile(cleanedAppUser3)) {
      appUsers.push({ name: appUser3Name.value.trim(), mobile: cleanedAppUser3 });
    }

    /* ================= BUILD DATA ================= */

    const farmerData = {
      farmBuddieId,
      farmNumber: selectedFarmNumber,
       identityId: identityId,
          mainFarmerId: mainFarmerId,

          leadSource: selectedFarmerData.leadSource || {
          type: "DIRECT",
          distributorName: "Farm Buddie Smart Irrigation"
        },

      role: document.getElementById("farmerRole")?.value || "MAIN",

      title: title.value,
      name: farmerNameValue,
      primaryMobile: cleanedPrimary,
      secondaryMobile: cleanedSecondary,
      aadhaarNumber: cleanedAadhaar,
      emailId: selectedFarmerData.emailId || "",
      address: address.value.trim(),

      farmDetails: {
        location: farmLocation.value.trim(),
        latitude: farmLatitude.value.trim(),
        longitude: farmLongitude.value.trim()
      },

      network: { type: networkType },

      sim: {

    simNumber: controller.simNumber || "",

    msisdn: controller.simMsisdn || "",

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

      motorConfig,
      tnebServices,
      pumpServiceMapping,
      valveConfig,

       documents: selectedFarmerData.documents || {},
      
      appUsers,
      status: "active",
      phoneAuth: {
          enabled: true
        },
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser.uid
    };

    // 🔥 STEP 1: VALIDATE FIRST (NO SAVE)
    await validatePhones(db, farmerData);

    // 🔥 STEP 2: SAVE FARM
    const newFarmRef = await addDoc(collection(db, "farmers"), farmerData);

    // 🔥 PHONE AUTH SYNC (ADD THIS LINE)
    await fullPhoneSync(db, auth, newFarmRef.id, farmerData, true);

    await updateDoc(doc(db, "controllers", controllerDoc.id), {
      status: "assigned",
      assignedAt: serverTimestamp(),
      // The NEW farm's own doc - not the farmer's first farm
      // (selectedFarmerDocId). MQTT credentials are written to this doc.
      farmerDocId: newFarmRef.id,
      farmerId: farmBuddieId,
      networkType: networkType,
      updatedAt: serverTimestamp()
    });
    const now = new Date();
    const formattedTime = now.toLocaleString();
    hideLoader();
    alert(
  `✅ New Farm Onboarded Successfully\n` +
  `Farm Buddie ID: ${farmBuddieId}\n` +
  `Onboarded at: ${formattedTime}`
);

    // 🔥 AUTO-PROVISION MQTT CREDENTIALS — the farm itself is already saved
    // at this point regardless of what happens here, so a failure here is a
    // warning, not a save error (retry later via the controller panel's
    // Generate MQTT Credentials button).
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

  } catch (error) {
    console.error(error);
    alert("Error saving new farm: " + error.message);
    hideLoader();
    resetButton(btn);
  }
};

function resetButton(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerText = "Save Farm";
  btn.style.opacity = "1";
  btn.style.cursor = "pointer";
  //btn.style.cursor = "not-allowed";
}

/* ===== STRICT NUMERIC INPUT HANDLING ===== */

[
  "appUser2Mobile",
  "appUser3Mobile"
].forEach(id => {

  const input = document.getElementById(id);
  if (!input) return;

  input.addEventListener("input", function () {
    this.value = this.value.replace(/\D/g, "").slice(0, 10);
  });

});

