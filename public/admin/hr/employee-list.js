import { auth, db } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
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

/* ================= LOAD EMPLOYEES ================= */
async function loadEmployees() {

  const q = query(
    collection(db, "employees"),
    orderBy("employeeId", "asc")   // 1 → highest
  );

  const snapshot = await getDocs(q);
  const tbody = document.getElementById("employeeTableBody");
  tbody.innerHTML = "";

  if (snapshot.empty) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:20px;">
          No employees found
        </td>
      </tr>
    `;
    return;
  }

  snapshot.forEach((docSnap) => {

    const e = docSnap.data();
    const docId = docSnap.id;
    const isInactive = e.status === "inactive";

    const tr = document.createElement("tr");

    if (isInactive) {
      tr.classList.add("inactive-row");
    }

    tr.innerHTML = `
      <td class="row-index"></td>
      <td>${e.employeeId || "-"}</td>
      <td>${e.name || "-"}</td>
      <td>${e.department || "-"}</td>
      <td>${e.mobile || "-"}</td>
      <td>
        <span class="hr-badge ${isInactive ? "inactive" : "active"}">
          ${e.status || "active"}
        </span>
      </td>

      <td class="action-cell">

        <button class="icon-btn view"
          onclick="viewEmployee('${docId}')"
          title="View">
          👁️
        </button>

        <button class="icon-btn edit"
          onclick="editEmployee('${docId}')"
          title="Edit"
          ${isInactive ? "disabled" : ""}>
          ✏️
        </button>

        <button class="icon-btn toggle"
          onclick="toggleEmployeeStatus('${docId}', '${e.status}')"
          title="${isInactive ? "Activate" : "Deactivate"}">
          ${isInactive ? "🟢" : "⛔"}
        </button>

        <button class="icon-btn delete"
          onclick="deleteEmployee('${docId}')"
          title="Delete">
          🗑️
        </button>

      </td>
    `;

    tbody.appendChild(tr);
  });

  // Initialize pagination
  setTimeout(() => {
    initTablePagination(".fb-table", 10);
    updateRowIndex();
  }, 150);
}

loadEmployees();

/* ================= UPDATE SERIAL NUMBER ================= */

function updateRowIndex() {

  const rows = document.querySelectorAll("#employeeTableBody tr");

  rows.forEach((row, index) => {
    const indexCell = row.querySelector(".row-index");
    if (indexCell) {
      indexCell.textContent = index + 1;
    }
  });
}

/* ================= ACTIONS ================= */

window.viewEmployee = (id) => {
  window.location.href = `/admin/hr/employee-view.html?id=${id}`;
};

window.editEmployee = (id) => {
  window.location.href = `/admin/hr/employee-edit.html?id=${id}`;
};

window.toggleEmployeeStatus = async (id, status) => {

  const newStatus = status === "inactive" ? "active" : "inactive";

  await updateDoc(doc(db, "employees", id), {
    status: newStatus
  });

  loadEmployees();
};

window.deleteEmployee = async (id) => {

  if (!confirm("Are you sure you want to permanently delete this employee?"))
    return;

  await deleteDoc(doc(db, "employees", id));
  loadEmployees();
};

/* ================= BACK BUTTON ================= */

window.goBackHR = function () {
  window.location.href = "/admin/hr/hrconnect.html";
};