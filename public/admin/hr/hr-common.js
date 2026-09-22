/* =====================================================
   HR COMMON SYSTEM
   Used across all HR pages
===================================================== */

import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

/* ================= AUTH GUARD ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= BACK BUTTON ================= */
window.goBackHR = function () {
  window.history.back();
};

/* ================= SMART NAVIGATION ================= */
window.navigateHR = function (page) {
  window.location.href = `/admin/hr/${page}.html`;
};

/* ================= PAGE TITLE INJECT ================= */
window.setHRPageTitle = function (title) {
  const el = document.getElementById("hrPageTitle");
  if (el) el.textContent = title;
};

/* ================= DATE FORMATTER ================= */
window.formatDate = function (dateStr) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN");
};

/* ================= STATUS BADGE ================= */
window.getStatusBadge = function (status) {
  if (!status) return "-";

  const s = status.toLowerCase();

  if (s === "active") {
    return `<span class="hr-badge active">Active</span>`;
  }

  if (s === "inactive") {
    return `<span class="hr-badge inactive">Inactive</span>`;
  }

  if (s === "pending") {
    return `<span class="hr-badge pending">Pending</span>`;
  }

  return status;
};
