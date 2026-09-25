/* Device control on the Device View page - quick actions, motor control,
 * safety limits and VI calibration (moved here from the Analytics page's
 * side panel so everything for one device is on one page).
 *
 * v1 scope: Motor 1 (the hub, motorNum "1").
 *
 * VI calibration: the hub computes every reading as
 *   reading = sensor RMS x constant
 * (vi_sensor.cpp), so for a phase whose multimeter reading differs from
 * the device's reading:
 *   new constant = current constant x multimeter / device reading
 * Each phase is pushed on its own - set_vi_calibration keeps every field
 * it isn't given. */

import { sendDeviceCommand, fetchConfigReadback } from "/js/device-commands.js";

const MOTOR_NUM = "1";

// The hub rejects a constant outside this range (vi_sensor.cpp VI_CAL_MIN/MAX).
const CAL_MIN = 1;
const CAL_MAX = 100000;

const CAL_ROWS = [
  { key: "volt_r", label: "Voltage R", unit: "V", reading: (m) => m?.v?.r },
  { key: "volt_y", label: "Voltage Y", unit: "V", reading: (m) => m?.v?.y },
  { key: "volt_b", label: "Voltage B", unit: "V", reading: (m) => m?.v?.b },
  { key: "curr_r", label: "Current R", unit: "A", reading: (m) => m?.i?.r },
  { key: "curr_y", label: "Current Y", unit: "A", reading: (m) => m?.i?.y },
  { key: "curr_b", label: "Current B", unit: "A", reading: (m) => m?.i?.b }
];

let auth = null;
let farm = null;          // latest farmer doc
let deviceCal = null;     // last config_vi read from the hub
let lastMotor1Json = "";
let readingAt = null;     // when the live motor 1 reading last changed

const $ = (id) => document.getElementById(id);

function target() {
  return {
    farmId: farm?.controller?.uniqueId,
    nodeId: farm?.deviceStatus?.nodeId || "MOTOR_1",
    motorNum: MOTOR_NUM
  };
}

function setNote(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "fleet-form-note" + (kind ? ` ${kind}` : "");
}

async function runCommand(cmd, extraParams = {}, { confirmMessage } = {}) {
  if (!farm) return;
  if (confirmMessage && !confirm(confirmMessage)) return;
  try {
    await sendDeviceCommand(auth, { ...target(), cmd, ...extraParams });
    setNote("controlNote", `Sent: ${cmd}`, "success");
  } catch (err) {
    console.error(`Command ${cmd} failed:`, err);
    setNote("controlNote", err.message, "error");
  }
}

/* ================= VI CALIBRATION ================= */

const fmt = (n, digits = 2) => (n == null || Number.isNaN(n) ? "--" : Number(n).toFixed(digits));

function renderCalTable() {
  const body = $("calTableBody");
  if (!body) return;
  body.innerHTML = CAL_ROWS.map(({ key, label, unit }) => `
    <tr data-key="${key}">
      <td class="cal-phase">${label}</td>
      <td class="cal-const" id="calConst_${key}">--</td>
      <td class="cal-reading" id="calReading_${key}">--</td>
      <td><input type="number" step="any" min="0" id="calMeter_${key}" placeholder="${unit}"></td>
      <td><button class="fb-btn-primary small" data-action="calc">🧮 Calculate</button></td>
      <td><input type="number" step="any" id="calNew_${key}" placeholder="new constant"></td>
      <td><button class="fb-btn-primary small" data-action="push">⬆️ Push</button></td>
    </tr>
    <tr class="cal-row-note"><td colspan="7" id="calNote_${key}"></td></tr>`).join("");

  body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const key = btn.closest("tr").dataset.key;
    if (btn.dataset.action === "calc") calculate(key);
    else pushPhase(key);
  });
}

function setRowNote(key, text, kind) {
  const el = $(`calNote_${key}`);
  if (!el) return;
  el.textContent = text;
  el.className = kind ? `cal-note ${kind}` : "cal-note";
}

function renderCalValues() {
  const motor1 = farm?.deviceStatus?.motor1;
  for (const { key, unit, reading } of CAL_ROWS) {
    const c = $(`calConst_${key}`);
    if (c) c.textContent = deviceCal ? fmt(deviceCal[key]) : "--";
    const r = $(`calReading_${key}`);
    const value = reading(motor1);
    if (r) r.textContent = value == null ? "--" : `${value} ${unit}`;
  }
  const at = $("calReadingAt");
  if (at) at.textContent = readingAt ? readingAt.toLocaleTimeString() : "--";
}

function calculate(key) {
  const row = CAL_ROWS.find((r) => r.key === key);
  const oldConst = deviceCal?.[key];
  const deviceReading = Number(row.reading(farm?.deviceStatus?.motor1));
  const meter = Number($(`calMeter_${key}`).value);

  if (oldConst == null) return setRowNote(key, "Press \"Fetch Device Constants\" first.", "error");
  if (!(meter > 0)) return setRowNote(key, `Enter the multimeter / clamp-meter reading (${row.unit}).`, "error");
  if (!(deviceReading > 0)) {
    return setRowNote(key, row.unit === "A"
      ? "Device reads 0 A - run the motor under load, then press Refresh Reading."
      : "Device reads 0 V - check this phase is powered, then press Refresh Reading.", "error");
  }

  const newConst = Math.round(oldConst * (meter / deviceReading) * 100) / 100;
  $(`calNew_${key}`).value = newConst;
  const change = ((meter / deviceReading) - 1) * 100;
  setRowNote(key,
    `${fmt(oldConst)} × ${meter} / ${deviceReading} = ${newConst} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%). Press Push to send it.`,
    Math.abs(change) > 30 ? "warn" : "");
}

async function fetchConstants() {
  if (!farm) return;
  setNote("calNote", "Fetching calibration constants from the device…");
  try {
    deviceCal = await fetchConfigReadback(auth, {
      ...target(), getCmd: "get_vi_calibration", responseType: "config_vi"
    });
    renderCalValues();
    setNote("calNote", "Loaded the device's current constants.", "success");
  } catch (err) {
    console.error("Fetch VI calibration failed:", err);
    setNote("calNote", err.message, "error");
  }
}

async function pushPhase(key) {
  if (!farm) return;
  const row = CAL_ROWS.find((r) => r.key === key);
  const value = Number($(`calNew_${key}`).value);
  if (!(value >= CAL_MIN && value <= CAL_MAX)) {
    return setRowNote(key, `New constant must be between ${CAL_MIN} and ${CAL_MAX} - press Calculate first.`, "error");
  }
  if (!confirm(`Push ${row.label} constant ${value} to the device?\n\nOnly ${row.label} changes; the other phases stay as they are.`)) return;

  setRowNote(key, "Pushing…");
  try {
    deviceCal = await fetchConfigReadback(auth, {
      ...target(),
      getCmd: "set_vi_calibration",
      params: { [key]: value },
      responseType: "config_vi",
      // The hub replies with all six constants - wait for the one that has ours.
      accept: (p) => Math.abs(Number(p[key]) - value) < 0.01
    });
    renderCalValues();
    $(`calMeter_${key}`).value = "";
    $(`calNew_${key}`).value = "";
    setRowNote(key, `Saved on the device (${fmt(deviceCal[key])}). Refreshing the reading - compare it with the meter again.`, "success");
    sendDeviceCommand(auth, { ...target(), cmd: "get_status" }).catch(() => {});
  } catch (err) {
    console.error("Push VI calibration failed:", err);
    setRowNote(key, `${err.message} Press Fetch Device Constants to check whether it was saved.`, "error");
  }
}

/* ================= SAFETY LIMITS ================= */

async function fetchSafety() {
  if (!farm) return;
  setNote("safetyNote", "Fetching current limits from the device…");
  try {
    const payload = await fetchConfigReadback(auth, {
      ...target(), getCmd: "get_config_safety", responseType: "config_safety"
    });
    const group = $("safetyPhaseGroup").value === "1" ? payload.prot_2p : payload.prot_3p;
    $("fs_vLow").value = group?.v_low ?? "";
    $("fs_vHigh").value = group?.v_high ?? "";
    $("fs_iDry").value = group?.i_dry ?? "";
    $("fs_iOverload").value = group?.i_overload ?? "";
    $("fs_dryRunRestartMinutes").value = payload.dry_run_restart_minutes ?? "";
    $("fs_phaseLossDetectV").value = payload.phase_loss_detect_v ?? "";
    $("fs_phaseLossDebounceMs").value = payload.phase_loss_debounce_ms ?? "";
    $("fs_phaseImbalanceMax").value = payload.phase_imbalance_max ?? "";
    $("fs_cyclicResumeCooldownSec").value = payload.cyclic_resume_cooldown_sec ?? "";
    $("fs_dolPulseMs").value = payload.dol_pulse_ms ?? "";
    $("fs_confirmTimeoutSec").value = payload.confirm_timeout_sec ?? "";
    setNote("safetyNote", "Loaded current values from the device.", "success");
  } catch (err) {
    console.error("Fetch safety config failed:", err);
    setNote("safetyNote", err.message, "error");
  }
}

async function saveSafety() {
  if (!farm) return;
  const phaseMode = Number($("safetyPhaseGroup").value);
  const num = (id) => {
    const v = $(id).value;
    return v === "" ? undefined : Number(v);
  };
  if (!confirm(
    "This changes the device's own protective thresholds (dry-run/overload/voltage cutoffs) for the " +
    (phaseMode === 1 ? "2-Phase" : "3-Phase") +
    " group. Wrong values can leave the motor under-protected. Continue?"
  )) return;

  setNote("safetyNote", "Saving…");
  try {
    await sendDeviceCommand(auth, {
      ...target(),
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
    setNote("safetyNote", "Sent to the device.", "success");
  } catch (err) {
    console.error("Save safety config failed:", err);
    setNote("safetyNote", err.message, "error");
  }
}

/* ================= WIRING ================= */

export function initDeviceControl(firebaseAuth) {
  auth = firebaseAuth;
  renderCalTable();

  const on = (id, fn) => $(id)?.addEventListener("click", fn);

  on("ctlGetStatus", () => runCommand("get_status"));
  on("ctlLightOn", () => runCommand("light_on"));
  on("ctlLightOff", () => runCommand("light_off"));
  on("ctlClearFault", () => runCommand("clear_fault"));
  on("ctlMotorOn", () => runCommand("motor_on", { use_valve: false }, { confirmMessage: "Start this motor remotely now?" }));
  on("ctlMotorOff", () => runCommand("motor_off", {}, { confirmMessage: "Stop this motor remotely now?" }));
  on("ctlEmergencyStop", () => runCommand("emergency_stop", { fault: 0 }, {
    confirmMessage: "⚠️ EMERGENCY STOP - this immediately halts the motor. Continue?"
  }));

  on("safetyFetch", fetchSafety);
  on("safetySave", saveSafety);

  on("calFetch", fetchConstants);
  on("calRefreshReading", async () => {
    await runCommand("get_status");
    setNote("calNote", "Asked the device for a fresh reading - the Device Reading column updates when it arrives.");
  });
}

/* Called with every Firestore snapshot of the farmer doc. */
export function updateDeviceControl(farmerData) {
  farm = farmerData;
  const motor1Json = JSON.stringify(farmerData?.deviceStatus?.motor1 ?? null);
  if (motor1Json !== lastMotor1Json) {
    // First snapshot: best guess is the last time the device reported at all.
    readingAt = lastMotor1Json ? new Date() : (farmerData?.deviceStatus?.lastSeen?.toDate?.() ?? null);
    lastMotor1Json = motor1Json;
  }
  renderCalValues();
}
