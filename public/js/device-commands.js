import { BRIDGE_BASE_URL } from "/js/config.js";

async function authedFetch(auth, path, options = {}) {
  const idToken = await auth.currentUser.getIdToken();
  return fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`,
      ...(options.headers || {})
    }
  });
}

/**
 * POST /command/device on the bridge (see server/src/bridge/server.js) -
 * relays cmd/params to the device's cmd topic. Fire-and-forget at this
 * layer: resolves once the bridge has published it, not once the device
 * has acted on it or acknowledged - see fetchConfigReadback() below for
 * commands that need to read the device's actual reply.
 */
export async function sendDeviceCommand(auth, { farmId, nodeId, motorNum, cmd, ...params }) {
  const res = await authedFetch(auth, "/command/device", {
    method: "POST",
    body: JSON.stringify({ farmId, nodeId, motorNum, cmd, ...params })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Command failed (${res.status})`);
  return data;
}

/** GET /telemetry/:farmId - raw device_events rows from the last `sinceMs` milliseconds. */
export async function fetchDeviceEvents(auth, farmId, sinceMs = 10000) {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const res = await authedFetch(auth, `/telemetry/${farmId}?since=${encodeURIComponent(since)}`);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Telemetry fetch failed (${res.status})`);
  return data.events || [];
}

/**
 * Sends a "get_config_*"-style command, then polls /telemetry for the
 * device's reply instead of waiting on it directly - the bridge has no
 * push channel back to the browser (it relays MQTT one-way over plain
 * HTTP, see sendDeviceCommand() above), so a config readback (safety
 * limits, VI calibration, ...) can only be observed by re-reading recent
 * history after asking the device to publish it. Matches on
 * payload.type since a get_config_safety/get_vi_calibration response
 * both land as the same event_type (motor{N}_response) - see main.cpp's
 * sendConfigSafety()/sendConfigVi(), which set doc["type"] to
 * "config_safety"/"config_vi" for exactly this reason.
 */
// maxWaitMs: a GSM hub's round trip (command out, reply back, bridge
// insert) regularly takes longer than a few seconds.
// params: extra fields for getCmd (e.g. set_vi_calibration's new values).
// accept: optional check on the reply, so an older reply still inside the
// polling window isn't mistaken for the answer to this command.
export async function fetchConfigReadback(auth, { farmId, nodeId, motorNum, getCmd, params = {}, responseType, accept = () => true, maxWaitMs = 20000, pollIntervalMs = 1500 }) {
  await sendDeviceCommand(auth, { farmId, nodeId, motorNum, cmd: getCmd, ...params });

  const deadline = Date.now() + maxWaitMs;
  const eventType = `motor${motorNum}_response`;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const events = await fetchDeviceEvents(auth, farmId, maxWaitMs + 5000);
    const match = events
      .filter(e => e.event_type === eventType && e.payload?.type === responseType && accept(e.payload))
      .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0];

    if (match) return match.payload;
  }

  throw new Error("Device did not respond in time - it may be offline.");
}
