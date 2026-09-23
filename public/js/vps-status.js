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
