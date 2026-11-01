// Shared pieces of the card-list pages (Farmer Database, Distributor
// Database) - css/records.css has the look. Plain helpers, no framework.

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  filter: '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  building: '<rect x="4" y="3" width="11" height="18" rx="1"/><path d="M15 9h5v12h-5M8 7h3M8 11h3M8 15h3"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>'
};

export function icon(name) {
  return `<svg class="rx-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ""}</svg>`;
}

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Page buttons: Prev, 1 … 4 5 6 … 12, Next.
export function renderPager(el, page, pages) {
  if (pages <= 1) { el.innerHTML = ""; return; }
  const nums = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1 || (page <= 3 && n <= 5) || (page >= pages - 2 && n >= pages - 4)) nums.push(n);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const btn = (label, to, { cur = false, dis = false, aria = "" } = {}) =>
    `<button type="button" class="rx-page${cur ? " cur" : ""}" data-page="${to}"${dis ? " disabled" : ""}${cur ? ' aria-current="page"' : ""}${aria ? ` aria-label="${aria}"` : ""}>${label}</button>`;
  el.innerHTML = btn("‹ Prev", page - 1, { dis: page === 1, aria: "Previous page" }) +
    nums.map((n) => (n === "…" ? `<span class="rx-page-gap">…</span>` : btn(n, n, { cur: n === page, aria: `Page ${n}` }))).join("") +
    btn("Next ›", page + 1, { dis: page === pages, aria: "Next page" });
}

// Search, filters, sort, page and page size, kept for this browser tab -
// back from a farmer's View / Edit, the list is where it was.
export function loadState(key, defaults) {
  try { return { ...defaults, ...(JSON.parse(sessionStorage.getItem(key) || "null") || {}) }; } catch { return { ...defaults }; }
}
export function saveState(key, state) {
  try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* private mode - fine */ }
}

let toastTimer = 0;
export function toast(msg, bad = false) {
  let t = document.querySelector(".rx-toast");
  if (!t) { t = document.createElement("div"); t.className = "rx-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// "/" focuses the search box (not while typing in a field).
export function slashToSearch(input) {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || document.activeElement?.isContentEditable) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}
