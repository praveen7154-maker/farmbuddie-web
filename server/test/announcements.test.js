// node --test server/test  (from the repo root) - Message Broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createAnnouncementsModule, validateAnnouncement, resolveTargets, pushMessage
} from "../src/bridge/announcements.js";

const NOW = new Date("2026-10-08T10:00:00Z");

const AUDIENCE = {
  farms: [
    { farmId: "0001", farmerName: "Farm Buddie R&D", active: true, online: true },
    { farmId: "0002", farmerName: "Murugan", active: true, online: false },
    { farmId: "0003", farmerName: "Selvi", active: true, online: true }
  ],
  phones: [
    { phone: "9999912345", farmIds: ["0001"] },
    { phone: "9000000002", farmIds: ["0002"] },
    { phone: "9000000003", farmIds: ["0002", "0003"] }
  ],
  devices: [
    { instanceId: "a", token: "tok-a", farmIds: ["0001"] },
    { instanceId: "b", token: "tok-b", farmIds: ["0002"] },
    { instanceId: "c", token: "tok-c", farmIds: ["0003"] },
    { instanceId: "d", token: "tok-dead", farmIds: ["0003"] }
  ]
};

test("validation", () => {
  const ok = validateAnnouncement({ category: "update", title: "  New app  ", body: "Update today", audience: "all" }, NOW);
  assert.equal(ok.title, "New app");
  assert.equal(ok.farmIds, null);
  assert.equal(ok.sendAt, null);
  assert.throws(() => validateAnnouncement({ category: "spam", title: "x", body: "y", audience: "all" }, NOW), /category/);
  assert.throws(() => validateAnnouncement({ category: "update", title: "", body: "y", audience: "all" }, NOW), /Title/);
  assert.throws(() => validateAnnouncement({ category: "update", title: "x", body: "y".repeat(1001), audience: "all" }, NOW), /too long/);
  assert.throws(() => validateAnnouncement({ category: "update", title: "x", body: "y", audience: "farms", farmIds: [] }, NOW), /at least one/);
  assert.throws(() => validateAnnouncement({ category: "update", title: "x", body: "y", audience: "farms", farmIds: ["12a"] }, NOW), /Invalid/);
  assert.throws(() => validateAnnouncement({ category: "update", title: "x", body: "y", titleTa: "த", audience: "all" }, NOW), /Tamil message/);
  // A send time within a minute is "now"; a far one is refused.
  assert.equal(validateAnnouncement({ category: "reminder", title: "x", body: "y", audience: "all",
    sendAt: new Date(NOW.getTime() + 30000).toISOString() }, NOW).sendAt, null);
  assert.throws(() => validateAnnouncement({ category: "reminder", title: "x", body: "y", audience: "all",
    sendAt: "2027-06-01T00:00:00Z" }, NOW), /at most/);
  assert.throws(() => validateAnnouncement({ category: "reminder", title: "x", body: "y", audience: "all",
    sendAt: "2026-10-09T10:00:00Z", expiresAt: "2026-10-09T09:00:00Z" }, NOW), /after the send time/);
});

test("targets: selected farms reach only their phones and installs", () => {
  const t = resolveTargets({ audience: "farms", farmIds: ["0002"] }, AUDIENCE);
  assert.deepEqual(t.farms, ["0002"]);
  assert.deepEqual(t.phones.map((p) => p.phone), ["9000000002", "9000000003"]);
  assert.deepEqual(t.devices.map((d) => d.token), ["tok-b"]);
  const all = resolveTargets({ audience: "all" }, AUDIENCE);
  assert.equal(all.phones.length, 3);
  assert.equal(all.devices.length, 4);
});

test("the push stays small and is tagged for the app", () => {
  const m = pushMessage({ id: 7, category: "offer", title: "Diwali offer", body: "x".repeat(900), important: true });
  assert.ok(m.notification.body.length <= 240);
  assert.equal(m.android.notification.channelId, "farmbuddie_official");
  assert.deepEqual(m.data, { type: "announcement", announcementId: "7", category: "offer", important: "1" });
});

// In-memory stand-in for announcementStore.js, same contract.
function fakeStore() {
  const rows = [];
  const readRows = [];
  const visible = (a, farmIds) => !a.deletedAt && a.sentAt && (!a.expiresAt || a.expiresAt > new Date()) &&
    (farmIds == null || a.audience === "all" || (a.farmIds || []).some((f) => farmIds.includes(f)));
  return {
    rows, readRows,
    async create(a) { rows.push({ ...a, id: rows.length + 1, sentAt: null, deletedAt: null }); return rows.length; },
    async claim(id) {
      const a = rows.find((r) => r.id === id && !r.sentAt && !r.deletedAt);
      if (!a) return null;
      a.sentAt = new Date();
      return a;
    },
    async recordDelivery(id, s) { Object.assign(rows.find((r) => r.id === id), s); },
    async dueIds() { return rows.filter((r) => !r.sentAt && !r.deletedAt && r.sendAt <= new Date()).map((r) => r.id); },
    async list() { return rows; },
    async count() { return rows.length; },
    async get(id) { return rows.find((r) => r.id === Number(id)) || null; },
    async reads(id) { return readRows.filter((r) => r.id === id).map((r) => ({ phone: r.phone, readAt: r.at })); },
    async recall(id) {
      const a = rows.find((r) => r.id === Number(id) && !r.deletedAt);
      if (!a) return false;
      a.deletedAt = new Date();
      return true;
    },
    async feed(farmIds, phone) {
      return rows.filter((a) => visible(a, farmIds))
        .map((a) => ({ id: a.id, title: a.title, read: readRows.some((r) => r.id === a.id && r.phone === phone) }))
        .reverse();
    },
    async visibleIds(ids, farmIds) { return rows.filter((a) => ids.includes(a.id) && visible(a, farmIds)).map((a) => a.id); },
    async markRead(ids, phone) { for (const id of ids) if (!readRows.some((r) => r.id === id && r.phone === phone)) readRows.push({ id, phone, at: new Date() }); }
  };
}

async function withServer(fn) {
  const store = fakeStore();
  const pushes = [];
  const removed = [];
  const mod = createAnnouncementsModule({
    store,
    loadAudience: async () => AUDIENCE,
    phoneFarmIds: async (phone) => AUDIENCE.phones.find((p) => p.phone === phone)?.farmIds || [],
    sendPush: async (tokens, message) => {
      pushes.push({ tokens, message });
      const dead = tokens.filter((t) => t === "tok-dead");
      return { ok: tokens.length - dead.length, failed: dead.length, deadTokens: dead };
    },
    removeDevices: async (tokens) => removed.push(...tokens)
  });
  let who = { email: "admin@test" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.decodedToken = who; next(); });
  app.use("/broadcast", mod.adminRouter);
  app.use("/announcements", mod.farmerRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ call, store, pushes, removed, mod, as: (t) => { who = t; } });
  } finally {
    server.close();
  }
}

test("send to selected farms: pushed, counted, and only those farmers see it", async () => {
  await withServer(async ({ call, pushes, removed, as }) => {
    const sent = await call("/broadcast/announcements", "POST",
      { category: "reminder", title: "Service visit", body: "Our team visits on Monday", audience: "farms", farmIds: ["0003"] });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.scheduled, false);
    assert.deepEqual(sent.body.delivery, { targetFarms: 1, targetPhones: 1, targetDevices: 2, pushOk: 1, pushFailed: 1 });
    assert.deepEqual(pushes[0].tokens.sort(), ["tok-c", "tok-dead"]);
    assert.deepEqual(removed, ["tok-dead"]);

    // Unknown farm -> refused.
    assert.equal((await call("/broadcast/announcements", "POST",
      { category: "general", title: "x", body: "y", audience: "farms", farmIds: ["0099"] })).status, 400);

    as({ phone_number: "+919000000003" });
    const feed = await call("/announcements");
    assert.equal(feed.body.announcements.length, 1);
    assert.equal(feed.body.unread, 1);
    as({ phone_number: "+919999912345" });
    assert.equal((await call("/announcements")).body.announcements.length, 0);
  });
});

test("read receipts only for messages the phone can see", async () => {
  await withServer(async ({ call, store, as }) => {
    await call("/broadcast/announcements", "POST", { category: "update", title: "All", body: "For everyone", audience: "all" });
    await call("/broadcast/announcements", "POST", { category: "update", title: "R&D", body: "Only 0001", audience: "farms", farmIds: ["0001"] });
    as({ phone_number: "+919000000002" });
    const r = await call("/announcements/read", "POST", { ids: [1, 2, "x"] });
    assert.equal(r.body.marked, 1);
    assert.deepEqual(store.readRows.map((x) => [x.id, x.phone]), [[1, "9000000002"]]);
    assert.equal((await call("/announcements")).body.unread, 0);
    // Admins and other people's tokens can't reach the admin side.
    assert.equal((await call("/broadcast/announcements")).status, 403);
  });
});

test("scheduled messages wait for the scheduler; recall hides them", async () => {
  await withServer(async ({ call, store, pushes, mod, as }) => {
    const later = new Date(Date.now() + 3600 * 1000).toISOString();
    const s = await call("/broadcast/announcements", "POST",
      { category: "reminder", title: "Pay bill", body: "Due tomorrow", audience: "all", sendAt: later });
    assert.equal(s.body.scheduled, true);
    assert.equal(pushes.length, 0);
    as({ phone_number: "+919000000002" });
    assert.equal((await call("/announcements")).body.announcements.length, 0);

    store.rows[0].sendAt = new Date(Date.now() - 1000);   // time passes
    await mod.sendDue();
    await mod.sendDue();                                    // never twice
    assert.equal(pushes.length, 1);
    assert.equal((await call("/announcements")).body.announcements.length, 1);

    as({ email: "admin@test" });
    assert.equal((await call("/broadcast/announcements/1", "DELETE")).status, 200);
    assert.equal((await call("/broadcast/announcements/1", "DELETE")).status, 404);
    as({ phone_number: "+919000000002" });
    assert.equal((await call("/announcements")).body.announcements.length, 0);
  });
});

test("a phone with no farm gets an empty feed", async () => {
  await withServer(async ({ call, as }) => {
    await call("/broadcast/announcements", "POST", { category: "update", title: "All", body: "x", audience: "all" });
    as({ phone_number: "+918888888888" });
    assert.deepEqual((await call("/announcements")).body, { announcements: [], unread: 0 });
  });
});
