import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";

// Admin > Message Broadcast. Server side: server/src/bridge/announcements.js.
// Farmers read these in the Irrigo app under Notifications > Farm Buddie Official.

const PAGE_SIZE = 10;
const CAT = {
  general: { icon: "📢", label: "General" },
  update: { icon: "🔄", label: "Update" },
  reminder: { icon: "⏰", label: "Reminder" },
  offer: { icon: "🎁", label: "Offer" },
  alert: { icon: "⚠️", label: "Alert" }
};
// {version}, {date}, {time}... are blanks to fill in - the message can't be
// sent while one is left (see formProblem()).
const TEMPLATES = [
  {
    name: "Firmware update - master controller", category: "update", important: true,
    title: "Controller update to v{version} on {date}",
    body: "Your Farm Buddie master controller will be updated to firmware v{version} on {date}, {time}. During the update the controller restarts, and motors and valves cannot be controlled from the app. Please keep irrigation stopped during this time, and start it again once Maintenance shows firmware v{version}. Your settings and programs are kept.",
    titleTa: "கண்ட்ரோலர் அப்டேட் v{version} – {date}",
    bodyTa: "{date} அன்று {time} நேரத்தில் உங்கள் Farm Buddie மாஸ்டர் கண்ட்ரோலர் ஃபர்ம்வேர் v{version}-க்கு அப்டேட் செய்யப்படும். அப்டேட்டின் போது கண்ட்ரோலர் மறுதொடக்கம் ஆகும்; அந்த நேரத்தில் செயலியிலிருந்து மோட்டார் மற்றும் வால்வுகளை இயக்க முடியாது. தயவுசெய்து இந்த நேரத்தில் பாசனத்தை நிறுத்தி வைக்கவும்; Maintenance-இல் ஃபர்ம்வேர் v{version} என காட்டிய பின் மீண்டும் தொடங்கவும். உங்கள் அமைப்புகள் மற்றும் புரோகிராம்கள் மாறாது."
  },
  {
    name: "Firmware update - motor nodes", category: "update", important: true,
    title: "Motor node update to v{version} on {date}",
    body: "The motor nodes on your farm (Motor 2, Motor 3) will be updated to firmware v{version} on {date}, {time}. Each node restarts once during the update, and that motor cannot be controlled until it is back. Please keep irrigation on these motors stopped during this time, and start it again after the update. Your settings and programs are kept.",
    titleTa: "மோட்டார் நோடு அப்டேட் v{version} – {date}",
    bodyTa: "{date} அன்று {time} நேரத்தில் உங்கள் பண்ணையின் மோட்டார் நோடுகள் (Motor 2, Motor 3) ஃபர்ம்வேர் v{version}-க்கு அப்டேட் செய்யப்படும். அப்டேட்டின் போது ஒவ்வொரு நோடும் ஒருமுறை மறுதொடக்கம் ஆகும்; அது திரும்பும் வரை அந்த மோட்டாரை இயக்க முடியாது. தயவுசெய்து இந்த நேரத்தில் அந்த மோட்டார்களின் பாசனத்தை நிறுத்தி வைக்கவும்; அப்டேட் முடிந்த பின் மீண்டும் தொடங்கவும். உங்கள் அமைப்புகள் மற்றும் புரோகிராம்கள் மாறாது."
  },
  {
    name: "Firmware update - master and motor nodes", category: "update", important: true,
    title: "Farm Buddie firmware update on {date}",
    body: "Your Farm Buddie master controller (to v{version}) and motor nodes (to v{node_version}) will be updated on {date}, {time}. They restart during the update, and motors and valves cannot be controlled from the app. Please keep all irrigation stopped during this time, and start it again once Maintenance shows firmware v{version}. Your settings and programs are kept.",
    titleTa: "Farm Buddie ஃபர்ம்வேர் அப்டேட் – {date}",
    bodyTa: "{date} அன்று {time} நேரத்தில் உங்கள் Farm Buddie மாஸ்டர் கண்ட்ரோலர் v{version}-க்கும், மோட்டார் நோடுகள் v{node_version}-க்கும் அப்டேட் செய்யப்படும். அப்டேட்டின் போது அவை மறுதொடக்கம் ஆகும்; அந்த நேரத்தில் செயலியிலிருந்து மோட்டார் மற்றும் வால்வுகளை இயக்க முடியாது. தயவுசெய்து இந்த நேரத்தில் எல்லா பாசனத்தையும் நிறுத்தி வைக்கவும்; Maintenance-இல் ஃபர்ம்வேர் v{version} என காட்டிய பின் மீண்டும் தொடங்கவும். உங்கள் அமைப்புகள் மற்றும் புரோகிராம்கள் மாறாது."
  },
  {
    name: "Irrigo app update", category: "update",
    title: "New Irrigo app update available",
    body: "A new version of the Irrigo app is ready on the Play Store with improvements and fixes. Please open the Play Store and tap Update.",
    titleTa: "புதிய Irrigo செயலி அப்டேட்",
    bodyTa: "Irrigo செயலியின் புதிய பதிப்பு Play Store-இல் தயாராக உள்ளது. Play Store-ஐ திறந்து Update அழுத்தவும்."
  },
  {
    name: "Service visit", category: "reminder",
    title: "Farm Buddie service visit",
    body: "Our service team will visit your farm this week for a free check-up of your starter and valves. Please keep the panel accessible.",
    titleTa: "Farm Buddie சேவை வருகை",
    bodyTa: "இந்த வாரம் எங்கள் சேவை குழு உங்கள் பண்ணைக்கு வந்து ஸ்டார்டர் மற்றும் வால்வுகளை இலவசமாக சரிபார்க்கும். பேனலை அணுகக்கூடியதாக வைத்திருக்கவும்."
  },
  {
    name: "SIM / data renewal", category: "reminder",
    title: "SIM renewal reminder",
    body: "The data plan for your Farm Buddie controller is due for renewal soon. Please contact us to keep your motor connected.",
    titleTa: "SIM புதுப்பிப்பு நினைவூட்டல்",
    bodyTa: "உங்கள் Farm Buddie கண்ட்ரோலரின் டேட்டா திட்டம் விரைவில் புதுப்பிக்கப்பட வேண்டும். மோட்டார் இணைப்பை தொடர எங்களை தொடர்பு கொள்ளவும்."
  },
  {
    name: "Power cut advisory", category: "alert",
    title: "Planned power shutdown",
    body: "TNEB has announced a planned power shutdown in your area. Your motor will stop during the outage and the controller will alert you when power returns.",
    titleTa: "திட்டமிட்ட மின்தடை",
    bodyTa: "உங்கள் பகுதியில் திட்டமிட்ட மின்தடையை TNEB அறிவித்துள்ளது. மின்தடையின் போது மோட்டார் நின்றுவிடும்; மின்சாரம் வந்ததும் கண்ட்ரோலர் தெரிவிக்கும்."
  },
  {
    name: "Festival greetings", category: "general",
    title: "Happy Pongal from Farm Buddie!",
    body: "Wishing you and your family a happy and prosperous Pongal. Thank you for growing with Farm Buddie.",
    titleTa: "Farm Buddie வழங்கும் பொங்கல் வாழ்த்துகள்!",
    bodyTa: "உங்களுக்கும் உங்கள் குடும்பத்தினருக்கும் இனிய பொங்கல் நல்வாழ்த்துகள். Farm Buddie உடன் வளர்வதற்கு நன்றி."
  }
];

let audience = null;            // { farms, totals, limits }
const selected = new Set();     // farmIds, kept across pages and filters
let farmPage = 1;
let historyPage = 1;
let previewLang = "en";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
const fmtTime = (t) => (t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "-");

async function api(path, options = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showMsg(kind, msg) {
  $("pageError").hidden = true;
  $("pageOk").hidden = true;
  if (!msg) return;
  const el = kind === "ok" ? $("pageOk") : $("pageError");
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------- init ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }
  try {
    audience = await api("/broadcast/audience");
    $("totFarms").textContent = audience.totals.farms;
    $("totPhones").textContent = audience.totals.phones;
    $("totDevices").textContent = audience.totals.devices;
    renderFarms();
    renderReach();
  } catch (err) {
    showMsg("error", `Couldn't load the farmer list: ${err.message}`);
  }
  loadHistory();
});

$("logoutBtn")?.addEventListener("click", () => signOut(auth).then(() => window.location.replace("/login.html")));

// ---------------- 1. compose ----------------
$("templateSelect").innerHTML += TEMPLATES.map((t, i) => `<option value="${i}">${CAT[t.category].icon} ${esc(t.name)}</option>`).join("");
$("templateSelect").addEventListener("change", (e) => {
  const t = TEMPLATES[e.target.value];
  if (!t) return;
  document.querySelector(`input[name="cat"][value="${t.category}"]`).checked = true;
  $("titleInput").value = t.title;
  $("bodyInput").value = t.body;
  $("titleTaInput").value = t.titleTa;
  $("bodyTaInput").value = t.bodyTa;
  $("tamilToggle").checked = true;
  $("tamilFields").hidden = false;
  $("importantToggle").checked = !!t.important;
  refreshCompose();
});

$("tamilToggle").addEventListener("change", (e) => {
  $("tamilFields").hidden = !e.target.checked;
  if (!e.target.checked) setPreviewLang("en");
  refreshCompose();
});
["titleInput", "bodyInput", "titleTaInput", "bodyTaInput", "importantToggle"].forEach((id) => $(id).addEventListener("input", refreshCompose));
document.querySelectorAll('input[name="cat"]').forEach((r) => r.addEventListener("change", refreshCompose));
$("previewLang").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lang]");
  if (b) setPreviewLang(b.dataset.lang);
});

function setPreviewLang(lang) {
  previewLang = lang;
  $("previewLang").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  refreshCompose();
}

function tamilOn() {
  return $("tamilToggle").checked && $("bodyTaInput").value.trim() !== "";
}

function refreshCompose() {
  const limits = audience?.limits || { title: 80, body: 1000 };
  const count = (inputId, outId, max) => {
    const n = $(inputId).value.length;
    $(outId).textContent = `${n} / ${max}`;
    $(outId).classList.toggle("near", n > max * 0.9);
  };
  count("titleInput", "titleCount", limits.title);
  count("bodyInput", "bodyCount", limits.body);
  count("titleTaInput", "titleTaCount", limits.title);
  count("bodyTaInput", "bodyTaCount", limits.body);

  const cat = CAT[radio("cat")];
  const ta = previewLang === "ta" && tamilOn();
  const title = (ta ? $("titleTaInput").value.trim() || $("titleInput").value.trim() : $("titleInput").value.trim());
  const body = ta ? $("bodyTaInput").value.trim() : $("bodyInput").value.trim();
  $("previewChip").textContent = `${cat.icon} ${cat.label}`;
  $("previewChip").className = `bc-chip ${radio("cat")}`;
  $("previewTitle").textContent = title || "Your title";
  $("previewBody").textContent = body || (ta ? "Tamil message appears here." : "Your message appears here.");
  $("previewCard").classList.toggle("important", $("importantToggle").checked);
  updateSendButton();
}

// ---------------- 2. recipients ----------------
document.querySelectorAll('input[name="audience"]').forEach((r) => r.addEventListener("change", () => {
  $("farmPicker").hidden = radio("audience") !== "farms";
  renderReach();
  updateSendButton();
}));
["farmSearch", "onlineFilter", "appFilter"].forEach((id) => $(id).addEventListener("input", () => { farmPage = 1; renderFarms(); }));
$("clearSelection").addEventListener("click", () => { selected.clear(); renderFarms(); renderReach(); updateSendButton(); });

function filteredFarms() {
  const q = $("farmSearch").value.trim().toLowerCase();
  const online = $("onlineFilter").value;
  const app = $("appFilter").value;
  return (audience?.farms || []).filter((f) =>
    (!q || [f.farmId, f.farmerName, f.farmBuddieId, f.location].some((v) => String(v || "").toLowerCase().includes(q))) &&
    (!online || (online === "online") === !!f.online) &&
    (!app || (app === "yes") === f.devices > 0));
}

function renderFarms() {
  const list = filteredFarms();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  farmPage = Math.min(farmPage, totalPages);
  const rows = list.slice((farmPage - 1) * PAGE_SIZE, farmPage * PAGE_SIZE);
  $("farmBody").innerHTML = rows.length ? rows.map((f) => `
    <tr class="${f.active ? "" : "inactive-row"}">
      <td><input type="checkbox" data-farm="${esc(f.farmId)}" ${selected.has(f.farmId) ? "checked" : ""}></td>
      <td><b>${esc(f.farmId)}</b></td>
      <td>${esc(f.farmerName || "-")}${f.active ? "" : ' <span class="ota-pill">inactive</span>'}</td>
      <td>${esc(f.farmBuddieId || "-")}</td>
      <td>${esc(f.location || "-")}</td>
      <td>${f.online ? '<span class="ota-pill updated">Online</span>' : '<span class="ota-pill">Offline</span>'}</td>
      <td>${f.phones}</td>
      <td>${f.devices ? f.devices : '<span class="bc-warn" title="No phone of this farm has the app with notifications - they will see it when they open the app">0</span>'}</td>
    </tr>`).join("") : `<tr><td colspan="8">No farms match.</td></tr>`;
  $("selectAll").checked = rows.length > 0 && rows.every((f) => selected.has(f.farmId));
  renderPager($("farmPager"), farmPage, totalPages, list.length, "farms", (p) => { farmPage = p; renderFarms(); });
}

$("farmBody").addEventListener("change", (e) => {
  const id = e.target.dataset.farm;
  if (!id) return;
  e.target.checked ? selected.add(id) : selected.delete(id);
  renderFarms();
  renderReach();
  updateSendButton();
});
$("selectAll").addEventListener("change", (e) => {
  const list = filteredFarms().slice((farmPage - 1) * PAGE_SIZE, farmPage * PAGE_SIZE);
  list.forEach((f) => (e.target.checked ? selected.add(f.farmId) : selected.delete(f.farmId)));
  renderFarms();
  renderReach();
  updateSendButton();
});

// Phones / installs are counted per farm, so a phone on two chosen farms
// shows up twice here - the server counts each phone once when it sends.
function renderReach() {
  if (!audience) return;
  if (radio("audience") === "all") {
    $("reachLine").innerHTML = `Reaches <b>all ${audience.totals.farms} farms</b> · <b>${audience.totals.phones}</b> farmer phones ·
      <b>${audience.totals.devices}</b> get a notification now`;
    return;
  }
  const farms = audience.farms.filter((f) => selected.has(f.farmId));
  const phones = farms.reduce((s, f) => s + f.phones, 0);
  const devices = farms.reduce((s, f) => s + f.devices, 0);
  $("reachLine").innerHTML = farms.length
    ? `<b>${farms.length}</b> farm${farms.length > 1 ? "s" : ""} selected · about <b>${phones}</b> phones ·
       <b>${devices}</b> get a notification now
       <span class="bc-selected">${farms.slice(0, 12).map((f) => `<span>${esc(f.farmId)} ${esc(f.farmerName || "")}</span>`).join("")}${farms.length > 12 ? `<span>+${farms.length - 12} more</span>` : ""}</span>`
    : `<span class="ota-muted">Tick the farms to send to.</span>`;
}

// ---------------- 3. delivery ----------------
document.querySelectorAll('input[name="when"]').forEach((r) => r.addEventListener("change", () => {
  $("sendAtWrap").hidden = radio("when") !== "later";
  if (radio("when") === "later" && !$("sendAtInput").value) {
    const t = new Date(Date.now() + 60 * 60 * 1000);
    t.setMinutes(0, 0, 0);
    $("sendAtInput").value = toLocalInput(t);
  }
  updateSendButton();
}));
$("sendAtInput").addEventListener("input", updateSendButton);

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formProblem() {
  if (!$("titleInput").value.trim()) return "Add a title";
  if (!$("bodyInput").value.trim()) return "Write the message";
  const fields = ["titleInput", "bodyInput"].concat($("tamilToggle").checked ? ["titleTaInput", "bodyTaInput"] : []);
  const blank = fields.map((id) => $(id).value.match(/\{[a-z_]+\}/)).find(Boolean);
  if (blank) return `Fill in ${blank[0]} (in English and Tamil)`;
  if ($("tamilToggle").checked && $("titleTaInput").value.trim() && !$("bodyTaInput").value.trim()) return "Add the Tamil message too";
  if (radio("audience") === "farms" && selected.size === 0) return "Select at least one farm";
  if (radio("when") === "later") {
    const t = new Date($("sendAtInput").value);
    if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() + 60 * 1000) return "Pick a send time in the future";
  }
  return null;
}

function updateSendButton() {
  const problem = formProblem();
  $("sendBtn").disabled = !!problem;
  $("sendBtn").textContent = radio("when") === "later" ? "⏰ Schedule message" : "📢 Send message";
  $("sendStatus").textContent = problem || "";
  $("sendStatus").className = "ota-status-text";
}

$("sendBtn").addEventListener("click", async () => {
  if (formProblem()) return;
  const all = radio("audience") === "all";
  const later = radio("when") === "later";
  const who = all ? `ALL ${audience?.totals.farms ?? ""} farms` : `${selected.size} selected farm${selected.size > 1 ? "s" : ""}`;
  const when = later ? `at ${new Date($("sendAtInput").value).toLocaleString()}` : "now";
  if (!confirm(`Send "${$("titleInput").value.trim()}" to ${who} ${when}?`)) return;

  const body = {
    category: radio("cat"),
    title: $("titleInput").value,
    body: $("bodyInput").value,
    titleTa: $("tamilToggle").checked ? $("titleTaInput").value : "",
    bodyTa: $("tamilToggle").checked ? $("bodyTaInput").value : "",
    important: $("importantToggle").checked,
    audience: all ? "all" : "farms",
    farmIds: all ? undefined : [...selected],
    sendAt: later ? new Date($("sendAtInput").value).toISOString() : null,
    expiresAt: $("expiresAtInput").value ? new Date($("expiresAtInput").value).toISOString() : null
  };
  $("sendBtn").disabled = true;
  $("sendStatus").textContent = later ? "Scheduling…" : "Sending…";
  try {
    const r = await api("/broadcast/announcements", { method: "POST", body: JSON.stringify(body) });
    if (r.scheduled) {
      showMsg("ok", `⏰ Message #${r.id} scheduled for ${new Date(r.sendAt).toLocaleString()}.`);
    } else {
      const d = r.delivery || {};
      showMsg("ok", `✅ Message #${r.id} sent to ${d.targetFarms ?? "?"} farms · ${d.targetPhones ?? "?"} phones · ` +
        `notification delivered to ${d.pushOk ?? 0} app install${d.pushOk === 1 ? "" : "s"}` +
        (d.pushFailed ? ` (${d.pushFailed} failed - those see it when they open the app)` : "") + ".");
    }
    resetForm();
    historyPage = 1;
    loadHistory();
  } catch (err) {
    $("sendStatus").textContent = err.message;
    $("sendStatus").className = "ota-status-text error";
    $("sendBtn").disabled = false;
  }
});

function resetForm() {
  ["titleInput", "bodyInput", "titleTaInput", "bodyTaInput", "expiresAtInput", "sendAtInput"].forEach((id) => { $(id).value = ""; });
  $("templateSelect").value = "";
  $("importantToggle").checked = false;
  document.querySelector('input[name="when"][value="now"]').checked = true;
  $("sendAtWrap").hidden = true;
  refreshCompose();
}

// ---------------- history ----------------
$("historyFilter").addEventListener("change", () => { historyPage = 1; loadHistory(); });

const historySelected = new Set();   // message ids ticked for deletion, kept across pages
let historyShownIds = [];

async function loadHistory() {
  try {
    const status = $("historyFilter").value;
    const r = await api(`/broadcast/announcements?page=${historyPage}${status ? `&status=${status}` : ""}`);
    // Past the last page (its last rows were just deleted): go back one.
    if (r.items.length === 0 && historyPage > 1 && r.total > 0) {
      historyPage = Math.max(1, Math.ceil(r.total / r.pageSize));
      return loadHistory();
    }
    if (!status) $("totSent").textContent = r.total;
    historyShownIds = r.items.map((a) => a.id);
    $("historyBody").innerHTML = r.items.length ? r.items.map(historyRow).join("") : `<tr><td colspan="10">No messages yet.</td></tr>`;
    renderPager($("historyPager"), r.page, Math.max(1, Math.ceil(r.total / r.pageSize)), r.total, "messages", (p) => { historyPage = p; loadHistory(); });
  } catch (err) {
    $("historyBody").innerHTML = `<tr><td colspan="10">Couldn't load: ${esc(err.message)}</td></tr>`;
  }
  updateHistorySelection();
}

function updateHistorySelection() {
  const n = historySelected.size;
  $("historyDeleteBtn").disabled = n === 0;
  $("historyDeleteBtn").textContent = n ? `🗑 Delete selected (${n})` : "🗑 Delete selected";
  $("historySelectAll").checked = historyShownIds.length > 0 && historyShownIds.every((id) => historySelected.has(id));
}

$("historySelectAll").addEventListener("change", (e) => {
  for (const id of historyShownIds) {
    if (e.target.checked) historySelected.add(id);
    else historySelected.delete(id);
  }
  document.querySelectorAll(".historyPick").forEach((c) => { c.checked = e.target.checked; });
  updateHistorySelection();
});

$("historyDeleteBtn").addEventListener("click", async () => {
  const ids = [...historySelected].sort((a, b) => a - b);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} message${ids.length > 1 ? "s" : ""} (#${ids.join(", #")}) for good?\n\n` +
    "They disappear from this list AND from every farmer's app. A notification already shown on a phone " +
    "can't be taken back. This can't be undone.")) return;
  $("historyDeleteBtn").disabled = true;
  try {
    const r = await api("/broadcast/announcements/delete", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids })
    });
    historySelected.clear();
    showMsg("ok", `Deleted ${r.deleted} message${r.deleted === 1 ? "" : "s"}.`);
    loadHistory();
  } catch (err) {
    showMsg("error", `Couldn't delete: ${err.message}`);
    updateHistorySelection();
  }
});

function historyRow(a) {
  const cat = CAT[a.category] || CAT.general;
  const to = a.audience === "all" ? "All farmers" : `${(a.farmIds || []).length} farm${(a.farmIds || []).length === 1 ? "" : "s"}`;
  const when = a.status === "scheduled" ? `⏰ ${fmtTime(a.sendAt)}` : fmtTime(a.sentAt);
  const notified = a.status === "scheduled" ? "-" : `${a.pushOk ?? 0}${a.pushFailed ? ` <small class="bc-warn">(${a.pushFailed} failed)</small>` : ""}`;
  const pct = a.targetPhones ? Math.round((a.readCount / a.targetPhones) * 100) : 0;
  const read = a.status === "scheduled" ? "-"
    : `<span class="ota-bar"><span style="width:${Math.min(100, pct)}%"></span></span> ${a.readCount}/${a.targetPhones ?? 0}`;
  const status = a.status === "recalled" ? ' <span class="ota-pill failed">Recalled</span>'
    : a.status === "scheduled" ? ' <span class="ota-pill in_progress">Scheduled</span>' : "";
  return `<tr data-id="${a.id}" class="${a.status === "recalled" ? "inactive-row" : ""}">
    <td class="ota-check-col"><input type="checkbox" class="historyPick" value="${a.id}" ${historySelected.has(a.id) ? "checked" : ""}></td>
    <td>${a.id}</td>
    <td>${cat.icon} ${cat.label}</td>
    <td class="bc-title-cell">${a.important ? "⭐ " : ""}${esc(a.title)}${status}</td>
    <td>${to}</td>
    <td>${when}</td>
    <td>${notified}</td>
    <td>${read}</td>
    <td>${esc((a.createdBy || "").split("@")[0])}</td>
    <td>${a.status !== "recalled" ? `<button class="bc-link danger" data-recall="${a.id}">${a.status === "scheduled" ? "Cancel" : "Recall"}</button>` : ""}</td>
  </tr>`;
}

$("historyBody").addEventListener("click", async (e) => {
  const pick = e.target.closest(".historyPick");
  if (pick) {
    const id = Number(pick.value);
    if (pick.checked) historySelected.add(id);
    else historySelected.delete(id);
    updateHistorySelection();
    return;   // ticking a row doesn't open it
  }
  if (e.target.closest(".ota-check-col")) return;
  const recall = e.target.closest("button[data-recall]");
  if (recall) {
    e.stopPropagation();
    if (!confirm("Remove this message from every farmer's app? (A notification already shown on a phone can't be taken back.)")) return;
    try {
      await api(`/broadcast/announcements/${recall.dataset.recall}`, { method: "DELETE" });
      showMsg("ok", `Message #${recall.dataset.recall} recalled.`);
      loadHistory();
    } catch (err) {
      showMsg("error", err.message);
    }
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openDetail(row.dataset.id);
});

async function openDetail(id) {
  $("detailContent").innerHTML = "Loading…";
  $("detailModal").hidden = false;
  try {
    const a = await api(`/broadcast/announcements/${id}`);
    const cat = CAT[a.category] || CAT.general;
    const farms = a.audience === "all" ? "All farmers" : (a.farmIds || []).map((f) => {
      const farm = audience?.farms.find((x) => x.farmId === f);
      return `<span>${esc(f)} ${esc(farm?.farmerName || "")}</span>`;
    }).join("");
    $("detailContent").innerHTML = `
      <div class="bc-detail-head"><span class="bc-chip ${esc(a.category)}">${cat.icon} ${cat.label}</span>
        ${a.important ? '<span class="ota-pill busy">⭐ Important</span>' : ""}
        <span class="ota-pill ${a.status === "recalled" ? "failed" : a.status === "scheduled" ? "in_progress" : "updated"}">${esc(a.status)}</span></div>
      <h3>${esc(a.title)}</h3>
      <p class="bc-detail-body">${esc(a.body)}</p>
      ${a.bodyTa ? `<h4 lang="ta">${esc(a.titleTa || a.title)}</h4><p class="bc-detail-body" lang="ta">${esc(a.bodyTa)}</p>` : ""}
      <div class="bc-detail-grid">
        <div><p>Sent</p><b>${a.sentAt ? fmtTime(a.sentAt) : `Scheduled ${fmtTime(a.sendAt)}`}</b></div>
        <div><p>Farms</p><b>${a.targetFarms ?? "-"}</b></div>
        <div><p>Phones</p><b>${a.targetPhones ?? "-"}</b></div>
        <div><p>Notified</p><b>${a.pushOk ?? "-"}</b></div>
        <div><p>Read</p><b>${a.readCount}</b></div>
        <div><p>Shown until</p><b>${a.expiresAt ? fmtTime(a.expiresAt) : "Always"}</b></div>
      </div>
      <p class="ota-muted">By ${esc(a.createdBy || "-")}${a.deletedAt ? ` · recalled ${fmtTime(a.deletedAt)} by ${esc(a.deletedBy || "-")}` : ""}</p>
      <h4>To</h4><div class="bc-selected">${a.audience === "all" ? "<span>All farmers</span>" : farms}</div>
      <h4>Read by (${a.reads.length})</h4>
      ${a.reads.length ? `<table class="fb-table"><thead><tr><th>Phone</th><th>Farm</th><th>Read</th></tr></thead><tbody>
        ${a.reads.map((r) => `<tr><td>${esc(r.phone)}</td><td>${r.farms.map((f) => `${esc(f.farmId)} ${esc(f.farmerName || "")}`).join(", ") || "-"}</td><td>${fmtTime(r.readAt)}</td></tr>`).join("")}
      </tbody></table>` : '<p class="ota-muted">Nobody has opened it yet.</p>'}`;
  } catch (err) {
    $("detailContent").textContent = `Couldn't load: ${err.message}`;
  }
}
$("detailClose").addEventListener("click", () => { $("detailModal").hidden = true; });
$("detailModal").addEventListener("click", (e) => { if (e.target.id === "detailModal") $("detailModal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("detailModal").hidden = true; });

// One button per page, with "…" gaps for long lists - same as the OTA page.
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

refreshCompose();
