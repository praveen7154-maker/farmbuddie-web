/* Device control on the Device View page - quick actions, motor control,
 * safety limits and VI calibration (moved here from the Analytics page's
 * side panel so everything for one device is on one page).
 *
 * Acts on the motor picked in the Motor selector: "1" is the hub's own
 * motor, "2".."4" are motor nodes (relayed by the hub over the mesh - see
 * the bridge's motorNumbers.js). The selector lists only motors that have
 * reported a status (deviceStatus.motor<N>).
 *
 * VI calibration: the hub computes every reading as
 *   reading = sensor RMS x constant
 * (vi_sensor.cpp), so for a phase whose multimeter reading differs from
 * the device's reading:
 *   new constant = current constant x multimeter / device reading
 * Each phase is pushed on its own - set_vi_calibration keeps every field
 * it isn't given. */

import { sendDeviceCommand, sendCommandAwaitAck, fetchConfigReadback, fetchFreshStatus } from "/js/device-commands.js";
import { motorNodeFlags } from "/js/device-status-render.js";

const MOTOR_NUMS = ["1", "2", "3", "4"];
let motorNum = "1";       // the motor the Control / VI / Safety sections act on

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
let lastMotorJson = "";
/* The selected motor's reading shown in the table:
 *   payload - its status report, at - when the bridge got it (server time),
 *   fresh   - straight from the hub via Refresh Reading (or newer than
 *             such a reading). Only a fresh one is used to calculate: the
 *             farmer doc's copy can be up to 20 minutes old (the bridge
 *             writes readings-only changes that rarely - statusThrottle.js),
 *   gotAtMs - when this page got it (this PC's clock). */
let reading = null;
let readingBusy = false;
// Bumped by every push: a reading asked for before it was made with the old constant.
let calEpoch = 0;
// A fresh reading is trusted this long - mains voltage and motor load drift.
const READING_FRESH_MS = 3 * 60 * 1000;

const $ = (id) => document.getElementById(id);

function target() {
  return {
    farmId: farm?.controller?.uniqueId,
    nodeId: farm?.deviceStatus?.nodeId || "MOTOR_1",
    motorNum
  };
}

const selectedMotor = () => farm?.deviceStatus?.[`motor${motorNum}`];

function setNote(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "fleet-form-note" + (kind ? ` ${kind}` : "");
}

async function runCommand(cmd, extraParams = {}, { confirmMessage } = {}) {
  if (!farm) return;
  if (confirmMessage && !confirm(confirmMessage)) return;
  setNote("controlNote", `Sending ${cmd} to Motor ${motorNum}…`);
  try {
    const ack = await sendCommandAwaitAck(auth, { ...target(), cmd, ...extraParams });
    if (ack.ok) setNote("controlNote", `Motor ${motorNum}: ${cmd} done.`, "success");
    else setNote("controlNote", `Motor ${motorNum} refused ${cmd}: ${ack.error || "unknown error"}`, "error");
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

const readingIsFresh = () => !!reading?.fresh && Date.now() - reading.gotAtMs < READING_FRESH_MS;

function renderCalValues() {
  const fresh = readingIsFresh();
  for (const { key, unit, reading: pick } of CAL_ROWS) {
    const c = $(`calConst_${key}`);
    if (c) c.textContent = deviceCal ? fmt(deviceCal[key]) : "--";
    const r = $(`calReading_${key}`);
    const value = pick(reading?.payload);
    if (r) {
      r.textContent = value == null ? "--" : `${value} ${unit}`;
      r.classList.toggle("cal-stale", !fresh);
    }
  }
  const at = $("calReadingAt");
  if (at) {
    at.textContent = reading?.at
      ? `${reading.at.toLocaleTimeString()}${fresh ? " (fresh from the device)" : " (old copy - press Refresh Reading)"}`
      : "--";
  }
}

function calculate(key) {
  const row = CAL_ROWS.find((r) => r.key === key);
  const oldConst = deviceCal?.[key];
  const deviceReading = Number(row.reading(reading?.payload));
  const meter = Number($(`calMeter_${key}`).value);

  if (oldConst == null) return setRowNote(key, "Press \"Fetch Device Constants\" first.", "error");
  if (readingBusy) return setRowNote(key, "Waiting for the device's fresh reading - try again in a moment.", "error");
  if (!readingIsFresh()) {
    return setRowNote(key, "The Device Reading is old - press Refresh Reading, read the meter at the same time, then Calculate.", "error");
  }
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
  } catch (err) {
    console.error("Fetch VI calibration failed:", err);
    setNote("calNote", err.message, "error");
    return;
  }
  await refreshReading("Loaded the device's current constants.");
}

/* Asks the hub for a status report and shows the one it sends back. */
async function refreshReading(donePrefix = "") {
  if (!farm) return;
  if (readingBusy) {
    // A refresh is already on its way - it will update the note itself.
    if (donePrefix) setNote("calNote", `${donePrefix} Waiting for the device's fresh reading…`);
    return;
  }
  readingBusy = true;
  const forMotor = motorNum;
  const epoch = calEpoch;
  const btn = $("calRefreshReading");
  if (btn) btn.disabled = true;
  setNote("calNote", `${donePrefix ? donePrefix + " " : ""}Asking the device for a fresh reading…`);
  try {
    const { payload, at } = await fetchFreshStatus(auth, target());
    // The motor selector changed meanwhile, or a push did (its own refresh follows).
    if (forMotor !== motorNum || epoch !== calEpoch) return;
    reading = { payload, at, fresh: true, gotAtMs: Date.now() };
    renderCalValues();
    // "Reading is old" / "reads 0" messages no longer apply.
    for (const { key } of CAL_ROWS) {
      if ($(`calNote_${key}`)?.classList.contains("error")) setRowNote(key, "");
    }
    setNote("calNote", `${donePrefix ? donePrefix + " " : ""}Fresh reading from the device - read your meter now and enter it.`, "success");
  } catch (err) {
    console.error("Refresh reading failed:", err);
    if (forMotor === motorNum && epoch === calEpoch) setNote("calNote", err.message, "error");
  } finally {
    readingBusy = false;
    if (btn) btn.disabled = false;
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
    // The reading on screen was made with the old constant - never calculate from it again.
    calEpoch++;
    if (reading) reading = { ...reading, fresh: false };
    renderCalValues();
    $(`calMeter_${key}`).value = "";
    $(`calNew_${key}`).value = "";
    setRowNote(key, `Saved on the device (${fmt(deviceCal[key])}). Getting a new reading - compare it with the meter again.`, "success");
    setNote("calNote", "Saved - getting a new reading in a moment…");
  } catch (err) {
    console.error("Push VI calibration failed:", err);
    setRowNote(key, `${err.message} Press Fetch Device Constants to check whether it was saved.`, "error");
    return;
  }
  // The hub sends a status right after the push too, but its reading can
  // still come from the old constant - give the sensor a couple of seconds
  // (one full V+I cycle) before asking for the reading to compare.
  await new Promise((r) => setTimeout(r, 2500));
  while (readingBusy) await new Promise((r) => setTimeout(r, 500));   // an older refresh, now ignored
  await refreshReading();
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
    // Older firmware has no such setting - left at "(unchanged)", never sent.
    $("fs_phaseReversalProtect").value =
      typeof payload.phase_reversal_protect === "boolean" ? (payload.phase_reversal_protect ? "1" : "0") : "";
    seqSupported = payload.phase_seq_supported === true;
    renderPhaseSeq();
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
  // Same range as the Irrigo and admin apps' Voltage Low Limit.
  const vLow = num("fs_vLow");
  if (vLow !== undefined && (!Number.isFinite(vLow) || vLow < 120 || vLow > 210)) {
    setNote("safetyNote", "Voltage Low must be between 120 V and 210 V.", "error");
    return;
  }
  // Same range as the apps and the hub (30 s to 10 min, whole seconds).
  const cooldown = num("fs_cyclicResumeCooldownSec");
  if (cooldown !== undefined && (!Number.isInteger(cooldown) || cooldown < 30 || cooldown > 600)) {
    setNote("safetyNote", "Cyclic Resume Cooldown must be a whole number of seconds from 30 to 600.", "error");
    return;
  }
  // Phase reverse protection: "" = leave it as it is on the device.
  const reverseSel = $("fs_phaseReversalProtect").value;
  const phaseReversalProtect = reverseSel === "" ? undefined : reverseSel === "1";
  if (phaseReversalProtect === true && selectedMotor()?.phase_seq !== "ok" && !confirm(
    "The live phase order isn't showing R → Y → B correct right now. With Phase Reverse Protection " +
    "active, a reversed order stops the motor and refuses every start. Activate anyway?"
  )) return;
  if (!confirm(
    "This changes the device's own protective thresholds (dry-run/overload/voltage cutoffs) for the " +
    (phaseMode === 1 ? "2-Phase" : "3-Phase") +
    " group. Wrong values can leave the motor under-protected. Continue?"
  )) return;

  setNote("safetyNote", "Saving…");
  try {
    const ack = await sendCommandAwaitAck(auth, {
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
      confirm_timeout_sec: num("fs_confirmTimeoutSec"),
      phase_reversal_protect: phaseReversalProtect
    });
    if (ack.ok) setNote("safetyNote", `Saved on Motor ${motorNum}.`, "success");
    else setNote("safetyNote", `Motor ${motorNum} rejected the change: ${ack.error || "unknown error"}`, "error");
  } catch (err) {
    console.error("Save safety config failed:", err);
    setNote("safetyNote", err.message, "error");
  }
}

/* The selected motor's live phase order (its status report's phase_seq) -
 * shown under the safety limits so Phase Reverse Protection is only
 * switched on once it reads correct. */
let seqSupported = null;   // from the last config_safety fetch - null until fetched
function renderPhaseSeq() {
  const seq = selectedMotor()?.phase_seq;
  if (seq === "ok") {
    setNote("phaseSeqLive", "Phase order (live): ✅ R → Y → B - correct", "success");
  } else if (seq === "reversed") {
    setNote("phaseSeqLive", "Phase order (live): ⚠️ REVERSED - swap any two phases at the panel. " +
      "With Phase Reverse Protection active the motor will not start.", "error");
  } else if (seq === "unknown") {
    setNote("phaseSeqLive", "Phase order (live): checking… all three phases must be on.");
  } else if (seq === "unsupported" || seqSupported === false) {
    setNote("phaseSeqLive", "Phase order: this controller can't check it (needs the V2 hub board).");
  } else {
    setNote("phaseSeqLive", "Phase order: not reported - update the controller firmware to check it.");
  }
}

/* ================= MOTOR SELECTOR ================= */

// Motor 1 (the hub) always, plus the motor nodes the hub reports as paired.
function availableMotors() {
  const paired = motorNodeFlags(farm?.deviceStatus);
  return MOTOR_NUMS.filter((n) => n === "1" || n in paired);
}

function renderMotorSelect() {
  const sel = $("ctlMotorSelect");
  if (!sel) return;
  const nums = availableMotors();
  const current = Array.from(sel.options).map((o) => o.value).join(",");
  if (current !== nums.join(",")) {
    sel.innerHTML = nums.map((n) => `<option value="${n}">Motor ${n}</option>`).join("");
  }
  if (!nums.includes(motorNum)) selectMotor("1");
  sel.value = motorNum;
}

function selectMotor(n) {
  if (n === motorNum) return;
  motorNum = n;
  // Constants, readings and limits belong to the previous motor - clear them.
  deviceCal = null;
  lastMotorJson = JSON.stringify(selectedMotor() ?? null);
  reading = savedReading();
  document.querySelectorAll(".ctlMotorLabel").forEach((el) => { el.textContent = `Motor ${n}`; });
  for (const { key } of CAL_ROWS) {
    $(`calMeter_${key}`).value = "";
    $(`calNew_${key}`).value = "";
    setRowNote(key, "");
  }
  document.querySelectorAll("[id^='fs_']").forEach((el) => { el.value = ""; });
  setNote("controlNote", "");
  setNote("calNote", "");
  setNote("safetyNote", "");
  // The phase order shown is the newly picked motor's; its support isn't known until fetched.
  seqSupported = null;
  $("fs_phaseReversalProtect").value = "";
  renderCalValues();
  renderPhaseSeq();
}

/* ================= WIRING ================= */

/* Live readings while this page is on screen. The hub reports every 10 s
 * only for 2.5 min after a command reaches it (APP_ACTIVE_WINDOW_MS in its
 * config.h), otherwise every 2 min running / 10 min idle - so this page sat
 * on readings minutes old unless the Irrigo app happened to be open too.
 * Same as the app: ask the hub and each paired motor node when the page
 * opens or comes back on screen, then every minute while it stays there;
 * nothing while it's in the background. */
const KEEPALIVE_MS = 60 * 1000;
let lastKeepaliveMs = 0;

function keepalive() {
  if (!auth?.currentUser || !farm?.controller?.uniqueId || document.visibilityState !== "visible") return;
  if (Date.now() - lastKeepaliveMs < KEEPALIVE_MS) return;
  lastKeepaliveMs = Date.now();
  const paired = motorNodeFlags(farm.deviceStatus);
  for (const m of MOTOR_NUMS) {
    if (m !== "1" && paired[m] !== true) continue;
    sendDeviceCommand(auth, { ...target(), motorNum: m, cmd: "get_status" }).catch(() => {});
  }
}

export function initDeviceControl(firebaseAuth) {
  auth = firebaseAuth;
  renderCalTable();
  setInterval(keepalive, 5000);
  document.addEventListener("visibilitychange", keepalive);

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

  $("ctlMotorSelect")?.addEventListener("change", (e) => selectMotor(e.target.value));

  on("safetyFetch", fetchSafety);
  on("safetySave", saveSafety);

  on("calFetch", fetchConstants);
  on("calRefreshReading", () => refreshReading());
  // "Fresh" runs out after a few minutes even with no new data.
  setInterval(renderCalValues, 30 * 1000);
}

/* The farmer doc's copy of the selected motor's report. Its time is the
 * device's last report of any kind - the closest the doc has. */
function savedReading() {
  return {
    payload: selectedMotor() ?? null,
    at: farm?.deviceStatus?.lastSeen?.toDate?.() ?? null,
    fresh: false,
    gotAtMs: Date.now()
  };
}

/* Called with every Firestore snapshot of the farmer doc. */
export function updateDeviceControl(farmerData) {
  farm = farmerData;
  keepalive();
  renderMotorSelect();
  const motorJson = JSON.stringify(selectedMotor() ?? null);
  if (motorJson !== lastMotorJson) {
    lastMotorJson = motorJson;
    const saved = savedReading();
    // The bridge writes the doc when the motor's state changes (on/off,
    // fault...), so a copy newer than a fresh reading is just as fresh.
    if (!reading?.at || (saved.at && saved.at > reading.at)) {
      reading = { ...saved, fresh: !!reading?.fresh && !!saved.at };
    }
  }
  renderCalValues();
  renderPhaseSeq();
}
