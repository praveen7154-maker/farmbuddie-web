import { db } from "/js/firebase-init.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { formatDurationShort, renderMotorsInto, renderValvesInto } from "/js/device-status-render.js";

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

  renderMotorsInto(document.getElementById("motorGrid"), data, isOnline);
  renderValvesInto(document.getElementById("valveGrid"), data.motor1?.valves, isOnline);
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

    // Online if updated within 270s - same threshold as isDeviceOnline()
    // (device-status-render.js); status comes every 120s with no app open.
    isOnline = diff < 270;

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
