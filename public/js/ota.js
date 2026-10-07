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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const product = () => $("productInput").value;
const isNode = () => product() !== "hub";
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : "-");

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
      hasKey: config ? bytesInclude(fileBytes, config.publicKeyPem) : false
    };
  }
  renderChecks();
  updateReleaseButton();
});
$("versionInput").addEventListener("input", () => { renderChecks(); updateReleaseButton(); });
$("productInput").addEventListener("change", () => {
  // Node updates go to selected farms only (each hub restarts to stage one).
  const allRadio = document.querySelector('input[name="mode"][value="all"]');
  allRadio.disabled = isNode();
  if (isNode() && allRadio.checked) document.querySelector('input[name="mode"][value="farms"]').checked = true;
  $("nodeNote").hidden = !isNode();
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
  if (config && fileInfo.size > config.maxFirmwareBytes) p.push(`Too big for the hub (${fileInfo.size} > ${config.maxFirmwareBytes} bytes)`);
  if (!fileInfo.hasKey) p.push("Doesn't contain the fleet's OTA public key - rebuild from the current repo");
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(versionValue())) p.push("Enter the version (same as FIRMWARE_VERSION in config.h)");
  return p;
}

function renderChecks() {
  const ul = $("binChecks");
  if (!fileInfo) { ul.innerHTML = ""; return; }
  const items = [
    [true, `${esc(fileInfo.name)} - ${(fileInfo.size / 1024).toFixed(0)} KB, SHA-256 <code>${fileInfo.sha256.slice(0, 16)}…</code>`],
    [fileInfo.isEsp, fileInfo.isEsp ? "ESP32 firmware image" : "Not an ESP32 firmware image"],
    [fileInfo.hasKey, fileInfo.hasKey ? "Contains the fleet's OTA public key" : "Does NOT contain the fleet's OTA public key - devices would refuse later updates"],
    [!config || fileInfo.size <= config.maxFirmwareBytes, "Fits the hub's app slot"]
  ];
  ul.innerHTML = items.map(([ok, text]) => `<li class="${ok ? "ok" : "bad"}">${text}</li>`).join("");
}

// ---------------- 2. targets ----------------
function renderFarms() {
  const q = $("farmSearch").value.trim().toLowerCase();
  const farms = (config?.farms || []).filter((f) =>
    !q || f.farmId.includes(q) || String(f.farmerName || "").toLowerCase().includes(q));
  const checked = new Set([...document.querySelectorAll(".farmPick:checked")].map((c) => c.value));
  $("farmBody").innerHTML = farms.length ? farms.map((f) => `
    <tr>
      <td><input type="checkbox" class="farmPick" value="${esc(f.farmId)}" ${checked.has(f.farmId) ? "checked" : ""} ${mode() === "all" ? "disabled" : ""}></td>
      <td>${esc(f.farmId)}</td>
      <td>${esc(f.farmerName || "-")}</td>
      <td><span class="vps-dot ${f.online ? "ok" : "down"}"></span> ${f.online ? "Online" : "Offline"}</td>
      <td>${esc(f.fwVersion || "-")}</td>
    </tr>`).join("") : `<tr><td colspan="5">No farms with a controller</td></tr>`;
  updateTargetNote();
}

function selectedFarmIds() {
  return [...document.querySelectorAll(".farmPick:checked")].map((c) => c.value);
}

function updateTargetNote() {
  const all = mode() === "all";
  $("confirmAllWrap").hidden = !all;
  const n = all ? (config?.farms.length || 0) : selectedFarmIds().length;
  const offline = all ? (config?.farms || []).filter((f) => !f.online).length : 0;
  $("targetNote").textContent = all
    ? `All ${n} farms. ${offline ? `${offline} are offline now - they'll show "Waiting"; resend to them later.` : ""}`
    : n ? `${n} farm${n > 1 ? "s" : ""} selected.` : "Tick the farm(s) to update - start with one hub.";
  updateReleaseButton();
}

$("farmSearch").addEventListener("input", renderFarms);
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", renderFarms));
$("farmBody").addEventListener("change", (e) => { if (e.target.classList.contains("farmPick")) updateTargetNote(); });
$("selectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".farmPick:not(:disabled)").forEach((c) => { c.checked = e.target.checked; });
  updateTargetNote();
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
    const busy = d.summary.in_progress + d.summary.waiting + (ns ? ns.in_progress + (ns.total === 0 ? 1 : 0) : 0);
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
    const pct = t.state === "downloading" && Number.isFinite(t.percent)
      ? `<span class="ota-bar"><span style="width:${Math.max(0, Math.min(100, t.percent))}%"></span></span> ${t.percent}%`
      : t.outcome === "updated" ? "100%" : "";
    const detail = t.error ? (ERROR_TEXT[t.error] || t.error) : t.outcome === "updated" ? `Running ${esc(t.fwVersion || release.version)}` : "";
    return `<tr>
      <td>${esc(t.farmId)}</td>
      <td>${esc(t.nodeId)}</td>
      <td><span class="ota-pill ${t.outcome}">${esc(STATE_TEXT[t.state] || t.state)}</span></td>
      <td>${pct}</td>
      <td>${esc((t.transport || "").toUpperCase())}</td>
      <td>${esc(detail)}</td>
      <td>${t.attempts}</td>
      <td>${fmtTime(t.updatedAt)}</td>
    </tr>`;
  }).join("");
  const retryable = summary.waiting + summary.busy + summary.failed;
  $("retryBtn").disabled = retryable === 0;
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
async function loadHistory() {
  const { releases } = await api("/ota/releases");
  $("historyBody").innerHTML = releases.length ? releases.map((r) => {
    const s = r.summary;
    const n = r.nodeSummary;
    const result = n
      ? [`${n.updated}/${n.total} units updated`, n.failed && `${n.failed} failed`, n.in_progress && `${n.in_progress} in progress`,
        s.failed && `${s.failed} hub(s) failed to stage`].filter(Boolean).join(", ")
      : [`${s.updated}/${s.total} updated`, s.failed && `${s.failed} failed`, s.busy && `${s.busy} busy`,
        (s.waiting + s.in_progress) && `${s.waiting + s.in_progress} pending`].filter(Boolean).join(", ");
    return `<tr data-id="${r.id}">
      <td>${r.id}</td><td>${esc(PRODUCT_TEXT[r.product] || "Hub")}</td><td>${esc(r.version)}</td><td>${r.mode === "all" ? "All farms" : `${s.total} farm${s.total > 1 ? "s" : ""}`}</td>
      <td>${esc(result)}</td><td>${esc(r.createdBy || "-")}</td><td>${fmtTime(r.createdAt)}</td></tr>`;
  }).join("") : `<tr><td colspan="7">No releases yet</td></tr>`;
}
$("historyBody").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (row) openRelease(Number(row.dataset.id));
});
