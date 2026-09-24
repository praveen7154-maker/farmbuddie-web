/**
 * Shared rendering for a device's live deviceStatus (motor state/fault,
 * phase voltage/current, valves) - pulled out of device-view.js so the
 * new fleet control panel (analytics.js) doesn't reimplement the same
 * ~150 lines a second time. Mirrors Irrigo app's PumpCodes.kt (its
 * STATE_ and FAULT_ constants) - a small, stable enum, safe to keep in sync here
 * without the drift risk a much larger mapping (e.g. the alert EVENT_*
 * codes) would carry. See that file if the firmware ever adds a new
 * state/fault code.
 */

export const STATE_LABELS = {
  0: "Stopped",
  1: "Running",
  2: "Starting",
  3: "Stopping",
  4: "Fault",
  5: "Changeover",
};

export const FAULT_LABELS = {
  0: null, // no fault - nothing to show
  1: "Dry Run",
  2: "Overload",
  3: "Voltage Low",
  4: "Voltage High",
  5: "Phase Loss",
  6: "Phase Imbalance",
  10: "Power Outage",
};

export function formatDurationShort(totalSec) {
  if (totalSec == null) return "-";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** True if deviceStatus.lastSeen is within the last 270s - the same "still talking to the broker" threshold used across the admin panel (and server/src/bridge/fleetStatus.js). A device with no app open only reports every 120s, so this rides out one lost status. */
export function isDeviceOnline(deviceStatus) {
  const lastSeen = deviceStatus?.lastSeen?.toDate?.() || (deviceStatus?.lastSeen ? new Date(deviceStatus.lastSeen) : null);
  if (!lastSeen) return false;
  return (Date.now() - lastSeen.getTime()) / 1000 < 270;
}

/**
 * Real shape: deviceStatus.motor1/motor2, the firmware's raw `status`
 * topic payload (state/fault are integer codes, v/i are {r,y,b} phase
 * readings) - see Irrigo app's model/PumpModels.kt PumpStatus. motor2
 * only exists here at all once this farm's Motor_2 has ever published a
 * status (i.e. it's paired).
 */
export function renderMotorsInto(grid, data, isOnline) {
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

/**
 * `valves` is a plain open/closed boolean array (index 0 = valve 1), only
 * present at all when valve mesh mode is on for this farm - null/absent
 * means "no valve mesh configured", not "everything closed".
 */
export function renderValvesInto(grid, valves, isOnline) {
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
