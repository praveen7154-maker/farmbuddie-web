import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  getDoc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ================= AUTH GUARD ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.replace("/login.html");
});

/* ================= LOGOUT ================= */
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

/* ================= SUCCESS MESSAGE ================= */
const msg = sessionStorage.getItem("distSuccess");
if (msg) {
  const successBox = document.createElement("div");
  successBox.style.background = "#e6f9f0";
  successBox.style.color = "#065f46";
  successBox.style.padding = "12px 18px";
  successBox.style.borderRadius = "12px";
  successBox.style.marginBottom = "20px";
  successBox.style.fontSize = "13px";
  successBox.style.fontWeight = "600";
  successBox.innerText = msg;

  document.querySelector(".fb-main")?.prepend(successBox);

  setTimeout(() => successBox.remove(), 6000);
  sessionStorage.removeItem("distSuccess");
}

/* ================= GLOBAL STATE ================= */
let allDistributors = [];
let filteredDistributors = [];

/* ================= LOAD DISTRIBUTORS ================= */
async function loadDistributors() {

  const q = query(
    collection(db, "distributors"),
    orderBy("distributorId", "asc")
  );

  const snapshot = await getDocs(q);

  allDistributors = snapshot.docs.map(d => ({
    _docId: d.id,
    ...d.data()
  }));

  filteredDistributors = [...allDistributors];

  renderTable(filteredDistributors);
}

loadDistributors();

/* ================= RENDER TABLE ================= */
function renderTable(data) {

  const tbody = document.getElementById("distributorTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!data.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:20px;">
          No distributors found
        </td>
      </tr>
    `;

    resetPagination();
    return;
  }

  data.forEach((d, index) => {

    const tr = document.createElement("tr");
    const isInactive = d.status === "inactive";

    if (isInactive) tr.classList.add("inactive-row");

    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${d.distributorId || "-"}</td>
      <td>${d.name || "-"}</td>
      <td>${d.primaryMobile || "-"}</td>
      <td>${d.status || "-"}</td>

      <td class="action-cell">

        <button class="icon-btn view"
          onclick="viewDistributor('${d._docId}')"
          title="View">👁️</button>

        <button class="icon-btn edit"
          onclick="editDistributor('${d._docId}')"
          title="Edit"
          ${isInactive ? "disabled" : ""}>✏️</button>

        <button class="icon-btn toggle"
          onclick="toggleStatus('${d._docId}','${d.status}')"
          title="${isInactive ? "Activate" : "Deactivate"}">
          ${isInactive ? "🟢" : "⛔"}
        </button>

        <button class="icon-btn delete"
          onclick="deleteDistributor('${d._docId}')"
          title="Delete">🗑️</button>

      </td>
    `;

    tbody.appendChild(tr);
  });

  resetPagination();
}

/* ================= RESET PAGINATION SAFELY ================= */
function resetPagination() {

  // remove old pagination first
  const oldControls = document.getElementById("fbPagination");
  if (oldControls) oldControls.innerHTML = "";

  setTimeout(() => {
    if (typeof initTablePagination === "function") {
      initTablePagination(".fb-table", 10);
    }
  }, 100);
}

/* ================= SEARCH ================= */
document.getElementById("searchInput")?.addEventListener("input", (e) => {

  const value = e.target.value.toLowerCase().trim();

  if (!value) {
    renderTable(filteredDistributors);
    return;
  }

  const searched = filteredDistributors.filter(d => {

    const id = d.distributorId?.toLowerCase() || "";
    const idNumeric = d.distributorId?.replace("FB-DIST-", "") || "";
    const name = d.name?.toLowerCase() || "";
    const mobile = d.primaryMobile || "";

    return (
      id.includes(value) ||
      idNumeric.includes(value) ||
      name.includes(value) ||
      mobile.includes(value)
    );
  });

  renderTable(searched);
});

/* ================= ACTIONS ================= */

window.viewDistributor = (id) => {
  window.location.href = `/admin/distributor-view.html?id=${id}`;
};

window.editDistributor = (id) => {
  window.location.href = `/admin/distributor-edit.html?id=${id}`;
};

window.toggleStatus = async (id, status) => {

  const newStatus = status === "inactive" ? "active" : "inactive";

  await updateDoc(doc(db, "distributors", id), {
    status: newStatus
  });

  loadDistributors();
};

window.deleteDistributor = async (id) => {

  const snap = await getDoc(doc(db, "distributors", id));

  if (!snap.exists()) {
    alert("Distributor not found");
    return;
  }

  const distributor = snap.data();

  const message = `
⚠️ Distributor: ${distributor.name}

Are you sure you want to delete this distributor permanently?
`;

  if (!confirm(message)) return;

  await deleteDoc(doc(db, "distributors", id));
  loadDistributors();
};

/* ================= GO TO ONBOARDING ================= */
window.goToDistributorOnboarding = function () {
  window.location.href = "/admin/distributor-onboarding.html";
};