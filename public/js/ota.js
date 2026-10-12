import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import { sha256Hex, bytesInclude, loadSigningKey, signRelease } from "/js/ota-crypto.js";

// Admin > Firmware OTA. Server side: server/src/bridge/ota.js. The signing
// key and its passphrase are only ever used in this page (ota-crypto.js).

const POLL_MS = 5000;
const POLL_GIVE_UP_MS = 45 * 60 * 1000;

// Error codes the hub reports (Motor firmware, OtaManager) -> plain words.
const ERROR_TEXT = {
  pump_running: "Motor or cyclic program was running - resend when it's off",
  already_in_progress: "An update is already running on this hub",
  invalid_signature: "Signature rejected by the hub - key mismatch",
  missing_signature: "No signature - hub firmware expects a signed update",
  bad_signature_encoding: "Signature damaged in transit",
  checksum_mismatch: "Downloaded file didn't match - resend",
  size_mismatch: "Downloaded size didn't match - resend",
  download_stalled: "Download stalled (weak signal) - resend later",
  incomplete_download: "Download cut off - resend later",
  download_timeout: "Download took too long - resend later",
  flash_write_failed: "Couldn't write flash - check the hub",
  wifi_unavailable: "No WiFi for the download",
  gsm_unavailable: "No GSM link for the download",
  unknown_content_length: "Download server didn't give a file size",
  chunked_not_supported: "Download server used chunked transfer",
  too_many_redirects: "Too many redirects on the download link",
  connect_failed: "Couldn't reach the download server",
  no_response: "Download server didn't answer",
  // Node images - hub staging step and the units themselves.
  no_units: "This farm has no unit of this kind - nothing to update",
  hub_slot_busy: "Hub's own last update isn't confirmed yet - retry in a few minutes",
  unknown_product: "Hub firmware doesn't know this kind of unit - update the hub first",
  image_too_big: "Image too big for the slot",
  no_ota_slot: "Unit still on the old flash layout - needs one USB flash",
  wrong_product: "Image is for another kind of unit",
  sha256_mismatch: "Received image didn't match - it will be fetched again",
  write_failed: "Unit couldn't write its flash",
  commit_failed: "Unit couldn't switch to the new firmware",
  stalled: "Transfer stalled for an hour - unit offline or out of range",
  validating: "Unit is still confirming its previous update"
};
// How many units of the chosen kind a farm has (server: farmUnits.js);
// null for a hub image - every farm has a hub.
const UNIT_KEY = { "motor-node": "motorNodes", valve: "valves", "filter-backwash": "backwash" };
const UNIT_WORD = { "motor-node": ["motor node", "motor nodes"], valve: ["valve unit", "valve units"], "filter-backwash": ["backwash node", "backwash nodes"] };
const unitCount = (f, p = product()) => (UNIT_KEY[p] ? Number(f.units?.[UNIT_KEY[p]] || 0) : null);
// A farm the chosen image can go to. An old server without units: all.
const eligible = (f) => !isNode() || !f.units || unitCount(f) > 0;
const unitsText = (f) => {
  if (!f.units) return "-";
  const parts = Object.entries(UNIT_KEY).map(([p, k]) => [p, Number(f.units[k] || 0)]).filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} ${UNIT_WORD[p][n === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(", ") : "Hub only";
};
// Which device the image says it is for - see productLabels() in the
// server's ota.js (same rules).
function productLabels(bytes) {
  const prefix = new TextEncoder().encode("FARMBUDDIE-FW-PRODUCT=");
  const found = new Set();
  outer: for (let i = 0; i + prefix.length < bytes.length; i++) {
    for (let k = 0; k < prefix.length; k++) if (bytes[i + k] !== prefix[k]) continue outer;
    let j = i + prefix.length;
    let value = "";
    while (j < bytes.length && value.length <= 24) {
      const c = bytes[j];
      if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d) { value += String.fromCharCode(c); j++; }
      else break;
    }
    if (value.length >= 1 && value.length <= 24 && bytes[j] === 0x3b) found.add(value);
  }
  return [...found];
}
const PRODUCT_TEXT = { hub: "Hub", "motor-node": "Motor node", valve: "Valve unit", "filter-backwash": "Filter backwash" };
const NODE_STATE_TEXT = {
  receiving: "Receiving", installed: "Installed - waiting", validated: "Updated", current: "Already on it",
  failed: "Failed", rolled_back: "Rolled back"
};
const STATE_TEXT = {
  sent: "Waiting for hub", starting: "Starting", downloading: "Downloading", verifying: "Verifying",
  flashing: "Installing", validated: "Updated", failed: "Failed", rolled_back: "Rolled back",
  downloaded: "Downloaded", staged: "Handing out to units"
};

let config = null;          // { publicKeyPem, maxFirmwareBytes, farms }
let fileBytes = null;       // Uint8Array of the chosen .bin
let fileInfo = null;        // { sha256, size, hasKey, isEsp }
let pemText = null;
let currentReleaseId = null;
let pollTimer = null;
let pollStartedAt = 0;

const PAGE_SIZE = 10;
const selectedFarms = new Set();   // kept across pages and filters
let farmPage = 1;
let historyPage = 1;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const product = () => $("productInput").value;
const isNode = () => product() !== "hub";
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : "-");
// "2m 05s" since a GSM download started.
const gsmElapsed = (t) => {
  const sec = t ? Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000)) : 0;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
};

async function api(path, options = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${idToken}`, ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showPageError(msg) {
  const el = $("pageError");
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------------- init ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }
  try {
    config = await api("/ota/config");
    fillVersionFilter();
    renderFarms();
    await loadHistory();
  } catch (err) {
    showPageError(`Couldn't load OTA data: ${err.message}`);
  }
});

$("logoutBtn")?.addEventListener("click", () => signOut(auth).then(() => window.location.replace("/login.html")));

// ---------------- 1. firmware ----------------
$("binInput").addEventListener("change", async (e) => {
  fileBytes = null;
  fileInfo = null;
  const file = e.target.files[0];
  if (file) {
    fileBytes = new Uint8Array(await file.arrayBuffer());
    fileInfo = {
      name: file.name,
      size: fileBytes.length,
      sha256: await sha256Hex(fileBytes),
      isEsp: fileBytes[0] === 0xe9,
      hasKey: config ? bytesInclude(fileBytes, config.publicKeyPem) : false,
      labels: productLabels(fileBytes)
    };
  }
  renderChecks();
  updateReleaseButton();
});
$("versionInput").addEventListener("input", () => { renderChecks(); updateReleaseButton(); });
$("productInput").addEventListener("change", () => {
  renderChecks();
  // Node updates go to selected farms only (each hub restarts to stage one).
  const allRadio = document.querySelector('input[name="mode"][value="all"]');
  allRadio.disabled = isNode();
  if (isNode() && allRadio.checked) document.querySelector('input[name="mode"][value="farms"]').checked = true;
  $("nodeNote").hidden = !isNode();
  // A farm ticked for another kind of image may not have this kind of unit.
  for (const f of config?.farms || []) if (!eligible(f)) selectedFarms.delete(f.farmId);
  farmPage = 1;
  renderFarms();
  updateReleaseButton();
});

function versionValue() {
  return $("versionInput").value.trim();
}

function fileProblems() {
  const p = [];
  if (!fileInfo) return ["Choose the firmware.bin"];
  if (!fileInfo.isEsp) p.push("Not an ESP32 firmware image");
  const lp = labelProblem();
  if (lp) p.push(lp);
  if (config && fileInfo.size > config.maxFirmwareBytes) p.push(`Too big for the hub (${fileInfo.size} > ${config.maxFirmwareBytes} bytes)`);
  if (!fileInfo.hasKey) p.push("Doesn't contain the fleet's OTA public key - rebuild from the current repo");
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(versionValue())) p.push("Enter the version (same as FIRMWARE_VERSION in config.h)");
  return p;
}

function labelProblem() {
  const l = fileInfo?.labels || [];
  if (l.length === 0) return "Firmware doesn't say which device it is for - rebuild it from the current repo";
  if (l.length > 1 || l[0] !== product()) {
    return `This is ${l.map((x) => PRODUCT_TEXT[x] || x).join(" + ")} firmware - the type above is ${PRODUCT_TEXT[product()]}`;
  }
  return null;
}

function renderChecks() {
  const ul = $("binChecks");
  if (!fileInfo) { ul.innerHTML = ""; return; }
  const items = [
    [true, `${esc(fileInfo.name)} - ${(fileInfo.size / 1024).toFixed(0)} KB, SHA-256 <code>${fileInfo.sha256.slice(0, 16)}…</code>`],
    [fileInfo.isEsp, fileInfo.isEsp ? "ESP32 firmware image" : "Not an ESP32 firmware image"],
    [!labelProblem(), labelProblem() || `${PRODUCT_TEXT[product()]} firmware - matches the type above`],
    [fileInfo.hasKey, fileInfo.hasKey ? "Contains the fleet's OTA public key" : "Does NOT contain the fleet's OTA public key - devices would refuse later updates"],
    [!config || fileInfo.size <= config.maxFirmwareBytes, "Fits the hub's app slot"]
  ];
  ul.innerHTML = items.map(([ok, text]) => `<li class="${ok ? "ok" : "bad"}">${text}</li>`).join("");
}

// ---------------- 2. targets ----------------
// One button per page, with "…" gaps for long lists. onGo(page).
function renderPager(el, page, totalPages, totalItems, label, onGo) {
  if (totalItems === 0) { el.innerHTML = ""; return; }
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalItems);
  el.innerHTML = `<span class="ota-muted">${from}-${to} of ${totalItems} ${label}</span>
    <button data-go="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>
    ${pages.map((p) => p === "…" ? `<span class="ota-muted">…</span>`
      : `<button data-go="${p}" class="${p === page ? "active" : ""}">${p}</button>`).join("")}
    <button data-go="${page + 1}" ${page >= totalPages ? "disabled" : ""}>›</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("button[data-go]");
    if (b && !b.disabled) onGo(Number(b.dataset.go));
  };
}

function fillVersionFilter() {
  const versions = [...new Set((config?.farms || []).map((f) => f.fwVersion).filter(Boolean))].sort();
  $("farmVersionFilter").innerHTML = `<option value="">All versions</option>` +
    versions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("") +
    ((config?.farms || []).some((f) => !f.fwVersion) ? `<option value="__none">Unknown</option>` : "");
}

function filteredFarms() {
  const q = $("farmSearch").value.trim().toLowerCase();
  const status = $("farmStatusFilter").value;
  const version = $("farmVersionFilter").value;
  return (config?.farms || []).filter((f) => eligible(f) &&
    (!q || f.farmId.includes(q) || String(f.farmerName || "").toLowerCase().includes(q)) &&
    (!status || (status === "online") === Boolean(f.online)) &&
    (!version || (version === "__none" ? !f.fwVersion : f.fwVersion === version)));
}

function renderFarms() {
  const farms = filteredFarms();
  const totalPages = Math.max(1, Math.ceil(farms.length / PAGE_SIZE));
  farmPage = Math.min(Math.max(1, farmPage), totalPages);
  const shown = farms.slice((farmPage - 1) * PAGE_SIZE, farmPage * PAGE_SIZE);
  const disabled = mode() === "all" ? "disabled" : "";
  $("farmBody").innerHTML = shown.length ? shown.map((f) => `
    <tr>
      <td><input type="checkbox" class="farmPick" value="${esc(f.farmId)}" ${selectedFarms.has(f.farmId) ? "checked" : ""} ${disabled}></td>
      <td>${esc(f.farmId)}</td>
      <td>${esc(f.farmerName || "-")}</td>
      <td><span class="vps-dot ${f.online ? "ok" : "down"}"></span> ${f.online ? "Online" : "Offline"}</td>
      <td>${esc(f.fwVersion || "-")}</td>
      <td>${esc(unitsText(f))}</td>
    </tr>`).join("") : `<tr><td colspan="6">${!config?.farms?.length ? "No farms with a controller"
      : isNode() && !config.farms.some(eligible) ? `No farm has a ${UNIT_WORD[product()][0]} paired`
      : "No farm matches the filters"}</td></tr>`;
  // Header box = every farm the filters show (all pages), not just this page.
  const allShownPicked = farms.length > 0 && farms.every((f) => selectedFarms.has(f.farmId));
  $("selectAll").checked = allShownPicked;
  $("selectAll").disabled = mode() === "all";
  $("selectAll").title = `Select all ${farms.length} farm${farms.length === 1 ? "" : "s"} matching the filters`;
  const pool = (config?.farms || []).filter(eligible).length;
  $("farmCount").textContent = isNode()
    ? `${farms.length} of ${pool} farms with a ${UNIT_WORD[product()][0]} shown`
    : `${farms.length} of ${config?.farms?.length || 0} farms shown`;
  renderPager($("farmPager"), farmPage, totalPages, farms.length, "farms", (p) => { farmPage = p; renderFarms(); });
  updateTargetNote();
}

function selectedFarmIds() {
  return [...selectedFarms];
}

function updateTargetNote() {
  const all = mode() === "all";
  $("confirmAllWrap").hidden = !all;
  const n = all ? (config?.farms.length || 0) : selectedFarmIds().length;
  const offline = all ? (config?.farms || []).filter((f) => !f.online).length : 0;
  $("targetNote").textContent = all
    ? `All ${n} farms. ${offline ? `${offline} are offline now - they'll show "Waiting"; resend to them later.` : ""}`
    : n ? `${n} farm${n > 1 ? "s" : ""} selected: ${selectedFarmIds().slice(0, 12).join(", ")}${n > 12 ? ", …" : ""}.`
      : "Tick the farm(s) to update - start with one hub.";
  updateReleaseButton();
}

const refilter = () => { farmPage = 1; renderFarms(); };
$("farmSearch").addEventListener("input", refilter);
$("farmStatusFilter").addEventListener("change", refilter);
$("farmVersionFilter").addEventListener("change", refilter);
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", renderFarms));
$("farmBody").addEventListener("change", (e) => {
  if (!e.target.classList.contains("farmPick")) return;
  if (e.target.checked) selectedFarms.add(e.target.value);
  else selectedFarms.delete(e.target.value);
  renderFarms();
});
$("selectAll").addEventListener("change", (e) => {
  for (const f of filteredFarms()) {
    if (e.target.checked) selectedFarms.add(f.farmId);
    else selectedFarms.delete(f.farmId);
  }
  renderFarms();
});
$("confirmAllInput").addEventListener("input", updateReleaseButton);

// ---------------- 3. sign & release ----------------
$("pemInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  pemText = f ? await f.text() : null;
  updateReleaseButton();
});
$("passInput").addEventListener("input", updateReleaseButton);

function releaseProblems() {
  const p = fileProblems();
  if (mode() === "all") {
    if (!config?.farms.length) p.push("No farms");
    if ($("confirmAllInput").value.trim() !== versionValue()) p.push("Type the version again to confirm all farms");
  } else if (selectedFarmIds().length === 0) {
    p.push("Pick at least one farm");
  }
  if (!pemText) p.push("Choose the signing key file");
  return p;
}

function updateReleaseButton() {
  const problems = releaseProblems();
  $("releaseBtn").disabled = problems.length > 0;
  $("releaseBtn").title = problems.join("\n");
}

function setReleaseStatus(text, isError = false) {
  const el = $("releaseStatus");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

$("releaseBtn").addEventListener("click", async () => {
  const problems = releaseProblems();
  if (problems.length) { setReleaseStatus(problems[0], true); return; }
  const version = versionValue();
  const all = mode() === "all";
  const farmIds = selectedFarmIds();
  const what = all ? `ALL ${config.farms.length} farms` : `farm${farmIds.length > 1 ? "s" : ""} ${farmIds.join(", ")}`;
  const kind = PRODUCT_TEXT[product()];
  if (!confirm(isNode()
    ? `Send ${kind} firmware ${version} to the hub of ${what}? Each hub restarts once, then updates its ${kind.toLowerCase()}s.`
    : `Send firmware ${version} to ${what}?`)) return;

  $("releaseBtn").disabled = true;
  try {
    setReleaseStatus("Unlocking key…");
    const key = await loadSigningKey(pemText, $("passInput").value);
    setReleaseStatus("Signing…");
    const signature = await signRelease(key, config.publicKeyPem, fileInfo.sha256, fileInfo.size, version, product());

    setReleaseStatus("Uploading firmware…");
    const up = await api("/ota/firmware", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Firmware-Version": version, "X-Firmware-Product": product() },
      body: fileBytes
    });
    if (up.sha256 !== fileInfo.sha256) throw new Error("Server stored a different file than was signed - try again");

    setReleaseStatus("Sending to hubs…");
    const rel = await api("/ota/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: fileInfo.sha256, version, signature, product: product(), target: all ? "all" : { farmIds } })
    });

    // Don't keep the key material around.
    $("passInput").value = "";
    $("pemInput").value = "";
    pemText = null;
    $("confirmAllInput").value = "";
    setReleaseStatus(`Sent to ${rel.targets} hub${rel.targets > 1 ? "s" : ""} - watch the progress below.`);
    historyPage = 1;
    await loadHistory();
    openRelease(rel.releaseId);
  } catch (err) {
    setReleaseStatus(err.message, true);
  } finally {
    updateReleaseButton();
  }
});

// ---------------- progress ----------------
function openRelease(id) {
  currentReleaseId = id;
  $("progressCard").hidden = false;
  $("retryStatus").textContent = "";
  pollStartedAt = Date.now();
  refreshRelease();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshRelease, POLL_MS);
  $("progressCard").scrollIntoView({ behavior: "smooth" });
}

async function refreshRelease() {
  if (!currentReleaseId) return;
  try {
    const d = await api(`/ota/releases/${currentReleaseId}`);
    renderRelease(d);
    const ns = d.nodeSummary;
    // A node update keeps going long after the hubs have staged it.
    const busy = d.release.stoppedAt ? 0
      : d.summary.in_progress + d.summary.waiting + (ns ? ns.in_progress + (ns.total === 0 ? 1 : 0) : 0);
    if (busy === 0 || Date.now() - pollStartedAt > POLL_GIVE_UP_MS) clearInterval(pollTimer);
  } catch (err) {
    $("retryStatus").textContent = err.message;
  }
}

function renderRelease({ release, summary, targets, nodeSummary, nodes }) {
  const node = release.product && release.product !== "hub";
  $("progressTitle").textContent = `- #${release.id}, ${PRODUCT_TEXT[release.product] || "Hub"} ${release.version}, ${release.mode === "all" ? "all farms" : "selected farms"}, ${fmtTime(release.createdAt)}`;
  $("nodeSection").hidden = !node;
  if (node) renderNodes(release, nodeSummary, nodes || []);
  $("sumUpdated").textContent = summary.updated;
  $("sumProgress").textContent = summary.in_progress;
  $("sumWaiting").textContent = summary.waiting;
  $("sumBusy").textContent = summary.busy;
  $("sumFailed").textContent = summary.failed;
  $("targetBody").innerHTML = targets.map((t) => {
    // Over GSM the hub's one modem is busy with the download, so "starting"
    // is the last it says until it restarts on the new firmware (or reports
    // a failure) - show the time since then instead of a blank.
    const gsmDownloading = t.state === "starting" && t.transport === "gsm" && t.outcome === "in_progress";
    const pct = t.state === "downloading" && Number.isFinite(t.percent)
      ? `<span class="ota-bar"><span style="width:${Math.max(0, Math.min(100, t.percent))}%"></span></span> ${t.percent}%`
      : gsmDownloading ? `<span class="ota-bar indeterminate"><span></span></span> ${gsmElapsed(t.updatedAt)}`
      : t.outcome === "updated" ? "100%" : "";
    // In progress by its state, but no word for over 30 min (server: NO_REPLY_MS).
    const noReply = t.outcome === "waiting" && t.state !== "sent";
    const detail = t.error ? (ERROR_TEXT[t.error] || t.error)
      : noReply ? `No reply from the hub since ${fmtTime(t.updatedAt)} - it gave up or restarted. Use Resend.`
      : t.outcome === "updated" ? (node ? `Hub has ${esc(release.version)} for its units` : `Running ${esc(t.fwVersion || release.version)}`)
      : gsmDownloading ? "Over GSM - usually 3-6 min, no progress until it restarts" : "";
    const stateText = gsmDownloading ? "Downloading" : noReply ? "No reply" : STATE_TEXT[t.state] || t.state;
    return `<tr>
      <td>${esc(t.farmId)}</td>
      <td>${esc(t.nodeId)}</td>
      <td><span class="ota-pill ${t.outcome}">${esc(stateText)}</span></td>
      <td>${pct}</td>
      <td>${esc((t.transport || "").toUpperCase())}</td>
      <td>${esc(detail)}</td>
      <td>${t.attempts}</td>
      <td>${fmtTime(t.updatedAt)}</td>
    </tr>`;
  }).join("");
  const retryable = summary.waiting + summary.busy + summary.failed;
  $("retryBtn").disabled = retryable === 0 || Boolean(release.stoppedAt);
  // Node releases only - a hub update can't be stopped once sent.
  $("stopBtn").hidden = !node;
  $("stopBtn").textContent = release.stoppedAt ? "⏹ Send stop again" : "⏹ Stop handing out";
  $("stoppedNote").hidden = !release.stoppedAt;
  $("stoppedNote").textContent = release.stoppedAt
    ? `Stopped ${fmtTime(release.stoppedAt)} by ${release.stoppedBy || "-"}: the hubs were told to stop handing this firmware out. ` +
      "Units already updated stay updated; the rest keep their current firmware. A hub that was offline then didn't hear it - " +
      "press \"Send stop again\" once it's back online."
    : "";
}

function renderNodes(release, s, nodes) {
  $("nodeSummaryText").textContent = s && s.total
    ? `- ${s.updated} updated, ${s.in_progress} in progress, ${s.failed} failed`
    : "- none reporting yet (the hub hands it out a minute or so after staging)";
  $("nodeBody").innerHTML = nodes.length ? nodes.map((n) => {
    const pct = n.state === "receiving" && Number.isFinite(n.percent)
      ? `<span class="ota-bar"><span style="width:${Math.max(0, Math.min(100, n.percent))}%"></span></span> ${n.percent}%`
      : n.outcome === "updated" || n.state === "installed" ? "100%" : "";
    return `<tr>
      <td>${esc(n.farmId)}</td>
      <td>${esc(n.node)}</td>
      <td><span class="ota-pill ${n.outcome}">${esc(NODE_STATE_TEXT[n.state] || n.state)}</span></td>
      <td>${pct}</td>
      <td>${esc(n.version || "")}</td>
      <td>${esc(n.error ? (ERROR_TEXT[n.error] || n.error) : "")}</td>
      <td>${fmtTime(n.updatedAt)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7">No unit has reported yet</td></tr>`;
}

$("stopBtn").addEventListener("click", async () => {
  if (!currentReleaseId) return;
  if (!confirm("Tell this release's hubs to stop handing the firmware out to their units?\n\n" +
    "Units already updated stay updated. Units not updated yet (or part-way through) keep their current firmware. " +
    "The release can't be resumed - send a new one instead.")) return;
  $("stopBtn").disabled = true;
  try {
    const r = await api(`/ota/releases/${currentReleaseId}/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    });
    $("retryStatus").textContent = `Stop sent to ${r.stopped} hub${r.stopped === 1 ? "" : "s"}` +
      (r.skipped.length ? ` (skipped ${r.skipped.join(", ")} - a newer unit update was sent there since)` : "") + ".";
    await refreshRelease();
    loadHistory().catch(() => {});
  } catch (err) {
    $("retryStatus").textContent = err.message;
  } finally {
    $("stopBtn").disabled = false;
  }
});

$("retryBtn").addEventListener("click", async () => {
  if (!currentReleaseId || !confirm("Resend this update to every hub that isn't updated yet?")) return;
  try {
    const r = await api(`/ota/releases/${currentReleaseId}/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    });
    $("retryStatus").textContent = r.resent ? `Resent to ${r.resent} hub${r.resent > 1 ? "s" : ""}.` : "Nothing to resend.";
    openRelease(currentReleaseId);
  } catch (err) {
    $("retryStatus").textContent = err.message;
  }
});

// ---------------- history ----------------
const historySelected = new Set();   // release ids ticked for deletion, kept across pages
let historyShownIds = [];

async function loadHistory() {
  const product = $("historyProductFilter").value;
  const q = $("historySearch").value.trim();
  $("historyStatus").textContent = "";
  const d = await api(`/ota/releases?page=${historyPage}${product ? `&product=${encodeURIComponent(product)}` : ""}` +
    (q ? `&q=${encodeURIComponent(q)}` : ""));
  const { releases } = d;
  const total = Number.isFinite(d.total) ? d.total : releases.length;
  // Past the last page (the last rows on it were just deleted): go back one.
  if (releases.length === 0 && historyPage > 1 && total > 0) {
    historyPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return loadHistory();
  }
  historyShownIds = releases.map((r) => r.id);
  renderPager($("historyPager"), d.page || 1, Math.max(1, Math.ceil(total / PAGE_SIZE)), total, "releases",
    (p) => { historyPage = p; loadHistory().catch((err) => showPageError(err.message)); });
  updateHistorySelection();
  $("historyBody").innerHTML = releases.length ? releases.map((r) => {
    const s = r.summary;
    const n = r.nodeSummary;
    const result = n
      ? [`${n.updated}/${n.total} units updated`, n.failed && `${n.failed} failed`, n.in_progress && `${n.in_progress} in progress`,
        s.failed && `${s.failed} hub(s) failed to stage`].filter(Boolean).join(", ")
      : [`${s.updated}/${s.total} updated`, s.failed && `${s.failed} failed`, s.busy && `${s.busy} busy`,
        (s.waiting + s.in_progress) && `${s.waiting + s.in_progress} pending`].filter(Boolean).join(", ");
    const shown = r.stoppedAt ? `⏹ Stopped - ${result}` : result;
    return `<tr data-id="${r.id}">
      <td class="ota-check-col"><input type="checkbox" class="historyPick" value="${r.id}" ${historySelected.has(r.id) ? "checked" : ""}></td>
      <td>${r.id}</td><td>${esc(PRODUCT_TEXT[r.product] || "Hub")}</td><td>${esc(r.version)}</td><td>${r.mode === "all" ? "All farms" : `${s.total} farm${s.total > 1 ? "s" : ""}`}</td>
      <td>${esc(shown)}</td><td>${esc(r.createdBy || "-")}</td><td>${fmtTime(r.createdAt)}</td></tr>`;
  }).join("") : `<tr><td colspan="8">${q || product ? "No release matches" : "No releases yet"}</td></tr>`;
  updateHistorySelection();
}

function updateHistorySelection() {
  const n = historySelected.size;
  $("historyDeleteBtn").disabled = n === 0;
  $("historyDeleteBtn").textContent = n ? `🗑 Delete selected (${n})` : "🗑 Delete selected";
  $("historySelectAll").checked = historyShownIds.length > 0 && historyShownIds.every((id) => historySelected.has(id));
}

const reloadHistory = () => { historyPage = 1; loadHistory().catch((err) => showPageError(err.message)); };
$("historyProductFilter").addEventListener("change", reloadHistory);
let historySearchTimer = null;
$("historySearch").addEventListener("input", () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(reloadHistory, 350);
});
$("historySelectAll").addEventListener("change", (e) => {
  for (const id of historyShownIds) {
    if (e.target.checked) historySelected.add(id);
    else historySelected.delete(id);
  }
  document.querySelectorAll(".historyPick").forEach((c) => { c.checked = e.target.checked; });
  updateHistorySelection();
});
$("historyBody").addEventListener("click", (e) => {
  const pick = e.target.closest(".historyPick");
  if (pick) {
    const id = Number(pick.value);
    if (pick.checked) historySelected.add(id);
    else historySelected.delete(id);
    updateHistorySelection();
    return;   // ticking a row doesn't open it
  }
  if (e.target.closest(".ota-check-col")) return;
  const row = e.target.closest("tr[data-id]");
  if (row) openRelease(Number(row.dataset.id));
});
$("historyDeleteBtn").addEventListener("click", async () => {
  const ids = [...historySelected].sort((a, b) => a - b);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} release record${ids.length > 1 ? "s" : ""} (#${ids.join(", #")})?\n\n` +
    "Only the records go - hubs and units keep the firmware they run. A hub still downloading one of these " +
    "will fail the download and stay on its current firmware. This can't be undone.")) return;
  $("historyDeleteBtn").disabled = true;
  try {
    const r = await api("/ota/releases/delete", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids })
    });
    if (ids.includes(currentReleaseId)) {
      clearInterval(pollTimer);
      currentReleaseId = null;
      $("progressCard").hidden = true;
    }
    historySelected.clear();
    showPageError("");
    await loadHistory();
    $("historyStatus").textContent = `Deleted ${r.deleted} release record${r.deleted === 1 ? "" : "s"}.`;
  } catch (err) {
    showPageError(`Couldn't delete: ${err.message}`);
    updateHistorySelection();
  }
});
