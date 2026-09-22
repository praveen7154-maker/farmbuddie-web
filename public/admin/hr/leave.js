import { db } from "/js/firebase-init.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

async function loadLeaves() {

  const snap = await getDocs(collection(db, "leaves"));
  const tbody = document.getElementById("leaveBody");
  tbody.innerHTML = "";

  snap.forEach(d => {
    const l = d.data();

    tbody.innerHTML += `
      <tr>
        <td>${l.employeeId}</td>
        <td>${l.name}</td>
        <td>${l.fromDate}</td>
        <td>${l.toDate}</td>
        <td>${l.status}</td>
      </tr>
    `;
  });
}

loadLeaves();
