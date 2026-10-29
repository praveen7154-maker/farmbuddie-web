// User Roles (admin panel) - the team accounts: the production team (the
// Production page only) and the onboarding team (Farmer Onboarding, Add
// Farm, Edit Farm, Farmer Database). Both sign in on the normal login page
// with a username. The server keeps the accounts and does every check
// (server/src/bridge/production.js, /team-users); admins only.
import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { BRIDGE_BASE_URL } from "/js/config.js";
import { fmtTime, fmtDate } from "/js/time-format.js";

const shell = window.FBShell;
const icon = shell.icon;
const esc = shell.esc;
const $ = (id) => document.getElementById(id);
const TEAMS = {
  production: { name: "Production team", one: "production team member", where: "the Production page" },
  onboarding: { name: "Onboarding team", one: "onboarding team member", where: "Farmer Onboarding, Add Farm, Edit Farm and Farmer Database" }
};
const USER_RE = /^[a-z][a-z0-9._-]{2,31}$/;

document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

let getToken;
let started = false;
onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("/login.html"); return; }
  getToken = () => user.getIdToken();
  if (!started) { started = true; start(); }
});
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(BRIDGE_BASE_URL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
  return data;
}

let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("pdToast");
  t.className = `pd-toast show ${kind}`;
  t.innerHTML = icon(kind === "ok" ? "circle-check" : "circle-alert") + `<span>${esc(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}

// ---------------------------------------------------------------- start
let users = [];
async function start() {
  for (const team of Object.keys(TEAMS)) setupForm(team);
  setupPopup();
  setupPassword();
  setupDelete();
  const ok = await loadUsers();
  if (ok === "forbidden") {
    $("ur").innerHTML = `<div class="pd-card pd-blocked">${icon("circle-alert")}<div><b>User Roles isn't available</b><p>Only an admin can manage team accounts.</p></div></div>`;
    return;
  }
  $("ur").removeAttribute("aria-busy");
}

async function loadUsers() {
  try {
    users = (await api("/team-users")).users;
  } catch (err) {
    if (err.status === 403) return "forbidden";
    toast("Couldn't load the teams: " + err.message, "bad");
    return false;
  }
  const of = (t) => users.filter((u) => u.team === t);
  for (const team of Object.keys(TEAMS)) {
    document.querySelector(`[data-badge="${team}"]`).textContent = of(team).length;
  }
  $("urCountProduction").textContent = of("production").length;
  $("urCountOnboarding").textContent = of("onboarding").length;
  $("urCountOff").textContent = users.filter((u) => !u.active).length;
  if (!$("urTeamModal").hidden) renderUsers();
  return true;
}

// ---------------------------------------------------------------- create
function makePassword() {
  // Easy to read out and type: no 0/O/1/l/I.
  const L = "abcdefghjkmnpqrstuvwxyz", U = "ABCDEFGHJKLMNPQRSTUVWXYZ", D = "23456789";
  const r = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  return `${r(U)}${r(L)}${r(L)}${r(L)}-${r(D)}${r(D)}${r(D)}${r(D)}-${r(U)}${r(L)}`;
}
const suggestUsername = (name) => {
  const parts = name.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0] + (parts[1] ? "." + parts[1][0] : "")).slice(0, 32);
};

function setupForm(team) {
  const form = document.querySelector(`[data-form="${team}"]`);
  const placeholder = team === "production" ? ["Murugan", "murugan"] : ["Priya", "priya"];
  form.innerHTML = `
    <label><span>Name</span><input data-f="name" placeholder="${placeholder[0]}" maxlength="60"></label>
    <label><span>Username <small data-f="state"></small></span><input data-f="user" placeholder="${placeholder[1]}" maxlength="32" autocapitalize="none" spellcheck="false"></label>
    <label><span>Password</span>
      <span class="pd-pw">
        <input data-f="pass" type="password" placeholder="at least 8 characters" autocomplete="new-password">
        <button type="button" class="pd-icon-btn" data-f="show" aria-label="Show password">${icon("eye")}</button>
        <button type="button" class="pd-icon-btn" data-f="gen" aria-label="Make a password" title="Make a strong password">${icon("wand-sparkles")}</button>
      </span>
    </label>
    <button type="submit" class="pd-btn pd-btn-primary">${icon("plus")}Create</button>`;
  const f = (k) => form.querySelector(`[data-f="${k}"]`);
  const msg = document.querySelector(`[data-msg="${team}"]`);
  let userEdited = false;
  const userState = () => {
    const s = f("state"), v = f("user").value;
    if (!v) { s.textContent = ""; s.className = ""; return; }
    if (!USER_RE.test(v)) { s.textContent = "3-32, a-z 0-9 . _ -"; s.className = "bad"; return; }
    const taken = users.some((u) => u.username === v);
    s.textContent = taken ? "taken" : "available";
    s.className = taken ? "bad" : "ok";
  };
  f("name").addEventListener("input", () => { if (!userEdited) { f("user").value = suggestUsername(f("name").value); userState(); } });
  f("user").addEventListener("input", () => { userEdited = true; f("user").value = f("user").value.toLowerCase().replace(/\s/g, ""); userState(); });
  f("gen").addEventListener("click", () => { f("pass").value = makePassword(); f("pass").type = "text"; });
  f("show").addEventListener("click", () => { f("pass").type = f("pass").type === "password" ? "text" : "password"; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    const body = { team, name: f("name").value.trim(), username: f("user").value.trim(), password: f("pass").value };
    if (!body.name) { msg.textContent = "Enter the person's name"; f("name").focus(); return; }
    if (!USER_RE.test(body.username)) { msg.textContent = "Username: 3-32 characters, starting with a letter - letters, digits, . _ -"; f("user").focus(); return; }
    if (users.some((u) => u.username === body.username)) { msg.textContent = `"${body.username}" is already taken`; f("user").focus(); return; }
    if (body.password.length < 8) { msg.textContent = "Password: at least 8 characters (the wand makes one)"; f("pass").focus(); return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("/team-users", { method: "POST", body });
      form.reset();
      userEdited = false;
      f("state").textContent = "";
      freshCreds.set(body.username, body.password);
      await loadUsers();
      openTeam(team, body.username);           // the popup, on the new person, with their sign-in
      toast(`${body.name} can sign in now`);
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- popup
// Sign-in details of people created / given a new password on this page.
// Passwords are kept only as hashes on the server, so this is the only
// place they can be read back - until this page is closed.
const freshCreds = new Map();   // username -> password
const signInText = (u, pw) => `Farm Buddie sign-in\n${location.origin}/login.html\nUsername: ${u}` + (pw ? `\nPassword: ${pw}` : "");
let popupTeam = "production";

function setupPopup() {
  const modal = $("urTeamModal");
  const close = () => { modal.hidden = true; };
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openTeam(b.dataset.open)));
  $("urTeamClose").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
  $("urTeamSearch").addEventListener("input", () => renderUsers());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden && $("urPwModal").hidden && $("urDelModal").hidden) close();
  });
  $("urUsers").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const u = users.find((x) => x.username === b.dataset.user);
    if (!u) return;
    const act = b.dataset.act;
    if (act === "copy") {
      const pw = freshCreds.get(u.username);
      navigator.clipboard?.writeText(signInText(u.username, pw)).then(
        () => toast(pw ? `Copied ${u.name}'s sign-in` : "Copied the link and username - the password can't be shown again: use Password to set a new one"),
        () => toast("Couldn't copy - select and copy by hand", "bad"));
    } else if (act === "password") {
      openPassword(u);
    } else if (act === "active") {
      const on = !u.active;
      if (!on && !confirm(`Switch off ${u.name}? They are signed out at once and can't sign in until you switch them on again.`)) return;
      try {
        await api(`/team-users/${encodeURIComponent(u.username)}/active`, { method: "POST", body: { active: on } });
        toast(`${u.name} ${on ? "can sign in again" : "is switched off"}`);
        loadUsers();
      } catch (err) {
        toast(err.message, "bad");
      }
    } else if (act === "delete") {
      openDelete(u);
    }
  });
}

function openTeam(team, highlight = null) {
  popupTeam = team;
  $("urTeamName").textContent = TEAMS[team].name;
  $("urTeamModal").hidden = false;
  $("urTeamModal").querySelector(".pd-team-box").dataset.team = team;
  $("urTeamSearch").value = "";
  renderUsers(highlight);
  const row = highlight && document.querySelector(`.pd-user[data-user="${CSS.escape(highlight)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" }); else $("urTeamSearch").focus();
}

function renderUsers(highlight = null) {
  const q = $("urTeamSearch").value.trim().toLowerCase();
  const team = users.filter((u) => u.team === popupTeam);
  const list = q ? team.filter((u) => `${u.name} ${u.username}`.toLowerCase().includes(q)) : team;
  $("urTeamCount").textContent = `${team.length}`;
  if (!list.length) {
    $("urUsers").innerHTML = `<p class="pd-empty">${team.length ? "Nobody matches." : `No ${TEAMS[popupTeam].name.toLowerCase()} accounts yet - create one on the card.`}</p>`;
    return;
  }
  const stat = (u) => (u.team === "onboarding"
    ? `<b>${u.farms ?? "–"}</b><small>farms onboarded</small>`
    : `<b>${u.entries ?? "–"}<i>/</i>${u.nodeEntries ?? "–"}</b><small>controllers / nodes</small>`);
  $("urUsers").innerHTML = list.map((u) => `
    <article class="pd-user${u.active ? "" : " off"}${u.username === highlight ? " pd-new" : ""}" data-user="${esc(u.username)}">
      <span class="pd-avatar">${esc((u.name || u.username).charAt(0).toUpperCase())}</span>
      <div class="pd-user-main"><b>${esc(u.name)}</b><span>@${esc(u.username)}${u.active ? "" : " · switched off"} · last sign-in ${u.lastLoginAt ? `${fmtDate(u.lastLoginAt)}, ${fmtTime(u.lastLoginAt)}` : "never"}</span></div>
      <div class="pd-user-stat">${stat(u)}</div>
      ${freshCreds.has(u.username) ? `<div class="pd-user-cred">${icon("key-round")}<span>Username <code>${esc(u.username)}</code></span><span>Password <code>${esc(freshCreds.get(u.username))}</code></span><small>shown until this page is closed</small></div>` : ""}
      <div class="pd-user-actions">
        <button type="button" class="pd-btn pd-btn-ghost" data-act="copy" data-user="${esc(u.username)}" title="Login link, username${freshCreds.has(u.username) ? " and password" : ""}">${icon("copy")}Copy sign-in</button>
        <button type="button" class="pd-btn pd-btn-ghost" data-act="password" data-user="${esc(u.username)}">${icon("key-round")}Password</button>
        <button type="button" class="pd-btn ${u.active ? "pd-btn-ghost" : "pd-btn-primary"}" data-act="active" data-user="${esc(u.username)}">${icon("power")}${u.active ? "Switch off" : "Switch on"}</button>
        <button type="button" class="pd-btn pd-btn-ghost ur-del" data-act="delete" data-user="${esc(u.username)}" aria-label="Delete ${esc(u.name)}">${icon("trash-2")}Delete</button>
      </div>
    </article>`).join("");
}

// ---------------------------------------------------------------- password
let pwFor = null;
function setupPassword() {
  const modal = $("urPwModal");
  const close = () => { modal.hidden = true; pwFor = null; };
  $("urPwCancel").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  $("urPwGen").addEventListener("click", () => { $("urPwInput").value = makePassword(); });
  $("urPwCopy").addEventListener("click", () => navigator.clipboard?.writeText($("urPwInput").value).then(() => toast("Copied"), () => toast("Couldn't copy", "bad")));
  $("urPwSave").addEventListener("click", async () => {
    const pw = $("urPwInput").value;
    if (pw.length < 8) { $("urPwMsg").textContent = "At least 8 characters"; return; }
    try {
      await api(`/team-users/${encodeURIComponent(pwFor.username)}/password`, { method: "POST", body: { password: pw } });
      const u = pwFor;
      close();
      freshCreds.set(u.username, pw);
      await loadUsers();
      openTeam(u.team, u.username);
      toast(`New password set for ${u.name}`);
    } catch (err) {
      $("urPwMsg").textContent = err.message;
    }
  });
}
function openPassword(u) {
  pwFor = u;
  $("urPwWho").textContent = u.name;
  $("urPwInput").value = makePassword();
  $("urPwMsg").textContent = "";
  $("urPwModal").hidden = false;
  $("urPwInput").focus();
  $("urPwInput").select();
}

// ---------------------------------------------------------------- delete
let delFor = null;
function setupDelete() {
  const modal = $("urDelModal");
  const close = () => { modal.hidden = true; delFor = null; };
  $("urDelNo").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  $("urDelYes").addEventListener("click", async () => {
    const u = delFor;
    const btn = $("urDelYes");
    btn.disabled = true;
    try {
      await api(`/team-users/${encodeURIComponent(u.username)}`, { method: "DELETE" });
      close();
      freshCreds.delete(u.username);
      await loadUsers();
      toast(`${u.name} deleted`);
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      btn.disabled = false;
    }
  });
}
function openDelete(u) {
  delFor = u;
  $("urDelWho").textContent = u.name;
  const made = u.team === "onboarding" ? "The farms they onboarded stay" : "The controllers and nodes they entered stay";
  $("urDelText").textContent = `@${u.username} is signed out at once and can never sign in again. ${made}, with their name on them. To stop them only for a while, use Switch off instead.`;
  $("urDelModal").hidden = false;
  $("urDelNo").focus();
}
