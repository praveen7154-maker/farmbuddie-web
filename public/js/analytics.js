import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  startDataStore,
  getFarmers,
  subscribe
} from "/js/data-store.js";

import { isDeviceOnline, renderMotorsInto, renderValvesInto } from "/js/device-status-render.js";
import { sendDeviceCommand, fetchConfigReadback } from "/js/device-commands.js";


/* ================= AUTH ================= */
// This page used to keep its own separate onSnapshot listener on the whole
// farmers collection, duplicating the one data-store.js already runs for
// controller-database.js - shares that one instead now, same pattern as
// index.js.
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  startDataStore();
  subscribe(onStoreUpdate);
  onStoreUpdate();
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= GLOBAL STATE ================= */

let allFarmers = [];
let currentSearchValue = "";
let paginationInitialized = false;

/* ================= SEARCH ================= */

document.getElementById("searchInput")?.addEventListener("input", (e) => {
  currentSearchValue = e.target.value.toLowerCase();
  applyFilter();
});

/* ================= APPLY FILTER ================= */

function applyFilter() {

  if (!currentSearchValue) {
    renderTable(allFarmers);
    return;
  }

  const filtered = allFarmers.filter(f =>
    (f.farmBuddieId || "").toLowerCase().includes(currentSearchValue) ||
    (f.controller?.uniqueId || "").toLowerCase().includes(currentSearchValue)
  );

  renderTable(filtered);
}

/* ================= STORE UPDATE ================= */
// Fires once on load and again on every data-store.js update - store
// already skips re-notifying when nothing actually changed, so no need to
// hash/compare snapshots here ourselves.
function onStoreUpdate() {
  allFarmers = getFarmers().slice().sort((a, b) =>
    (a.farmBuddieId || "").localeCompare(b.farmBuddieId || "", undefined, { numeric: true })
  );
  applyFilter();

  // Keep the fleet control panel's live status current too, off the exact
  // same store update - no separate onSnapshot listener needed for it
  // (the whole farmer doc, deviceStatus included, is already in here).
  if (currentFleetFarmerId) {
    const f = allFarmers.find(x => x.id === currentFleetFarmerId);
    if (f) renderFleetStatus(f);
  }
}

/* ================= RENDER TABLE ================= */

function renderTable(data) {

  const tbody = document.getElementById("farmerTableBody");
  tbody.innerHTML = "";

  /* ===== NO DATA MESSAGE ===== */

  if (!data.length) {

    const message = currentSearchValue
      ? "No matching records found for filter"
      : "No records available";

    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:24px; font-weight:500;">
          ${message}
        </td>
      </tr>
    `;

    // Reset pagination display
    if (document.getElementById("fbStart")) {
      document.getElementById("fbStart").innerText = 0;
      document.getElementById("fbEnd").innerText = 0;
      document.getElementById("fbTotal").innerText = 0;
      document.getElementById("fbPagination").innerHTML = "";
    }

    paginationInitialized = false;
    return;
  }

  /* ===== BUILD TABLE ROWS ===== */

  let index = 1;
  const fragment = document.createDocumentFragment();
  for (const f of data) {

    const farmBuddieId = f.farmBuddieId || "-";
    const variant = f.controller?.variant || "-";
    const uniqueId = f.controller?.uniqueId || "-";
    const isOnline = isDeviceOnline(f.deviceStatus);

    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${index++}</td>
      <td>${farmBuddieId}</td>
      <td>${variant}</td>
      <td>${uniqueId}</td>
      <td>
        <span class="${isOnline ? "status-online" : "status-offline"}">
          ${isOnline ? "Online" : "Offline"}
        </span>
      </td>
      <td class="action-cell">
        <button class="icon-btn view"
          onclick="window.location.href='/admin/device-view.html?id=${f.id}'"
          title="View">
          👁️View
        </button>
        <button class="icon-btn fleet-control-btn"
          onclick="openFleetPanel('${f.id}')"
          title="Control">
          🎛️Control
        </button>
      </td>
    `;

    fragment.appendChild(tr);
  }
  tbody.appendChild(fragment);
  /* ===== INIT PAGINATION ONLY ONCE PER RENDER ===== */

 setTimeout(() => {

  if (typeof initTablePagination === "function") {

    if (!paginationInitialized) {
      initTablePagination(".fb-table", 10);
      paginationInitialized = true;
    } else {
      initTablePagination(".fb-table", 10);
    }

  }

}, 0);

};

/* =====================================================
   FLEET CONTROL PANEL
   Live status (reusing device-view.js's own render helpers - see
   device-status-render.js) plus command buttons, in-page instead of
   navigating to device-view.html. v1 scope: Motor 1 only (motorNum "1")
   - Motor 2 control can be added once there's a real paired-Motor_2 farm
   to test safety-limit/calibration commands against.
===================================================== */

const MOTOR_NUM = "1";
let currentFleetFarmerId = null;

function farmCommandTarget(f) {
  return {
    farmId: f.controller?.uniqueId,
    nodeId: f.deviceStatus?.nodeId || "MOTOR_1",
    motorNum: MOTOR_NUM
  };
}

window.openFleetPanel = function (farmerId) {
  const f = allFarmers.find(x => x.id === farmerId);
  if (!f) return;

  currentFleetFarmerId = farmerId;
  document.getElementById("fleetPanel").classList.remove("hidden");
  document.getElementById("fleetSafetyNote").textContent = "";
  document.getElementById("fleetCalNote").textContent = "";

  renderFleetStatus(f);
};

document.getElementById("fleetPanelClose")?.addEventListener("click", () => {
  currentFleetFarmerId = null;
  document.getElementById("fleetPanel").classList.add("hidden");
});

function renderFleetStatus(f) {
  const data = f.deviceStatus || {};
  const isOnline = isDeviceOnline(data);

  document.getElementById("fleetPanelFarmName").textContent = f.name || f.farmBuddieId || "-";
  document.getElementById("fleetFarmBuddieId").textContent = f.farmBuddieId || "-";
  document.getElementById("fleetUniqueId").textContent = f.controller?.uniqueId || "-";

  const badge = document.getElementById("fleetOnlineBadge");
  badge.textContent = isOnline ? "Online" : "Offline";
  badge.className = "status-pill " + (isOnline ? "status-online" : "status-offline");

  renderMotorsInto(document.getElementById("fleetMotorGrid"), data, isOnline);
  renderValvesInto(document.getElementById("fleetValveGrid"), data.motor1?.valves, isOnline);

  const health = data.health || {};
  document.getElementById("fleetFw").textContent = health.fw_version ?? "-";
  document.getElementById("fleetTransport").textContent = isOnline ? (health.transport ?? "-") : "--";
  document.getElementById("fleetSignal").textContent = isOnline && health.signal_pct != null ? `${health.signal_pct}%` : "--";
  document.getElementById("fleetUptime").textContent = isOnline ? (health.uptime_sec != null ? `${Math.floor(health.uptime_sec / 60)}m` : "-") : "--";
}

/* ---------------- QUICK ACTIONS / MOTOR CONTROL ---------------- */

async function runFleetCommand(cmd, extraParams = {}, { confirmMessage } = {}) {
  const f = allFarmers.find(x => x.id === currentFleetFarmerId);
  if (!f) return;

  if (confirmMessage && !confirm(confirmMessage)) return;

  try {
    await sendDeviceCommand(auth, { ...farmCommandTarget(f), cmd, ...extraParams });
  } catch (err) {
    console.error(`Command ${cmd} failed:`, err);
    alert(`❌ ${err.message}`);
  }
}

document.getElementById("fleetGetStatus")?.addEventListener("click", () => runFleetCommand("get_status"));
document.getElementById("fleetLightOn")?.addEventListener("click", () => runFleetCommand("light_on"));
document.getElementById("fleetLightOff")?.addEventListener("click", () => runFleetCommand("light_off"));
document.getElementById("fleetClearFault")?.addEventListener("click", () => runFleetCommand("clear_fault"));

document.getElementById("fleetMotorOn")?.addEventListener("click", () =>
  runFleetCommand("motor_on", { use_valve: false }, {
    confirmMessage: "Start this motor remotely now?"
  })
);

document.getElementById("fleetMotorOff")?.addEventListener("click", () =>
  runFleetCommand("motor_off", {}, {
    confirmMessage: "Stop this motor remotely now?"
  })
);

document.getElementById("fleetEmergencyStop")?.addEventListener("click", () =>
  runFleetCommand("emergency_stop", { fault: 0 }, {
    confirmMessage: "⚠️ EMERGENCY STOP - this immediately halts the motor. Continue?"
  })
);

/* ---------------- SAFETY LIMITS ---------------- */

function setNote(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "fleet-form-note" + (kind ? ` ${kind}` : "");
}

document.getElementById("fleetFetchSafety")?.addEventListener("click", async () => {
  const f = allFarmers.find(x => x.id === currentFleetFarmerId);
  if (!f) return;

  setNote("fleetSafetyNote", "Fetching current limits from device…");

  try {
    const payload = await fetchConfigReadback(auth, {
      ...farmCommandTarget(f),
      getCmd: "get_config_safety",
      responseType: "config_safety"
    });

    const group = document.getElementById("fleetPhaseGroup").value === "1" ? payload.prot_2p : payload.prot_3p;

    document.getElementById("fs_vLow").value = group?.v_low ?? "";
    document.getElementById("fs_vHigh").value = group?.v_high ?? "";
    document.getElementById("fs_iDry").value = group?.i_dry ?? "";
    document.getElementById("fs_iOverload").value = group?.i_overload ?? "";
    document.getElementById("fs_dryRunRestartMinutes").value = payload.dry_run_restart_minutes ?? "";
    document.getElementById("fs_phaseLossDetectV").value = payload.phase_loss_detect_v ?? "";
    document.getElementById("fs_phaseLossDebounceMs").value = payload.phase_loss_debounce_ms ?? "";
    document.getElementById("fs_phaseImbalanceMax").value = payload.phase_imbalance_max ?? "";
    document.getElementById("fs_cyclicResumeCooldownSec").value = payload.cyclic_resume_cooldown_sec ?? "";
    document.getElementById("fs_dolPulseMs").value = payload.dol_pulse_ms ?? "";
    document.getElementById("fs_confirmTimeoutSec").value = payload.confirm_timeout_sec ?? "";

    setNote("fleetSafetyNote", "Loaded current values from device.", "success");
  } catch (err) {
    console.error("Fetch safety config failed:", err);
    setNote("fleetSafetyNote", err.message, "error");
  }
});

document.getElementById("fleetSaveSafety")?.addEventListener("click", async () => {
  const f = allFarmers.find(x => x.id === currentFleetFarmerId);
  if (!f) return;

  const phaseMode = Number(document.getElementById("fleetPhaseGroup").value);

  const num = (id) => {
    const v = document.getElementById(id).value;
    return v === "" ? undefined : Number(v);
  };

  if (!confirm(
    "This changes the device's own protective thresholds (dry-run/overload/voltage cutoffs) for the " +
    (phaseMode === 1 ? "2-Phase" : "3-Phase") +
    " group. Wrong values can leave the motor under-protected. Continue?"
  )) return;

  setNote("fleetSafetyNote", "Saving…");

  try {
    await sendDeviceCommand(auth, {
      ...farmCommandTarget(f),
      cmd: "set_thresholds",
      phase_mode: phaseMode,
      v_low: num("fs_vLow"),
      v_high: num("fs_vHigh"),
      i_dry: num("fs_iDry"),
      i_overload: num("fs_iOverload"),
      dry_run_restart_minutes: num("fs_dryRunRestartMinutes"),
      phase_loss_detect_v: num("fs_phaseLossDetectV"),
      phase_loss_debounce_ms: num("fs_phaseLossDebounceMs"),
      phase_imbalance_max: num("fs_phaseImbalanceMax"),
      cyclic_resume_cooldown_sec: num("fs_cyclicResumeCooldownSec"),
      dol_pulse_ms: num("fs_dolPulseMs"),
      confirm_timeout_sec: num("fs_confirmTimeoutSec")
    });

    setNote("fleetSafetyNote", "Sent to device.", "success");
  } catch (err) {
    console.error("Save safety config failed:", err);
    setNote("fleetSafetyNote", err.message, "error");
  }
});

/* ---------------- VI CALIBRATION ---------------- */

document.getElementById("fleetFetchCal")?.addEventListener("click", async () => {
  const f = allFarmers.find(x => x.id === currentFleetFarmerId);
  if (!f) return;

  setNote("fleetCalNote", "Fetching current calibration from device…");

  try {
    const payload = await fetchConfigReadback(auth, {
      ...farmCommandTarget(f),
      getCmd: "get_vi_calibration",
      responseType: "config_vi"
    });

    document.getElementById("fc_voltR").value = payload.volt_r ?? "";
    document.getElementById("fc_voltY").value = payload.volt_y ?? "";
    document.getElementById("fc_voltB").value = payload.volt_b ?? "";
    document.getElementById("fc_currR").value = payload.curr_r ?? "";
    document.getElementById("fc_currY").value = payload.curr_y ?? "";
    document.getElementById("fc_currB").value = payload.curr_b ?? "";

    setNote("fleetCalNote", "Loaded current values from device.", "success");
  } catch (err) {
    console.error("Fetch VI calibration failed:", err);
    setNote("fleetCalNote", err.message, "error");
  }
});

document.getElementById("fleetSaveCal")?.addEventListener("click", async () => {
  const f = allFarmers.find(x => x.id === currentFleetFarmerId);
  if (!f) return;

  const num = (id) => {
    const v = document.getElementById(id).value;
    return v === "" ? undefined : Number(v);
  };

  if (!confirm(
    "This changes the device's own voltage/current sensor calibration. Wrong values will make every " +
    "voltage/current reading (and the safety thresholds that depend on them) wrong too. Continue?"
  )) return;

  setNote("fleetCalNote", "Saving…");

  try {
    await sendDeviceCommand(auth, {
      ...farmCommandTarget(f),
      cmd: "set_vi_calibration",
      volt_r: num("fc_voltR"),
      volt_y: num("fc_voltY"),
      volt_b: num("fc_voltB"),
      curr_r: num("fc_currR"),
      curr_y: num("fc_currY"),
      curr_b: num("fc_currB")
    });

    setNote("fleetCalNote", "Sent to device.", "success");
  } catch (err) {
    console.error("Save VI calibration failed:", err);
    setNote("fleetCalNote", err.message, "error");
  }
});