/* Valve Configuration + Additional Features - one definition shared by
 * onboarding, Add Farm, Edit (form), Farmer View / MCU-Controller panel
 * (display) and the Farmer Database export. Shown for both IRRIGO and
 * IRRIGO_PLUS; every count is mandatory and defaults to 0.
 *
 * Stored on the farm doc as farmers/<id>.valveConfig. valve24Count,
 * valve9Count, filterBackwashCount and waterLevelMonitoring keep their
 * original field names so farms saved before this still read correctly. */

export const VALVE_FIELDS = [
  { key: "valve24Count", label: "Solenoid Valve - 24V AC" },
  { key: "valve9Count", label: "Solenoid Valve - 9V DC" },
  { key: "butterfly230AcCount", label: "Butterfly Valve - 230V AC" },
  { key: "butterfly24DcCount", label: "Butterfly Valve - 24V DC" }
];

export const FEATURE_FIELDS = [
  { key: "waterLevelMonitoring", label: "Water Level Monitoring" },
  { key: "filterBackwashCount", label: "Auto Filter Backwash" },
  { key: "fertigationCount", label: "Fertigation" },
  { key: "weatherStationCount", label: "Farm Weather Station" }
];

const ALL_FIELDS = [...VALVE_FIELDS, ...FEATURE_FIELDS];

function inputHtml({ key, label }) {
  return `
    <div class="fb-field">
      <label>${label} *</label>
      <input type="text" id="${key}" class="small-input" maxlength="3"
             inputmode="numeric" pattern="\\d*" value="0">
    </div>`;
}

/* Fills <section id="valveConfigSection"> with both groups. Call once on page load. */
export function renderValveConfigSection() {
  const section = document.getElementById("valveConfigSection");
  if (!section) return;
  section.innerHTML = `
    <h2>⚙️ Valve Configuration</h2>
    <div class="fb-grid">${VALVE_FIELDS.map(inputHtml).join("")}</div>
    <div style="margin-top:18px;">
      <h2 class="sub-section-title">🔥 Additional Features</h2>
      <div class="fb-grid">${FEATURE_FIELDS.map(inputHtml).join("")}</div>
    </div>`;
  // Digits only, up to 3.
  section.addEventListener("input", (e) => {
    if (e.target.matches("input")) e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3);
  });
}

/* { config, missing } - missing is the label of the first empty field (all are mandatory). */
export function readValveConfig() {
  const config = {};
  let missing = null;
  for (const { key, label } of ALL_FIELDS) {
    const raw = (document.getElementById(key)?.value || "").trim();
    if (raw === "" && !missing) missing = label;
    config[key] = parseInt(raw || "0", 10) || 0;
  }
  return { config, missing };
}

/* Loads a saved farm's valveConfig into the form (missing fields -> 0). */
export function fillValveConfig(valveConfig) {
  for (const { key } of ALL_FIELDS) {
    const el = document.getElementById(key);
    if (el) el.value = valveConfig?.[key] ?? 0;
  }
}

/* View pages: two titled info-grids (Valve Configuration, Additional Features). */
export function valveConfigViewHtml(valveConfig) {
  const items = (fields) => fields.map(({ key, label }) =>
    `<div class="info-item"><b>${label}:</b> ${valveConfig?.[key] ?? 0}</div>`).join("");
  return `
    <div class="section-title">⚙️ Valve Configuration</div>
    <div class="info-grid">${items(VALVE_FIELDS)}</div>
    <div class="section-title">🔥 Additional Features</div>
    <div class="info-grid">${items(FEATURE_FIELDS)}</div>`;
}

/* Export columns, in display order. */
export function valveConfigExportColumns(valveConfig) {
  const out = {};
  for (const { key, label } of ALL_FIELDS) out[label] = valveConfig?.[key] ?? 0;
  return out;
}
