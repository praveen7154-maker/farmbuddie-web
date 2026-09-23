import { auth } from "/js/firebase-init.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { API_BASE_URL } from "/js/config.js";

const POLL_INTERVAL_MS = 20000;
let pollTimer = null;

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  refreshStatus();
  pollTimer = setInterval(refreshStatus, POLL_INTERVAL_MS);
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("/login.html"));
});

document.getElementById("refreshBtn")?.addEventListener("click", refreshStatus);

function setCard(prefix, ok, label, detail) {
  const dot = document.getElementById(`${prefix}Dot`);
  const labelEl = document.getElementById(`${prefix}Label`);
  const detailEl = document.getElementById(`${prefix}Detail`);

  dot.className = `vps-dot ${ok ? "ok" : "down"}`;
  labelEl.textContent = label;
  detailEl.textContent = detail || "";
}

function renderConnectedClients(connectedClients) {
  const listEl = document.getElementById("connectedClientList");

  if (!connectedClients || !connectedClients.ok) {
    setCard("farmDevices", false, "Unknown", connectedClients?.error || "");
    setCard("infraClients", false, "Unknown", "");
    listEl.innerHTML = "";
    return;
  }

  // Green here just means "we successfully read this count from TBMQ" -
  // zero farm devices connected is normal (no hardware deployed yet, or
  // everyone's phone app closed), not a failure state to flag red.
  setCard("farmDevices", true, String(connectedClients.farmDevices), "");
  setCard("infraClients", true, String(connectedClients.infrastructure), "bridge, TBMQ's own WebSocket credential, etc.");

  if (!connectedClients.clients.length) {
    listEl.innerHTML = "";
    return;
  }

  const rows = connectedClients.clients
    .slice()
    .sort((a, b) => (a.clientId || "").localeCompare(b.clientId || ""))
    .map((c) => `
      <tr>
        <td>${c.clientId}</td>
        <td>${/^FBIRG\d+$/.test(c.clientId) ? "Farm Device" : "Infrastructure"}</td>
        <td>${c.subscriptionsCount ?? "-"}</td>
        <td>${c.clientIpAdr || "-"}</td>
        <td>${c.connectedAt ? new Date(c.connectedAt).toLocaleString() : "-"}</td>
      </tr>
    `)
    .join("");

  listEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Client ID</th><th>Type</th><th>Subscriptions</th><th>IP Address</th><th>Connected Since</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function refreshStatus() {
  const lastChecked = document.getElementById("lastChecked");

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE_URL}/provision/status`, {
      headers: { "Authorization": `Bearer ${idToken}` }
    });

    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const data = await res.json();

    // Reaching this point at all proves the provisioning API itself is up -
    // no separate ping needed for it.
    setCard("api", true, "Reachable", "");

    setCard(
      "tbmqRest",
      data.tbmqRest.ok,
      data.tbmqRest.ok ? "Reachable" : "Unreachable",
      data.tbmqRest.ok ? `${data.tbmqRest.latencyMs}ms` : data.tbmqRest.error
    );

    setCard(
      "bridgeMqtt",
      data.bridgeMqtt.ok,
      data.bridgeMqtt.ok ? "Connected" : "Not connected",
      data.bridgeMqtt.error || ""
    );

    setCard(
      "bridgeSvc",
      data.bridgeService.ok,
      data.bridgeService.ok ? "Reachable" : "Unreachable",
      data.bridgeService.ok ? `${data.bridgeService.latencyMs}ms` : data.bridgeService.error
    );

    setCard(
      "postgres",
      data.postgres.ok,
      data.postgres.ok ? "Reachable" : "Unreachable",
      data.postgres.ok ? `${data.postgres.latencyMs}ms` : data.postgres.error
    );

    renderConnectedClients(data.connectedClients);

    lastChecked.textContent = `Last checked: ${new Date(data.checkedAt).toLocaleTimeString()}`;
  } catch (err) {
    console.error("Status check error:", err);
    // The fetch itself failing (not just a service inside it) means the
    // provisioning API didn't answer at all - the one case none of the
    // per-service cards above can report, since they all rely on this same
    // request succeeding.
    setCard("api", false, "Unreachable", err.message);
    lastChecked.textContent = "Last checked: failed to reach status API";
  }
}
