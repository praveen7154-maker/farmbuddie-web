import { db } from "/js/firebase-init.js";
import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const params = new URLSearchParams(window.location.search);
const id = params.get("id");

if (!id) {
  alert("Invalid Employee");
  window.history.back();
}

let employeeData = null;

/* ================= FORMAT DATE ================= */
function formatDate(d) {
  if (!d) return "NA";
  if (d.seconds) {
    return new Date(d.seconds * 1000).toLocaleDateString("en-IN");
  }
  return d;
}

/* ================= LOAD EMPLOYEE ================= */
async function loadEmployee() {

  const snap = await getDoc(doc(db, "employees", id));

  if (!snap.exists()) {
    alert("Employee not found");
    return;
  }

  const e = snap.data();
  employeeData = e;

  document.getElementById("vId").textContent = e.employeeId || "NA";
  document.getElementById("vName").textContent = e.name || "NA";
  document.getElementById("vEmail").textContent = e.email || "NA";
  document.getElementById("vMobile").textContent = e.mobile || "NA";
  document.getElementById("vRole").textContent = e.role || "NA";
  document.getElementById("vDepartment").textContent = e.department || "NA";
  document.getElementById("vStatus").textContent = e.status || "NA";
  document.getElementById("vJoining").textContent = formatDate(e.joiningDate);

  document.getElementById("vHolder").textContent = e.bank?.accountHolder || "NA";
  document.getElementById("vAccount").textContent = e.bank?.accountNumber || "NA";
  document.getElementById("vIfsc").textContent = e.bank?.ifsc || "NA";
  document.getElementById("vBank").textContent = e.bank?.bankName || "NA";

  const photo = document.getElementById("vPhoto");
  photo.src = e.documents?.photo?.url || "/assets/default-user.png";

  /* ===== DOCUMENTS SECTION (ALWAYS SHOW ALL) ===== */

const docList = document.getElementById("docList");
docList.innerHTML = "";

/* Define all expected document types */
const expectedDocuments = [
  "aadhaar",
  "pan",
  "experience",
  "degree",
  "payslip",
  "accountStatement",
  "other1",
  "other2"
];

expectedDocuments.forEach(docName => {

  const uploaded = e.documents?.[docName]?.url || null;

  const div = document.createElement("div");
  div.className = "info-item";

  div.innerHTML = `
    <b>${docName.toUpperCase()}:</b>
    ${uploaded
      ? `<a href="${uploaded}" target="_blank">View Document</a>`
      : "NA"}
  `;

  docList.appendChild(div);
});
}

loadEmployee();

/* ================= PRINT ================= */
function generateCleanPrintHTML(data) {

  const formatDate = (d) => {
    if (!d) return "NA";
    if (d.seconds) {
      return new Date(d.seconds * 1000).toLocaleDateString("en-IN");
    }
    return d;
  };

  const docs = [
    "aadhaar",
    "pan",
    "experience",
    "degree",
    "payslip",
    "accountStatement",
    "other1",
    "other2"
  ];

  const docRows = docs.map(d => `
      <tr>
        <td>${d.toUpperCase()}</td>
        <td>${data.documents?.[d]?.url ? "Uploaded" : "NA"}</td>
      </tr>
  `).join("");

  return `
  <html>
  <head>
    <title>Employee - ${data.employeeId}</title>

    <style>
      @page { margin: 25mm; }

      body {
        font-family: 'Segoe UI', Arial;
        color: #222;
      }

      .header {
        text-align: center;
        margin-bottom: 30px;
      }

      .header h2 {
        margin: 0;
        font-size: 22px;
      }

      .photo {
        text-align: center;
        margin-bottom: 20px;
      }

      .photo img {
        width: 110px;
        height: 110px;
        border-radius: 50%;
        object-fit: cover;
        border: 3px solid #2ea36b;
      }

      h3 {
        margin-top: 30px;
        margin-bottom: 10px;
        border-bottom: 1px solid #ccc;
        padding-bottom: 5px;
        font-size: 16px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }

      td {
        padding: 8px;
        border: 1px solid #ddd;
      }

      tr:nth-child(even) {
        background: #f9f9f9;
      }

    </style>
  </head>

  <body>

    <div class="header">
      <h2>Employee Details</h2>
      <div>Farm Buddie HR System</div>
    </div>

    ${data.documents?.photo?.url
      ? `<div class="photo"><img src="${data.documents.photo.url}"></div>`
      : ""
    }

    <h3>Basic Information</h3>
    <table>
      <tr><td>Employee ID</td><td>${data.employeeId || "NA"}</td></tr>
      <tr><td>Name</td><td>${data.name || "NA"}</td></tr>
      <tr><td>Email</td><td>${data.email || "NA"}</td></tr>
      <tr><td>Mobile</td><td>${data.mobile || "NA"}</td></tr>
      <tr><td>Role</td><td>${data.role || "NA"}</td></tr>
      <tr><td>Department</td><td>${data.department || "NA"}</td></tr>
      <tr><td>Status</td><td>${data.status || "NA"}</td></tr>
      <tr><td>Joining Date</td><td>${formatDate(data.joiningDate)}</td></tr>
    </table>

    <h3>Bank Details</h3>
    <table>
      <tr><td>Account Holder</td><td>${data.bank?.accountHolder || "NA"}</td></tr>
      <tr><td>Account Number</td><td>${data.bank?.accountNumber || "NA"}</td></tr>
      <tr><td>IFSC</td><td>${data.bank?.ifsc || "NA"}</td></tr>
      <tr><td>Bank Name</td><td>${data.bank?.bankName || "NA"}</td></tr>
    </table>

    <h3>Documents</h3>
    <table>
      ${docRows}
    </table>

  </body>
  </html>
  `;
}
/* ================= DOWNLOAD PDF ================= */
window.downloadPDF = function () {

  if (!employeeData) return;

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();

  let y = 10;

  function addLine(text) {
    pdf.text(text, 10, y);
    y += 8;
  }

  addLine("Employee Details - Farm Buddie");
  y += 5;

  addLine("Employee ID: " + (employeeData.employeeId || "NA"));
  addLine("Name: " + (employeeData.name || "NA"));
  addLine("Email: " + (employeeData.email || "NA"));
  addLine("Mobile: " + (employeeData.mobile || "NA"));
  addLine("Role: " + (employeeData.role || "NA"));
  addLine("Department: " + (employeeData.department || "NA"));
  addLine("Status: " + (employeeData.status || "NA"));
  addLine("Joining Date: " + formatDate(employeeData.joiningDate));

  y += 5;
  addLine("Bank Details:");
  addLine("Account Holder: " + (employeeData.bank?.accountHolder || "NA"));
  addLine("Account Number: " + (employeeData.bank?.accountNumber || "NA"));
  addLine("IFSC: " + (employeeData.bank?.ifsc || "NA"));
  addLine("Bank Name: " + (employeeData.bank?.bankName || "NA"));

  pdf.save(`Employee-${employeeData.employeeId}.pdf`);
};