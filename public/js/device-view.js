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
   MOTOR STATE/FAULT CODES
   Mirrors Irrigo app's PumpCodes.kt (STATE_*/FAULT_*) - a small, stable
   enum, safe to keep in sync here without the drift risk a much larger
   mapping (e.g. the alert EVENT_* codes) would carry. See that file if
   the firmware ever adds a new state/fault code.
===================================================== */

const STATE_LABELS = {
  0: "Stopped",
  1: "Running",
  2: "Starting",
  3: "Stopping",
  4: "Fault",
  5: "Changeover",
};

const FAULT_LABELS = {
  0: null, // no fault - nothing to show
  1: "Dry Run",
  2: "Overload",
  3: "Voltage Low",
  4: "Voltage High",
  5: "Phase Loss",
  6: "Phase Imbalance",
  10: "Power Outage",
};

function formatDurationShort(totalSec) {
  if (totalSec == null) return "-";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

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

  renderMotors(data, isOnline);
  renderValves(data.motor1?.valves, isOnline);
});

/* =====================================================
   UPDATE STATUS SECTION
   deviceStatus.health mirrors the device's `health` topic (see
   farmbuddie-web's server/src/bridge/firestoreMirror.js mirrorHealth() -
   NOT the per-motor `status` topic (deviceStatus.motor1/motor2), a
   separate message on its own cadence with its own field shape (see
   Irrigo app's model/PumpModels.kt HealthStatus).
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

  /* ================= HEALTH DISPLAY ================= */

  const health = data.health || {};

  // Firmware version is worth showing even offline (static info, not a
  // live reading) - same reasoning the old version kept `fw` visible
  // while offline.
  document.getElementById("fw").innerText = health.fw_version ?? "-";

  if (!isOnline) {
    document.getElementById("transport").innerText = "--";
    document.getElementById("signal").innerText = "--";
    document.getElementById("mqttUptime").innerText = "--";
    document.getElementById("deviceUptime").innerText = "--";
    document.getElementById("resetReason").innerText = "--";
  } else {
    document.getElementById("transport").innerText =
      health.transport ?? "-";
    document.getElementById("signal").innerText =
      health.signal_pct != null ? `${health.signal_pct}%` : "-";
    document.getElementById("mqttUptime").innerText =
      formatDurationShort(health.uptime_sec);
    document.getElementById("deviceUptime").innerText =
      formatDurationShort(health.device_uptime_sec);
    document.getElementById("resetReason").innerText =
      health.reset_reason ?? "-";
  }

  return isOnline;   // 🔥 VERY IMPORTANT
}

/* =====================================================
   RENDER MOTORS (WITH OFFLINE SAFE DISPLAY)
   Real shape: deviceStatus.motor1/motor2, the firmware's raw `status`
   topic payload (state/fault are integer codes, v/i are {r,y,b} phase
   readings) - see Irrigo app's model/PumpModels.kt PumpStatus. motor2
   only exists here at all once this farm's Motor_2 has ever published a
   status (i.e. it's paired) - a farm with only Motor 1 simply never gets
   a motor2 key, online or offline.
===================================================== */

function renderMotors(data, isOnline) {

  const grid = document.getElementById("motorGrid");
  grid.innerHTML = "";

  ["motor1", "motor2"].forEach((key, index) => {

    if (!(key in data)) return; // never paired/never reported - no card at all

    const motor = data[key] || {};

    const stateLabel = isOnline ? (STATE_LABELS[motor.state] ?? `Code ${motor.state}`) : "--";
    const faultLabel = isOnline ? FAULT_LABELS[motor.fault] : null;

    const v = isOnline ? (motor.v || {}) : {};
    const i = isOnline ? (motor.i || {}) : {};
    const vR = v.r ?? "--", vY = v.y ?? "--", vB = v.b ?? "--";
    const iR = i.r ?? "--", iY = i.y ?? "--", iB = i.b ?? "--";

    const runSec = isOnline ? formatDurationShort(motor.run_sec) : "--";
    const cyclic = isOnline ? (motor.cyclic_running ? "Yes" : "No") : "--";
    const light = isOnline ? (motor.light_on ? "ON" : "OFF") : "--";
    const lightIcon = motor.light_on ? "💡" : "🔌";

    let imagePath = "/assets/motors/motor1-idle.png";
    if (isOnline && motor.state === 1) {
      imagePath = "/assets/motors/motor1-running.gif";
    }

    const div = document.createElement("div");
    div.className = "motor-card";

    div.innerHTML = `
      <div class="motor-left">

        <div class="motor-header">
          <strong>Motor ${index + 1}</strong>
          <span class="status-pill ${isOnline ? "status-online" : "status-offline"}">
            ${isOnline ? "ONLINE" : "OFFLINE"}
          </span>
        </div>

        <div class="motor-info">
          State: ${stateLabel}${faultLabel ? ` (${faultLabel})` : ""} | Run: ${runSec} | Cyclic: ${cyclic}
        </div>

        <div class="motor-light">
          ${lightIcon} Light: ${light}
        </div>

        <br>

        <div class="phase-inline">
          <div class="phase-r">R: ${vR}V / ${iR}A</div>
          <div class="phase-y">Y: ${vY}V / ${iY}A</div>
          <div class="phase-b">B: ${vB}V / ${iB}A</div>
        </div>

      </div>

      <div class="motor-visual">
        <img src="${imagePath}" alt="Motor ${index + 1}">
      </div>
    `;

    grid.appendChild(div);
  });
}

/* =====================================================
   RENDER VALVES (OFFLINE SAFE)
   `valves` is a plain open/closed boolean array (index 0 = valve 1),
   only present at all when valve mesh mode is on for this farm - see
   PumpModels.kt's own doc comment on PumpStatus.valves. null/absent
   means "no valve mesh configured", not "everything closed" - rendered
   as an empty grid rather than pretending a fixed valve count exists.
===================================================== */

function renderValves(valves, isOnline) {

  const grid = document.getElementById("valveGrid");
  grid.innerHTML = "";

  if (!valves || valves.length === 0) {
    grid.innerHTML = `<div class="valve-box">No valve mesh configured</div>`;
    return;
  }

  valves.forEach((open, idx) => {

    const div = document.createElement("div");
    div.className = "valve-box";

    if (!isOnline) {
      div.innerHTML = `V${idx + 1}<br><span class="valve-offline">--</span>`;
    } else {
      div.innerHTML = `
        V${idx + 1}<br>
        <span class="${open ? "valve-open" : "valve-offline"}">
          ${open ? "OPEN" : "CLOSED"}
        </span>
      `;
    }

    grid.appendChild(div);
  });
}
