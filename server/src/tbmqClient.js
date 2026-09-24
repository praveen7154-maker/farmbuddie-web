import { config } from "./config.js";

// Cached admin JWT — TBMQ tokens expire, so we hold one and re-login lazily on 401.
let cachedToken = null;

async function login() {
  const res = await fetch(`${config.tbmqBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: config.tbmqAdminEmail(),
      password: config.tbmqAdminPassword()
    })
  });

  if (!res.ok) {
    throw new Error(`TBMQ login failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  return cachedToken;
}

async function authedFetch(path, options = {}, retry = true) {
  if (!cachedToken) await login();

  const res = await fetch(`${config.tbmqBaseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Authorization": `Bearer ${cachedToken}`
    }
  });

  if (res.status === 401 && retry) {
    cachedToken = null;
    return authedFetch(path, options, false);
  }

  return res;
}

/**
 * Creates an MQTT_BASIC credential in TBMQ.
 * clientId/userName are set equal (TBMQ's Basic auth requires the connecting
 * MQTT client ID to match the registered client ID for that credential).
 */
export async function createBasicCredentials({
  name,
  clientId,
  userName,
  password,
  pubAuthRulePatterns,
  subAuthRulePatterns
}) {
  // clientId null = any client id may use this username/password (the
  // ota-admin tool connects with a fresh id every run).
  const credentialsValue = JSON.stringify({
    ...(clientId ? { clientId } : {}),
    userName,
    password,
    authRules: {
      pubAuthRulePatterns,
      subAuthRulePatterns
    }
  });

  const res = await authedFetch("/api/mqtt/client/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      credentialsType: "MQTT_BASIC",
      credentialsValue
    })
  });

  if (!res.ok) {
    throw new Error(`TBMQ create credentials failed: ${res.status} ${await res.text()}`);
  }

  return res.json(); // includes `id` (credentialsId)
}

/**
 * Real reachability check for TBMQ's REST/admin API (port 8083) - used by
 * GET /provision/status (see routes/status.js). Forces a fresh login
 * rather than reusing cachedToken, since the point is to prove the broker
 * itself answers right now, not that a token happened to still be valid.
 * Never throws - a down/unreachable broker is a normal, expected result
 * here, not an error condition for the caller to catch.
 */
export async function checkTbmqHealth() {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${config.tbmqBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: config.tbmqAdminEmail(),
        password: config.tbmqAdminPassword()
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    cachedToken = data.token;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.name === "AbortError" ? "Timed out" : err.message };
  }
}

/**
 * Currently-connected MQTT sessions, straight from TBMQ's own live
 * connection table (GET /api/v2/client-session?connectedStatusList=
 * CONNECTED) - not a Firestore mirror or Postgres history, the broker's
 * actual answer to "who is connected to me right now". Used by GET
 * /provision/status (see routes/status.js) for the "VPS & TBMQ" admin
 * page. pageSize=100 - this fleet is nowhere near needing real
 * pagination here; revisit if that ever changes.
 */
export async function fetchConnectedClients() {
  const res = await authedFetch("/api/v2/client-session?pageSize=100&page=0&connectedStatusList=CONNECTED");

  if (!res.ok) {
    throw new Error(`TBMQ client-session list failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return (data.data || []).map((c) => ({
    clientId: c.clientId,
    clientType: c.clientType,
    connectedAt: c.connectedAt,
    subscriptionsCount: c.subscriptionsCount,
    clientIpAdr: c.clientIpAdr
  }));
}

export async function deleteCredentials(credentialsId) {
  const res = await authedFetch(`/api/mqtt/client/credentials/${credentialsId}`, {
    method: "DELETE"
  });

  // 404 = already gone, treat as success (idempotent rotation)
  if (!res.ok && res.status !== 404) {
    throw new Error(`TBMQ delete credentials failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Finds an existing credential by its `name` (we always set name = clientId,
 * which is unique per device/app). TBMQ doesn't expose a filter-by-name query
 * param, so we page through and match client-side.
 */
export async function findCredentialsByName(name) {
  let page = 0;
  const pageSize = 100;

  while (true) {
    const res = await authedFetch(
      `/api/mqtt/client/credentials?pageSize=${pageSize}&page=${page}`
    );

    if (!res.ok) {
      throw new Error(`TBMQ list credentials failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const match = (data.data || []).find((c) => c.name === name);
    if (match) return match;

    if (data.hasNext === false || !data.data || data.data.length < pageSize) return null;
    page += 1;
  }
}

/**
 * One page of every MQTT credential - TBMQ's SHORT form (id, name, type,
 * no credentialsValue). Use getCredentialsById() for the rules/username.
 */
export async function listCredentialsPage(page, pageSize = 100) {
  const res = await authedFetch(`/api/mqtt/client/credentials?pageSize=${pageSize}&page=${page}`);
  if (!res.ok) {
    throw new Error(`TBMQ list credentials failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** One credential in full (credentialsValue included, password stripped by TBMQ). */
export async function getCredentialsById(credentialsId) {
  const res = await authedFetch(`/api/mqtt/client/credentials/${credentialsId}`);
  if (!res.ok) {
    throw new Error(`TBMQ get credentials ${credentialsId} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Replaces an existing MQTT_BASIC credential's authorization rules, keeping
 * everything else. TBMQ keeps the stored password when a credential is
 * saved with its id (see its MqttClientCredentialsController), so nothing
 * that logs in with it has to change. Rules apply from the client's next
 * connect - see disconnectClient().
 */
export async function updateCredentialAuthRules(credentials, authRules) {
  // Must be the FULL credential (getCredentialsById) - saving back the list's
  // short form would drop clientId/userName, which TBMQ rejects.
  if (!credentials.credentialsValue) {
    throw new Error(`updateCredentialAuthRules(${credentials.name}): needs the full credential, not the list's short form`);
  }
  const value = JSON.parse(credentials.credentialsValue);
  value.authRules = authRules;
  delete value.password; // ignored on update anyway - TBMQ keeps the current one
  const res = await authedFetch("/api/mqtt/client/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, credentialsValue: JSON.stringify(value) })
  });
  if (!res.ok) {
    throw new Error(`TBMQ update credentials ${credentials.name} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Drops a connected client's session so it reconnects - and so picks up its
 * credential's current rules, which TBMQ only reads at connect. False if
 * the client isn't connected right now.
 */
export async function disconnectClient(clientId) {
  const info = await authedFetch(`/api/client-session?clientId=${encodeURIComponent(clientId)}`);
  if (!info.ok) return false;
  const session = await info.json();
  if (!session?.sessionId || session.connectionState !== "CONNECTED") return false;
  const res = await authedFetch(
    `/api/client-session/disconnect?clientId=${encodeURIComponent(clientId)}&sessionId=${session.sessionId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw new Error(`TBMQ disconnect ${clientId} failed: ${res.status} ${await res.text()}`);
  }
  return true;
}
