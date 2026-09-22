import { db } from "/js/firebase-init.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

async function loadAttendance() {

  const snap = await getDocs(collection(db, "attendance"));
  const tbody = document.getElementById("attendanceBody");
  tbody.innerHTML = "";

  snap.forEach(d => {
    const a = d.data();
    tbody.innerHTML += `
      <tr>
        <td>${a.employeeId}</td>
        <td>${a.name}</td>
        <td>${a.date}</td>
        <td>${a.status}</td>
      </tr>
    `;
  });
}

loadAttendance();
