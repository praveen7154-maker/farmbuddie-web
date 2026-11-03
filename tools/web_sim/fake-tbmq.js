// The TBMQ REST client (server/src/tbmqClient.js) for the web simulation:
// credentials kept in memory.
const creds = new Map();
let n = 0;
export async function createBasicCredentials({ name, clientId, userName }) {
  const id = { id: `cred-${++n}` };
  creds.set(id.id, { id, name, clientId, userName });
  return { id, name };
}
export async function deleteCredentials(id) { creds.delete(id); }
export async function findCredentialsByName(name) { return [...creds.values()].find((c) => c.name === name) || null; }
export async function checkTbmqHealth() { return { ok: true, latencyMs: 3 }; }
export async function fetchConnectedClients() { return []; }
export const _creds = creds;
