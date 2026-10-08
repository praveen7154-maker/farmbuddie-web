import express from "express";

// Message Broadcast (admin panel > Message Broadcast): the company's own
// announcements to farmers - update notices, reminders, offers. The admin
// writes one message (optionally with a Tamil version), picks all farmers
// or some farms, and sends it now or at a set time. This module:
//   - stores it (Postgres - announcementStore.js),
//   - pushes it to every phone of the chosen farms (FCM, same fcmTokens the
//     device alerts use - pushNotifications.js),
//   - serves each phone its own feed (GET /announcements - the Irrigo app's
//     "Farm Buddie Official" list), and records who has read what.
// The push is only the doorbell: the app always (re)loads the feed from
// here, so a phone that was off, had notifications blocked or missed the
// push still gets every message the next time it opens.
//
// Everything is injected (store, audience, push) so it can be tested
// without Postgres/Firestore/FCM - see createAnnouncementsModule().

export const CATEGORIES = ["general", "update", "reminder", "offer", "alert"];
export const LIMITS = { title: 80, body: 1000, farms: 5000 };
// The app's feed: newest first, at most this many, none older than this.
const FEED_LIMIT = 100;
const FEED_MAX_AGE_DAYS = 180;
const MAX_SCHEDULE_DAYS = 60;
const MAX_EXPIRY_DAYS = 365;
const PUSH_BODY_CHARS = 240;   // the push only carries a preview - FCM caps a message at 4 KB
const FARM_RE = /^\d{1,6}$/;
const PAGE_SIZE = 10;

export const normalizePhone = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

function text(value, max, field, required) {
  const s = typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
  if (!s && required) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return s || null;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalDate(value, field) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a valid date`);
  return d;
}

/** Checks and cleans an admin's new message. Throws a 400-status Error. */
export function validateAnnouncement(input, now = new Date()) {
  const b = input || {};
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) throw badRequest("Pick a category");
  const title = text(b.title, LIMITS.title, "Title", true);
  const body = text(b.body, LIMITS.body, "Message", true);
  const bodyTa = text(b.bodyTa, LIMITS.body, "Tamil message", false);
  const titleTa = text(b.titleTa, LIMITS.title, "Tamil title", false);
  if (titleTa && !bodyTa) throw badRequest("Add the Tamil message too, or clear the Tamil title");

  const audience = b.audience === "all" ? "all" : b.audience === "farms" ? "farms" : null;
  if (!audience) throw badRequest("Choose all farmers or selected farms");
  let farmIds = null;
  if (audience === "farms") {
    if (!Array.isArray(b.farmIds) || b.farmIds.length === 0) throw badRequest("Select at least one farm");
    farmIds = [...new Set(b.farmIds.map(String))];
    if (farmIds.length > LIMITS.farms || farmIds.some((f) => !FARM_RE.test(f))) throw badRequest("Invalid farm list");
  }

  let sendAt = optionalDate(b.sendAt, "Send time");
  if (sendAt && sendAt.getTime() <= now.getTime() + 60 * 1000) sendAt = null;   // "now", give or take a clock
  if (sendAt && sendAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86400000) {
    throw badRequest(`Send time can be at most ${MAX_SCHEDULE_DAYS} days ahead`);
  }
  const expiresAt = optionalDate(b.expiresAt, "Show until");
  const start = sendAt || now;
  if (expiresAt && expiresAt.getTime() <= start.getTime()) throw badRequest("'Show until' must be after the send time");
  if (expiresAt && expiresAt.getTime() > start.getTime() + MAX_EXPIRY_DAYS * 86400000) {
    throw badRequest(`'Show until' can be at most ${MAX_EXPIRY_DAYS} days after sending`);
  }

  return { category, title, body, titleTa, bodyTa, important: b.important === true, audience, farmIds, sendAt, expiresAt };
}

const intersects = (a, set) => a.some((x) => set.has(x));

/**
 * Who a message reaches: the farms, the registered phone numbers and the
 * app installs (push tokens) behind them. audience = loadAudience() output.
 */
export function resolveTargets(announcement, audience) {
  const farmSet = announcement.audience === "all"
    ? new Set(audience.farms.map((f) => f.farmId))
    : new Set(announcement.farmIds);
  // "All" also covers a phone whose farm isn't in the farm list (any enabled access counts).
  const reaches = (farmIds) => (announcement.audience === "all" ? farmIds.length > 0 : intersects(farmIds, farmSet));
  return {
    farms: [...farmSet],
    phones: audience.phones.filter((p) => reaches(p.farmIds)),
    devices: audience.devices.filter((d) => d.token && reaches(d.farmIds))
  };
}

/** The FCM message for one announcement (tokens added by the sender). */
export function pushMessage(a) {
  const preview = a.body.length > PUSH_BODY_CHARS ? `${a.body.slice(0, PUSH_BODY_CHARS - 1)}…` : a.body;
  return {
    // A notification block, so the system shows it even while the app is
    // closed - and on app builds from before this feature. The app's own
    // channel makes it "Farm Buddie Official"; the tag stops a resend from
    // stacking a second copy.
    notification: { title: a.title, body: preview },
    android: {
      priority: "high",
      notification: { channelId: "farmbuddie_official", tag: `fb-announcement-${a.id}`, color: "#1D9BF0" }
    },
    data: { type: "announcement", announcementId: String(a.id), category: a.category, important: a.important ? "1" : "0" }
  };
}

const maskPhone = (p) => (p && p.length >= 4 ? `••••••${p.slice(-4)}` : "••••");

/**
 * deps:
 *   store         - announcementStore.js (or a fake)
 *   loadAudience  - async () => ({ farms: [{farmId, farmerName, farmBuddieId, location, active, online}],
 *                                  phones: [{phone, farmIds}], devices: [{instanceId, token, farmIds}] })
 *   phoneFarmIds  - async (phone10) => enabled farmIds of that phone ([] if none)
 *   sendPush      - async (tokens[], message) => ({ ok, failed, deadTokens: [] })
 *   removeDevices - async (tokens[]) - drop push tokens FCM says are gone
 */
export function createAnnouncementsModule({ store, loadAudience, phoneFarmIds, sendPush, removeDevices = async () => {} }) {
  // Pushes a claimed (now visible) announcement and records the numbers.
  async function deliver(a) {
    const audience = await loadAudience();
    const targets = resolveTargets(a, audience);
    let ok = 0;
    let failed = 0;
    try {
      const tokens = [...new Set(targets.devices.map((d) => d.token))];
      if (tokens.length) {
        const r = await sendPush(tokens, pushMessage(a));
        ok = r.ok;
        failed = r.failed;
        if (r.deadTokens?.length) await removeDevices(r.deadTokens).catch(() => {});
      }
    } catch (err) {
      // The message is already in every phone's feed - only the doorbell failed.
      console.error(`[broadcast] push for #${a.id} failed:`, err);
      failed = targets.devices.length;
    }
    const stats = {
      targetFarms: targets.farms.length,
      targetPhones: targets.phones.length,
      targetDevices: targets.devices.length,
      pushOk: ok,
      pushFailed: failed
    };
    await store.recordDelivery(a.id, stats);
    console.log(`[broadcast] #${a.id} "${a.title}" -> ${stats.targetFarms} farms, ${stats.targetPhones} phones, push ${ok} ok / ${failed} failed`);
    return stats;
  }

  // Sends one message if nobody else has (claim is atomic), else null.
  async function sendNow(id) {
    const claimed = await store.claim(id);
    return claimed ? { announcement: claimed, delivery: await deliver(claimed) } : null;
  }

  async function sendDue() {
    for (const id of await store.dueIds()) {
      try {
        await sendNow(id);
      } catch (err) {
        console.error(`[broadcast] scheduled #${id} failed:`, err);
      }
    }
  }

  // ---------------- admin ----------------
  const adminRouter = express.Router();
  adminRouter.use(express.json({ limit: "64kb" }));
  adminRouter.use((req, res, next) => {
    if (!req.decodedToken?.email) return res.status(403).json({ error: "Admin identity required" });
    next();
  });

  // Every farm with a controller, and how many phones / app installs each reaches.
  adminRouter.get("/audience", async (req, res) => {
    try {
      const audience = await loadAudience();
      const phonesPerFarm = new Map();
      const devicesPerFarm = new Map();
      for (const p of audience.phones) for (const f of p.farmIds) phonesPerFarm.set(f, (phonesPerFarm.get(f) || 0) + 1);
      for (const d of audience.devices) for (const f of d.farmIds) devicesPerFarm.set(f, (devicesPerFarm.get(f) || 0) + 1);
      const farms = audience.farms.map((f) => ({
        ...f, phones: phonesPerFarm.get(f.farmId) || 0, devices: devicesPerFarm.get(f.farmId) || 0
      }));
      const all = resolveTargets({ audience: "all" }, audience);
      res.json({
        farms,
        totals: { farms: farms.length, phones: all.phones.length, devices: all.devices.length },
        categories: CATEGORIES,
        limits: LIMITS
      });
    } catch (err) {
      console.error("[broadcast] audience error:", err);
      res.status(500).json({ error: "Couldn't load the farmer list" });
    }
  });

  adminRouter.post("/announcements", async (req, res) => {
    try {
      const a = validateAnnouncement(req.body);
      if (a.audience === "farms") {
        const known = new Set((await loadAudience()).farms.map((f) => f.farmId));
        const unknown = a.farmIds.filter((f) => !known.has(f));
        if (unknown.length) return res.status(400).json({ error: `Unknown farm ID(s): ${unknown.slice(0, 5).join(", ")}` });
      }
      const id = await store.create({ ...a, createdBy: req.decodedToken.email });
      if (a.sendAt) {
        console.log(`[broadcast] #${id} scheduled for ${a.sendAt.toISOString()} by ${req.decodedToken.email}`);
        return res.json({ id, scheduled: true, sendAt: a.sendAt });
      }
      const sent = await sendNow(id);
      return res.json({ id, scheduled: false, delivery: sent?.delivery || null });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error("[broadcast] create error:", err);
      return res.status(500).json({ error: "Couldn't send the message" });
    }
  });

  adminRouter.get("/announcements", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const status = ["sent", "scheduled", "recalled"].includes(req.query.status) ? req.query.status : null;
      const [items, total] = await Promise.all([
        store.list(PAGE_SIZE, (page - 1) * PAGE_SIZE, status),
        store.count(status)
      ]);
      res.json({ items, page, pageSize: PAGE_SIZE, total });
    } catch (err) {
      console.error("[broadcast] list error:", err);
      res.status(500).json({ error: "Couldn't load the history" });
    }
  });

  adminRouter.get("/announcements/:id", async (req, res) => {
    try {
      const a = await store.get(req.params.id);
      if (!a) return res.status(404).json({ error: "Not found" });
      const reads = await store.reads(a.id);
      const audience = await loadAudience();
      const farmsOf = new Map(audience.phones.map((p) => [p.phone, p.farmIds]));
      const names = new Map(audience.farms.map((f) => [f.farmId, f.farmerName]));
      res.json({
        ...a,
        reads: reads.map((r) => ({
          phone: maskPhone(r.phone),
          farms: (farmsOf.get(r.phone) || []).map((f) => ({ farmId: f, farmerName: names.get(f) || null })),
          readAt: r.readAt
        }))
      });
    } catch (err) {
      console.error("[broadcast] detail error:", err);
      res.status(500).json({ error: "Couldn't load the message" });
    }
  });

  // Recall: gone from every phone's feed on its next refresh (a scheduled
  // one is simply never sent). A push already shown can't be taken back.
  adminRouter.delete("/announcements/:id", async (req, res) => {
    try {
      const ok = await store.recall(req.params.id, req.decodedToken.email);
      if (!ok) return res.status(404).json({ error: "Not found or already recalled" });
      console.log(`[broadcast] #${req.params.id} recalled by ${req.decodedToken.email}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[broadcast] recall error:", err);
      res.status(500).json({ error: "Couldn't recall the message" });
    }
  });

  // ---------------- farmers (the Irrigo app) ----------------
  const farmerRouter = express.Router();
  farmerRouter.use(express.json({ limit: "16kb" }));

  // The caller's farms, or null for an admin (sees everything).
  async function callerFarms(req) {
    if (req.decodedToken?.email) return null;
    const phone = normalizePhone(req.decodedToken?.phone_number);
    if (phone.length !== 10) return [];
    return phoneFarmIds(phone);
  }

  farmerRouter.get("/", async (req, res) => {
    try {
      const farms = await callerFarms(req);
      if (farms && farms.length === 0) return res.json({ announcements: [], unread: 0 });
      const phone = normalizePhone(req.decodedToken?.phone_number);
      const items = await store.feed(farms, phone, FEED_LIMIT, FEED_MAX_AGE_DAYS);
      res.json({ announcements: items, unread: items.filter((a) => !a.read).length, serverTime: new Date().toISOString() });
    } catch (err) {
      console.error("[broadcast] feed error:", err);
      res.status(500).json({ error: "Couldn't load messages" });
    }
  });

  // body: { ids: [..] } - marks those of them this phone can see as read.
  farmerRouter.post("/read", async (req, res) => {
    try {
      const phone = normalizePhone(req.decodedToken?.phone_number);
      if (phone.length !== 10) return res.json({ ok: true, marked: 0 });   // admins don't count as readers
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
      if (ids.length === 0) return res.json({ ok: true, marked: 0 });
      const farms = await phoneFarmIds(phone);
      if (farms.length === 0) return res.json({ ok: true, marked: 0 });
      const visible = await store.visibleIds(ids, farms);
      if (visible.length) await store.markRead(visible, phone);
      res.json({ ok: true, marked: visible.length });
    } catch (err) {
      console.error("[broadcast] read error:", err);
      res.status(500).json({ error: "Couldn't save" });
    }
  });

  let timer = null;
  return {
    adminRouter,
    farmerRouter,
    sendDue,
    // Scheduled messages - checked once a minute.
    startScheduler(intervalMs = 60 * 1000) {
      if (timer) return;
      timer = setInterval(() => sendDue().catch((err) => console.error("[broadcast] scheduler:", err)), intervalMs);
      sendDue().catch(() => {});
    },
    stopScheduler() {
      clearInterval(timer);
      timer = null;
    }
  };
}
