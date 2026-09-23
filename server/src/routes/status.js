import { Router } from "express";
import { config } from "../config.js";
import { checkTbmqHealth } from "../tbmqClient.js";

export const statusRouter = Router();

/**
 * Fetches the bridge service's own /healthz over the docker network (see
 * bridge/server.js) - it reports its own MQTT session state and Postgres
 * reachability, neither of which provision-api has direct access to (the
 * bridge is a separate process/container - see server/src/bridge/).
 * Never throws - an unreachable bridge is a real, expected status to show,
 * not a request failure.
 */
async function checkBridgeHealth() {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${config.bridgeInternalUrl}/healthz`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      mqttConnected: data.mqttConnected === true,
      postgres: data.postgres || { ok: false, error: "not reported" }
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.name === "AbortError" ? "Timed out" : err.message };
  }
}

/**
 * GET /provision/status
 * Backs the admin panel's "VPS & TBMQ" page (see public/admin/
 * vps-status.html) - a single call that reports whether TBMQ's REST API,
 * the bridge's live MQTT session, and Postgres are all actually reachable
 * right now, not just "the containers are running". Admin-only (mounted
 * behind verifyFirebaseToken + adminOrigins CORS in app.js, same as
 * /provision/device).
 */
statusRouter.get("/", async (req, res) => {
  const [tbmqRest, bridge] = await Promise.all([checkTbmqHealth(), checkBridgeHealth()]);

  res.json({
    checkedAt: new Date().toISOString(),
    tbmqRest,
    bridgeMqtt: { ok: bridge.ok && bridge.mqttConnected === true, error: bridge.ok ? (bridge.mqttConnected ? undefined : "Bridge is up but not connected to TBMQ") : bridge.error },
    bridgeService: { ok: bridge.ok, latencyMs: bridge.latencyMs, error: bridge.error },
    postgres: bridge.ok ? bridge.postgres : { ok: false, error: "Bridge unreachable - cannot check Postgres" }
  });
});
