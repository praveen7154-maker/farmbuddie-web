import { db } from "/js/firebase-init.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* =====================================================
   GET FARMER ID
===================================================== */

const urlParams = new URLSearchParams(window.location.search);
const farmerId = urlParams.get("id");

if (!farmerId) {
  alert("Invalid Device ID");
  window.location.href = "/admin/analytics.html";
}

const farmerRef = doc(db, "farmers", farmerId);

/* =====================================================
   REALTIME LISTENER
===================================================== */

onSnapshot(farmerRef, (snap) => {
  if (!snap.exists()) return;

  const farmerData = snap.data();
  const data = farmerData.deviceStatus || {};

  document.getElementById("farmId").innerText =
    farmerData.farmBuddieId || "-";

  document.getElementById("uniqueId").innerText =
    farmerData.controller?.uniqueId || "-";

 const isOnline = updateStatusSection(data);

if (!isOnline) {
  renderMotors({}, false);
  renderValves({}, false);
} else {
  renderMotors(data, true);
  renderValves(data.valves || {}, true);
}
});

/* =====================================================
   UPDATE STATUS SECTION
===================================================== */

function updateStatusSection(data) {

  let isOnline = false;

  /* ================= CHECK ONLINE STATUS ================= */

  if (data.lastSeen?.toDate) {
    const lastSeen = data.lastSeen.toDate();
    const diff = (Date.now() - lastSeen.getTime()) / 1000;

    // Device considered online if updated within 60 seconds
    isOnline = diff < 60;

    document.getElementById("lastSeenTime").innerText =
      lastSeen.toLocaleTimeString();
  } else {
    document.getElementById("lastSeenTime").innerText = "-";
  }

  /* ================= STATUS BADGE ================= */

  document.getElementById("statusText").innerText =
    isOnline ? "Online" : "Offline";

  const badge = document.getElementById("deviceStatusBadge");
  badge.innerText = isOnline ? "Online" : "Offline";
  badge.className =
    "status-pill " + (isOnline ? "status-online" : "status-offline");

  /* ================= TELEMETRY DISPLAY ================= */

  if (!isOnline) {

    // Clear live data when device is offline
    document.getElementById("wifi").innerText = "--";
    document.getElementById("packetsSent").innerText = "--";
    document.getElementById("packetsRecv").innerText = "--";
    document.getElementById("packetsLost").innerText = "--";

    // Firmware can still be shown (static info)
    document.getElementById("fw").innerText =
      data.fw ?? "-";

  } else {

    // Show real-time values when online
    document.getElementById("wifi").innerText =
      data.rssi ?? "-";

    document.getElementById("fw").innerText =
      data.fw ?? "-";

    document.getElementById("packetsSent").innerText =
      data.lora?.packets_sent ?? "-";

    document.getElementById("packetsRecv").innerText =
      data.lora?.packets_recv ?? "-";

    document.getElementById("packetsLost").innerText =
      data.lora?.packets_lost ?? "-";
  }

  return isOnline;   // 🔥 VERY IMPORTANT
}

/* =====================================================
   RENDER MOTORS (WITH OFFLINE SAFE DISPLAY)
===================================================== */

function renderMotors(data, isOnline) {

  const grid = document.getElementById("motorGrid");
  grid.innerHTML = "";

  ["m1","m2","m3"].forEach((key, index) => {

    const motor = data[key] || {};

   

    const online = isOnline && motor.online === true;
    const state = online ? (motor.state || "offline").toLowerCase() : "--";

    const rssi = online ? (motor.rssi ?? "-") : "--";
    const v = online ? (motor.v || ["-","-","-"]) : ["--","--","--"];
    const i = online ? (motor.i || ["-","-","-"]) : ["--","--","--"];

     const light = online ? (motor.light === true ? "ON" : "OFF") : "--";
    const lightIcon = motor.light ? "💡" : "🔌";

    let imagePath = "/assets/motors/motor1-idle.png";

    if (online && state === "running") {
      imagePath = "/assets/motors/motor1-running.gif";
    }

    const div = document.createElement("div");
    div.className = "motor-card";

    div.innerHTML = `
      <div class="motor-left">

        <div class="motor-header">
          <strong>Motor ${index+1}</strong>
          <span class="status-pill ${online ? "status-online" : "status-offline"}">
            ${online ? "ONLINE" : "OFFLINE"}
          </span>
        </div>

        <div class="motor-info">
          LoRa RSSI: ${rssi} | State: ${online ? state.toUpperCase() : "--"}
        </div>

        <div class="motor-light">
          ${lightIcon} Light: ${light}
        </div>

        <br>

        <div class="phase-inline">
          <div class="phase-r">R: ${v[0]}V / ${i[0]}A</div>
          <div class="phase-y">Y: ${v[1]}V / ${i[1]}A</div>
          <div class="phase-b">B: ${v[2]}V / ${i[2]}A</div>
        </div>

      </div>

      <div class="motor-visual">
        <img src="${imagePath}" alt="Motor ${index+1}">
      </div>
    `;

    grid.appendChild(div);
  });
}
/* =====================================================
   RENDER VALVES (OFFLINE SAFE)
===================================================== */

function renderValves(valves, isOnline) {

  const grid = document.getElementById("valveGrid");
  grid.innerHTML = "";

  for (let n = 1; n <= 18; n++) {

    const div = document.createElement("div");
    div.className = "valve-box";

    if (!isOnline) {

      div.innerHTML = `
        V${n}<br>
        <span class="valve-offline">--</span>
      `;

    } else {

      const key = "v" + n;
      const state = (valves[key]?.state || "offline").toLowerCase();

      div.innerHTML = `
        V${n}<br>
        <span class="${state === "open" ? "valve-open" : "valve-offline"}">
          ${state.toUpperCase()}
        </span>
      `;
    }

    grid.appendChild(div);
  }
}