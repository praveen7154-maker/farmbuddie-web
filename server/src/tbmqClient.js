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
  const credentialsValue = JSON.stringify({
    clientId,
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
