// In-memory stand-ins for the server's Postgres stores (same contracts as
// server/src/bridge/*Store.js), for the web simulation. Production and
// distributor sessions, OTA releases, announcements. Module Pricing gets an
// empty store: its page loads, its flows aren't simulated.

export function productionUserStore() {
  const users = new Map();
  const sessions = new Map();
  return {
    users, sessions,
    async listUsers(team = null) { return [...users.values()].filter((u) => !team || u.team === team); },
    async getUser(u) { return users.get(u) || null; },
    async createUser({ username, name, passwordHash, createdBy, team = "production" }) {
      if (users.has(username)) return false;
      users.set(username, { username, name, team, passwordHash, createdBy, active: true, createdAt: new Date(), lastLoginAt: null });
      return true;
    },
    async deleteUser(u) {
      for (const [h, s] of sessions) if (s.username === u) sessions.delete(h);
      return users.delete(u);
    },
    async setPassword(u, h) { users.get(u).passwordHash = h; },
    async setActive(u, a) { users.get(u).active = a; },
    async touchLogin(u) { users.get(u).lastLoginAt = new Date(); },
    async createSession(h, u, expiresAt) { sessions.set(h, { username: u, expiresAt }); },
    async getSession(h) { return sessions.get(h) || null; },
    async deleteSession(h) { sessions.delete(h); },
    async deleteSessions(u) { for (const [h, s] of sessions) if (s.username === u) sessions.delete(h); }
  };
}

export function distributorAccountStore() {
  const accounts = new Map();
  const sessions = new Map();
  return {
    accounts, sessions,
    async getAccount(id) { return accounts.get(id) || null; },
    async setPassword(id, passwordHash, mustChange) { accounts.set(id, { passwordHash, mustChange }); },
    async deleteAccount(id) { accounts.delete(id); },
    async createSession(h, id, expiresAt) { sessions.set(h, { distributorId: id, expiresAt }); },
    async getSession(h) { return sessions.get(h) || null; },
    async deleteSession(h) { sessions.delete(h); },
    async deleteSessions(id, except = null) { for (const [h, s] of sessions) if (s.distributorId === id && h !== except) sessions.delete(h); },
    async saveDevice() {}, async removeDevices() {}, async removeDevicesOf() {}, async devices() { return []; }
  };
}

export function otaStore() {
  const fw = new Map();
  const releases = [];      // { release, targets, nodes }
  const find = (id) => releases.find((r) => r.release.id === id);
  return {
    fw, releases,
    async saveFirmware(f) { fw.set(f.sha256, { ...f, uploadedAt: new Date() }); },
    async getFirmwareMeta(sha) { const f = fw.get(sha); return f && { sha256: f.sha256, version: f.version, product: f.product || "hub", size: f.size }; },
    async getFirmwareData(sha) { return fw.get(sha)?.data || null; },
    async createRelease(release, targets, at = new Date()) {
      const id = releases.length ? releases[releases.length - 1].release.id + 1 : 1;
      releases.push({
        release: { id, sha256: release.sha256, version: release.version, product: release.product || "hub", url: release.url,
          signature: release.signature, mode: release.mode, createdBy: release.createdBy, createdAt: at, stoppedAt: null, stoppedBy: null },
        targets: targets.map((t) => ({ farmId: t.farmId, nodeId: t.nodeId, state: "sent", percent: null, error: null, transport: null,
          fwVersion: null, attempts: 1, sentAt: at, updatedAt: at })),
        nodes: []
      });
      return id;
    },
    async getRelease(id) { const r = find(Number(id)); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async listReleases(limit, offset = 0, product = null, q = null) {
      return releases.filter((r) => match(r, product, q)).reverse().slice(offset, offset + limit)
        .map((r) => ({ release: r.release, targets: r.targets.map((t) => ({ state: t.state, error: t.error })), nodes: r.nodes.map((n) => ({ state: n.state })) }));
    },
    async latestReleaseVersions() {
      const out = {};
      for (const r of releases) out[r.release.product || "hub"] = r.release.version;
      return out;
    },
    async countReleases(product = null, q = null) { return releases.filter((r) => match(r, product, q)).length; },
    async deleteReleases(ids) {
      let n = 0;
      for (let i = releases.length - 1; i >= 0; i--) if (ids.includes(releases[i].release.id)) { releases.splice(i, 1); n++; }
      return n;
    },
    async markStopped(id, by, at = new Date()) { const r = find(id); if (r) { r.release.stoppedAt = at; r.release.stoppedBy = by; } },
    async farmsWithNewerNodeRelease(id, farmIds) {
      return [...new Set(releases.filter((r) => r.release.id > id && r.release.product !== "hub")
        .flatMap((r) => r.targets.map((t) => t.farmId)).filter((f) => farmIds.includes(f)))];
    },
    async markSent(id, farmIds, at = new Date()) {
      const r = find(id);
      for (const t of r?.targets || []) if (farmIds.includes(t.farmId)) Object.assign(t, { state: "sent", percent: null, error: null, attempts: t.attempts + 1, sentAt: at, updatedAt: at });
    },
    async recordStatus(farmId, payload, at = new Date()) {
      const product = payload.product || "hub";
      const r = [...releases].reverse().find((x) => x.release.product === product && x.targets.some((t) => t.farmId === farmId) &&
        (!payload.version || x.release.version === payload.version));
      const t = r?.targets.find((x) => x.farmId === farmId);
      if (t) Object.assign(t, { state: payload.state, percent: Number.isFinite(payload.percent) ? payload.percent : null, error: payload.error || null,
        transport: payload.transport || t.transport, fwVersion: payload.fw_version || null, updatedAt: at });
    },
    async recordNodeStatus(farmId, payload, at = new Date()) {
      if (!payload.product || payload.product === "hub") return;
      const r = [...releases].reverse().find((x) => x.release.product === payload.product && x.targets.some((t) => t.farmId === farmId));
      if (!r) return;
      let n = r.nodes.find((x) => x.farmId === farmId && x.node === String(payload.node));
      if (!n) r.nodes.push(n = { farmId, node: String(payload.node), product: payload.product });
      Object.assign(n, { state: payload.state, percent: Number.isFinite(payload.percent) ? payload.percent : null, error: payload.error || null,
        version: payload.version || n.version || null, updatedAt: at });
    }
  };
  function match(r, product, q) {
    if (product && r.release.product !== product) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return String(r.release.id) === q || r.release.version.toLowerCase().includes(s) || (r.release.createdBy || "").toLowerCase().includes(s) ||
      r.targets.some((t) => t.farmId === q);
  }
}

export function announcementStore() {
  const rows = [];
  const readRows = [];
  const visible = (a, farmIds) => !a.deletedAt && a.sentAt && (!a.expiresAt || a.expiresAt > new Date()) &&
    (farmIds == null || a.audience === "all" || (a.farmIds || []).some((f) => farmIds.includes(f)));
  return {
    rows,
    async create(a) { rows.push({ ...a, id: rows.length + 1, createdAt: new Date(), sentAt: null, deletedAt: null }); return rows.length; },
    async claim(id) { const a = rows.find((r) => r.id === id && !r.sentAt && !r.deletedAt); if (!a) return null; a.sentAt = new Date(); return a; },
    async recordDelivery(id, s) { Object.assign(rows.find((r) => r.id === id), s); },
    async dueIds() { return rows.filter((r) => !r.sentAt && !r.deletedAt && r.sendAt <= new Date()).map((r) => r.id); },
    async list(limit = 10, offset = 0) { return [...rows].reverse().slice(offset, offset + limit); },
    async count() { return rows.length; },
    async get(id) { return rows.find((r) => r.id === Number(id)) || null; },
    async reads(id) { return readRows.filter((r) => r.id === id).map((r) => ({ phone: r.phone, readAt: r.at })); },
    async remove(ids) { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i].id)) rows.splice(i, 1); return before - rows.length; },
    async recall(id) { const a = rows.find((r) => r.id === Number(id) && !r.deletedAt); if (!a) return false; a.deletedAt = new Date(); return true; },
    async feed(farmIds, phone) { return rows.filter((a) => visible(a, farmIds)).map((a) => ({ id: a.id, title: a.title, read: readRows.some((r) => r.id === a.id && r.phone === phone) })).reverse(); },
    async visibleIds(ids, farmIds) { return rows.filter((a) => ids.includes(a.id) && visible(a, farmIds)).map((a) => a.id); },
    async markRead(ids, phone) { for (const id of ids) if (!readRows.some((r) => r.id === id && r.phone === phone)) readRows.push({ id, phone, at: new Date() }); }
  };
}

// Module Pricing: every read answers "nothing yet" so the page renders.
export function emptyPricingStore() {
  return new Proxy({}, {
    get(_t, name) {
      if (name === "then") return undefined;
      return async () => {
        const n = String(name);
        if (n === "catalogue") return { products: [], variants: [], accessories: [] };
        if (n === "auditLog") return { entries: [], total: 0 };
        if (n === "listQuotes") return { quotes: [], total: 0 };
        if (/^(settings)$/.test(n)) return {};
        if (/^(count|nextQuoteNo)/.test(n)) return 0;
        if (/^(staffRole|get|skuTaken)/.test(n)) return null;
        if (/^(normalizeDiscounts)$/.test(n)) return [];
        return [];
      };
    }
  });
}
