// Admin Home: a card for every module (the list lives in admin-shell.js,
// so the header launcher, the search and this page always agree).
import { auth } from "/js/firebase-init.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { fmtTime } from "/js/time-format.js";

/* ================= AUTH ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }
  const name = (user.displayName || (user.email || "admin").split("@")[0]).replace(/[._-]+/g, " ");
  document.getElementById("greetName").textContent = name;
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= MODULE CARDS ================= */
const shell = window.FBShell;
const { modules, icon, esc } = shell;
const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");

document.getElementById("filterIcon").outerHTML = icon("search");
document.getElementById("recentIcon").outerHTML = icon("clock");
document.getElementById("paletteKey").textContent = (mac ? "⌘" : "Ctrl") + " K";
document.getElementById("footKey").textContent = (mac ? "⌘" : "Ctrl") + " K";

let n = 0;
document.getElementById("groups").innerHTML =
  `<h2 class="fbx-section-title">All modules</h2><div class="fbx-cards">` +
  modules.map((m) =>
    `<a class="fbx-card" href="${m.href}" data-tone="${m.tone}" style="--i:${n++}" ` +
      `data-search="${esc((m.label + " " + m.desc + " " + m.group).toLowerCase())}">` +
      `<div class="fbx-card-top"><span class="fbx-card-ic">${icon(m.icon)}</span>` +
      `<span class="fbx-card-go">${icon("arrow-right")}</span></div>` +
      `<span class="fbx-card-tag">${esc(m.group)}</span>` +
      `<h3>${esc(m.label)}</h3><p>${esc(m.desc)}</p></a>`
  ).join("") + "</div>";

/* ================= RECENT ================= */
let recent = [];
try { recent = JSON.parse(localStorage.getItem(shell.KEY_RECENT) || "[]"); } catch { recent = []; }
const byId = Object.fromEntries(modules.map((m) => [m.id, m]));
recent = (Array.isArray(recent) ? recent : []).filter((id) => byId[id]).slice(0, 5);
if (recent.length) {
  const box = document.getElementById("recent");
  box.insertAdjacentHTML("beforeend", recent.map((id) => {
    const m = byId[id];
    return `<a class="fbx-chip" href="${m.href}" data-tone="${m.tone}"><span>${icon(m.icon)}</span>${esc(m.label)}</a>`;
  }).join(""));
  box.hidden = false;
}

/* ================= SEARCH ================= */
const filter = document.getElementById("moduleFilter");
filter.addEventListener("input", () => {
  const q = filter.value.trim().toLowerCase();
  let any = false;
  document.querySelectorAll(".fbx-card").forEach((c) => {
    const hit = !q || c.dataset.search.includes(q);
    c.hidden = !hit;
    any = any || hit;
  });
  document.getElementById("noMatch").hidden = any;
});
filter.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = document.querySelector(".fbx-card:not([hidden])");
    if (first) first.click();
  } else if (e.key === "Escape") {
    filter.value = "";
    filter.dispatchEvent(new Event("input"));
  }
});

/* ================= LIGHT FOLLOWING THE POINTER ================= */
document.getElementById("groups").addEventListener("pointermove", (e) => {
  const card = e.target.closest(".fbx-card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});

/* ================= GREETING + CLOCK ================= */
function tick() {
  const now = new Date();
  const h = now.getHours();
  document.getElementById("greet").textContent =
    h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("clockTime").textContent =
    fmtTime(now);
  document.getElementById("clockDate").textContent =
    now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
tick();
setInterval(tick, 15000);
