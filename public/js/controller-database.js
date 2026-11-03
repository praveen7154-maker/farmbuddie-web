import { auth, db } from "/js/firebase-init.js";
import { valveConfigViewHtml } from "/js/valve-config.js";
import { nodeMappingViewHtml } from "/js/node-mapping.js";
import { isDeviceOnline, isMotorOnline } from "/js/device-status-render.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  addDoc,
  collection,
  serverTimestamp,
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

import {
  startDataStore,
  warmDataStore,
  getControllers,
  getFarmers,
  isLive,
  subscribe
} from "/js/data-store.js";

import { provisionDeviceCredentials, renderMqttCredentialReveal } from "/js/provisioning.js";
import { fmtDateTime } from "/js/time-format.js";
import { icon, esc, renderPager, loadState, saveState, toast, slashToSearch } from "/js/records-ui.js";

/* ================= CACHE ================= */


let renderScheduled = false;
let lastTableKey = "";

/* ================= ADMIN VISIBLE STATUS ================= */
const ADMIN_VISIBLE_STATUSES = ["available", "assigned", "sold"];
const uploadBtn = document.getElementById("uploadExcelBtn");
const fileInput = document.getElementById("controllerExcel");

/* ================= AUTH ================= */

onAuthStateChanged(auth, (user) => {

  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  /* START REALTIME DATA STORE (only what this page shows) */
  startDataStore(PAGE_DATA);

});


/* ================= SMART RENDER ================= */

// What the table shows: the controllers, and which farmer holds each one.
// Redrawing only when the controller COUNT changed missed both a controller
// turning assigned and the farmer list arriving after the controllers - the
// farmer column stayed empty until something else redrew it. Farmer docs
// also change on every device status update; those don't touch the table,
// so they don't redraw it.
function tableKey(){
  const holders = getFarmers()
    .map(f => `${f.controller?.uniqueId || ""}=${f.farmBuddieId || ""}`)
    .sort()
    .join(",");
  return JSON.stringify(getControllers()) + "|" + holders;
}

function scheduleRender(){
  const key = tableKey();
  if (key === lastTableKey) return;     // e.g. only a device status changed
  lastTableKey = key;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; renderControllers(); });
}

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {

  signOut(auth)
    .then(() => window.location.replace("/login.html"))
    .catch(err => console.error("Logout error:", err));

});

/* ================= REPAIR CONTROLLERS ================= */
// Reads from data-store.js's already-live farmers/controllers arrays
// instead of firing two fresh full-collection queries - this page already
// has both subscribed since load (see startDataStore() above), so a
// second read here would just be re-fetching the same data.
window.repairControllers = async function () {

  const farmerIds = new Set(
    getFarmers()
      .map(f => f.controller?.uniqueId)
      .filter(Boolean)
  );

  for (const c of getControllers()) {
    if (c.status === "assigned" && !farmerIds.has(c.uniqueId)) {
      await updateDoc(doc(db, "controllers", c.id), {
        status: "available",
        farmerId: null,
        farmerDocId: null,
        assignedAt: null
      });
    }
  }
}


/* ================= EXCEL UPLOAD ================= */

uploadBtn.addEventListener("click", async () => {

    if (!fileInput.files.length) {
        alert("Please select an Excel file.");
        return;
    }

    const file = fileInput.files[0];

    const reader = new FileReader();

    reader.onload = async function(e){

        const XLSX = await window.loadXlsx();
        const workbook = XLSX.read(e.target.result,{
            type:"binary"
        });

        const sheet =
            workbook.Sheets[workbook.SheetNames[0]];

        // raw: false - without this, SheetJS reads any numeric-looking
        // cell as a JS number instead of the text actually in it. That
        // silently strips leading zeros off a 4-digit Unique ID ("0001"
        // becomes 1) and, worse, loses real digits off anything longer
        // than ~15-16 digits (a 19-digit ICCID can't be represented
        // exactly as a JS number at all) - exactly the "5.75418E+12"-
        // style corruption a pasted MOBILE_NUMBER/SIM_NO/SIM_IMSI column
        // shows when Excel itself already auto-formatted it as a number.
        // raw:false asks SheetJS for the cell's DISPLAYED text instead,
        // which is only a full fix if the source column was formatted as
        // Text in Excel before the data was typed/pasted in - see
        // normalizeControllerRow()'s own doc comment for the row-level
        // corruption check that catches the rest.
        const rows =
            XLSX.utils.sheet_to_json(sheet, { raw: false })
                .filter((row) => !isBlankRow(row));

        previewExcel(rows);

    };

    reader.readAsBinaryString(file);

});

// A controller's Unique ID becomes its device's MQTT farmId verbatim
// (controllers.uniqueId), and the firmware builds every topic it uses as
// farm/<farmId>/... via snprintf(..., "%04u", farmId) - a plain 4-digit
// decimal string, zero-padded. Anything else (the old template's
// "FBIRRIGO26AA10001X"-style example, a typo, a copy-paste from the wrong
// column) silently creates a controller no device can ever actually reach -
// caught here, before it ever reaches Firestore.
function isValidUniqueId(uniqueId) {
    return /^\d{4}$/.test(String(uniqueId ?? "").trim());
}

// True if every one of this row's real columns is empty - the sample
// template ships 200 blank, pre-formatted rows below its examples (see
// downloadControllerSample() in controller-database.html) so an admin
// typing new controllers straight into it still gets Text-formatted ID/
// SIM cells; sheet_to_json() still returns those rows since the cells
// exist (just empty), so without this they'd show up in the preview as
// 200 fake "Invalid Unique ID" rows instead of being silently skipped.
function isBlankRow(row) {
    return ["Variant", "Serial Number", "Unique ID", "IMEI Number", "SIM MSISDN", "SIM Number", "SIM IMSI"]
        .every((field) => !String(row[field] ?? "").trim());
}

// Every column that must be a plain run of digits, never scientific
// notation or a decimal point - a source Excel column left in
// General/Number format instead of Text mangles any of these the exact
// same way it mangles Unique ID (see the sheet_to_json() call's own doc
// comment): "8991940912940333745" becomes "8.99194E+17" and the real
// digits are gone for good, not just hidden.
const NUMERIC_ID_FIELDS = ["Serial Number", "IMEI Number", "SIM Number", "SIM MSISDN", "SIM IMSI"];

// True if `value` still shows the signature of having passed through a
// number conversion at some point - scientific notation or a decimal
// point. raw:false on the sheet_to_json() call (above) already recovers
// the common case (a Text-formatted cell SheetJS would otherwise coerce
// to a number); this catches what that can't: a source cell that was
// ALREADY a lossy float inside the Excel file itself, because the column
// wasn't set to Text before the data was typed or pasted in. No amount
// of parsing on this end can get those digits back - the fix has to be
// upstream, in how the sheet was filled in - so this exists to refuse
// the row loudly instead of silently saving garbage.
function looksCorrupted(value) {
    const s = String(value ?? "").trim();
    if (!s) return false;
    return /[eE][+-]?\d/.test(s) || s.includes(".");
}

// Recovers a zero-padded 4-digit Unique ID from a bare number Excel/
// SheetJS handed back without its leading zeros ("1" -> "0001") - only
// when the digits themselves are still intact (1-4 of them and nothing
// else), never for a value that's wrong in some other way.
function normalizeUniqueId(value) {
    const s = String(value ?? "").trim();
    return /^\d{1,4}$/.test(s) ? s.padStart(4, "0") : s;
}

// Applied identically by previewExcel() and uploadControllers() so what
// the admin sees in the preview modal is exactly what would actually get
// saved - normalizes Unique ID's leading zeros and flags any of
// NUMERIC_ID_FIELDS that still looks corrupted after that.
function normalizeControllerRow(row) {
    const normalized = { ...row, "Unique ID": normalizeUniqueId(row["Unique ID"]) };
    const corruptedFields = NUMERIC_ID_FIELDS.filter((field) => looksCorrupted(row[field]));
    return { row: normalized, corruptedFields };
}

// The same rules the Production page applies to a controller
// (server/src/bridge/production.js checkFields()), so a controller added
// either way looks the same. Returns { values, problem } - values are the
// record's fields, every one a string ("" when the cell was blank:
// sheet_to_json() leaves a blank cell out of the row, and a missing field
// made Firestore reject the whole row - every hub without a SIM failed).
const VARIANTS = ["IRRIGO", "IRRIGO_PLUS", "IRRIGO_SMART_PLUS"];
const cleanCell = (v) => String(v ?? "").replace(/\s+/g, "").trim();
function normalizeVariant(v) {
    const s = String(v ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    return { IRRIGOPLUS: "IRRIGO_PLUS", IRRIGOSMARTPLUS: "IRRIGO_SMART_PLUS", IRRIGO_SMARTPLUS: "IRRIGO_SMART_PLUS" }[s] || s;
}
function checkControllerRow(rawRow) {
    const { row, corruptedFields } = normalizeControllerRow(rawRow);
    const values = {
        variant: normalizeVariant(row["Variant"]),
        serialNumber: cleanCell(row["Serial Number"]).toUpperCase(),
        uniqueId: cleanCell(row["Unique ID"]),
        imeiNumber: cleanCell(row["IMEI Number"]),
        simMsisdn: cleanCell(row["SIM MSISDN"]),
        simNumber: cleanCell(row["SIM Number"]).toUpperCase(),
        simImsi: cleanCell(row["SIM IMSI"])
    };
    if (/^\d{1,4}$/.test(values.uniqueId)) values.uniqueId = values.uniqueId.padStart(4, "0");
    let problem = "";
    if (corruptedFields.length) problem = `${corruptedFields.join(", ")} looks corrupted (scientific notation/decimal) - re-enter that column in Excel as Text`;
    else if (!VARIANTS.includes(values.variant)) problem = `Variant must be IRRIGO, IRRIGO_PLUS or IRRIGO_SMART_PLUS - got "${row["Variant"] ?? ""}"`;
    else if (!values.serialNumber) problem = "Serial Number is missing";
    else if (!/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(values.serialNumber)) problem = `Serial Number: letters, digits and - only (4-32) - got "${values.serialNumber}"`;
    else if (!isValidUniqueId(values.uniqueId)) problem = `Invalid Unique ID (must be 4 digits, e.g. "0001") - got "${row["Unique ID"] ?? ""}"`;
    else if (values.uniqueId === "0000") problem = "0000 is not a valid Unique ID";
    else if (!values.serialNumber.endsWith(values.uniqueId)) problem = `Serial Number ${values.serialNumber} must end in the Unique ID ${values.uniqueId}`;
    else if (!values.imeiNumber) problem = "IMEI Number is missing";
    else if (!/^\d{15}$/.test(values.imeiNumber)) problem = `IMEI Number must be 15 digits - got "${values.imeiNumber}"`;
    else if (values.simMsisdn && !/^\d{8,15}$/.test(values.simMsisdn)) problem = "SIM MSISDN must be 8-15 digits";
    else if (values.simNumber && !/^\d{18,22}F?$/.test(values.simNumber)) problem = "SIM Number must be 18-22 digits (the ICCID printed on the SIM)";
    else if (values.simImsi && !/^\d{14,15}$/.test(values.simImsi)) problem = "SIM IMSI must be 15 digits";
    return { values, problem };
}

// The fields no two controllers may share (as the Production page checks).
const UNIQUE_FIELDS = [
    ["serialNumber", "Serial Number"], ["uniqueId", "Unique ID"], ["imeiNumber", "IMEI Number"],
    ["simMsisdn", "SIM MSISDN"], ["simNumber", "SIM Number"], ["simImsi", "SIM IMSI"]
];
// A clash with a controller already saved, or with an earlier row of this
// same file - only on values actually there (two blank SIM cells are not
// the same SIM). "" when none.
function clashOf(values, existing, seenInFile) {
    for (const [key, label] of UNIQUE_FIELDS) {
        const v = values[key];
        if (!v) continue;
        const hit = existing.find((c) => String(c[key] ?? "").trim().toUpperCase() === v);
        if (hit) return `${label} ${v} is already used by controller ${hit.uniqueId || hit.serialNumber || hit.id}`;
        if (seenInFile[key].has(v)) return `${label} ${v} appears twice in this file`;
    }
    return "";
}
const newSeen = () => Object.fromEntries(UNIQUE_FIELDS.map(([k]) => [k, new Set()]));
const markSeen = (values, seen) => UNIQUE_FIELDS.forEach(([k]) => { if (values[k]) seen[k].add(values[k]); });
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// "Ravi Kumar (Production)", "admin@... (Excel upload)" - who added a controller.
function createdByText(c) {
    const by = c?.createdBy;
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    if (!by) return "-";
    const how = c.source === "production" ? "Production" : c.source === "excel" ? "Excel upload" : "";
    const who = by.type === "staff" ? `${by.name || by.id} (@${by.id})` : (by.id || by.name || "Admin");
    return esc(who) + (how ? ` <small>· ${how}</small>` : "");
}

/* ================= Preview Excel ================= */
function previewExcel(rows) {

    const tbody = document.getElementById("previewTable");
    tbody.innerHTML = "";

    const existing = getControllers();
    const seen = newSeen();
    rows.forEach((row, index) => {

        // Same checks uploadControllers() makes, so "Ready" here means it saves.
        const { values, problem: bad } = checkControllerRow(row);
        const problem = bad || clashOf(values, existing, seen);
        if (!problem) markSeen(values, seen);

        tbody.innerHTML += `
            <tr>
                <td>${index + 1}</td>

                <td>${escHtml(values.serialNumber || "-")}</td>

                <td>${escHtml(values.variant || "-")}</td>

                <td>
                    ${problem
                        ? `<span class="status-invalid">${escHtml(problem)}</span>`
                        : `<span class="status-ready">Ready</span>`
                    }
                </td>
            </tr>
        `;

    });

    document
        .getElementById("uploadPreviewModal")
        .classList.remove("hidden");

    window.previewRows = rows;
}

/* ================= Confirm Upload ================= */
document
.getElementById("confirmUpload")
.onclick = uploadControllers;

/* ================= Upload Controller ================= */


/* ================= PAIRED HARDWARE ================= */


function onlinePill(online) {
  return online
    ? `<span class="mqtt-status-pill issued">Online</span>`
    : `<span class="mqtt-status-pill none">Offline</span>`;
}

/**
 * The master (the hub itself - it has no BLE pairing, so it isn't in
 * pairedUnits) first, then every node paired from the Irrigo app
 * (farmers/{id}.pairedUnits). Online states come from the hub's own live
 * reports (deviceStatus): its lastSeen for the master, each motor node's relayed
 * status, and the valves-topic snapshot's node list for valve nodes.
 */
// "MOTOR_3" -> "3"; null for anything else.
function motorNumberOf(nodeLabel) {
  const m = /^MOTOR_(\d+)$/.exec(String(nodeLabel || ""));
  return m ? m[1] : null;
}

// A unit paired at or before its removal note (pairedUnits.removed.<kind>.
// <label>) is a removed one an old app version uploaded again - see the
// Irrigo app's PairedUnitsRepository.removedAt().
function livePairedUnits(f, kind, labelKey) {
  const removed = f.pairedUnits?.removed?.[kind] || {};
  return Object.values(f.pairedUnits?.[kind] || {}).filter((u) => {
    const at = removed[u?.[labelKey]];
    return !(typeof at === "number" && (u.provisionedAtMs || 0) <= at);
  });
}

function pairedHardwareHtml(f) {
  const ds = f.deviceStatus || {};
  const health = ds.health || {};
  const rows = [];

  if (f.controller?.uniqueId) {
    const seen = !!ds.lastSeen;
    const parts = [`ID ${escHtml(f.controller.uniqueId)}`];
    if (health.fw_version) parts.push(`FW ${escHtml(health.fw_version)}`);
    if (health.transport) parts.push(escHtml(String(health.transport).toUpperCase()));
    if (Number.isFinite(health.signal_pct)) parts.push(`signal ${health.signal_pct}%`);
    rows.push(`
      <div class="info-item full">
        <b>Master</b> (Motor hub${ds.nodeId ? ` ${escHtml(ds.nodeId)}` : ""}) - ${parts.join(" · ")}
        ${seen ? onlinePill(isDeviceOnline(ds)) : `<span class="mqtt-status-pill none">Not connected yet</span>`}
      </div>
    `);
  }

  const motorNodes = livePairedUnits(f, "motorNodes", "nodeLabel");
  for (const u of motorNodes) {
    const extra = u.bleDeviceName ? ` · ${escHtml(u.bleDeviceName)}` : "";
    rows.push(`
      <div class="info-item">
        <b>${escHtml(u.nodeLabel)}</b> (Motor Node)${extra}
        ${motorNumberOf(u.nodeLabel) ? onlinePill(isMotorOnline(ds, motorNumberOf(u.nodeLabel))) : ""}
      </div>
    `);
  }

  const liveUnits = Array.isArray(ds.valves?.units) ? ds.valves.units : [];
  const valves = livePairedUnits(f, "valves", "unitLabel")
    .sort((a, b) => (a.valveOffset ?? 0) - (b.valveOffset ?? 0));
  for (const u of valves) {
    const first = (u.valveOffset ?? 0) + 1;
    const last = (u.valveOffset ?? 0) + (u.valveCount ?? 0);
    const range = u.valveCount ? ` · V${first}${last > first ? `–V${last}` : ""}` : "";
    const hw = `${escHtml(u.channelCount || "?")}-ch ${escHtml(u.valveType || "")}`.trim();
    const extra = u.bleDeviceName ? ` · ${escHtml(u.bleDeviceName)}` : "";
    const live = liveUnits.find((x) => x.u === u.unitLabel);
    rows.push(`
      <div class="info-item">
        <b>${escHtml(u.unitLabel)}</b> (${u.hasPressureSensors ? "Filter Backwash" : "Valve"}) - ${hw}, ${esc(u.valveCount)} valve(s)${range}${extra}
        ${live ? onlinePill(live.on && isDeviceOnline(ds)) : ""}
      </div>
    `);
  }

  return rows.length ? rows.join("") : `<div class="info-item full">No hardware paired yet</div>`;
}

async function uploadControllers(){

    const rows = window.previewRows || [];

    if(!rows.length) return;

    document
    .getElementById("pageLoader")
    .style.display="flex";

    let uploaded=0;
    let failed=0;
    const failures=[];   // "Row 3: IMEI Number must be 15 digits"
    const seen=newSeen();

    for(const [i, rawRow] of rows.entries()){

        try{

            // Checked again here (not read back from the preview) so what's
            // saved always matches what "Ready" meant on screen.
            const { values, problem: bad } = checkControllerRow(rawRow);
            const problem = bad || clashOf(values, getControllers(), seen);
            if (problem) {
                failures.push(`Row ${i + 1}: ${problem}`);
                failed++;
                continue;
            }
            markSeen(values, seen);

            await addDoc(collection(db,"controllers"),{

                ...values,

                status:"available",

                farmerId:null,

                // Who added it - the Production page records the same
                // (server/src/bridge/production.js).
                source:"excel",

                createdBy:{ type:"admin", id:(auth.currentUser?.email || "").toLowerCase(), name:auth.currentUser?.email || "" },

                createdAt:serverTimestamp()

            });

            uploaded++;

        }

        catch(err){

            console.error(err);
            failures.push(`Row ${i + 1}: couldn't save - ${err.message}`);

            failed++;

        }

    }

    document
    .getElementById("pageLoader")
    .style.display="none";

    document
    .getElementById("uploadPreviewModal")
    .classList.add("hidden");

    document
    .getElementById("uploadResult")
    .innerHTML=`
        <h3>Upload Completed</h3>

        Uploaded : ${uploaded}<br>

        Failed : ${failed}
        ${failures.length ? `<ul style="text-align:left;max-height:240px;overflow:auto;margin-top:8px">${failures.map((f) => `<li>${escHtml(f)}</li>`).join("")}</ul>` : ""}
    `;

    document
    .getElementById("uploadResultModal")
    .classList.remove("hidden");

    renderControllers();
    fileInput.value="";

}

/* ================= Cancel Preview ================= */

document
.getElementById("cancelPreview")
.onclick = ()=>{

  /* ================= upload preview ================= */
 document
 .getElementById("uploadPreviewModal")
 .classList.add("hidden");

}

/* ================= close preview ================= */
document
.getElementById("closePreview")
.onclick = ()=>{

 document
 .getElementById("uploadPreviewModal")
 .classList.add("hidden");

}

document
.getElementById("closeUploadResult")
.onclick = ()=>{

 document
 .getElementById("uploadResultModal")
 .classList.add("hidden");

}

/* ================= LIST (css/records.css) ================= */
// Search, filters, sort and page are kept for this browser tab.
const STATE_KEY = "fb.controllerDb.v1";
const DEFAULTS = { q: "", status: "all", variant: "all", source: "all", sort: "oldest", size: 20, page: 1, open: false };
const st = loadState(STATE_KEY, DEFAULTS);
let shown = [];

const $ = (id) => document.getElementById(id);
const ms = (t) => (t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : (Date.parse(t) || 0));
const VARIANT_NAMES = { IRRIGO: "Irrigo", IRRIGO_PLUS: "Irrigo Plus", IRRIGO_SMART_PLUS: "Irrigo Smart Plus" };
const STATUS_NAMES = { available: "Available", assigned: "Assigned", sold: "Unmapped" };
const STATUS_TONE = { available: "green", assigned: "blue", sold: "red" };

// Farmer holding each Unique ID; "assigned" with no farmer shows as available.
function holders() {
  const m = new Map();
  for (const f of getFarmers()) if (f.controller?.uniqueId) m.set(f.controller.uniqueId, f);
  return m;
}
const statusOf = (c, farmer) => (c.status === "assigned" && !farmer ? "available" : c.status);
const sourceOf = (c) => (c.source === "production" ? "production" : c.source === "excel" ? "excel" : "other");

const GROUPS = [
  { key: "status", label: "Status", opts: [["all", "All"], ["available", "Available"], ["assigned", "Assigned"], ["sold", "Unmapped"]] },
  { key: "variant", label: "Variant", opts: [["all", "All"], ["IRRIGO", "Irrigo"], ["IRRIGO_PLUS", "Irrigo Plus"], ["IRRIGO_SMART_PLUS", "Irrigo Smart Plus"]] },
  { key: "source", label: "Added by", opts: [["all", "All"], ["production", "Production"], ["excel", "Excel upload"], ["other", "Other"]] }
];
const activeCount = () => GROUPS.filter((g) => st[g.key] !== "all").length;

const SORTS = {
  oldest: (a, b) => ms(a.c.createdAt) - ms(b.c.createdAt),
  newest: (a, b) => ms(b.c.createdAt) - ms(a.c.createdAt),
  uid: (a, b) => String(a.c.uniqueId || "").localeCompare(String(b.c.uniqueId || "")),
  serial: (a, b) => String(a.c.serialNumber || "").localeCompare(String(b.c.serialNumber || ""))
};

function renderFilters() {
  $("cdFilters").innerHTML = GROUPS.map((g) => `
    <div class="rx-fgroup"><span>${g.label}</span><div class="rx-chips">
      ${g.opts.map(([v, l]) => `<button type="button" class="rx-chip${st[g.key] === v ? " on" : ""}" data-f="${g.key}" data-v="${v}" aria-pressed="${st[g.key] === v}">${l}</button>`).join("")}
    </div></div>`).join("");
  $("cdFilters").hidden = !st.open;
  $("cdFilterBtn").classList.toggle("on", st.open);
  $("cdFilterBtn").setAttribute("aria-expanded", String(st.open));
  const n = activeCount();
  $("cdFilterCount").hidden = !n;
  $("cdFilterCount").textContent = n;
  const pills = GROUPS.filter((g) => st[g.key] !== "all").map((g) =>
    `<button type="button" class="rx-pill-x" data-clear="${g.key}" title="Remove this filter">${esc(g.label)}: ${esc(g.opts.find(([v]) => v === st[g.key])?.[1] || "")}${icon("x")}</button>`);
  if (st.q) pills.push(`<button type="button" class="rx-pill-x" data-clear="q">“${esc(st.q)}”${icon("x")}</button>`);
  $("cdActive").innerHTML = pills.length ? pills.join("") + `<button type="button" class="rx-clear" data-clear="all">Clear all</button>` : "";
}

function renderStats(all) {
  const n = (s) => all.filter((x) => x.status === s).length;
  const tile = (label, v, tone, set, on) =>
    `<button type="button" class="rx-stat${on ? " on" : ""}" data-tone="${tone}" data-stat='${JSON.stringify(set)}'><small>${label}</small><b>${v}</b></button>`;
  const variants = Object.keys(VARIANT_NAMES).filter((v) => all.some((x) => x.c.variant === v));
  $("cdStats").innerHTML =
    tile("Total", all.length, "", { status: "all", variant: "all" }, false) +
    tile("Available", n("available"), "green", { status: "available" }, st.status === "available") +
    tile("Assigned", n("assigned"), "blue", { status: "assigned" }, st.status === "assigned") +
    tile("Unmapped", n("sold"), "red", { status: "sold" }, st.status === "sold") +
    (variants.length > 1 ? variants.map((v) => tile(VARIANT_NAMES[v], all.filter((x) => x.c.variant === v).length, "blue", { variant: v }, st.variant === v)).join("") : "");
}

function matches(x, q) {
  if (st.status !== "all" && x.status !== st.status) return false;
  if (st.variant !== "all" && x.c.variant !== st.variant) return false;
  if (st.source !== "all" && sourceOf(x.c) !== st.source) return false;
  if (!q) return true;
  const c = x.c;
  return [c.serialNumber, c.uniqueId, c.username, c.imeiNumber, c.simNumber, c.simMsisdn, c.simImsi, c.variant,
    VARIANT_NAMES[c.variant], x.farmer?.farmBuddieId, x.farmer?.name, c.createdBy?.name, c.createdBy?.id]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
}

function row(x, i) {
  const { c, farmer, status } = x;
  const tone = STATUS_TONE[status] || "grey";
  const farmerCell = status === "assigned" && farmer
    ? `<button type="button" class="rx-link" data-act="farmer" data-fb="${esc(farmer.farmBuddieId)}" data-id="${esc(c.id)}" title="Open the farmer">${esc(farmer.farmBuddieId)}</button>`
    : status === "sold" ? `<span class="rx-tag" data-tone="red">Unmapped</span>` : `<span style="color:var(--fbx-faint)">Not assigned</span>`;
  const by = c.createdBy ? createdByText(c) : "-";
  return `<article class="rx-row" data-tone="${status === "assigned" ? "green" : "grey"}" style="animation-delay:${Math.min(i, 12) * 18}ms">
    <div class="rx-id"><b>${esc(c.uniqueId || "-")}</b><span class="rx-tag" data-tone="${tone}">${esc(STATUS_NAMES[status] || status || "-")}</span></div>
    <div class="rx-main">
      <div class="rx-name"><span class="rx-mono">${esc(c.serialNumber || "-")}</span><em>${esc(VARIANT_NAMES[c.variant] || c.variant || "")}${c.username ? " · " + esc(c.username) : ""}</em></div>
      <div><small>IMEI</small><span class="rx-mono">${esc(c.imeiNumber || "-")}</span></div>
      <div><small>Farmer</small>${farmerCell}</div>
      <div class="rx-wide-only"><small>Added</small>${by}${c.createdAt ? `<br><span style="color:var(--fbx-faint)">${esc(fmtDateTime(c.createdAt))}</span>` : ""}</div>
    </div>
    <div class="rx-side"><div class="rx-actions">
      ${status === "assigned" && farmer ? `<button type="button" class="rx-icon" data-act="farmer" data-fb="${esc(farmer.farmBuddieId)}" data-id="${esc(c.id)}" title="Farmer details" aria-label="Farmer details for ${esc(c.uniqueId)}">${icon("eye")}</button>` : `<span class="rx-icon" style="visibility:hidden" aria-hidden="true"></span>`}
    </div></div>
  </article>`;
}

function renderControllers() {
  saveState(STATE_KEY, st);
  const list0 = getControllers();
  if (!list0.length && !isLive("controllers")) return;      // still loading - the skeletons stay
  const hold = holders();
  // Production-internal statuses stay hidden, as before.
  const all = list0.filter((c) => ADMIN_VISIBLE_STATUSES.includes(c.status))
    .map((c) => { const farmer = hold.get(c.uniqueId); return { c, farmer, status: statusOf(c, farmer) }; });
  const q = st.q.trim().toLowerCase();
  shown = all.filter((x) => matches(x, q)).sort(SORTS[st.sort] || SORTS.oldest);
  const size = Number(st.size) || 20;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  st.page = Math.min(Math.max(1, st.page), pages);
  const from = (st.page - 1) * size;
  const page = shown.slice(from, from + size);

  renderStats(all);
  renderFilters();
  $("cdCount").textContent = !all.length ? "" :
    `${shown.length} of ${all.length} controller${all.length === 1 ? "" : "s"}` + (shown.length ? ` · showing ${from + 1}-${from + page.length}` : "");
  $("cdList").innerHTML = page.length ? page.map(row).join("") :
    `<div class="rx-empty">${icon("inbox")}<p>${all.length ? "No controllers match these filters." : "No controllers yet - add them on the Production page or upload an Excel."}</p>${activeCount() || st.q ? `<button type="button" class="rx-btn" data-clear="all">Clear filters</button>` : ""}</div>`;
  renderPager($("cdPager"), st.page, pages);
}

/* ================= LIST CONTROLS ================= */
document.querySelectorAll("[data-rx-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.rxIcon); });
const searchBox = $("searchInput");
searchBox.value = st.q;
$("cdSort").value = st.sort;
$("cdSize").value = String(st.size);
slashToSearch(searchBox);
let typing = 0;
searchBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { st.q = searchBox.value; st.page = 1; renderControllers(); }, 120);
});
$("cdSort").addEventListener("change", (e) => { st.sort = e.target.value; st.page = 1; renderControllers(); });
$("cdSize").addEventListener("change", (e) => { st.size = Number(e.target.value) || 20; st.page = 1; renderControllers(); });
$("cdFilterBtn").addEventListener("click", () => { st.open = !st.open; renderFilters(); saveState(STATE_KEY, st); });
$("cdExcel").addEventListener("click", exportControllers);

function clearFilter(key) {
  if (key === "all") { Object.assign(st, { ...DEFAULTS, sort: st.sort, size: st.size, open: st.open }); searchBox.value = ""; }
  else if (key === "q") { st.q = ""; searchBox.value = ""; }
  else st[key] = "all";
  st.page = 1;
  renderControllers();
}

$("cdPage").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-f]");
  if (chip) { st[chip.dataset.f] = chip.dataset.v; st.page = 1; return renderControllers(); }
  const clr = e.target.closest("[data-clear]");
  if (clr) return clearFilter(clr.dataset.clear);
  const stat = e.target.closest("[data-stat]");
  if (stat) {
    const set = JSON.parse(stat.dataset.stat);
    const already = stat.classList.contains("on");
    Object.assign(st, already ? Object.fromEntries(Object.keys(set).map((k) => [k, "all"])) : set);
    st.page = 1;
    return renderControllers();
  }
  const pg = e.target.closest("button[data-page]");
  if (pg && !pg.disabled) {
    st.page = Number(pg.dataset.page);
    renderControllers();
    $("cdCount").scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const act = e.target.closest("[data-act='farmer']");
  if (act) window.openFarmerPanel(act.dataset.fb, act.dataset.id);
});

async function exportControllers() {
  if (!shown.length) { toast("Nothing to export - clear the filters first", true); return; }
  try {
    const XLSX = await window.loadXlsx();
    const rows = shown.map(({ c, farmer, status }) => ({
      "Variant": c.variant || "", "Serial Number": c.serialNumber || "", "Unique ID": c.uniqueId || "",
      "Username": c.username || "", "IMEI Number": c.imeiNumber || "", "SIM MSISDN": c.simMsisdn || "",
      "SIM Number": c.simNumber || "", "SIM IMSI": c.simImsi || "", "Status": STATUS_NAMES[status] || status || "",
      "Farmer": farmer?.farmBuddieId || "", "Added by": c.createdBy ? (c.createdBy.name || c.createdBy.id || "") : "",
      "Source": c.source || "", "Created At": c.createdAt ? fmtDateTime(c.createdAt) : ""
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Controllers");
    XLSX.writeFile(wb, "Farm_Buddie_Controllers.xlsx");
  } catch (err) {
    toast("Couldn't make the Excel file: " + err.message, true);
  }
}

/* ================= FARMER SIDE PANEL (1:1 WITH ONBOARDING) ================= */
window.openFarmerPanel = async function (farmBuddieId, controllerDocId) {
  window.__currentControllerDocId = controllerDocId || null;
  window.__currentFarmerMqtt = null;

  let panel = document.getElementById("farmerPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "farmerPanel";
    panel.className = "fb-side-panel hidden";
    panel.innerHTML = `
      <div class="fb-side-header">
        <h3>👨‍🌾 Farmer Details</h3>
        <button onclick="closeFarmerPanel()">✖</button>
      </div>
      <div class="fb-side-body" id="farmerPanelBody">Loading…</div>
    `;
    document.body.appendChild(panel);
  }

  panel.classList.remove("hidden");

  // Looked up from the already-live store instead of a fresh query - this
  // farmer's data is already in getFarmers() via data-store.js's listener.
  const f = getFarmers().find(x => x.farmBuddieId === farmBuddieId);

  if (!f) {
    document.getElementById("farmerPanelBody").innerHTML =
      `<div class="info-item full">Farmer details are still loading - close this and open it again in a moment.</div>`;
    return;
  }

  const appUsersHtml = (f.appUsers?.length)
    ? f.appUsers.map(u =>
        `<div class="info-item"><b>${esc(u.name)}</b>: ${esc(u.mobile)}</div>`
      ).join("")
    : `<div class="info-item full">No additional app users</div>`;

  document.getElementById("farmerPanelBody").innerHTML = `

  <!-- FARMER IDENTITY -->
  <div class="section-title">👨‍🌾 Farmer Identity</div>
  <div class="info-grid">
    <div class="info-item"><b>Farm Buddie ID:</b> ${esc(f.farmBuddieId || "-")}</div>
    <div class="info-item"><b>Title:</b> ${esc(f.title || "-")}</div>
    <div class="info-item"><b>Name:</b> ${esc(f.name || "-")}</div>
    <div class="info-item"><b>Status:</b> ${esc(f.status || "-")}</div>
    <div class="info-item"><b>Primary Mobile:</b> ${esc(f.primaryMobile || "-")}</div>
    <div class="info-item"><b>Secondary Mobile:</b> ${esc(f.secondaryMobile || "-")}</div>
    <div class="info-item"><b>Aadhaar Number:</b> ${esc(f.aadhaarNumber || "-")}</div>

      <div class="info-item">
        <b>Lead Source:</b> ${
          f.leadSource?.type === "DISTRIBUTOR"
            ? "Distributor"
            : "Farm Buddie Smart Irrigation"
        }
      </div>

      ${
        f.leadSource?.type === "DISTRIBUTOR"
          ? `
            <div class="info-item">
              <b>Distributor Name:</b> ${esc(f.leadSource?.distributorName || "-")}
            </div>
          `
          : ""
      }

      <div class="info-item full"><b>Address:</b> ${esc(f.address || "-")}</div>
  </div>

  <!-- APP USERS -->
  <div class="section-title">📱 App Access Users</div>
  <div class="info-grid">
    ${
      Array.isArray(f.appUsers) && f.appUsers.length
        ? f.appUsers.map(u => `
            <div class="info-item">
              <b>${esc(u.name || "User")}:</b> ${esc(u.mobile || "-")}
            </div>
          `).join("")
        : `<div class="info-item full">No additional app users</div>`
    }
  </div>

  <!-- FARM & APP USER DETAILS -->
    <div class="section-title">🌾 Farm & App User Details</div>
    <div class="info-grid">
      <div class="info-item full">
        <b>Farm Location:</b> ${esc(f.farmDetails?.location || "-")}
        </div>

        <div class="info-item">
          <b>Farm Latitude:</b> ${esc(f.farmDetails?.latitude || "-")}
        </div>

        <div class="info-item">
          <b>Farm Longitude:</b> ${esc(f.farmDetails?.longitude || "-")}
        </div>


    </div>

  <!-- DOCUMENTS -->
  <div class="section-title">📂 Uploaded Documents</div>
  <div class="info-grid">
    <div class="info-item">
      <b>Aadhaar File:</b>
      ${
        f.documents?.aadhaarUrl
          ? `<a href="${esc(f.documents.aadhaarUrl)}" target="_blank">View Document</a>`
          : "-"
      }
    </div>
    <div class="info-item">
      <b>Other Document:</b>
      ${
        f.documents?.otherDocUrl
          ? `<a href="${esc(f.documents.otherDocUrl)}" target="_blank">View Document</a>`
          : "-"
      }
    </div>
  </div>

  <!-- NETWORK -->
  <div class="section-title">🌐 Network Management</div>
  <div class="info-grid">
    <div class="info-item"><b>Network Type:</b> ${esc(f.network?.type || "-")}</div>
  </div>

  <!-- SIM DETAILS -->
  <div class="section-title">📶 SIM Management</div>
  <div class="info-grid">
   <div class="info-item"><b>SIM Number (ICCID):</b> ${esc(f.sim?.simNumber || "-")}</div>
    <div class="info-item"><b>MSISDN:</b> ${esc(f.sim?.msisdn || "-")}</div>
    <div class="info-item"><b>IMSI:</b> ${esc(f.sim?.simImsi || "-")}</div>
    <div class="info-item"><b>IMEI:</b> ${esc(f.sim?.imeiNumber || "-")}</div>
    <div class="info-item"><b>SIM Type:</b> ${esc(f.sim?.simType || "-")}</div>
    <div class="info-item"><b>Billing Cycle:</b> ${esc(f.sim?.billingCycle || "-")}</div>
    <div class="info-item"><b>SIM/AMC Activation Date:</b> ${esc(f.sim?.activationDate || "-")}</div>
  </div>

  <!-- CONTROLLER -->
<div class="section-title">🧠 MCU / Device Mapping</div>
<div class="info-grid">
  <div class="info-item"><b>Variant:</b> ${esc(f.controller?.variant || "-")}</div>
  <div class="info-item"><b>Serial Number:</b> ${esc(f.controller?.serialNumber || "-")}</div>
  <div class="info-item full"><b>Unique Device ID:</b> ${esc(f.controller?.uniqueId || "-")}</div>

  <div class="info-item"><b>Warranty Start:</b> ${esc(f.controller?.warranty?.start || "-")}</div>
  <div class="info-item"><b>Warranty End:</b> ${esc(f.controller?.warranty?.end || "-")}</div>
</div>

<!-- MQTT DETAILS -->
<div class="section-title">📡 MQTT Configuration</div>
<div class="info-grid">
  <div class="info-item full"><b>Broker URL:</b> ${esc(f.controller?.mqtt?.brokerUrl || "-")}</div>
  <div class="info-item"><b>Port:</b> ${esc(f.controller?.mqtt?.port || "-")}</div>
  <div class="info-item full"><b>Username:</b> ${esc(f.controller?.mqtt?.username || "-")}</div>
</div>
<div class="mqtt-actions">
  <span class="mqtt-status-pill ${f.controller?.mqtt?.username ? "issued" : "none"}">
    ${f.controller?.mqtt?.username ? "Credentials issued" : "No credentials yet"}
  </span>
  ${
    // A farm's login is always FBIRG<its uniqueId>. Anything else was written
    // here by mistake (old Add Farm bug) - ask the server, which returns and
    // stores the right one.
    f.controller?.mqtt?.username && f.controller.mqtt.username === `FBIRG${esc(f.controller?.uniqueId)}`
      ? `<button class="fb-btn-primary small" onclick="fetchMqttCredentials()">📥 Fetch MQTT Credentials</button>`
      : `<button class="fb-btn-primary small" onclick="generateInitialMqttCredentials()">🔑 Generate MQTT Credentials</button>`
  }
</div>
<div id="mqttRevealBox"></div>

  <!-- PAIRED HARDWARE (live BLE-paired nodes, synced from the Irrigo app
       via farmers/{id}.pairedUnits - see PairedUnitsRepository.kt) -
       separate from the static onboarding-time counts right below
       (Motor & TNEB Configuration), which are just what the farmer was
       sold, not what's actually been paired over BLE yet. -->
  <div class="section-title">🔗 Paired Hardware</div>
  <div class="info-grid">
    ${pairedHardwareHtml(f)}
  </div>

  <!-- MOTOR & TNEB CONFIG -->
<div class="section-title">⚡ Motor & TNEB Configuration</div>
<div class="info-grid">

  <!-- Motors -->
  <div class="info-item">
    <b>No of Motors:</b> ${esc(f.motorConfig?.motorCount || 0)}
  </div>

  ${
    f.motorConfig?.pumpHp?.length
      ? f.motorConfig.pumpHp.map((hp, i) => `
          <div class="info-item">
            <b>Pump ${i+1} HP:</b> ${esc(hp || "-")}
          </div>
        `).join("")
      : `<div class="info-item full">No pump configuration</div>`
  }

  <!-- Services -->
  <div class="info-item">
    <b>No of Services:</b> ${esc(f.tnebServices?.serviceCount || 0)}
  </div>

  ${
    f.tnebServices?.services?.length
      ? f.tnebServices.services.map(service => `
          <div class="info-item">
            <b>Service ${esc(service.serviceNumber)} HP:</b> ${esc(service.sanctionedHp || "-")}
          </div>
        `).join("")
      : `<div class="info-item full">No service configuration</div>`
  }

</div>

    <!-- PUMP → SERVICE MAPPING -->
    <div class="section-title">🔁 Pump to Service Mapping</div>
    <div class="info-grid">
      ${
        f.pumpServiceMapping?.length
          ? f.pumpServiceMapping.map(map => `
              <div class="info-item">
                <b>Pump ${esc(map.pumpNumber)} (${esc(map.hp)}) →</b> Service ${esc(map.service)}
              </div>
            `).join("")
          : `<div class="info-item full">No mapping data</div>`
      }
    </div>

    <!-- VALVE CONFIG + ADDITIONAL FEATURES (see valve-config.js) -->
    ${valveConfigViewHtml(f.valveConfig)}
    ${nodeMappingViewHtml(f.nodes)}

  <!-- TIMESTAMPS -->
  <div class="section-title">⏱ Record Info</div>
  <div class="info-grid">
    <div class="info-item">
      <b>Created At:</b>
      ${fmtDateTime(f.createdAt)}
    </div>

    <div class="info-item">
      <b>Last Updated:</b>
      ${fmtDateTime(f.updatedAt)}
    </div>
  </div>

`;

  // Shows the durably-stored credential + QR immediately on every panel
  // open once one's been issued - the password is stored in plaintext
  // now (see deviceProvisioning.js's own doc comment on why), so this
  // never needs a fresh Rotate (which actually changes the password)
  // just to look at or re-share the QR again.
  if (f.controller?.mqtt?.password) {
    window.__currentFarmerMqtt = {
      brokerUrl: f.controller.mqtt.brokerUrl,
      port: f.controller.mqtt.port,
      username: f.controller.mqtt.username,
      password: f.controller.mqtt.password,
      farmId: f.controller.uniqueId,
      nodeId: "MOTOR_1",
      farmerName: f.name || "",
      farmBuddieId: f.farmBuddieId || ""
    };
    renderMqttCredentialReveal(document.getElementById("mqttRevealBox"), window.__currentFarmerMqtt);
  }
}

window.closeFarmerPanel = () =>
  document.getElementById("farmerPanel")?.classList.add("hidden");

/* ================= MQTT PROVISIONING ================= */

// Read-only - just re-renders the already-loaded, already-stored
// credential/QR (window.__currentFarmerMqtt, set when the panel opened -
// see openFarmerPanel()). No network call, no TBMQ mutation, so it's safe
// to click as often as needed. This is the button admins actually want
// for "show me the QR again" - Rotate (below) is a separate, deliberately
// less prominent action for when credentials need to be invalidated.
window.fetchMqttCredentials = async function () {
  const revealBox = document.getElementById("mqttRevealBox");
  const data = window.__currentFarmerMqtt;

  if (!data) {
    alert("❌ No credentials found for this device yet.");
    return;
  }

  if (revealBox) await renderMqttCredentialReveal(revealBox, data);
};

// Only reachable for a controller that has never had credentials issued
// (e.g. a pre-migration legacy record) - the normal path is onboarding's
// save button issuing them once (see add-farm.js/farmer-onboarding.js),
// after which they're final and this button no longer shows at all
// (fetchMqttCredentials() above takes over instead). Never rotates.
window.generateInitialMqttCredentials = async function () {

  const controllerDocId = window.__currentControllerDocId;
  const revealBox = document.getElementById("mqttRevealBox");

  if (!controllerDocId) {
    alert("❌ Could not determine which controller this is. Reopen the farmer panel and try again.");
    return;
  }

  try {
    if (revealBox) revealBox.innerHTML = `<div class="mqtt-reveal-box">Issuing credentials…</div>`;

    const data = await provisionDeviceCredentials(auth, controllerDocId, { rotate: false });

    // The credential is durably stored server-side now (see
    // deviceProvisioning.js) - no separate persistence step needed here,
    // it's already in Firestore by the time this returns, and the next
    // panel open reads it straight from f.controller.mqtt.password.
    if (revealBox) await renderMqttCredentialReveal(revealBox, data);

  } catch (err) {
    console.error("MQTT provisioning error:", err);
    if (revealBox) revealBox.innerHTML = "";
    alert("❌ " + err.message);
  }
};

/* ================= INSTANT FIRST PAINT ================= */
// The last data this browser saw, shown while the login check and the live
// listener start (see data-store.js warmDataStore()).
const PAGE_DATA = ["controllers", "farmers"];
subscribe(scheduleRender);
warmDataStore(PAGE_DATA);
